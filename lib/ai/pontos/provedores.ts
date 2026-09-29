/**
 * OS PROVEDORES QUE O SISTEMA SABE USAR — a lista que substituiu o CHECK.
 *
 * A migration 0127 removeu os três CHECKs que prendiam `provider` em
 * `anthropic|openai|google` no banco, porque eles tornavam impossível cadastrar
 * OpenRouter (ou qualquer provedor novo, ou um modelo local) e porque cada
 * provedor novo viraria uma migration. Com a coluna aberta, a garantia de que a
 * tela não oferece opção inválida passa a morar aqui.
 *
 * A defesa em profundidade continua sendo dupla, e é importante entender de
 * onde vem cada metade:
 *
 *  - **Esta lista** é o que a tela OFERECE. Ela existe para o operador não
 *    escolher algo que o sistema não sabe executar.
 *  - **O registry** (`createDefaultRegistry`) é o que EXECUTA. Um provider que
 *    chegue até ele sem entrada correspondente falha com
 *    `LlmProviderUnknownError` — erro tipado que diz o que fazer, e não uma
 *    violação de constraint que o operador leria como bug do produto.
 *
 * As duas metades precisam concordar, e é justamente esse tipo de par que este
 * repo já viu divergir em silêncio (catálogo × preço). Por isso
 * `tests/unit/provedores-x-registry.test.ts` casa uma com a outra.
 */

/** Como a chave daquele provedor é validada e o que a tela precisa pedir. */
export interface ProvedorSuportado {
  id: string;
  /** Nome como o operador conhece. */
  rotulo: string;
  /** Uma frase sobre quando escolher este, para quem não acompanha o mercado. */
  quandoUsar: string;
  /**
   * O provedor aceita apontar para outro endpoint (é OpenAI-compatível)? É o
   * que habilita gateway próprio e, no roteiro, modelo local.
   */
  aceitaEndpointProprio: boolean;
  /** O catálogo de modelos vem de uma API pública que dá para sincronizar? */
  catalogoSincronizavel: boolean;
  /** Onde o operador pega a chave — a tela mostra o link. */
  ondePegarAChave: string;
  /** Como a chave começa — vira placeholder do campo, para a pessoa reconhecer que copiou a coisa certa. */
  prefixoDaChave: string;
}

export const PROVEDORES = [
  {
    id: "anthropic",
    rotulo: "Anthropic (Claude)",
    quandoUsar:
      "O padrão recomendado para conversar com o cliente: é o que melhor segue instruções longas e usa as ferramentas do CRM.",
    aceitaEndpointProprio: false,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://console.anthropic.com/settings/keys",
    prefixoDaChave: "sk-ant-…",
  },
  {
    id: "openai",
    rotulo: "OpenAI (GPT)",
    quandoUsar:
      "Necessário para transcrever áudio e para indexar o seu material — esses dois pontos usam tecnologia da OpenAI mesmo quando o resto está em outro provedor.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://platform.openai.com/api-keys",
    prefixoDaChave: "sk-…",
  },
  {
    id: "google",
    rotulo: "Google (Gemini)",
    quandoUsar:
      "Alternativa com contexto muito longo e custo baixo para tarefas de classificação.",
    aceitaEndpointProprio: false,
    catalogoSincronizavel: false,
    ondePegarAChave: "https://aistudio.google.com/apikey",
    prefixoDaChave: "AIza…",
  },
  {
    id: "openrouter",
    rotulo: "OpenRouter",
    quandoUsar:
      "Uma chave só dá acesso a centenas de modelos de dezenas de fabricantes, inclusive os gratuitos. É o caminho mais simples para experimentar sem abrir conta em cada provedor.",
    aceitaEndpointProprio: true,
    catalogoSincronizavel: true,
    ondePegarAChave: "https://openrouter.ai/keys",
    prefixoDaChave: "sk-or-…",
  },
] as const satisfies readonly ProvedorSuportado[];
// `as const satisfies` e não anotação de tipo: a anotação apagaria os literais
// e `Provider` viraria `string`, deixando o compilador aceitar qualquer texto
// como provedor — que é exatamente a garantia que esta lista existe para dar.

/**
 * Só os ids, na forma que o `z.enum` exige (tupla não-vazia de literais).
 *
 * Existe para os pontos de ESCRITA derivarem daqui em vez de repetir a lista:
 * a rota de credenciais, o schema de versão do agente e o diálogo da tela
 * tinham cada um a sua cópia, e quando a 0127 abriu o banco para a OpenRouter
 * as três continuaram recusando — o produto oferecia um provedor que não tinha
 * como ser cadastrado.
 */
export const IDS_DE_PROVEDOR = PROVEDORES.map((p) => p.id) as unknown as readonly [
  (typeof PROVEDORES)[number]["id"],
  ...(typeof PROVEDORES)[number]["id"][],
];

export const PROVEDOR_POR_ID: ReadonlyMap<string, ProvedorSuportado> = new Map(
  PROVEDORES.map((p) => [p.id, p]),
);

export function ehProvedorSuportado(id: string): boolean {
  return PROVEDOR_POR_ID.has(id);
}

/**
 * A CHAVE DE VOZ DO TELEFONE — a ElevenLabs, que dá voz à URA
 * (`lib/telefonia/chave-elevenlabs.ts`). Ela mora em `ai_provider_credentials`,
 * a mesma tabela das chaves de modelo, mas NÃO é provedor de modelo de
 * linguagem: não entra em `PROVEDORES` (que casa com o registry do motor) e não
 * pode aparecer onde se escolhe com o que o agente pensa.
 */
export const PROVEDOR_DE_VOZ = "elevenlabs";

/**
 * O rótulo fixo da linha de voz — a outra metade do UNIQUE
 * `(organization_id, provider, label)` que faz "trocar a chave" substituir em
 * vez de somar (`lib/telefonia/chave-elevenlabs.ts`, que reexporta esta
 * constante e a usa nas duas consultas que leem a linha). Mora aqui, ao lado
 * de `PROVEDOR_DE_VOZ`, pela mesma razão: client-safe, sem import nenhum.
 */
export const ROTULO_DA_CHAVE_DE_VOZ = "ElevenLabs";

/**
 * O CRITÉRIO ÚNICO de "esta linha de `ai_provider_credentials` é a chave de
 * voz da organização": o provider E o rótulo — nunca só o provider, porque a
 * coluna é de vocabulário aberto (um clone pode ter outra linha com
 * `provider = "elevenlabs"` e outro rótulo, e ela não seria a chave de voz).
 *
 * `is_active` é OPCIONAL: quem já filtrou por ele na própria consulta SQL
 * (`estadoDaChaveDeVoz`/`chaveDeVoz`, que já fazem `is_active = true` no
 * `where`) não precisa repetir aqui; quem filtra um array já carregado na
 * memória (o cartão da ElevenLabs em Credenciais de IA) sempre o passa.
 */
export function ehLinhaDaChaveDeVoz(c: { provider: string; label: string; is_active?: boolean }): boolean {
  return c.provider === PROVEDOR_DE_VOZ && c.label === ROTULO_DA_CHAVE_DE_VOZ && (c.is_active ?? true);
}

/**
 * Os `provider` que têm linha em `ai_provider_credentials` e NÃO executam
 * modelo de linguagem. Este é o critério ÚNICO: quem lista credencial para
 * escolher modelo filtra por `ehProvedorDeModelo`/`credenciaisDeModelo`, nunca
 * comparando com o texto do provider.
 *
 * Lista de exclusão, não de inclusão, de propósito: a coluna é de vocabulário
 * aberto desde a 0127, e um clone pode ter linha de provider que esta lista não
 * conhece — essas continuam aparecendo como antes. Só sai o que sabemos que não
 * é modelo.
 */
export const PROVEDORES_QUE_NAO_SAO_MODELO: ReadonlySet<string> = new Set([PROVEDOR_DE_VOZ]);

export function ehProvedorDeModelo(provider: string): boolean {
  return !PROVEDORES_QUE_NAO_SAO_MODELO.has(provider);
}

/** Só as credenciais de provedor de modelo, na ordem em que vieram. */
export function credenciaisDeModelo<T extends { provider: string }>(linhas: readonly T[]): T[] {
  return linhas.filter((l) => ehProvedorDeModelo(l.provider));
}
