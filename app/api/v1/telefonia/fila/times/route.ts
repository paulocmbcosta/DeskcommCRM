/**
 * GET /api/v1/telefonia/fila/times — a espera máxima na fila do telefone de cada
 * time ATIVO da organização (migration 0295): o que está gravado e o que vale.
 *
 * `manager`+: é a leitura do seletor de Configurações › Times, a mesma régua da
 * tela e da gravação (`PUT …/fila/times/[teamId]`). A organização sai da sessão.
 * Sem a telefonia oferecida nesta instalação, `oferecida: false` e a lista vazia,
 * sem tocar no banco — o seletor nem aparece. Leitura não audita.
 */
import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { lerEsperaDosTimes, type EsperaDosTimesNaResposta } from "@/lib/telefonia/espera-do-time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_fila" });
  if (!authz.ok) return authz.response;

  if (configAriDoAmbiente() === null) {
    return ok({ oferecida: false, times: [] } satisfies EsperaDosTimesNaResposta, { requestId });
  }
  const times = await lerEsperaDosTimes(getRequestPool(), authz.org.orgId);
  return ok({ oferecida: true, times } satisfies EsperaDosTimesNaResposta, { requestId });
}
