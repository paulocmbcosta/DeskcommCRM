/**
 * GET /api/v1/telefonia/voz/vozes — as vozes da conta da ElevenLabs da organização (admin).
 *
 * A lista vem ao vivo da ElevenLabs (com a amostra pública de cada voz, para o
 * "Ouvir amostra"); nada é copiado para o banco — o nome de uma voz é da conta
 * do cliente, e muda lá. Listar vozes não sintetiza nada e não gasta crédito. A
 * falha dela volta 422/502 (`STATUS_DA_FALHA`), nunca 429/503.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { chaveDeVoz } from "@/lib/telefonia/chave-elevenlabs";
import { ErroDaElevenLabs, listarVozes } from "@/lib/telefonia/elevenlabs";
import { opcoesDaElevenLabs } from "@/lib/telefonia/servico-de-falas";
import { MENSAGEM_DA_FALHA_DA_FALA, STATUS_DA_FALHA, type FalhaDaFala } from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_voz" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const falhar = (motivo: FalhaDaFala) =>
    fail(motivo, t(MENSAGEM_DA_FALHA_DA_FALA[motivo]), STATUS_DA_FALHA[motivo], { requestId });

  const chave = await chaveDeVoz(getRequestPool(), authz.org.orgId);
  if (!chave) return falhar("sem_chave");
  try {
    return ok({ vozes: await listarVozes(chave, opcoesDaElevenLabs()) }, { requestId });
  } catch (e) {
    return falhar(e instanceof ErroDaElevenLabs ? e.motivo : "erro_do_provedor");
  }
}
