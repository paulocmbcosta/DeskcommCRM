/**
 * O QUE FALTA PARA SALVAR UM MENU DE VOZ — a cadeia que o editor da aba Menus
 * mostra ao lado do "Salvar menu" travado: a PRIMEIRA coisa que falta, na ordem
 * em que a pessoa preenche o editor. Puro e client-safe.
 *
 * As regras não são cópias: tecla repetida é `teclaRepetida` (vocabulario.ts); a
 * prévia que falta e o áudio que sumiu chegam prontos do editor, que tem a
 * máquina da prévia (`usePreviaDaFala`) e a recusa da rota (`previa_ausente`).
 * A rota continua sendo a autoridade (`menuSchema`, `timesValidos`,
 * `conferirFala`, em menus.ts): isto só evita mandar a ela o que ela recusaria
 * com certeza — e diz à pessoa o porquê do botão travado.
 *
 * As frases estão em português; a tela as passa por `t()`. Como a chave chega
 * por constante, o gate de i18n não a enxerga: o teste deste arquivo confere o
 * espanhol de cada uma.
 */
import { teclaRepetida } from "./vocabulario";

export interface MenuParaConferir {
  nome: string;
  opcoes: ReadonlyArray<{ tecla: string; time_id: string }>;
  time_padrao_id: string;
  /** Algum time escolhido (de uma opção, ou o padrão) foi arquivado. */
  algumTimeArquivado: boolean;
  /** A fala do menu como vai para a rota. */
  textoDoMenu: string;
  /** Falta a prévia de alguma fala que vai no corpo (a do menu, ou a de tecla inválida escrita). */
  faltaPrevia: boolean;
  /** A rota disse que o áudio salvo de uma fala em uso não está mais no Storage (`previa_ausente`). */
  audioSumiu: boolean;
}

export type OQueFalta =
  | "nome"
  | "opcao"
  | "time_da_opcao"
  | "tecla_repetida"
  | "time_padrao"
  | "time_arquivado"
  | "texto"
  | "audio_sumiu"
  | "previa";

export const MENSAGEM_DO_QUE_FALTA: Record<OQueFalta, string> = {
  nome: "Dê um nome ao menu.",
  opcao: "O menu precisa de pelo menos uma opção.",
  time_da_opcao: "Escolha o time de cada opção.",
  tecla_repetida: "Cada tecla só pode levar a um time.",
  time_padrao: "Escolha o time padrão.",
  time_arquivado: "Um time escolhido foi arquivado. Escolha outro time.",
  texto: "Escreva a fala do menu.",
  audio_sumiu: "O áudio salvo de uma fala não foi encontrado. Gere a prévia dela de novo antes de salvar.",
  previa: "Gere a prévia de cada fala que mudou antes de salvar o menu.",
};

/** A primeira coisa que falta para o menu poder ser salvo, ou `null` quando nada falta. */
export function oQueFaltaNoMenu(m: MenuParaConferir): OQueFalta | null {
  if (!m.nome.trim()) return "nome";
  if (m.opcoes.length === 0) return "opcao";
  if (m.opcoes.some((o) => !o.time_id)) return "time_da_opcao";
  if (teclaRepetida(m.opcoes)) return "tecla_repetida";
  if (!m.time_padrao_id) return "time_padrao";
  if (m.algumTimeArquivado) return "time_arquivado";
  if (!m.textoDoMenu.trim()) return "texto";
  // O áudio que sumiu só pesa enquanto falta a prévia: gerada a nova, ela vai no lugar.
  if (m.faltaPrevia) return m.audioSumiu ? "audio_sumiu" : "previa";
  return null;
}

/**
 * O time está na lista E foi arquivado — a rota o recusaria (`time_invalido`). Um
 * id que a lista não conhece (ela não carregou, ou o time é de outro lugar) fica
 * com a rota, que é a autoridade: a tela não trava por suposição.
 */
export function estaArquivado(times: ReadonlyArray<{ id: string; archived: boolean }>, id: string): boolean {
  return times.some((x) => x.id === id && x.archived);
}
