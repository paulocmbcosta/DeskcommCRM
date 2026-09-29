/**
 * `voice_calls` PELA REST: SÓ AS LINHAS DO WACALLS (migration 0288) — medido em
 * Postgres real, com o JWT de um membro, como o PostgREST chega.
 *
 * A policy de escrita da 0235 (`voice_calls_write`, `for all`, agent para cima)
 * nasceu quando a tabela era só do WaCalls. Desde a 0286 ela guarda também as
 * ligações do telefone (`provider = 'sip_trunk'`), que só o worker e a API gravam,
 * pela conexão direta. Com a policy antiga, um agent da organização forjava pela
 * REST o desfecho do menu (`menu_outcome`, `menu_digit`, `menu_id`) — e poluía os
 * "últimos 7 dias" do menu e o cartão da ligação na conversa (revisão de
 * segurança da fase 2, Task 26).
 *
 * O WaCalls CONTINUA escrevendo pela REST, com a sessão do usuário:
 * `app/api/v1/voice/calls/route.ts` (INSERT, e o UPDATE da reconciliação quando a
 * ponte chegou antes) e `app/api/v1/voice/calls/[id]/accept/route.ts` (UPDATE do
 * `owner_user_id`). Por isso a 0288 não revoga a escrita: ela
 *  (a) restringe a policy de escrita a `provider = 'wacalls'`, no `using` E no
 *      `with check` — a linha do telefone é só-leitura pela REST, e nenhuma linha
 *      do WaCalls vira do telefone;
 *  (b) põe um CHECK (`voice_calls_menu_so_no_telefone_check`): as colunas do menu
 *      e do aviso de instabilidade ficam nulas fora de `sip_trunk` — para todo
 *      mundo, a REST inclusive.
 *
 * Cada recusa vem com o seu controle positivo: o WaCalls grava como grava hoje, e
 * o worker (a conexão direta; e `service_role`, que ignora a RLS) grava a linha do
 * telefone com as colunas do menu.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";

const ORG_A = "c0de0288-7700-4000-8000-00000000000a";
const ORG_B = "c0de0288-7700-4000-8000-00000000000b";
const AGENTE = "c0de0288-7711-4000-8000-00000000000a";
const LEITOR = "c0de0288-7711-4000-8000-0000000000ee";
const TIME = "c0de0288-7722-4000-8000-00000000000a";
const FALA = "c0de0288-7733-4000-8000-00000000000a";
const MENU = "c0de0288-7744-4000-8000-00000000000a";
const NUMERO = "c0de0288-7755-4000-8000-00000000000a";
const LIGACAO_WACALLS = "c0de0288-7766-4000-8000-00000000000a";
const LIGACAO_SIP = "c0de0288-7766-4000-8000-0000000000ff";
const HASH = "b".repeat(64);
const CHECK = "voice_calls_menu_so_no_telefone_check";
const RLS = /new row violates row-level security policy/;

type Resultado = { linhas: number } | { erro: string };

/**
 * A DML como `authenticated` com o JWT de `usuario` (o PostgREST), dentro de uma
 * transação desfeita. `linhas`: quantas a DML alcançou; `erro`: a recusa do banco.
 */
function comoMembro(usuario: string, dml: string): Resultado {
  try {
    const saida = sql(`begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${usuario}"}', true);
      with w as (${dml} returning 1) select 'linhas=' || count(*) from w;
      rollback;`);
    const m = /linhas=(\d+)/.exec(saida);
    if (!m) throw new Error(`saída inesperada do psql: ${saida}`);
    return { linhas: Number(m[1]) };
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    return { erro: `${err instanceof Error ? err.message : String(err)}${typeof stderr === "string" ? stderr : ""}` };
  }
}
const comoAgente = (dml: string) => comoMembro(AGENTE, dml);

/** A mesma DML como o worker: a conexão direta (`postgres`) ou `service_role`, desfeita no fim. */
function comoServico(papel: "postgres" | "service_role", dml: string): Resultado {
  try {
    const saida = sql(`begin;
      ${papel === "service_role" ? "set local role service_role;" : ""}
      with w as (${dml} returning 1) select 'linhas=' || count(*) from w;
      rollback;`);
    const m = /linhas=(\d+)/.exec(saida);
    if (!m) throw new Error(`saída inesperada do psql: ${saida}`);
    return { linhas: Number(m[1]) };
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    return { erro: `${err instanceof Error ? err.message : String(err)}${typeof stderr === "string" ? stderr : ""}` };
  }
}

/** O INSERT que `app/api/v1/voice/calls/route.ts` faz — sem `provider`: o default é `wacalls`. */
const insertDoWacalls = (extra: { colunas?: string; valores?: string; org?: string } = {}) => `
  insert into public.voice_calls
    (organization_id, channel_session_id, wacalls_call_id, direction, peer_phone, status, created_by, owner_user_id
     ${extra.colunas ? `, ${extra.colunas}` : ""})
  values ('${extra.org ?? ORG_A}', '${NUMERO}', 'wa-rest-' || gen_random_uuid(), 'outbound', '+5561999990288',
          'starting', '${AGENTE}', '${AGENTE}' ${extra.valores ? `, ${extra.valores}` : ""})`;

/** A linha do telefone, como o worker a grava (lib/channels/telefonia/repositorio.ts). */
const insertDoTelefone = (colunas = "", valores = "") => `
  insert into public.voice_calls
    (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status ${colunas ? `, ${colunas}` : ""})
  values ('${ORG_A}', '${NUMERO}', 'sip_trunk', 'sip-rest-' || gen_random_uuid(), 'inbound', '+5561999990288',
          'ringing' ${valores ? `, ${valores}` : ""})`;

const linhas = (r: Resultado) => ("linhas" in r ? r.linhas : `erro: ${r.erro}`);
const erro = (r: Resultado) => ("erro" in r ? r.erro : `passou (${r.linhas} linha(s))`);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENTE}', 'voz-rest-0288-agente@invariant.test'), ('${LEITOR}', 'voz-rest-0288-leitor@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'voz-rest-0288-a', 'Voz REST 0288 A', 'Voz A'), ('${ORG_B}', 'voz-rest-0288-b', 'Voz REST 0288 B', 'Voz B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENTE}', '${ORG_A}', 'agent', now()), ('${LEITOR}', '${ORG_A}', 'viewer', now())
      on conflict do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${TIME}', '${ORG_A}', 'Suporte', 'suporte-voz-rest-0288')
      on conflict (id) do nothing;
    insert into public.phone_prompts
      (id, organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status)
    values ('${FALA}', '${ORG_A}', 'menu', 'Para Suporte, digite 1.', 'voz', 'eleven_multilingual_v2', '${HASH}',
            '${ORG_A}/${HASH}.ulaw', 1000, 'ready')
      on conflict (id) do nothing;
    insert into public.phone_menus (id, organization_id, name, prompt_id, default_team_id) values
      ('${MENU}', '${ORG_A}', 'Principal', '${FALA}', '${TIME}')
      on conflict (id) do nothing;
    insert into public.channel_sessions
      (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
       sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
    values ('${NUMERO}', '${ORG_A}', 'sip_trunk', '\\x00', 'STARTING', 'Voz REST 0288', '+556130007700',
            'voip.exemplo-voz-rest.com.br', 5060, 'udp', 'u-voz-rest', '\\x00')
      on conflict (id) do nothing;
    insert into public.voice_calls (id, organization_id, channel_session_id, wacalls_call_id, direction, peer_phone, status)
      values ('${LIGACAO_WACALLS}', '${ORG_A}', '${NUMERO}', 'wa-0288-existente', 'inbound', '+5561999990288', 'ringing')
      on conflict (id) do nothing;
    insert into public.voice_calls
      (id, organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status,
       team_id, menu_id, menu_digit, menu_outcome)
      values ('${LIGACAO_SIP}', '${ORG_A}', '${NUMERO}', 'sip_trunk', 'sip-0288-existente', 'inbound', '+5561999990288',
              'ended', '${TIME}', '${MENU}', '1', 'chosen')
      on conflict (id) do nothing;
  `);
});

describe("o WaCalls continua gravando pela REST, como hoje (controle positivo)", () => {
  it("agent INSERE a ligação que discou (o INSERT da rota, provider pelo default)", () => {
    expect(linhas(comoAgente(insertDoWacalls()))).toBe(1);
  });

  it("agent RECONCILIA a linha que a ponte gravou antes (o UPDATE da rota, pelo wacalls_call_id)", () => {
    expect(
      linhas(
        comoAgente(`update public.voice_calls
                       set direction = 'outbound', contact_id = null, created_by = '${AGENTE}',
                           owner_user_id = '${AGENTE}', updated_at = now()
                     where organization_id = '${ORG_A}' and wacalls_call_id = 'wa-0288-existente'`),
      ),
    ).toBe(1);
  });

  it("agent ATENDE (o UPDATE do owner_user_id da rota de aceitar)", () => {
    expect(
      linhas(
        comoAgente(`update public.voice_calls set owner_user_id = '${AGENTE}'
                     where organization_id = '${ORG_A}' and id = '${LIGACAO_WACALLS}' and owner_user_id is null`),
      ),
    ).toBe(1);
  });

  it("o critério de papel e de organização da 0235 continua: viewer não grava, e ninguém grava em outra organização", () => {
    expect(erro(comoMembro(LEITOR, insertDoWacalls()))).toMatch(RLS);
    expect(erro(comoAgente(insertDoWacalls({ org: ORG_B })))).toMatch(RLS);
  });
});

describe("a linha do TELEFONE é só-leitura pela REST (a policy vale só para provider = 'wacalls')", () => {
  it("agent não INSERE linha sip_trunk — nem com as colunas do menu, nem sem", () => {
    expect(erro(comoAgente(insertDoTelefone()))).toMatch(RLS);
    expect(
      erro(comoAgente(insertDoTelefone("menu_id, menu_digit, menu_outcome", `'${MENU}', '2', 'chosen'`))),
    ).toMatch(RLS);
  });

  it("agent não ALTERA a linha sip_trunk: forjar o desfecho do menu não alcança linha nenhuma", () => {
    expect(
      linhas(comoAgente(`update public.voice_calls set menu_outcome = 'default_invalid', menu_digit = null
                          where id = '${LIGACAO_SIP}'`)),
    ).toBe(0);
    expect(linhas(comoAgente(`update public.voice_calls set emergency_heard_at = now() where id = '${LIGACAO_SIP}'`))).toBe(0);
    expect(sql(`select menu_outcome || ':' || menu_digit from public.voice_calls where id = '${LIGACAO_SIP}';`)).toBe("chosen:1");
  });

  it("agent não APAGA a linha sip_trunk", () => {
    expect(linhas(comoAgente(`delete from public.voice_calls where id = '${LIGACAO_SIP}'`))).toBe(0);
  });

  it("agent não transforma uma linha do WaCalls em linha do telefone (o with check)", () => {
    expect(
      erro(comoAgente(`update public.voice_calls set provider = 'sip_trunk', sip_call_ref = 'forjada'
                        where id = '${LIGACAO_WACALLS}'`)),
    ).toMatch(RLS);
  });

  it("o membro continua LENDO a linha do telefone (a policy de leitura não mudou)", () => {
    expect(countAs(AGENTE, `select count(*) from public.voice_calls where id = '${LIGACAO_SIP}';`)).toBe(1);
  });
});

describe("as colunas do menu e do aviso ficam nulas fora de sip_trunk (CHECK, para todo mundo)", () => {
  it.each([
    ["menu_id", `'${MENU}'`],
    ["menu_digit", "'1'"],
    ["menu_outcome", "'chosen'"],
    ["emergency_heard_at", "now()"],
  ])("agent: INSERT do WaCalls com %s é recusado pelo CHECK", (coluna, valor) => {
    expect(erro(comoAgente(insertDoWacalls({ colunas: coluna, valores: valor })))).toContain(CHECK);
  });

  it("agent: UPDATE de uma linha do WaCalls pondo o desfecho do menu é recusado pelo CHECK", () => {
    expect(
      erro(comoAgente(`update public.voice_calls set menu_outcome = 'chosen' where id = '${LIGACAO_WACALLS}'`)),
    ).toContain(CHECK);
  });

  it("nem a conexão direta grava coluna do menu numa linha do WaCalls", () => {
    expect(
      erro(comoServico("postgres", `update public.voice_calls set menu_digit = '1' where id = '${LIGACAO_WACALLS}'`)),
    ).toContain(CHECK);
  });
});

describe("o worker continua gravando a linha do telefone com as colunas do menu (controle positivo)", () => {
  it.each(["postgres", "service_role"] as const)("%s: INSERT e UPDATE da linha sip_trunk com menu, tecla, desfecho e aviso", (papel) => {
    expect(
      linhas(
        comoServico(
          papel,
          insertDoTelefone("team_id, menu_id, menu_digit, menu_outcome, emergency_heard_at", `'${TIME}', '${MENU}', '3', 'chosen', now()`),
        ),
      ),
    ).toBe(1);
    expect(
      linhas(
        comoServico(
          papel,
          `update public.voice_calls set menu_digit = null, menu_outcome = 'default_no_input', emergency_heard_at = now()
            where organization_id = '${ORG_A}' and id = '${LIGACAO_SIP}'`,
        ),
      ),
    ).toBe(1);
  });
});

describe("o catálogo e o apêndice", () => {
  it("a policy de escrita exige provider = 'wacalls' no using E no with check, com o papel e a organização da 0235", () => {
    const [qual, withCheck] = sql(`select qual || E'\\n' || with_check from pg_policies
                                    where schemaname = 'public' and tablename = 'voice_calls' and policyname = 'voice_calls_write'
                                      and cmd = 'ALL';`).split("\n");
    for (const expr of [qual, withCheck]) {
      expect(expr).toContain("provider = 'wacalls'");
      expect(expr).toContain("fn_user_org_ids");
      expect(expr).toMatch(/fn_role_at_least\(organization_id, 'agent'/);
    }
  });

  it("voice_calls_write é a ÚNICA policy de escrita que alcança authenticated (outra permissiva a somaria)", () => {
    // Policies permissivas se somam por OU: uma segunda de INSERT/UPDATE/DELETE/ALL
    // para `authenticated` (ou `public`, que o inclui) devolveria a linha do telefone à REST.
    const consulta = `select policyname || ':' || cmd from pg_policies
                       where schemaname = 'public' and tablename = 'voice_calls'
                         and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
                         and permissive = 'PERMISSIVE'
                         and roles && array['authenticated', 'public']::name[]
                       order by 1;`;
    const escrita = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(escrita(sql(consulta))).toEqual(["voice_calls_write:ALL"]);
    // Controle: a consulta vê uma segunda policy de escrita (criada e desfeita).
    expect(
      escrita(
        sql(`begin;
          create policy voice_calls_sonda_insert on public.voice_calls for insert to authenticated with check (true);
          ${consulta}
          rollback;`),
      ).filter((l) => l.includes(":")),
    ).toEqual(["voice_calls_sonda_insert:INSERT", "voice_calls_write:ALL"]);
  });

  it("o CHECK existe e está VALIDADO", () => {
    expect(
      sql(`select convalidated from pg_constraint
            where conrelid = 'public.voice_calls'::regclass and conname = '${CHECK}' and contype = 'c';`),
    ).toBe("t");
  });

  it("clone com linha do WaCalls com coluna do menu: o bloco do apêndice a CURA antes do CHECK, e o CHECK nasce validado", () => {
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const rotulo = "-- ---- telefonia fase 2: URA e falas (migration 0288) ----";
    const inicio = baseline.indexOf(rotulo);
    const bloco = baseline.slice(inicio, baseline.indexOf("\n-- ---- ", inicio + rotulo.length));
    const trecho = (marca: string) => {
      const de = bloco.indexOf(`do ${marca}`);
      const ate = bloco.indexOf(`end ${marca};`);
      if (de === -1 || ate === -1) throw new Error(`bloco ${marca} não encontrado no apêndice da 0288`);
      return bloco.slice(de, ate + `end ${marca};`.length);
    };
    const saida = sql(`begin;
      alter table public.voice_calls drop constraint ${CHECK};
      update public.voice_calls set menu_outcome = 'chosen', menu_digit = '4', menu_id = '${MENU}',
             emergency_heard_at = now()
       where id = '${LIGACAO_WACALLS}';
      ${trecho("$chk_ligacoes$")}
      ${trecho("$validar$")}
      select 'curada=' || (menu_id is null and menu_digit is null and menu_outcome is null and emergency_heard_at is null)
        from public.voice_calls where id = '${LIGACAO_WACALLS}';
      select 'telefone=' || menu_outcome from public.voice_calls where id = '${LIGACAO_SIP}';
      select 'check=' || convalidated from pg_constraint
       where conrelid = 'public.voice_calls'::regclass and conname = '${CHECK}';
      rollback;`);
    expect(saida).toContain("curada=true");
    expect(saida).toContain("telefone=chosen");
    expect(saida).toContain("check=true");
  });
});
