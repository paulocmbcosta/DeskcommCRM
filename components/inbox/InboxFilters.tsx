"use client";
import { useT } from "@/hooks/i18n/useT";
import { useEffect, useRef, useState } from "react";
import { Bell, Funnel, MagnifyingGlass } from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useConversationTagVocabulary } from "@/hooks/inbox/useConversationTags";
import { useTimesDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import type { InboxTab } from "@/lib/inbox/abas";

export { INBOX_TABS, visibleInboxTabs, type InboxTab } from "@/lib/inbox/abas";

export interface InboxFiltersValue {
  tab: InboxTab;
  search: string;
  onlyUnread: boolean;
  channel_session_id?: string;
  tag?: string;
  /**
   * A FILA por setor (migration 0263): `mine` (meus times + a geral), `none` (só
   * a geral) ou o id de um time. `undefined` é "todas as filas".
   *
   * ⚠️ O default é `undefined` DE PROPÓSITO, e a decisão é de tela, não de
   * segurança. Nascer em `mine` esconderia, de quem não está em time nenhum,
   * toda conversa encaminhada a um setor — inclusive uma que ESTÁ atribuída a
   * ela, porque o filtro é por time e não por dono. Numa instalação que acabou
   * de atualizar, o inbox encolheria sozinho sem nada na tela dizendo por quê.
   * Quem quiser a visão por setor a escolhe, e a escolha fica visível no
   * seletor.
   */
  team_id?: string;
}

/** "Os times de quem está olhando, mais a fila geral." */
export const FILA_MEUS_TIMES = "mine";
/** "Só o que ninguém encaminhou para setor nenhum." */
export const FILA_GERAL = "none";

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
  /**
   * Os seletores (time, número, etiqueta) ficam RECOLHIDOS — abrem no funil,
   * filtra-se, e fecham de novo, para a coluna ser de conversas e não de
   * controles. Controlado pelo pai quando ele quer fechá-los por conta própria
   * (o inbox fecha ao abrir uma conversa); sem as duas props, o componente
   * cuida do próprio estado.
   */
  aberto?: boolean;
  onAbertoChange?: (aberto: boolean) => void;
}

/**
 * Quantos filtros auxiliares estão valendo AGORA.
 *
 * É o que impede o recolhimento de virar mentira de tela: com os seletores
 * fechados, um filtro ativo seria invisível — a lista encolheria sem nada
 * dizendo por quê. O número no funil diz, e o funil muda de cor.
 */
export function contarFiltrosAuxiliares(value: InboxFiltersValue): number {
  return [value.team_id, value.channel_session_id, value.tag].filter((v) => v != null).length;
}

export function InboxFilters({ value, onChange, aberto, onAbertoChange }: Props) {
  const t = useT();
  const [abertoLocal, setAbertoLocal] = useState(false);
  const filtrosAbertos = aberto ?? abertoLocal;
  const alternarFiltros = () => {
    const proximo = !filtrosAbertos;
    setAbertoLocal(proximo);
    onAbertoChange?.(proximo);
  };
  const filtrosAtivos = contarFiltrosAuxiliares(value);
  const [searchInput, setSearchInput] = useState(value.search);
  /**
   * O campo escuta o valor de FORA — e só ele.
   *
   * O estado do campo é próprio porque o debounce mora nele. O preço era não
   * saber quando o filtro morria por outro caminho: "Limpar filtros" zerava a
   * busca aplicada e deixava o termo escrito na tela, mostrando uma busca que
   * não valia mais — a mesma mentira de tela que esta entrega existe para matar.
   *
   * A ref guarda o que ESTE campo propagou. Valor de fora diferente dela = a
   * mudança veio de outro lugar, e o campo adota. Igual = foi o próprio campo, e
   * adotar atropelaria quem continuou digitando.
   *
   * ⚠️ O QUE O TESTE ALCANÇA, E O QUE NÃO. Tirar este efeito reprova o primeiro
   * caso de `tests/unit/limpar-filtros-limpa-o-campo.test.tsx` — medido. Já a
   * marca lá embaixo, no timer, NÃO é alcançada por teste determinístico: ela
   * defende a corrida entre o timer disparar e este efeito rodar, e nessa fresta
   * o teste nunca consegue digitar. Medido também: sabotá-la deixa os dois casos
   * verdes. Está escrito aqui em vez de fingir cobertura que não existe.
   */
  const propagado = useRef(value.search);
  useEffect(() => {
    if (value.search !== propagado.current) {
      propagado.current = value.search;
      setSearchInput(value.search);
    }
  }, [value.search]);
  const { data: channels } = useChannelSessions({ refetchInterval: 30_000 });
  const { activeOrg } = useAuth();
  const { data: tagVocabulary } = useConversationTagVocabulary(activeOrg?.orgId ?? null);
  const { data: times } = useTimesDoInbox();

  // Filtrar por um número que saiu da lista (o operador acabou de excluir o
  // canal) deixa o inbox mostrando um subconjunto — às vezes vazio — sem nada na
  // tela dizendo que há filtro. O número some do dropdown junto com o canal, e o
  // alternador inteiro sumiria com ele se sobrasse menos de dois.
  const filtroForaDaLista =
    value.channel_session_id != null &&
    channels != null &&
    !channels.some((c) => c.id === value.channel_session_id);
  // Alternador só aparece com 2+ números — com um só não há o que alternar.
  const showChannelSwitch = (channels?.length ?? 0) >= 2 || filtroForaDaLista;
  // O MESMO tratamento, agora para a etiqueta. Sem ele, o seletor inteiro some
  // com o filtro AINDA APLICADO — a lista fica num subconjunto, às vezes vazio,
  // e nada na tela diz que há filtro nem oferece como tirá-lo.
  const tagForaDoVocabulario =
    value.tag != null &&
    tagVocabulary != null &&
    !tagVocabulary.includes(value.tag);
  const mostrarSeletorDeTag =
    (tagVocabulary?.length ?? 0) > 0 || tagForaDoVocabulario;

  // Arquivado não é destino de filtro: ele existe no catálogo só para o selo do
  // cabeçalho saber nomear conversa antiga.
  const timesVivos = (times ?? []).filter((time) => !time.archived);
  // O MESMO tratamento do canal e da etiqueta, pela terceira vez e pela mesma
  // razão: o time filtrado foi arquivado, o seletor sumiria com o filtro AINDA
  // APLICADO, e a lista ficaria num subconjunto sem nada dizendo por quê.
  const timeForaDaLista =
    value.team_id != null &&
    value.team_id !== FILA_MEUS_TIMES &&
    value.team_id !== FILA_GERAL &&
    times != null &&
    !timesVivos.some((time) => time.id === value.team_id);
  /**
   * Sem time cadastrado, o seletor NÃO existe.
   *
   * Uma instalação que nunca criou setor nenhum não ganha um filtro a mais na
   * barra por causa de uma feature que ela não usa — e "Meus times" numa org sem
   * times seria uma opção que responde sempre a mesma coisa.
   */
  const mostrarSeletorDeTime = timesVivos.length > 0 || timeForaDaLista;

  // O timer lê o valor MAIS RECENTE, não o do render em que foi agendado.
  //
  // Antes, o efeito dependia só de `[searchInput]` e a closure capturava `value`
  // inteiro — `tab` incluso. Digitar e trocar de aba em menos de 250 ms fazia o
  // timer disparar com a aba VELHA e devolver o operador à aba anterior, sem ele
  // ter pedido. Some em teste manual: quem sabe do defeito digita devagar.
  //
  // As refs são o que permite manter `[searchInput]` como única dependência (pôr
  // `value`/`onChange` ali reagendaria o timer a cada render e a busca nunca
  // fecharia) SEM pagar o preço da closure velha.
  const valorRef = useRef(value);
  const onChangeRef = useRef(onChange);
  // A atualização vai num efeito, e não no corpo do render: escrever em ref
  // durante a renderização é proibido pela regra `react-hooks/refs` — o React
  // pode renderizar sem efetivar, e aí a ref passa a apontar para um estado que
  // nunca chegou à tela. O efeito roda depois do commit, quando `value` é real.
  useEffect(() => {
    valorRef.current = value;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    const t = setTimeout(() => {
      const atual = valorRef.current;
      if (searchInput !== atual.search) {
        // Marca ANTES de propagar: se o efeito de sincronização rodar depois de
        // a pessoa ter digitado mais uma tecla, ele veria o valor que ESTE campo
        // acabou de mandar e o adotaria por cima do que já está na tela. Sem
        // teste que alcance — ver o aviso no efeito lá em cima.
        propagado.current = searchInput;
        onChangeRef.current({ ...atual, search: searchInput });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  return (
    <div className="border-b border-border bg-background">
      <div className="space-y-2 px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlass
              size={15}
              weight="regular"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle"
              aria-hidden
            />
            {/* "última mensagem", e não "mensagem": a busca alcança apenas
                `conversations.last_message_preview` — a ÚLTIMA mensagem, truncada em 200
                caracteres já na ingestão (`grep -rn 'slice(0, 200)' lib/channels/` mostra onde).
                Medido numa conversa real de 32 mensagens: buscar o que o cliente pediu na
                3ª devolve ZERO. Alcançar o histórico é projeto próprio (índice trigram +
                retenção + LGPD); até lá, a tela não promete o que o backend não faz. */}
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("Buscar por nome, telefone ou última mensagem…")}
              className="h-9 rounded-full border-transparent bg-surface-elevated pl-9 text-sm shadow-none focus-visible:border-border focus-visible:bg-background"
              aria-label={t("Buscar conversas")}
            />
          </div>
          {/* O FUNIL guarda os seletores. Ele nunca esconde um filtro LIGADO:
              com algo valendo, muda de cor e mostra quantos são — é a diferença
              entre recolher controles e esconder estado. */}
          <button
            type="button"
            aria-expanded={filtrosAbertos}
            aria-controls="inbox-filtros-auxiliares"
            aria-label={t("Filtros")}
            title={t("Filtros")}
            data-testid="inbox-abrir-filtros"
            onClick={alternarFiltros}
            className={cn(
              "relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              filtrosAtivos > 0 || filtrosAbertos
                ? "border-accent bg-accent-soft text-accent"
                : "border-transparent bg-surface-elevated text-text-muted hover:text-text",
            )}
          >
            <Funnel size={16} weight={filtrosAtivos > 0 ? "fill" : "regular"} aria-hidden />
            {filtrosAtivos > 0 && (
              <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums leading-none text-accent-foreground">
                {filtrosAtivos}
              </span>
            )}
          </button>
          {/* Pressionável em vez de Switch: o filtro vive na linha da busca, e
              um Switch com rótulo pedia uma fileira inteira só para si. */}
          <button
            type="button"
            aria-pressed={value.onlyUnread}
            aria-label={t("Não lidos")}
            title={t("Não lidos")}
            onClick={() => onChange({ ...value, onlyUnread: !value.onlyUnread })}
            className={cn(
              "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              value.onlyUnread
                ? "border-accent bg-accent text-accent-foreground"
                : "border-transparent bg-surface-elevated text-text-muted hover:text-text",
            )}
          >
            <Bell size={16} weight={value.onlyUnread ? "fill" : "regular"} aria-hidden />
          </button>
        </div>

        {filtrosAbertos && (
        <div id="inbox-filtros-auxiliares" data-testid="inbox-filtros-auxiliares" className="space-y-2">
        {!mostrarSeletorDeTime && !showChannelSwitch && !mostrarSeletorDeTag && (
          <p className="px-1 text-xs text-text-muted">
            {t("Ainda não há o que filtrar: os filtros aparecem quando existir mais de um número, um time ou uma etiqueta.")}
          </p>
        )}
        {/* A FILA POR SETOR, em linha própria e ACIMA das demais.
            Própria porque ela responde "de quem é este trabalho", que é uma
            pergunta de outra ordem que "por qual número" e "com que etiqueta" —
            e porque três seletores numa coluna de 280px deixam ~88px para cada
            um, largura em que todo rótulo vira reticência. */}
        {mostrarSeletorDeTime && (
          <Select
            value={value.team_id ?? "all"}
            onValueChange={(v) =>
              onChange({ ...value, team_id: v === "all" ? undefined : v })
            }
          >
            <SelectTrigger
              className={cn(
                "h-8 w-full rounded-full border-transparent bg-surface-elevated px-3 text-xs shadow-none",
                value.team_id != null && "border-accent bg-accent-soft text-accent",
              )}
              aria-label={t("Filtrar por time")}
            >
              <SelectValue placeholder={t("Todas as filas")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("Todas as filas")}</SelectItem>
              <SelectItem value={FILA_MEUS_TIMES}>{t("Meus times")}</SelectItem>
              {/* A fila geral precisa de um valor PRÓPRIO: a ausência do filtro
                  significa "não filtre", que é outra pergunta — sem esta opção
                  não haveria como pedir "o que ninguém encaminhou". */}
              <SelectItem value={FILA_GERAL}>{t("Fila geral (sem time)")}</SelectItem>
              {/* A órfã entra na lista pelo mesmo motivo da etiqueta: sem ela o
                  Select mostraria o placeholder no lugar do valor JÁ escolhido. */}
              {timeForaDaLista && value.team_id != null && (
                <SelectItem value={value.team_id}>{t("Time arquivado")}</SelectItem>
              )}
              {timesVivos.map((time) => (
                <SelectItem key={time.id} value={time.id}>
                  {time.name}
                  {!time.aberto_agora && (
                    <span className="ml-1 text-muted-foreground">· {t("fechado agora")}</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {(showChannelSwitch || mostrarSeletorDeTag) && (
          <div className="flex gap-2">
            {showChannelSwitch && (
              <Select
                value={value.channel_session_id ?? "all"}
                onValueChange={(v) =>
                  onChange({ ...value, channel_session_id: v === "all" ? undefined : v })
                }
              >
                <SelectTrigger
                  className={cn(
                    "h-8 min-w-0 flex-1 rounded-full border-transparent bg-surface-elevated px-3 text-xs shadow-none",
                    value.channel_session_id != null && "border-accent bg-accent-soft text-accent",
                  )}
                  aria-label={t("Filtrar por número de WhatsApp")}
                >
                  <SelectValue placeholder={t("Todos os números")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("Todos os números")}</SelectItem>
                  {filtroForaDaLista && value.channel_session_id != null && (
                    <SelectItem value={value.channel_session_id}>{t("Número removido")}</SelectItem>
                  )}
                  {channels?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {channelLabel(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {mostrarSeletorDeTag && (
              <Select
                value={value.tag ?? "all"}
                onValueChange={(v) => onChange({ ...value, tag: v === "all" ? undefined : v })}
              >
                <SelectTrigger
                  className={cn(
                    "h-8 min-w-0 flex-1 rounded-full border-transparent bg-surface-elevated px-3 text-xs shadow-none",
                    value.tag != null && "border-accent bg-accent-soft text-accent",
                  )}
                  aria-label={t("Filtrar por tag")}
                >
                  <SelectValue placeholder={t("Todas as tags")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("Todas as tags")}</SelectItem>
                  {/* A órfã entra na lista: sem ela o Select mostraria o
                      placeholder no lugar do valor JÁ selecionado, e o operador
                      veria "Todas as tags" com um filtro ativo. */}
                  {[
                    ...(tagVocabulary ?? []),
                    ...(tagForaDoVocabulario && value.tag ? [value.tag] : []),
                  ].map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      {tag}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
        </div>
        )}
      </div>
    </div>
  );
}
