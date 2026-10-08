/**
 * OS FILTROS DO INBOX, NUMA RÉGUA SÓ — em que aba cada um vale, o que vai para
 * cada rota, quantos o funil conta e que nomes o vazio cita.
 *
 * Eram quatro respostas escritas em quatro lugares:
 *   · `InboxLayout` decidia o que ia para a API, com um `if` por filtro;
 *   · `InboxFilters` decidia que controle mostrar;
 *   · `contarFiltrosAuxiliares` contava time, número e etiqueta para o funil;
 *   · `filtrosAuxiliaresAtivos` nomeava não lidos, busca, etiqueta, canal, fila
 *     e insatisfeitos para o vazio — e NÃO o time.
 * As duas últimas já discordavam: com só o time ligado e nenhum resultado, a
 * tela dizia "Sem conversas por aqui", como se a caixa estivesse vazia.
 *
 * Com os filtros novos (atendente, caixa de entrada, período, assunto — desenho
 * de 2026-10-08) seriam nove filtros em quatro listas. Aqui há uma tabela,
 * `ONDE_VALE`, e todo o resto deriva dela.
 *
 * Módulo puro: sem React, sem rede. O lado do servidor desta mesma tabela é
 * `app/api/v1/conversations/counts/route.ts` (a que contagem cada filtro chega).
 */
import type { MeioDeCanal } from "@/lib/channels/capabilities";
import type { InboxTab } from "@/lib/inbox/abas";
import { resolverPeriodo, type Periodo } from "@/lib/inbox/periodo";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";

/**
 * O que a pessoa ligou na tela. Tudo menos `search` mora no ENDEREÇO da página
 * (`lib/inbox/filtros-na-url.ts`): recarregar não perde o filtro, e o link de
 * uma lista filtrada abre a mesma lista.
 */
export interface FiltrosDeTela {
  search: string;
  onlyUnread: boolean;
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
  tag?: string;
  /** A caixa de entrada pelo MEIO (só WhatsApp, só telefone, só chat do site)… */
  channel?: MeioDeCanal;
  /** …ou por UM número. Escolher um apaga o outro. */
  channel_session_id?: string;
  /** O atendente: `me`, `unassigned` ou o id de um usuário. */
  assigned_to?: string;
  /** O período do encerramento, por uma escolha pronta… */
  periodo?: Periodo;
  /** …ou por duas datas `AAAA-MM-DD`, inclusivas. Só valem juntas. */
  de?: string;
  ate?: string;
  assunto_id?: string;
  /** Só a fila dos times — foi para um setor e ninguém pegou (chip de Todas). */
  na_fila?: boolean;
  /** `espera` = quem está há mais tempo sem resposta primeiro. */
  ordem?: "espera";
  /** Só as de cliente insatisfeito ou crítico (sentimento). Todas e Minhas. */
  insatisfeitos?: boolean;
}

export type ChaveDeFiltro =
  | "unread"
  | "search"
  | "team_id"
  | "tag"
  | "caixa"
  | "assigned_to"
  | "periodo"
  | "assunto_id"
  | "na_fila"
  | "insatisfeitos"
  | "ordem";

/** As abas que listam CONVERSA ou ATENDIMENTO. A de telefone lista ligações e tem filtros próprios. */
const DE_CONVERSA: readonly InboxTab[] = ["unassigned", "mine", "all", "ai", "closed"];

/**
 * EM QUE ABA CADA FILTRO VALE — a tabela do desenho (§4.1), e a única.
 *
 * Filtro ligado em aba onde não vale continua no endereço, não é aplicado nem
 * contado ali, e volta a valer quando a pessoa volta para a aba dele. É a regra
 * que `na_fila` já seguia: um filtro aplicado numa aba que não mostra o controle
 * que o desliga é uma lista menor sem explicação.
 *
 * O ATENDENTE não vale em Minhas (a aba já é "eu") nem em Fila e Automático:
 * conversa com dono tem comando `humano`, e essas duas abas pedem os comandos
 * que só existem SEM dono (`lib/inbox/comando-da-conversa.ts`). Aplicado ali, o
 * filtro só poderia esvaziar a lista.
 *
 * PERÍODO e ASSUNTO são do atendimento encerrado: só Fechadas.
 */
export const ONDE_VALE: Record<ChaveDeFiltro, readonly InboxTab[]> = {
  unread: DE_CONVERSA,
  search: DE_CONVERSA,
  team_id: DE_CONVERSA,
  tag: DE_CONVERSA,
  caixa: DE_CONVERSA,
  assigned_to: ["all", "closed"],
  periodo: ["closed"],
  assunto_id: ["closed"],
  na_fila: ["all"],
  insatisfeitos: ["all", "mine"],
  ordem: ["all", "mine"],
};

export function valeNaAba(chave: ChaveDeFiltro, tab: InboxTab): boolean {
  return ONDE_VALE[chave].includes(tab);
}

/** Os filtros que VALEM na aba, já na forma que as rotas recebem. */
export interface FiltrosAplicados {
  search?: string;
  unread?: true;
  team_id?: string;
  tag?: string;
  channel?: MeioDeCanal;
  channel_session_id?: string;
  assigned_to?: string;
  /** O período já resolvido em instantes (`lib/inbox/periodo.ts`). */
  closed_from?: string;
  closed_to?: string;
  assunto_id?: string;
  na_fila?: true;
  ordem?: "espera";
  insatisfeitos?: true;
}

/**
 * Tira as chaves sem valor. Não é enfeite: estes objetos são ESPALHADOS por cima
 * do filtro da aba (`{ ...tabToFilter(tab), ...paraConversas(...) }`), e um
 * `assigned_to: undefined` espalhado por cima de "Minhas" apagaria o
 * `assigned_to: "me"` da aba — a lista viraria "Todas" sem erro nenhum.
 */
function semVazios<T extends object>(objeto: T): T {
  return Object.fromEntries(Object.entries(objeto).filter(([, valor]) => valor !== undefined)) as T;
}

export function filtrosAplicados(
  tab: InboxTab,
  tela: FiltrosDeTela,
  agora: Date = new Date(),
): FiltrosAplicados {
  const vale = (chave: ChaveDeFiltro) => valeNaAba(chave, tab);
  const intervalo = vale("periodo") ? resolverPeriodo(tela, agora) : {};
  return semVazios<FiltrosAplicados>({
    // A tela NÃO pede o que a rota recusa: uma letra só não é busca, e mandá-la
    // faria piscar um erro na cara de quem digita. A regra é a MESMA do schema
    // (`lib/inbox/termo-de-busca.ts`) — nunca repetida aqui.
    search: vale("search") && buscaValeConsulta(tela.search) ? tela.search : undefined,
    unread: vale("unread") && tela.onlyUnread ? true : undefined,
    team_id: vale("team_id") ? tela.team_id : undefined,
    tag: vale("tag") ? tela.tag : undefined,
    channel: vale("caixa") ? tela.channel : undefined,
    channel_session_id: vale("caixa") ? tela.channel_session_id : undefined,
    assigned_to: vale("assigned_to") ? tela.assigned_to : undefined,
    closed_from: intervalo.closed_from,
    closed_to: intervalo.closed_to,
    assunto_id: vale("assunto_id") ? tela.assunto_id : undefined,
    na_fila: vale("na_fila") && tela.na_fila ? true : undefined,
    ordem: vale("ordem") ? tela.ordem : undefined,
    insatisfeitos: vale("insatisfeitos") && tela.insatisfeitos ? true : undefined,
  });
}

/** O que vai para `GET /api/v1/conversations` — por cima do filtro da aba. */
export function paraConversas(tab: InboxTab, aplicados: FiltrosAplicados) {
  const {
    closed_from: _desde,
    closed_to: _ate,
    assunto_id: _assunto,
    assigned_to,
    ...resto
  } = aplicados;
  return semVazios({
    ...resto,
    // Em Fechadas o atendente é o do ATENDIMENTO (quem estava no encerramento),
    // e vai para a outra rota. A consulta de conversas que roda por trás da aba
    // não o recebe: ali ele seria o dono de HOJE, outra pergunta.
    assigned_to: tab === "closed" ? undefined : assigned_to,
  });
}

/** O que vai para `GET /api/v1/atendimentos?status=closed`. */
export function paraFechados(aplicados: FiltrosAplicados) {
  const { na_fila: _fila, ordem: _ordem, insatisfeitos: _insatisfeitos, ...resto } = aplicados;
  return resto;
}

/**
 * O que vai para a contagem das abas: TODOS os filtros ligados, sem olhar a aba
 * em que a pessoa está.
 *
 * O selo de uma aba diz o que a lista mostrará ao CLICAR nela. Se a tela
 * mandasse só os filtros da aba atual, o selo de Fechadas ignoraria o período
 * enquanto a pessoa estivesse em Todas — e mudaria de número no clique. Quem
 * sabe a que contagem cada filtro chega é o servidor
 * (`conversations/counts/route.ts`), pela mesma tabela de `ONDE_VALE`.
 */
export function paraContagens(tela: FiltrosDeTela, agora: Date = new Date()) {
  const intervalo = resolverPeriodo(tela, agora);
  return semVazios({
    search: buscaValeConsulta(tela.search) ? tela.search : undefined,
    unread: tela.onlyUnread || undefined,
    team_id: tela.team_id,
    tag: tela.tag,
    channel: tela.channel,
    channel_session_id: tela.channel_session_id,
    assigned_to: tela.assigned_to,
    closed_from: intervalo.closed_from,
    closed_to: intervalo.closed_to,
    assunto_id: tela.assunto_id,
    na_fila: tela.na_fila || undefined,
    insatisfeitos: tela.insatisfeitos || undefined,
  });
}

/**
 * Os filtros ligados, em palavras que o operador reconhece — para o vazio dizer
 * POR QUE a lista está vazia, em vez de fingir que a caixa está.
 *
 * Sai do MESMO objeto que foi ao servidor (`FiltrosAplicados`): a tela não tem
 * como nomear um filtro que a consulta não aplicou, nem calar um que aplicou.
 *
 * A ABA não entra: ela é a visão escolhida, já está destacada no trilho, e
 * nomeá-la aqui diria ao operador para "limpar" o lugar onde ele está. A ordem
 * ("Mais tempo esperando") também não: não esconde conversa nenhuma.
 *
 * As strings saem em português porque `t()` usa o português como chave. Elas
 * precisam existir em `lib/i18n/dicionario.ts`: o guardião do espanhol é cego a
 * `t(<variável>)` e não cobra sozinho.
 */
export function nomesDosFiltros(aplicados: FiltrosAplicados): string[] {
  const nomes: string[] = [];
  if (aplicados.unread) nomes.push("Não lidos");
  if (aplicados.search) nomes.push("Busca");
  if (aplicados.team_id) nomes.push("Time");
  if (aplicados.tag) nomes.push("Etiqueta");
  if (aplicados.channel || aplicados.channel_session_id) nomes.push("Caixa de entrada");
  if (aplicados.assigned_to) nomes.push("Atendente");
  if (aplicados.closed_from || aplicados.closed_to) nomes.push("Período");
  if (aplicados.assunto_id) nomes.push("Assunto");
  if (aplicados.na_fila) nomes.push("Só na fila");
  if (aplicados.insatisfeitos) nomes.push("Insatisfeitos");
  return nomes;
}

/**
 * Quantos dos filtros que moram DENTRO do funil estão valendo — o número no
 * funil, que é o que impede o recolhimento de virar mentira de tela: com os
 * seletores fechados, um filtro ativo seria invisível.
 *
 * Não lidos, busca, "Só na fila" e "Insatisfeitos" não contam aqui: cada um tem
 * o seu botão à vista, que já mostra se está ligado.
 */
export function contarFiltrosDoFunil(aplicados: FiltrosAplicados): number {
  return [
    aplicados.team_id,
    aplicados.tag,
    aplicados.channel ?? aplicados.channel_session_id,
    aplicados.assigned_to,
    aplicados.closed_from ?? aplicados.closed_to,
    aplicados.assunto_id,
  ].filter((valor) => valor != null).length;
}
