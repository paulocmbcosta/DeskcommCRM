/**
 * OS FILTROS DO INBOX NO ENDEREÇO DA PÁGINA — ler e escrever.
 *
 * Até aqui só a aba ia para o endereço (`?filter=`); o resto era estado local e
 * se perdia ao recarregar. Com os filtros no endereço, recarregar devolve a
 * mesma lista e dá para mandar a um colega o link de uma lista já filtrada
 * ("Fechadas da Maria, hoje").
 *
 * Os nomes dos parâmetros são os MESMOS da API (`assigned_to`, `channel`,
 * `team_id`…), para existir um vocabulário só. O período é a exceção: no
 * endereço mora a ESCOLHA (`periodo=hoje`, ou `de`/`ate`), e não os instantes —
 * um link com "hoje" tem de continuar significando hoje amanhã.
 *
 * ⚠️ A BUSCA NÃO VAI PARA O ENDEREÇO. O termo é nome ou telefone de cliente:
 * no endereço ele ficaria no histórico do navegador e em registro de acesso.
 */
import { z } from "zod";

import { MEIOS_DE_CANAL, type MeioDeCanal } from "@/lib/channels/capabilities";
import type { InboxTab } from "@/lib/inbox/abas";
import type { FiltrosDeTela } from "@/lib/inbox/filtros-de-tela";
import { dataValida, PERIODOS, type Periodo } from "@/lib/inbox/periodo";

/** Tudo menos a busca. */
export type FiltrosNaUrl = Omit<FiltrosDeTela, "search">;

/** Os parâmetros que ESTE módulo escreve e apaga. `filter` e `id` não são dele. */
export const PARAMETROS_DE_FILTRO = [
  "unread",
  "team_id",
  "tag",
  "channel",
  "channel_session_id",
  "assigned_to",
  "periodo",
  "de",
  "ate",
  "assunto_id",
  "na_fila",
  "ordem",
  "insatisfeitos",
] as const;

/** O teto de `conversationTagSchema` (`lib/schemas/messaging.ts`). */
const TETO_DA_ETIQUETA = 40;

// A MESMA régua do servidor (`z.string().uuid()`): um id que a tela aceita nunca
// vira 422 na rota.
const ehUuid = (valor: string) => z.string().uuid().safeParse(valor).success;
const ligado = (valor: string | null) => valor === "1" || valor === "true";

/**
 * Lê os filtros do endereço.
 *
 * Valor fora de forma é DESCARTADO em silêncio: um link velho, cortado ou
 * editado à mão abre a lista sem aquele filtro, em vez de um erro na cara de
 * quem só clicou num link. (Descartar aqui é seguro porque o que sobra é o
 * endereço que a tela vai reescrever no próximo gesto.)
 */
export function lerFiltrosDaUrl(sp: Pick<URLSearchParams, "get">): FiltrosNaUrl {
  const filtros: FiltrosNaUrl = { onlyUnread: ligado(sp.get("unread")) };

  const time = sp.get("team_id");
  if (time && (time === "mine" || time === "none" || ehUuid(time))) filtros.team_id = time;

  const etiqueta = sp.get("tag")?.trim().toLowerCase();
  if (etiqueta && etiqueta.length <= TETO_DA_ETIQUETA) filtros.tag = etiqueta;

  const meio = sp.get("channel");
  if (meio && (MEIOS_DE_CANAL as readonly string[]).includes(meio)) {
    filtros.channel = meio as MeioDeCanal;
  }

  const numero = sp.get("channel_session_id");
  if (numero && ehUuid(numero)) filtros.channel_session_id = numero;

  const atendente = sp.get("assigned_to");
  if (atendente && (atendente === "me" || atendente === "unassigned" || ehUuid(atendente))) {
    filtros.assigned_to = atendente;
  }

  // A escolha pronta vence as datas: os dois juntos só existem num link editado
  // à mão, e "hoje" é a leitura menos surpreendente.
  const periodo = sp.get("periodo");
  if (periodo && (PERIODOS as readonly string[]).includes(periodo)) {
    filtros.periodo = periodo as Periodo;
  } else {
    const de = sp.get("de");
    const ate = sp.get("ate");
    // Só valem juntas e em ordem: metade de um período não é um período.
    if (de && ate && dataValida(de) && dataValida(ate) && de <= ate) {
      filtros.de = de;
      filtros.ate = ate;
    }
  }

  const assunto = sp.get("assunto_id");
  if (assunto && ehUuid(assunto)) filtros.assunto_id = assunto;

  if (ligado(sp.get("na_fila"))) filtros.na_fila = true;
  if (sp.get("ordem") === "espera") filtros.ordem = "espera";
  if (ligado(sp.get("insatisfeitos"))) filtros.insatisfeitos = true;
  return filtros;
}

/**
 * Devolve o endereço com a aba e os filtros dados.
 *
 * Parte de `atual` e só mexe no que é DELE: `id` (a conversa aberta) e qualquer
 * parâmetro que este módulo não conhece atravessam intactos. Apaga primeiro e
 * escreve depois — é o que faz "Limpar filtros" funcionar sem enumerar filtro:
 * o que não veio em `filtros` some do endereço.
 */
export function escreverFiltrosNaUrl(
  atual: URLSearchParams,
  tab: InboxTab,
  filtros: FiltrosNaUrl,
): URLSearchParams {
  const proximo = new URLSearchParams(atual);
  for (const chave of PARAMETROS_DE_FILTRO) proximo.delete(chave);
  proximo.set("filter", tab);
  if (filtros.onlyUnread) proximo.set("unread", "1");
  if (filtros.team_id) proximo.set("team_id", filtros.team_id);
  if (filtros.tag) proximo.set("tag", filtros.tag);
  if (filtros.channel) proximo.set("channel", filtros.channel);
  if (filtros.channel_session_id) proximo.set("channel_session_id", filtros.channel_session_id);
  if (filtros.assigned_to) proximo.set("assigned_to", filtros.assigned_to);
  if (filtros.periodo) {
    proximo.set("periodo", filtros.periodo);
  } else if (filtros.de && filtros.ate) {
    proximo.set("de", filtros.de);
    proximo.set("ate", filtros.ate);
  }
  if (filtros.assunto_id) proximo.set("assunto_id", filtros.assunto_id);
  if (filtros.na_fila) proximo.set("na_fila", "1");
  if (filtros.ordem) proximo.set("ordem", filtros.ordem);
  if (filtros.insatisfeitos) proximo.set("insatisfeitos", "1");
  return proximo;
}
