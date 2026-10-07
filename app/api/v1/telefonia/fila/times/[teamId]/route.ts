/**
 * PUT /api/v1/telefonia/fila/times/[teamId] — grava a espera máxima na fila do
 * telefone de um time (manager+; migration 0295).
 *
 * O corpo é `{ espera_maxima_s }`: de 30 a 1800 segundos, ou `null` para voltar
 * ao padrão (120 s). `attendance_teams` só tem GRANT de leitura para
 * `authenticated`: quem grava é esta rota, pela conexão do app, e a organização
 * é SEMPRE a da sessão — o corpo é `.strict()`, e um `organization_id` nele é 422.
 * O time de outra organização responde 404, igual ao que não existe; o arquivado,
 * 409 (ele não recebe ligações).
 *
 * Quem já está esperando não muda: o worker lê o teto quando a ligação entra na
 * fila do time. Sem a telefonia oferecida nesta instalação, 409
 * `telefonia_nao_oferecida` sem tocar no banco.
 *
 * Auditoria: `phone.queue_wait_changed`, com o antes e o depois em segundos
 * (`null` = o padrão).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { esperaDoTimeSchema, gravarEsperaDoTime } from "@/lib/telefonia/espera-do-time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

export async function PUT(req: NextRequest, ctx: { params: Promise<{ teamId: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_fila" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (configAriDoAmbiente() === null) {
    return fail("telefonia_nao_oferecida", t("O telefone não está ligado nesta instalação."), 409, { requestId });
  }
  const id = idSchema.safeParse((await ctx.params).teamId);
  if (!id.success) return fail("not_found", t("Time não encontrado."), 404, { requestId });
  const corpo = esperaDoTimeSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", t("Escolha uma espera entre 30 segundos e 30 minutos."), 422, { requestId });
  }

  const org = authz.org.orgId;
  const teamId = id.data;
  const r = await gravarEsperaDoTime(getRequestPool(), org, teamId, corpo.data.espera_maxima_s);
  if (!r.ok) {
    if (r.motivo === "nao_encontrado") return fail("not_found", t("Time não encontrado."), 404, { requestId });
    return fail("time_arquivado", t("Este time está arquivado."), 409, { requestId });
  }

  void audit({
    action: "phone.queue_wait_changed",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "attendance_team",
    resourceId: teamId,
    metadata: { de: r.anterior, para: corpo.data.espera_maxima_s },
    requestId,
  });
  return ok({ time: r.time }, { requestId });
}
