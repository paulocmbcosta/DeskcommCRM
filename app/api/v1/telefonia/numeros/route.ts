/**
 * GET  /api/v1/telefonia/numeros — os números de telefone da organização (admin).
 * POST /api/v1/telefonia/numeros — conecta um número novo (admin).
 *
 * Telefonia SIP, spec 20 §7. Cada número é a conta SIP que a organização
 * contratou de uma operadora: servidor, usuário e senha. A senha entra em claro
 * só no corpo deste POST, é cifrada no mesmo comando que grava e nunca volta
 * num GET — a tela mostra que existe, não qual é.
 *
 * Salvar não espera a operadora: o número nasce `STARTING`, o Asterisk recebe o
 * tronco na hora (quando alcançável) e o estado do registro (Conectado / senha
 * recusada / sem resposta) aparece na linha em segundos, pelo worker.
 *
 * Fase 2: o número pode nascer apontando para um time OU um menu de voz
 * (`menu_id`); `criarNumero` trava o menu na mesma transação do INSERT.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import {
  MENSAGEM_DA_FALHA,
  criarNumero,
  numeroSchema,
  numerosDaOrg,
  statusDaFalhaDoCadastro,
} from "@/lib/channels/telefonia/numeros";
import { empurrarTroncoAgora } from "@/lib/channels/telefonia/empurrar";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia" });
  if (!authz.ok) return authz.response;
  const numeros = await numerosDaOrg(getRequestPool(), authz.org.orgId);
  return ok({ oferecida: configAriDoAmbiente() !== null, numeros }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = numeroSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }

  const pool = getRequestPool();
  const r = await criarNumero(pool, authz.org.orgId, parsed.data);
  if (!r.ok) {
    return fail(r.motivo, t(MENSAGEM_DA_FALHA[r.motivo]), statusDaFalhaDoCadastro(r.motivo), { requestId });
  }

  void audit({
    action: "channel.phone_trunk_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: r.id,
    metadata: {
      servidor: parsed.data.servidor,
      usuario: parsed.data.usuario,
      time_id: parsed.data.time_id,
      menu_id: parsed.data.menu_id ?? null,
      prefixo: parsed.data.prefixo ?? null,
    },
    requestId,
  });

  await empurrarTroncoAgora(pool, r.id);
  const numeros = await numerosDaOrg(pool, authz.org.orgId);
  return ok(numeros.find((n) => n.id === r.id) ?? null, { requestId, status: 201 });
}
