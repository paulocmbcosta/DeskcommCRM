/**
 * O QUE A IA LÊ AO SER DEVOLVIDA É DO ATENDIMENTO EM QUE FOI DEVOLVIDA.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A conversa é UMA por cliente e canal; o atendimento é o episódio dentro dela
 * (migration 0266). Decisão do dono do produto em 2026-09-19: quando o cliente
 * volta depois de encerrado, o atendimento novo COMEÇA DO ZERO. A tela já
 * recortava mensagens e notas internas pela janela do episódio. O resumo que o
 * agente lê em "Devolver ao automático" (`lerContinuidadeHumana`) não: filtrava
 * só por organização e conversa.
 *
 * O cliente fala com o Financeiro na segunda — a pessoa anota "enviei a 2ª via
 * do boleto" e pede o comprovante de pagamento. Encerrado. Na quarta ele volta
 * com a internet caída, o Suporte atende e devolve ao automático. O resumo
 * trazia, como "o que o cliente já considera combinado" DESTE atendimento, a nota
 * do boleto — e, como pendência, um comprovante que ninguém do Suporte pediu.
 *
 * A pendência é o pior dos três vazamentos: nota e decisão viram contexto; a
 * pendência vira `next_action` do checkpoint de retomada — o campo que existe
 * para o agente AGIR.
 *
 * ─── Por que os chamados seguem o CHAMADO, e não o horário do evento ────────
 *
 * Um chamado aberto na segunda pode ser respondido na quarta. O produto já
 * decidiu o PRINCÍPIO: `app/api/v1/ai/cases/[id]/reply/route.ts` registra essa
 * resposta como `service_stale` — "fica registrada, mas não altera o atendimento
 * novo" — e abre aviso na Central. Recortar o EVENTO pelo horário dele poria essa
 * mesma resposta no resumo. O chamado pertence ao atendimento em que foi ABERTO;
 * os eventos vão com ele.
 *
 * É o mesmo princípio, NÃO a mesma régua: a rota mede por fronteira de serviço
 * (`service_revision` + demanda), que também muda DENTRO de um atendimento — troca
 * de demanda, "Reabrir" pelo atendente. Nesses casos a resposta é `service_stale`
 * para a rota e segue no resumo, porque o atendimento é o mesmo. Aqui vale a
 * janela do atendimento, que é a unidade de "começa do zero".
 *
 * ─── O dublê APLICA os filtros ──────────────────────────────────────────────
 *
 * As asserções são sobre o que SAI (o texto do resumo, a pendência), não sobre
 * "`gte` foi chamado". Um dublê que só registrasse a chamada continuaria verde
 * se alguém trocasse a coluna do filtro, que é o formato do defeito.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const erroLogado = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: erroLogado, debug: vi.fn() },
}));

import { lerContinuidadeHumana } from "@/lib/escalacao/continuidade";

type Linha = Record<string, unknown>;

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONV = "44444444-4444-4444-8444-444444444444";

function instante(v: unknown): number {
  return Date.parse(String(v));
}

/**
 * Supabase em memória, só o que a leitura usa — e com os filtros VALENDO.
 * `erroEm` faz a tabela indicada responder erro (a régua da janela "diz" a
 * falha; a pergunta é o que a continuidade faz com isso).
 */
function bancoEmMemoria(tabelas: Record<string, Linha[]>, opts: { erroEm?: string } = {}) {
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    let limite: number | null = null;
    const ordens: Array<{ coluna: string; crescente: boolean }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: unknown) => ((linhas = linhas.filter((l) => l[c] === v)), chain),
      in: (c: string, vs: unknown[]) => ((linhas = linhas.filter((l) => vs.includes(l[c]))), chain),
      gte: (c: string, v: unknown) => ((linhas = linhas.filter((l) => instante(l[c]) >= instante(v))), chain),
      lt: (c: string, v: unknown) => ((linhas = linhas.filter((l) => instante(l[c]) < instante(v))), chain),
      order: (coluna: string, o: { ascending: boolean }) => (ordens.push({ coluna, crescente: o.ascending }), chain),
      limit: (n: number) => ((limite = n), chain),
      then: (resolver: (v: unknown) => unknown) => {
        if (opts.erroEm === tabela) {
          return Promise.resolve({ data: null, error: { message: "boom" } }).then(resolver);
        }
        const ordenadas = [...linhas].sort((a, b) => {
          for (const { coluna, crescente } of ordens) {
            const d = instante(a[coluna]) - instante(b[coluna]);
            if (d !== 0) return crescente ? d : -d;
          }
          return 0;
        });
        const data = limite === null ? ordenadas : ordenadas.slice(0, limite);
        return Promise.resolve({ data, error: null }).then(resolver);
      },
    };
    return chain;
  };
  return { from } as never;
}

// ─── A semana do cliente ────────────────────────────────────────────────────

const SEG = "2026-09-14T10:00:00Z"; // Financeiro abre
const QUA = "2026-09-16T10:00:00Z"; // Suporte abre (o cliente voltou)

const atendimento = (id: string, inicio: string): Linha => ({
  id,
  organization_id: ORG,
  conversation_id: CONV,
  started_at: inicio,
  created_at: inicio,
});
const FINANCEIRO = atendimento("a1111111-1111-4111-8111-111111111111", SEG);
const SUPORTE = atendimento("a2222222-2222-4222-8222-222222222222", QUA);

const nota = (texto: string, quando: string, org = ORG): Linha => ({
  organization_id: org,
  conversation_id: CONV,
  body: texto,
  created_by_name: "Ana",
  created_at: quando,
});
const NOTA_DO_BOLETO = nota("Enviei a 2ª via do boleto.", "2026-09-14T11:00:00Z");
const NOTA_DA_ONU = nota("Cliente sem sinal; reiniciei a ONU remotamente.", "2026-09-16T11:00:00Z");

const chamado = (id: string, titulo: string, abertoEm: string): Linha => ({
  id,
  organization_id: ORG,
  conversation_id: CONV,
  title: titulo,
  status: "resolved",
  opened_at: abertoEm,
  closed_at: null,
});
const CHAMADO_BOLETO = chamado("c1111111-1111-4111-8111-111111111111", "Boleto vencido", "2026-09-14T10:30:00Z");
const CHAMADO_CONEXAO = chamado("c2222222-2222-4222-8222-222222222222", "Sem conexão", "2026-09-16T10:30:00Z");

const resposta = (caseId: string, acao: string, texto: string, quando: string): Linha => ({
  organization_id: ORG,
  case_id: caseId,
  kind: "human_replied",
  human_action: acao,
  body: texto,
  created_at: quando,
});
const PEDIU_COMPROVANTE = resposta(
  CHAMADO_BOLETO.id as string,
  "need_lead_info",
  "Pedir o comprovante de pagamento.",
  "2026-09-14T11:30:00Z",
);
const RESOLVEU_CONEXAO = resposta(
  CHAMADO_CONEXAO.id as string,
  "resolved",
  "Sinal normalizado após reiniciar a ONU.",
  "2026-09-16T11:30:00Z",
);

function semanaInteira(over: Record<string, Linha[]> = {}): Record<string, Linha[]> {
  return {
    atendimentos: [FINANCEIRO, SUPORTE],
    conversation_notes: [NOTA_DO_BOLETO, NOTA_DA_ONU],
    agent_cases: [CHAMADO_BOLETO, CHAMADO_CONEXAO],
    agent_case_events: [PEDIU_COMPROVANTE, RESOLVEU_CONEXAO],
    ...over,
  };
}

beforeEach(() => erroLogado.mockClear());

describe("devolvida na quarta, a IA lê a quarta — o atendimento novo começa do zero", () => {
  it("⭐ a nota interna do Financeiro não entra no resumo da devolução do Suporte", async () => {
    const c = await lerContinuidadeHumana(bancoEmMemoria(semanaInteira()), ORG, CONV);

    expect(c.resumo).toContain("reiniciei a ONU");
    expect(c.resumo, "nota de protocolo encerrado vazou para o atendimento novo").not.toContain("boleto");
    expect(c.notas.map((n) => n.texto)).toEqual([NOTA_DA_ONU.body]);
  });

  it("⭐ a decisão tomada num chamado do atendimento anterior não é 'o que o cliente já considera combinado' neste", async () => {
    const c = await lerContinuidadeHumana(bancoEmMemoria(semanaInteira()), ORG, CONV);

    expect(c.decisoes.map((d) => d.chamadoTitulo)).toEqual(["Sem conexão"]);
    expect(c.resumo).toContain("Sinal normalizado");
    expect(c.resumo).not.toContain("Boleto vencido");
    expect(c.chamados.map((x) => x.id)).toEqual([CHAMADO_CONEXAO.id]);
  });

  it("⭐ a pendência do atendimento anterior NÃO vira a próxima ação do agente", async () => {
    // O único `need_lead_info` da conversa é o do Financeiro. Sem o recorte ele
    // vira `next_action` do checkpoint de retomada: a instrução de cobrar do
    // cliente, num atendimento de Suporte, um comprovante que ninguém ali pediu.
    const c = await lerContinuidadeHumana(bancoEmMemoria(semanaInteira()), ORG, CONV);

    expect(c.pendenciaComOCliente).toBeNull();
    expect(c.resumo).not.toContain("comprovante");
  });

  it("chamado aberto na segunda e respondido na QUARTA segue com a segunda — é o `service_stale` que a rota de resposta já aplica", async () => {
    const respondidoTarde = resposta(
      CHAMADO_BOLETO.id as string,
      "need_lead_info",
      "Pedir o comprovante de pagamento.",
      "2026-09-16T12:00:00Z", // dentro da janela da quarta — o horário do EVENTO não decide
    );
    const c = await lerContinuidadeHumana(
      bancoEmMemoria(semanaInteira({ agent_case_events: [respondidoTarde, RESOLVEU_CONEXAO] })),
      ORG,
      CONV,
    );

    expect(c.pendenciaComOCliente).toBeNull();
    expect(c.decisoes.map((d) => d.chamadoTitulo)).toEqual(["Sem conexão"]);
  });

  it("atendimento vigente SEM rastro humano: não houve atendimento humano — ainda que o anterior tenha tido", async () => {
    // É o que impede `devolverAtendimentoAoAgente` de gravar um checkpoint de
    // retomada feito inteiro de assunto encerrado.
    const c = await lerContinuidadeHumana(
      bancoEmMemoria({
        atendimentos: [FINANCEIRO, SUPORTE],
        conversation_notes: [NOTA_DO_BOLETO],
        agent_cases: [CHAMADO_BOLETO],
        agent_case_events: [PEDIU_COMPROVANTE],
      }),
      ORG,
      CONV,
    );

    expect(c.houveAtendimentoHumano).toBe(false);
    expect(c.resumo).toBe("");
    expect(c.pendenciaComOCliente).toBeNull();
    // Aqui a leitura FUNCIONOU e não havia nada: não é o mesmo que janela ilegível.
    expect(c.leituraFalhou).toBe(false);
  });
});

describe("onde não há o que recortar, nada some", () => {
  it("um atendimento só: o primeiro episódio não tem piso — nem o que é anterior à linha dele se perde", async () => {
    const antesDaLinha = nota("Cliente ligou antes de escrever.", "2026-09-14T09:00:00Z");
    const c = await lerContinuidadeHumana(
      bancoEmMemoria(semanaInteira({ atendimentos: [FINANCEIRO], conversation_notes: [antesDaLinha, NOTA_DO_BOLETO] })),
      ORG,
      CONV,
    );

    expect(c.notas.map((n) => n.texto)).toEqual([antesDaLinha.body, NOTA_DO_BOLETO.body]);
    expect(c.pendenciaComOCliente).toBe(PEDIU_COMPROVANTE.body);
  });

  it("sem episódio nenhum (conversa anterior ao backfill): a conversa inteira é a resposta honesta", async () => {
    const c = await lerContinuidadeHumana(bancoEmMemoria(semanaInteira({ atendimentos: [] })), ORG, CONV);

    expect(c.notas).toHaveLength(2);
    expect(c.decisoes).toHaveLength(2);
  });
});

describe("as guardas", () => {
  it("janela ilegível: continuidade VAZIA e erro no log — nunca a conversa inteira", async () => {
    // Cair em "sem recorte" aqui entregaria à IA exatamente o que o recorte
    // existe para segurar. Voltar cega é degradação, e fica dita no log; voltar
    // com a nota de outro protocolo é o defeito.
    const c = await lerContinuidadeHumana(bancoEmMemoria(semanaInteira(), { erroEm: "atendimentos" }), ORG, CONV);

    expect(c.houveAtendimentoHumano).toBe(false);
    expect(c.resumo).toBe("");
    expect(c.notas).toEqual([]);
    // "Não li" e "não havia nada" são respostas diferentes — quem chama grava
    // isso no audit, em vez de registrar como fato que a equipe não fez nada.
    expect(c.leituraFalhou).toBe(true);
    expect(erroLogado).toHaveBeenCalledTimes(1);
    expect(erroLogado.mock.calls[0]?.[1]).toMatchObject({ conversation_id: CONV, motivo: "erro_de_leitura" });
  });

  it("o vazio devolvido é de quem o recebe — mexer nele não contamina a próxima leitura", async () => {
    const banco = () => bancoEmMemoria(semanaInteira(), { erroEm: "atendimentos" });
    const primeira = await lerContinuidadeHumana(banco(), ORG, CONV);
    primeira.notas.push({ autor: null, texto: "intrusa", quando: QUA });

    expect((await lerContinuidadeHumana(banco(), ORG, CONV)).notas).toEqual([]);
  });

  it("o recorte não afrouxa o isolamento: nota de OUTRA organização, dentro da janela, não entra", async () => {
    const intrusa = nota("Nota de outro tenant.", "2026-09-16T11:15:00Z", OUTRA_ORG);
    const c = await lerContinuidadeHumana(
      bancoEmMemoria(semanaInteira({ conversation_notes: [NOTA_DA_ONU, intrusa] })),
      ORG,
      CONV,
    );

    expect(c.notas.map((n) => n.texto)).toEqual([NOTA_DA_ONU.body]);
  });

  it("⭐ usa a régua ÚNICA — não reescreve a regra lendo `atendimentos` por conta própria", () => {
    // Mesmo princípio de `notas-internas-por-atendimento.test.ts`: a janela certa
    // num arquivo não adianta se uma ponta monta a dela. A segunda régua diverge
    // no dia em que alguém mudar "fechamento não é fronteira" num lugar só.
    const fonte = readFileSync("lib/escalacao/continuidade.ts", "utf8");
    expect(fonte).toContain("janelaDoAtendimento(");
    expect(fonte).toContain("ATENDIMENTO_VIGENTE");
    expect(fonte).not.toContain('.from("atendimentos")');
  });
});
