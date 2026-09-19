/**
 * OS CÓDIGOS DO IXC, EM PORTUGUÊS DE ATENDENTE.
 *
 * O IXC responde `status_internet: "FA"`. Quem atende precisa ler "Bloqueado —
 * financeiro em atraso", e precisa que a cor diga a mesma coisa que o texto.
 * Código desconhecido NÃO vira "—": vira o próprio código, com tom neutro. Uma
 * instância com status customizado mostra o que tem, em vez de esconder.
 *
 * Fontes: manual interno da Totus (status/status_internet) e os vocabulários
 * medidos em amostra de 1000 linhas por tabela (2026-09-19).
 */
export type Tom = "bom" | "atencao" | "ruim" | "neutro";

export interface Leitura {
  rotulo: string;
  tom: Tom;
}

function ler(mapa: Record<string, Leitura>, codigo: string): Leitura {
  return mapa[codigo] ?? { rotulo: codigo || "—", tom: "neutro" };
}

const STATUS_DO_CONTRATO: Record<string, Leitura> = {
  A: { rotulo: "Ativo", tom: "bom" },
  P: { rotulo: "Pré-contrato", tom: "atencao" },
  I: { rotulo: "Inativo", tom: "neutro" },
  N: { rotulo: "Negativado", tom: "ruim" },
  D: { rotulo: "Desistiu", tom: "neutro" },
};

const STATUS_DO_ACESSO: Record<string, Leitura> = {
  A: { rotulo: "Liberado", tom: "bom" },
  D: { rotulo: "Desativado", tom: "neutro" },
  CM: { rotulo: "Bloqueado — bloqueio manual", tom: "ruim" },
  CA: { rotulo: "Bloqueado — bloqueio automático", tom: "ruim" },
  FA: { rotulo: "Bloqueado — financeiro em atraso", tom: "ruim" },
  AA: { rotulo: "Aguardando assinatura", tom: "atencao" },
};

/** Suspensão ≠ cancelamento: bloqueio mora em `status_internet`, não em `status`. */
const ACESSOS_BLOQUEADOS = new Set(["CM", "CA", "FA"]);

const STATUS_DA_OS: Record<string, Leitura> = {
  A: { rotulo: "Aberta", tom: "atencao" },
  AN: { rotulo: "Em análise", tom: "atencao" },
  EN: { rotulo: "Encaminhada", tom: "atencao" },
  AS: { rotulo: "Assumida", tom: "atencao" },
  AG: { rotulo: "Agendada", tom: "atencao" },
  RAG: { rotulo: "Aguardando reagendamento", tom: "atencao" },
  EX: { rotulo: "Em execução", tom: "atencao" },
  F: { rotulo: "Finalizada", tom: "neutro" },
};

const STATUS_DO_TICKET: Record<string, Leitura> = {
  N: { rotulo: "Novo", tom: "atencao" },
  P: { rotulo: "Pendente", tom: "atencao" },
  EP: { rotulo: "Em progresso", tom: "atencao" },
  S: { rotulo: "Solucionado", tom: "neutro" },
  C: { rotulo: "Cancelado", tom: "neutro" },
};

const PRIORIDADE: Record<string, Leitura> = {
  B: { rotulo: "Baixa", tom: "neutro" },
  N: { rotulo: "Normal", tom: "neutro" },
  M: { rotulo: "Média", tom: "neutro" },
  A: { rotulo: "Alta", tom: "atencao" },
  C: { rotulo: "Crítica", tom: "ruim" },
};

export const lerStatusDoContrato = (c: string) => ler(STATUS_DO_CONTRATO, c);
export const lerStatusDoAcesso = (c: string) => ler(STATUS_DO_ACESSO, c);
export const lerStatusDaOs = (c: string) => ler(STATUS_DA_OS, c);
export const lerStatusDoTicket = (c: string) => ler(STATUS_DO_TICKET, c);
export const lerPrioridade = (c: string) => ler(PRIORIDADE, c);
export const acessoBloqueado = (statusInternet: string) => ACESSOS_BLOQUEADOS.has(statusInternet);

/** `online` do `radusuarios`: S, N, vazio — e `SS`, que é sessão em dobro (medido). */
export function lerConexao(online: string): Leitura {
  if (online === "S" || online === "SS") return { rotulo: "Online", tom: "bom" };
  if (online === "N") return { rotulo: "Offline", tom: "ruim" };
  return { rotulo: "Sem informação", tom: "neutro" };
}

/**
 * Potência óptica recebida pela ONU (dBm). Régua de campo de GPON: até −25 é
 * folga, −25 a −27 funciona no limite, abaixo de −27 cai. `0`/vazio não é sinal
 * perfeito — é ONU sem leitura, e dizer "bom" ali mandaria o atendente descartar
 * a causa mais provável do chamado.
 */
export function lerSinalRx(bruto: string): Leitura & { dbm: number | null } {
  const n = Number.parseFloat(bruto);
  if (!Number.isFinite(n) || n >= 0) return { rotulo: "Sem leitura", tom: "neutro", dbm: null };
  if (n >= -25) return { rotulo: "Bom", tom: "bom", dbm: n };
  if (n >= -27) return { rotulo: "No limite", tom: "atencao", dbm: n };
  return { rotulo: "Ruim", tom: "ruim", dbm: n };
}
