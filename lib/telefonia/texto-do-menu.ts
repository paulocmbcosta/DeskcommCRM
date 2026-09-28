/**
 * O texto que a URA fala, montado a partir das opções do menu, e os textos
 * sugeridos das falas (desenho da fase 2, §4 e §6.2). Puro e client-safe: a tela
 * monta o texto enquanto a pessoa escolhe as opções, e ela edita antes de gerar a
 * prévia da voz.
 */
import type { FalaGeral } from "./vocabulario";

export interface OpcaoParaTexto {
  tecla: string;
  nomeDoTime: string;
}

/** A frase de cada opção; `{time}` e `{tecla}` são trocados. A tela a passa por `t()`. */
export const FRASE_DA_OPCAO = "Para {time}, digite {tecla}.";

/** O 0 por último: é, por costume, a tecla de "falar com alguém". */
const ordemDaTecla = (tecla: string) => (tecla === "0" ? 10 : Number(tecla));

export function montarTextoDoMenu(opcoes: readonly OpcaoParaTexto[], frase: string = FRASE_DA_OPCAO): string {
  return [...opcoes]
    .filter((o) => /^[0-9]$/.test(o.tecla) && o.nomeDoTime.trim() !== "")
    .sort((a, b) => ordemDaTecla(a.tecla) - ordemDaTecla(b.tecla))
    .map((o) => frase.replaceAll("{time}", o.nomeDoTime.trim()).replaceAll("{tecla}", o.tecla))
    .join(" ");
}

/** Os textos que a tela sugere antes de a pessoa escrever o dela. A tela os passa por `t()`. */
export const TEXTO_SUGERIDO: Record<FalaGeral | "emergency" | "invalid", string> = {
  waiting: "Todos os nossos atendentes estão ocupados no momento. Por favor, aguarde na linha que já vamos atender você.",
  nobody: "No momento não conseguimos atender. Registramos a sua ligação e vamos retornar assim que possível. Obrigado.",
  after_hours: "Nosso atendimento está fechado agora. Ligue de novo no nosso horário de atendimento. Obrigado pela ligação.",
  emergency: "Estamos com uma instabilidade no momento e já estamos trabalhando para resolver. Obrigado pela paciência.",
  invalid: "Opção inválida.",
};

/** O "fora do horário" quando a organização tem um WhatsApp conectado (desenho §4). `{numero}` é trocado. */
export const TEXTO_SUGERIDO_FORA_DO_HORARIO_COM_WHATSAPP =
  "Nosso atendimento está fechado agora. Se preferir, mande uma mensagem no nosso WhatsApp, {numero}. Obrigado pela ligação.";

/**
 * O número como a voz o diz: do Brasil, "(61) 99999-0000" ou "(61) 3686-1503"; de
 * outro país, "+" e os dígitos. `null` quando não parece telefone.
 */
export function numeroParaFalar(bruto: string | null | undefined): string | null {
  const d = (bruto ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const local = d.slice(4);
    return `(${d.slice(2, 4)}) ${local.slice(0, -4)}-${local.slice(-4)}`;
  }
  return d.length >= 8 ? `+${d}` : null;
}

/**
 * O texto sugerido de "fora do horário". Com um WhatsApp conectado, cita o número
 * (a tela o acha em `useChannelSessions`); sem, é o texto de sempre. Continua
 * editável. `traduzir` é o `t()` da tela: a frase passa por ele ANTES de o número
 * entrar, para a chave do dicionário ser a frase com `{numero}`.
 */
export function textoSugeridoForaDoHorario(
  numeroDoWhatsApp: string | null | undefined,
  traduzir: (texto: string) => string = (texto) => texto,
): string {
  const numero = numeroParaFalar(numeroDoWhatsApp);
  if (!numero) return traduzir(TEXTO_SUGERIDO.after_hours);
  return traduzir(TEXTO_SUGERIDO_FORA_DO_HORARIO_COM_WHATSAPP).replaceAll("{numero}", numero);
}
