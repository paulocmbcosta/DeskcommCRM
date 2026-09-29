/**
 * O miolo de POST (cria) e PATCH (edita) de um menu de voz — a mesma sequência
 * nos dois: papel (admin); validar o corpo; salvar (`salvarMenuDaOrg`,
 * lib/telefonia/menus.ts: confere as DUAS falas contra as prévias fora da
 * transação e grava falas, menu e opções numa transação só, sob a trava do menu);
 * traduzir a falha; auditar.
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
 *
 * A RESPOSTA é o menu que a transação gravou (`resultado.menu`), sem reler a lista.
 * A semana: menu novo não tem ligação nenhuma; no editado, lê-se só a dele
 * (`semanaDoMenu`) — e, se ESSA leitura falhar, o menu já está gravado: a resposta
 * é `menu: null` (a tela relê a lista), nunca um 500 que faria a pessoa salvar de
 * novo algo que já salvou.
 *
 * O POST aceita `Idempotency-Key: <uuid>` (CLAUDE.md, spec 01 §7.3), pelo helper
 * do repo (`comIdempotencia`, lib/api/idempotency.ts): a mesma chave com o mesmo
 * corpo devolve o menu da primeira vez sem criar outro; com outro corpo, 409
 * `idempotency_conflict`. Recusa (422/409/502) não vira recibo — a mesma chave
 * pode tentar de novo depois de gerar a prévia. O que o helper NÃO cobre (duas
 * requisições SIMULTÂNEAS com a mesma chave) está no cabeçalho dele.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { armazemDaInstalacao } from "@/lib/telefonia/armazem";
import {
  MENSAGEM_DA_FALHA_DO_MENU,
  MENSAGEM_DO_AUDIO_DA_FALA_DO_MENU,
  menuSchema,
  salvarMenuDaOrg,
  semanaDoMenu,
  type QualFala,
} from "@/lib/telefonia/menus";
import { somarUltimosSeteDias } from "@/lib/telefonia/ultimos-sete-dias";
import {
  MENSAGEM_DA_FALHA_DA_FALA,
  MENSAGEM_DO_TEXTO_INVALIDO,
  STATUS_DA_FALHA,
  type FalhaDaFala,
  type MenuPublico,
} from "@/lib/telefonia/vocabulario";

const idSchema = z.string().uuid();

/** Tag do endpoint no recibo de idempotência. Muda de rota, muda de recibo. */
const ENDPOINT_DA_CRIACAO = "/api/v1/telefonia/menus";

/** O corpo da resposta de sucesso — o que o recibo de idempotência guarda. */
interface RespostaDoMenu {
  menu: MenuPublico | null;
}

/** A recusa do salvar, carregada para FORA do `executar` da idempotência sem virar recibo. */
class Recusa extends Error {
  constructor(readonly resposta: Response) {
    super("recusa do salvar menu");
  }
}

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

  // Só a CRIAÇÃO aceita a chave; malformada é recusada antes de qualquer efeito, sem recibo.
  const chave = idDoMenu === null ? chaveDaRequisicao(req) : null;
  if (chave !== null && !idSchema.safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

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

  /** O efeito: salva, audita e descreve o menu. Recusa LANÇA `Recusa` — assim não vira recibo. */
  const efetivar = async (): Promise<{ resposta: RespostaDoMenu; status: 200 | 201 }> => {
    const r = await salvarMenuDaOrg({
      pool,
      armazem: armazemDaInstalacao(),
      organizationId: org,
      userId: authz.user.id,
      id: idDoMenu,
      entrada: e,
    });
    if (!r.ok) {
      if ("fala" in r) throw new Recusa(falharFala(r.motivo, r.fala));
      if (r.motivo === "nao_encontrado") {
        throw new Recusa(fail("not_found", t(MENSAGEM_DA_FALHA_DO_MENU.nao_encontrado), 404, { requestId }));
      }
      throw new Recusa(
        fail(r.motivo, t(MENSAGEM_DA_FALHA_DO_MENU[r.motivo]), r.motivo === "gravacao_em_andamento" ? 409 : 422, { requestId }),
      );
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

    if (!idDoMenu) return { resposta: { menu: { ...r.menu, ultimos_7_dias: somarUltimosSeteDias([]) } }, status: 201 };
    try {
      return { resposta: { menu: { ...r.menu, ultimos_7_dias: await semanaDoMenu(pool, org, r.id) } }, status: 200 };
    } catch (erro) {
      logger.warn("[telefonia] menu salvo, mas a semana dele não pôde ser lida", {
        organization_id: org,
        menu_id: r.id,
        causa: erro instanceof Error ? erro.message.slice(0, 300) : "desconhecida",
      });
      return { resposta: { menu: null }, status: 200 };
    }
  };

  try {
    if (chave === null) {
      const { resposta, status } = await efetivar();
      return ok(resposta, { requestId, status });
    }
    const desfecho = await comIdempotencia<RespostaDoMenu>({
      db: await createClient(),
      organizationId: org,
      endpoint: ENDPOINT_DA_CRIACAO,
      chave,
      corpo: e,
      executar: efetivar,
    });
    if (desfecho.tipo === "conflito") {
      return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, { requestId });
    }
    // O recibo só guarda sucesso deste endpoint de criação: 201.
    return ok(desfecho.resposta, { requestId, status: desfecho.status === 200 ? 200 : 201 });
  } catch (erro) {
    if (erro instanceof Recusa) return erro.resposta;
    throw erro;
  }
}
