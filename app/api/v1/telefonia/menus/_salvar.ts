/**
 * O miolo de POST (cria) e PATCH (edita) de um menu de voz — a mesma sequência
 * nos dois: papel (admin); validar o corpo; salvar
 * (`salvarMenuDaOrg`, lib/telefonia/menus.ts: confere as DUAS falas contra as
 * prévias fora da transação e grava falas, menu e opções numa transação só, sob a
 * trava do menu); traduzir a falha; auditar.
 *
 * As falas chegam como texto + hash da PRÉVIA (`POST /api/v1/telefonia/falas/previa`),
 * ou como a fala em uso quando o texto não mudou. Esta rota NÃO chama a
 * ElevenLabs (desenho D15): confere e aponta. A organização é a da SESSÃO — o
 * corpo é `strict` e não a aceita.
 *
 * A guarda de suporte (`requireSupportWrite`) fica no HANDLER, antes de chamar
 * este miolo: é lá que `tests/unit/suporte-cobertura-de-efeitos.test.ts` a procura,
 * e um handler mutante sem ela no próprio corpo é reprovado.
 *
 * A falha de uma fala leva `details.fala` (`menu` ou `invalida`): a tela marca o
 * campo certo. Áudio sumido ou Storage fora dizem qual fala e que a prévia se gera
 * de novo (`MENSAGEM_DO_AUDIO_DA_FALA_DO_MENU`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  MENSAGEM_DA_FALHA_DO_MENU,
  MENSAGEM_DO_AUDIO_DA_FALA_DO_MENU,
  menuSchema,
  menusDaOrg,
  salvarMenuDaOrg,
  type QualFala,
} from "@/lib/telefonia/menus";
import { STATUS_DA_FALHA, armazemDaInstalacao } from "@/lib/telefonia/servico-de-falas";
import { MENSAGEM_DA_FALHA_DA_FALA, MENSAGEM_DO_TEXTO_INVALIDO, type FalhaDaFala } from "@/lib/telefonia/vocabulario";

const idSchema = z.string().uuid();

/** `idBruto` = o `[id]` do caminho no PATCH; `null` no POST. Validado DEPOIS do papel. */
export async function salvarMenu(req: NextRequest, idBruto: string | null): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_menus" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let idDoMenu: string | null = null;
  if (idBruto !== null) {
    const id = idSchema.safeParse(idBruto);
    if (!id.success) return fail("not_found", t(MENSAGEM_DA_FALHA_DO_MENU.nao_encontrado), 404, { requestId });
    idDoMenu = id.data;
  }

  const parsed = menuSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const doTexto = parsed.error.issues.some(
      (i) => (i.path[0] === "fala" || i.path[0] === "fala_invalida") && i.path[1] === "texto",
    );
    return fail("validation_failed", doTexto ? t(MENSAGEM_DO_TEXTO_INVALIDO) : t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const e = parsed.data;
  const org = authz.org.orgId;
  const pool = getRequestPool();

  const falharFala = (motivo: FalhaDaFala, fala: QualFala) => {
    const details = { fala };
    if (motivo === "texto_recusado") return fail("validation_failed", t(MENSAGEM_DO_TEXTO_INVALIDO), 422, { requestId, details });
    const mensagem =
      motivo === "previa_ausente" || motivo === "armazenamento"
        ? MENSAGEM_DO_AUDIO_DA_FALA_DO_MENU[motivo][fala]
        : MENSAGEM_DA_FALHA_DA_FALA[motivo];
    return fail(motivo, t(mensagem), STATUS_DA_FALHA[motivo], { requestId, details });
  };

  const r = await salvarMenuDaOrg({
    pool,
    armazem: armazemDaInstalacao(),
    organizationId: org,
    userId: authz.user.id,
    id: idDoMenu,
    entrada: e,
  });
  if (!r.ok) {
    if ("fala" in r) return falharFala(r.motivo, r.fala);
    if (r.motivo === "nao_encontrado") return fail("not_found", t(MENSAGEM_DA_FALHA_DO_MENU.nao_encontrado), 404, { requestId });
    return fail(r.motivo, t(MENSAGEM_DA_FALHA_DO_MENU[r.motivo]), r.motivo === "gravacao_em_andamento" ? 409 : 422, {
      requestId,
    });
  }

  void audit({
    action: "phone.menu_saved",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "phone_menu",
    resourceId: r.id,
    metadata: {
      novo: !idDoMenu,
      nome: e.nome,
      opcoes: e.opcoes,
      time_padrao_id: e.time_padrao_id,
      com_fala_invalida: Boolean(e.fala_invalida),
      fala_invalida_descartada: r.falaInvalidaDescartada,
    },
    requestId,
  });
  for (const gravada of [r.fala, r.falaInvalida]) {
    if (!gravada?.mudou) continue;
    void audit({
      action: "phone.prompt_saved",
      actorUserId: authz.user.id,
      organizationId: org,
      resourceType: "phone_prompt",
      resourceId: gravada.fala.id,
      metadata: { tipo: gravada.fala.tipo, hash: gravada.fala.hash, menu_id: r.id },
      requestId,
    });
  }

  const menus = await menusDaOrg(pool, org);
  return ok({ menu: menus.find((m) => m.id === r.id) ?? null }, { requestId, status: idDoMenu ? 200 : 201 });
}
