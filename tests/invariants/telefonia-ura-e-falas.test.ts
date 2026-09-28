/**
 * A URA E AS FALAS DO TELEFONE NO BANCO (migration 0288) — medido em Postgres real.
 *
 * O que se prova, e por que cada um:
 *  1. ISOLAMENTO. As quatro tabelas novas (`phone_prompts`, `phone_settings`,
 *     `phone_menus`, `phone_menu_options`) nasceriam com CRUD inteiro para
 *     `authenticated` no Supabase real (default ACL). O que isola é a policy e o
 *     `revoke`. Medido como `authenticated` com o JWT de um membro — como
 *     `postgres` (rolbypassrls = t) não se mediria nada. Controle positivo: o
 *     membro de A lê as linhas de A.
 *  2. A REST SÓ LÊ. A escrita é da API (organização resolvida da sessão) e do
 *     worker, pela conexão direta; `anon`, `authenticated` e `service_role` não
 *     gravam nem na própria organização — `permission denied`, não "zero linhas".
 *  3. AS CATRACAS DO SCHEMA. O caminho do áudio amarrado a organização + hash (o
 *     worker escreve esse caminho no disco); tecla só 0–9; número aponta para time
 *     OU menu; opção e time padrão só levam a time da MESMA organização (FK
 *     composta); aviso de instabilidade coerente.
 *  4. O bucket é privado.
 *  5. O bloco do apêndice — lido do `baseline.sql` pelo rótulo, não copiado à mão
 *     — reaplica sem erro, CURA cada linha que violaria um CHECK novo e, sob o
 *     default ACL do Supabase (GRANT ALL aos três papéis da REST), devolve as
 *     tabelas a só-leitura. O `pnpm test:db` reproduz o default ACL para FUNÇÕES
 *     e não para TABELAS: sem simular o grant aqui, a prova do `revoke` passaria
 *     num banco onde o defeito não pode existir.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";

const ORG_A = "c0de0288-0000-4000-8000-00000000000a";
const ORG_B = "c0de0288-0000-4000-8000-00000000000b";
const USER_A = "c0de0288-1111-4000-8000-00000000000a";
const USER_B = "c0de0288-1111-4000-8000-00000000000b";
const TIME_A = "c0de0288-2222-4000-8000-00000000000a";
const TIME_B = "c0de0288-2222-4000-8000-00000000000b";
const FALA_A = "c0de0288-3333-4000-8000-00000000000a";
const FALA_B = "c0de0288-3333-4000-8000-00000000000b";
const MENU_A = "c0de0288-4444-4000-8000-00000000000a";
const MENU_B = "c0de0288-4444-4000-8000-00000000000b";
const NUMERO_A = "c0de0288-5555-4000-8000-00000000000a";
const HASH = "a".repeat(64);
const TABELAS = ["phone_prompts", "phone_settings", "phone_menus", "phone_menu_options"] as const;
const LISTA_SQL = TABELAS.map((t) => `'${t}'`).join(", ");
const PAPEIS_DA_REST = ["anon", "authenticated", "service_role"] as const;

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const ROTULO = "-- ---- telefonia fase 2: URA e falas (migration 0288) ----";

/** O bloco rotulado da 0288, do rótulo até o próximo rótulo de apêndice — o texto que o self-host aplica. */
function blocoDa0288(): string {
  const inicio = BASELINE.indexOf(ROTULO);
  if (inicio === -1) throw new Error("rótulo da 0288 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO, inicio + 1) !== -1) throw new Error("rótulo da 0288 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO.length);
  if (fim === -1) throw new Error("fim do bloco da 0288 não encontrado");
  return BASELINE.slice(inicio, fim);
}

/** `null` quando o comando passa; a mensagem do psql quando falha. */
function tenta(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    return `${err instanceof Error ? err.message : String(err)}${typeof stderr === "string" ? stderr : ""}`;
  }
}

/** Roda a DML como `papel` (com o JWT do membro de A, que é como a REST chega) e desfaz. */
function comoPapel(papel: (typeof PAPEIS_DA_REST)[number], dml: string): string | null {
  return tenta(`begin;
    set local role ${papel};
    select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', true);
    ${dml};
    rollback;`);
}

/** Os privilégios que os papéis da REST têm nas quatro tabelas, como o catálogo os conta. */
function privilegiosDaRest(): string[] {
  return sql(`
    select table_name || ':' || grantee || ':' || string_agg(privilege_type, ',' order by privilege_type)
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name in (${LISTA_SQL})
       and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
     group by table_name, grantee;`)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

const SO_LEITURA = TABELAS.flatMap((t) => [`${t}:authenticated:SELECT`, `${t}:service_role:SELECT`]).sort();

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'ura-0288-a@invariant.test'), ('${USER_B}', 'ura-0288-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'ura-0288-a', 'URA 0288 A', 'URA A'), ('${ORG_B}', 'ura-0288-b', 'URA 0288 B', 'URA B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'agent', now()), ('${USER_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${TIME_A}', '${ORG_A}', 'Suporte', 'suporte-0288'), ('${TIME_B}', '${ORG_B}', 'Suporte', 'suporte-0288')
      on conflict (id) do nothing;
    insert into public.phone_prompts
      (id, organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status)
    values
      ('${FALA_A}', '${ORG_A}', 'menu', 'Para Suporte, digite 1.', 'voz', 'eleven_multilingual_v2', '${HASH}',
       '${ORG_A}/${HASH}.ulaw', 1000, 'ready'),
      ('${FALA_B}', '${ORG_B}', 'menu', 'Para Suporte, digite 1.', 'voz', 'eleven_multilingual_v2', '${HASH}',
       '${ORG_B}/${HASH}.ulaw', 1000, 'ready')
      on conflict (id) do nothing;
    insert into public.phone_settings (organization_id, voice_id) values ('${ORG_A}', 'voz'), ('${ORG_B}', 'voz')
      on conflict (organization_id) do nothing;
    insert into public.phone_menus (id, organization_id, name, prompt_id, default_team_id) values
      ('${MENU_A}', '${ORG_A}', 'Principal', '${FALA_A}', '${TIME_A}'),
      ('${MENU_B}', '${ORG_B}', 'Principal', '${FALA_B}', '${TIME_B}')
      on conflict (id) do nothing;
    insert into public.phone_menu_options (organization_id, menu_id, digit, team_id) values
      ('${ORG_A}', '${MENU_A}', '1', '${TIME_A}'), ('${ORG_B}', '${MENU_B}', '1', '${TIME_B}')
      on conflict do nothing;
    insert into public.channel_sessions
      (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
       sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
    values ('${NUMERO_A}', '${ORG_A}', 'sip_trunk', '\\x00', 'STARTING', 'URA 0288', '+556130000288',
            'voip.exemplo-0288.com.br', 5060, 'udp', 'u0288', '\\x00')
      on conflict (id) do nothing;
  `);
});

describe("isolamento entre organizações (JWT de membro, como a REST)", () => {
  it.each(TABELAS)("%s: o membro de A lê as de A e ZERO de B; o de B, zero de A", (tabela) => {
    expect(countAs(USER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
    expect(countAs(USER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`)).toBe(0);
    expect(countAs(USER_B, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`)).toBe(0);
    expect(countAs(USER_B, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`)).toBeGreaterThan(0);
  });

  it("sem filtro de organização, o membro de A enxerga só a própria (sem porta dos fundos)", () => {
    expect(countAs(USER_A, "select count(distinct organization_id) from public.phone_prompts;")).toBe(1);
  });

  it("a leitura é a única policy: nenhuma ALL, nenhuma de escrita", () => {
    const policies = sql(`select tablename || ':' || policyname || ':' || cmd
                            from pg_policies where schemaname = 'public' and tablename in (${LISTA_SQL});`)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
    expect(policies).toEqual(TABELAS.map((t) => `${t}:tenant_isolation_${t}_select:SELECT`).sort());
  });
});

describe("a REST só lê — a escrita é da API e do worker", () => {
  const DMLS = [
    `update public.phone_prompts set "text" = 'x' where organization_id = '${ORG_A}'`,
    `insert into public.phone_menus (organization_id, name, default_team_id) values ('${ORG_A}', 'x', '${TIME_A}')`,
    `delete from public.phone_menu_options where organization_id = '${ORG_A}'`,
    `update public.phone_settings set voice_id = 'outra' where organization_id = '${ORG_A}'`,
    `insert into public.phone_prompts (organization_id, kind, "text", voice_id, model_id, content_hash, status)
       values ('${ORG_A}', 'menu', 'x', 'v', 'm', '${HASH}', 'failed')`,
  ];

  it.each(PAPEIS_DA_REST)("%s não grava em nenhuma das quatro tabelas", (papel) => {
    for (const dml of DMLS) expect(comoPapel(papel, dml)).toMatch(/permission denied/);
  });

  it("e nada mudou de fato", () => {
    expect(sql(`select count(*) from public.phone_prompts where "text" = 'x';`)).toBe("0");
    expect(sql(`select voice_id from public.phone_settings where organization_id = '${ORG_A}';`)).toBe("voz");
    expect(sql(`select count(*) from public.phone_menu_options where organization_id = '${ORG_A}';`)).toBe("1");
  });

  it("anon não lê; authenticated e service_role leem (controle positivo do GRANT)", () => {
    expect(comoPapel("anon", "select count(*) from public.phone_prompts")).toMatch(/permission denied/);
    expect(comoPapel("authenticated", "select count(*) from public.phone_prompts")).toBeNull();
    expect(comoPapel("service_role", "select count(*) from public.phone_prompts")).toBeNull();
  });
});

describe("as catracas do schema", () => {
  const insereFala = (valores: string) =>
    tenta(`insert into public.phone_prompts
      (organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status)
      values ${valores};`);

  it("kind e status fora do vocabulário são recusados", () => {
    expect(insereFala(`('${ORG_A}', 'musica', 't', 'v', 'm', '${HASH}', null, null, 'failed')`)).toContain(
      "phone_prompts_kind_check",
    );
    expect(insereFala(`('${ORG_A}', 'menu', 't', 'v', 'm', '${HASH}', null, null, 'gerando')`)).toContain(
      "phone_prompts_status_check",
    );
  });

  it("o hash é sha256 em hexadecimal minúsculo", () => {
    expect(insereFala(`('${ORG_A}', 'menu', 't', 'v', 'm', 'ABC', null, null, 'failed')`)).toContain(
      "phone_prompts_hash_check",
    );
  });

  it("o caminho do áudio é amarrado à organização e ao hash — nada de pasta de outra org", () => {
    expect(insereFala(`('${ORG_A}', 'menu', 't', 'v', 'm', '${HASH}', '${ORG_B}/${HASH}.ulaw', 10, 'ready')`)).toContain(
      "phone_prompts_storage_path_check",
    );
    expect(insereFala(`('${ORG_A}', 'menu', 't', 'v', 'm', '${HASH}', '../../etc/passwd', 10, 'ready')`)).toContain(
      "phone_prompts_storage_path_check",
    );
    // Controle positivo: o caminho certo passa.
    expect(insereFala(`('${ORG_A}', 'waiting', 't', 'v', 'm', '${HASH}', '${ORG_A}/${HASH}.ulaw', 10, 'ready')`)).toBeNull();
  });

  it("pronta sem arquivo é recusada; texto vazio e texto acima de 1000 também", () => {
    expect(insereFala(`('${ORG_A}', 'menu', 't', 'v', 'm', '${HASH}', null, null, 'ready')`)).toContain(
      "phone_prompts_ready_check",
    );
    expect(insereFala(`('${ORG_A}', 'menu', '', 'v', 'm', '${HASH}', null, null, 'failed')`)).toContain(
      "phone_prompts_text_check",
    );
    expect(insereFala(`('${ORG_A}', 'menu', repeat('a', 1001), 'v', 'm', '${HASH}', null, null, 'failed')`)).toContain(
      "phone_prompts_text_check",
    );
  });

  it("tecla só 0–9 (* e # ficam reservadas)", () => {
    expect(
      tenta(`insert into public.phone_menu_options (organization_id, menu_id, digit, team_id)
             values ('${ORG_A}', '${MENU_A}', '*', '${TIME_A}');`),
    ).toContain("phone_menu_options_digit_check");
  });

  it("a opção e o time padrão só levam a time da MESMA organização (FK composta)", () => {
    expect(
      tenta(`insert into public.phone_menu_options (organization_id, menu_id, digit, team_id)
             values ('${ORG_A}', '${MENU_A}', '2', '${TIME_B}');`),
    ).toMatch(/foreign key/);
    expect(
      tenta(`insert into public.phone_menus (organization_id, name, default_team_id) values ('${ORG_A}', 'x', '${TIME_B}');`),
    ).toMatch(/foreign key/);
    // E a opção não pendura em menu de outra organização.
    expect(
      tenta(`insert into public.phone_menu_options (organization_id, menu_id, digit, team_id)
             values ('${ORG_A}', '${MENU_B}', '3', '${TIME_A}');`),
    ).toMatch(/foreign key/);
  });

  it("o nome do menu não é vazio", () => {
    expect(
      tenta(`insert into public.phone_menus (organization_id, name, default_team_id) values ('${ORG_A}', '   ', '${TIME_A}');`),
    ).toContain("phone_menus_name_check");
  });

  it("o número aponta para um time OU um menu, nunca os dois", () => {
    expect(
      tenta(`update public.channel_sessions set sip_team_id = '${TIME_A}', sip_menu_id = '${MENU_A}' where id = '${NUMERO_A}';`),
    ).toContain("channel_sessions_sip_destino_check");
    expect(tenta(`update public.channel_sessions set sip_team_id = null, sip_menu_id = '${MENU_A}' where id = '${NUMERO_A}';`)).toBeNull();
  });

  it("aviso de instabilidade coerente: vence depois de ligar, e só há prazo com o aviso ligado", () => {
    expect(
      tenta(`update public.attendance_teams set phone_emergency_active_since = now(),
               phone_emergency_expires_at = now() - interval '1 minute' where id = '${TIME_A}';`),
    ).toContain("attendance_teams_phone_emergency_check");
    expect(
      tenta(`update public.attendance_teams set phone_emergency_active_since = null,
               phone_emergency_expires_at = now() + interval '1 hour' where id = '${TIME_A}';`),
    ).toContain("attendance_teams_phone_emergency_check");
    expect(
      tenta(`update public.attendance_teams set phone_emergency_active_since = now(),
               phone_emergency_expires_at = null where id = '${TIME_A}';`),
    ).toBeNull();
    sql(`update public.attendance_teams set phone_emergency_active_since = null, phone_emergency_expires_at = null
          where id = '${TIME_A}';`);
  });

  it("voice_calls: desfecho do menu e tecla dentro do vocabulário; emergency_heard_at existe", () => {
    const liga = (outcome: string, digito: string) =>
      tenta(`insert into public.voice_calls
               (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status,
                menu_id, menu_outcome, menu_digit, emergency_heard_at)
             values ('${ORG_A}', '${NUMERO_A}', 'sip_trunk', 'ref-0288-' || gen_random_uuid(), 'inbound',
                     '+5561999990288', 'ended', '${MENU_A}', ${outcome}, ${digito}, now());`);
    expect(liga("'talvez'", "null")).toContain("voice_calls_menu_outcome_check");
    expect(liga("'chosen'", "'#'")).toContain("voice_calls_menu_digit_check");
    expect(liga("'chosen'", "'2'")).toBeNull();
    expect(liga("null", "null")).toBeNull();
  });

  it("a Central aceita os dois avisos novos do telefone", () => {
    expect(
      tenta(`insert into public.agent_inbox_items (organization_id, kind, severity, title) values
               ('${ORG_A}', 'phone_prompt_unplayable', 'warn', 'fala'),
               ('${ORG_A}', 'phone_emergency_expired', 'info', 'aviso');`),
    ).toBeNull();
  });
});

describe("o bucket e o apêndice", () => {
  it("o bucket phone-prompts é PRIVADO e só aceita μ-law", () => {
    expect(
      sql(`select public::text || '|' || array_to_string(allowed_mime_types, ',')
             from storage.buckets where id = 'phone-prompts';`),
    ).toBe("false|audio/basic");
  });

  it("as quatro tabelas estão em só-leitura para a REST", () => {
    expect(privilegiosDaRest()).toEqual(SO_LEITURA);
  });

  it("reaplicar o bloco do apêndice não dá erro, e cura cada linha que violaria um CHECK", () => {
    const FALA_TORTA = "c0de0288-3333-4000-8000-0000000000ff";
    // Estado de um clone "bugado": cada CHECK derrubado à mão e uma linha que o viola.
    sql(`
      alter table public.channel_sessions drop constraint channel_sessions_sip_destino_check;
      update public.channel_sessions set sip_team_id = '${TIME_A}', sip_menu_id = '${MENU_A}' where id = '${NUMERO_A}';

      alter table public.attendance_teams drop constraint attendance_teams_phone_emergency_check;
      update public.attendance_teams set phone_emergency_active_since = null,
             phone_emergency_expires_at = now() + interval '1 hour' where id = '${TIME_B}';

      alter table public.phone_prompts drop constraint phone_prompts_storage_path_check;
      insert into public.phone_prompts
        (id, organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status)
      values ('${FALA_TORTA}', '${ORG_A}', 'nobody', 't', 'v', 'm', '${HASH}', '${ORG_B}/${HASH}.ulaw', 10, 'ready');

      alter table public.phone_menu_options drop constraint phone_menu_options_digit_check;
      insert into public.phone_menu_options (organization_id, menu_id, digit, team_id)
      values ('${ORG_A}', '${MENU_A}', '#', '${TIME_A}');

      alter table public.voice_calls drop constraint voice_calls_menu_outcome_check;
      insert into public.voice_calls
        (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status, menu_outcome)
      values ('${ORG_A}', '${NUMERO_A}', 'sip_trunk', 'ref-0288-torta', 'inbound', '+5561999990288', 'ended', 'talvez');
    `);

    expect(tenta(blocoDa0288())).toBeNull();

    expect(
      sql(`select coalesce(sip_team_id::text, '-') || '|' || coalesce(sip_menu_id::text, '-')
             from public.channel_sessions where id = '${NUMERO_A}';`),
    ).toBe(`${TIME_A}|-`);
    expect(
      sql(`select (phone_emergency_active_since is null and phone_emergency_expires_at is null)::text
             from public.attendance_teams where id = '${TIME_B}';`),
    ).toBe("true");
    expect(
      sql(`select status || '|' || coalesce(storage_path, '-') from public.phone_prompts where id = '${FALA_TORTA}';`),
    ).toBe("failed|-");
    expect(sql(`select count(*) from public.phone_menu_options where digit = '#';`)).toBe("0");
    expect(sql(`select count(*) from public.voice_calls where menu_outcome = 'talvez';`)).toBe("0");

    // As constraints voltaram — e UMA de cada, não duas.
    expect(
      sql(`select count(*) from pg_constraint where conname in (
             'channel_sessions_sip_destino_check', 'attendance_teams_phone_emergency_check',
             'phone_prompts_storage_path_check', 'phone_menu_options_digit_check', 'voice_calls_menu_outcome_check');`),
    ).toBe("5");
    expect(
      sql(`select count(*) from pg_policies
            where tablename in (${LISTA_SQL}) and policyname like 'tenant_isolation_%_select';`),
    ).toBe("4");
  });

  it("sob o default ACL do Supabase (GRANT ALL aos três papéis), o bloco devolve a REST a só-leitura", () => {
    // O que todo projeto Supabase faz com tabela nova em `public`. O `test:db`
    // não reproduz isso para TABELAS; sem este passo, o `revoke` seria provado
    // num banco onde a escrita pela REST nunca foi concedida.
    sql(`grant all on ${TABELAS.map((t) => `public.${t}`).join(", ")} to anon, authenticated, service_role;`);
    expect(privilegiosDaRest()).not.toEqual(SO_LEITURA);

    expect(tenta(blocoDa0288())).toBeNull();

    expect(privilegiosDaRest()).toEqual(SO_LEITURA);
    for (const papel of PAPEIS_DA_REST) {
      expect(comoPapel(papel, `delete from public.phone_prompts where organization_id = '${ORG_A}'`)).toMatch(
        /permission denied/,
      );
    }
  });
});
