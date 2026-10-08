"use client";
import { useT } from "@/hooks/i18n/useT";
import { useEffect, useRef, useState } from "react";
import { Bell, Funnel, MagnifyingGlass } from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { canalComNumero } from "@/lib/inbox/rotulo-do-canal";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useConversationTagVocabulary } from "@/hooks/inbox/useConversationTags";
import { useTimesDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import { MEIOS_DE_CANAL, type MeioDeCanal } from "@/lib/channels/capabilities";
import type { InboxTab } from "@/lib/inbox/abas";
import {
  contarFiltrosDoFunil,
  filtrosAplicados,
  valeNaAba,
  type FiltrosDeTela,
} from "@/lib/inbox/filtros-de-tela";
import type { OpcoesDosFiltros } from "@/lib/inbox/opcoes-dos-filtros";
import { hojeComoData, type Periodo } from "@/lib/inbox/periodo";

export { INBOX_TABS, visibleInboxTabs, type InboxTab } from "@/lib/inbox/abas";

/**
 * A aba e os filtros ligados. Os filtros (`FiltrosDeTela`) estão documentados
 * campo a campo em `lib/inbox/filtros-de-tela.ts`, junto da tabela que diz em
 * que aba cada um vale.
 */
export type InboxFiltersValue = FiltrosDeTela & { tab: InboxTab };

/** "Os times de quem está olhando, mais a fila geral." */
export const FILA_MEUS_TIMES = "mine";
/** "Só o que ninguém encaminhou para setor nenhum." */
export const FILA_GERAL = "none";

/** O nome de cada meio, na ordem em que o seletor de caixa os mostra. */
const NOME_DO_MEIO: Record<MeioDeCanal, string> = {
  whatsapp: "WhatsApp",
  phone: "Telefone",
  site_chat: "Chat do site",
};
const ORDEM_DOS_MEIOS: MeioDeCanal[] = ["whatsapp", "phone", "site_chat"];

/**
 * O valor do seletor de caixa de entrada: um seletor só para duas perguntas —
 * o MEIO inteiro ("WhatsApp") ou UM número. O prefixo diz qual.
 */
const CAIXA_MEIO = "meio:";
const CAIXA_NUMERO = "numero:";

const PERIODOS_DO_SELETOR: Array<[Periodo, string]> = [
  ["hoje", "Hoje"],
  ["ontem", "Ontem"],
  ["7d", "Últimos 7 dias"],
  ["30d", "Últimos 30 dias"],
];
const PERIODO_POR_DATAS = "datas";

const SELETOR =
  "h-8 rounded-full border-transparent bg-surface-elevated px-3 text-xs shadow-none";
const SELETOR_LIGADO = "border-accent bg-accent-soft text-accent";

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
  /**
   * Os seletores (time, atendente, caixa, etiqueta, período, assunto) ficam
   * RECOLHIDOS — abrem no funil,
   * filtra-se, e fecham de novo, para a coluna ser de conversas e não de
   * controles. Controlado pelo pai quando ele quer fechá-los por conta própria
   * (o inbox fecha ao abrir uma conversa); sem as duas props, o componente
   * cuida do próprio estado.
   */
  aberto?: boolean;
  onAbertoChange?: (aberto: boolean) => void;
  /**
   * Atendentes, caixas de entrada e assuntos — o que os seletores novos listam
   * (`GET /api/v1/conversations/filtros`). Vêm por prop, de quem é dono do
   * "aberto" (`useOpcoesDosFiltros`, no `InboxLayout`): a leitura só acontece com
   * o funil aberto.
   *
   * `undefined` = ainda não chegou (ou o funil nunca abriu). Os seletores que
   * não dependem dela (atendente com "Eu" e "Sem atendente", período) funcionam
   * assim mesmo; os que dependem aparecem quando ela chega.
   */
  opcoes?: OpcoesDosFiltros;
  /**
   * A leitura das opções FALHOU. Sem isto, "ainda não chegou" e "não vai chegar"
   * eram o mesmo estado: os seletores de caixa e de assunto não apareciam, e um
   * filtro ligado ficava escrito "Carregando…" para sempre, sem nada dizendo o
   * que houve nem como tentar de novo.
   */
  opcoesComErro?: boolean;
  onRecarregarOpcoes?: () => void;
}

/**
 * Um campo de data com o valor GUARDADO AQUI enquanto a pessoa digita.
 *
 * O valor de verdade mora no endereço da página, e o endereço chega de volta à
 * tela por uma transição do React (é assim que o Next aplica o `replaceState`).
 * Um `<input type="date">` controlado direto por ele receberia o valor ANTIGO
 * logo depois de cada tecla, e o navegador zera o trecho da data que estava
 * sendo digitado. O campo mostra o que foi digitado na hora; quando o valor de
 * fora muda (outra ponta puxou esta, "Limpar filtros"), ele adota.
 */
function CampoDeData({
  valor,
  onMudar,
  rotulo,
  min,
  max,
}: {
  valor: string;
  onMudar: (data: string) => void;
  rotulo: string;
  min?: string;
  max?: string;
}) {
  const [local, setLocal] = useState(valor);
  useEffect(() => setLocal(valor), [valor]);
  return (
    <Input
      type="date"
      value={local}
      min={min}
      max={max}
      onChange={(e) => {
        setLocal(e.target.value);
        // Campo apagado (ou data pela metade) não vira filtro: metade de um
        // período não recorta nada.
        if (e.target.value) onMudar(e.target.value);
      }}
      aria-label={rotulo}
      className="h-8 min-w-0 flex-1 rounded-full border-transparent bg-surface-elevated px-3 text-xs shadow-none"
    />
  );
}

export function InboxFilters({
  value,
  onChange,
  aberto,
  onAbertoChange,
  opcoes,
  opcoesComErro = false,
  onRecarregarOpcoes,
}: Props) {
  const t = useT();
  const [abertoLocal, setAbertoLocal] = useState(false);
  const filtrosAbertos = aberto ?? abertoLocal;
  const alternarFiltros = () => {
    const proximo = !filtrosAbertos;
    setAbertoLocal(proximo);
    onAbertoChange?.(proximo);
  };
  // QUANTOS FILTROS DO FUNIL ESTÃO VALENDO NESTA ABA. É o que impede o
  // recolhimento de virar mentira de tela: com os seletores fechados, um filtro
  // ativo seria invisível — a lista encolheria sem nada dizendo por quê. O
  // número no funil diz, e o funil muda de cor. Sai da MESMA régua que monta a
  // consulta (`filtrosAplicados`): filtro que não vale nesta aba não é contado,
  // porque também não é aplicado.
  const filtrosAtivos = contarFiltrosDoFunil(filtrosAplicados(value.tab, value));
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
  const { activeOrg, user } = useAuth();
  const { data: tagVocabulary } = useConversationTagVocabulary(activeOrg?.orgId ?? null);
  const { data: times } = useTimesDoInbox();

  // ─── A CAIXA DE ENTRADA: o meio ("WhatsApp") ou um número ────────────────
  const caixas = opcoes?.caixas;
  const meiosPresentes = ORDEM_DOS_MEIOS.filter((meio) => caixas?.some((c) => c.meio === meio));
  // Filtrar por um número que saiu da lista (o operador acabou de excluir o
  // canal) deixa o inbox mostrando um subconjunto — às vezes vazio — sem nada na
  // tela dizendo que há filtro. O número some do seletor junto com o canal, e o
  // seletor inteiro sumiria com ele se sobrasse uma caixa só.
  const numeroForaDaLista =
    value.channel_session_id != null &&
    caixas != null &&
    !caixas.some((c) => c.id === value.channel_session_id);
  const filtroDeCaixa = value.channel != null || value.channel_session_id != null;
  // Só aparece quando há o que escolher (mais de um meio, ou mais de um número)
  // — ou quando há um filtro de caixa valendo, que precisa de onde ser tirado.
  const mostrarSeletorDeCaixa =
    valeNaAba("caixa", value.tab) &&
    (filtroDeCaixa || meiosPresentes.length >= 2 || (caixas?.length ?? 0) >= 2);
  const valorDaCaixa = value.channel
    ? `${CAIXA_MEIO}${value.channel}`
    : value.channel_session_id
      ? `${CAIXA_NUMERO}${value.channel_session_id}`
      : "all";
  const escolherCaixa = (v: string) => {
    // Escolher um apaga o outro: são duas formas da mesma pergunta.
    if (v.startsWith(CAIXA_MEIO)) {
      const meio = v.slice(CAIXA_MEIO.length);
      if ((MEIOS_DE_CANAL as readonly string[]).includes(meio)) {
        onChange({ ...value, channel: meio as MeioDeCanal, channel_session_id: undefined });
      }
      return;
    }
    onChange({
      ...value,
      channel: undefined,
      channel_session_id: v.startsWith(CAIXA_NUMERO) ? v.slice(CAIXA_NUMERO.length) : undefined,
    });
  };
  // O meio escolhido entra na lista mesmo sem número nenhum dele hoje: é a única
  // forma de alcançar a conversa de um número que já foi removido.
  const meiosDoSeletor = ORDEM_DOS_MEIOS.filter(
    (meio) => meiosPresentes.includes(meio) || value.channel === meio,
  );
  // O número escolhido cujo meio tem UM número só: a linha dele não é desenhada
  // dentro do grupo (meio e número seriam a mesma lista), e sem uma linha para o
  // valor o seletor mostraria "todas" com o filtro aplicado.
  const numeroSozinhoNoMeio = (caixas ?? []).find(
    (c) =>
      c.id === value.channel_session_id &&
      (caixas ?? []).filter((outra) => outra.meio === c.meio).length < 2,
  );

  // ─── O ATENDENTE ─────────────────────────────────────────────────────────
  const mostrarSeletorDeAtendente = valeNaAba("assigned_to", value.tab);
  // O observador não atende: para ele não existe "Eu".
  const podeSerEu = activeOrg?.role !== "viewer";
  // Quem está olhando sai da lista de nomes quando há "Eu": seriam duas linhas
  // para o mesmo filtro.
  const colegas = (opcoes?.atendentes ?? []).filter((a) => !(podeSerEu && a.user_id === user?.id));
  // O PRÓPRIO id é "eu": é o que chega quando a gestora escolhe a pessoa pelo
  // nome e manda o link para ela. Sem isto ela veria "outro atendente" — o id
  // dela não está em `colegas` — com a própria lista embaixo.
  const souEu =
    value.assigned_to === "me" || (podeSerEu && user?.id != null && value.assigned_to === user.id);
  const valorDoAtendente = souEu ? "me" : (value.assigned_to ?? "all");
  const atendentePorId =
    value.assigned_to != null && !souEu && value.assigned_to !== "unassigned";
  const atendenteForaDaLista =
    atendentePorId && !colegas.some((a) => a.user_id === value.assigned_to);
  /**
   * O que escrever numa linha cujo nome a tela não sabe.
   *
   * Três estados, e confundi-los é mentir: ainda carregando; a leitura falhou;
   * ou chegou e o valor não está nela. No último caso a tela NÃO sabe por quê —
   * a pessoa pode ter saído, ser observadora, ou quem olha pode simplesmente
   * não ver nomes de colegas (a rota devolve a lista vazia). Por isso "outro",
   * e não "removido".
   */
  const semNome = (quandoChegou: string) =>
    opcoes != null ? quandoChegou : opcoesComErro ? "Não foi possível carregar" : "Carregando…";

  // ─── PERÍODO e ASSUNTO: só a aba Fechadas ────────────────────────────────
  const mostrarSeletorDePeriodo = valeNaAba("periodo", value.tab);
  const porDatas = value.periodo == null && value.de != null && value.ate != null;
  const valorDoPeriodo = value.periodo ?? (porDatas ? PERIODO_POR_DATAS : "all");
  const escolherPeriodo = (v: string) => {
    if (v === PERIODO_POR_DATAS) {
      // Nasce com HOJE nos dois campos: não existe estado intermediário com uma
      // data só — metade de um período não recorta nada, e o seletor mostraria
      // "Escolher datas…" com a lista inteira embaixo.
      const hoje = hojeComoData();
      onChange({ ...value, periodo: undefined, de: hoje, ate: hoje });
      return;
    }
    onChange({
      ...value,
      periodo: v === "all" ? undefined : (v as Periodo),
      de: undefined,
      ate: undefined,
    });
  };
  // Mexer numa ponta para além da outra PUXA a outra junto, em vez de produzir
  // um intervalo ao contrário (que não recortaria nada).
  const mudarDe = (de: string) => {
    if (!value.ate) return;
    onChange({ ...value, de, ate: de > value.ate ? de : value.ate });
  };
  const mudarAte = (ate: string) => {
    if (!value.de) return;
    onChange({ ...value, ate, de: ate < value.de ? ate : value.de });
  };

  const assuntos = opcoes?.assuntos;
  const assuntoForaDaLista =
    value.assunto_id != null &&
    assuntos != null &&
    !assuntos.some((time) => time.assuntos.some((a) => a.id === value.assunto_id));
  // Organização que não cadastrou assunto nenhum não ganha um seletor que leva a
  // uma lista vazia — a mesma decisão do seletor de time.
  const mostrarSeletorDeAssunto =
    valeNaAba("assunto_id", value.tab) && ((assuntos?.length ?? 0) > 0 || value.assunto_id != null);

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
        {!mostrarSeletorDeTime &&
          !mostrarSeletorDeAtendente &&
          !mostrarSeletorDeCaixa &&
          !mostrarSeletorDeTag &&
          !mostrarSeletorDePeriodo &&
          !mostrarSeletorDeAssunto && (
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

        {/* A leitura das opções falhou: dizer, e oferecer tentar de novo. Os
            seletores que não dependem dela (atendente, período) seguem abaixo. */}
        {opcoesComErro && opcoes == null && (
          <p className="flex items-center justify-between gap-2 px-1 text-xs text-text-muted" data-testid="opcoes-dos-filtros-falharam">
            <span>{t("Não foi possível carregar as opções dos filtros.")}</span>
            {onRecarregarOpcoes && (
              <button
                type="button"
                className="shrink-0 font-medium text-accent underline-offset-2 hover:underline"
                onClick={onRecarregarOpcoes}
              >
                {t("Tentar novamente")}
              </button>
            )}
          </p>
        )}

        {/* O ATENDENTE, em linha própria: responde "de quem é", como o time
            responde "de que setor é". Só em Todas e Fechadas — Minhas já é "eu",
            e Fila e Automático não têm atendente. Em Fechadas ele é quem estava
            com a conversa NO ENCERRAMENTO. */}
        {mostrarSeletorDeAtendente && (
          <Select
            value={valorDoAtendente}
            onValueChange={(v) => onChange({ ...value, assigned_to: v === "all" ? undefined : v })}
          >
            <SelectTrigger
              className={cn(SELETOR, "w-full", value.assigned_to != null && SELETOR_LIGADO)}
              aria-label={t("Filtrar por atendente")}
              data-testid="filtro-de-atendente"
            >
              <SelectValue placeholder={t("Todos os atendentes")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("Todos os atendentes")}</SelectItem>
              {/* "Eu" também para o observador que chegou por um link com
                  `assigned_to=me`: sem a linha, o filtro valeria com o seletor em
                  branco. (Ele não atende, então a lista dele vem vazia — e o
                  vazio cita "Atendente", com o "Limpar filtros" ao lado.) */}
              {(podeSerEu || value.assigned_to === "me") && <SelectItem value="me">{t("Eu")}</SelectItem>}
              <SelectItem value="unassigned">{t("Sem atendente")}</SelectItem>
              {/* A órfã entra na lista pelo mesmo motivo do time, da caixa e da
                  etiqueta: sem ela o seletor mostraria o texto de "todos" com um
                  filtro AINDA aplicado. */}
              {atendenteForaDaLista && value.assigned_to != null && (
                <SelectItem value={value.assigned_to}>{t(semNome("Outro atendente"))}</SelectItem>
              )}
              {colegas.map((a) => (
                <SelectItem key={a.user_id} value={a.user_id}>
                  {a.nome ?? t("Atendente sem nome")}
                  {/* Quem saiu continua dono de histórico: fica na lista, marcado. */}
                  {!a.ativo && <span className="ml-1 text-muted-foreground">· {t("saiu")}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {(mostrarSeletorDeCaixa || mostrarSeletorDeTag) && (
          <div className="flex gap-2">
            {mostrarSeletorDeCaixa && (
              <Select value={valorDaCaixa} onValueChange={escolherCaixa}>
                <SelectTrigger
                  className={cn(SELETOR, "min-w-0 flex-1", filtroDeCaixa && SELETOR_LIGADO)}
                  aria-label={t("Filtrar por caixa de entrada")}
                  data-testid="filtro-de-caixa"
                >
                  <SelectValue placeholder={t("Todas as caixas")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("Todas as caixas")}</SelectItem>
                  {value.channel_session_id != null && (numeroForaDaLista || caixas == null) && (
                    <SelectItem value={`${CAIXA_NUMERO}${value.channel_session_id}`}>
                      {t(semNome("Número removido"))}
                    </SelectItem>
                  )}
                  {numeroSozinhoNoMeio && (
                    <SelectItem value={`${CAIXA_NUMERO}${numeroSozinhoNoMeio.id}`}>
                      {canalComNumero({
                        display_name: numeroSozinhoNoMeio.nome,
                        phone_number: numeroSozinhoNoMeio.numero,
                      }) ?? t(NOME_DO_MEIO[numeroSozinhoNoMeio.meio])}
                    </SelectItem>
                  )}
                  {/* A linha do MEIO existe sempre: só ela alcança a conversa de um
                      número já removido. Os números aparecem embaixo quando o meio
                      tem mais de um — com um só, o meio e o número são a mesma
                      lista, e duas linhas para ela seriam ruído. */}
                  {meiosDoSeletor.map((meio) => {
                    const numeros = (caixas ?? []).filter((c) => c.meio === meio);
                    return (
                      <SelectGroup key={meio}>
                        <SelectItem value={`${CAIXA_MEIO}${meio}`}>{t(NOME_DO_MEIO[meio])}</SelectItem>
                        {numeros.length >= 2 &&
                          numeros.map((c) => (
                            <SelectItem key={c.id} value={`${CAIXA_NUMERO}${c.id}`} className="pl-6">
                              {canalComNumero({ display_name: c.nome, phone_number: c.numero }) ??
                                t(NOME_DO_MEIO[meio])}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    );
                  })}
                </SelectContent>
              </Select>
            )}

            {mostrarSeletorDeTag && (
              <Select
                value={value.tag ?? "all"}
                onValueChange={(v) => onChange({ ...value, tag: v === "all" ? undefined : v })}
              >
                <SelectTrigger
                  className={cn(SELETOR, "min-w-0 flex-1", value.tag != null && SELETOR_LIGADO)}
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

        {/* PERÍODO e ASSUNTO: só em Fechadas. Respondem a pergunta de fim de dia
            de quem coordena — "o que foi encerrado hoje, e sobre o quê?". */}
        {(mostrarSeletorDePeriodo || mostrarSeletorDeAssunto) && (
          <div className="flex gap-2">
            {mostrarSeletorDePeriodo && (
              <Select value={valorDoPeriodo} onValueChange={escolherPeriodo}>
                <SelectTrigger
                  className={cn(SELETOR, "min-w-0 flex-1", valorDoPeriodo !== "all" && SELETOR_LIGADO)}
                  aria-label={t("Filtrar por período")}
                  data-testid="filtro-de-periodo"
                >
                  <SelectValue placeholder={t("Qualquer data")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("Qualquer data")}</SelectItem>
                  {PERIODOS_DO_SELETOR.map(([valor, nome]) => (
                    <SelectItem key={valor} value={valor}>
                      {t(nome)}
                    </SelectItem>
                  ))}
                  <SelectItem value={PERIODO_POR_DATAS}>{t("Escolher datas…")}</SelectItem>
                </SelectContent>
              </Select>
            )}

            {mostrarSeletorDeAssunto && (
              <Select
                value={value.assunto_id ?? "all"}
                onValueChange={(v) => onChange({ ...value, assunto_id: v === "all" ? undefined : v })}
              >
                <SelectTrigger
                  className={cn(SELETOR, "min-w-0 flex-1", value.assunto_id != null && SELETOR_LIGADO)}
                  aria-label={t("Filtrar por assunto")}
                  data-testid="filtro-de-assunto"
                >
                  {/* Sem assunto escolhido o gatilho diz só "Assunto": ele divide a
                      linha com o período (uns 134 px cada), e "Todos os assuntos"
                      saía cortado pela seta — medido na captura do teste de tela.
                      A lista continua oferecendo "Todos os assuntos" por extenso. */}
                  <SelectValue placeholder={t("Assunto")}>
                    {value.assunto_id == null ? t("Assunto") : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("Todos os assuntos")}</SelectItem>
                  {value.assunto_id != null && (assuntoForaDaLista || assuntos == null) && (
                    <SelectItem value={value.assunto_id}>
                      {t(semNome("Assunto removido"))}
                    </SelectItem>
                  )}
                  {/* Por time: o mesmo nome de assunto pode existir em dois setores. */}
                  {(assuntos ?? []).map((time) => (
                    <SelectGroup key={time.time_id}>
                      <SelectLabel>{time.time}</SelectLabel>
                      {time.assuntos.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.nome}
                          {/* Arquivado continua: ele nomeia atendimento antigo. */}
                          {a.arquivado && (
                            <span className="ml-1 text-muted-foreground">· {t("arquivado")}</span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        {/* As duas datas, só com "Escolher datas…". Inclusivas nas duas pontas. */}
        {mostrarSeletorDePeriodo && porDatas && (
          <div className="flex items-center gap-2" data-testid="filtro-de-datas">
            <CampoDeData valor={value.de ?? ""} max={value.ate} onMudar={mudarDe} rotulo={t("De")} />
            <span className="text-xs text-text-muted">{t("até")}</span>
            <CampoDeData valor={value.ate ?? ""} min={value.de} onMudar={mudarAte} rotulo={t("Até")} />
          </div>
        )}
        </div>
        )}
      </div>
    </div>
  );
}
