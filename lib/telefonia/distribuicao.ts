/**
 * QUEM TOCA — a regra de distribuição da ligação recebida (spec 20 §2).
 *
 * Decisão do dono do produto: recebe quem ATENDEU menos ligações hoje, no fuso
 * da organização. Contar as oferecidas premiaria quem recusa — cada recusa
 * empurraria a próxima ligação para um colega. Empate: quem está há mais tempo
 * sem atender (quem nunca atendeu hoje vem antes de quem atendeu cedo). Último
 * desempate: o id, só para a ordem ser determinística e o teste, reproduzível.
 *
 * Toca UM por vez, 20 s cada, e dá DUAS voltas na lista. Quem já tocou nesta
 * volta não toca de novo nela; quem ficou indisponível no meio sai da conta na
 * próxima leitura — a lista é relida a cada toque, porque 20 s bastam para
 * alguém entrar em pausa ou atender outra ligação.
 *
 * Funções puras: quem lê o banco é o controlador (`lib/channels/telefonia/`).
 */

export const TOQUE_POR_ATENDENTE_MS = 20_000;
export const VOLTAS_PELA_LISTA = 2;
/** Ninguém disponível: fila com música, reavaliando a cada tanto, até o teto. */
export const ESPERA_NA_FILA_MS = 120_000;
export const REAVALIAR_FILA_MS = 5_000;

export interface CandidatoAoToque {
  userId: string;
  /** Ligações ATENDIDAS hoje, no fuso da organização. */
  atendidasHoje: number;
  /** Quando atendeu a última ligação (qualquer dia). `null` = nunca. */
  ultimaAtendidaEm: Date | null;
}

/** A fila de quem toca primeiro. Não altera a entrada. */
export function ordemDeToque(candidatos: readonly CandidatoAoToque[]): string[] {
  return [...candidatos]
    .sort((a, b) => {
      if (a.atendidasHoje !== b.atendidasHoje) return a.atendidasHoje - b.atendidasHoje;
      const ta = a.ultimaAtendidaEm?.getTime() ?? -Infinity;
      const tb = b.ultimaAtendidaEm?.getTime() ?? -Infinity;
      if (ta !== tb) return ta - tb;
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    })
    .map((c) => c.userId);
}

export interface EstadoDoToque {
  /** Volta atual, a partir de 1. */
  volta: number;
  /** Quem já tocou nesta volta. */
  tocaramNestaVolta: ReadonlySet<string>;
}

export const ESTADO_INICIAL: EstadoDoToque = { volta: 1, tocaramNestaVolta: new Set() };

export type ProximoToque =
  | { tipo: "tocar"; userId: string; estado: EstadoDoToque }
  /** Ninguém disponível agora: esperar na fila e perguntar de novo. */
  | { tipo: "esperar" }
  /** Todas as voltas esgotadas com gente disponível que não atendeu. */
  | { tipo: "desistir" };

/**
 * Próximo a tocar, dado quem está disponível AGORA (já sem quem está em pausa,
 * offline, fora do horário ou em outra ligação).
 *
 * Disponíveis que já tocaram nesta volta não tocam de novo nela; esgotada a
 * volta, abre a próxima. Esgotadas as voltas, desiste. Lista vazia é "esperar",
 * não "desistir": ninguém disponível é o caso da fila, e as voltas contam
 * tentativas de atender, não segundos de espera.
 */
export function proximoToque(
  disponiveis: readonly CandidatoAoToque[],
  estado: EstadoDoToque,
  voltas: number = VOLTAS_PELA_LISTA,
): ProximoToque {
  if (disponiveis.length === 0) return { tipo: "esperar" };
  const ordem = ordemDeToque(disponiveis);

  const naVolta = ordem.find((id) => !estado.tocaramNestaVolta.has(id));
  if (naVolta) {
    return {
      tipo: "tocar",
      userId: naVolta,
      estado: { volta: estado.volta, tocaramNestaVolta: new Set([...estado.tocaramNestaVolta, naVolta]) },
    };
  }

  if (estado.volta >= voltas) return { tipo: "desistir" };
  const primeiro = ordem[0]!;
  return {
    tipo: "tocar",
    userId: primeiro,
    estado: { volta: estado.volta + 1, tocaramNestaVolta: new Set([primeiro]) },
  };
}

// ─── a espera máxima, por time (migration 0295) ───────────────────────────

/** Os limites de `attendance_teams.phone_queue_max_wait_seconds` (o CHECK do banco é o mesmo). */
export const ESPERA_NA_FILA_MIN_S = 30;
export const ESPERA_NA_FILA_MAX_S = 1800;
/** O que a tela oferece (Configurações › Times): 2, 5, 10, 15, 20 e 30 minutos. O primeiro é o padrão. */
export const OPCOES_DE_ESPERA_NA_FILA_S = [120, 300, 600, 900, 1200, 1800] as const;

/**
 * A espera máxima de um time, em ms. Sem configuração (ou com um valor que não
 * é número), o padrão de sempre — a fila nunca fica sem teto por causa de um
 * dado ruim. Preso aos limites: o banco já recusa fora deles, e o worker não
 * depende disso.
 */
export function esperaMaximaMs(segundos: number | null | undefined): number {
  if (typeof segundos !== "number" || !Number.isFinite(segundos)) return ESPERA_NA_FILA_MS;
  return Math.min(Math.max(Math.round(segundos), ESPERA_NA_FILA_MIN_S), ESPERA_NA_FILA_MAX_S) * 1000;
}

// ─── a vez na fila (ordem de chegada) ─────────────────────────────────────

/**
 * É a vez desta ligação tocar? Com `livres` atendentes livres, só as `livres`
 * ligações mais ANTIGAS que esperam (sem ramal tocando) podem tocar; as outras
 * esperam. `naFrente` = quantas, do mesmo time, chegaram antes desta e ainda
 * esperam. Sem isto, quem pegava o atendente que desocupou era a ligação cujo
 * relógio de 5 s disparasse primeiro — não a que esperava há mais tempo.
 */
export function eAVezDela(naFrente: number, livres: number): boolean {
  return naFrente < livres;
}
