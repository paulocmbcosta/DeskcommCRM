"use client";
/**
 * AGIR NA FILA DO TELEFONE (aba Telefone; entrega 3; migration 0296): "Atender"
 * puxa para o ramal de quem clicou uma ligação que espera; "Mover" manda a
 * ligação para a fila de outro time.
 *
 * As duas rotas só ACEITAM o pedido (202) e devolvem o id de uma ordem — quem
 * age é o serviço de telefonia. O que aconteceu depois não vem pela fila (a
 * leitura dela é compartilhada pela organização inteira e não leva dado de UMA
 * pessoa): vem por `GET /api/v1/telefonia/fila/ordens/{id}`, lida a cada 1 s,
 * por até 15 s, até a ordem constar como encerrada. O que não deu certo vira um
 * aviso com a frase do motivo; o que deu certo no mover, a confirmação. No
 * atender não há o que confirmar: a ligação conecta, e o painel do telefone a
 * mostra. Sem resposta em 15 s a tela não afirma nada — relê a fila, que é quem
 * diz onde a ligação está.
 *
 * Chamado UMA vez, pela coluna (`FilaDoTelefone`), que entrega `reler` — a
 * releitura da fila dela. A fila é relida quando o pedido é aceito (a linha
 * passa a dizer quem está cuidando; a ordem não mexe em `voice_calls`, então o
 * tempo real não avisa) e quando a ordem acaba.
 *
 * O acompanhamento NÃO para se a coluna sair da tela (a pessoa trocou de aba no
 * Inbox): o aviso é global, e "seu telefone não atendeu" é justamente o que ela
 * precisa ler onde estiver.
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useTelefonia } from "@/components/telefonia/TelefoniaContext";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { trocarMarcador } from "@/lib/telefonia/texto-do-menu";
import type { SituacaoDaOrdemDaFila, TipoDaOrdemDaFila } from "@/lib/telefonia/vocabulario";

/** De quanto em quanto a ordem é lida, e por quanto tempo. */
const ACOMPANHAR_A_CADA_MS = 1_000;
const ACOMPANHAR_POR_MS = 15_000;

/** O que este navegador pediu sobre uma ligação da fila. */
export type AcaoNaFila = "atender" | "mover";

/** A ordem como `GET /api/v1/telefonia/fila/ordens/{id}` a devolve. */
interface OrdemNaResposta {
  id: string;
  tipo: TipoDaOrdemDaFila;
  situacao: SituacaoDaOrdemDaFila;
  /** `done` = deu certo. O resto do vocabulário (e o que a tela não conhece) é "não deu". */
  desfecho: string | null;
  /** Por quê (`voice_call_queue_orders.reason`, vocabulário aberto). */
  motivo: string | null;
}

/**
 * Por que a ordem não deu certo, como a tela diz. A chave é o `motivo` que o
 * worker grava — menos `no_answer`, que é o DESFECHO de quem puxou e não
 * atendeu. Motivo fora daqui cai na frase genérica.
 */
const FRASE_DA_FALHA = {
  destino_offline: "Seu telefone não está conectado.",
  destino_em_ligacao: "Você está em outra ligação.",
  ligacao_encerrada: "A ligação acabou antes.",
  ligacao_ja_atendida: "Outra pessoa atendeu antes.",
  ja_ha_ordem: "Outra pessoa já está cuidando desta ligação.",
  time_fora_do_horario: "O time está fora do horário de atendimento.",
  no_answer: "Seu telefone não atendeu. A ligação voltou para a fila.",
} as const;
type FalhaConhecida = keyof typeof FRASE_DA_FALHA;

function falhaDaOrdem(ordem: OrdemNaResposta): FalhaConhecida | null {
  if (ordem.desfecho === "no_answer") return "no_answer";
  // `hasOwn`: o motivo é texto do banco, e `"toString" in tabela` seria verdade.
  return ordem.motivo !== null && Object.hasOwn(FRASE_DA_FALHA, ordem.motivo) ? (ordem.motivo as FalhaConhecida) : null;
}

const esperar = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Lê a ordem até ela acabar. `null` = não acabou (ou não deu para ler) dentro do prazo. */
async function acompanhar(ordemId: string): Promise<OrdemNaResposta | null> {
  const desistirEm = Date.now() + ACOMPANHAR_POR_MS;
  while (Date.now() < desistirEm) {
    await esperar(ACOMPANHAR_A_CADA_MS);
    try {
      const ordem = (
        await apiClient.get<{ data: OrdemNaResposta }>(`/api/v1/telefonia/fila/ordens/${encodeURIComponent(ordemId)}`)
      ).data;
      if (ordem.situacao === "ended") return ordem;
    } catch {
      /* a próxima leitura tenta de novo */
    }
  }
  return null;
}

export function useAcoesDaFila({ reler }: { reler: () => void }) {
  const t = useT();
  const { atenderDaFila } = useTelefonia();
  /** O pedido DESTE navegador que ainda corre, por ligação — é o que deixa o botão ocupado. */
  const [emCurso, setEmCurso] = useState<Readonly<Record<string, AcaoNaFila>>>({});
  // A mesma conta, lida na hora do clique: dois cliques seguidos chegam antes
  // de o estado redesenhar, e o segundo não pode virar outro pedido.
  const correndo = useRef(new Map<string, AcaoNaFila>());

  const marcar = useCallback((ligacaoId: string, acao: AcaoNaFila | null) => {
    if (acao) correndo.current.set(ligacaoId, acao);
    else correndo.current.delete(ligacaoId);
    setEmCurso(Object.fromEntries(correndo.current));
  }, []);

  const avisarAFalha = useCallback(
    (ordem: OrdemNaResposta) => {
      const falha = falhaDaOrdem(ordem);
      toast.error(falha ? t(FRASE_DA_FALHA[falha]) : t("Não foi possível concluir. Tente de novo."));
    },
    [t],
  );

  const atender = useCallback(
    async (ligacaoId: string): Promise<void> => {
      // Uma ligação por vez: o telefone de quem pede só atende uma, e o
      // navegador só guarda a ordem do último pedido (`TelefoniaContext`).
      if (correndo.current.has(ligacaoId) || [...correndo.current.values()].includes("atender")) return;
      marcar(ligacaoId, "atender");
      try {
        // A recusa da rota já virou aviso, com o motivo, dentro do contexto do telefone.
        const ordemId = await atenderDaFila(ligacaoId);
        if (!ordemId) return;
        reler();
        const ordem = await acompanhar(ordemId);
        if (ordem && ordem.desfecho !== "done") avisarAFalha(ordem);
      } finally {
        marcar(ligacaoId, null);
        reler();
      }
    },
    [atenderDaFila, avisarAFalha, marcar, reler],
  );

  const mover = useCallback(
    async (ligacaoId: string, time: { id: string; nome: string }): Promise<void> => {
      if (correndo.current.has(ligacaoId)) return;
      marcar(ligacaoId, "mover");
      try {
        let ordemId: string;
        try {
          ordemId = (
            await apiClient.post<{ data: { ordem_id: string } }>(
              `/api/v1/telefonia/chamadas/${encodeURIComponent(ligacaoId)}/mover`,
              { team_id: time.id },
            )
          ).data.ordem_id;
        } catch (e) {
          showApiError(e);
          return;
        }
        reler();
        const ordem = await acompanhar(ordemId);
        if (!ordem) return;
        if (ordem.desfecho === "done") toast.success(trocarMarcador(t("Ligação movida para {time}."), "{time}", time.nome));
        else avisarAFalha(ordem);
      } finally {
        marcar(ligacaoId, null);
        reler();
      }
    },
    [avisarAFalha, marcar, reler, t],
  );

  return {
    emCurso,
    /** Há um "Atender" deste navegador em curso: os outros esperam. */
    puxando: Object.values(emCurso).includes("atender"),
    atender,
    mover,
  };
}
