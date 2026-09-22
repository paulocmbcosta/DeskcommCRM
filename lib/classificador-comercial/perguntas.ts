/**
 * O QUE O JEV LÊ E O QUE ELE RESPONDE — a parte pura do classificador comercial.
 *
 * O Jev (TypeSafe) não gera texto: recebe um ESTADO e perguntas tipadas e
 * devolve probabilidades. Duas perguntas, cada decisão feita de UM jeito só (a
 * doc do Jev avisa que noul e choice sobre a mesma coisa não somam 1):
 *
 *  - `comercial` (noul) DECIDE: probabilidade de o cliente querer contratar,
 *    mudar de plano ou conhecer planos. Contra o limiar da organização.
 *  - `assunto` (choice) só EXPLICA: vai para a linha do tempo e para o log.
 *
 * Critérios escritos com o que conta E o que não conta, porque o Jev lê ao pé
 * da letra ("answers the question you wrote, not the one you meant").
 *
 * Nenhum nome de funil, de organização ou de nicho aparece aqui: "plano" e
 * "serviço" servem a provedor de internet, clínica e loja.
 */

/** Versão FIXA: o alias `~typesafe/jev-latest` troca de modelo sozinho e desafina o limiar. */
export const MODELO_DO_JEV = "typesafe/jev-1.13";

/** Quantas falas o Jev lê. Estado grande com texto irrelevante derruba a acurácia. */
export const LIMITE_DE_MENSAGENS = 12;
export const LIMITE_DE_CARACTERES_POR_MENSAGEM = 500;

export interface MensagemParaEstado {
  direcao: "inbound" | "outbound";
  /** Corpo, ou transcrição/descrição da mídia. `null` = ainda sem texto. */
  texto: string | null;
}

export interface EstadoDoJev {
  conversa: Array<{ quem: "cliente" | "atendente"; texto: string }>;
}

/** Corta por CODE POINT, nunca por unidade UTF-16 — senão um emoji vira um surrogate solto e quebra JSON estrito. */
function cortarPorCodePoint(texto: string, limite: number): string {
  return Array.from(texto).slice(0, limite).join("");
}

/**
 * Quem garante a ordem cronológica (mais antiga → mais nova) da entrada é
 * `dadosViaSupabase().ultimasMensagens` (Tarefa 7) — esta função só rotula,
 * filtra e corta, na ordem em que recebe.
 */
export function montarEstado(mensagens: MensagemParaEstado[]): EstadoDoJev | null {
  const conversa = mensagens
    .map((m) => ({
      quem: m.direcao === "inbound" ? ("cliente" as const) : ("atendente" as const),
      texto: (m.texto ?? "").trim(),
    }))
    .filter((m) => m.texto !== "")
    .slice(-LIMITE_DE_MENSAGENS)
    .map((m) => ({ ...m, texto: cortarPorCodePoint(m.texto, LIMITE_DE_CARACTERES_POR_MENSAGEM) }));

  // Só o atendente falando (campanha, aviso) não é conversa a classificar.
  if (!conversa.some((m) => m.quem === "cliente")) return null;
  return { conversa };
}

export const ASSUNTOS = {
  contratacao: "Quer contratar ou comprar um produto ou serviço pela primeira vez",
  mudanca_de_plano: "Já é cliente e quer mudar, ampliar ou trocar de plano, produto ou serviço",
  conhecer_planos: "Quer conhecer planos, produtos, preços, promoções ou disponibilidade antes de decidir",
  suporte: "Relata problema técnico, serviço que não funciona ou pede ajuda para usar o que já tem",
  financeiro: "Fala de boleto, segunda via, fatura, pagamento, cobrança ou desbloqueio por pagamento",
  cancelamento: "Quer cancelar, encerrar ou suspender o serviço",
  outro: "Só cumprimentou, ainda não disse o assunto, ou fala de fornecedor, vaga de emprego ou assunto pessoal",
} as const;

export type Assunto = keyof typeof ASSUNTOS;

/**
 * Descritivo: quem de fato aplica a decisão C (cancelamento fora) é o
 * critério `false` da pergunta `comercial`, não esta lista. Serve para
 * relatório e para o teste que congela a decisão.
 */
export const ASSUNTOS_COMERCIAIS: ReadonlySet<Assunto> = new Set<Assunto>([
  "contratacao",
  "mudanca_de_plano",
  "conhecer_planos",
]);

export const ROTULO_DO_ASSUNTO: Record<Assunto, string> = {
  contratacao: "contratação",
  mudanca_de_plano: "mudança de plano",
  conhecer_planos: "conhecer planos e preços",
  suporte: "suporte",
  financeiro: "financeiro",
  cancelamento: "cancelamento",
  outro: "sem assunto definido",
};

export const PERGUNTAS = {
  comercial: {
    type: "noul",
    instructions:
      "Na `conversa`, o cliente quer comprar ou contratar algo, mudar ou ampliar um plano ou serviço que já tem, ou conhecer planos, produtos e preços?",
    criteria: {
      true: "O cliente pede ou demonstra interesse em contratar, comprar, mudar de plano, ampliar o serviço ou saber planos e preços",
      false:
        "O cliente só cumprimentou, ou fala de suporte técnico, boleto, pagamento, cobrança, cancelamento, reclamação, fornecedor ou assunto pessoal",
    },
  },
  assunto: {
    type: "choice",
    instructions: "Qual é o assunto principal do cliente na `conversa`?",
    criteria: ASSUNTOS,
  },
} as const;

/**
 * A resposta do Jev já traduzida para o que o produto usa.
 *
 * `assunto` e `tokensDeEntrada` são `| null`: só `comercial` (a decisão) vem
 * de um campo estrito no schema HTTP (`lib/classificador-comercial/jev.ts`)
 * — os outros dois só EXPLICAM ou CUSTEIAM, e um provedor que respondeu a
 * pergunta certa mas errou o resto de um jeito imprevisto não pode fazer o
 * card deixar de nascer.
 */
export interface RespostaDoJev {
  comercial: number;
  assunto: string | null;
  confiancaDoAssunto: number | null;
  /** Versão que respondeu, como o provedor a devolveu (ex.: `jev-1.13.0`). */
  modelo: string;
  /** `null` = o provedor não informou uso — nunca 0 (0 é "grátis", `null` é "não sei"). */
  tokensDeEntrada: number | null;
}

export interface Decisao {
  criar: boolean;
  assunto: Assunto;
  probabilidade: number;
}

export function decidir(resposta: RespostaDoJev, limiar: number): Decisao {
  // Object.hasOwn (não `in`): `in` também é true para "toString", "constructor",
  // "__proto__" etc. — herdados de Object.prototype — e gravaria lixo na linha do tempo.
  // `resposta.assunto === null` primeiro: `Object.hasOwn` não aceita `null` como
  // chave (o tipo é `PropertyKey`), e sem o motivo não há como escolher um assunto.
  const assunto: Assunto =
    resposta.assunto !== null && Object.hasOwn(ASSUNTOS, resposta.assunto) ? (resposta.assunto as Assunto) : "outro";
  return { criar: resposta.comercial >= limiar, assunto, probabilidade: resposta.comercial };
}
