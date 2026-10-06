"use client";
/**
 * A COLUNA DA ABA TELEFONE do Inbox (migration 0295): quem está na fila do
 * telefone, por ordem de chegada; quem ainda ouve o menu; quem está em ligação;
 * e as perdidas dos últimos 30 minutos.
 *
 * A leitura NÃO é daqui: `useFilaDoTelefone` é chamado uma vez, no
 * `InboxLayout`, e desce por prop — o selo do trilho e esta coluna saem da mesma
 * resposta, então o selo nunca conta o que a lista não mostra. Os filtros (time
 * e número da empresa) são desta coluna, aplicados sobre aquela resposta.
 *
 * O RELÓGIO: os tempos da tela ("aguardando há 3:42", "cai em 1:18") andam
 * sozinhos, a cada segundo, sem leitura nenhuma — UM relógio para a coluna
 * inteira, e não um por linha. Ele mede pelo relógio do BANCO: a resposta traz a
 * hora de lá, e a defasagem deste navegador entra na conta (um computador dois
 * minutos atrasado mostraria toda espera dois minutos menor).
 */
import type { UseQueryResult } from "@tanstack/react-query";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { BotaoLigar } from "@/components/telefonia/BotaoLigar";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import type { FilaComRelogio } from "@/hooks/telefonia/useFilaDoTelefone";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import {
  FASES_QUE_ESPERAM,
  relogio,
  type FilaDoTelefone as Fila,
  type LigacaoNaFila,
  type MotivoDaPerdida,
  type PerdidaRecente,
} from "@/lib/telefonia/fila";
import { PhoneX } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { ChipsDaFila } from "./ChipsDaFila";
import { LinhaDaFila } from "./LinhaDaFila";

/** Por que a ligação se perdeu, como a tela diz. A chave é o vocabulário de `lib/telefonia/fila.ts`. */
const MOTIVO: Record<MotivoDaPerdida, string> = {
  desligou_no_menu: "Desligou no menu",
  desistiu_na_fila: "Desistiu na fila",
  fila_esgotada: "A fila esgotou",
  ninguem_atendeu: "Ninguém atendeu",
  fora_do_horario: "Fora do horário",
  interrompida: "Interrompida",
  outro: "Não atendida",
};

/**
 * O alvo do clique na linha da perdida (ícone + texto). O respiro da direita é
 * dividido com a linha (`pr-1` aqui, `pr-2` nela): com ou sem o botão de ligar,
 * a borda direita fica onde fica nas outras linhas.
 */
const CORPO_DA_PERDIDA = "flex min-w-0 flex-1 items-start gap-3 py-2.5 pl-3 pr-1 text-left";

/** O valor do seletor que significa "sem filtro de número". */
const TODOS_OS_NUMEROS = "all";

interface Props {
  consulta: Pick<UseQueryResult<FilaComRelogio>, "data" | "isPending" | "isError" | "refetch">;
  /** A conversa aberta à direita — a linha dela fica marcada. */
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * O RELÓGIO DA TELA: a hora deste navegador, relida a cada segundo.
 *
 * É uma fonte EXTERNA ao React, e é lida como tal (`useSyncExternalStore`): o
 * desenho não chama `Date.now()` por conta própria (um componente que lê a hora
 * no corpo muda de resultado a cada redesenho), e nenhum efeito copia a hora
 * para um estado. No servidor não há relógio (`null`) — o primeiro desenho do
 * cliente é igual ao que veio de lá, e a hora entra logo depois.
 *
 * Truncada ao segundo: a leitura tem de devolver o MESMO valor entre duas
 * batidas, e a tela não mostra fração de segundo.
 */
function assinarRelogio(aoBater: () => void): () => void {
  const batida = setInterval(aoBater, 1_000);
  return () => clearInterval(batida);
}
const lerRelogio = (): number => Math.floor(Date.now() / 1_000) * 1_000;
const semRelogio = (): number | null => null;

function useRelogioDaTela(): number | null {
  return useSyncExternalStore<number | null>(assinarRelogio, lerRelogio, semRelogio);
}

/** O número da empresa como se lê: "Matriz · +55…", ou só o que houver. */
function rotuloDoNumero(n: Fila["numeros"][number]): string {
  return [n.nome?.trim(), phoneForDisplay(n.numero)].filter(Boolean).join(" · ") || "—";
}

/** A ordem da fila: quem espera há mais tempo em cima; empate pelo id, para a linha não pular de lugar. */
function porOrdemDeChegada(a: LigacaoNaFila, b: LigacaoNaFila): number {
  const desde = (l: LigacaoNaFila) => new Date(l.na_fila_desde ?? l.entrou_em).getTime();
  return desde(a) - desde(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function FilaDoTelefone({ consulta, selectedId, onSelect }: Props) {
  const t = useT();
  const relogioMs = useRelogioDaTela();
  const [timeEscolhido, setTimeEscolhido] = useState<string | undefined>(undefined);
  const [numeroEscolhido, setNumeroEscolhido] = useState<string | undefined>(undefined);

  const { data } = consulta;

  if (!data) {
    if (consulta.isError) {
      return (
        <div role="alert" className="p-4 text-center text-sm text-text-muted">
          <p>{t("Não foi possível ler a fila do telefone.")}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void consulta.refetch()}>
            {t("Tentar novamente")}
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-3 p-3" data-testid="fila-do-telefone-carregando" aria-busy>
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  // `?filter=phone` numa organização sem telefone (link guardado, telefonia
  // desligada depois): a aba some do trilho, e quem chegou aqui lê o porquê.
  if (!data.ativa) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-text-muted">
        {t("O telefone não está ligado nesta organização.")}
      </div>
    );
  }

  // A hora do BANCO, agora: o relógio deste navegador mais a defasagem medida na
  // leitura. Sem relógio ainda (o desenho do servidor), vale a hora da leitura.
  const agoraMs = relogioMs !== null ? relogioMs + data.defasagemMs : new Date(data.agora).getTime();
  const nomeDoTime = new Map(data.times.map((time) => [time.id, time.nome] as const));
  const tetoDoTime = new Map(data.times.map((time) => [time.id, time.espera_maxima_s] as const));
  // Na linha, o número da empresa é o NÚMERO; o apelido fica para quando não há número.
  const numeroDaEmpresa = new Map(data.numeros.map((n) => [n.id, n.numero ?? n.nome] as const));

  // Com um número só não há seletor na tela — e um filtro sem controle que o
  // desfaça é uma lista menor sem explicação. Só vale o número que ainda existe.
  const mostrarNumeros = data.numeros.length > 1;
  const numero =
    mostrarNumeros && data.numeros.some((n) => n.id === numeroEscolhido) ? numeroEscolhido : undefined;

  const doNumero = (x: { numero_da_empresa_id: string }) => numero === undefined || x.numero_da_empresa_id === numero;
  const doTime = (x: { time_id: string | null }) => timeEscolhido === undefined || x.time_id === timeEscolhido;

  const ligacoesDoNumero = data.ligacoes.filter(doNumero);
  const ligacoes = ligacoesDoNumero.filter(doTime);
  const naFila = ligacoes.filter((l) => FASES_QUE_ESPERAM.has(l.fase)).sort(porOrdemDeChegada);
  const noMenu = ligacoes.filter((l) => l.fase === "menu" || l.fase === "avisos");
  const emLigacao = ligacoes.filter((l) => l.fase === "em_ligacao");
  const perdidas = data.perdidas.filter(doNumero).filter(doTime);
  const vazio = naFila.length + noMenu.length + emLigacao.length + perdidas.length === 0;

  const linha = (l: LigacaoNaFila) => {
    const conversa = l.conversa_id;
    return (
      <LinhaDaFila
        key={l.id}
        ligacao={l}
        nomeDoTime={l.time_id ? (nomeDoTime.get(l.time_id) ?? null) : null}
        numeroDaEmpresa={numeroDaEmpresa.get(l.numero_da_empresa_id) ?? null}
        tetoS={l.time_id ? (tetoDoTime.get(l.time_id) ?? null) : null}
        agoraMs={agoraMs}
        selecionada={conversa !== null && conversa === selectedId}
        onAbrir={conversa ? () => onSelect(conversa) : undefined}
      />
    );
  };

  return (
    <div className="flex h-full flex-col">
      <ChipsDaFila
        times={data.times}
        ligacoes={ligacoesDoNumero}
        agoraMs={agoraMs}
        timeEscolhido={timeEscolhido}
        onEscolherTime={setTimeEscolhido}
      />
      {mostrarNumeros && (
        <div className="border-b border-border px-3 py-1.5">
          <Select
            value={numero ?? TODOS_OS_NUMEROS}
            onValueChange={(v) => setNumeroEscolhido(v === TODOS_OS_NUMEROS ? undefined : v)}
          >
            <SelectTrigger
              className={cn(
                "h-8 w-full rounded-full border-transparent bg-surface-elevated px-3 text-xs shadow-none",
                numero !== undefined && "border-accent bg-accent-soft text-accent",
              )}
              aria-label={t("Filtrar por número da empresa")}
              data-testid="fila-numero"
            >
              <SelectValue placeholder={t("Todos os números")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TODOS_OS_NUMEROS}>{t("Todos os números")}</SelectItem>
              {data.numeros.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {rotuloDoNumero(n)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {/* `min-h-0 flex-1`, e não `h-full`: os chips e o seletor ficam acima, e
          com a altura cheia o fim da lista passaria da coluna — as últimas
          ligações ficariam fora do alcance da rolagem. */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="fila-do-telefone">
        {vazio && (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-text-muted">
            {t("Nenhuma ligação agora.")}
          </div>
        )}
        {naFila.length > 0 && (
          <Secao id="na-fila" titulo={t("Na fila, por ordem de chegada")}>
            {naFila.map(linha)}
          </Secao>
        )}
        {noMenu.length > 0 && (
          <Secao id="no-menu" titulo={t("No menu")}>
            {noMenu.map(linha)}
          </Secao>
        )}
        {emLigacao.length > 0 && (
          <Secao id="em-ligacao" titulo={t("Em ligação")}>
            {emLigacao.map(linha)}
          </Secao>
        )}
        {perdidas.length > 0 && (
          <Secao id="perdidas" titulo={t("Perdidas nos últimos 30 minutos")}>
            {perdidas.map((p) => {
              const conversa = p.conversa_id;
              return (
                <LinhaDaPerdida
                  key={p.id}
                  perdida={p}
                  nomeDoTime={p.time_id ? (nomeDoTime.get(p.time_id) ?? null) : null}
                  agoraMs={agoraMs}
                  selecionada={conversa !== null && conversa === selectedId}
                  onAbrir={conversa ? () => onSelect(conversa) : undefined}
                />
              );
            })}
          </Secao>
        )}
      </div>
    </div>
  );
}

function Secao({ id, titulo, children }: { id: string; titulo: string; children: ReactNode }) {
  return (
    <section data-secao={id} aria-label={titulo}>
      <h3 className="px-3 pt-3 pb-1 text-[11px] font-medium text-text-subtle">{titulo}</h3>
      {children}
    </section>
  );
}

/**
 * Uma recebida que acabou sem ninguém atender. O que importa aqui é devolver a
 * ligação: por isso o botão de ligar mora na linha (ele some sozinho para quem
 * não tem ramal). A linha inteira NÃO pode ser um botão — o de ligar está dentro
 * dela, e botão dentro de botão não existe; quem abre a conversa é o resto da
 * linha, ao lado dele.
 */
function LinhaDaPerdida({
  perdida,
  nomeDoTime,
  agoraMs,
  selecionada,
  onAbrir,
}: {
  perdida: PerdidaRecente;
  nomeDoTime: string | null;
  agoraMs: number;
  selecionada: boolean;
  /** Abre a conversa da ligação. Ausente = número oculto, sem conversa: nada para clicar. */
  onAbrir?: () => void;
}) {
  const t = useT();
  const nome = perdida.contato?.nome?.trim() || null;
  const numero = phoneForDisplay(perdida.numero) || null;
  const detalhes = [nome ? numero : null, nomeDoTime].filter(Boolean);
  const passou = agoraMs - new Date(perdida.encerrada_em).getTime();
  const minutos = Number.isFinite(passou) ? Math.max(0, Math.floor(passou / 60_000)) : 0;
  const haQuanto = minutos === 0 ? t("agora há pouco") : `${t("há")} ${minutos} min`;

  // As mesmas medidas de `LinhaDaFila`: as duas dividem a coluna, e o nome
  // começa no mesmo lugar nas quatro seções.
  const corpo = (
    <>
      <span className="flex h-5 w-6 shrink-0 items-center justify-center">
        <PhoneX size={14} className="text-text-subtle" aria-hidden />
      </span>
      <span className="block min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text">
          {nome ?? numero ?? t("Número não identificado")}
        </span>
        {detalhes.length > 0 && (
          <span className="mt-0.5 block truncate text-[11px] text-text-muted">{detalhes.join(" · ")}</span>
        )}
        {/* Sem `truncate`: motivo, espera e hora cabem em duas linhas, e cortar
            qualquer um dos três é esconder o que a linha existe para dizer. */}
        <span className="mt-1 block text-[11px] tabular-nums text-text-muted">
          {`${t(MOTIVO[perdida.motivo])} · ${t("esperou")} ${relogio(perdida.esperou_s * 1000)} · ${haQuanto}`}
        </span>
      </span>
    </>
  );
  return (
    <div
      className={cn(
        "relative flex w-full items-center border-b border-border/70 pr-2",
        onAbrir && "transition-colors hover:bg-surface-elevated",
        selecionada && "bg-accent-50 hover:bg-accent-50",
      )}
      data-perdida-id={perdida.id}
      data-motivo={perdida.motivo}
    >
      {selecionada && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
      {onAbrir ? (
        <button
          type="button"
          className={cn(CORPO_DA_PERDIDA, "focus-visible:outline-hidden focus-visible:bg-surface-elevated")}
          aria-current={selecionada ? "true" : undefined}
          onClick={onAbrir}
        >
          {corpo}
        </button>
      ) : (
        <div className={CORPO_DA_PERDIDA}>{corpo}</div>
      )}
      {perdida.contato && (
        <BotaoLigar contatoId={perdida.contato.id} nome={perdida.contato.nome} temTelefone variante="icone" />
      )}
    </div>
  );
}
