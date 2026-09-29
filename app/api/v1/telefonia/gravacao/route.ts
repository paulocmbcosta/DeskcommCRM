/**
 * GET /api/v1/telefonia/gravacao — a política de gravação das ligações (admin).
 * PUT /api/v1/telefonia/gravacao — liga/desliga e escolhe a retenção (admin).
 *
 * F3 da spec 20 (desenho docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md).
 * Ligar exige o AVISO DE GRAVAÇÃO pronto (a fala geral `recording_notice`, gerada
 * na aba Voz e falas): sem ele, 409 `aviso_de_gravacao_ausente`. A regra mora em
 * `salvarPoliticaDaOrg`; a tela só a espelha. Salvar o que já estava não escreve
 * auditoria. A organização é a da sessão: o corpo aceita só os dois campos (`strict`).
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
import { RETENCOES_DA_GRAVACAO_DIAS, retencaoValida } from "@/lib/telefonia/gravacao";
import { lerPoliticaDaOrg, salvarPoliticaDaOrg } from "@/lib/telefonia/gravacao-da-org";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const politicaSchema = z
  .object({
    ativa: z.boolean(),
    retencao_dias: z.number().int().refine(retencaoValida),
  })
  .strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_gravacao" });
  if (!authz.ok) return authz.response;
  const p = await lerPoliticaDaOrg(getRequestPool(), authz.org.orgId);
  return ok(
    {
      oferecida: configAriDoAmbiente() !== null,
      ativa: p.ativa,
      retencao_dias: p.retencaoDias,
      retencoes: RETENCOES_DA_GRAVACAO_DIAS,
      aviso: p.aviso,
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_gravacao" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = politicaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const org = authz.org.orgId;
  const r = await salvarPoliticaDaOrg(getRequestPool(), org, {
    ativa: parsed.data.ativa,
    retencaoDias: parsed.data.retencao_dias,
  });
  if (!r.ok) {
    return fail(
      "aviso_de_gravacao_ausente",
      t("Para gravar as ligações, gere e salve antes o aviso de gravação na aba Voz e falas."),
      409,
      { requestId },
    );
  }
  if (r.mudou) {
    void audit({
      action: "phone.recording_settings_changed",
      actorUserId: authz.user.id,
      organizationId: org,
      resourceType: "phone_settings",
      resourceId: authz.org.orgId,
      metadata: {
        antes: { ativa: r.antes.ativa, retencao_dias: r.antes.retencaoDias },
        depois: { ativa: r.depois.ativa, retencao_dias: r.depois.retencaoDias },
      },
      requestId,
    });
  }
  return ok({ ativa: r.depois.ativa, retencao_dias: r.depois.retencaoDias }, { requestId });
}
