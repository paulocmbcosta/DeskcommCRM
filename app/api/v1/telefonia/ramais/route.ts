/**
 * GET /api/v1/telefonia/ramais — os ramais da organização (admin): nome, número,
 * times e a situação de agora (D18). A aba Conexões › Telefone › Ramais relê a
 * cada 10 s. É o diretório inteiro, visto por quem administra.
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
  const authz = await requireRole("admin", { requestId, resource: "telefonia_ramais" });
  if (!authz.ok) return authz.response;
  const cfg = configAriDoAmbiente();
  const online = await ramaisOnline(cfg ? new ClienteAri(cfg) : null);
  const d = await lerDiretorio(getRequestPool(), authz.org.orgId, authz.user.id, new Date(), online);
  return ok({ pessoas: d.pessoas }, { requestId });
}
