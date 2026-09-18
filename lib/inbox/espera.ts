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
 * Limite conhecido, e escrito para não virar surpresa: o banco guarda só a
 * ÚLTIMA entrada. Cliente que manda três mensagens em duas horas aparece como
 * "há 1 min", não "há 2 h". Medir desde a primeira sem resposta pede uma coluna
 * que ainda não existe.
 */

const TERMINAIS = new Set(["closed", "resolved", "archived"]);

/**
 * Os dois degraus da cor. Não são SLA — a instalação ainda não tem onde
 * configurar um —, são só o ponto em que a linha deixa de ser informação e
 * passa a ser pedido de atenção. Meia hora é quando o cliente de WhatsApp
 * começa a achar que foi esquecido; duas horas é quando ele tem certeza.
 */
export const ESPERA_ATENCAO_MS = 30 * 60_000;
export const ESPERA_CRITICA_MS = 2 * 60 * 60_000;

export type NivelDeEspera = "normal" | "atencao" | "critico";

export interface Espera {
  desde: Date;
  ms: number;
  nivel: NivelDeEspera;
}

export function esperaDaConversa(
  conversa: {
    status: string;
    last_inbound_at: string | null;
    last_outbound_at: string | null;
  },
  agora: Date,
): Espera | null {
  if (TERMINAIS.has(conversa.status)) return null;
  if (!conversa.last_inbound_at) return null;
  const entrada = new Date(conversa.last_inbound_at);
  if (Number.isNaN(entrada.getTime())) return null;
  if (conversa.last_outbound_at) {
    const saida = new Date(conversa.last_outbound_at);
    if (!Number.isNaN(saida.getTime()) && saida.getTime() >= entrada.getTime()) return null;
  }
  const ms = Math.max(0, agora.getTime() - entrada.getTime());
  const nivel: NivelDeEspera =
    ms >= ESPERA_CRITICA_MS ? "critico" : ms >= ESPERA_ATENCAO_MS ? "atencao" : "normal";
  return { desde: entrada, ms, nivel };
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
