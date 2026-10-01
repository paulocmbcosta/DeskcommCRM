/**
 * OS RAMAIS NO BANCO (migration 0291) — medido em Postgres real.
 *
 *  1. ISOLAMENTO e REST SÓ LEITURA em `phone_extensions` (como as tabelas da 0288).
 *  2. A NUMERAÇÃO: quem ganha papel de atendimento recebe o menor livre a partir
 *     de 201; viewer não recebe; perder o papel (viewer, revogado, removido)
 *     LIBERA o número, e o próximo a entrar pega o liberado.
 *  3. A CORRIDA: duas admissões simultâneas na mesma organização não disputam o
 *     mesmo número (trava por organização) — medido com duas sessões de verdade.
 *  4. A RÉGUA do número: 2 a 4 dígitos, sem começar por 0; único na organização,
 *     repetível entre organizações.
 *  5. O BACKFILL do bloco: quem já existia ganha ramal na ordem de entrada, e o
 *     bloco reaplica sem mudar nada.
 *  6. A LIGAÇÃO INTERNA em `voice_calls`: só ela fica sem número da empresa, e só
 *     na linha do telefone.
 *  7. As funções novas não são alcançáveis pela anon key.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";

const ORG_A = "c0de0291-0000-4000-8000-00000000000a";
const ORG_B = "c0de0291-0000-4000-8000-00000000000b";
const U = (n: number) => `c0de0291-1111-4000-8000-${String(n).padStart(12, "0")}`;
const NUMERO_A = "c0de0291-5555-4000-8000-00000000000a";

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const ROTULO = "-- ---- telefonia fase 2: ramais (migration 0291) ----";

function blocoDa0291(): string {
  const inicio = BASELINE.indexOf(ROTULO);
  if (inicio === -1) throw new Error("rótulo da 0291 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO, inicio + 1) !== -1) throw new Error("rótulo da 0291 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO.length);
  if (fim === -1) throw new Error("fim do bloco da 0291 não encontrado");
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

const ramal = (org: string, user: string) =>
  sql(`select coalesce((select "number" from public.phone_extensions where organization_id = '${org}' and user_id = '${user}'), '-');`);

function membro(org: string, user: string, papel: string) {
  sql(`insert into public.user_organizations (user_id, organization_id, role, accepted_at)
       values ('${user}', '${org}', '${papel}', now());`);
}

/** Roda o script numa sessão PRÓPRIA do psql, sem esperar — para medir a corrida. */
function emParalelo(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", [
      "exec", "-i", process.env.TEST_DB_CONTAINER!, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
    ]);
    let saida = "";
    let erro = "";
    p.stdout.on("data", (d) => (saida += String(d)));
    p.stderr.on("data", (d) => (erro += String(d)));
    p.on("close", (code) => (code === 0 ? resolve(saida) : reject(new Error(erro))));
    p.stdin.end(script);
  });
}

beforeAll(() => {
  const usuarios = Array.from({ length: 12 }, (_, i) => `('${U(i + 1)}', 'ramal-0291-${i + 1}@invariant.test')`).join(", ");
  sql(`
    insert into auth.users (id, email) values ${usuarios} on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'ramal-0291-a', 'Ramal 0291 A', 'Ramal A'), ('${ORG_B}', 'ramal-0291-b', 'Ramal 0291 B', 'Ramal B')
      on conflict (id) do nothing;
    insert into public.channel_sessions
      (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
       sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
    values ('${NUMERO_A}', '${ORG_A}', 'sip_trunk', '\\x00', 'STARTING', 'Ramal A', '+556130000292',
            'voip.exemplo-0291.com.br', 5060, 'udp', 'u0291', '\\x00')
      on conflict (id) do nothing;
  `);
});

afterAll(() => {
  sql(`delete from public.voice_calls where organization_id in ('${ORG_A}', '${ORG_B}');`);
});

describe("a numeração automática", () => {
  it("agente ganha 201, o seguinte 202; viewer não ganha", () => {
    membro(ORG_A, U(1), "agent");
    membro(ORG_A, U(2), "admin");
    membro(ORG_A, U(3), "viewer");
    expect(ramal(ORG_A, U(1))).toBe("201");
    expect(ramal(ORG_A, U(2))).toBe("202");
    expect(ramal(ORG_A, U(3))).toBe("-");
  });

  it("viewer promovido ganha; rebaixado libera; revogado libera; o próximo pega o menor livre", () => {
    sql(`update public.user_organizations set role = 'agent' where organization_id = '${ORG_A}' and user_id = '${U(3)}';`);
    expect(ramal(ORG_A, U(3))).toBe("203");
    sql(`update public.user_organizations set role = 'viewer' where organization_id = '${ORG_A}' and user_id = '${U(1)}';`);
    expect(ramal(ORG_A, U(1))).toBe("-");
    membro(ORG_A, U(4), "manager");
    expect(ramal(ORG_A, U(4))).toBe("201");
    sql(`update public.user_organizations set revoked_at = now() where organization_id = '${ORG_A}' and user_id = '${U(2)}';`);
    expect(ramal(ORG_A, U(2))).toBe("-");
    sql(`delete from public.user_organizations where organization_id = '${ORG_A}' and user_id = '${U(3)}';`);
    expect(ramal(ORG_A, U(3))).toBe("-");
    membro(ORG_A, U(5), "agent");
    expect(ramal(ORG_A, U(5))).toBe("202");
  });

  it("a outra organização tem a sua própria numeração", () => {
    membro(ORG_B, U(6), "agent");
    expect(ramal(ORG_B, U(6))).toBe("201");
  });

  it("número trocado à mão não é reusado; o próximo pula para o seguinte livre", () => {
    sql(`update public.phone_extensions set "number" = '203' where organization_id = '${ORG_A}' and user_id = '${U(4)}';`);
    membro(ORG_A, U(7), "agent");
    expect(ramal(ORG_A, U(7))).toBe("201");
    membro(ORG_A, U(8), "agent");
    expect(ramal(ORG_A, U(8))).toBe("204");
  });

  it("duas admissões SIMULTÂNEAS não disputam o mesmo número", async () => {
    const livre = sql(`select public.fn_proximo_ramal('${ORG_A}');`);
    const admissao = (u: string) => `begin;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ('${u}', '${ORG_A}', 'agent', now());
      select pg_sleep(0.5);
      commit;`;
    await Promise.all([emParalelo(admissao(U(9))), emParalelo(admissao(U(10)))]);
    const numeros = [ramal(ORG_A, U(9)), ramal(ORG_A, U(10))].sort();
    expect(numeros[0]).toBe(livre);
    expect(numeros[0]).not.toBe(numeros[1]);
    expect(numeros.every((n) => /^\d+$/.test(n))).toBe(true);
  });
});

describe("a régua do número", () => {
  const troca = (n: string) =>
    tenta(`begin; update public.phone_extensions set "number" = '${n}' where organization_id = '${ORG_A}' and user_id = '${U(4)}'; rollback;`);

  it("2 a 4 dígitos, sem começar por 0", () => {
    expect(troca("20")).toBeNull();
    expect(troca("9999")).toBeNull();
    expect(troca("0201")).toMatch(/phone_extensions_number_check/);
    expect(troca("01")).toMatch(/phone_extensions_number_check/);
    expect(troca("7")).toMatch(/phone_extensions_number_check/);
    expect(troca("12345")).toMatch(/phone_extensions_number_check/);
    expect(troca("2a1")).toMatch(/phone_extensions_number_check/);
  });

  it("único na organização", () => {
    expect(troca(ramal(ORG_A, U(7)))).toMatch(/duplicate key/);
  });
});

describe("isolamento e REST só leitura", () => {
  it("o membro de A lê os ramais de A e zero de B", () => {
    expect(countAs(U(4), `select count(*) from public.phone_extensions where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
    expect(countAs(U(4), `select count(*) from public.phone_extensions where organization_id = '${ORG_B}';`)).toBe(0);
  });

  it.each(["anon", "authenticated", "service_role"])("%s não grava", (papel) => {
    const r = tenta(`begin; set local role ${papel};
      select set_config('request.jwt.claims', '{"sub":"${U(4)}"}', true);
      update public.phone_extensions set "number" = '999' where organization_id = '${ORG_A}';
      rollback;`);
    expect(r).toMatch(/permission denied/);
  });

  it("anon não chama as funções novas", () => {
    expect(tenta(`begin; set local role anon; select public.fn_proximo_ramal('${ORG_A}'); rollback;`)).toMatch(/permission denied/);
    expect(sql(`select has_function_privilege('anon', 'public.fn_ramal_por_papel()', 'execute')::text;`)).toBe("false");
  });
});

describe("o backfill do bloco", () => {
  it("quem existia sem ramal ganha, na ordem de entrada; reaplicar não muda nada", () => {
    sql(`alter table public.user_organizations disable trigger trg_ramal_por_papel;
         insert into public.user_organizations (user_id, organization_id, role, accepted_at, created_at) values
           ('${U(11)}', '${ORG_B}', 'agent', now(), now() - interval '2 days'),
           ('${U(12)}', '${ORG_B}', 'viewer', now(), now() - interval '1 day');
         alter table public.user_organizations enable trigger trg_ramal_por_papel;`);
    expect(ramal(ORG_B, U(11))).toBe("-");
    sql(blocoDa0291());
    expect(ramal(ORG_B, U(11))).toBe("202");
    expect(ramal(ORG_B, U(12))).toBe("-");
    const antes = sql(`select string_agg(user_id || ':' || "number", ',' order by user_id) from public.phone_extensions;`);
    sql(blocoDa0291());
    expect(sql(`select string_agg(user_id || ':' || "number", ',' order by user_id) from public.phone_extensions;`)).toBe(antes);
  });
});

describe("a ligação interna em voice_calls", () => {
  const insere = (colunas: string) =>
    tenta(`begin;
      insert into public.voice_calls (organization_id, provider, sip_call_ref, peer_phone, status, ${colunas.split("|")[0]})
      values ('${ORG_A}', 'sip_trunk', 'ref-' || gen_random_uuid(), '201', 'starting', ${colunas.split("|")[1]});
      rollback;`);

  it("a interna nasce sem número da empresa", () => {
    expect(insere(`direction, peer_user_id|'internal', '${U(4)}'`)).toBeNull();
  });

  it("a feita e a recebida continuam exigindo o número", () => {
    expect(insere(`direction|'outbound'`)).toMatch(/voice_calls_canal_ou_interna_check/);
  });

  it("interna só na linha do telefone", () => {
    const r = tenta(`begin;
      insert into public.voice_calls (organization_id, provider, wacalls_call_id, peer_phone, status, direction)
      values ('${ORG_A}', 'wacalls', 'w-0291', '201', 'starting', 'internal');
      rollback;`);
    expect(r).toMatch(/check constraint/);
  });

  it("direção fora do vocabulário é recusada", () => {
    expect(insere(`direction, channel_session_id|'lateral', '${NUMERO_A}'`)).toMatch(/voice_calls_direction_check/);
  });
});
