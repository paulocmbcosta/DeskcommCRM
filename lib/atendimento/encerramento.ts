/**
 * O REGISTRO DO ENCERRAMENTO — assunto e resumo do atendimento (migration 0293).
 *
 * Quem APLICA a regra é o banco (`fn_atendimento_encerrar`). Este arquivo guarda
 * o que a tela e as rotas precisam saber dela sem reescrevê-la: os limites (para
 * avisar antes de mandar) e o vocabulário das recusas (para a rota transformar a
 * mensagem do banco no campo que a janela vai marcar).
 *
 * Os números abaixo são os MESMOS do corpo da função e do CHECK da tabela.
 * `tests/unit/encerramento-espelha-o-banco.test.ts` lê a migration e reprova se
 * um dos dois lados mudar sozinho.
 */

/** Com "exigir resumo" ligado, menos que isto não conta como resumo. */
export const RESUMO_MINIMO = 10;
/** Teto do resumo (CHECK `atendimentos_closure_summary_check`). */
export const RESUMO_MAXIMO = 2000;
/** Teto do nome do assunto (CHECK `atendimento_assuntos_nome_check`). */
export const NOME_DO_ASSUNTO_MAXIMO = 60;

export type CampoDoEncerramento = "assunto" | "resumo";
export type MotivoDaRecusa = "obrigatorio" | "invalido" | "longo";

export interface RecusaDoEncerramento {
  campo: CampoDoEncerramento;
  motivo: MotivoDaRecusa;
}

/**
 * As quatro recusas que `fn_atendimento_encerrar` levanta (errcode 22023).
 * A chave é a MENSAGEM da exceção, literal.
 */
const RECUSAS: ReadonlyMap<string, RecusaDoEncerramento> = new Map([
  ["encerramento_assunto_obrigatorio", { campo: "assunto", motivo: "obrigatorio" }],
  ["encerramento_assunto_invalido", { campo: "assunto", motivo: "invalido" }],
  ["encerramento_resumo_obrigatorio", { campo: "resumo", motivo: "obrigatorio" }],
  ["encerramento_resumo_longo", { campo: "resumo", motivo: "longo" }],
]);

export const MENSAGENS_DE_RECUSA: readonly string[] = [...RECUSAS.keys()];

/** Mensagem do banco → o campo e o motivo. Mensagem que não é recusa → `null`. */
export function motivoDaRecusa(mensagem: string | null | undefined): RecusaDoEncerramento | null {
  if (!mensagem) return null;
  // Map, e não objeto: `"toString"` num objeto literal acharia o método herdado.
  return RECUSAS.get(mensagem.trim()) ?? null;
}

/** A frase que a pessoa lê. Em português; quem mostra passa pelo `t()`. */
export function fraseDaRecusa(recusa: RecusaDoEncerramento): string {
  if (recusa.campo === "assunto") {
    return recusa.motivo === "obrigatorio"
      ? "Escolha o assunto do atendimento."
      : "Esse assunto não está mais disponível. Escolha outro.";
  }
  if (recusa.motivo === "longo") return "O resumo passou de 2000 letras. Encurte o texto.";
  return "Escreva o que foi tratado (mínimo de 10 letras).";
}

/** O assunto como a tela o mostra: o nome e o setor de onde ele é. */
export interface AssuntoDoAtendimento {
  id: string;
  nome: string;
  /** Nome do time dono do assunto. `null` só se o time sumiu do catálogo. */
  time: string | null;
}

/** "Suporte › Wi-Fi", ou só o nome quando não há setor a dizer. */
export function rotuloDoAssunto(assunto: Pick<AssuntoDoAtendimento, "nome" | "time">): string {
  return assunto.time ? `${assunto.time} › ${assunto.nome}` : assunto.nome;
}

/** O que a janela precisa para abrir (`GET /api/v1/atendimentos/assuntos`). */
export interface OpcoesDeEncerramento {
  exigir_assunto: boolean;
  exigir_resumo: boolean;
  /** Só times ATIVOS que têm ao menos um assunto ATIVO. */
  times: { id: string; name: string; assuntos: { id: string; name: string }[] }[];
}

/** O que a janela manda. `null` = não informado (o banco preserva o que havia). */
export interface RegistroDoEncerramento {
  assunto_id: string | null;
  resumo: string | null;
}

/**
 * A conferência que a tela faz ANTES de mandar — a mesma do banco, para o
 * atendente não esperar uma viagem ao servidor para saber o que falta. O banco
 * confere de novo: isto é cortesia, não portão.
 */
export function conferirRegistro(
  registro: RegistroDoEncerramento,
  opcoes: Pick<OpcoesDeEncerramento, "exigir_assunto" | "exigir_resumo" | "times">,
): RecusaDoEncerramento[] {
  const recusas: RecusaDoEncerramento[] = [];
  const haAssuntos = opcoes.times.some((time) => time.assuntos.length > 0);
  if (opcoes.exigir_assunto && haAssuntos && !registro.assunto_id) {
    recusas.push({ campo: "assunto", motivo: "obrigatorio" });
  }
  const resumo = (registro.resumo ?? "").trim();
  if (resumo.length > RESUMO_MAXIMO) recusas.push({ campo: "resumo", motivo: "longo" });
  else if (opcoes.exigir_resumo && resumo.length < RESUMO_MINIMO) {
    recusas.push({ campo: "resumo", motivo: "obrigatorio" });
  }
  return recusas;
}
