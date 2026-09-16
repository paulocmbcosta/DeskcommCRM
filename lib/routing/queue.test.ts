/**
 * A POSIÇÃO NA FILA É A DO TIME, NÃO A DA ORGANIZAÇÃO INTEIRA.
 *
 * `getQueuePosition` é o número que o CLIENTE ouve pelo WhatsApp ("você é o 3º
 * da fila"). Com times, contar a fila da organização inteira diria ao cliente
 * uma posição que não existe na tela de quem vai atendê-lo: conversas de outros
 * setores entrariam na conta. Número errado dito com confiança.
 *
 * O teste vigia a QUERY, não a aritmética: o fake devolve `count` fixo e as
 * asserções olham só os filtros aplicados. Quem conta é o Postgres; o que pode
 * quebrar aqui é o predicado.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/ai/agents/org-tem-automatico", () => ({ orgTemAutomatico: async () => false }));
vi.mock("@/lib/inbox/comando-da-conversa", () => ({ comandosDaFila: () => ["na_fila"] }));

import { getQueuePosition } from "./queue";

function fake() {
  const filtros: Array<[string, unknown]> = [];
  const q = {
    select() { return q; },
    eq(k: string, v: unknown) { filtros.push([k, v]); return q; },
    is(k: string, v: unknown) { filtros.push([k, v]); return q; },
    in(k: string, v: unknown) { filtros.push([k, v]); return q; },
    lte(k: string, v: unknown) { filtros.push([k, v]); return q; },
    then(r: (x: unknown) => unknown) { return Promise.resolve({ count: 2, error: null }).then(r); },
  };
  const db = { from() { return q; } } as unknown as SupabaseClient;
  return { db, filtros };
}

const agora = new Date("2026-09-06T15:00:00Z");

describe("posição na fila", () => {
  it("com time, conta só a fila daquele time", async () => {
    const { db, filtros } = fake();
    await getQueuePosition(db, "org", null, agora, "time");
    expect(filtros).toContainEqual(["team_id", "time"]);
  });

  it("sem time, conta só a fila geral — as conversas sem time", async () => {
    const { db, filtros } = fake();
    await getQueuePosition(db, "org", null, agora, null);
    expect(filtros).toContainEqual(["team_id", null]);
  });
});
