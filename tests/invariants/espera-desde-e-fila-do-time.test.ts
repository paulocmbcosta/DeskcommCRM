import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ORG, GOV_SESSION, countAs, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Migration 0279 — `espera_desde` e a transferência para time que põe na fila.
 *
 * `espera_desde` é o que o termômetro do Inbox mostra: a PRIMEIRA mensagem do
 * cliente ainda sem resposta. Ela vive num trigger PL/pgSQL, invisível a
 * qualquer teste de TypeScript — um `create or replace` futuro, ou uma função de
 * ingestão que passe a gravar as colunas de outro jeito, a quebraria em silêncio
 * e o card voltaria a medir desde a última mensagem.
 */
const CONTATO = "dddddddd-3333-4000-8000-000000000279";
const CONVERSA = "dddddddd-4444-4000-8000-000000000279";
const TIME = "dddddddd-7777-4000-8000-000000000279";

function esperaDesde(): string {
  return lastLine(
    sql(`select coalesce(espera_desde::text, '(null)') from public.conversations where id = '${CONVERSA}';`),
  );
}

function mensagem(direcao: "inbound" | "outbound", em: string): void {
  sql(`select public.fn_mark_conversation_message('${CONVERSA}'::uuid, '${direcao}', 'x', '${em}'::timestamptz);`);
}

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.conversations where id = '${CONVERSA}';
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${GOV_ORG}', 'Contato da espera') on conflict do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug)
      values ('${TIME}', '${GOV_ORG}', 'Suporte 0279', 'suporte-0279') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${GOV_ORG}', '${CONTATO}', '${GOV_SESSION}', 'open');
  `);
});

describe("0279 — espera_desde é a primeira mensagem sem resposta", () => {
  it("conversa sem mensagem não espera", () => {
    expect(esperaDesde()).toBe("(null)");
  });

  it("a primeira entrada abre a espera", () => {
    mensagem("inbound", "2026-09-24 10:00:00+00");
    expect(esperaDesde()).toBe("2026-09-24 10:00:00+00");
  });

  it("a segunda entrada NÃO move a espera (o ponto da coluna)", () => {
    mensagem("inbound", "2026-09-24 10:09:00+00");
    expect(esperaDesde()).toBe("2026-09-24 10:00:00+00");
  });

  it("a resposta da empresa zera", () => {
    mensagem("outbound", "2026-09-24 10:12:00+00");
    expect(esperaDesde()).toBe("(null)");
  });

  it("a próxima entrada abre um ciclo NOVO, não herda o antigo", () => {
    mensagem("inbound", "2026-09-24 11:00:00+00");
    expect(esperaDesde()).toBe("2026-09-24 11:00:00+00");
  });

  it("encerrar o atendimento zera, e reabrir volta a esperar", () => {
    sql(`update public.conversations set status = 'closed' where id = '${CONVERSA}';`);
    expect(esperaDesde()).toBe("(null)");
    sql(`update public.conversations set status = 'open' where id = '${CONVERSA}';`);
    expect(esperaDesde()).toBe("2026-09-24 11:00:00+00");
  });
});

describe("0279 — transferir para um time põe a conversa na fila", () => {
  it("fn_conversation_set_team cala a IA e o comando vira 'aguardando'", () => {
    sql(`update public.conversations set bot_silenced_until = null, assigned_to_user_id = null where id = '${CONVERSA}';`);
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.fn_conversation_set_team('${GOV_ORG}'::uuid, '${CONVERSA}'::uuid, '${TIME}'::uuid)`,
      ),
    ).toBe(1);
    expect(
      lastLine(
        sql(
          `select bot_silenced_until::text || '|' || public.comando_da_conversa(c) || '|' || team_id
             from public.conversations c where id = '${CONVERSA}';`,
        ),
      ),
    ).toBe(`infinity|aguardando|${TIME}`);
  });

  it("tirar do time (null) não mexe no silêncio", () => {
    sql(`update public.conversations set bot_silenced_until = null where id = '${CONVERSA}';`);
    countAs(
      GOV_AGENT_A,
      `select count(*) from public.fn_conversation_set_team('${GOV_ORG}'::uuid, '${CONVERSA}'::uuid, null)`,
    );
    expect(
      lastLine(sql(`select coalesce(bot_silenced_until::text, '(null)') from public.conversations where id = '${CONVERSA}';`)),
    ).toBe("(null)");
  });
});
