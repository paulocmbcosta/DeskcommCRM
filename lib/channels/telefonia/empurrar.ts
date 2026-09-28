/**
 * O caminho RÁPIDO da sincronização (spec 20 §4.1): a rota que salva um número
 * empurra o tronco para o Asterisk na mesma requisição, para o estado aparecer
 * em segundos. Nunca lança — se o Asterisk não estiver alcançável agora, o
 * worker reconcilia em até um minuto, e a tela mostra "Conectando" até lá.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { logger } from "@/lib/logger";

import { ClienteAri, configAriDoAmbiente } from "./ari";
import { troncoPorId } from "./repositorio";
import { TroncoInvalido, empurrarTronco, retirarTronco } from "./sincronizacao";

export async function empurrarTroncoAgora(db: Queryable, id: string): Promise<void> {
  const cfg = configAriDoAmbiente();
  if (!cfg) return;
  try {
    const tronco = await troncoPorId(db, id);
    if (tronco) await empurrarTronco(new ClienteAri(cfg), tronco);
  } catch (e) {
    // A rota validou com a mesma régua, então isto só acontece se a linha mudou
    // por fora (REST) entre gravar e empurrar. Não é "o worker reconcilia": o
    // worker também recusa, e marca o número como falho na tela.
    if (e instanceof TroncoInvalido) {
      logger.warn("[telefonia] tronco com configuração inválida não empurrado", { tronco: id, problema: e.motivo });
      return;
    }
    logger.warn("[telefonia] tronco não empurrado agora — o worker reconcilia", {
      tronco: id,
      erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
    });
  }
}

export async function retirarTroncoAgora(id: string): Promise<void> {
  const cfg = configAriDoAmbiente();
  if (!cfg) return;
  try {
    await retirarTronco(new ClienteAri(cfg), id);
  } catch (e) {
    logger.warn("[telefonia] tronco não retirado agora — o worker reconcilia", {
      tronco: id,
      erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
    });
  }
}
