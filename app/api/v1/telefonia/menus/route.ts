/**
 * GET  /api/v1/telefonia/menus — os menus de voz da organização, com o "últimos 7 dias" (admin).
 * POST /api/v1/telefonia/menus — cria um menu com a fala da prévia (admin; sem ElevenLabs).
 *
 * Desenho da fase 2, §6.2 (aba Menus) e §8. O miolo do POST mora em `_salvar.ts`,
 * igual ao do PATCH. O "últimos 7 dias" conta só ligações encerradas
 * (`menusDaOrg`); o alerta de menu que confunde é da tela (`menuConfunde`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { menusDaOrg } from "@/lib/telefonia/menus";

import { salvarMenu } from "./_salvar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_menus" });
  if (!authz.ok) return authz.response;
  return ok(
    { oferecida: configAriDoAmbiente() !== null, menus: await menusDaOrg(getRequestPool(), authz.org.orgId) },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return salvarMenu(req, null);
}
