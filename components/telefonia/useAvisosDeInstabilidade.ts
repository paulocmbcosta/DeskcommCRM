"use client";
/**
 * O aviso de instabilidade de cada time — o que a faixa em todo o CRM e o cartão
 * de Configurações › Times leem (desenho da fase 2, §6.3 e §6.4), pela rota
 * `GET /api/v1/telefonia/emergencias`: `{ oferecida, pode_mudar, ligados, times }`.
 *
 *  - `ligados` é o que QUALQUER membro recebe — a faixa lê só isto;
 *  - `times` (texto, quem ligou) só vem para gerente e admin — o cartão;
 *  - `pode_mudar` diz se quem lê liga e desliga. É a régua da SESSÃO decidida no
 *    servidor (`requireRole("manager")`, a mesma das escritas): a tela mostra os
 *    botões por ele e não refaz a conta do papel no navegador — o `usePermission`
 *    do cliente diria "sim" ao admin de plataforma que a rota recusa.
 *
 * Polling de 60 s, e não Realtime, por decisão medida: `attendance_teams` não
 * está na publicação `supabase_realtime`, e pô-la lá transmitiria toda edição de
 * nome e horário de time. O aviso vive horas; um minuto nas OUTRAS abas é
 * aceitável, e na aba de quem liga ou desliga a mutação invalida a consulta na
 * hora. O polling pausa com a aba escondida (padrão do TanStack Query) e relê ao
 * voltar o foco. Sem telefonia na instalação (`oferecida: false`), não relê nada.
 *
 * O PRAZO: o servidor decide o que está vigente contra o relógio da requisição —
 * a tela não confia no relógio do navegador para esconder um aviso, que pode
 * estar horas adiantado. Mas, em vez de esperar o minuto, a consulta relê quando
 * o prazo mais próximo passa (`proximoPrazo`): o aviso vencido sai da tela na
 * hora em que para de tocar. Esse relógio precisa de um dado lido (é dele que sai
 * o prazo); sem leitura boa não há aviso na tela para vencer, e quem recupera é a
 * releitura de 60 s, que NÃO depende de leitura boa nenhuma.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, isSameDay, type Locale } from "date-fns";
import { useEffect } from "react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { DuracaoDaEmergencia } from "@/lib/telefonia/vencimento-da-emergencia";
import type { AvisoDoTimePublico, AvisoNaFaixa, AvisosNaResposta, FalaParaSalvar } from "@/lib/telefonia/vocabulario";

import { fraseDaFalhaDaFala } from "./usePreviaDaFala";

/** A leitura COMPLETA (o cartão de Configurações › Times) — e o prefixo de toda leitura de aviso. */
export const CHAVE_DOS_AVISOS = ["telefonia", "avisos"] as const;

/**
 * A leitura da FAIXA (`?so=ligados`): só `ligados` e `pode_mudar`, sem a lista
 * completa nem o nome de quem ligou pedido à Auth — ela roda em toda tela, uma
 * vez por minuto em cada aba. Mora DEBAIXO de `CHAVE_DOS_AVISOS`: invalidar o
 * prefixo (o que ligar e desligar fazem) relê as duas.
 */
export const CHAVE_DA_FAIXA = [...CHAVE_DOS_AVISOS, "faixa"] as const;

const URL_DOS_AVISOS = "/api/v1/telefonia/emergencias";

/** Com a telefonia oferecida, quanto a faixa espera entre uma leitura e outra. */
export const INTERVALO_DA_RELEITURA_MS = 60_000;

/** Folga depois do prazo, para o relógio do servidor também já tê-lo passado. */
const FOLGA_DO_PRAZO_MS = 1_000;

/** O maior atraso que o `setTimeout` aceita (~24,8 dias); acima dele o navegador dispara na hora. */
const MAIOR_ESPERA_MS = 2_147_483_647;

const urlDoTime = (teamId: string) => `${URL_DOS_AVISOS}/${encodeURIComponent(teamId)}`;

/** O prazo mais próximo entre os avisos ligados, em ms; `null` quando nenhum tem prazo. */
export function proximoPrazo(ligados: readonly AvisoNaFaixa[]): number | null {
  let menor: number | null = null;
  for (const a of ligados) {
    if (!a.expira_em) continue;
    const ms = new Date(a.expira_em).getTime();
    if (Number.isFinite(ms) && (menor === null || ms < menor)) menor = ms;
  }
  return menor;
}

/**
 * A hora de um aviso no fuso de quem olha: "14:05" hoje, "30/09 01:30" em outro
 * dia — o aviso de 4 h ligado às 22 h desliga amanhã, e o "até eu desligar"
 * ligado ontem não pode parecer de hoje.
 */
export function horaDoAviso(iso: string, agora: Date, locale?: Locale): string {
  const d = new Date(iso);
  return format(d, isSameDay(d, agora) ? "HH:mm" : "dd/MM HH:mm", { locale });
}

/** A rota recusou QUEM lê (401 sessão, 403 acesso): reler não muda a resposta. */
function leituraRecusada(erro: unknown): boolean {
  return erro instanceof ApiError && (erro.status === 401 || erro.status === 403);
}

/** A faixa em todo o CRM: `oferecida` vem do layout (servidor), e sem ela nada é lido. */
export function useAvisosNaFaixa(oferecida: boolean) {
  return useLeituraDosAvisos(CHAVE_DA_FAIXA, `${URL_DOS_AVISOS}?so=ligados`, oferecida);
}

/** O cartão de Configurações › Times: a leitura completa (gerente e admin recebem `times`). */
export function useAvisosDosTimes() {
  return useLeituraDosAvisos(CHAVE_DOS_AVISOS, URL_DOS_AVISOS, true);
}

function useLeituraDosAvisos(chave: readonly string[], url: string, ligado: boolean) {
  const { activeOrg } = useAuth();
  const consulta = useQuery({
    queryKey: chave,
    enabled: ligado && activeOrg !== null,
    staleTime: 30_000,
    // A volta do foco relê SEMPRE, até depois de um 401/403: `loadAuthUser` devolve
    // 401 quando a Auth pisca por um instante, e a faixa mora no layout (não
    // remonta ao navegar) — sem este caminho, uma falha passageira a apagaria em
    // toda aba até recarregar.
    refetchOnWindowFocus: true,
    // O relógio depende de `ligado` (a faixa recebe do layout se a instalação tem
    // telefonia), e NÃO de uma leitura boa: se a primeira falhar, não há dado, e o
    // app não repete 500/504 (lib/query/client.ts) — a faixa nunca apareceria para
    // quem fica o dia inteiro com a aba em foco. O dado só DESLIGA o relógio quando
    // diz, com todas as letras, que a instalação não tem telefonia (o cartão do
    // time não recebe `ligado` do servidor e fica sabendo por ele).
    // E um 401/403 (a sessão caiu, o acesso mudou) PARA o relógio do minuto:
    // repetir às cegas não muda a resposta, e cada aba bateria na rota à toa. É o
    // erro da ÚLTIMA leitura que decide: a primeira leitura boa (pela volta do
    // foco) limpa o erro e religa o relógio.
    refetchInterval: (q) =>
      ligado && !leituraRecusada(q.state.error) && q.state.data?.oferecida !== false ? INTERVALO_DA_RELEITURA_MS : false,
    queryFn: async () => (await apiClient.get<{ data: AvisosNaResposta }>(url)).data,
  });

  const recusada = leituraRecusada(consulta.error);
  const prazo = consulta.data && !recusada ? proximoPrazo(consulta.data.ligados) : null;
  const { refetch } = consulta;
  useEffect(() => {
    if (prazo === null) return;
    const espera = Math.min(Math.max(prazo - Date.now(), 0) + FOLGA_DO_PRAZO_MS, MAIOR_ESPERA_MS);
    // `cancelRefetch: false`: a faixa e cada cartão armam o mesmo relógio; a leitura sai uma vez só.
    const relogio = setTimeout(() => void refetch({ cancelRefetch: false }), espera);
    return () => clearTimeout(relogio);
  }, [prazo, refetch]);

  return consulta;
}

/** Desliga o aviso VIGENTE do time. A recusa vira toast com a frase da rota — nunca a mensagem crua. */
export function useDesligarAviso() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (teamId: string) =>
      (await apiClient.delete<{ data: { desligado: boolean } }>(urlDoTime(teamId))).data,
    onSuccess: (r) => {
      // `desligado: false`: outra pessoa (ou o prazo) já o tinha desligado — nada mudou agora.
      toast.success(r.desligado ? t("Aviso de instabilidade desligado.") : t("O aviso de instabilidade já estava desligado."));
    },
    onError: (e) => {
      toast.error(fraseDaFalhaDaFala(e, t) ?? t("Não foi possível desligar o aviso. Tente de novo em instantes."));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CHAVE_DOS_AVISOS }),
  });
}

/**
 * Liga o aviso com o texto e o hash da prévia OUVIDA (ou os da fala em uso, com
 * o texto sem mudança). Ligar não gera fala nem chama a ElevenLabs: a rota confere
 * o hash.
 *
 * A recusa é de quem chama enquanto a janela está aberta — ela a mostra ao lado do
 * botão. `janelaAberta` diz isso: se a janela já saiu da tela quando a resposta
 * chega (a pessoa foi para outra página), a recusa vira toast aqui, em vez de
 * sumir com a janela.
 */
export function useLigarAviso(janelaAberta?: { readonly current: boolean }) {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    onError: (e) => {
      if (janelaAberta?.current) return;
      toast.error(fraseDaFalhaDaFala(e, t) ?? t("Não foi possível ligar o aviso. Tente de novo em instantes."));
    },
    mutationFn: async (p: { teamId: string; fala: FalaParaSalvar; duracao: DuracaoDaEmergencia }) =>
      (await apiClient.put<{ data: { aviso: AvisoDoTimePublico } }>(urlDoTime(p.teamId), { fala: p.fala, duracao: p.duracao }))
        .data,
    onSuccess: async () => {
      toast.success(t("Aviso de instabilidade ligado."));
      await qc.invalidateQueries({ queryKey: CHAVE_DOS_AVISOS });
    },
  });
}
