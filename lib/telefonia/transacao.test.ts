// @vitest-environment node
/**
 * `emTransacao` — a transação ÚNICA das gravações do telefone (fala geral, menu,
 * arquivar, apontar número): uma conexão, `begin`, prazo de trava, `fn`, e
 * `commit` ou `rollback` conforme `fn` decidir; erro desfaz; 55P03 vira
 * `gravacao_em_andamento`; conexão com rollback quebrado é DESCARTADA.
 */
import { describe, expect, it } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { confirmar, desfazer, emTransacao, type ConexaoDaTransacao, type PoolDeTransacao } from "./transacao";

class PoolFalso implements PoolDeTransacao {
  passos: string[] = [];
  liberacoes: Array<Error | undefined> = [];
  conexoes = 0;
  falharRollback = false;
  falharCommit = false;
  connect = async (): Promise<ConexaoDaTransacao> => {
    this.conexoes++;
    return {
      release: (erro?: Error) => this.liberacoes.push(erro),
      query: (async (sql: string) => {
        this.passos.push(sql);
        if (sql === "rollback" && this.falharRollback) throw new Error("Connection terminated");
        if (sql === "commit" && this.falharCommit) throw Object.assign(new Error("commit falhou"), { code: "40001" });
        return { rows: [], rowCount: 0 };
      }) as unknown as Queryable["query"],
    };
  };
}

const erro = (code: string) => Object.assign(new Error(`erro ${code}`), { code });

describe("emTransacao", () => {
  it("confirmar: begin, prazo da trava, o que fn pediu, commit; a conexão volta sã ao pool", async () => {
    const pool = new PoolFalso();
    const r = await emTransacao(pool, "4s", async (c) => {
      await c.query("select 1");
      return confirmar({ ok: true as const, n: 1 });
    });
    expect(r).toEqual({ ok: true, n: 1 });
    expect(pool.passos).toEqual(["begin", "set local lock_timeout = '4s'", "select 1", "commit"]);
    expect(pool.liberacoes).toEqual([undefined]);
  });

  it("desfazer: a recusa de fn volta como valor, e a transação é desfeita", async () => {
    const pool = new PoolFalso();
    const r = await emTransacao(pool, "500ms", async (c) => {
      await c.query("insert x");
      return desfazer({ ok: false as const, motivo: "nao_encontrado" });
    });
    expect(r).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(pool.passos).toEqual(["begin", "set local lock_timeout = '500ms'", "insert x", "rollback"]);
    expect(pool.liberacoes).toEqual([undefined]);
  });

  it("o prazo da trava venceu (55P03): gravacao_em_andamento, desfeito e a conexão devolvida", async () => {
    const pool = new PoolFalso();
    const r = await emTransacao(pool, "4s", async () => {
      throw erro("55P03");
    });
    expect(r).toEqual({ ok: false, motivo: "gravacao_em_andamento" });
    expect(pool.passos.at(-1)).toBe("rollback");
    expect(pool.liberacoes).toEqual([undefined]);
  });

  it("traduzirErro vira valor a recusa conhecida; o resto sobe, sempre depois de desfazer", async () => {
    const pool = new PoolFalso();
    const traduzir = (e: unknown) => ((e as { code?: string }).code === "23503" ? { ok: false as const, motivo: "time_invalido" } : null);
    expect(await emTransacao(pool, "4s", async () => Promise.reject(erro("23503")), traduzir)).toEqual({
      ok: false,
      motivo: "time_invalido",
    });
    await expect(emTransacao(pool, "4s", async () => Promise.reject(erro("08006")), traduzir)).rejects.toThrow("erro 08006");
    expect(pool.passos.filter((p) => p === "rollback")).toHaveLength(2);
    expect(pool.liberacoes).toEqual([undefined, undefined]);
  });

  it("o commit falhou: desfaz e sobe o erro — nada é dado por gravado", async () => {
    const pool = new PoolFalso();
    pool.falharCommit = true;
    await expect(emTransacao(pool, "4s", async () => confirmar(1))).rejects.toThrow("commit falhou");
    expect(pool.passos.slice(-2)).toEqual(["commit", "rollback"]);
  });

  it("o rollback também falhou (conexão morta): a conexão é DESCARTADA com release(erro), e sobe o erro original", async () => {
    const pool = new PoolFalso();
    pool.falharRollback = true;
    await expect(emTransacao(pool, "4s", async () => Promise.reject(erro("08006")))).rejects.toThrow("erro 08006");
    expect(pool.liberacoes).toHaveLength(1);
    expect(pool.liberacoes[0]).toBeInstanceOf(Error);
  });

  it("prazo fora do formato (vai para dentro do SQL): recusa antes de pegar conexão", async () => {
    const pool = new PoolFalso();
    for (const prazo of ["4s'; drop table x; --", "0s", "4 s", "", "4m"]) {
      await expect(emTransacao(pool, prazo, async () => confirmar(1))).rejects.toThrow(/prazo/);
    }
    expect(pool.conexoes).toBe(0);
  });
});
