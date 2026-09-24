/**
 * GET /api/v1/conversations/counts — contagens por visão do inbox (G4-02).
 *
 * Usa o client user-scoped (cookie session) → toda contagem HERDA a RLS de
 * SELECT de `conversations` (fn_can_view_conversation, migration 0035). Um agent
 * em modo own* recebe a contagem do SEU escopo, NUNCA o total da org — a mesma
 * garantia do listing. Head count (count:'exact', head:true) não devolve linhas.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { CONVERSATION_TERMINAL_STATUSES, filtroDeTimeSchema, listConversationsQuerySchema } from "@/lib/schemas";
import { orgTemAutomatico } from "@/lib/ai/agents/org-tem-automatico";
import { comandosDaFila } from "@/lib/inbox/comando-da-conversa";
import { createClient } from "@/lib/supabase/server";

import { aplicarPredicadoDeTime, predicadoDeTime, type ConsultaFiltravel } from "../_filtro-de-time";
import { filtroDaBuscaDeConversas } from "../_handler";
import { aplicarNaFilaDoTime } from "../_na-fila";
import { predicadoDaBuscaDosFechados } from "@/app/api/v1/atendimentos/_handler";

export const dynamic = "force-dynamic";

/** Um par pronto para virar predicado: coluna e valor. */
export type FiltroDeContagem = readonly [coluna: string, valor: string | boolean];

/**
 * Os filtros AUXILIARES que a lista aplicou e que a contagem tem de aplicar junto.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 * Medido na tela: com "Não lidos" ligado, a lista mostrava ZERO linhas e a aba
 * continuava estampando "Todas 2". Este próprio arquivo já declarava a regra —
 * "um badge que conta o que a aba não mostra manda o atendente procurar trabalho
 * que não existe" — e a regra estava certa: a COBERTURA parou no predicado da
 * aba e nunca alcançou os filtros ao lado dela.
 *
 * ─── Por que uma lista só, e não um `if` por contagem ──────────────────────
 * Uma lista aplicada a TODAS as contagens torna a divergência impossível por
 * construção: não existe o caminho "esqueci de pôr o filtro na contagem X".
 * `tests/unit/badge-espelha-o-filtro.test.ts` vigia que nenhuma contagem seja
 * montada por fora.
 *
 * A busca não é um par coluna/valor: a mesma fábrica de predicado da lista
 * resolve contato, protocolo e prévia antes de montar estas contagens.
 *
 * O TIME também não entra aqui, e pela razão OPOSTA: ele não é igualdade (`none`
 * é `is null` e `mine` é uma lista que sai do banco), então não cabe num par
 * coluna/valor. Ele é aplicado dentro da mesma fábrica, logo abaixo, pela régua
 * ÚNICA de `_filtro-de-time.ts` — a mesma que a lista usa. O que não pode
 * acontecer é ele ficar de fora da contagem: a lista filtrada por setor com o
 * badge contando a organização inteira é o defeito do `unread` de novo.
 */
export function filtrosAuxiliaresDaContagem(
  sp: URLSearchParams,
): FiltroDeContagem[] {
  const filtros: FiltroDeContagem[] = [];
  const canal = sp.get("channel_session_id");
  if (canal) filtros.push(["channel_session_id", canal]);
  const tag = sp.get("tag");
  if (tag) filtros.push(["tag", tag]);
  return filtros;
}

/** Verdadeiro quando a contagem deve pedir só as não lidas. */
export function contagemSoNaoLidas(sp: URLSearchParams): boolean {
  return sp.get("unread") === "true";
}

/** Uma contagem que ainda aceita o predicado de time — e que, aguardada, diz quanto e se falhou. */
type ContagemFiltravel = ConsultaFiltravel &
  PromiseLike<{ count: number | null; error: { message: string } | null }>;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail(
      "no_active_org",
      traduzir("No active organization.", authUser?.idioma ?? "pt-BR"),
      403,
      { requestId },
    );
  }

  const org = activeOrg.orgId;
  const sp = req.nextUrl.searchParams;
  const porTime = z.enum(["true"]).optional().safeParse(sp.get("by_team") ?? undefined);
  if (!porTime.success) {
    return fail("validation_failed", traduzir("Query inválida.", authUser?.idioma ?? "pt-BR"), 422, {
      requestId,
    });
  }
  const incluirPorTime = porTime.data === "true";
  const auxiliares = filtrosAuxiliaresDaContagem(sp);
  const soNaoLidas = contagemSoNaoLidas(sp);
  // A MESMA régua da lista, e não um `get` cru: sem ela, o badge aceitaria um
  // `team_id` que a lista recusa — e um valor fora de forma chegaria ao Postgres
  // como `22P02`, virando 500 numa contagem.
  const filtroDeTime = filtroDeTimeSchema.safeParse(sp.get("team_id") ?? undefined);
  if (!filtroDeTime.success) {
    return fail("validation_failed", traduzir("Query inválida.", authUser?.idioma ?? "pt-BR"), 422, {
      requestId,
    });
  }
  const termo = listConversationsQuerySchema.pick({ search: true }).safeParse({
    search: sp.get("search") ?? undefined,
  });
  if (!termo.success) {
    return fail("validation_failed", traduzir("Query inválida.", authUser?.idioma ?? "pt-BR"), 422, {
      requestId,
    });
  }
  const busca = termo.data.search
    ? await filtroDaBuscaDeConversas(supabase, org, termo.data.search)
    : null;
  const buscaDosFechados = termo.data.search
    ? await predicadoDaBuscaDosFechados(supabase, org, termo.data.search)
    : undefined;
  // Resolvido ANTES da fábrica porque `mine` custa uma leitura: dentro dela,
  // seriam cinco idas ao banco para responder sempre a mesma coisa.
  const time = await predicadoDeTime(supabase, org, user.id, filtroDeTime.data);

  // ⚠️ TODA contagem nasce daqui, e daqui já sai com `organization_id` E com os
  // filtros auxiliares. Herdar tira a opção de esquecer: não existe o caminho
  // "montei uma contagem e não pus o filtro".
  // `comTime=false` só para os CHIPS de Todas (`by_team`): cada chip é um time, e
  // aplicar o time escolhido a todos eles zeraria os outros — clicar em
  // "Suporte" apagaria os números de "Vendas", que é justamente o que o chip
  // existe para mostrar. Todo o resto (número, etiqueta, não lidas, busca, fila)
  // continua herdado.
  const agora = new Date();
  // "Só na fila" é um chip de TODAS: vale para o número de Todas e para os
  // chips de time, e para mais nenhum. Aplicado na fábrica, zerava o badge de
  // Minhas (fila de time é conversa SEM dono) e encolhia os das outras abas,
  // cujas listas ignoram o filtro — badge contando o que a aba não mostra.
  const soNaFila = sp.get("na_fila") === "true";
  const daTodas = <Q extends Parameters<typeof aplicarNaFilaDoTime>[0]>(q: Q): Q =>
    soNaFila ? aplicarNaFilaDoTime(q, agora) : q;
  const countExact = (comTime = true) => {
    let q = supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org);
    // A etiqueta NÃO é igualdade: `conversations.tags` é array, e a lista a filtra
    // com `contains` (`_handler.ts`). Aqui ela saía como `.eq("tag", …)` — coluna
    // que não existe —, e com uma etiqueta escolhida a rota inteira respondia
    // erro: os números sumiam de TODAS as abas justo quando havia filtro ligado.
    for (const [coluna, valor] of auxiliares) {
      q = coluna === "tag" ? q.contains("tags", [String(valor)]) : q.eq(coluna, valor);
    }
    if (soNaoLidas) q = q.gt("unread_count_for_assignee", 0);
    if (busca) {
      q = busca.tipo === "or"
        ? q.or(busca.valor)
        : q.ilike("last_message_preview", busca.valor);
    }
    return comTime ? aplicarPredicadoDeTime(q, time) : q;
  };

  // A aba FECHADAS conta ATENDIMENTOS, não conversas (ver `atendimentos/_handler.ts`):
  // a conversa é uma por cliente e canal, e reabre quando ele volta — contar
  // conversas fechadas deixava de fora todo atendimento encerrado de quem voltou.
  // Fábrica própria porque a tabela é outra; a RÉGUA é a mesma, herdada inteira:
  // organização, número, etiqueta, não lidas (os três moram na conversa, por isso
  // o `!inner`), busca e o time — que aqui é o do FECHAMENTO, igual à lista da aba.
  const countAtendimentosFechados = () => {
    let q = supabase
      .from("atendimentos")
      .select("id, conversations!inner(id)", { count: "exact", head: true })
      .eq("organization_id", org)
      .not("closed_at", "is", null);
    for (const [coluna, valor] of auxiliares) {
      q =
        coluna === "tag"
          ? q.contains("conversations.tags", [String(valor)])
          : q.eq(`conversations.${coluna}`, valor);
    }
    if (soNaoLidas) q = q.gt("conversations.unread_count_for_assignee", 0);
    if (buscaDosFechados) q = q.or(buscaDosFechados);
    // O cast poupa o compilador de uma conta que ele não termina: o builder
    // tipado por um `select` COM EMBED, entregue a um genérico, estoura a
    // profundidade de instanciação (TS2589) — e só o `next build` acusa, porque
    // o `tsconfig` do typecheck não segue o mesmo caminho. O que se preserva é o
    // que a rota lê: `count` e `error`.
    return aplicarPredicadoDeTime(q as unknown as ContagemFiltravel, time);
  };

  // Espelha tabToFilter (InboxLayout): unassigned = fila aberta sem dono;
  // mine = atribuídas a mim e ainda ABERTAS; all = todas ABERTAS no escopo RLS.
  //
  // O `not in (terminais)` de mine/all espelha o `exclude_finished` das abas, e o
  // espelhamento é o ponto: um badge que conta o que a aba não mostra é pior
  // que badge nenhum — manda o atendente procurar um trabalho que não existe.
  // O fato ORG-WIDE resolvido ANTES das contagens, porque ele escolhe QUAL
  // conjunto de comandos a Fila pede. `undefined` (não deu para saber) segue a
  // convenção da regra: assume que há automático.
  const automaticoDaOrg = await orgTemAutomatico(supabase, org);

  let times: Array<{ id: string; name: string }> = [];
  if (incluirPorTime) {
    const { data, error } = await supabase
      .from("attendance_teams")
      .select("id, name")
      .eq("organization_id", org)
      .order("name");
    if (error) return fail("internal_error", error.message, 500, { requestId });
    times = data ?? [];
  }

  const [fila, automatico, mine, all, closed, ...grupos] = await Promise.all([
    // A FILA DEIXOU DE SER "sem dono + status de espera".
    //
    // Aquele par contava como trabalho humano pendente tudo que o robô estava
    // atendendo: medido na VPS em 2026-08-30, o badge dizia 83 enquanto 47
    // daquelas conversas tinham o automático no comando. Agora ele conta o mesmo
    // predicado que a aba pede — e o espelhamento entre badge e aba é vigiado
    // por `tests/e2e/inbox-abas-espelham-o-comando.spec.ts`,
    // `tests/unit/fila-tem-uma-definicao-so.test.ts` e
    // `tests/invariants/gov-5b-inbox-scope-counts.test.ts`, porque um badge que conta o
    // que a aba não mostra manda o atendente procurar trabalho que não existe.
    countExact().in("comando_da_conversa", comandosDaFila(automaticoDaOrg)),
    // A aba "Automático". Antes ela pedia `status='ai_handling'`, escrito por UM
    // caminho só em produção — por isso vivia quase vazia.
    countExact().eq("comando_da_conversa", "automatico"),
    countExact()
      .eq("assigned_to_user_id", user.id)
      .not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`),
    daTodas(countExact().not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`)),
    // A aba "Fechadas" existia SEM número nenhum. Num inbox antigo, é o número
    // que diz o tamanho do arquivo — e a sua ausência fazia a aba parecer um
    // lugar vazio. Mesma fábrica: herda organização e filtros.
    // Busca sem protocolo/contato casado tem resposta vazia na lista; não há
    // predicado `or=()` válido, então a contagem é zero sem consultar a tabela.
    buscaDosFechados === null
      ? Promise.resolve({ count: 0, error: null })
      : countAtendimentosFechados(),
    ...times.map((time) =>
      daTodas(countExact(false)
        .not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`)
        .eq("team_id", time.id)),
    ),
    ...(incluirPorTime ? [daTodas(countExact(false)
      .not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`)
      .is("team_id", null))] : []),
    // Quantos de cada time estão NA FILA (ninguém pegou) — o selo vermelho do
    // chip. Mesma régua da lista (`_na-fila.ts`).
    ...times.map((time) => aplicarNaFilaDoTime(countExact(false).eq("team_id", time.id), agora)),
  ]);

  const firstErr =
    fila.error ?? automatico.error ?? mine.error ?? all.error ?? closed.error ??
    grupos.find((grupo) => grupo.error)?.error;
  if (firstErr) {
    return fail("internal_error", firstErr.message, 500, { requestId });
  }

  return ok(
    {
      fila: fila.count ?? 0,
      automatico: automatico.count ?? 0,
      // `unassigned` continua respondendo, com o MESMO valor de `fila`. É rota
      // `/api/v1/` versionada: campo não some de uma versão para outra, e um
      // cliente com a página aberta desde antes do deploy segue lendo o nome
      // velho até recarregar.
      unassigned: fila.count ?? 0,
      mine: mine.count ?? 0,
      all: all.count ?? 0,
      closed: closed.count ?? 0,
      ...(incluirPorTime ? { by_team: [
        ...times.map((time, index) => ({
          team_id: time.id,
          name: time.name,
          count: grupos[index]?.count ?? 0,
          na_fila: grupos[times.length + 1 + index]?.count ?? 0,
        })),
        // "Sem time" não tem fila de time, por definição.
        { team_id: null, name: null, count: grupos[times.length]?.count ?? 0, na_fila: 0 },
      ] } : {}),
    },
    { requestId },
  );
}
