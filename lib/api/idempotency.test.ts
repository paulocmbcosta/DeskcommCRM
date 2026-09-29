/**
 * Idempotência de POST — o que o helper promete, e o que ele NÃO promete.
 *
 * O caso que dá sentido ao resto: no replay o efeito **não roda de novo**.
 * Um helper que devolvesse a resposta gravada mas executasse o efeito outra
 * vez passaria numa asserção de "mesma resposta" e ainda assim duplicaria a
 * criação — por isso a asserção é no call-site do efeito, não só no retorno.
 *
 * O buraco declarado (a corrida entre duas requisições simultâneas) tem caso
 * próprio, para que a limitação esteja presa por teste e não só por
 * comentário: no dia em que o schema ganhar estado de "em curso", o caso (8)
 * fica vermelho e obriga a quem mexeu a ler o porquê.
 *
 * `request_hash` é `bytea`: o dublê grava e devolve o valor como o PostgREST
 * (`byteaComoPostgrest`) — entrada de `bytea` na escrita, `"\x" + hex` na
 * leitura. Um dublê que devolvesse a string gravada escondeu que o hash nunca
 * casava (todo replay virava 409). O caminho real está em
 * tests/invariants/idempotencia-recibo-no-banco.test.ts.
 */

import { describe, expect, it, vi } from "vitest";

import { comIdempotencia, hashDoCorpo, hashGuardado, TTL_MS } from "@/lib/api/idempotency";
import { byteaComoPostgrest } from "@/tests/helpers/bytea-do-postgrest";

const ORG = "a1b20000-0000-4000-8000-000000000001";
const CHAVE = "a1b20000-0000-4000-8000-000000000002";
const ENDPOINT = "/api/v1/message-templates";

type Linha = Record<string, unknown>;

type OpcoesDoDuble = {
  linhas?: Linha[];
  /** Se presente, o insert falha com este erro (ex.: { code: "23505" }). */
  erroNoInsert?: { code?: string } | null;
  /**
   * Linhas que passam a existir no momento da colisão — simula o outro
   * escritor que gravou o recibo entre a nossa leitura e o nosso insert.
   * Sem isto o caminho do 23505 não é exercitado de verdade.
   */
  linhasAposColisao?: Linha[];
};

/**
 * Dublê mínimo do builder do supabase-js, só com a cadeia que o helper usa:
 * `from().select().eq().eq().eq().gt().maybeSingle()` e `from().insert()`.
 *
 * Registra os filtros aplicados (`eqAplicados`, `gtAplicados`) porque asserção
 * em efeito colateral — "inseriu" — não prova que o FILTRO foi aplicado:
 * apagar um `.eq("organization_id", …)` deixaria o helper lendo recibo de
 * outra organização e o teste continuaria verde.
 */
function duble(opcoes: OpcoesDoDuble = {}) {
  const linhas = [...(opcoes.linhas ?? [])];
  const inseridos: Linha[] = [];
  const eqAplicados: Array<[string, unknown]> = [];
  const gtAplicados: Array<[string, unknown]> = [];
  let filtros: Array<[string, unknown]> = [];
  let maiorQue: [string, unknown] | null = null;

  const casa = (linha: Linha) =>
    filtros.every(([coluna, valor]) => linha[coluna] === valor) &&
    (maiorQue ? String(linha[maiorQue[0]]) > String(maiorQue[1]) : true);

  const builder = {
    select: () => builder,
    eq: (coluna: string, valor: unknown) => {
      eqAplicados.push([coluna, valor]);
      filtros.push([coluna, valor]);
      return builder;
    },
    gt: (coluna: string, valor: unknown) => {
      gtAplicados.push([coluna, valor]);
      maiorQue = [coluna, valor];
      return builder;
    },
    maybeSingle: async () => ({ data: linhas.find(casa) ?? null, error: null }),
    insert: async (linha: Linha) => {
      if (opcoes.erroNoInsert) {
        if (opcoes.erroNoInsert.code === "23505" && opcoes.linhasAposColisao) {
          linhas.push(...opcoes.linhasAposColisao);
        }
        return { error: opcoes.erroNoInsert };
      }
      inseridos.push(linha);
      linhas.push({ ...linha, request_hash: byteaComoPostgrest(linha.request_hash) });
      return { error: null };
    },
  };

  return {
    db: { from: (tabela: string) => (tabela === "idempotency_keys" ? builder : {}) },
    inseridos,
    eqAplicados,
    gtAplicados,
    reiniciarFiltros: () => {
      filtros = [];
      maiorQue = null;
    },
  };
}

const RELOGIO = () => new Date("2026-09-14T00:00:00.000Z");
const DAQUI_A_UM_MINUTO = new Date(RELOGIO().getTime() + 60_000).toISOString();
const VENCIDO = new Date(RELOGIO().getTime() - 1).toISOString();

const CORPO = { title: "Boas-vindas" };
const hashDoCorpoPadrao = hashDoCorpo(CORPO);

/** Um recibo como a LEITURA o devolve: o `bytea` do digest em `"\x" + hex`. */
function recibo(over: Partial<Linha> = {}): Linha {
  return {
    organization_id: ORG,
    key: CHAVE,
    endpoint: ENDPOINT,
    request_hash: byteaComoPostgrest(`\\x${hashDoCorpoPadrao}`),
    status_code: 201,
    response_body: { id: "t1" },
    expires_at: DAQUI_A_UM_MINUTO,
    ...over,
  };
}

describe("comIdempotencia", () => {
  it("(1) sem recibo: executa e grava o recibo com o hash do corpo", async () => {
    const d = duble();
    const executar = vi.fn(async () => ({ resposta: { id: "t1" }, status: 201 }));

    const desfecho = await comIdempotencia({
      db: d.db as never,
      organizationId: ORG,
      endpoint: ENDPOINT,
      chave: CHAVE,
      corpo: CORPO,
      executar,
      agora: RELOGIO,
    });

    expect(desfecho).toEqual({ tipo: "executou", resposta: { id: "t1" }, status: 201 });
    expect(executar).toHaveBeenCalledTimes(1);
    expect(d.inseridos).toHaveLength(1);
    expect(d.inseridos[0]).toMatchObject({
      organization_id: ORG,
      key: CHAVE,
      endpoint: ENDPOINT,
      // `\x` + hex: a entrada de bytea grava os 32 bytes do digest.
      request_hash: `\\x${hashDoCorpoPadrao}`,
      status_code: 201,
      expires_at: new Date(RELOGIO().getTime() + TTL_MS).toISOString(),
    });
  });

  it("(2) mesma chave e mesmo corpo: NÃO reexecuta o efeito e devolve o gravado", async () => {
    const d = duble({ linhas: [recibo()] });
    const executar = vi.fn(async () => ({ resposta: { id: "DUPLICADO" }, status: 201 }));

    const desfecho = await comIdempotencia({
      db: d.db as never,
      organizationId: ORG,
      endpoint: ENDPOINT,
      chave: CHAVE,
      corpo: CORPO,
      executar,
      agora: RELOGIO,
    });

    expect(desfecho).toEqual({ tipo: "replay", resposta: { id: "t1" }, status: 201 });
    expect(executar).not.toHaveBeenCalled();
    expect(d.inseridos).toHaveLength(0);
  });

  it("(3) mesma chave e corpo diferente: conflito, sem reexecutar e sem sobrescrever", async () => {
    const d = duble({ linhas: [recibo()] });
    const executar = vi.fn(async () => ({ resposta: { id: "t2" }, status: 201 }));

    const desfecho = await comIdempotencia({
      db: d.db as never,
      organizationId: ORG,
      endpoint: ENDPOINT,
      chave: CHAVE,
      corpo: { title: "Outro assunto" },
      executar,
      agora: RELOGIO,
    });

    expect(desfecho).toEqual({ tipo: "conflito" });
    expect(executar).not.toHaveBeenCalled();
    expect(d.inseridos).toHaveLength(0);
  });

  it("(4) recibo vencido não conta: a mesma chave depois da janela é operação nova", async () => {
    const d = duble({ linhas: [recibo({ expires_at: VENCIDO })] });
    const executar = vi.fn(async () => ({ resposta: { id: "t2" }, status: 201 }));

    const desfecho = await comIdempotencia({
      db: d.db as never,
      organizationId: ORG,
      endpoint: ENDPOINT,
      chave: CHAVE,
      corpo: CORPO,
      executar,
      agora: RELOGIO,
    });

    expect(desfecho).toEqual({ tipo: "executou", resposta: { id: "t2" }, status: 201 });
    expect(executar).toHaveBeenCalledTimes(1);
  });

  it("(5) o filtro de validade e o de tenant vão para o BANCO, não para o código depois", async () => {
    // Sem asserção no filtro aplicado, apagar o `.gt("expires_at", …)` ou um
    // `.eq("organization_id", …)` passaria verde — e o helper leria recibo
    // vencido, ou de outra organização.
    const d = duble();
    await comIdempotencia({
      db: d.db as never,
      organizationId: ORG,
      endpoint: ENDPOINT,
      chave: CHAVE,
      corpo: CORPO,
      executar: async () => ({ resposta: {}, status: 201 }),
      agora: RELOGIO,
    });

    expect(d.gtAplicados).toEqual([["expires_at", RELOGIO().toISOString()]]);
    expect(d.eqAplicados).toEqual([
      ["organization_id", ORG],
      ["key", CHAVE],
      ["endpoint", ENDPOINT],
    ]);
  });

  it("(6) gravação do recibo falha depois do efeito: devolve sucesso, não erro", async () => {
    // Devolver erro faria o cliente retentar e duplicar — o oposto do que a
    // idempotência existe para fazer. Best-effort, declarado no cabeçalho.
    const d = duble({ erroNoInsert: { code: "08006" } });
    const desfecho = await comIdempotencia({
      db: d.db as never,
      organizationId: ORG,
      endpoint: ENDPOINT,
      chave: CHAVE,
      corpo: CORPO,
      executar: async () => ({ resposta: { id: "t1" }, status: 201 }),
      agora: RELOGIO,
    });
    expect(desfecho).toEqual({ tipo: "executou", resposta: { id: "t1" }, status: 201 });
  });

  it("(7) colisão 23505 na gravação: relê e classifica, em vez de 500", async () => {
    // Aqui o outro escritor só aparece NO INSERT — a primeira leitura não vê
    // nada. É esse caminho que o teste anterior (com o recibo já visível)
    // deixava passar sem exercitar.
    const d = duble({
      erroNoInsert: { code: "23505" },
      linhasAposColisao: [recibo()],
    });
    const executar = vi.fn(async () => ({ resposta: { id: "t2" }, status: 201 }));

    const desfecho = await comIdempotencia({
      db: d.db as never,
      organizationId: ORG,
      endpoint: ENDPOINT,
      chave: CHAVE,
      corpo: CORPO,
      executar,
      agora: RELOGIO,
    });

    expect(executar).toHaveBeenCalledTimes(1);
    expect(desfecho).toEqual({ tipo: "replay", resposta: { id: "t1" }, status: 201 });
  });

  it("(8) LIMITAÇÃO DECLARADA: duas requisições iguais em paralelo executam as duas", async () => {
    // Este caso descreve o comportamento ATUAL e indesejado: sem estado
    // "em curso" na tabela (`status_code`/`response_body` são NOT NULL, então
    // não há onde gravar reserva), as duas leem "sem recibo" e as duas
    // executam. Ele fica vermelho no dia em que o schema fechar a corrida —
    // e é aí que quem mexeu vai ler o porquê, no cabeçalho do helper.
    const d = duble();
    const executar = vi.fn(async () => ({ resposta: { id: "x" }, status: 201 }));

    const entrada = {
      db: d.db as never,
      organizationId: ORG,
      endpoint: ENDPOINT,
      chave: CHAVE,
      corpo: CORPO,
      executar,
      agora: RELOGIO,
    };
    await Promise.all([comIdempotencia(entrada), comIdempotencia(entrada)]);

    expect(executar).toHaveBeenCalledTimes(2);
  });
});

describe("o hash guardado, como a leitura o devolve (bytea)", () => {
  it("(9) recibo gravado ANTES do conserto (hex sem `\\x` = 64 bytes ASCII) ainda casa: replay, não 409", async () => {
    const d = duble({ linhas: [recibo({ request_hash: byteaComoPostgrest(hashDoCorpoPadrao) })] });
    const executar = vi.fn(async () => ({ resposta: { id: "DUPLICADO" }, status: 201 }));

    const desfecho = await comIdempotencia({
      db: d.db as never,
      organizationId: ORG,
      endpoint: ENDPOINT,
      chave: CHAVE,
      corpo: CORPO,
      executar,
      agora: RELOGIO,
    });

    expect(desfecho).toEqual({ tipo: "replay", resposta: { id: "t1" }, status: 201 });
    expect(executar).not.toHaveBeenCalled();
  });

  it("(10) hashGuardado lê os dois formatos que existem na tabela, e nada mais", () => {
    const digest = hashDoCorpoPadrao;
    expect(hashGuardado(byteaComoPostgrest(`\\x${digest}`))).toBe(digest); // 32 bytes (atual e RPC de tenant)
    expect(hashGuardado(byteaComoPostgrest(digest))).toBe(digest); // 64 bytes ASCII (antes do conserto)
    // Qualquer outra coisa não é um hash reconhecível: o chamador responde 409, nunca 500.
    expect(hashGuardado(byteaComoPostgrest("\\xabcd"))).toBeNull();
    expect(hashGuardado("\\xzz")).toBeNull();
    expect(hashGuardado(null)).toBeNull();
    expect(hashGuardado({ type: "Buffer" })).toBeNull();
  });

  it("(11) recibo ilegível (bytea que não é hash) vira conflito, não exceção", async () => {
    const d = duble({ linhas: [recibo({ request_hash: byteaComoPostgrest("\\xabcd") })] });
    const desfecho = await comIdempotencia({
      db: d.db as never,
      organizationId: ORG,
      endpoint: ENDPOINT,
      chave: CHAVE,
      corpo: CORPO,
      executar: async () => ({ resposta: {}, status: 201 }),
      agora: RELOGIO,
    });
    expect(desfecho).toEqual({ tipo: "conflito" });
  });
});
