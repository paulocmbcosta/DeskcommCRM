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
 * A duração vira `expires_at` aqui, com o relógio da requisição (`expiraEm`).
 * Desligar só mexe no aviso vigente: o vencido que o worker ainda não varreu é da
 * passada dele (`phone.emergency_expired`), e a resposta diz `desligado: false`.
 *
 * Auditoria: `phone.emergency_activated` com a duração, o prazo, a fala e se o
 * texto mudou (e o período substituído, se havia um); `phone.prompt_saved` quando
 * a fala mudou; `phone.emergency_deactivated` só quando havia o que desligar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  MENSAGEM_DA_FALHA_DO_AVISO,
  desligarAvisoDoTime,
  ligarAvisoDoTime,
  ligarAvisoSchema,
  type FalhaDoAviso,
} from "@/lib/telefonia/emergencias";
import { STATUS_DA_FALHA, armazemDaInstalacao } from "@/lib/telefonia/servico-de-falas";
import { expiraEm } from "@/lib/telefonia/vencimento-da-emergencia";
import {
  MENSAGEM_DA_FALHA_DA_FALA,
  MENSAGEM_DO_TEXTO_INVALIDO,
  type AvisoDoTimePublico,
  type FalhaDaFala,
} from "@/lib/telefonia/vocabulario";
import { nomesDeExibicao } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

/** A recusa própria do aviso: 404 para o time que não é desta organização, 409 para a trava ocupada. */
function falhaDoAviso(motivo: FalhaDoAviso, t: (texto: string) => string, requestId: string): Response {
  if (motivo === "nao_encontrado") return fail("not_found", t(MENSAGEM_DA_FALHA_DO_AVISO.nao_encontrado), 404, { requestId });
  return fail(motivo, t(MENSAGEM_DA_FALHA_DO_AVISO[motivo]), 409, { requestId });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ teamId: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_avisos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

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
    if (r.motivo === "nao_encontrado" || r.motivo === "gravacao_em_andamento") return falhaDoAviso(r.motivo, t, requestId);
    // Salvar nunca vai à ElevenLabs: o texto recusado foi pela NOSSA régua.
    if (r.motivo === "texto_recusado") return fail("validation_failed", t(MENSAGEM_DO_TEXTO_INVALIDO), 422, { requestId });
    const motivo: FalhaDaFala = r.motivo;
    return fail(motivo, t(MENSAGEM_DA_FALHA_DA_FALA[motivo]), STATUS_DA_FALHA[motivo], { requestId });
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
      anterior: r.anterior ? { desde: r.anterior.desde, expira_em: r.anterior.expiraEm } : null,
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

  // O nome pela MESMA régua da leitura (GET): quem acabou de ligar vê o que todos verão.
  const nome = (await nomesDeExibicao([authz.user.id])).get(authz.user.id) ?? null;
  const aviso: AvisoDoTimePublico = {
    team_id: teamId,
    time_nome: r.time.nome,
    ativa: true,
    desde: desde.toISOString(),
    expira_em: prazo?.toISOString() ?? null,
    ligada_por: nome,
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
      metadata: { ligado_em: r.desligado.desde, expiraria_em: r.desligado.expiraEm },
      requestId,
    });
  }
  return ok({ desligado: r.desligado !== null }, { requestId });
}
