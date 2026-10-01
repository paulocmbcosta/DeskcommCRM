/**
 * O QUE O PAINEL DO TELEFONE DIZ SOBRE A TRANSFERÊNCIA (v2; desenho §12.5) —
 * regra pura, client-safe. A tela passa o estado da ligação (o que o banco disse
 * e o header com que o ramal tocou) e recebe a frase, em português (chave do
 * dicionário, com `{nome}` a trocar depois do `t()`), e o tom.
 *
 * Quem sou eu na transferência sai do PAPEL com que o meu ramal tocou
 * (`X-Transferencia`): sem papel, eu atendi a ligação e sou quem transfere (A);
 * `transf`/`fila`, ela chegou a mim transferida; `volta`, a que eu transferi
 * voltou; `consulta`, um colega quer falar antes.
 */
import {
  MENSAGEM_DO_MOTIVO_DA_TRANSFERENCIA,
  MENSAGEM_GENERICA_DA_TRANSFERENCIA,
  type TransferenciaDaLigacao,
} from "./vocabulario";

export interface EstadoParaOTexto {
  fase: "discando" | "chamando" | "tocando" | "em_ligacao";
  papelDaEntrada: string | null;
  transferencia: {
    tipo: "blind" | "attended";
    de_nome: string | null;
    para_nome: string | null;
    para_time: string | null;
    consulta: "tocando" | "falando" | null;
  } | null;
  transferidaPor: string | null;
  ultimaTransferencia: {
    desfecho: string | null;
    motivo: string | null;
    para_nome: string | null;
    para_time: string | null;
    fui_eu: boolean;
    fechada_em: string | null;
  } | null;
}

export interface TextoDaTransferencia {
  /** A frase em português (chave do dicionário). */
  texto: string;
  /** O que vai no lugar de `{nome}`, se a frase o tiver. */
  nome: string | null;
  tom: "info" | "erro";
}

/** Por quanto tempo o painel ainda conta o desfecho de uma transferência que acabou. */
export const DESFECHO_NA_TELA_MS = 30_000;

const nomeDoDestino = (t: { para_nome: string | null; para_time: string | null }) => t.para_nome ?? t.para_time;

export function textoDaTransferencia(e: EstadoParaOTexto, agora: number): TextoDaTransferencia | null {
  const aberta = e.transferencia;
  if (e.fase === "tocando") {
    if (e.papelDaEntrada === "volta") {
      const quem = aberta ? nomeDoDestino(aberta) : null;
      return quem
        ? { texto: "{nome} não atendeu, o cliente voltou", nome: quem, tom: "info" }
        : { texto: "A transferência não foi atendida, o cliente voltou", nome: null, tom: "info" };
    }
    if (e.papelDaEntrada === "consulta") {
      return { texto: "{nome} quer falar com você antes de transferir", nome: aberta?.de_nome ?? null, tom: "info" };
    }
    if (e.papelDaEntrada === "transf" || e.papelDaEntrada === "fila") {
      return aberta?.de_nome
        ? { texto: "Transferida por {nome}", nome: aberta.de_nome, tom: "info" }
        : { texto: "Ligação transferida", nome: null, tom: "info" };
    }
    return null;
  }
  if (e.fase !== "em_ligacao") return null;

  if (aberta?.tipo === "attended") {
    if (e.papelDaEntrada === "consulta") {
      return { texto: "{nome} quer transferir um cliente para você", nome: aberta.de_nome, tom: "info" };
    }
    const quem = nomeDoDestino(aberta);
    return aberta.consulta === "falando"
      ? { texto: "Falando com {nome} · cliente em espera", nome: quem, tom: "info" }
      : { texto: "Chamando {nome}… · cliente em espera", nome: quem, tom: "info" };
  }
  if (aberta) return { texto: "Transferindo para {nome}…", nome: nomeDoDestino(aberta), tom: "info" };

  const ultima = e.ultimaTransferencia;
  const recente =
    ultima?.fechada_em !== null && ultima?.fechada_em !== undefined && agora - new Date(ultima.fechada_em).getTime() < DESFECHO_NA_TELA_MS;
  if (ultima && ultima.fui_eu && recente) {
    if (ultima.desfecho === "refused") {
      return {
        texto: MENSAGEM_DO_MOTIVO_DA_TRANSFERENCIA[ultima.motivo ?? ""] ?? MENSAGEM_GENERICA_DA_TRANSFERENCIA,
        nome: null,
        tom: "erro",
      };
    }
    if (ultima.desfecho === "returned") {
      return { texto: "{nome} não atendeu, o cliente voltou", nome: nomeDoDestino(ultima), tom: "info" };
    }
  }
  if (e.transferidaPor) return { texto: "Transferida por {nome}", nome: e.transferidaPor, tom: "info" };
  return null;
}

// ─── a corrente no cartão da ligação ───────────────────────────────────────


/**
 * A frase de um elo da corrente de transferências, no cartão da ligação
 * (`CartaoDaLigacao`). Modelo em português (chave do dicionário) com `{de}`,
 * `{para}` e `{quem}` a trocar depois do `t()`. O nome que falta vira "alguém"
 * na tela — o registro é de uma hora em que o nome pode não ter sido lido.
 */
export function fraseDoElo(e: TransferenciaDaLigacao): { modelo: string; de: string | null; para: string | null; quem: string | null } {
  const para = e.para_nome ?? e.para_time;
  const base = { de: e.de_nome, para, quem: e.atendida_por_nome };
  if (e.tipo === "attended") {
    if (e.desfecho === "answered") return { ...base, modelo: "{de} falou com {para} antes e transferiu" };
    if (e.desfecho === "returned") return { ...base, modelo: "{de} tentou falar com {para}, que não atendeu" };
    return { ...base, modelo: "{de} falou com {para} e voltou ao cliente" };
  }
  switch (e.desfecho) {
    case "answered":
      return { ...base, modelo: "{de} transferiu para {para} · {para} atendeu" };
    case "returned":
      return { ...base, modelo: "{de} transferiu para {para} · não atendeu, voltou para {de}" };
    case "queue_answered":
      return { ...base, modelo: "{de} transferiu para {para} · {quem} atendeu" };
    case "missed":
      return { ...base, modelo: "{de} transferiu para {para} · ninguém atendeu" };
    default:
      return { ...base, modelo: "{de} tentou transferir para {para}" };
  }
}
