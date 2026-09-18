import { describe, expect, it } from "vitest";

import { HEARTBEAT_TIMEOUT_MINUTES } from "@/lib/routing/eligibility";

import { MOTIVOS_DE_PAUSA, rotuloDoMotivoDePausa, statusDoAtendente, statusDoAtendenteSchema } from "./pausa";

const agora = new Date("2026-09-18T15:00:00Z");
const ha = (min: number) => new Date(agora.getTime() - min * 60_000).toISOString();

describe("o status que a tela mostra", () => {
  it("sem linha de disponibilidade: offline", () => {
    expect(statusDoAtendente(null, agora)).toBe("offline");
  });

  it("disponível com sinal de vida recente: online", () => {
    expect(statusDoAtendente({ is_available: true, last_heartbeat_at: ha(1) }, agora)).toBe("online");
  });

  it("disponível SEM sinal de vida recente não é 'online' — a aba pode ter fechado", () => {
    // É a régua do painel de Equipe: prometer alguém que não está lá é pior que
    // dizer offline um minuto cedo.
    expect(
      statusDoAtendente({ is_available: true, last_heartbeat_at: ha(HEARTBEAT_TIMEOUT_MINUTES + 1) }, agora),
    ).toBe("offline");
  });

  it("a pausa vem primeiro: 'offline' diria menos do que se sabe", () => {
    expect(statusDoAtendente({ is_available: false, paused_at: ha(10), last_heartbeat_at: ha(30) }, agora)).toBe("paused");
  });
});

describe("o corpo do POST de status", () => {
  it("pausa sem motivo é recusada", () => {
    expect(statusDoAtendenteSchema.safeParse({ status: "paused" }).success).toBe(false);
  });

  it("'outro' pede a observação — 'outro' sozinho é motivo nenhum", () => {
    expect(statusDoAtendenteSchema.safeParse({ status: "paused", reason: "outro" }).success).toBe(false);
    expect(statusDoAtendenteSchema.safeParse({ status: "paused", reason: "outro", note: "médico" }).success).toBe(true);
  });

  it("online e offline não pedem motivo", () => {
    expect(statusDoAtendenteSchema.safeParse({ status: "online" }).success).toBe(true);
    expect(statusDoAtendenteSchema.safeParse({ status: "offline" }).success).toBe(true);
  });

  it("organization_id no corpo é RECUSADO — a organização sai da sessão", () => {
    expect(statusDoAtendenteSchema.safeParse({ status: "online", organization_id: "x" }).success).toBe(false);
  });

  it("status fora do vocabulário é recusado", () => {
    expect(statusDoAtendenteSchema.safeParse({ status: "almocando" }).success).toBe(false);
  });
});

describe("o rótulo do motivo", () => {
  it("todo motivo padrão tem rótulo próprio", () => {
    for (const m of MOTIVOS_DE_PAUSA) expect(rotuloDoMotivoDePausa(m.valor)).toBe(m.rotulo);
  });

  it("motivo que esta versão não conhece aparece como veio — a pausa não some da tela", () => {
    expect(rotuloDoMotivoDePausa("visita-tecnica")).toBe("visita-tecnica");
  });
});
