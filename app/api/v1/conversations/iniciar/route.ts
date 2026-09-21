import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/iniciar
 *
 * Falar PRIMEIRO: abre a conversa com um contato que nunca escreveu e manda a
 * mensagem de abertura, num ato só.
 *
 * ─── Por que não bastam as duas rotas que já existem ────────────────────────
 *
 * `open-with-contact` abre e `POST /messages` envia. Encadeá-las do lado do
 * cliente funcionaria, e foi o que a primeira versão desta tela fez — até a
 * pergunta "e quando a segunda falha?" aparecer. A resposta certa (manter a
 * conversa, mostrar o motivo, deixar o operador tentar de novo lá dentro) é
 * regra de produto, e regra de produto que mora no componente de tela é regra
 * que a próxima tela não herda.
 *
 * Aqui ela mora uma vez, no helper que a tool MCP também usa.
 *
 * ─── 200, e não 201, quando o envio falha ───────────────────────────────────
 *
 * A resposta carrega DUAS notícias e elas podem discordar: a conversa foi
 * criada (isso é fato, e o `conversation_id` é útil) e a mensagem não saiu.
 * Um 4xx faria a tela descartar o corpo e perder o id da conversa que acabou de
 * nascer; um 201 liso diria que deu tudo certo. O status reporta o que a ROTA
 * fez — abriu a conversa —, e `envio.ok` reporta o que a PLATAFORMA fez.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { iniciarConversaEEnviar } from "@/lib/messaging/iniciar-conversa";
import { CANAL_NAO_FALA_PRIMEIRO } from "@/lib/messaging/open-shared-contact-conversation";
import { iniciarConversaSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // `agent`: quem atende é quem chama o cliente. O mesmo papel que responde
  // uma conversa pode começá-la — a diferença entre as duas é só quem falou
  // primeiro, e não haveria por que pedir mais poder para isso.
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let input;
  try {
    input = await validateRequest(iniciarConversaSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // ─── Admin client, e NÃO o de sessão ───────────────────────────────────
  //
  // Não é conveniência: com o client de sessão esta rota falharia em 100% das
  // chamadas. Abrir a conversa passa por `fn_service_begin`, e o baseline a
  // revoga de `authenticated` (`revoke execute … from public,anon,authenticated;
  // grant … to service_role`). O mesmo vale para `fn_upsert_wa_contact`, que
  // cria o cadastro quando só vem telefone. É por isso que
  // `open-with-contact` — a rota irmã, que faz a metade de cima deste ato —
  // também usa o admin.
  //
  // Para conferir na fonte em vez de acreditar nesta linha:
  //   grep -n "function public.fn_service_begin" supabase/baseline.sql | grep -iE "grant|revoke"
  //
  // O tenant continua garantido à mão, que é o que o anti-pattern 10 exige:
  // `organizationId` sai do gate de papel acima e nunca do corpo, e as duas
  // peças o recebem explícito — `openSharedContactConversation(db, orgId, …)`
  // filtra por ele, e `sendMessageHandler` filtra `organization_id` em toda
  // consulta justamente porque metade dos chamadores dele já é service role
  // (ver o comentário longo em `_handler.ts`, que nomeia o vazamento medido).
  const supabase = createAdminClient();

  try {
    const resultado = await iniciarConversaEEnviar(
      supabase,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
      },
      {
        channel_session_id: input.channel_session_id,
        contact_id: input.contact_id,
        phone_number: input.phone_number,
        name: input.name,
        mensagem: input.mensagem,
      },
    );

    return ok(
      {
        contact_id: resultado.contact_id,
        conversation_id: resultado.conversation_id,
        enviada: resultado.envio.ok,
        // A frase da plataforma, crua. É ela que diz "falta o valor {{2}}" ou
        // "a definição mudou desde a configuração" — traduzir para um genérico
        // aqui apagaria a única informação acionável que o operador recebe.
        erro_envio: resultado.envio.ok ? null : resultado.envio.motivo,
        message: resultado.envio.ok ? resultado.envio.message : null,
      },
      { requestId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    if (msg === "contact_not_found") {
      return fail("not_found", t("Contato não encontrado."), 404, { requestId });
    }
    if (msg === "session_not_found") {
      return fail("not_found", t("Conexão não encontrada nesta organização."), 404, { requestId });
    }
    if (msg === "invalid_phone") {
      return fail("validation_error", t("Telefone inválido."), 422, { requestId });
    }
    if (msg === CANAL_NAO_FALA_PRIMEIRO) {
      return fail(
        CANAL_NAO_FALA_PRIMEIRO,
        t("Por esta conexão só dá para responder quem já escreveu. Escolha um número de WhatsApp para chamar o cliente."),
        422,
        { requestId },
      );
    }
    return fail("internal_error", msg, 500, { requestId });
  }
}
