// @vitest-environment node
/**
 * A PODA DAS GRAVAÇÕES VENCIDAS (F3, D5): o laço de lotes e a ORDEM — o Storage
 * primeiro, a marcação depois; Storage fora não marca nada. O SQL (quem é
 * vencida, o que a marcação escreve) é provado no Postgres real, em
 * tests/invariants/telefonia-gravacao.test.ts.
 */
import { describe, expect, it } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { podarGravacoesVencidas, type GravacaoVencida } from "./poda-das-gravacoes";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

function vencida(i: number, org = ORG_A, caminho: string | null = `${org}/c/m-${i}.mp3`): GravacaoVencida {
  return { vcId: `vc-${i}`, organizationId: org, mensagemId: `m-${i}`, conversationId: "c", caminho };
}

/** Um banco que entrega as vencidas em lotes e registra as marcações, na ordem. */
function banco(lotes: GravacaoVencida[][], linha: string[]) {
  const marcadas: string[] = [];
  const db: Queryable = {
    query: (async (sql: string, params: unknown[] = []) => {
      if (/from voice_calls v/.test(sql)) {
        linha.push("ler");
        const r = lotes.shift() ?? [];
        return {
          rows: r.map((g) => ({
            id: g.vcId,
            organization_id: g.organizationId,
            conversation_id: g.conversationId,
            mensagem_id: g.mensagemId,
            caminho: g.caminho,
          })),
          rowCount: r.length,
        };
      }
      linha.push("marcar");
      marcadas.push(String(params[0]));
      return { rows: [], rowCount: 1 };
    }) as Queryable["query"],
  };
  return { db, marcadas };
}

describe("podarGravacoesVencidas", () => {
  it("remove do Storage ANTES de marcar, e conta por organização", async () => {
    const linha: string[] = [];
    const removidos: string[][] = [];
    const { db, marcadas } = banco([[vencida(1), vencida(2, ORG_B)]], linha);
    const r = await podarGravacoesVencidas({
      db,
      agora: new Date("2026-09-30T00:00:00Z"),
      lote: 10,
      storage: {
        remover: async (c) => {
          linha.push("remover");
          removidos.push(c);
        },
      },
    });
    expect(linha).toEqual(["ler", "remover", "marcar", "marcar"]);
    expect(removidos).toEqual([[`${ORG_A}/c/m-1.mp3`, `${ORG_B}/c/m-2.mp3`]]);
    expect(marcadas).toEqual(["vc-1", "vc-2"]);
    expect([...r.porOrganizacao]).toEqual([
      [ORG_A, 1],
      [ORG_B, 1],
    ]);
    expect(r).toMatchObject({ temResto: false, falhas: [] });
  });

  it("Storage fora: nada é marcado, a falha é dita, e amanhã tenta de novo", async () => {
    const linha: string[] = [];
    const { db, marcadas } = banco([[vencida(1)]], linha);
    const r = await podarGravacoesVencidas({
      db,
      agora: new Date(),
      storage: {
        remover: async () => {
          throw new Error("storage 503");
        },
      },
    });
    expect(marcadas).toEqual([]);
    expect(r.porOrganizacao.size).toBe(0);
    expect(r.falhas).toEqual(["gravacoes: storage 503"]);
  });

  it("lote cheio pede outro; o teto de lotes deixa resto para amanhã", async () => {
    const linha: string[] = [];
    const { db, marcadas } = banco([[vencida(1), vencida(2)], [vencida(3), vencida(4)], [vencida(5)]], linha);
    const r = await podarGravacoesVencidas({ db, agora: new Date(), lote: 2, maxLotes: 2, storage: { remover: async () => undefined } });
    expect(marcadas).toEqual(["vc-1", "vc-2", "vc-3", "vc-4"]);
    expect(r.temResto).toBe(true);
  });

  it("sem vencidas: uma leitura, nada removido", async () => {
    const linha: string[] = [];
    const { db } = banco([], linha);
    let chamou = false;
    const r = await podarGravacoesVencidas({
      db,
      agora: new Date(),
      storage: {
        remover: async () => {
          chamou = true;
        },
      },
    });
    expect(linha).toEqual(["ler"]);
    expect(chamou).toBe(false);
    expect(r.porOrganizacao.size).toBe(0);
  });

  it("caminho que não é o da gravação (ponteiro trocado): NÃO é removido — só a marcação", async () => {
    const linha: string[] = [];
    let chamou = false;
    const { db, marcadas } = banco([[vencida(1, ORG_A, `${ORG_A}/c/outra-midia.jpg`)]], linha);
    await podarGravacoesVencidas({
      db,
      agora: new Date(),
      storage: {
        remover: async () => {
          chamou = true;
        },
      },
    });
    expect(chamou).toBe(false);
    expect(marcadas).toEqual(["vc-1"]);
  });

  it("vencida sem arquivo na mensagem (anonimizada): marca sem pedir remoção vazia", async () => {
    const linha: string[] = [];
    let chamou = false;
    const { db, marcadas } = banco([[vencida(1, ORG_A, null)]], linha);
    await podarGravacoesVencidas({
      db,
      agora: new Date(),
      storage: {
        remover: async () => {
          chamou = true;
        },
      },
    });
    expect(chamou).toBe(false);
    expect(marcadas).toEqual(["vc-1"]);
  });
});
