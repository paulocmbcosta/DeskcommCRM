"use client";
/**
 * A PRÉVIA DE UMA FALA NA TELA (desenho da fase 2, D15 e §4): "Gerar prévia" →
 * ouvir → salvar. É a ÚNICA hora em que a tela faz a ElevenLabs trabalhar, e ela
 * não muda nada nas ligações — quem muda é o "Salvar e usar" (ou "Salvar menu",
 * ou "Ligar" o aviso), que devolve à API o hash desta prévia.
 *
 * A prévia vale para UM texto e UMA voz: editar o campo depois de gerar a
 * invalida (`falaParaSalvar` passa a devolver `null`), trocar a voz também, e o
 * botão de salvar volta a pedir prévia — é o que impede salvar um texto com o
 * áudio de outro. O áudio chega em base64 na resposta e fica só na memória da
 * aba: ouvir de novo não custa nada.
 *
 * A falha chega na hora: a cota de prévias estourada é 429 com um `Retry-After`
 * de até uma hora, e o `apiClient` lança em vez de esperar (lib/api/client.ts) —
 * a tela mostra a frase da rota, sem botão girando.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { apiClient } from "@/lib/api/client";
import { ApiError, ApiErrorSemCorpo, mensagemDoServidor } from "@/lib/api/types";
import {
  MENSAGEM_DA_FALHA_DA_FALA,
  ehFalhaDaFala,
  type FalaParaSalvar,
  type FalaPublica,
  type PreviaNaResposta,
} from "@/lib/telefonia/vocabulario";

export interface PreviaDaFala {
  /** O texto EXATO (aparado) que gerou o áudio. */
  texto: string;
  hash: string;
  duracao_ms: number;
  /** O áudio já estava no Storage: a ElevenLabs não foi chamada. */
  reaproveitada: boolean;
  /** μ-law 8 kHz, como o Asterisk toca. */
  audio: Uint8Array;
}

/** A síntese de 1000 caracteres pode passar dos 30 s do prazo padrão de escrita do `apiClient`. */
const PRAZO_DA_PREVIA_MS = 60_000;

export function bytesDoBase64(b64: string): Uint8Array {
  const bruto = atob(b64);
  const bytes = new Uint8Array(bruto.length);
  for (let i = 0; i < bruto.length; i++) bytes[i] = bruto.charCodeAt(i);
  return bytes;
}

/**
 * O que vai no corpo do "Salvar": a prévia DESTE texto, ou — se o texto é o da
 * fala em uso — a própria fala em uso (nada a regravar). `null` = falta gerar a
 * prévia do texto que está no campo.
 */
export function falaParaSalvar(texto: string, emUso: FalaPublica | null, previa: PreviaDaFala | null): FalaParaSalvar | null {
  const limpo = texto.trim();
  if (!limpo) return null;
  if (previa && previa.texto === limpo) return { texto: previa.texto, hash: previa.hash };
  if (emUso?.status === "ready" && emUso.texto === limpo) return { texto: emUso.texto, hash: emUso.hash };
  return null;
}

/**
 * A frase de uma falha da API de falas (prévia ou salvar), na ordem: a que veio
 * do CORPO da resposta (`mensagemDoServidor`) — que já sabe o caso, inclusive a
 * prévia paga e não guardada (`paga: true`) e a cota de prévias estourada —; sem
 * ela, a do vocabulário pelo código. `null` quando não há frase específica: quem
 * chama escolhe a genérica do SEU gesto.
 *
 * A "mensagem" de uma resposta SEM corpo estruturado (o 504 de um proxy com
 * HTML, `HTTP 502`) é inventada pelo `apiClient` (`ApiErrorSemCorpo`) e nunca
 * chega à tela: "Falhou: HTTP 504" não diz nada a quem opera. Nunca o código cru.
 */
export function fraseDaFalhaDaFala(erro: unknown, t: (texto: string) => string): string | null {
  const doServidor = mensagemDoServidor(erro);
  if (doServidor) return t(doServidor);
  if (erro instanceof ApiError && !(erro instanceof ApiErrorSemCorpo) && ehFalhaDaFala(erro.code)) {
    return t(MENSAGEM_DA_FALHA_DA_FALA[erro.code]);
  }
  return null;
}

/** A mensagem da falha da PRÉVIA para a tela, `null` sem falha. */
export function mensagemDaFalhaDaPrevia(erro: unknown, t: (texto: string) => string): string | null {
  if (!erro) return null;
  return fraseDaFalhaDaFala(erro, t) ?? t("Não foi possível gerar a prévia. Tente de novo em instantes.");
}

/** O que foi pedido na última geração: o texto (aparado) e a voz da tela naquele momento. */
interface PedidoDaPrevia {
  texto: string;
  voz: string | null;
}

/**
 * A prévia de UMA fala. `vozAtual` é a voz que a tela conhece AGORA (`null` =
 * nenhuma, ou a tela não a lê — o gerente, na janela do aviso, não lê a voz): a
 * prévia fica amarrada à voz com que foi pedida, e some quando ela muda. O hash
 * da prévia inclui a voz; salvá-la depois da troca seria recusado com
 * `previa_desatualizada`, e o botão de salvar convidaria a uma recusa certa.
 *
 * Os efeitos de estado de cada geração vão no `mutate(...)`, não nas opções da
 * mutação: as opções rodam mesmo depois do `reset()`, e uma prévia que chegasse
 * depois de `limpar()` reapareceria na tela (e com ela o "Salvar").
 */
export function usePreviaDaFala(vozAtual: string | null) {
  const [pedido, setPedido] = useState<PedidoDaPrevia | null>(null);
  const [gerada, setGerada] = useState<PreviaDaFala | null>(null);
  const [ouvida, setOuvida] = useState(false);
  const mutacao = useMutation({
    mutationFn: async (limpo: string): Promise<PreviaDaFala> => {
      const r = (
        await apiClient.post<{ data: PreviaNaResposta }>(
          "/api/v1/telefonia/falas/previa",
          { texto: limpo },
          { timeoutMs: PRAZO_DA_PREVIA_MS },
        )
      ).data;
      return {
        texto: limpo,
        hash: r.hash,
        duracao_ms: r.duracao_ms,
        reaproveitada: r.reaproveitada,
        audio: bytesDoBase64(r.audio_base64),
      };
    },
  });

  const daVozAtual = pedido !== null && pedido.voz === vozAtual;
  const previa = daVozAtual ? gerada : null;
  const vale = (texto: string) => previa !== null && previa.texto === texto.trim();

  return {
    /** A prévia gerada, se ainda é da voz atual; `null` sem prévia (ou depois de trocar a voz). */
    previa,
    /** A pessoa tocou a prévia atual (o aviso de instabilidade só liga depois disso, §6.3). */
    ouvida: ouvida && previa !== null,
    marcarOuvida: () => setOuvida(true),
    gerar: (texto: string) => {
      const limpo = texto.trim();
      setPedido({ texto: limpo, voz: vozAtual });
      setGerada(null);
      setOuvida(false);
      mutacao.mutate(limpo, { onSuccess: (p) => setGerada(p) });
    },
    gerando: mutacao.isPending,
    /**
     * A falha da última geração, se foi DESTE texto e da voz atual — editar o
     * campo (ou trocar a voz) apaga a falha, porque ela era de outro pedido.
     */
    erroPara: (texto: string): unknown =>
      mutacao.error && daVozAtual && pedido.texto === texto.trim() ? mutacao.error : null,
    /** A prévia é deste texto (e da voz atual)? */
    valePara: vale,
    limpar: () => {
      setPedido(null);
      setGerada(null);
      setOuvida(false);
      mutacao.reset();
    },
  };
}
