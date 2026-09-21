/**
 * POST /api/v1/contacts/[id]/conectores/ixc/faturas/[faturaId]/enviar
 *
 * Manda a cobrança de uma fatura no chat, do jeito que o atendente escolheu:
 * **boleto** (o PDF baixado do IXC + a linha digitável) ou **Pix** (o QR code +
 * o copia-e-cola).
 *
 * O navegador envia SÓ três coisas: o id da fatura, o da conversa e a forma.
 * Tudo o que sai para o cliente é relido do IXC e conferido em
 * `enviarCobrancaIxc` (lib/conectores/ixc/enviar-cobranca.ts) — a mesma função
 * que a ferramenta da IA vai chamar. Aqui ficam o que é de HTTP: sessão, a
 * conversa ser DESTE contato, onde o arquivo é guardado, e a auditoria.
 *
 * A saída é o `sendMessageHandler` de sempre: mesma fila, mesmo anti-banimento,
 * mesmo opt-out, storage-first. O boleto enviado é uma mensagem comum na conversa.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { enviarCobrancaIxc, type MotivoDaRecusa } from "@/lib/conectores/ixc/enviar-cobranca";
import { FORMAS_DE_COBRANCA } from "@/lib/conectores/ixc/faturas";
import { listarVinculos } from "@/lib/conectores/vinculos";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { sendMessageSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { contextoIxc, respostaDaFalha } from "../../../_contexto";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const corpoSchema = z.object({ conversation_id: z.string().uuid(), forma: z.enum(FORMAS_DE_COBRANCA) }).strict();

/** Cada recusa pede um conserto diferente de quem está na tela — por isso cada uma tem a sua frase. */
const RECUSAS: Record<MotivoDaRecusa, { codigo: string; status: number; frase: string }> = {
  fatura_nao_encontrada: { codigo: "not_found", status: 404, frase: "Fatura não encontrada." },
  fatura_fechada: { codigo: "state_conflict", status: 409, frase: "Esta fatura não está mais em aberto. Atualize o painel." },
  forma_indisponivel: {
    codigo: "fatura_nao_enviavel",
    status: 422,
    frase: "O IXC ainda não gerou esta forma de pagamento para a fatura. Escolha a outra ou gere por lá.",
  },
  cobranca_indisponivel: {
    codigo: "fatura_nao_enviavel",
    status: 422,
    frase: "O IXC não devolveu a cobrança desta fatura. Tente de novo; se insistir, gere por lá.",
  },
  pix_inativo: {
    codigo: "fatura_nao_enviavel",
    status: 422,
    frase: "O Pix desta fatura não está mais ativo no IXC. Envie o boleto ou gere um Pix novo por lá.",
  },
  pix_corrompido: {
    codigo: "fatura_nao_enviavel",
    status: 422,
    frase: "O código Pix que o IXC devolveu não passou na conferência, e por isso não foi enviado.",
  },
};

export async function POST(
  req: NextRequest,
  rota: { params: Promise<{ id: string; faturaId: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: contactId, faturaId } = await rota.params;
  const ctx = await contextoIxc(contactId, requestId);
  if (!ctx.ok) return ctx.response;

  if (!/^\d{1,12}$/.test(faturaId)) {
    return fail("not_found", ctx.t("Fatura não encontrada."), 404, { requestId });
  }
  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("invalid_request", ctx.t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = corpoSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", ctx.t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }
  const { conversation_id: conversationId, forma } = parsed.data;

  // A conversa vem do navegador: tem de ser DESTE contato, nesta organização —
  // conferido ANTES de pedir qualquer coisa ao IXC.
  const supabase = await createClient();
  const { data: conversa, error: erroDaConversa } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("contact_id", ctx.contato.id)
    .eq("organization_id", ctx.orgId)
    .maybeSingle();
  if (erroDaConversa) return fail("internal_error", erroDaConversa.message, 500, { requestId });
  if (!conversa) return fail("not_found", ctx.t("Conversa não encontrada."), 404, { requestId });

  let resultado;
  try {
    const vinculos = await listarVinculos(ctx.admin, ctx.orgId, ctx.contato.id, "ixc");
    resultado = await enviarCobrancaIxc({
      credencial: ctx.credencial,
      cadastrosVinculados: new Set(vinculos.map((v) => v.external_id)),
      faturaId,
      forma,
      portas: {
        // Storage-first, no MESMO prefixo que o handler de envio confere
        // (`<org>/<conversa>/…`). O ÚLTIMO segmento é o nome que o cliente vê no
        // WhatsApp — por isso o pedaço aleatório (que evita colisão entre dois
        // envios da mesma fatura) vai numa pasta, e o arquivo chama
        // `boleto-10-09-2026.pdf`, não `boleto-10-09-2026-3f2a1b9c.pdf`.
        guardarArquivo: async (arquivo) => {
          const caminho = `${ctx.orgId}/${conversationId}/cobranca-${randomUUID().slice(0, 8)}/${arquivo.nome}.${arquivo.extensao}`;
          const { error } = await ctx.admin.storage
            .from("whatsapp-media")
            .upload(caminho, arquivo.conteudo, { contentType: arquivo.mime, upsert: false });
          if (error) throw new ApiError(500, "internal_error", undefined, requestId, "Erro ao guardar o arquivo da cobrança.");
          return caminho;
        },
        enviar: async (mensagem) => {
          await sendMessageHandler(
            supabase,
            { organization_id: ctx.orgId, actor: { type: "user", id: ctx.userId }, requestId, idioma: ctx.idioma },
            sendMessageSchema.parse({ conversation_id: conversationId, ...mensagem }),
          );
        },
      },
    });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    return respostaDaFalha(err, ctx, requestId);
  }

  if (!resultado.ok) {
    const recusa = RECUSAS[resultado.motivo];
    return fail(recusa.codigo, ctx.t(recusa.frase), recusa.status, { requestId, details: { motivo: resultado.motivo } });
  }

  void audit({
    action: "conector.fatura_enviada",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    resourceType: "conversation",
    resourceId: conversationId,
    // O id, a forma e o valor — nunca a linha digitável nem o copia-e-cola.
    metadata: {
      conector: "ixc",
      fatura: resultado.fatura.id,
      forma: resultado.forma,
      vencimento: resultado.fatura.vencimento,
      valor_cents: resultado.fatura.valorCents,
      mensagens_enviadas: resultado.enviadas,
      mensagens_previstas: resultado.previstas,
    },
    requestId,
  });

  return ok(
    { forma: resultado.forma, mensagens_enviadas: resultado.enviadas, mensagens_previstas: resultado.previstas },
    { status: 201, requestId },
  );
}
