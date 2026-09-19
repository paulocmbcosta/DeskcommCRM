/**
 * POST /api/v1/contacts/[id]/conectores/ixc/faturas/[faturaId]/enviar
 *
 * Manda a fatura no chat. O navegador envia SÓ o id da fatura e o da conversa:
 * valor, vencimento e linha digitável são relidos do IXC aqui, e o texto é
 * composto por `mensagensDaFatura`. Um dígito errado nesses números custa
 * dinheiro de alguém — então ninguém os digita, nem a tela, nem (depois) a IA.
 *
 * Quatro conferências antes de sair qualquer mensagem, todas no servidor:
 *   1. a fatura existe e é de um cadastro VINCULADO a este contato — senão um
 *      `agent` mandaria a cobrança de um cliente para o WhatsApp de outro;
 *   2. ainda está em aberto (o cliente pode ter pago entre o painel abrir e o clique);
 *   3. tem o que enviar (linha digitável ou link https);
 *   4. a conversa é DESTE contato, nesta organização.
 *
 * A saída é o `sendMessageHandler` de sempre: mesma fila, mesmo anti-banimento,
 * mesmo opt-out. A fatura enviada é uma mensagem comum na conversa.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { CAMPOS_DA_FATURA } from "@/lib/conectores/ixc/campos";
import { hojeEmSaoPaulo, lerFatura } from "@/lib/conectores/ixc/faturas";
import { listarNoIxc } from "@/lib/conectores/ixc/http";
import { mensagensDaFatura } from "@/lib/conectores/ixc/mensagem-fatura";
import { listarVinculos } from "@/lib/conectores/vinculos";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { sendMessageSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { contextoIxc, respostaDaFalha } from "../../../_contexto";

export const dynamic = "force-dynamic";
export const maxDuration = 40;

const corpoSchema = z.object({ conversation_id: z.string().uuid() }).strict();

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
  const conversationId = parsed.data.conversation_id;

  let fatura;
  try {
    const vinculados = new Set((await listarVinculos(ctx.admin, ctx.orgId, ctx.contato.id, "ixc")).map((v) => v.external_id));
    const { registros } = await listarNoIxc(ctx.credencial, {
      tabela: "fn_areceber",
      filtro: { campo: "fn_areceber.id", operador: "=", valor: faturaId },
      campos: CAMPOS_DA_FATURA,
      limite: 1,
    });
    const registro = registros.find((r) => r.id === faturaId);
    // A MESMA resposta para "não existe" e "é de outro cliente": dizer qual dos
    // dois seria confirmar a um curioso que o id é de alguém.
    if (!registro || !vinculados.has(registro.id_cliente ?? "")) {
      return fail("not_found", ctx.t("Fatura não encontrada."), 404, { requestId });
    }
    if (registro.status !== "A") {
      return fail("state_conflict", ctx.t("Esta fatura não está mais em aberto. Atualize o painel."), 409, { requestId });
    }
    fatura = lerFatura(registro, hojeEmSaoPaulo());
    if (!fatura || !fatura.enviavel) {
      return fail(
        "fatura_nao_enviavel",
        ctx.t("O boleto desta fatura ainda não foi gerado no IXC. Gere por lá ou fale com o financeiro."),
        422,
        { requestId },
      );
    }
  } catch (err) {
    return respostaDaFalha(err, ctx, requestId);
  }

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

  const textos = mensagensDaFatura(fatura);
  let enviadas = 0;
  try {
    for (const body of textos) {
      await sendMessageHandler(
        supabase,
        { organization_id: ctx.orgId, actor: { type: "user", id: ctx.userId }, requestId, idioma: ctx.idioma },
        sendMessageSchema.parse({ conversation_id: conversationId, body }),
      );
      enviadas += 1;
    }
  } catch (err) {
    // A primeira pode ter saído e a segunda não: o audit abaixo diz quantas.
    if (enviadas === 0) {
      if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
      return fail("internal_error", "Erro ao enviar a fatura.", 500, { requestId });
    }
  }

  void audit({
    action: "conector.fatura_enviada",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    resourceType: "conversation",
    resourceId: conversationId,
    // O id da fatura e o valor — nunca a linha digitável nem o link.
    metadata: {
      conector: "ixc",
      fatura: fatura.id,
      vencimento: fatura.vencimento,
      valor_cents: fatura.valorCents,
      mensagens_enviadas: enviadas,
      mensagens_previstas: textos.length,
    },
    requestId,
  });

  return ok({ mensagens_enviadas: enviadas, mensagens_previstas: textos.length }, { status: 201, requestId });
}
