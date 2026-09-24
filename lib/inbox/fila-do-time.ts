/**
 * POR QUE a fila de um time não anda — o contrato de
 * `GET /api/v1/conversations/teams/fila`, compartilhado com a dica do chip.
 */
export type MotivoDaFila =
  /** Há quem possa pegar: o roteador entrega na próxima rodada. */
  | "livre"
  /** O time está fora do horário (ou com agenda ilegível). */
  | "fechado"
  /** Time sem ninguém cadastrado. */
  | "sem_membros"
  /** Ninguém do time está disponível agora. */
  | "ninguem_disponivel"
  /** Há disponíveis, mas todos no limite de conversas (ou fora do próprio horário). */
  | "todos_ocupados";

export interface FilaDoTime {
  team_id: string;
  motivo: MotivoDaFila;
}
