/**
 * PUT /api/v1/telefonia/falas/gerais/[tipo] — o "Salvar e usar" de uma fala geral
 * da organização: `waiting` (aguarde), `nobody` (ninguém atendeu) ou `after_hours`
 * (fora do horário). Admin.
 *
 * Desenho da fase 2, §4 (passo 3) e §6.2. O corpo traz o texto e o HASH da prévia
 * dele (`POST /api/v1/telefonia/falas/previa`) — nunca um caminho, nunca a
 * organização (`falaParaSalvarSchema` é `strict`). Esta rota NÃO chama a
 * ElevenLabs: `salvarFalaGeral` trava a linha de `phone_settings` da organização
 * da SESSÃO, confere que o hash é o do texto com a voz atual e que
 * `<org da sessão>/<hash>.ulaw` existe, aponta a linha de `phone_prompts` para ele
 * e liga a fala à coluna do tipo — tudo numa transação. A trava é o que impede
 * duas primeiras gravações simultâneas de deixarem uma linha órfã
 * (tests/invariants/telefonia-fala-geral-concorrente.test.ts).
 *
 * A partir daí as ligações tocam o áudio novo. A mesma fala de novo não escreve
 * nem audita. O texto recusado pela nossa régua tem mensagem própria: salvar
 * nunca vai à ElevenLabs, então nunca foi ela que recusou.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { falaParaSalvarSchema, salvarFalaGeral } from "@/lib/telefonia/falas";
import { STATUS_DA_FALHA, armazemDaInstalacao } from "@/lib/telefonia/servico-de-falas";
import {
  FALAS_GERAIS,
  MENSAGEM_DA_FALHA_DA_FALA,
  MENSAGEM_DO_TEXTO_INVALIDO,
  type FalaGeral,
} from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ tipo: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_falas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const tipoBruto = (await ctx.params).tipo;
  if (!(FALAS_GERAIS as readonly string[]).includes(tipoBruto)) {
    return fail("not_found", t("Fala não encontrada."), 404, { requestId });
  }
  const tipo = tipoBruto as FalaGeral;

  const parsed = falaParaSalvarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const doTexto = parsed.error.issues.some((i) => i.path[0] === "texto");
    return fail("validation_failed", doTexto ? t(MENSAGEM_DO_TEXTO_INVALIDO) : t("Campos inválidos."), 422, { requestId });
  }

  const org = authz.org.orgId;
  const r = await salvarFalaGeral({
    pool: getRequestPool(),
    armazem: armazemDaInstalacao(),
    organizationId: org,
    userId: authz.user.id,
    tipo,
    texto: parsed.data.texto,
    hash: parsed.data.hash,
  });
  if (!r.ok) {
    if (r.motivo === "texto_recusado") {
      return fail("validation_failed", t(MENSAGEM_DO_TEXTO_INVALIDO), 422, { requestId });
    }
    return fail(r.motivo, t(MENSAGEM_DA_FALHA_DA_FALA[r.motivo]), STATUS_DA_FALHA[r.motivo], { requestId });
  }

  if (r.mudou) {
    void audit({
      action: "phone.prompt_saved",
      actorUserId: authz.user.id,
      organizationId: org,
      resourceType: "phone_prompt",
      resourceId: r.fala.id,
      metadata: { tipo, hash: r.fala.hash },
      requestId,
    });
  }
  return ok({ fala: r.fala }, { requestId });
}
