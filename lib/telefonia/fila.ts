/**
 * A FILA DO TELEFONE, como a tela a lê (aba Telefone do Inbox; migration 0295).
 * Tipos da resposta de `GET /api/v1/telefonia/fila` e as regras puras que o
 * servidor e a tela dividem — a fase de uma ligação, a posição na fila, por que
 * uma ligação se perdeu, e o relógio "m:ss". Quem lê o banco é
 * `lib/channels/telefonia/fila-da-tela.ts`.
 */
import { esperaMaximaMs } from "./distribuicao";
import { MOTIVO_FORA_DO_HORARIO } from "./vocabulario";

/** Onde a ligação está AGORA. */
export const FASES_DA_LIGACAO = ["menu", "avisos", "aguardando", "tocando", "em_ligacao", "transferencia_na_fila"] as const;
export type FaseDaLigacao = (typeof FASES_DA_LIGACAO)[number];

/** As fases que contam como "esperando por alguém" — o selo do trilho e a contagem do chip. */
export const FASES_QUE_ESPERAM: ReadonlySet<FaseDaLigacao> = new Set(["aguardando", "tocando", "transferencia_na_fila"]);

export const MOTIVOS_DA_PERDIDA = ["desligou_no_menu", "desistiu_na_fila", "fila_esgotada", "ninguem_atendeu", "fora_do_horario", "interrompida", "outro"] as const;
export type MotivoDaPerdida = (typeof MOTIVOS_DA_PERDIDA)[number];

export interface PessoaDaFila {
  id: string;
  nome: string | null;
}

export interface LigacaoNaFila {
  id: string;
  fase: FaseDaLigacao;
  /** O contato, se a ligação tem um (número oculto não tem). */
  contato: { id: string; nome: string | null } | null;
  /** O número de quem liga (E.164, ou o que a operadora mandou). */
  numero: string;
  /** O time da fila em que ela está (na transferência para um time, o time de destino). */
  time_id: string | null;
  /** O número da EMPRESA que foi chamado. */
  numero_da_empresa_id: string;
  conversa_id: string | null;
  /** Quando a ligação começou. */
  entrou_em: string;
  /** Quando passou a esperar por uma pessoa (`queued_at`); na transferência, quando ela foi pedida. `null` no menu e nos avisos. */
  na_fila_desde: string | null;
  /** A posição na fila do time (1 = a próxima); `null` fora de `aguardando`/`tocando`. */
  posicao: number | null;
  /** Quando a espera sem ninguém livre esgota; só em `aguardando`. */
  cai_em: string | null;
  tocando_para: PessoaDaFila | null;
  /** Com quem está falando (`em_ligacao`) — ou quem transferiu (`transferencia_na_fila`). */
  com: PessoaDaFila | null;
  atendida_em: string | null;
}

export interface PerdidaRecente {
  id: string;
  contato: { id: string; nome: string | null } | null;
  numero: string;
  time_id: string | null;
  numero_da_empresa_id: string;
  conversa_id: string | null;
  motivo: MotivoDaPerdida;
  /** Quanto esperou até a ligação acabar, em segundos (do começo da fila; sem fila, do começo da ligação). */
  esperou_s: number;
  encerrada_em: string;
}

export interface FilaDoTelefone {
  /** A instalação tem telefonia E a organização tem número: sem isso a aba nem aparece. */
  ativa: boolean;
  /** O relógio do BANCO na hora da leitura — a tela mede a defasagem do relógio dela por ele. */
  agora: string;
  times: Array<{ id: string; nome: string; espera_maxima_s: number }>;
  numeros: Array<{ id: string; nome: string | null; numero: string | null }>;
  ligacoes: LigacaoNaFila[];
  perdidas: PerdidaRecente[];
}

export const FILA_DESLIGADA: Omit<FilaDoTelefone, "agora"> = { ativa: false, times: [], numeros: [], ligacoes: [], perdidas: [] };

/** A fase, a partir das colunas da ligação viva. */
export function faseDaLigacao(l: {
  status: string;
  queued_at: unknown;
  ringing_user_id: string | null;
  menu_id: string | null;
  menu_outcome: string | null;
  transferencia_time_id: string | null;
}): FaseDaLigacao {
  if (l.status === "connected") return l.transferencia_time_id ? "transferencia_na_fila" : "em_ligacao";
  if (l.queued_at) return l.ringing_user_id ? "tocando" : "aguardando";
  return l.menu_id && !l.menu_outcome ? "menu" : "avisos";
}

/** Por que a recebida não atendida acabou. */
export function motivoDaPerdida(l: {
  end_reason: string | null;
  queued_at: unknown;
  menu_id: string | null;
  menu_outcome: string | null;
}): MotivoDaPerdida {
  if (l.end_reason === MOTIVO_FORA_DO_HORARIO) return "fora_do_horario";
  if (l.end_reason === "fila_esgotada") return "fila_esgotada";
  if (l.end_reason === "ninguem_atendeu") return "ninguem_atendeu";
  if (l.end_reason === "cliente_desligou") {
    return !l.queued_at && l.menu_id && !l.menu_outcome ? "desligou_no_menu" : "desistiu_na_fila";
  }
  if (l.end_reason && l.end_reason.includes("reinicio")) return "interrompida";
  return "outro";
}

/**
 * A posição de cada ligação na fila do SEU time: as que esperam por uma pessoa
 * (`aguardando` ou `tocando`), pela ordem de chegada (`na_fila_desde`; empate
 * pelo id, para a ordem ser estável). Devolve `id → posição` (1 = a próxima).
 */
export function posicoesNaFila(
  ligacoes: ReadonlyArray<Pick<LigacaoNaFila, "id" | "fase" | "time_id" | "na_fila_desde">>,
): Map<string, number> {
  const porTime = new Map<string, Array<{ id: string; desde: number }>>();
  for (const l of ligacoes) {
    if ((l.fase !== "aguardando" && l.fase !== "tocando") || !l.na_fila_desde) continue;
    const chave = l.time_id ?? "";
    const lista = porTime.get(chave) ?? [];
    lista.push({ id: l.id, desde: new Date(l.na_fila_desde).getTime() });
    porTime.set(chave, lista);
  }
  const posicoes = new Map<string, number>();
  for (const lista of porTime.values()) {
    lista.sort((a, b) => a.desde - b.desde || (a.id < b.id ? -1 : 1));
    lista.forEach((l, i) => posicoes.set(l.id, i + 1));
  }
  return posicoes;
}

/** O resumo de um time para o chip: quantas esperam e há quanto tempo a mais antiga espera (ms). */
export function resumoDoTime(
  ligacoes: ReadonlyArray<Pick<LigacaoNaFila, "fase" | "time_id" | "na_fila_desde">>,
  timeId: string,
  agoraMs: number,
): { esperando: number; maisAntigaMs: number | null } {
  let esperando = 0;
  let maisAntiga: number | null = null;
  for (const l of ligacoes) {
    if (l.time_id !== timeId || !FASES_QUE_ESPERAM.has(l.fase)) continue;
    esperando++;
    if (!l.na_fila_desde) continue;
    const ms = agoraMs - new Date(l.na_fila_desde).getTime();
    if (maisAntiga === null || ms > maisAntiga) maisAntiga = ms;
  }
  return { esperando, maisAntigaMs: maisAntiga === null ? null : Math.max(0, maisAntiga) };
}

/** Quantas ligações esperam por alguém — o selo do trilho. */
export function quantasEsperam(ligacoes: ReadonlyArray<Pick<LigacaoNaFila, "fase">>): number {
  return ligacoes.filter((l) => FASES_QUE_ESPERAM.has(l.fase)).length;
}

/** "m:ss" (e "h:mm:ss" depois de uma hora). Negativo vira "0:00". */
export function relogio(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export type UrgenciaDaEspera = "normal" | "atencao" | "critico";

/**
 * O quanto a espera pesa: passou da METADE do teto do time → atenção; faltam
 * menos de 20% → crítico. Sem prazo (há gente livre tocando), normal.
 */
export function urgenciaDaEspera(caiEmMs: number | null, agoraMs: number, tetoS: number | null): UrgenciaDaEspera {
  if (caiEmMs === null) return "normal";
  const teto = esperaMaximaMs(tetoS);
  const resta = caiEmMs - agoraMs;
  if (resta <= teto * 0.2) return "critico";
  if (resta <= teto * 0.5) return "atencao";
  return "normal";
}
