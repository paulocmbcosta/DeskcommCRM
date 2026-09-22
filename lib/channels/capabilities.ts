/**
 * O ÚNICO lugar do sistema que pode conhecer a diferença entre os canais.
 *
 * Feature nenhuma pergunta *com quem* falamos — pergunta *o que o canal permite*
 * (invariante 1 de `docs/doctrine/restricao-de-canal.md`). Cada capability abaixo
 * nasce de uma diferença real e medida entre WAHA e Meta Cloud; capability que
 * ninguém consome é código morto, e o teste de matriz reprova.
 */
import type { ChannelCapabilities, ChannelProvider, ProviderDeMensagem } from "./types";

export type { ChannelProvider, ChannelCapabilities, ProviderDeMensagem };

/**
 * A matriz descreve o que um canal de MENSAGEM permite — por isso a chave é
 * `ProviderDeMensagem`, não `ChannelProvider`. Perguntar a uma linha de voz se
 * ela manda texto fora da janela de 24h é erro de categoria, e responder
 * qualquer coisa (inclusive tudo `false`) faria a pergunta parecer legítima.
 * `capabilitiesOf` segue falhando fechado para quem não está aqui.
 */
export const CHANNEL_CAPABILITIES: Record<ProviderDeMensagem, ChannelCapabilities> = {
  // Auto-restrição: falo quando quiser, mas o WhatsApp me bane se eu abusar.
  waha: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    // Não há WABA por trás: não existe definição aprovada para gerir.
    canManageTemplates: false,
    banRisk: true,
    minIntervalMs: null,
    voiceNote: "server-convert",
    groups: "full",
    costPerMessage: false,
    outboundFirst: true,
    telefoneEhIdentidade: true,
  },
  // Hetero-restrição: não me banem, mas a Meta me proíbe e me cobra.
  meta_cloud: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    // A Graph API cria e edita definições; o repo hoje só ESPELHA, e é essa
    // lacuna que a capability torna visível em vez de deixar implícita.
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    // Fala primeiro, mas só com definição aprovada — é `requiresTemplates` que
    // diz COMO; esta diz que DÁ.
    outboundFirst: true,
    telefoneEhIdentidade: true,
  },
  // Mesma hetero-restrição do canal oficial, por baixo: é um BSP: a WABA é da
  // Meta, os templates são aprovados pela Meta e a janela de 24h é da Meta. O
  // intermediário muda o TRANSPORTE (quem endereça, como se autentica), não o
  // que o WhatsApp permite — e capability descreve o permitido, não o encanamento.
  //
  // As duas diferenças reais, medidas na doc do provider, não na intuição:
  //
  //  - `voiceNote: "opus-only"`. O provider tem um `voiceNote: true` no envio,
  //    mas exige ogg/opus mono explicitamente e NÃO converte — mesma restrição
  //    do canal oficial. Ler o campo booleano como "ele resolve para mim" é o
  //    erro que manda mp3 e entrega anexo de música.
  //  - `groups: "limited"`. Existe API de grupos, mas só em plano de uso e só
  //    para números fora de coexistência. Capability é o que a instalação MÉDIA
  //    pode fazer; prometer "full" aqui quebraria em quem não paga o plano.
  // `freeformOutsideWindow: false` está MEDIDO, não deduzido. A API aceita o
  // envio livre (200 + wamid) e a Meta recusa a ENTREGA depois, pelo webhook:
  //
  //   131047 Re-engagement message — "The 24-hour customer service window for
  //   this contact is closed. Send an approved template to re-open the
  //   conversation, or wait for the contact to message you first."
  //
  // O detalhe que engana: mandar um template NÃO abre a janela. Só o cliente
  // abre, respondendo. Quem ler o 200 como "enviado" acha que funciona.
  zernio: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    canManageTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    // Fala primeiro, mas só com definição aprovada — é `requiresTemplates` que
    // diz COMO; esta diz que DÁ.
    outboundFirst: true,
    telefoneEhIdentidade: true,
  },
  // O primeiro canal que NÃO é WhatsApp: o widget de chat que o dono cola no
  // próprio site. O transporte somos nós — a mensagem do atendente é gravada e o
  // navegador do visitante a busca —, então não existe plataforma no meio para
  // banir, cobrar, exigir modelo ou fechar janela. Quase tudo aqui é "sem
  // restrição", e é por isso que a linha precisa existir: pelo invariante 4 da
  // doutrina, gate que não se aplica responde `skipped: 'not_applicable'` a
  // partir DESTA matriz, em vez de sumir da cadeia.
  //
  //  - `voiceNote: "server-convert"`. Quem toca o áudio é o `<audio>` do
  //    navegador do visitante, que aceita o que o gravador do composer produz;
  //    não há plataforma exigindo ogg/opus.
  //  - `groups: "none"`. Uma conversa do site é sempre uma pessoa.
  //  - `outboundFirst: false` é A restrição deste canal, e ela é física, não
  //    política: o endereço do visitante é um token que nasce no navegador dele.
  //    Quem nunca escreveu não tem endereço.
  site_widget: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    canManageTemplates: false,
    banRisk: false,
    minIntervalMs: null,
    voiceNote: "server-convert",
    groups: "none",
    costPerMessage: false,
    outboundFirst: false,
    telefoneEhIdentidade: false,
  },
};

/**
 * O que assumir quando o banco NÃO diz qual é o canal — só quando a linha de
 * `channel_sessions` não pôde ser lida (a coluna é `not null default 'waha'`,
 * então uma sessão que existe sempre responde).
 *
 * Espelha o default da coluna de propósito: é o que mantém o comportamento
 * idêntico ao dos literais que as Tasks 4b/5 deixaram no código. E é o canal
 * CONSERVADOR dos dois — banRisk armado, throttle e warm-up ligados; errar para
 * o lado do meta_cloud desarmaria o anti-ban num número que pode ser banido.
 */
export const DEFAULT_CHANNEL_PROVIDER: ChannelProvider = "waha";

/**
 * Constantes nomeadas dos providers. Existem para que nenhum arquivo fora deste
 * módulo precise escrever a string — é o que o `scripts/lint-channels.ts` cobra.
 */
export const CHANNEL_PROVIDER_WAHA: ChannelProvider = "waha";
export const CHANNEL_PROVIDER_META: ChannelProvider = "meta_cloud";
export const CHANNEL_PROVIDER_ZERNIO: ChannelProvider = "zernio";
/** Chat do site (migration 0272) — o widget embutido no site do cliente. */
export const CHANNEL_PROVIDER_SITE_WIDGET: ChannelProvider = "site_widget";
/** Chamada de voz WhatsApp (spec 18). Não transporta mensagem — ver abaixo. */
export const CHANNEL_PROVIDER_WACALLS: ChannelProvider = "wacalls";

/**
 * Os providers por onde MENSAGEM entra e sai — a única lista que responde
 * "este canal serve para conversar?".
 *
 * Existe porque `channel_sessions` deixou de ser só a tabela dos transportes de
 * texto quando a voz entrou nela, e ~39 leituras daquela tabela não filtram
 * provider nenhum: elas dizem "canal" e querem dizer "canal de mensagem". Sem
 * esta lista, uma organização que pareia voz vê a linha de voz virar opção no
 * seletor "Número conectado", nascer amarrada ao primeiro agente publicado,
 * contar como canal conectado no retrato da instalação e ser escolhida por uma
 * automação para mandar texto — por um canal que não manda texto.
 *
 * `satisfies` e não anotação solta: um provider novo que não seja de mensagem
 * precisa ser DECIDIDO aqui, não esquecido.
 */
export const PROVIDERS_DE_MENSAGEM = [
  "waha",
  "meta_cloud",
  "zernio",
  "site_widget",
] as const satisfies readonly ProviderDeMensagem[];

/**
 * Os canais por onde dá para FALAR PRIMEIRO — o recorte de
 * `PROVIDERS_DE_MENSAGEM` que serve a quem INICIA conversa (automação, o botão
 * de chamar o cliente, o retorno do follow-up).
 *
 * Derivada da matriz, e não uma terceira lista escrita à mão: canal novo que
 * declare `outboundFirst` entra ou sai daqui sozinho, e a lista não tem como
 * discordar da capability.
 */
export const PROVIDERS_QUE_FALAM_PRIMEIRO: readonly ProviderDeMensagem[] =
  PROVIDERS_DE_MENSAGEM.filter((p) => CHANNEL_CAPABILITIES[p].outboundFirst);

/**
 * `true` quando dá para abrir conversa por este canal com quem nunca escreveu.
 * Provider desconhecido ou que não transporta mensagem responde `false` — o
 * mesmo falhar-fechado de `transportaMensagem`.
 */
export function canalFalaPrimeiro(provider: string | null | undefined): boolean {
  return (PROVIDERS_QUE_FALAM_PRIMEIRO as readonly string[]).includes(provider ?? "");
}

/**
 * `true` quando a linha de `channel_sessions` é um canal de mensagem.
 *
 * Aceita `string | null | undefined` de propósito: quem chama está lendo uma
 * coluna do banco, que pode trazer um provider mais novo que este código (um
 * clone que atualizou o schema antes da imagem). Provider desconhecido responde
 * `false` — falhar fechado aqui significa "não use este canal para mandar
 * recado", que é o erro barato; o caro é mandar por um canal que não entrega.
 * A coluna é `not null default 'waha'`, então `null` só aparece quando a linha
 * não pôde ser lida, e aí também não há canal a usar.
 */
export function transportaMensagem(provider: string | null | undefined): boolean {
  return (PROVIDERS_DE_MENSAGEM as readonly string[]).includes(provider ?? "");
}

/**
 * O MEIO pelo qual a pessoa fala — o vocabulário que a FEATURE pode usar.
 *
 * Provider é transporte (com quem o CRM fala); meio é o que o cliente usa (por
 * onde ELE fala). Três providers diferentes são o mesmo meio, `whatsapp`, e é
 * por isso que a tela nunca precisou saber qual deles estava por trás. Com o
 * chat do site apareceu o segundo meio, e a tela passou a precisar de UMA
 * distinção legítima: ícone de telefone não serve para uma conversa que veio de
 * um site. Ela pergunta o meio — que é o mesmo valor de `conversations.channel`
 * — e continua sem saber o provider.
 */
export const MEIOS_DE_CANAL = ["whatsapp", "site_chat"] as const;
export type MeioDeCanal = (typeof MEIOS_DE_CANAL)[number];

const MEIO_DO_PROVIDER: Record<ProviderDeMensagem, MeioDeCanal> = {
  waha: "whatsapp",
  meta_cloud: "whatsapp",
  zernio: "whatsapp",
  site_widget: "site_chat",
};

/** `null` para quem não transporta mensagem (voz) ou para provider que esta imagem não conhece. */
export function meioDoCanal(provider: string | null | undefined): MeioDeCanal | null {
  return MEIO_DO_PROVIDER[provider as ProviderDeMensagem] ?? null;
}

/**
 * Os providers que ESTE código conhece e que, sabidamente, não conversam.
 *
 * A diferença para `!transportaMensagem(p)` é a que separa "categoria" de
 * "falha", e ela decide o que o vigia de conexão faz com a linha:
 *
 *   - `wacalls` está aqui: ignorar em silêncio é o certo, e um aviso por sessão
 *     de voz a cada minuto seria ruído perpétuo.
 *   - um provider que o CHECK do banco já aceita e esta imagem ainda não conhece
 *     (o clone que aplicou o baseline antes de puxar a imagem nova) NÃO está
 *     aqui — ele tem de fazer barulho, porque uma conexão sem vigia e sem
 *     rastro é exatamente o buraco mudo que ninguém descobre.
 *
 * `transportaMensagem` responde `false` para os dois, e é o que se quer lá: na
 * hora de escolher por onde mandar recado, o desconhecido é tão inútil quanto a
 * voz. Aqui a pergunta é outra.
 */
export const PROVIDERS_SEM_MENSAGEM = ["wacalls"] as const;

/**
 * Erro de COMPILAÇÃO enquanto sobrar provider fora das duas listas. Provider
 * novo obriga a decidir se ele conversa — esquecer não é uma opção disponível.
 */
type ProviderNaoClassificado = Exclude<
  ChannelProvider,
  (typeof PROVIDERS_DE_MENSAGEM)[number] | (typeof PROVIDERS_SEM_MENSAGEM)[number]
>;
const _todoProviderFoiClassificado: ProviderNaoClassificado extends never ? true : never = true;
void _todoProviderFoiClassificado;

/** `true` só para provider conhecido cuja natureza não é mensagem. */
export function canalConhecidoSemMensagem(provider: string | null | undefined): boolean {
  return (PROVIDERS_SEM_MENSAGEM as readonly string[]).includes(provider ?? "");
}

export function capabilitiesOf(provider: ChannelProvider): ChannelCapabilities {
  const caps = CHANNEL_CAPABILITIES[provider as ProviderDeMensagem];
  // Fail-closed: provider fora da matriz não herda o default do WAHA. O tipo
  // barra em compilação; isto barra o que vem do banco em runtime.
  if (!caps) throw new Error(`unknown_channel_provider: ${provider}`);
  return caps;
}

/**
 * O telefone é identidade no canal deste provider? Fail-closed: provider
 * ausente, de voz ou que esta imagem não conhece responde `false` — errar para o
 * lado de "é identidade" entregaria dado de um cliente a quem só digitou o
 * número dele.
 */
export function telefoneEhIdentidade(provider: string | null | undefined): boolean {
  const linha = (CHANNEL_CAPABILITIES as Partial<Record<string, ChannelCapabilities>>)[provider ?? ""];
  return linha?.telefoneEhIdentidade === true;
}
