/**
 * PATCH  /api/v1/telefonia/numeros/[id] — edita o número (admin). Sem `senha`
 *        no corpo, vale a que está guardada; sem `prefixo`, vale o guardado
 *        (`""`/`null` apaga). Mudar só o prefixo não pede a senha: não é conta.
 *        O destino (fase 2) é um time OU um menu (`menu_id`; ausente = manter o
 *        guardado; escolher um time tira o menu). A troca de destino ganha
 *        auditoria própria (`phone.number_destination_changed`) com o antes e o
 *        depois que a TRANSAÇÃO leu — não uma releitura depois, que contaria
 *        outra história quando duas edições se cruzam.
 * DELETE /api/v1/telefonia/numeros/[id] — remove (arquiva) o número (admin).
 *
 * Spec 20 §7. Remover arquiva: conversas e ligações apontam para a linha e o
 * histórico delas fica. O Asterisk solta o registro na hora (ou na próxima
 * sincronização do worker, se não estiver alcançável agora).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  MENSAGEM_DA_FALHA,
  arquivarNumero,
  atualizarNumero,
  destinoMudou,
  numeroSchema,
  numerosDaOrg,
  statusDaFalhaDoCadastro,
} from "@/lib/channels/telefonia/numeros";
import { empurrarTroncoAgora, retirarTroncoAgora } from "@/lib/channels/telefonia/empurrar";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", t("Número não encontrado."), 404, { requestId });
  const parsed = numeroSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }

  const numeroId = id.data;
  const pool = getRequestPool();
  const r = await atualizarNumero(pool, authz.org.orgId, numeroId, parsed.data);
  if (!r.ok) {
    return fail(r.motivo, t(MENSAGEM_DA_FALHA[r.motivo]), statusDaFalhaDoCadastro(r.motivo), { requestId });
  }

  void audit({
    action: "channel.phone_trunk_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: numeroId,
    metadata: {
      servidor: parsed.data.servidor,
      usuario: parsed.data.usuario,
      time_id: parsed.data.time_id,
      // `undefined` = o formulário não mandou o campo, e o guardado ficou.
      ...(parsed.data.prefixo !== undefined ? { prefixo: parsed.data.prefixo } : {}),
      ...(parsed.data.menu_id !== undefined ? { menu_id: parsed.data.menu_id } : {}),
      trocou_senha: Boolean(parsed.data.senha),
    },
    requestId,
  });

  // A troca de destino (time ↔ menu) é o que muda o que o CLIENTE ouve ao ligar:
  // ganha uma linha própria. Só ids — nada da conta, nunca a senha.
  if (destinoMudou(r.destino)) {
    void audit({
      action: "phone.number_destination_changed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: numeroId,
      metadata: { de: r.destino.de, para: r.destino.para },
      requestId,
    });
  }

  // O destino não precisa ir ao Asterisk (o worker o lê a cada ligação); o
  // empurrão é pela conta, que o mesmo formulário pode ter mudado.
  await empurrarTroncoAgora(pool, id.data);
  const numeros = await numerosDaOrg(pool, authz.org.orgId);
  return ok(numeros.find((n) => n.id === id.data) ?? null, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", t("Número não encontrado."), 404, { requestId });

  const numeroId = id.data;
  const removeu = await arquivarNumero(getRequestPool(), authz.org.orgId, numeroId);
  if (!removeu) return fail("not_found", t("Número não encontrado."), 404, { requestId });

  void audit({
    action: "channel.phone_trunk_archived",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: numeroId,
    metadata: {},
    requestId,
  });

  await retirarTroncoAgora(id.data);
  return ok({ removido: true }, { requestId });
}
