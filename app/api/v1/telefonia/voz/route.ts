/**
 * GET /api/v1/telefonia/voz — a voz e as falas gerais da organização (admin).
 * PUT /api/v1/telefonia/voz — escolhe a voz da ElevenLabs (admin).
 *
 * Desenho da fase 2, §6.2 (aba Voz e falas). Trocar a voz NÃO regrava as falas: o
 * hash de cada uma inclui a voz, e a tela mostra "em uso, com a voz anterior" até
 * a pessoa gerar a prévia com a voz nova e salvar — regravar sozinho gastaria
 * crédito sem ninguém pedir.
 *
 * O `voice_id` passa pela régua ÚNICA (`ID_DE_VOZ`) antes de qualquer chamada, e
 * é conferido contra as vozes da conta antes de gravar (listar vozes não sintetiza
 * nada nem gasta crédito). Escolher a mesma voz de novo não escreve nem audita. A
 * organização é a da sessão: o corpo aceita só `voice_id` (`strict`).
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
import { chaveDeVoz, estadoDaChaveDeVoz } from "@/lib/telefonia/chave-elevenlabs";
import { ErroDaElevenLabs, listarVozes } from "@/lib/telefonia/elevenlabs";
import { falasGeraisDaOrg, vozDaOrganizacao } from "@/lib/telefonia/falas";
import { STATUS_DA_FALHA, opcoesDaElevenLabs } from "@/lib/telefonia/servico-de-falas";
import { ID_DE_VOZ, MENSAGEM_DA_FALHA_DA_FALA, type FalhaDaFala } from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const vozSchema = z.object({ voice_id: z.string().trim().regex(ID_DE_VOZ) }).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_voz" });
  if (!authz.ok) return authz.response;
  const db = getRequestPool();
  const org = authz.org.orgId;
  const [chave, voz, falas] = await Promise.all([
    estadoDaChaveDeVoz(db, org),
    vozDaOrganizacao(db, org),
    falasGeraisDaOrg(db, org),
  ]);
  return ok(
    {
      oferecida: configAriDoAmbiente() !== null,
      chave: { cadastrada: chave.cadastrada, last4: chave.last4 },
      voz: voz ? { voice_id: voz.voiceId, model_id: voz.modelId } : null,
      falas,
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_voz" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = vozSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });
  const voiceId = parsed.data.voice_id;

  const db = getRequestPool();
  const org = authz.org.orgId;
  const falhar = (motivo: FalhaDaFala) =>
    fail(motivo, t(MENSAGEM_DA_FALHA_DA_FALA[motivo]), STATUS_DA_FALHA[motivo], { requestId });

  const chave = await chaveDeVoz(db, org);
  if (!chave) return falhar("sem_chave");
  try {
    const vozes = await listarVozes(chave, opcoesDaElevenLabs());
    if (!vozes.some((v) => v.voice_id === voiceId)) return falhar("voz_inexistente");
  } catch (e) {
    return falhar(e instanceof ErroDaElevenLabs ? e.motivo : "erro_do_provedor");
  }

  const anterior = await vozDaOrganizacao(db, org);
  if (anterior?.voiceId === voiceId) return ok({ voice_id: voiceId }, { requestId });

  await db.query(
    `insert into phone_settings (organization_id, voice_id) values ($1, $2)
     on conflict (organization_id) do update set voice_id = excluded.voice_id, updated_at = now()`,
    [org, voiceId],
  );
  void audit({
    action: "phone.voice_changed",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "phone_settings",
    resourceId: authz.org.orgId,
    metadata: { voice_id: voiceId, anterior: anterior?.voiceId ?? null },
    requestId,
  });
  return ok({ voice_id: voiceId }, { requestId });
}
