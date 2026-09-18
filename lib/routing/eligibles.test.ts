import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEligibleAttendants } from "./eligibles";

function fixture(over: Record<string, unknown> = {}) {
  const filters: Array<[string, string, unknown]> = [];
  const rows: Record<string, unknown> = {
    channel_sessions: { id: "channel" }, channel_routing_policies: null,
    channel_routing_responsibles: [], user_organizations: [{ user_id: "ana" }],
    attendant_availability: [{ user_id: "ana", capacity: 2, schedule: {} }],
    conversations: [], conversation_assignment_events: [],
    attendance_teams: { id: "time", schedule: {}, archived_at: null },
    attendance_team_members: [{ user_id: "ana" }],
    ...over,
  };
  const db = { from(table: string) {
    const q = {
      select() { return q; }, order() { return q; },
      eq(key: string, value: unknown) { filters.push([table, key, value]); return q; },
      is(key: string, value: unknown) { filters.push([table, key, value]); return q; },
      in(key: string, value: unknown) { filters.push([table, key, value]); return q; },
      maybeSingle() { return Promise.resolve({ data: rows[table], error: null }); },
      then(resolve: (x: unknown) => unknown) {
        return Promise.resolve(rows[table] instanceof Error
          ? { data: null, error: rows[table] }
          : { data: rows[table], error: null }).then(resolve);
      },
    }; return q;
  } } as unknown as SupabaseClient;
  return { db, filters };
}
const scope = { kind: "conversation_channel", channelSessionId: "channel" } as const;
const now = new Date("2026-09-06T15:00:00Z");
describe("elegibilidade com origem explícita", () => {
  it("política vazia não cai no conjunto legado", async () => {
    const { db } = fixture({ channel_routing_policies: { id: "policy" } });
    expect(await loadEligibleAttendants(db, "org", now, scope)).toEqual([]);
  });
  it("membro revogado não recebe mesmo com disponibilidade legada", async () => {
    const { db } = fixture({ user_organizations: [] });
    expect(await loadEligibleAttendants(db, "org", now, scope)).toEqual([]);
  });
  it("capacidade é global e histórico é apenas do canal, com org nas duas tabelas", async () => {
    const { db, filters } = fixture();
    expect(await loadEligibleAttendants(db, "org", now, scope)).toMatchObject([{ userId: "ana" }]);
    expect(filters).toContainEqual(["conversation_assignment_events", "conversations.channel_session_id", "channel"]);
    expect(filters).toContainEqual(["conversation_assignment_events", "conversations.organization_id", "org"]);
    expect(filters).not.toContainEqual(["conversations", "channel_session_id", "channel"]);
  });
  it("resumo global não consulta política", async () => {
    const { db, filters } = fixture();
    await loadEligibleAttendants(db, "org", now, { kind: "organization_summary" });
    expect(filters.some(([table]) => table === "channel_routing_policies")).toBe(false);
  });
  it("canal inexistente não autoriza fallback", async () => {
    const { db } = fixture({ channel_sessions: null });
    await expect(loadEligibleAttendants(db, "org", now, scope)).rejects.toThrow("routing_channel_invalid");
  });
  it("erro de banco não vira sem elegível", async () => {
    const { db } = fixture({ attendant_availability: new Error("offline") });
    await expect(loadEligibleAttendants(db, "org", now, scope)).rejects.toThrow("offline");
  });

  it("atendente com agenda ilegível fica de fora SOZINHO — os demais continuam entrando", async () => {
    // `attendant_availability` aceita INSERT/UPDATE de anon, authenticated E
    // service_role, então este é o ponto mais exposto dos três. Bia no cenário
    // não é enfeite: sem ela, `[]` passaria por acerto e a prova seria vazia —
    // o que se mede aqui é que um registro ruim não derruba a ORGANIZAÇÃO.
    const { db } = fixture({
      user_organizations: [{ user_id: "ana" }, { user_id: "bia" }],
      attendant_availability: [
        { user_id: "ana", capacity: 2, schedule: { timezone: "America/Asunción", windows: [] } },
        { user_id: "bia", capacity: 2, schedule: {} },
      ],
    });
    await expect(loadEligibleAttendants(db, "org", now, scope)).resolves.toMatchObject([{ userId: "bia" }]);
  });
});

const scopeComTime = { kind: "conversation_channel", channelSessionId: "channel", teamId: "time" } as const;

describe("elegibilidade restrita por time", () => {
  it("atendente fora do time não entra", async () => {
    const { db } = fixture({ attendance_team_members: [{ user_id: "bia" }] });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toEqual([]);
  });

  it("time sem membro é restrição explícita, não ausência de configuração", async () => {
    const { db } = fixture({ attendance_team_members: [] });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toEqual([]);
  });

  it("time fechado agora não tem elegível, mesmo com atendente disponível e no horário dele", async () => {
    // Janela só de segunda a sexta; `now` é domingo. É o caso Cancelamentos.
    const { db } = fixture({
      attendance_teams: {
        id: "time", archived_at: null,
        schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "18:00" }] },
      },
    });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toEqual([]);
  });

  it("time aberto agora devolve quem está nele", async () => {
    const { db } = fixture({
      attendance_teams: {
        id: "time", archived_at: null,
        schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 0, start: "08:00", end: "18:00" }] },
      },
    });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toMatchObject([{ userId: "ana" }]);
  });

  it("teto do time: quem já tem o máximo DAQUELE setor fica de fora, e a conversa espera", async () => {
    // Capacidade pessoal 10, teto do Suporte 2. Ana tem 2 no Suporte: cheia
    // para o time, embora sobre capacidade — a conversa NÃO vai para ela.
    const { db } = fixture({
      attendant_availability: [{ user_id: "ana", capacity: 10, schedule: {} }],
      attendance_teams: { id: "time", schedule: {}, archived_at: null, max_concurrent: 2 },
      conversations: [
        { assigned_to_user_id: "ana", team_id: "time" },
        { assigned_to_user_id: "ana", team_id: "time" },
      ],
    });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toEqual([]);
  });

  it("teto do time conta só o que é do time: conversa de OUTRO setor não ocupa vaga", async () => {
    const { db } = fixture({
      attendant_availability: [{ user_id: "ana", capacity: 10, schedule: {} }],
      attendance_teams: { id: "time", schedule: {}, archived_at: null, max_concurrent: 2 },
      conversations: [
        { assigned_to_user_id: "ana", team_id: "time" },
        { assigned_to_user_id: "ana", team_id: "outro-time" },
        { assigned_to_user_id: "ana", team_id: null },
      ],
    });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toMatchObject([
      { userId: "ana", currentLoad: 3 },
    ]);
  });

  it("sem teto no time (null), vale só a capacidade da pessoa — como sempre foi", async () => {
    const { db } = fixture({
      attendant_availability: [{ user_id: "ana", capacity: 10, schedule: {} }],
      attendance_teams: { id: "time", schedule: {}, archived_at: null, max_concurrent: null },
      conversations: Array.from({ length: 6 }, () => ({ assigned_to_user_id: "ana", team_id: "time" })),
    });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toMatchObject([{ userId: "ana" }]);
  });

  it("time arquivado não devolve ninguém", async () => {
    const { db } = fixture({ attendance_teams: { id: "time", schedule: {}, archived_at: "2026-01-01T00:00:00Z" } });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toEqual([]);
  });

  it("canal e time SOMAM: só quem está nos dois sobra", async () => {
    // O canal responde "por onde se fala"; o time, "sobre o quê". Quem está num
    // só dos dois não atende — sem esta prova, a interseção pode ser trocada
    // pela política do canal sozinha e a suíte inteira segue verde.
    const { db } = fixture({
      channel_routing_policies: { id: "policy" },
      channel_routing_responsibles: [{ user_id: "ana" }, { user_id: "bia" }],
      attendance_team_members: [{ user_id: "bia" }, { user_id: "carla" }],
      user_organizations: [{ user_id: "ana" }, { user_id: "bia" }, { user_id: "carla" }],
      attendant_availability: [
        { user_id: "ana", capacity: 2, schedule: {} },
        { user_id: "bia", capacity: 2, schedule: {} },
        { user_id: "carla", capacity: 2, schedule: {} },
      ],
    });
    expect(await loadEligibleAttendants(db, "org", now, scopeComTime)).toMatchObject([{ userId: "bia" }]);
  });

  it("time com agenda ilegível fecha, em vez de derrubar o roteamento", async () => {
    // A coluna é jsonb sem CHECK: `America/Asunción` grava e o parser recusa.
    // Fechado é VISÍVEL — a conversa espera na fila e a Central avisa quando as
    // tentativas esgotam. Lançar aqui pararia o worker inteiro, sem sintoma útil.
    const { db } = fixture({
      attendance_teams: {
        id: "time", archived_at: null,
        schedule: { timezone: "America/Asunción", windows: [] },
      },
    });
    await expect(loadEligibleAttendants(db, "org", now, scopeComTime)).resolves.toEqual([]);
  });

  it("sem time no escopo, nada muda — nenhuma consulta às tabelas de time", async () => {
    const { db, filters } = fixture();
    expect(await loadEligibleAttendants(db, "org", now, scope)).toMatchObject([{ userId: "ana" }]);
    expect(filters.some(([t]) => t === "attendance_teams" || t === "attendance_team_members")).toBe(false);
  });
});
