"use client";
/**
 * UMA LIGAÇÃO VIVA na aba Telefone do Inbox (migration 0295): quem liga, para
 * qual time, por qual número da empresa, e ONDE ela está agora — na fila (com a
 * posição e o quanto falta para a espera esgotar), tocando para alguém, no menu
 * ou em ligação.
 *
 * A linha não lê relógio nenhum: `agoraMs` vem de quem a desenha, que é quem
 * sabe a defasagem entre o relógio do banco e o deste navegador. Assim as linhas
 * andam todas no mesmo segundo, e o teste não precisa esperar.
 *
 * A área principal é um botão só quando há o que abrir (`onAbrir`): a ligação
 * de número oculto não tem conversa, e uma linha que parece clicável e não faz
 * nada é o controle decorativo que esta casa não aceita.
 *
 * AGIR NA FILA (entrega 3; migration 0296). Na ligação que espera por uma pessoa
 * (`aguardando` ou `tocando`), a linha ganha "Atender" — para quem tem ramal — e
 * "Mover" — para gerente e admin. Os dois ficam FORA da área principal, numa
 * faixa embaixo do texto: botão dentro de botão não existe, e ao lado do texto
 * eles o espremeriam (a coluna da lista tem de 250 a 300 px). Quem decide quem
 * pode é a coluna, e chega aqui pronto (`acoes`); quem recusa o pedido, com o
 * motivo, é a rota — por isso os botões não se desligam pelo estado da ligação,
 * só enquanto o pedido DESTE navegador corre.
 *
 * Com uma ordem já aberta sobre a ligação (`ligacao.ordem`), a faixa diz quem
 * está cuidando, no lugar dos botões. E a ligação que toca para quem olha não
 * oferece "Atender": ela se atende pelo aviso de toque, e o banco já conta essa
 * pessoa como ocupada — a rota recusaria.
 */
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import {
  FASES_EM_QUE_SE_AGE,
  relogio,
  urgenciaDaEspera,
  type LigacaoNaFila,
  type OrdemNaFila,
  type UrgenciaDaEspera,
} from "@/lib/telefonia/fila";
import { trocarMarcador } from "@/lib/telefonia/texto-do-menu";
import { CircleNotch, Phone } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { MoverDeTime } from "./MoverDeTime";
import type { AcaoNaFila } from "./useAcoesDaFila";

/** O que quem olha pode fazer com as ligações que esperam — decidido pela coluna, igual para toda linha. */
export interface AcoesDaLinha {
  /** Quem olha tem ramal: pode puxar a ligação para si. */
  podeAtender: boolean;
  /** Gerente ou admin: pode mandar a ligação para a fila de outro time. */
  podeMover: boolean;
  /** O pedido DESTE navegador que ainda corre sobre esta ligação. */
  emCurso: AcaoNaFila | null;
  /** Há um "Atender" deste navegador em curso, nesta ou em outra ligação: só se puxa uma por vez. */
  puxando: boolean;
  /** Os times ativos da fila; o menu de mover tira o time em que a ligação está. */
  times: ReadonlyArray<{ id: string; nome: string }>;
  onAtender: () => void;
  onMover: (time: { id: string; nome: string }) => void;
}

interface Props {
  ligacao: LigacaoNaFila;
  nomeDoTime: string | null;
  /** O número da EMPRESA que foi chamado (ou o apelido dele, quando não há número). */
  numeroDaEmpresa: string | null;
  /** A espera máxima do time, em segundos — a régua do peso da espera. */
  tetoS: number | null;
  /** O relógio do banco, já corrigido pela defasagem (ms). */
  agoraMs: number;
  selecionada: boolean;
  /** Abre a conversa da ligação. Ausente = a ligação não tem conversa, e a área principal não é botão. */
  onAbrir?: () => void;
  /** O id de quem olha: a ligação que toca para ESTA pessoa diz "Tocando para você" e não oferece "Atender". */
  euId?: string | null;
  /** Atender e Mover (entrega 3). Ausente = quem olha só olha. */
  acoes?: AcoesDaLinha;
  /** O nome do time de destino da ordem de mover aberta (`ligacao.ordem.para_time_id`), se conhecido. */
  nomeDoTimeDaOrdem?: string | null;
}

/** A linha inteira: a área principal e, embaixo, a faixa das ações. A borda, o realce e a seleção são dela. */
const LINHA = "group relative border-b border-border/70";
const LINHA_QUE_ABRE = "transition-colors hover:bg-surface-elevated";
/** A área principal, com as mesmas medidas da linha de conversa (`ConversationListItem`): as duas listas dividem a coluna. */
const CORPO = "flex w-full items-start gap-3 px-3 py-2.5 text-left";
const CORPO_QUE_ABRE = "focus-visible:outline-hidden focus-visible:bg-surface-elevated";
/** A faixa das ações começa onde o texto começa: 12 px de respiro, 24 do selo da posição e 12 de vão. */
const FAIXA = "pb-2.5 pl-12 pr-3";

/**
 * A cor da espera na fila. Texto E cor: o tempo está sempre escrito, a cor só
 * diz o quanto ele pesa contra o teto do time.
 */
const COR_DA_URGENCIA: Record<UrgenciaDaEspera, string> = {
  normal: "text-text-muted",
  atencao: "rounded-full bg-warning-bg px-1.5 py-0.5 text-warning-fg",
  critico: "rounded-full bg-error px-1.5 py-0.5 text-bg",
};

/** Quanto tempo passou desde `iso`, em ms. Data ilegível conta zero, em vez de virar `NaN:NaN` na tela. */
function desde(iso: string | null, agoraMs: number): number {
  if (!iso) return 0;
  const ms = agoraMs - new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** O estado da ligação, por extenso, e o peso da espera (só a fila sem ninguém tocando tem prazo). */
function estadoDaLigacao(
  l: LigacaoNaFila,
  agoraMs: number,
  tetoS: number | null,
  t: (texto: string) => string,
  tocandoParaMim: boolean,
): { texto: string; urgencia: UrgenciaDaEspera | null } {
  const naFilaHa = relogio(desde(l.na_fila_desde ?? l.entrou_em, agoraMs));
  switch (l.fase) {
    case "aguardando": {
      const caiEm = l.cai_em ? new Date(l.cai_em).getTime() : null;
      const prazo = caiEm !== null && Number.isFinite(caiEm) ? caiEm : null;
      const espera = `${t("Aguardando há")} ${naFilaHa}`;
      return {
        // Prazo vencido não vira "cai em 0:00" parado na tela: a cor já diz que
        // esgotou, e quem derruba a ligação é o worker.
        texto: prazo !== null && prazo > agoraMs ? `${espera} · ${t("cai em")} ${relogio(prazo - agoraMs)}` : espera,
        urgencia: urgenciaDaEspera(prazo, agoraMs, tetoS),
      };
    }
    case "tocando":
      return {
        texto: `${tocandoParaMim ? t("Tocando para você") : `${t("Tocando para")} ${l.tocando_para?.nome?.trim() || t("alguém")}`} · ${t("na fila há")} ${naFilaHa}`,
        urgencia: null,
      };
    case "menu":
      return { texto: `${t("Ouvindo as opções")} · ${relogio(desde(l.entrou_em, agoraMs))}`, urgencia: null };
    case "avisos":
      return { texto: `${t("Ouvindo os avisos")} · ${relogio(desde(l.entrou_em, agoraMs))}`, urgencia: null };
    case "em_ligacao":
      return {
        texto: `${t("Com")} ${l.com?.nome?.trim() || t("alguém")} ${t("há")} ${relogio(desde(l.atendida_em ?? l.entrou_em, agoraMs))}`,
        urgencia: null,
      };
    case "transferencia_na_fila":
      return {
        texto: `${t("Transferida por")} ${l.com?.nome?.trim() || t("alguém")} · ${t("aguardando há")} ${naFilaHa}`,
        urgencia: null,
      };
  }
}

/** Quem está cuidando da ligação, por extenso: "Ana está atendendo…", "Movendo para Financeiro…". */
function fraseDaOrdem(ordem: OrdemNaFila, nomeDoTimeDaOrdem: string | null, t: (texto: string) => string): string {
  if (ordem.tipo === "move") {
    return trocarMarcador(t("Movendo para {time}…"), "{time}", nomeDoTimeDaOrdem?.trim() || t("outro time"));
  }
  return trocarMarcador(t("{nome} está atendendo…"), "{nome}", ordem.por?.nome?.trim() || t("alguém"));
}

export function LinhaDaFila({
  ligacao,
  nomeDoTime,
  numeroDaEmpresa,
  tetoS,
  agoraMs,
  selecionada,
  onAbrir,
  euId,
  acoes,
  nomeDoTimeDaOrdem,
}: Props) {
  const t = useT();
  const nome = ligacao.contato?.nome?.trim() || null;
  const numero = phoneForDisplay(ligacao.numero) || null;
  const empresa = phoneForDisplay(numeroDaEmpresa) || null;
  // Com nome, o número desce para a segunda linha; sem nome, ele É o título.
  const detalhes = [nome ? numero : null, nomeDoTime, empresa ? `${t("pelo")} ${empresa}` : null].filter(Boolean);
  const tocandoParaMim = ligacao.fase === "tocando" && Boolean(euId) && ligacao.tocando_para?.id === euId;
  const estado = estadoDaLigacao(ligacao, agoraMs, tetoS, t, tocandoParaMim);

  // A faixa embaixo do texto, só na ligação que espera por uma pessoa: quem já
  // está cuidando (a ordem aberta, que GANHA dos botões) ou os botões de quem
  // pode agir.
  const seAge = FASES_EM_QUE_SE_AGE.has(ligacao.fase);
  const ordem = seAge ? ligacao.ordem : null;
  // A que toca para mim se atende pelo aviso de toque — e a rota recusaria o pedido.
  const mostrarAtender = seAge && Boolean(acoes?.podeAtender) && !tocandoParaMim;
  // Sem outro time ativo não há para onde mover: o botão abriria um menu vazio.
  const destinos = (acoes?.times ?? []).filter((time) => time.id !== ligacao.time_id);
  const mostrarMover = seAge && Boolean(acoes?.podeMover) && destinos.length > 0;
  const atendendo = acoes?.emCurso === "atender";
  const movendo = acoes?.emCurso === "mover";

  const faixa = ordem ? (
    <p className={cn(FAIXA, "text-[11px] font-medium text-text-muted")} data-fila-ordem={ordem.tipo}>
      {fraseDaOrdem(ordem, nomeDoTimeDaOrdem ?? null, t)}
    </p>
  ) : acoes && (mostrarAtender || mostrarMover) ? (
    <div className={cn(FAIXA, "flex flex-wrap items-center gap-1.5")} data-fila-acoes>
      {mostrarAtender && (
        <Button
          size="sm"
          className="gap-1.5"
          aria-busy={atendendo}
          // Só o pedido DESTE navegador desliga o botão: o meu "Atender" em curso
          // (aqui ou em outra linha — só se puxa uma por vez) e o meu "Mover" nesta.
          disabled={acoes.puxando || acoes.emCurso !== null}
          data-fila-atender={ligacao.id}
          onClick={acoes.onAtender}
        >
          {atendendo ? <CircleNotch className="animate-spin" aria-hidden /> : <Phone weight="bold" aria-hidden />}
          {t("Atender")}
        </Button>
      )}
      {mostrarMover && (
        <MoverDeTime
          ligacaoId={ligacao.id}
          destinos={destinos}
          movendo={movendo}
          desligado={acoes.emCurso !== null}
          onMover={acoes.onMover}
        />
      )}
    </div>
  ) : null;

  const conteudo = (
    <>
      {/* Largura fixa: com a posição ou com o ícone, o nome começa no mesmo lugar. */}
      <span className="flex h-5 w-6 shrink-0 items-center justify-center">
        {ligacao.posicao !== null ? (
          <span
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-soft px-1 text-[10px] font-medium tabular-nums text-accent"
            aria-label={`${t("Posição")} ${ligacao.posicao} ${t("na fila")}`}
          >
            {ligacao.posicao}º
          </span>
        ) : (
          <Phone size={14} className="text-text-subtle" aria-hidden />
        )}
      </span>
      <span className="block min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text">
          {nome ?? numero ?? t("Número não identificado")}
        </span>
        {detalhes.length > 0 && (
          <span className="mt-0.5 block truncate text-[11px] text-text-muted">{detalhes.join(" · ")}</span>
        )}
        <span className="mt-1 block text-[11px] font-medium">
          <span
            className={cn("inline-block max-w-full tabular-nums", COR_DA_URGENCIA[estado.urgencia ?? "normal"])}
            data-testid="estado-da-ligacao"
            data-urgencia={estado.urgencia ?? undefined}
          >
            {estado.texto}
          </span>
        </span>
      </span>
    </>
  );

  // Com a faixa embaixo, o respiro de baixo é dela.
  const corpo = cn(CORPO, faixa && "pb-1.5");
  return (
    <div
      className={cn(LINHA, onAbrir && LINHA_QUE_ABRE, selecionada && "bg-accent-50 hover:bg-accent-50")}
      data-linha-da-fila={ligacao.id}
    >
      {selecionada && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
      {/* Os seletores da ligação (`data-ligacao-id`, `data-fase`, `aria-current`)
          ficam na área PRINCIPAL: é ela que se clica para abrir a conversa. */}
      {onAbrir ? (
        <button
          type="button"
          className={cn(corpo, CORPO_QUE_ABRE)}
          data-ligacao-id={ligacao.id}
          data-fase={ligacao.fase}
          aria-current={selecionada ? "true" : undefined}
          onClick={onAbrir}
        >
          {conteudo}
        </button>
      ) : (
        <div className={corpo} data-ligacao-id={ligacao.id} data-fase={ligacao.fase}>
          {conteudo}
        </div>
      )}
      {faixa}
    </div>
  );
}
