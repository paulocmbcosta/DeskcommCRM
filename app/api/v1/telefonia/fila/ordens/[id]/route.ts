/**
 * GET /api/v1/telefonia/fila/ordens/[id] — o que aconteceu com uma ordem da fila
 * do telefone ("atender" ou "mover"; aba Telefone, entrega 3; migration 0296).
 *
 * As rotas de atender e de mover respondem 202 — aceito, ainda não feito — e
 * quem faz é o worker. A tela de quem clicou pergunta por aqui, por alguns
 * segundos, até a ordem fechar: `done`, ou `refused`/`no_answer`/`cancelled` com
 * o motivo. O desfecho não pode vir pela rota da fila (`GET /telefonia/fila`):
 * aquela resposta é dividida por todos os navegadores da organização, e não leva
 * dado de UM usuário.
 *
 * agent+, e só quem PEDIU a ordem a lê — ou gerente/admin. Para qualquer outra
 * pessoa, e para a ordem de outra organização (a leitura é presa à da sessão), a
 * resposta é a mesma da que não existe: 404.
 *
 * ⚠️ "Só quem pediu" é CONVENIÊNCIA DA TELA, não fronteira de segurança. A policy
 * da 0296 (`tenant_isolation_voice_call_queue_orders_select`) dá `select` a todo
 * membro da organização: qualquer membro lê as ordens da PRÓPRIA organização
 * pela REST, com o JWT dele, sem passar por aqui. Esta rota restringe porque
 * cada tela acompanha o pedido que fez — não porque a ordem seja segredo entre
 * colegas. A fronteira que vale é a da ORGANIZAÇÃO: aqui, a leitura presa à da
 * sessão; na REST, a RLS. Quem precisar esconder a ordem de um colega muda a
 * policy, não esta rota.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { lerOrdemParaATela } from "@/lib/channels/telefonia/pedido-da-fila";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "telefonia_fila" });
  if (!authz.ok) return authz.response;
  const naoEncontrada = () =>
    fail("not_found", traduzir("Pedido não encontrado.", authz.user.idioma), 404, { requestId });

  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return naoEncontrada();

  const ordem = await lerOrdemParaATela(getRequestPool(), authz.org.orgId, id.data);
  if (!ordem) return naoEncontrada();
  // `roleAtLeast`, e não o rank na mão: o acesso à rota já foi decidido pelo
  // `requireRole`; aqui é "quem pediu OU gerente+" sobre o papel já resolvido.
  if (ordem.requested_by !== authz.user.id && !roleAtLeast(authz.org.role, "manager")) return naoEncontrada();

  return ok(
    { id: ordem.id, tipo: ordem.kind, situacao: ordem.status, desfecho: ordem.outcome, motivo: ordem.reason },
    { requestId },
  );
}
