/**
 * CONECTORES — o contrato que o núcleo conhece.
 *
 * Um conector liga UMA organização a UM sistema externo (hoje: o IXC, ERP de
 * provedor de internet). O produto é um só para todo cliente, então o núcleo não
 * pode saber o que é IXC: ele conhece este arquivo e o `registro.ts`, e pergunta
 * "quais conectores esta organização ligou". Mesmo desenho de `lib/channels/`
 * (docs/doctrine/restricao-de-canal.md), e pela mesma razão.
 *
 * Os três vocabulários abaixo espelham CHECKs do banco (migration 0271) e são
 * medidos por tests/invariants/vocabulario-banco-x-typescript.test.ts — conector
 * novo é uma linha aqui E uma migration que estende o CHECK.
 */
export const IDS_DE_CONECTOR = ["ixc"] as const;
export type ConectorId = (typeof IDS_DE_CONECTOR)[number];

export const ESTADOS_DA_CONEXAO = ["ativa", "erro"] as const;
export type EstadoDaConexao = (typeof ESTADOS_DA_CONEXAO)[number];

export const FORMAS_DE_VERIFICACAO = ["telefone", "documento", "manual"] as const;
export type FormaDeVerificacao = (typeof FORMAS_DE_VERIFICACAO)[number];

export function ehConectorId(valor: string): valor is ConectorId {
  return (IDS_DE_CONECTOR as readonly string[]).includes(valor);
}

/** Host + token em claro. Vive só no escopo de uma chamada — nunca em log nem resposta. */
export interface CredencialDeConector {
  baseUrl: string;
  token: string;
}

/**
 * Por que a chamada ao sistema externo falhou — em termos que a TELA consegue
 * transformar em conserto. "Deu erro" não é diagnóstico: `credencial_recusada`
 * manda trocar o token, `sem_resposta` manda conferir o endereço.
 */
export type MotivoDeFalha =
  | "url_insegura"
  | "sem_resposta"
  | "credencial_recusada"
  | "recurso_indisponivel"
  | "resposta_inesperada";

export class FalhaDoConector extends Error {
  constructor(
    public readonly motivo: MotivoDeFalha,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "FalhaDoConector";
  }
}

export type ResultadoDoTeste = { ok: true } | { ok: false; motivo: MotivoDeFalha; detalhe: string };

/** O que o núcleo sabe de um conector sem conhecer o sistema do outro lado. */
export interface DefinicaoDeConector {
  id: ConectorId;
  /** Nome na aba do painel e na tela de configuração. */
  rotulo: string;
  descricao: string;
  /** Texto de ajuda do campo de endereço — cada sistema tem o seu formato de host. */
  ajudaDoEndereco: string;
  ajudaDoToken: string;
  /** Prova host + token com uma leitura mínima. NUNCA lança: devolve veredito. */
  testar(credencial: CredencialDeConector): Promise<ResultadoDoTeste>;
}

/** A frase que a tela mostra para cada motivo. Uma só fonte, três telas. */
export const FRASE_DA_FALHA: Record<MotivoDeFalha, string> = {
  url_insegura: "O endereço não é aceito. Use o endereço público do sistema, começando com https://.",
  sem_resposta: "O sistema não respondeu. Confira o endereço e se ele está no ar.",
  credencial_recusada: "O sistema recusou o token. Confira se ele está certo e ativo.",
  recurso_indisponivel: "O token não tem acesso a um dos dados que o painel usa.",
  resposta_inesperada: "O sistema respondeu de um jeito que não entendi.",
};
