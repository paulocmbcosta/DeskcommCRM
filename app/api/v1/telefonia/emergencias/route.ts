/**
 * GET /api/v1/telefonia/emergencias — o aviso de instabilidade dos times da
 * organização (qualquer membro).
 *
 * Cada papel recebe o que usa (`AvisosNaResposta`):
 *  - todos: `ligados`, a FAIXA em todo o CRM — os avisos vigentes, com o time, o
 *    prazo e se o time foi arquivado (o aviso vigente de time arquivado segue na
 *    faixa, para alguém desligar);
 *  - gerente e admin (`pode_mudar`): também `times`, a lista completa do cartão
 *    de Configurações › Times — o texto salvo, quando ligou e quem ligou. O nome
 *    é só o CADASTRADO (`nomesDosAtendentes`); sem ele, "alguém da equipe" —
 *    nunca o e-mail nem o começo dele. Viewer e agent recebem `times: null`, e
 *    nenhum nome é pedido para eles.
 *
 * O vigente é calculado contra o relógio da requisição (`avisoVigente`): um aviso
 * vencido que o worker ainda não desligou já aparece desligado. Sem a telefonia
 * oferecida nesta instalação, as listas vêm vazias — não há ligação para ouvir
 * aviso nenhum. Leitura não audita.
 */
import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { traduzir } from "@/lib/i18n/dicionario";
import { QUEM_LIGOU_SEM_NOME, avisosDaOrg, avisosLigados, naFaixa } from "@/lib/telefonia/emergencias";
import type { AvisosNaResposta } from "@/lib/telefonia/vocabulario";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "telefonia_avisos" });
  if (!authz.ok) return authz.response;
  // A decisão de ACESSO é o `requireRole` acima; isto só escolhe o quanto a resposta leva.
  const podeMudar = roleAtLeast(authz.org.role, "manager");
  const org = authz.org.orgId;

  let resposta: AvisosNaResposta;
  if (configAriDoAmbiente() === null) {
    resposta = { oferecida: false, pode_mudar: podeMudar, ligados: [], times: podeMudar ? [] : null };
  } else if (podeMudar) {
    const semNome = traduzir(QUEM_LIGOU_SEM_NOME, authz.user.idioma);
    const times = await avisosDaOrg(getRequestPool(), org, new Date(), nomesDosAtendentes, semNome);
    resposta = { oferecida: true, pode_mudar: true, ligados: naFaixa(times), times };
  } else {
    resposta = { oferecida: true, pode_mudar: false, ligados: await avisosLigados(getRequestPool(), org, new Date()), times: null };
  }
  return ok(resposta, { requestId });
}
