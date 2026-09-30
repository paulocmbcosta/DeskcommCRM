/**
 * GET /api/v1/telefonia/diretorio — quem da organização pode receber uma
 * transferência ou uma ligação interna agora, e os times com quantos estão
 * livres (agent+). Desenho da fase 2, §12.4 e D17.
 *
 * `meu_ramal`, `pessoas` (nome, ramal, situação e times) e `times` (livres e
 * aberto/fora do horário). O "online" é UMA leitura de `GET /endpoints/PJSIP` na
 * ARI; sem telefonia na instalação, todo mundo aparece offline — é a verdade.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ClienteAri, configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { lerDiretorio, ramaisOnline } from "@/lib/channels/telefonia/diretorio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "telefonia_diretorio" });
  if (!authz.ok) return authz.response;
  const cfg = configAriDoAmbiente();
  const online = await ramaisOnline(cfg ? new ClienteAri(cfg) : null);
  const diretorio = await lerDiretorio(getRequestPool(), authz.org.orgId, authz.user.id, new Date(), online);
  return ok(diretorio, { requestId });
}
