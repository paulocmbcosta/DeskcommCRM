/**
 * GET /api/v1/telefonia/gravacao — a política de gravação das ligações (admin).
 * PUT /api/v1/telefonia/gravacao — liga/desliga e escolhe a retenção (admin).
 *
 * F3 da spec 20 (desenho docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md).
 * Ligar exige o AVISO DE GRAVAÇÃO pronto (a fala geral `recording_notice`, gerada
 * na aba Voz e falas): sem ele, 409 `aviso_de_gravacao_ausente`. A regra mora em
 * `salvarPoliticaDaOrg`; a tela só a espelha. Salvar o que já estava não escreve
 * auditoria. A organização é a da sessão: o corpo aceita só os campos da política (`strict`).
 *
 * A mesma política guarda a TRANSCRIÇÃO das ligações gravadas (F4, migration
 * 0298): `transcrever` é opcional no corpo (ausente = fica como está — quem já
 * integra com os dois campos antigos não desliga nada sem querer), e LIGAR exige
 * uma chave do transcritor: sem ela, 409 `chave_de_transcricao_ausente`. O GET
 * diz se há chave (`transcricao_com_chave`; `null` = não deu para saber agora).
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
import { logger } from "@/lib/logger";
import { chaveDoTranscritor } from "@/lib/telefonia/chave-do-transcritor";
import { RETENCOES_DA_GRAVACAO_DIAS, retencaoValida } from "@/lib/telefonia/gravacao";
import { lerPoliticaDaOrg, salvarPoliticaDaOrg } from "@/lib/telefonia/gravacao-da-org";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const politicaSchema = z
  .object({
    ativa: z.boolean(),
    retencao_dias: z.number().int().refine(retencaoValida),
    transcrever: z.boolean().optional(),
  })
  .strict();

/** Há chave para transcrever? `null` = não deu para saber agora (a tela não afirma nada). */
async function temChaveDeTranscricao(organizationId: string): Promise<boolean | null> {
  try {
    return (await chaveDoTranscritor(getRequestPool(), organizationId)) !== null;
  } catch (e) {
    logger.warn("telefonia: não consegui conferir a chave de transcrição", {
      organization_id: organizationId,
      erro: e instanceof Error ? e.name : typeof e,
    });
    return null;
  }
}

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
      transcrever: p.transcrever,
      transcricao_com_chave: await temChaveDeTranscricao(authz.org.orgId),
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
  let r;
  try {
    r = await salvarPoliticaDaOrg(
      getRequestPool(),
      org,
      {
        ativa: parsed.data.ativa,
        retencaoDias: parsed.data.retencao_dias,
        ...(parsed.data.transcrever !== undefined ? { transcrever: parsed.data.transcrever } : {}),
      },
      // Só é perguntado ao LIGAR a transcrição. Aqui "não consegui saber" sobe
      // como erro: ligar sem ter conferido a chave seria prometer o que talvez não saia.
      async () => (await chaveDoTranscritor(getRequestPool(), org)) !== null,
    );
  } catch (e) {
    logger.warn("telefonia: a política de gravação não foi salva", { organization_id: org, erro: e instanceof Error ? e.name : typeof e });
    return fail("internal_error", t("Não foi possível salvar agora. Tente de novo em instantes."), 500, { requestId });
  }
  if (!r.ok && r.motivo === "sem_chave_de_transcricao") {
    return fail(
      "chave_de_transcricao_ausente",
      t("Para transcrever as ligações, cadastre antes uma chave da OpenAI em Agente de IA › Provedores."),
      409,
      { requestId },
    );
  }
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
        antes: { ativa: r.antes.ativa, retencao_dias: r.antes.retencaoDias, transcrever: r.antes.transcrever },
        depois: { ativa: r.depois.ativa, retencao_dias: r.depois.retencaoDias, transcrever: r.depois.transcrever },
      },
      requestId,
    });
  }
  return ok(
    { ativa: r.depois.ativa, retencao_dias: r.depois.retencaoDias, transcrever: r.depois.transcrever },
    { requestId },
  );
}
