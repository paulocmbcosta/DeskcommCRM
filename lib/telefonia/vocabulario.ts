/**
 * O VOCABULÁRIO DA URA E DAS FALAS DO TELEFONE (migration 0288) — client-safe.
 *
 * Cada lista `as const` aqui espelha um CHECK do banco, e o espelho é MECÂNICO:
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` compara as duas contra
 * o Postgres real. Quem acrescenta um valor numa migration acrescenta aqui na
 * mesma mudança.
 *
 * Sem import nenhum, de propósito: a tela importa este arquivo, e o que ele
 * puxasse iria para o JavaScript do navegador.
 */

/** `phone_prompts.kind` — uma fala por linha. */
export const TIPOS_DE_FALA = ["menu", "invalid", "waiting", "nobody", "after_hours", "emergency"] as const;
export type TipoDeFala = (typeof TIPOS_DE_FALA)[number];

/** `phone_prompts.status`. "Gerando" não é estado do banco: é a requisição em curso na tela. */
export const ESTADOS_DA_FALA = ["ready", "failed"] as const;
export type EstadoDaFala = (typeof ESTADOS_DA_FALA)[number];

/** `voice_calls.menu_outcome` — o que aconteceu no menu de voz. */
export const DESFECHOS_DO_MENU = ["chosen", "default_no_input", "default_invalid"] as const;
export type DesfechoDoMenu = (typeof DESFECHOS_DO_MENU)[number];

/** As falas gerais da organização (`phone_settings.<tipo>_prompt_id`). */
export const FALAS_GERAIS = ["waiting", "nobody", "after_hours"] as const;
export type FalaGeral = (typeof FALAS_GERAIS)[number];

/** `voice_calls.end_reason` da ligação encerrada porque o time estava fora do horário. */
export const MOTIVO_FORA_DO_HORARIO = "after_hours";

/** Bucket PRIVADO do Storage com o áudio de cada fala (`<org>/<hash>.ulaw`). */
export const BUCKET_DAS_FALAS = "phone-prompts";

/** Teto de caracteres de uma fala — o mesmo do CHECK `phone_prompts_text_check`. */
export const TAMANHO_MAXIMO_DA_FALA = 1000;

/** O modelo de voz da ElevenLabs usado quando a organização não escolheu outro. */
export const MODELO_DE_VOZ_PADRAO = "eleven_multilingual_v2";

/**
 * Formato de um `voice_id` da ElevenLabs: alfanumérico, `_` e `-`, até 64
 * caracteres. Usado para filtrar a listagem de vozes (`lib/telefonia/elevenlabs.ts`)
 * e para recusar `sintetizar` com um ID fora do formato ANTES de qualquer chamada
 * de rede — um ID como `".."` nunca é uma voz real da conta.
 */
export const ID_DE_VOZ = /^[A-Za-z0-9_-]{1,64}$/;

export type MotivoDoErroDaElevenLabs =
  | "chave_invalida"
  | "sem_credito"
  | "texto_recusado"
  | "voz_inexistente"
  | "limite_de_uso"
  | "sem_resposta"
  | "erro_do_provedor";

/**
 * Por que uma prévia não saiu, ou por que o "Salvar e usar" recusou a prévia. A
 * rota devolve o código; a v1 não grava linha `failed` (a falha fica na prévia,
 * que não escreve linha), mas `phone_prompts.error` segue aceitando o código.
 */
export type FalhaDaFala =
  | "sem_chave"
  | "sem_voz"
  | "armazenamento"
  /** A organização passou de 30 prévias na hora (desenho §4). */
  | "limite_de_previas"
  /** O objeto `<org>/<hash>.ulaw` não está no Storage da organização. */
  | "previa_ausente"
  /** O hash não é o do texto com a voz atual: o texto (ou a voz) mudou depois da prévia. */
  | "previa_desatualizada"
  /** Outra gravação da mesma fala segurou a trava por mais que o prazo (`lock_timeout`, 55P03). */
  | "gravacao_em_andamento"
  | MotivoDoErroDaElevenLabs;

/** O que a tela diz de cada falha. Em português; a tela passa por `t()`. */
export const MENSAGEM_DA_FALHA_DA_FALA: Record<FalhaDaFala, string> = {
  sem_chave: "Cadastre a chave da ElevenLabs em Credenciais de IA para gerar as falas.",
  sem_voz: "Escolha a voz das falas na aba Voz e falas antes de gerar.",
  armazenamento: "Não foi possível guardar o áudio da fala. Tente de novo em instantes.",
  limite_de_previas:
    "Muitas prévias geradas na última hora. Espere um pouco para gerar outra — ouvir as que já estão na tela não custa nada.",
  previa_ausente: "A prévia deste texto não está mais guardada. Gere a prévia de novo e salve em seguida.",
  previa_desatualizada: "O texto ou a voz mudou depois da prévia. Gere a prévia de novo antes de salvar.",
  gravacao_em_andamento: "Outra gravação desta fala está em andamento. Tente de novo em instantes.",
  chave_invalida: "A ElevenLabs recusou a chave. Confira a chave em Credenciais de IA.",
  sem_credito: "A conta da ElevenLabs está sem crédito. As falas já geradas continuam tocando.",
  texto_recusado: "A ElevenLabs recusou este texto. Encurte ou reescreva e tente de novo.",
  voz_inexistente: "Essa voz não existe mais na conta da ElevenLabs. Escolha outra voz.",
  limite_de_uso: "A ElevenLabs pediu para esperar um pouco. Tente de novo em instantes.",
  sem_resposta: "A ElevenLabs não respondeu. Tente de novo em instantes.",
  erro_do_provedor: "A ElevenLabs devolveu um erro. Tente de novo em instantes.",
};

/**
 * O texto recusado pela NOSSA régua (`textoDaFalaValido`, em falas.ts: vazio, mais
 * de 1000 caracteres ou com o caractere NUL), antes de qualquer chamada. Não é
 * `texto_recusado`: aquela mensagem diz que a ElevenLabs recusou, e aqui ninguém
 * foi a ela. As rotas da prévia e do "Salvar e usar" usam esta, com
 * `validation_failed`.
 */
export const MENSAGEM_DO_TEXTO_INVALIDO =
  "Texto inválido: a fala precisa ter de 1 a 1000 caracteres, sem caracteres invisíveis.";

export function ehFalhaDaFala(valor: string | null | undefined): valor is FalhaDaFala {
  return typeof valor === "string" && Object.hasOwn(MENSAGEM_DA_FALHA_DA_FALA, valor);
}

/**
 * Uma fala como a tela a vê. Nunca leva o caminho do Storage. Leva o `hash`: é o
 * que a tela devolve no "Salvar" quando o texto não mudou (a fala em uso segue).
 */
export interface FalaPublica {
  id: string;
  tipo: TipoDeFala;
  texto: string;
  voice_id: string;
  /** sha256(modelo, voz, texto) — o mesmo da prévia que a gerou. */
  hash: string;
  status: EstadoDaFala;
  /** O código de `FalhaDaFala` quando `status = failed`. */
  erro: string | null;
  duracao_ms: number | null;
  atualizada_em: string;
}

/** A resposta da rota da prévia (`POST /api/v1/telefonia/falas/previa`). */
export interface PreviaNaResposta {
  /** O que o "Salvar e usar" devolve à API — nunca um caminho. */
  hash: string;
  duracao_ms: number;
  /** `true` = o áudio já estava no Storage: a ElevenLabs não foi chamada. */
  reaproveitada: boolean;
  /** O μ-law 8 kHz em base64; a tela converte em WAV para ouvir. */
  audio_base64: string;
}

/** O corpo que salva uma fala (fala geral, menu, aviso): o texto e o hash da prévia dele. */
export interface FalaParaSalvar {
  texto: string;
  hash: string;
}

export interface OpcaoDoMenuPublica {
  tecla: string;
  time_id: string;
  time_nome: string;
}

/** O laço de retorno do menu (desenho §8): o que as ligações dos últimos 7 dias fizeram nele. */
export interface UltimosSeteDias {
  total: number;
  por_tecla: Record<string, number>;
  sem_escolha: number;
  tecla_errada: number;
  desligou_no_menu: number;
}

export interface MenuPublico {
  id: string;
  nome: string;
  time_padrao_id: string;
  time_padrao_nome: string;
  opcoes: OpcaoDoMenuPublica[];
  fala: FalaPublica | null;
  fala_invalida: FalaPublica | null;
  /** A fala do menu (e a de tecla inválida, se houver) está pronta: pode ser ligado a um número. */
  pronto: boolean;
  /** Nomes dos números que tocam este menu. */
  numeros: string[];
  ultimos_7_dias: UltimosSeteDias;
}

export interface AvisoDoTimePublico {
  team_id: string;
  time_nome: string;
  /** Ligado e não vencido AGORA (a passada de 60 s do worker desliga os vencidos no banco). */
  ativa: boolean;
  desde: string | null;
  expira_em: string | null;
  ligada_por: string | null;
  fala: FalaPublica | null;
}
