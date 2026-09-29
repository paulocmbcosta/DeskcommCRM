/**
 * PUT    /api/v1/telefonia/emergencias/[teamId] — liga o aviso de instabilidade do time (manager+).
 * DELETE /api/v1/telefonia/emergencias/[teamId] — desliga (manager+).
 *
 * Desenho da fase 2, D7/D8, §4 e §6.3. Ligar recebe o texto e o HASH da prévia do
 * aviso (`POST /api/v1/telefonia/falas/previa`, que já aceita gerente) — ou os da
 * fala em uso, quando o texto não mudou — e a duração (1 h, 2 h por padrão, 4 h
 * ou "até eu desligar"). NÃO chama a ElevenLabs (D15): `ligarAvisoDoTime` confere
 * que a prévia é deste texto com a voz atual e que o objeto existe na pasta da
 * organização da SESSÃO, e grava fala e aviso numa transação sob a trava da linha
 * do time (lib/telefonia/emergencias.ts). Não conferiu, nada liga: tocar um aviso
 * com texto diferente do que o gerente acabou de ouvir seria pior que não tocar.
 * Quem exige "Gerar prévia" e "Ouvir" antes de "Ligar" é a tela (§6.3); a rota
 * garante a outra metade.
 *
 * Com o texto SALVO, sem mudança, ligar nem vai ao Storage — é o caminho do
 * incidente; com texto novo, a conferência da prévia tem prazo (5 s). Cada recusa
 * da fala tem a mensagem do LIGAR (`mensagemDaFalhaDoLigar`). Time arquivado não
 * liga (409 `time_arquivado`); o aviso que ele já tinha desliga normalmente.
 *
 * A duração vira `expires_at` aqui, com o relógio da requisição (`expiraEm`).
 * Desligar só mexe no aviso vigente: o vencido que o worker ainda não varreu é da
 * passada dele (`phone.emergency_expired`), e a resposta diz `desligado: false`.
 * Sem a telefonia oferecida nesta instalação, as duas respondem 409
 * `telefonia_nao_oferecida` sem tocar no banco — como o GET, que devolve a lista vazia.
 *
 * Auditoria: `phone.emergency_activated` com a duração, o prazo, a fala, se o
 * texto mudou e o período substituído, com quem o tinha ligado (religar com o
 * mesmo texto estende o prazo e troca o autor); `phone.prompt_saved` quando a
 * fala mudou; `phone.emergency_deactivated` só quando havia o que desligar.
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
import { armazemDaInstalacao } from "@/lib/telefonia/armazem";
import {
  MENSAGEM_DA_FALHA_DO_AVISO,
  QUEM_LIGOU_SEM_NOME,
  desligarAvisoDoTime,
  ligarAvisoDoTime,
  ligarAvisoSchema,
  mensagemDaFalhaDoLigar,
  type FalhaDoAviso,
  type PeriodoDoAviso,
} from "@/lib/telefonia/emergencias";
import { expiraEm } from "@/lib/telefonia/vencimento-da-emergencia";
import {
  MENSAGEM_DO_TEXTO_INVALIDO,
  STATUS_DA_FALHA,
  type AvisoDoTimePublico,
  type FalhaDaFala,
} from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

/**
 * A recusa própria do aviso: 404 para o time que não é desta organização; 409
 * para o time arquivado e para a linha do time presa por outra transação.
 */
function falhaDoAviso(motivo: FalhaDoAviso, t: (texto: string) => string, requestId: string): Response {
  if (motivo === "nao_encontrado") return fail("not_found", t(MENSAGEM_DA_FALHA_DO_AVISO.nao_encontrado), 404, { requestId });
  return fail(motivo, t(MENSAGEM_DA_FALHA_DO_AVISO[motivo]), 409, { requestId });
}

/** Sem a telefonia nesta instalação não há ligação para ouvir aviso nenhum. */
function semTelefonia(t: (texto: string) => string, requestId: string): Response {
  return fail("telefonia_nao_oferecida", t("O telefone não está ligado nesta instalação."), 409, { requestId });
}

/** O período substituído ou desligado, como a auditoria o guarda (snake_case). */
const periodoNaAuditoria = (p: PeriodoDoAviso) => ({ desde: p.desde, expira_em: p.expiraEm, ligado_por: p.ligadoPor });

export async function PUT(req: NextRequest, ctx: { params: Promise<{ teamId: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_avisos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (configAriDoAmbiente() === null) return semTelefonia(t, requestId);
  const id = idSchema.safeParse((await ctx.params).teamId);
  if (!id.success) return fail("not_found", t(MENSAGEM_DA_FALHA_DO_AVISO.nao_encontrado), 404, { requestId });
  const parsed = ligarAvisoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const doTexto = parsed.error.issues.some((i) => i.path[0] === "fala" && i.path[1] === "texto");
    return fail("validation_failed", doTexto ? t(MENSAGEM_DO_TEXTO_INVALIDO) : t("Campos inválidos."), 422, { requestId });
  }

  const org = authz.org.orgId;
  const { duracao } = parsed.data;
  const desde = new Date();
  const prazo = expiraEm(duracao, desde);
  const r = await ligarAvisoDoTime({
    pool: getRequestPool(),
    armazem: armazemDaInstalacao(),
    organizationId: org,
    userId: authz.user.id,
    teamId: id.data,
    fala: parsed.data.fala,
    desde,
    expiraEm: prazo,
  });
  if (!r.ok) {
    if (r.motivo === "nao_encontrado" || r.motivo === "time_arquivado" || r.motivo === "gravacao_em_andamento") {
      return falhaDoAviso(r.motivo, t, requestId);
    }
    // Ligar nunca vai à ElevenLabs: o texto recusado foi pela NOSSA régua.
    if (r.motivo === "texto_recusado") return fail("validation_failed", t(MENSAGEM_DO_TEXTO_INVALIDO), 422, { requestId });
    const motivo: FalhaDaFala = r.motivo;
    return fail(motivo, t(mensagemDaFalhaDoLigar(motivo)), STATUS_DA_FALHA[motivo], { requestId });
  }

  const teamId = r.time.id;
  void audit({
    action: "phone.emergency_activated",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "attendance_team",
    resourceId: teamId,
    metadata: {
      duracao,
      expira_em: prazo?.toISOString() ?? null,
      fala_id: r.fala.id,
      texto_mudou: r.mudou,
      anterior: r.anterior ? periodoNaAuditoria(r.anterior) : null,
    },
    requestId,
  });
  if (r.mudou) {
    void audit({
      action: "phone.prompt_saved",
      actorUserId: authz.user.id,
      organizationId: org,
      resourceType: "phone_prompt",
      resourceId: r.fala.id,
      metadata: { tipo: "emergency", hash: r.fala.hash, team_id: teamId },
      requestId,
    });
  }

  // A MESMA régua da leitura (GET): só o nome cadastrado; sem ele, o rótulo genérico — nunca o e-mail.
  const aviso: AvisoDoTimePublico = {
    team_id: teamId,
    time_nome: r.time.nome,
    arquivado: false,
    ativa: true,
    desde: desde.toISOString(),
    expira_em: prazo?.toISOString() ?? null,
    ligada_por: authz.user.full_name?.trim() || t(QUEM_LIGOU_SEM_NOME),
    fala: r.fala,
  };
  return ok({ aviso }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ teamId: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_avisos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (configAriDoAmbiente() === null) return semTelefonia(t, requestId);
  const id = idSchema.safeParse((await ctx.params).teamId);
  if (!id.success) return fail("not_found", t(MENSAGEM_DA_FALHA_DO_AVISO.nao_encontrado), 404, { requestId });
  const teamId = id.data;
  const r = await desligarAvisoDoTime(getRequestPool(), authz.org.orgId, teamId, new Date());
  if (!r.ok) return falhaDoAviso(r.motivo, t, requestId);

  if (r.desligado) {
    void audit({
      action: "phone.emergency_deactivated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "attendance_team",
      resourceId: teamId,
      metadata: { ligado_em: r.desligado.desde, expiraria_em: r.desligado.expiraEm, ligado_por: r.desligado.ligadoPor },
      requestId,
    });
  }
  return ok({ desligado: r.desligado !== null }, { requestId });
}
