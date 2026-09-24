import { describe, expect, it } from "vitest";

import { reguaDeEspera } from "@/lib/schemas/settings";

import { esperaDaConversa, estaNaFilaDoTime, formatarEspera, nivelDaEspera } from "./espera";

const agora = new Date("2026-09-18T15:00:00Z");
const ha = (ms: number) => new Date(agora.getTime() - ms).toISOString();

describe("há espera quando a última palavra foi do cliente", () => {
  it("cliente escreveu e ninguém respondeu: espera desde a mensagem dele", () => {
    const e = esperaDaConversa({ status: "open", last_inbound_at: ha(5 * 60_000), last_outbound_at: null }, agora);
    expect(e?.ms).toBe(5 * 60_000);
    expect(e?.nivel).toBe("laranja");
  });

  it("a empresa respondeu DEPOIS: quem deve o próximo passo é o cliente — sem cobrança", () => {
    expect(
      esperaDaConversa({ status: "claimed", last_inbound_at: ha(60 * 60_000), last_outbound_at: ha(10 * 60_000) }, agora),
    ).toBeNull();
  });

  it("o cliente escreveu DEPOIS da última resposta: a espera volta a contar", () => {
    const e = esperaDaConversa(
      { status: "claimed", last_inbound_at: ha(10 * 60_000), last_outbound_at: ha(60 * 60_000) },
      agora,
    );
    expect(e?.ms).toBe(10 * 60_000);
  });

  it.each(["closed", "resolved", "archived"])("atendimento %s não espera ninguém", (status) => {
    expect(esperaDaConversa({ status, last_inbound_at: ha(60_000), last_outbound_at: null }, agora)).toBeNull();
  });

  it("sem entrada nenhuma (conversa iniciada pela empresa) não há o que esperar", () => {
    expect(esperaDaConversa({ status: "open", last_inbound_at: null, last_outbound_at: ha(60_000) }, agora)).toBeNull();
  });

  it("carimbo ilegível não derruba o card", () => {
    expect(esperaDaConversa({ status: "open", last_inbound_at: "ontem", last_outbound_at: null }, agora)).toBeNull();
  });
});

describe("a cor sobe pela régua da organização (padrão 2 / 5 / 10 min)", () => {
  it.each([
    [2 * 60_000 - 1, "normal"],
    [2 * 60_000, "amarelo"],
    [5 * 60_000 - 1, "amarelo"],
    [5 * 60_000, "laranja"],
    [10 * 60_000 - 1, "laranja"],
    [10 * 60_000, "vermelho"],
  ])("%d ms → %s", (ms, nivel) => {
    expect(esperaDaConversa({ status: "open", last_inbound_at: ha(ms), last_outbound_at: null }, agora)?.nivel).toBe(nivel);
  });

  it("a régua da organização manda nos degraus", () => {
    const regua = { amarelo_min: 1, laranja_min: 3, vermelho_min: 4 };
    expect(nivelDaEspera(3 * 60_000, regua)).toBe("laranja");
    expect(nivelDaEspera(4 * 60_000, regua)).toBe("vermelho");
  });
});

describe("desde a PRIMEIRA mensagem sem resposta (espera_desde, migration 0279)", () => {
  it("usa espera_desde, não a última entrada", () => {
    const e = esperaDaConversa(
      { status: "open", last_inbound_at: ha(60_000), last_outbound_at: null, espera_desde: ha(10 * 60_000) },
      agora,
    );
    expect(e?.ms).toBe(10 * 60_000);
    expect(e?.nivel).toBe("vermelho");
  });

  it("espera_desde nulo é 'ninguém deve resposta', mesmo com entrada recente", () => {
    expect(
      esperaDaConversa({ status: "open", last_inbound_at: ha(60_000), last_outbound_at: null, espera_desde: null }, agora),
    ).toBeNull();
  });

  it.each(["humano", "aguardando"])("comando %s: o termômetro aparece", (comando) => {
    expect(
      esperaDaConversa(
        { status: "open", last_inbound_at: null, last_outbound_at: null, espera_desde: ha(3 * 60_000), comando_da_conversa: comando },
        agora,
      ),
    ).not.toBeNull();
  });

  it("no automático não há termômetro: a IA leva minutos para responder", () => {
    expect(
      esperaDaConversa(
        { status: "open", last_inbound_at: null, last_outbound_at: null, espera_desde: ha(3 * 60_000), comando_da_conversa: "automatico" },
        agora,
      ),
    ).toBeNull();
  });
});

describe("a régua lida do jsonb nunca quebra", () => {
  it("ausente → padrão", () => {
    expect(reguaDeEspera({})).toEqual({ amarelo_min: 2, laranja_min: 5, vermelho_min: 10 });
  });
  it("degraus fora de ordem → padrão", () => {
    expect(reguaDeEspera({ inbox: { regua_de_espera: { amarelo_min: 9, laranja_min: 5, vermelho_min: 10 } } })).toEqual({
      amarelo_min: 2,
      laranja_min: 5,
      vermelho_min: 10,
    });
  });
  it("válida → a da organização", () => {
    expect(reguaDeEspera({ inbox: { regua_de_espera: { amarelo_min: 1, laranja_min: 3, vermelho_min: 15 } } })).toEqual({
      amarelo_min: 1,
      laranja_min: 3,
      vermelho_min: 15,
    });
  });
});

describe("na fila do time: time definido, sem dono, IA calada", () => {
  const base = { status: "open", team_id: "t1", assigned_to_user_id: null, bot_silenced_until: "infinity" };
  it("o caso da transferência", () => {
    expect(estaNaFilaDoTime(base, agora)).toBe(true);
  });
  it("sem time não é fila de time", () => {
    expect(estaNaFilaDoTime({ ...base, team_id: null }, agora)).toBe(false);
  });
  it("alguém pegou", () => {
    expect(estaNaFilaDoTime({ ...base, assigned_to_user_id: "u1" }, agora)).toBe(false);
  });
  it("a IA ainda está no comando", () => {
    expect(estaNaFilaDoTime({ ...base, bot_silenced_until: null }, agora)).toBe(false);
    expect(estaNaFilaDoTime({ ...base, bot_silenced_until: ha(60_000) }, agora)).toBe(false);
  });
  it("encerrada não está na fila", () => {
    expect(estaNaFilaDoTime({ ...base, status: "closed" }, agora)).toBe(false);
  });
});

describe("o tempo por extenso", () => {
  it.each([
    [20_000, "menos de 1 min"],
    [12 * 60_000, "12 min"],
    [60 * 60_000, "1h"],
    [(3 * 60 + 51) * 60_000, "3h 51min"],
    [24 * 60 * 60_000, "1d"],
    [(2 * 24 + 4) * 60 * 60_000, "2d 4h"],
  ])("%d ms → %s", (ms, esperado) => {
    expect(formatarEspera(ms)).toBe(esperado);
  });
});
