/**
 * O QUE O AVISO DE MENSAGEM DIZ — uma regra, dois entregadores.
 *
 * Chegava só o texto do cliente. Com várias conversas abertas, o atendente via
 * "ok, pode ser amanhã" na esquina da tela e não sabia de quem era. O aviso
 * agora responde, nesta ordem, às três perguntas de quem atende:
 *
 *   1. QUEM está falando  → o rótulo canônico do contato (`rotuloDoContato`);
 *   2. DE ONDE            → o time da conversa, e com quem ela está;
 *   3. O QUÊ              → o texto, ou o tipo da mídia por extenso.
 *
 * Os dois entregadores leem daqui: o navegador com a aba aberta
 * (`useInboundMessageAlerts`) e o push do servidor (`push.handler.ts`). Antes
 * cada um remontava o título do seu jeito, e o do navegador nem caía para o
 * telefone quando o contato não tinha nome.
 *
 * Nada aqui consulta banco — é tudo sobre dados que o chamador já trouxe.
 */
import { rotuloDoContato, SEM_NOME, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";
import type { Comando } from "@/lib/inbox/comando-da-conversa";

export const TITULO_SEM_CONTATO = "Nova mensagem";

/** O que o aviso sabe da conversa — tudo vem de UMA chamada (ou do cache). */
export interface ContextoDaConversa {
  contato: ContatoNomeavel | null;
  time: string | null;
  /**
   * Quem está no comando, pela régua ÚNICA do Inbox (`comandoDaConversa`), e
   * não por uma cópia daqui: o cabeçalho da conversa e o aviso não podem
   * discordar sobre "na fila" x "no automático".
   */
  comando: Comando | null;
}

const MIDIA_POR_EXTENSO: Record<string, string> = {
  image: "📷 Imagem",
  video: "🎬 Vídeo",
  audio: "🎤 Áudio",
  document: "📄 Documento",
  sticker: "Figurinha",
  location: "📍 Localização",
  contact: "👤 Contato compartilhado",
  reaction: "Reagiu a uma mensagem",
};

/** O corpo: o texto do cliente, ou o que ele mandou dito por extenso. */
type Traduzir = (texto: string) => string;
const semTraducao: Traduzir = (texto) => texto;

/**
 * Todas recebem `t` opcional: traduzem os rótulos FIXOS ("na fila", "Áudio"),
 * nunca o texto do cliente nem o nome do time — esses chegam como foram escritos.
 */
export function previaDaMensagem(tipo: unknown, corpo: unknown, t: Traduzir = semTraducao): string {
  const texto = typeof corpo === "string" ? corpo.trim() : "";
  if (tipo === "text" || tipo === undefined || tipo === null) return texto || t(TITULO_SEM_CONTATO);
  const rotulo = t(MIDIA_POR_EXTENSO[String(tipo)] ?? "Mídia");
  // Imagem e documento podem vir com legenda — ela diz mais que o tipo.
  return texto ? `${rotulo} · ${texto}` : rotulo;
}

/** QUEM: o nome, o telefone formatado, e só então a admissão de que não se sabe. */
export function nomeDoRemetente(
  contato: ContatoNomeavel | null | undefined,
  t: Traduzir = semTraducao,
): string {
  const rotulo = rotuloDoContato(contato);
  return rotulo === SEM_NOME ? t(TITULO_SEM_CONTATO) : rotulo;
}

/**
 * DE ONDE, numa linha: "Suporte · com Ana", "Suporte · na fila",
 * "no automático", "com você". `null` quando não há nada a dizer — linha vazia
 * é pior que linha ausente.
 *
 * "Na fila" só com time: é o selo "Na fila · <time>" do Inbox
 * (`estaNaFilaDoTime`). Sem time, a mesma situação se chama "aguardando
 * atendente", como no cabeçalho da conversa.
 */
export function linhaDeContexto(
  ctx: Pick<ContextoDaConversa, "time" | "comando">,
  userId: string | null,
  t: Traduzir = semTraducao,
): string | null {
  const partes: string[] = [];
  const time = ctx.time?.trim();
  if (time) partes.push(time);
  const c = ctx.comando;
  if (c?.quem === "humano") {
    if (userId && c.userId === userId) partes.push(t("com você"));
    else {
      const quem = c.nome?.trim();
      if (quem) partes.push(`${t("com")} ${quem.split(/\s+/)[0]}`);
    }
  } else if (c?.quem === "automatico") partes.push(t("no automático"));
  else if (c?.quem === "aguardando") partes.push(t(time ? "na fila" : "aguardando atendente"));
  else if (c?.quem === "ninguem") partes.push(t("sem atendente"));
  else if (c?.quem === "encerrada") partes.push(t("encerrada"));
  return partes.length ? partes.join(" · ") : null;
}

/**
 * Para a bandeja do sistema, que só tem título e corpo: o time vai no título,
 * colado ao nome — é o que o olho lê primeiro quando três avisos se empilham.
 */
export function tituloParaBandeja(nome: string, time: string | null | undefined): string {
  const t = time?.trim();
  return t ? `${nome} · ${t}` : nome;
}

/** "3 mensagens" quando o mesmo cliente manda em rajada; nada para uma só. */
export function rotuloDaRajada(contagem: number, t: Traduzir = semTraducao): string | null {
  return contagem > 1 ? `${contagem} ${t("mensagens")}` : null;
}

/**
 * Cache em memória com validade — o que impede o aviso de virar carga no banco.
 *
 * Cliente manda em rajada ("oi" / "tudo bem?" / "queria saber do boleto"), e
 * CADA navegador aberto da organização recebe cada mensagem. Sem cache, 10
 * atendentes × 4 mensagens = 40 leituras da mesma conversa em segundos, todas
 * sob a RLS de conversas. Com ele, 10.
 *
 * A validade é curta porque a conversa muda de dono (rodízio, transferência) e
 * "só as minhas" depende disso: no pior caso, 15 s de aviso a mais ou a menos
 * logo depois de uma troca — e quem RECEBE a conversa já ganha o aviso próprio
 * de "Conversa atribuída a você".
 */
export function criarCacheComValidade<V>(validadeMs: number, limite = 200) {
  const mapa = new Map<string, { valor: V; ate: number }>();
  return {
    ler(chave: string, agora = Date.now()): V | undefined {
      const e = mapa.get(chave);
      if (!e) return undefined;
      if (e.ate <= agora) {
        mapa.delete(chave);
        return undefined;
      }
      return e.valor;
    },
    gravar(chave: string, valor: V, agora = Date.now()): void {
      if (mapa.size >= limite) {
        const maisVelha = mapa.keys().next().value;
        if (maisVelha !== undefined) mapa.delete(maisVelha);
      }
      mapa.set(chave, { valor, ate: agora + validadeMs });
    },
  };
}

export const VALIDADE_DO_CONTEXTO_MS = 15_000;
