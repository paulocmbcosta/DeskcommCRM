/**
 * HÁ QUANTO TEMPO O CLIENTE ESPERA — a linha do card que responde "qual eu
 * atendo primeiro?" sem ninguém abrir conversa nenhuma.
 *
 * Ela existia só na aba Fila, em cinza de 11px ("Aguardando há 5 min"), e sumia
 * nas outras abas — justo onde mora a conversa que TEM dono e está parada, que
 * é a espera que mais custa: a fila pelo menos está à vista de todos.
 *
 * ═══ Quando há espera ═══
 *
 * A última palavra foi do cliente e o atendimento não acabou. É a mesma régua
 * do `waitingLabel` da Fila (`last_inbound_at`), com uma condição a mais: se a
 * empresa já respondeu DEPOIS, quem deve o próximo movimento é o cliente, e
 * pintar aquilo de vermelho seria cobrar o atendente por esperar.
 *
 * Desde QUANDO: `espera_desde` (migration 0279), a PRIMEIRA mensagem do cliente
 * ainda sem resposta — não a última. Cliente que manda "oi" às 10h00 e "alguém
 * aí?" às 10h09 espera há 10 min, não há 1. Resposta de versão anterior ainda em
 * cache (sem o campo) cai na régua antiga, pela última entrada.
 *
 * Só com GENTE no comando (`humano` ou `aguardando`). No automático a IA leva de
 * 1 a 3 minutos para responder, e a régua de minutos pintaria de amarelo toda
 * conversa que o robô está atendendo normalmente.
 */

import { REGUA_DE_ESPERA_PADRAO, type ReguaDeEspera } from "@/lib/schemas/settings";

const TERMINAIS = new Set(["closed", "resolved", "archived"]);
const COMANDOS_QUE_ESPERAM_GENTE = new Set(["humano", "aguardando"]);

/**
 * Os degraus vêm da organização (`settings.inbox.regua_de_espera`, padrão
 * 2 / 5 / 10 min). `vermelho` é o que pulsa no card.
 */
export type NivelDeEspera = "normal" | "amarelo" | "laranja" | "vermelho";

export interface Espera {
  desde: Date;
  ms: number;
  nivel: NivelDeEspera;
}

export interface ConversaComEspera {
  status: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  /** `undefined` = resposta antiga, sem o campo; `null` = ninguém deve resposta. */
  espera_desde?: string | null;
  comando_da_conversa?: string | null;
}

export function nivelDaEspera(ms: number, regua: ReguaDeEspera = REGUA_DE_ESPERA_PADRAO): NivelDeEspera {
  const min = ms / 60_000;
  if (min >= regua.vermelho_min) return "vermelho";
  if (min >= regua.laranja_min) return "laranja";
  if (min >= regua.amarelo_min) return "amarelo";
  return "normal";
}

function data(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function esperaDaConversa(
  conversa: ConversaComEspera,
  agora: Date,
  regua: ReguaDeEspera = REGUA_DE_ESPERA_PADRAO,
): Espera | null {
  if (TERMINAIS.has(conversa.status)) return null;
  if (conversa.comando_da_conversa && !COMANDOS_QUE_ESPERAM_GENTE.has(conversa.comando_da_conversa)) return null;

  let desde: Date | null;
  if (conversa.espera_desde !== undefined) {
    desde = data(conversa.espera_desde);
  } else {
    // Régua antiga: a última entrada, se ninguém respondeu depois dela.
    desde = data(conversa.last_inbound_at);
    const saida = data(conversa.last_outbound_at);
    if (desde && saida && saida.getTime() >= desde.getTime()) desde = null;
  }
  if (!desde) return null;
  const ms = Math.max(0, agora.getTime() - desde.getTime());
  return { desde, ms, nivel: nivelDaEspera(ms, regua) };
}

/**
 * NA FILA DO TIME: foi para um setor, ninguém pegou, e a IA saiu do comando — o
 * cliente depende de uma pessoa que ainda não apareceu. É o gargalo que o selo
 * "Na fila · <time>" e o chip "Só na fila" mostram.
 *
 * ⚠️ A MESMA régua mora no filtro do banco (`aplicarNaFilaDoTime`, em
 * `app/api/v1/conversations/_na-fila.ts`): time definido, sem dono, não
 * encerrada, `bot_silenced_until` no futuro. Pergunta a coluna, e não o campo
 * calculado `comando_da_conversa`, porque ela entra em UMA contagem por time — o
 * campo calculado lê `contacts` duas vezes por linha (incidente de 2026-09-24,
 * migration 0278). Transferência e handoff gravam o silêncio, então os dois
 * caminhos reais caem aqui.
 */
export function estaNaFilaDoTime(
  conversa: {
    status: string;
    team_id?: string | null;
    assigned_to_user_id: string | null;
    bot_silenced_until: string | null;
  },
  agora: Date,
): boolean {
  if (!conversa.team_id || conversa.assigned_to_user_id) return false;
  if (TERMINAIS.has(conversa.status)) return false;
  const silencio = conversa.bot_silenced_until;
  if (!silencio) return false;
  if (silencio === "infinity") return true;
  const ate = data(silencio);
  return ate !== null && ate.getTime() > agora.getTime();
}

/**
 * "menos de 1 min", "12 min", "3h 51min", "2d 4h" — duas unidades, porque aqui
 * o minuto decide: entre 1h05 e 1h55 há uma hora inteira de cliente esperando.
 */
export function formatarEspera(ms: number, t: (texto: string) => string = (texto) => texto): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t("menos de 1 min");
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h}h` : `${h}h ${min % 60}min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}
