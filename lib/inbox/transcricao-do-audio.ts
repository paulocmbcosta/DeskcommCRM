/**
 * A TRANSCRIÇÃO DO ÁUDIO, do banco até o balão.
 *
 * O texto já existia: `workers/media-derive-worker.ts` transcreve todo áudio
 * que chega e grava em `messages.media_derived_text` — é assim que o agente
 * "ouve". Só não ia à tela, e o atendente tinha de escutar o que o sistema já
 * tinha lido. Medido em produção (2026-10-08, 14 dias): 320 áudios recebidos,
 * 320 com transcrição pronta; metade com até 132 caracteres, 90% com até 450,
 * o maior com 3.917; pronta em 8 s na mediana, 27 s no pior caso.
 *
 * Duas pontas moram aqui porque respondem à MESMA pergunta — "esta mensagem tem
 * transcrição que se possa mostrar?" — e não podem discordar: a rota decide o
 * que SAI do servidor, o balão decide o que APARECE.
 */
import { MARCADOR_NAO_LIDA, MAX_DERIVED_CHARS } from "@/lib/messaging/media/derivable";

/**
 * Por quanto tempo um áudio sem derivado é dado como "transcrevendo".
 *
 * ⚠️ `media_derived_status` nulo NÃO distingue "ainda vai chegar" de "nunca foi
 * pedido" (a mesma ressalva de `lib/classificador-comercial/dados.ts`). O que
 * separa os dois aqui é o relógio: o caminho normal fecha em segundos, e o de
 * reserva — worker fora do ar, o cron de 1 min drenando os dois saltos — levou
 * 103 s e 188 s nas medições de `lib/event-log/drain-loop.ts`. Passou disso, a
 * tela para de prometer um texto que talvez não venha; se ele vier, aparece.
 */
export const JANELA_DA_TRANSCRICAO_MS = 3 * 60_000;

/** O "trechozinho": o que cabe em cerca de três linhas da caixa. */
export const TAMANHO_DO_TRECHO = 140;
/**
 * Folga antes de cortar. Sem ela, um texto de 150 caracteres ganharia um "Ler
 * mais" que revela duas palavras — um clique que não paga o que custa.
 */
const FOLGA_DO_TRECHO = 40;
/** Quantas linhas um texto curto pode ter antes de ser mostrado corrido. */
const LINHAS_DO_TRECHO = 4;

interface LinhaComDerivado {
  type: string;
  revoked_at?: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_derived_text?: string | null;
  media_derived_status?: string | null;
}

/**
 * SERVIDOR — o que a LISTAGEM entrega do texto derivado: só a transcrição de
 * áudio, de mensagem que ainda tem o áudio, de contato que não foi anonimizado.
 *
 * - Imagem, vídeo e PDF também têm derivado (descrição, extração de até 8.000
 *   caracteres). Ninguém pediu isso na tela, e mandá-lo a cada recarga da
 *   conversa é peso e superfície sem uso.
 * - Apagada pelo autor: o balão já não mostra o áudio; a transcrição é o mesmo
 *   conteúdo por escrito, e esta rota não a entrega.
 * - Contato anonimizado, pelo FATO (`contacts.is_anonymized`) e não por um
 *   sinal indireto. Há dois caminhos de anonimização e eles deixam a mensagem
 *   em estados diferentes: a cascata (`fn_lgpd_cascade_redact_contact`) zera a
 *   mídia; o botão da ficha (`/api/v1/lgpd/anonymize`) nem toca em `messages`.
 *   Nenhum dos dois apaga o derivado. `contatoLiberado` é falso também quando
 *   não foi possível saber — na dúvida, a transcrição não sai.
 * - Sem arquivo (`media_url` e `media_storage_path` nulos): sem player, o balão
 *   não tem onde pendurar a transcrição.
 *
 * ⚠️ Isto decide o que ESTA ROTA responde, não o que o banco guarda nem o que o
 * Realtime carrega: o aviso de mudança do Supabase leva a linha inteira ao
 * navegador (a tela só o usa para recarregar).
 */
export function soATranscricaoDoAudio<T extends LinhaComDerivado>(m: T, contatoLiberado: boolean): T {
  const sai =
    contatoLiberado &&
    m.type === "audio" &&
    !m.revoked_at &&
    Boolean(m.media_storage_path || m.media_url);
  if (sai) return m;
  if (m.media_derived_text == null && m.media_derived_status == null) return m;
  return { ...m, media_derived_text: null, media_derived_status: null };
}

/** A linha tem transcrição que valha conferir o contato antes de entregar? */
export function temTranscricaoAEntregar(m: LinhaComDerivado): boolean {
  return m.type === "audio" && m.media_derived_text != null;
}

export type EstadoDaTranscricao =
  /** `incompleta`: o texto bateu no teto do derivado — o áudio continua além dele. */
  | { tipo: "texto"; texto: string; incompleta: boolean }
  | { tipo: "transcrevendo" }
  /** O áudio foi lido e não havia fala (silêncio, ruído, música). */
  | { tipo: "sem_fala" }
  /** Não deu para transcrever: falhou em todas as tentativas, ou falta a chave. */
  | { tipo: "indisponivel" };

interface MensagemComTranscricao {
  type: string;
  direction: "inbound" | "outbound";
  created_at: string;
  media_derived_text?: string | null;
  media_derived_status?: string | null;
}

/**
 * TELA — o que o balão mostra abaixo do player. `null` = nada: o player fica
 * como sempre foi (áudio antigo, ou gravado pelo atendente, que não é
 * transcrito).
 */
export function estadoDaTranscricao(
  m: MensagemComTranscricao,
  agoraMs: number,
): EstadoDaTranscricao | null {
  if (m.type !== "audio") return null;
  // `undefined` não é `null`: é a leitura que NÃO traz o derivado (a mensagem
  // otimista, a conversa vista pelo super-admin). Sem saber o estado, a tela não
  // anuncia "transcrevendo" — o texto nunca chegaria por esse caminho.
  if (m.media_derived_status === undefined) return null;

  if (m.media_derived_status === "ready") {
    const texto = (m.media_derived_text ?? "").trim();
    // O marcador é um recado para o AGENTE ("chegou algo que não consegui
    // interpretar"). Mostrado ao atendente como se fosse a fala do cliente,
    // seria uma transcrição falsa.
    if (texto === MARCADOR_NAO_LIDA) return { tipo: "indisponivel" };
    if (!texto) return { tipo: "sem_fala" };
    return {
      tipo: "texto",
      texto,
      incompleta: (m.media_derived_text ?? "").length >= MAX_DERIVED_CHARS,
    };
  }
  if (m.media_derived_status === "failed") return { tipo: "indisponivel" };

  // Só o que CHEGA é transcrito: prometer "transcrevendo" no áudio que o
  // atendente acabou de gravar seria anunciar um texto que nunca vem.
  if (m.direction !== "inbound") return null;
  const idade = agoraMs - Date.parse(m.created_at);
  // Em módulo: `created_at` é o relógio do SERVIDOR e `agoraMs` o do navegador.
  // Um navegador poucos segundos atrasado vê o áudio "no futuro" — e é
  // justamente o áudio que acabou de chegar. `idade` NaN (data ilegível) cai fora.
  if (Math.abs(idade) < JANELA_DA_TRANSCRICAO_MS) return { tipo: "transcrevendo" };
  return null;
}

/**
 * O começo da transcrição, cortado em fim de palavra. `cortou` diz se há o que
 * abrir — é ele que decide se o "Ler mais" existe.
 *
 * Por contagem de caracteres, e não por `line-clamp` medido no navegador: a
 * mesma entrada dá o mesmo trecho em qualquer largura, e a regra cabe num teste
 * sem tela.
 */
export function trechoDaTranscricao(texto: string): { trecho: string; cortou: boolean } {
  const inteiro = texto.trim();
  const corrido = inteiro.replace(/\s+/g, " ");
  if (corrido.length <= TAMANHO_DO_TRECHO + FOLGA_DO_TRECHO) {
    // Curto em caracteres pode ser ALTO em linhas ("sim\n\n\nnão\n\n…"): o
    // balão preserva quebras, e um texto assim ocuparia a tela sem ter o que
    // recolher. Poucas quebras ficam como vieram; muitas viram texto corrido —
    // nenhuma palavra some.
    const linhas = inteiro.split("\n").length;
    return { trecho: linhas > LINHAS_DO_TRECHO ? corrido : inteiro, cortou: false };
  }
  const bruto = corrido.slice(0, TAMANHO_DO_TRECHO);
  const ultimoEspaco = bruto.lastIndexOf(" ");
  // Sem espaço por perto (uma "palavra" enorme), corta no limite mesmo — por
  // ponto de código, para não deixar meio par substituto (emoji) na ponta.
  const corte =
    ultimoEspaco >= TAMANHO_DO_TRECHO / 2
      ? bruto.slice(0, ultimoEspaco)
      : Array.from(corrido).slice(0, TAMANHO_DO_TRECHO).join("");
  return { trecho: `${corte.replace(/[\s.,;:!?…-]+$/u, "")}…`, cortou: true };
}
