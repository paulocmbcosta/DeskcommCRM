/**
 * GET /api/v1/telefonia/emergencias — o aviso de instabilidade de cada time da
 * organização (qualquer membro).
 *
 * É o que a faixa em todo o CRM e o cartão de Configurações › Times leem (a faixa
 * mostra os `ativa: true`). `ativa` é calculada contra o relógio da requisição
 * (`avisoVigente`): um aviso vencido que o worker ainda não desligou já aparece
 * desligado. Sem a telefonia oferecida nesta instalação, a lista vem vazia — não
 * há ligação para ouvir aviso nenhum. Leitura não audita.
 *
 * O nome de quem ligou sai pela régua de exibição do CRM (`nomesDeExibicao`), e
 * só para aviso vigente: sem aviso ligado — o caso de quase todo minuto da faixa
 * —, nenhuma chamada além das duas consultas.
 */
import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { avisosDaOrg } from "@/lib/telefonia/emergencias";
import { nomesDeExibicao } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "telefonia_avisos" });
  if (!authz.ok) return authz.response;
  const oferecida = configAriDoAmbiente() !== null;
  const times = oferecida ? await avisosDaOrg(getRequestPool(), authz.org.orgId, new Date(), nomesDeExibicao) : [];
  return ok({ oferecida, times }, { requestId });
}
