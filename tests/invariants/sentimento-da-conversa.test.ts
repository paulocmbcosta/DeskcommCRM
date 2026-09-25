import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Migration 0280 — o sentimento da conversa, para a equipe ver.
 *
 * A regra mora em PL/pgSQL (`fn_registrar_sentimento_da_conversa` e o trigger de
 * encerramento), invisível a teste de TypeScript: um `create or replace` futuro
 * que trocasse o `least` por atribuição apagaria o "pior momento" do card sem
 * nenhum teste de tela perceber.
 */
const CONTATO = "dddddddd-3333-4000-8000-000000000280";
const CONVERSA = "dddddddd-4444-4000-8000-000000000280";

function estado(): string {
  return lastLine(
    sql(
      `select coalesce(sentimento_atual::text,'-') || '|' || coalesce(sentimento_minimo::text,'-')
         from public.conversations where id = '${CONVERSA}';`,
    ),
  );
}

function nota(score: number, em: string): void {
  sql(
    `select public.fn_registrar_sentimento_da_conversa('${GOV_ORG}'::uuid, '${CONVERSA}'::uuid, ${score}, '${em}'::timestamptz);`,
  );
}

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.conversations where id = '${CONVERSA}';
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${GOV_ORG}', 'Contato do sentimento') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, service_started_at)
      values ('${CONVERSA}', '${GOV_ORG}', '${CONTATO}', '${GOV_SESSION}', 'open', '2026-09-25 09:00:00+00');
  `);
});

describe("0280 — sentimento atual e o pior momento do atendimento", () => {
  it("sem nota, sem sentimento", () => {
    expect(estado()).toBe("-|-");
  });

  it("a primeira nota vira atual e mínimo", () => {
    nota(0.5, "2026-09-25 10:00:00+00");
    expect(estado()).toBe("0.500|0.500");
  });

  it("a nota que cai derruba os dois; a que sobe muda só o atual", () => {
    nota(0.12, "2026-09-25 10:01:00+00");
    expect(estado()).toBe("0.120|0.120");
    nota(0.7, "2026-09-25 10:02:00+00");
    expect(estado()).toBe("0.700|0.120");
  });

  it("nota fora de ordem (mensagem mais antiga) entra no mínimo, não no atual", () => {
    nota(0.05, "2026-09-25 09:30:00+00");
    expect(estado()).toBe("0.700|0.050");
  });

  it("nota de mensagem ANTERIOR ao atendimento é ignorada", () => {
    nota(0.01, "2026-09-25 08:00:00+00");
    expect(estado()).toBe("0.700|0.050");
  });

  it("nota fora da faixa 0..1 é ignorada", () => {
    nota(1.5, "2026-09-25 10:03:00+00");
    expect(estado()).toBe("0.700|0.050");
  });

  it("encerrar zera, e nota atrasada não reacende a conversa encerrada", () => {
    sql(`update public.conversations set status = 'closed' where id = '${CONVERSA}';`);
    expect(estado()).toBe("-|-");
    nota(0.1, "2026-09-25 10:04:00+00");
    expect(estado()).toBe("-|-");
  });

  it("a função não é alcançável por quem usa o app", () => {
    const acl = lastLine(
      sql(`select has_function_privilege('authenticated',
             'public.fn_registrar_sentimento_da_conversa(uuid,uuid,numeric,timestamptz)', 'execute')::text
          || '|' || has_function_privilege('anon',
             'public.fn_registrar_sentimento_da_conversa(uuid,uuid,numeric,timestamptz)', 'execute')::text;`),
    );
    expect(acl).toBe("false|false");
  });
});
