import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { carregarTimes } from "./catalogo";

/** Domingo, 12:00 em America/Sao_Paulo — conferido com Intl, não presumido. */
const domingoMeioDia = new Date("2026-09-06T15:00:00Z");

function fake(times: unknown[], membros: unknown[]) {
  const q = (linhas: unknown) => {
    const o = {
      select() { return o; },
      order() { return o; },
      eq() { return o; },
      is() { return o; },
      in() { return o; },
      then(r: (x: unknown) => unknown) { return Promise.resolve({ data: linhas, error: null }).then(r); },
    };
    return o;
  };
  return { from(t: string) { return q(t === "attendance_teams" ? times : membros); } } as unknown as SupabaseClient;
}

describe("catálogo de times", () => {
  it("diz se o time está aberto AGORA, pela janela dele", async () => {
    const db = fake(
      [{ id: "t1", name: "Cancelamentos", slug: "cancelamento", description: "Pedidos de cancelar",
         schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "18:00" }] } }],
      [{ team_id: "t1", user_id: "ana" }],
    );
    const [time] = await carregarTimes(db, "org", domingoMeioDia);
    expect(time).toMatchObject({ slug: "cancelamento", aberto_agora: false });
  });

  it("time sem janela é 24/7 — janela existe para RESTRINGIR", async () => {
    const db = fake([{ id: "t1", name: "Suporte", slug: "suporte", description: "", schedule: {} }], []);
    const [time] = await carregarTimes(db, "org", domingoMeioDia);
    expect(time?.aberto_agora).toBe(true);
  });

  it("agenda ilegível fecha o time e vem marcada — não derruba a tela", async () => {
    // `America/Asunción`, com o acento que um hispanofalante escreve natural: a
    // coluna é jsonb sem CHECK, então o banco aceita o que o parser recusa.
    const db = fake(
      [{ id: "t1", name: "Cancelamentos", slug: "cancelamento", description: "",
         schedule: { timezone: "America/Asunción", windows: [] } }],
      [],
    );
    await expect(carregarTimes(db, "org", domingoMeioDia)).resolves.toMatchObject([
      { slug: "cancelamento", aberto_agora: false, horario_invalido: true },
    ]);
  });

  it("time com agenda boa não vem marcado", async () => {
    const db = fake([{ id: "t1", name: "Suporte", slug: "suporte", description: "", schedule: {} }], []);
    const [time] = await carregarTimes(db, "org", domingoMeioDia);
    expect(time?.horario_invalido).toBe(false);
  });

  it("conta os membros alocados", async () => {
    const db = fake(
      [{ id: "t1", name: "Suporte", slug: "suporte", description: "", schedule: {} }],
      [{ team_id: "t1", user_id: "ana" }, { team_id: "t1", user_id: "bia" }],
    );
    const [time] = await carregarTimes(db, "org", domingoMeioDia);
    expect(time?.user_ids).toEqual(["ana", "bia"]);
  });
});
