/**
 * A TRANSFERÊNCIA DE LIGAÇÃO NO BANCO (migration 0290) — medido em Postgres real.
 *
 * O que se prova, e por que cada um:
 *  1. ISOLAMENTO. `voice_call_transfers` nasceria com CRUD inteiro para os
 *     papéis da REST (default ACL do Supabase, que o próprio baseline traz). O
 *     que isola é a policy de leitura e o `revoke`. Medido como `authenticated`
 *     com o JWT de um membro. Controle positivo: o membro de A lê as de A.
 *  2. A REST SÓ LÊ. A escrita é da API (organização da SESSÃO) e do worker, pela
 *     conexão direta: `anon`, `authenticated` e `service_role` não gravam nem na
 *     própria organização.
 *  3. UMA ABERTA POR LIGAÇÃO, no banco: dois cliques simultâneos em "Transferir"
 *     não abrem duas. Encerrada a primeira, a segunda abre.
 *  4. AS CATRACAS: destino pessoa OU time (exatamente um), consultada só para
 *     pessoa, desfecho só no fim e só do vocabulário.
 *  5. NENHUM PONTEIRO ATRAVESSA ORGANIZAÇÃO: a transferência de A não aponta para
 *     a ligação nem para o time de B — o banco recusa (FK composta).
 *  6. O bloco do apêndice — lido do `baseline.sql` pelo rótulo — reaplica sem
 *     erro e sem derrubar os CHECKs (mesmo oid).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";

const ORG_A = "c0de0290-0000-4000-8000-00000000000a";
const ORG_B = "c0de0290-0000-4000-8000-00000000000b";
const USER_A = "c0de0290-1111-4000-8000-00000000000a";
const USER_A2 = "c0de0290-1111-4000-8000-0000000000a2";
const USER_B = "c0de0290-1111-4000-8000-00000000000b";
const TIME_A = "c0de0290-2222-4000-8000-00000000000a";
const TIME_B = "c0de0290-2222-4000-8000-00000000000b";
const NUMERO_A = "c0de0290-5555-4000-8000-00000000000a";
const NUMERO_B = "c0de0290-5555-4000-8000-00000000000b";
const LIGACAO_A = "c0de0290-6666-4000-8000-00000000000a";
const LIGACAO_B = "c0de0290-6666-4000-8000-00000000000b";
const PAPEIS_DA_REST = ["anon", "authenticated", "service_role"] as const;

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const ROTULO = "-- ---- telefonia fase 2: transferência de ligação (migration 0290) ----";

function blocoDa0290(): string {
  const inicio = BASELINE.indexOf(ROTULO);
  if (inicio === -1) throw new Error("rótulo da 0290 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO, inicio + 1) !== -1) throw new Error("rótulo da 0290 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO.length);
  if (fim === -1) throw new Error("fim do bloco da 0290 não encontrado");
  return BASELINE.slice(inicio, fim);
}

function tenta(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    return `${err instanceof Error ? err.message : String(err)}${typeof stderr === "string" ? stderr : ""}`;
  }
}

function comoPapel(papel: (typeof PAPEIS_DA_REST)[number], dml: string): string | null {
  return tenta(`begin;
    set local role ${papel};
    select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', true);
    ${dml};
    rollback;`);
}

/** Insere como dono (é o caminho da API e do worker) e desfaz: `null` = aceito, senão a mensagem. */
function insereEDesfaz(valores: string, antes = ""): string | null {
  return tenta(`begin;
    ${antes}
    insert into public.voice_call_transfers
      (organization_id, voice_call_id, requested_by, from_user_id, to_user_id, to_team_id, kind, status, outcome, ended_at)
    values ${valores};
    rollback;`);
}

const CHECKS = [
  "voice_call_transfers_consultada_check",
  "voice_call_transfers_destino_check",
  "voice_call_transfers_kind_check",
  "voice_call_transfers_outcome_check",
  "voice_call_transfers_status_check",
];
const checks = () =>
  sql(`select conname || ':' || convalidated::text || ':' || oid from pg_constraint
        where contype = 'c' and conrelid = 'public.voice_call_transfers'::regclass order by conname;`)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'transf-0290-a@invariant.test'), ('${USER_A2}', 'transf-0290-a2@invariant.test'),
      ('${USER_B}', 'transf-0290-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'transf-0290-a', 'Transf 0290 A', 'Transf A'), ('${ORG_B}', 'transf-0290-b', 'Transf 0290 B', 'Transf B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'agent', now()), ('${USER_A2}', '${ORG_A}', 'agent', now()),
      ('${USER_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${TIME_A}', '${ORG_A}', 'Suporte', 'suporte-0290'), ('${TIME_B}', '${ORG_B}', 'Suporte', 'suporte-0290')
      on conflict (id) do nothing;
    insert into public.channel_sessions
      (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
       sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
    values ('${NUMERO_A}', '${ORG_A}', 'sip_trunk', '\\x00', 'STARTING', 'Transf A', '+556130000290',
            'voip.exemplo-0290.com.br', 5060, 'udp', 'u0290a', '\\x00'),
           ('${NUMERO_B}', '${ORG_B}', 'sip_trunk', '\\x00', 'STARTING', 'Transf B', '+556130000291',
            'voip.exemplo-0290.com.br', 5060, 'udp', 'u0290b', '\\x00')
      on conflict (id) do nothing;
    insert into public.voice_calls
      (id, organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status, owner_user_id, answered_at)
    values ('${LIGACAO_A}', '${ORG_A}', '${NUMERO_A}', 'sip_trunk', 'ref-0290-a', 'inbound', '+5561999990290', 'connected', '${USER_A}', now()),
           ('${LIGACAO_B}', '${ORG_B}', '${NUMERO_B}', 'sip_trunk', 'ref-0290-b', 'inbound', '+5561999990291', 'connected', '${USER_B}', now())
      on conflict (id) do nothing;
    insert into public.voice_call_transfers
      (organization_id, voice_call_id, requested_by, from_user_id, to_user_id, kind, status, outcome, ended_at)
    values ('${ORG_A}', '${LIGACAO_A}', '${USER_A}', '${USER_A}', '${USER_A2}', 'blind', 'ended', 'answered', now()),
           ('${ORG_B}', '${LIGACAO_B}', '${USER_B}', '${USER_B}', null, 'blind', 'ended', 'missed', now());
    update public.voice_call_transfers set to_team_id = '${TIME_B}' where organization_id = '${ORG_B}';
  `);
});

afterAll(() => {
  sql(`
    delete from public.voice_call_transfers where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.voice_calls where organization_id in ('${ORG_A}', '${ORG_B}');
  `);
});

describe("isolamento entre organizações (JWT de membro, como a REST)", () => {
  it("o membro de A lê as de A e ZERO de B; o de B, zero de A", () => {
    const de = (u: string, o: string) =>
      countAs(u, `select count(*) from public.voice_call_transfers where organization_id = '${o}';`);
    expect(de(USER_A, ORG_A)).toBeGreaterThan(0);
    expect(de(USER_A, ORG_B)).toBe(0);
    expect(de(USER_B, ORG_A)).toBe(0);
    expect(de(USER_B, ORG_B)).toBeGreaterThan(0);
  });

  it("a leitura é a única policy", () => {
    expect(
      sql(`select policyname || ':' || cmd from pg_policies
            where schemaname = 'public' and tablename = 'voice_call_transfers';`),
    ).toBe("tenant_isolation_voice_call_transfers_select:SELECT");
  });
});

describe("a REST só lê — a escrita é da API e do worker", () => {
  it.each(PAPEIS_DA_REST)("%s não grava", (papel) => {
    for (const dml of [
      `update public.voice_call_transfers set outcome = 'refused' where organization_id = '${ORG_A}'`,
      `delete from public.voice_call_transfers where organization_id = '${ORG_A}'`,
      `insert into public.voice_call_transfers (organization_id, voice_call_id, to_user_id, kind)
         values ('${ORG_A}', '${LIGACAO_A}', '${USER_A2}', 'blind')`,
    ]) {
      expect(comoPapel(papel, dml)).toMatch(/permission denied/);
    }
  });

  it("anon não lê; authenticated e service_role leem", () => {
    expect(comoPapel("anon", "select count(*) from public.voice_call_transfers")).toMatch(/permission denied/);
    expect(comoPapel("authenticated", "select count(*) from public.voice_call_transfers")).toBeNull();
    expect(comoPapel("service_role", "select count(*) from public.voice_call_transfers")).toBeNull();
  });
});

describe("uma aberta por ligação", () => {
  const aberta = `('${ORG_A}', '${LIGACAO_A}', '${USER_A}', '${USER_A}', '${USER_A2}', null, 'blind', 'open', null, null)`;

  it("a segunda aberta na mesma ligação é recusada", () => {
    expect(insereEDesfaz(`${aberta}, ${aberta}`)).toMatch(/voice_call_transfers_uma_aberta/);
  });

  it("encerrada a primeira, a próxima abre (controle positivo)", () => {
    expect(insereEDesfaz(aberta)).toBeNull();
  });
});

describe("as catracas do schema", () => {
  const linha = (to_user: string, to_team: string, kind: string, status: string, outcome: string, ended: string) =>
    `('${ORG_A}', '${LIGACAO_A}', '${USER_A}', '${USER_A}', ${to_user}, ${to_team}, '${kind}', '${status}', ${outcome}, ${ended})`;

  it("destino: nem os dois, nem nenhum", () => {
    expect(insereEDesfaz(linha(`'${USER_A2}'`, `'${TIME_A}'`, "blind", "open", "null", "null"))).toMatch(/destino_check/);
    expect(insereEDesfaz(linha("null", "null", "blind", "open", "null", "null"))).toMatch(/destino_check/);
    expect(insereEDesfaz(linha("null", `'${TIME_A}'`, "blind", "open", "null", "null"))).toBeNull();
  });

  it("consultada só para pessoa", () => {
    expect(insereEDesfaz(linha("null", `'${TIME_A}'`, "attended", "open", "null", "null"))).toMatch(/consultada_check/);
    expect(insereEDesfaz(linha(`'${USER_A2}'`, "null", "attended", "open", "null", "null"))).toBeNull();
  });

  it("desfecho só no fim, e só do vocabulário", () => {
    expect(insereEDesfaz(linha(`'${USER_A2}'`, "null", "blind", "open", "'answered'", "null"))).toMatch(/outcome_check/);
    expect(insereEDesfaz(linha(`'${USER_A2}'`, "null", "blind", "ended", "null", "now()"))).toMatch(/outcome_check/);
    expect(insereEDesfaz(linha(`'${USER_A2}'`, "null", "blind", "ended", "'talvez'", "now()"))).toMatch(/outcome_check/);
    expect(insereEDesfaz(linha(`'${USER_A2}'`, "null", "blind", "ended", "'returned'", "now()"))).toBeNull();
  });

  it("tipo fora do vocabulário é recusado", () => {
    expect(insereEDesfaz(linha(`'${USER_A2}'`, "null", "conferencia", "open", "null", "null"))).toMatch(/kind_check/);
  });
});

describe("nenhum ponteiro atravessa organização", () => {
  it("a transferência de A não aponta para a ligação de B", () => {
    expect(
      insereEDesfaz(`('${ORG_A}', '${LIGACAO_B}', '${USER_A}', '${USER_A}', '${USER_A2}', null, 'blind', 'open', null, null)`),
    ).toMatch(/foreign key/);
  });

  it("nem para o time de B", () => {
    expect(
      insereEDesfaz(`('${ORG_A}', '${LIGACAO_A}', '${USER_A}', '${USER_A}', null, '${TIME_B}', 'blind', 'open', null, null)`),
    ).toMatch(/foreign key/);
  });
});

describe("o bloco do apêndice", () => {
  it("reaplica sem erro e sem derrubar os CHECKs", () => {
    const antes = checks();
    expect(antes.map((l) => l.split(":")[0])).toEqual(CHECKS);
    expect(antes.every((l) => l.split(":")[1] === "true")).toBe(true);
    sql(blocoDa0290());
    expect(checks()).toEqual(antes);
  });

  it("sob o default ACL do Supabase (GRANT ALL), o bloco devolve a tabela a só-leitura", () => {
    sql("grant all on public.voice_call_transfers to anon, authenticated, service_role;");
    sql(blocoDa0290());
    const privilegios = sql(`
      select grantee || ':' || string_agg(privilege_type, ',' order by privilege_type)
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'voice_call_transfers'
         and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
       group by grantee order by grantee;`)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(privilegios).toEqual(["authenticated:SELECT", "service_role:SELECT"]);
  });
});
