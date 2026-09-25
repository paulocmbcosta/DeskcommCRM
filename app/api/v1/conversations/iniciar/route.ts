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
import { audit } from "@/lib/audit";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { carregarTimes } from "@/lib/times/catalogo";
import { timesParaIniciarConversa } from "@/lib/times/iniciar-conversa";

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
  // O client do USUÁRIO para o que é decisão dele: a lista de times passa pela
  // RLS, e `fn_conversation_iniciar_no_time` lê `auth.uid()` para saber quem
  // fica como dono — com o admin client ela recusaria tudo com `42501`.
  const sessao = await createClient();
  const orgId = authz.org.orgId;
  const teamId = input.team_id ?? null;

  let permitidos;
  try {
    permitidos = timesParaIniciarConversa(
      await carregarTimes(sessao, orgId, new Date()),
      authz.user.id,
      authz.org.role,
    );
  } catch {
    return fail("internal_error", t("Não foi possível carregar os times."), 500, { requestId });
  }
  if (permitidos.length > 0 && !teamId) {
    return fail("team_required", t("Escolha o time desta conversa."), 422, { requestId });
  }
  if (teamId && !permitidos.some((time) => time.id === teamId)) {
    return fail("team_not_allowed", t("Você não pode abrir conversa neste time."), 422, { requestId });
  }

  try {
    const resultado = await iniciarConversaEEnviar(
      supabase,
      {
        organization_id: orgId,
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
      {
        antesDeEnviar: async (aberta) => {
          const { data, error } = await sessao.rpc("fn_conversation_iniciar_no_time", {
            p_org: orgId,
            p_conversation: aberta.conversation_id,
            p_team: teamId,
          });
          if (error) {
            throw new ConversaNaoAtribuida(error.message, error.details ?? "");
          }
          const assumiu = (data as { assigned_to_user_id: string | null } | null)?.assigned_to_user_id;
          await audit({
            action: "conversation.started_in_team",
            actorUserId: authz.user.id,
            organizationId: orgId,
            resourceType: "conversation",
            resourceId: aberta.conversation_id,
            requestId,
            metadata: { team_id: teamId, assigned_to_user_id: assumiu ?? null },
          });
          if (assumiu) {
            await registrarTrocaDeComando({
              supabase: sessao,
              organizationId: orgId,
              conversationId: aberta.conversation_id,
              contactId: aberta.contact_id,
              tipo: "conversation_claimed",
              actor: { type: "user", id: authz.user.id, role: authz.org.role },
              motivo: "Assumiu o atendimento desta conversa",
            });
          }
        },
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
    if (err instanceof ConversaNaoAtribuida) {
      // Nada foi enviado: o envio só acontece depois desta etapa.
      if (err.codigo === "conversation_owned") {
        const dono = err.detalhe.trim();
        return fail(
          "conversation_owned",
          dono
            ? `${t("Este cliente já está em atendimento com")} ${dono}. ${t("Peça a transferência para chamar por aqui.")}`
            : t("Este cliente já está em atendimento com outra pessoa. Peça a transferência para chamar por aqui."),
          409,
          { requestId },
        );
      }
      if (err.codigo === "team_required") {
        return fail("team_required", t("Escolha o time desta conversa."), 422, { requestId });
      }
      if (err.codigo === "team_not_member" || err.codigo === "team_not_found") {
        return fail("team_not_allowed", t("Você não pode abrir conversa neste time."), 422, { requestId });
      }
      return fail("internal_error", t("Não foi possível iniciar a conversa. Tente novamente."), 500, { requestId });
    }
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

/** A etapa de time/dono recusou — com o código do banco, para a rota traduzir. */
class ConversaNaoAtribuida extends Error {
  constructor(
    readonly codigo: string,
    readonly detalhe: string,
  ) {
    super(codigo);
  }
}
