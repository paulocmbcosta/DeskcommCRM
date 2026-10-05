import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * O ENCERRAMENTO REGISTRA ASSUNTO E RESUMO, E A REGRA MORA NO BANCO (migration 0293).
 *
 * ═══ O que este arquivo prova ═══
 *
 * 1. `atendimento_assuntos` não vaza entre organizações e não tem porta de
 *    escrita pela REST — nem para `service_role`.
 * 2. O cadastro (`fn_save_atendimento_assunto` / `fn_archive_atendimento_assunto`)
 *    recusa `agent`, recusa time de outra organização, não duplica nome e
 *    REATIVA o nome arquivado em vez de criar um gêmeo.
 * 3. `fn_atendimento_encerrar` é a porta única: com os interruptores desligados
 *    fecha como sempre fechou; ligados, recusa o que falta — e a conversa SEGUE
 *    ABERTA depois da recusa.
 * 4. Omitir não apaga: reabrir e fechar de novo preserva o registro. Quem chega
 *    depois de a conversa já estar fechada não sobrescreve o registro de quem
 *    fechou.
 * 5. O resumo NÃO vai para o payload do evento; o assunto vai.
 * 6. Anonimizar o contato zera o resumo e preserva o assunto.
 * 7. `fn_metricas_de_assuntos` conta por organização e período, e é só de serviço.
 *
 * Todo caso que escreve depois do seed roda em `begin … rollback`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

/** `-q` tira o COMMAND TAG (`BEGIN`/`ROLLBACK`) do stdout. */
function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-q", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function erroAoRodar(script: string): string {
  try {
    sql(script);
    return "";
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return String(e.stderr ?? e.message ?? err);
  }
}

const linhas = (out: string) => out.split("\n").filter((l) => l.startsWith("@@")).map((l) => l.slice(2));

const ORG_A = "a2930000-0000-4000-8000-0000000000a1";
const ORG_B = "a2930000-0000-4000-8000-0000000000b1";
const ANA = "a2930000-0000-4000-8000-0000000000a2"; // agent de A
const BIA = "a2930000-0000-4000-8000-0000000000a3"; // manager de A
const BETO = "a2930000-0000-4000-8000-0000000000b2"; // manager de B
const SESSAO_A = "a2930000-0000-4000-8000-0000000000a4";
const SESSAO_B = "a2930000-0000-4000-8000-0000000000b4";
const CONTATO_A = "a2930000-0000-4000-8000-0000000000a5";
const CONTATO_A2 = "a2930000-0000-4000-8000-0000000000a6";
const CONTATO_B = "a2930000-0000-4000-8000-0000000000b5";
const TIME_SUPORTE = "a2930000-0000-4000-8000-0000000000a7";
const TIME_COBRANCA = "a2930000-0000-4000-8000-0000000000a8";
const TIME_B = "a2930000-0000-4000-8000-0000000000b7";
const WIFI = "a2930000-0000-4000-8000-0000000000c1"; // Suporte, ativo
const ANTIGO = "a2930000-0000-4000-8000-0000000000c2"; // Suporte, arquivado
const BOLETO = "a2930000-0000-4000-8000-0000000000c3"; // Cobrança, ativo
const ASSUNTO_B = "a2930000-0000-4000-8000-0000000000c4"; // da organização B
const GRUPO = "a2930000-0000-4000-8000-0000000000d1";

const jwt = (user: string) =>
  `set role authenticated; select set_config('request.jwt.claims', '{"sub":"${user}"}', false);`;

/** Liga/desliga os interruptores da organização A. */
const interruptores = (assunto: boolean, resumo: boolean) => `
  update public.organizations
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('atendimento',
           jsonb_build_object('encerramento', jsonb_build_object('exigir_assunto', ${assunto}, 'exigir_resumo', ${resumo})))
   where id = '${ORG_A}';`;

const texto = (v: string | null) => (v === null ? "null" : `'${v}'`);

const encerrar = (conversa: string, ator: string, assunto: string | null, resumo: string | null, status = "closed") =>
  `public.fn_atendimento_encerrar('${ORG_A}', '${conversa}', null, '${ator}', ${assunto === null ? "null" : `'${assunto}'`}, ${texto(resumo)}, '${status}')`;

/**
 * A chamada PRECISA ser recusada com esta mensagem — e o script continua depois
 * dela, que é o que deixa medir o estado da conversa APÓS a recusa. Se a função
 * não recusar, `NAO_RECUSOU` (P0001) escapa do `when` e derruba o caso.
 */
const recusa = (mensagem: string, chamada: string) => `
  do $recusa$
  begin
    perform ${chamada};
    raise exception 'NAO_RECUSOU';
  exception when sqlstate '22023' then
    if sqlerrm <> '${mensagem}' then raise; end if;
  end $recusa$;`;

const conversaDe = (org: string, contato: string) =>
  sql(`select id from public.conversations where organization_id='${org}' and contact_id='${contato}' and not is_group;`);

const registro = (conversa: string) => `
  select '@@' || c.status || '|' || coalesce(a.assunto_id::text, 'NULO') || '|' || coalesce(a.closure_summary, 'NULO') || '|' || coalesce(a.closed_by_name, 'NULO')
    from public.conversations c
    join public.atendimentos a on a.conversation_id = c.id
   where c.id = '${conversa}'
   order by a.started_at desc limit 1;`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ANA}',  'ana-0293@invariant.test',  '{"full_name":"Ana Atendente"}'),
      ('${BIA}',  'bia-0293@invariant.test',  '{"full_name":"Bia Gestora"}'),
      ('${BETO}', 'beto-0293@invariant.test', '{"full_name":"Beto Vizinho"}')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-0293-a', 'Org A 0293', 'Org A 0293'),
      ('${ORG_B}', 'inv-0293-b', 'Org B 0293', 'Org B 0293')
      on conflict (id) do nothing;
    update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"all"}'::jsonb
     where id in ('${ORG_A}', '${ORG_B}');
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ANA}',  '${ORG_A}', 'agent',   now()),
      ('${BIA}',  '${ORG_A}', 'manager', now()),
      ('${BETO}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status) values
      ('${SESSAO_A}', '${ORG_A}', 'inv-0293-a', '\\x00'::bytea, 'WORKING'),
      ('${SESSAO_B}', '${ORG_B}', 'inv-0293-b', '\\x00'::bytea, 'WORKING')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name, phone_number) values
      ('${CONTATO_A}',  '${ORG_A}', 'Cliente A',  '+5561900002931'),
      ('${CONTATO_A2}', '${ORG_A}', 'Cliente A2', '+5561900002932'),
      ('${CONTATO_B}',  '${ORG_B}', 'Cliente B',  '+5561900002933')
      on conflict (id) do nothing;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${TIME_SUPORTE}',  '${ORG_A}', 'Suporte',  'suporte'),
      ('${TIME_COBRANCA}', '${ORG_A}', 'Cobrança', 'cobranca'),
      ('${TIME_B}',        '${ORG_B}', 'Vendas',   'vendas')
      on conflict (id) do nothing;
    insert into public.atendimento_assuntos (id, organization_id, team_id, name, archived_at) values
      ('${WIFI}',      '${ORG_A}', '${TIME_SUPORTE}',  'Wi-Fi',  null),
      ('${ANTIGO}',    '${ORG_A}', '${TIME_SUPORTE}',  'Antigo', now()),
      ('${BOLETO}',    '${ORG_A}', '${TIME_COBRANCA}', 'Boleto', null),
      ('${ASSUNTO_B}', '${ORG_B}', '${TIME_B}',        'Plano',  null)
      on conflict (id) do nothing;
    select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_A}',  '${SESSAO_A}');
    select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_A2}', '${SESSAO_A}');
    select public.fn_upsert_wa_conversation('${ORG_B}', '${CONTATO_B}',  '${SESSAO_B}');
  `);
});

describe("atendimento_assuntos: isolamento e porta de escrita", () => {
  it("o vizinho lê zero assuntos da organização A; quem é de A lê os seus", () => {
    const out = linhas(
      sql(`
        begin;
        ${jwt(BETO)}
        select '@@' || count(*) filter (where organization_id = '${ORG_A}') || '|' || count(*) from public.atendimento_assuntos;
        reset role;
        ${jwt(ANA)}
        select '@@' || count(*) filter (where organization_id = '${ORG_A}') || '|' || count(*) from public.atendimento_assuntos;
        rollback;
      `),
    );
    expect(out[0]).toBe("0|1");
    expect(out[1]).toBe("3|3");
  });

  it.each(["authenticated", "service_role", "anon"])("%s não escreve na tabela pela REST", (papel) => {
    const prelude = papel === "authenticated" ? jwt(BIA) : `set role ${papel};`;
    const erro = erroAoRodar(`
      begin;
      ${prelude}
      insert into public.atendimento_assuntos (organization_id, team_id, name) values ('${ORG_A}', '${TIME_SUPORTE}', 'Por fora');
      rollback;
    `);
    expect(erro).toMatch(/permission denied/);
  });

  it("a FK composta recusa assunto pendurado no time de outra organização", () => {
    const erro = erroAoRodar(`
      begin;
      insert into public.atendimento_assuntos (organization_id, team_id, name) values ('${ORG_A}', '${TIME_B}', 'Cruzado');
      rollback;
    `);
    expect(erro).toMatch(/foreign key/);
  });
});

describe("o cadastro de assuntos", () => {
  it("agent não cadastra nem arquiva", () => {
    expect(
      erroAoRodar(`begin; ${jwt(ANA)} select public.fn_save_atendimento_assunto('${ORG_A}', '${TIME_SUPORTE}', null, 'Novo'); rollback;`),
    ).toMatch(/assunto_forbidden/);
    expect(
      erroAoRodar(`begin; ${jwt(ANA)} select public.fn_archive_atendimento_assunto('${ORG_A}', '${WIFI}', true); rollback;`),
    ).toMatch(/assunto_forbidden/);
  });

  it("manager cadastra, renomeia e arquiva", () => {
    const out = linhas(
      sql(`
        begin;
        ${jwt(BIA)}
        select '@@' || (public.fn_save_atendimento_assunto('${ORG_A}', '${TIME_SUPORTE}', null, '  Lentidão  ')->>'name');
        select '@@' || (public.fn_save_atendimento_assunto('${ORG_A}', '${TIME_SUPORTE}', '${WIFI}', 'Wi-Fi e senha')->>'name');
        select '@@' || (public.fn_archive_atendimento_assunto('${ORG_A}', '${WIFI}', true)->>'archived');
        reset role;
        select '@@' || name || '|' || (archived_at is not null) from public.atendimento_assuntos where id = '${WIFI}';
        rollback;
      `),
    );
    expect(out).toEqual(["Lentidão", "Wi-Fi e senha", "true", "Wi-Fi e senha|true"]);
  });

  it("nome repetido no mesmo time é recusado, sem diferenciar maiúscula nem espaço", () => {
    const erro = erroAoRodar(
      `begin; ${jwt(BIA)} select public.fn_save_atendimento_assunto('${ORG_A}', '${TIME_SUPORTE}', null, '  wi-fi '); rollback;`,
    );
    expect(erro).toMatch(/assunto_duplicado/);
  });

  it("o mesmo nome em OUTRO time é permitido", () => {
    const out = linhas(
      sql(`begin; ${jwt(BIA)} select '@@' || (public.fn_save_atendimento_assunto('${ORG_A}', '${TIME_COBRANCA}', null, 'Wi-Fi')->>'name'); rollback;`),
    );
    expect(out[0]).toBe("Wi-Fi");
  });

  it("criar um nome arquivado REATIVA o mesmo assunto", () => {
    const out = linhas(
      sql(`
        begin;
        ${jwt(BIA)}
        select '@@' || (public.fn_save_atendimento_assunto('${ORG_A}', '${TIME_SUPORTE}', null, 'antigo')->>'id');
        reset role;
        select '@@' || (archived_at is null) || '|' || count(*) over () from public.atendimento_assuntos
         where team_id = '${TIME_SUPORTE}' and lower(name) = 'antigo';
        rollback;
      `),
    );
    expect(out[0]).toBe(ANTIGO);
    expect(out[1]).toBe("true|1");
  });

  it("recusa time de outra organização, organização alheia e renomear por outro time", () => {
    expect(
      erroAoRodar(`begin; ${jwt(BIA)} select public.fn_save_atendimento_assunto('${ORG_A}', '${TIME_B}', null, 'X'); rollback;`),
    ).toMatch(/assunto_team_not_found/);
    expect(
      erroAoRodar(`begin; ${jwt(BIA)} select public.fn_save_atendimento_assunto('${ORG_B}', '${TIME_B}', null, 'X'); rollback;`),
    ).toMatch(/assunto_forbidden/);
    expect(
      erroAoRodar(`begin; ${jwt(BIA)} select public.fn_save_atendimento_assunto('${ORG_A}', '${TIME_COBRANCA}', '${WIFI}', 'X'); rollback;`),
    ).toMatch(/assunto_not_found/);
    expect(
      erroAoRodar(`begin; ${jwt(BETO)} select public.fn_archive_atendimento_assunto('${ORG_B}', '${WIFI}', true); rollback;`),
    ).toMatch(/assunto_not_found/);
  });

  it("nome vazio ou com mais de 60 letras é recusado", () => {
    expect(
      erroAoRodar(`begin; ${jwt(BIA)} select public.fn_save_atendimento_assunto('${ORG_A}', '${TIME_SUPORTE}', null, '   '); rollback;`),
    ).toMatch(/assunto_invalid_name/);
    expect(
      erroAoRodar(`begin; ${jwt(BIA)} select public.fn_save_atendimento_assunto('${ORG_A}', '${TIME_SUPORTE}', null, repeat('a', 61)); rollback;`),
    ).toMatch(/assunto_invalid_name/);
  });
});

describe("fn_atendimento_encerrar: a porta única", () => {
  it("só o serviço chama: authenticated e anon não têm EXECUTE", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    expect(erroAoRodar(`begin; ${jwt(BIA)} select ${encerrar(conv, BIA, null, null)}; rollback;`)).toMatch(/permission denied/);
    expect(erroAoRodar(`begin; set role anon; select ${encerrar(conv, BIA, null, null)}; rollback;`)).toMatch(/permission denied/);
  });

  it("interruptores desligados: fecha sem assunto e sem resumo, com autor", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(sql(`begin; select (${encerrar(conv, ANA, null, null)}).id; ${registro(conv)} rollback;`));
    expect(out[0]).toBe("closed|NULO|NULO|Ana Atendente");
  });

  it("exigir assunto: sem assunto é recusado, e a conversa SEGUE ABERTA", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${interruptores(true, false)}
        ${recusa("encerramento_assunto_obrigatorio", encerrar(conv, ANA, null, "Cliente pediu a segunda via."))}
        select '@@' || c.status || '|' || (a.closed_at is null) || '|' || coalesce(a.closure_summary, 'NULO')
          from public.conversations c join public.atendimentos a on a.conversation_id = c.id where c.id = '${conv}';
        rollback;
      `),
    );
    expect(out[0]).toMatch(/^(open|pending|ai_handling|claimed)\|true\|NULO$/);
  });

  it("exigir assunto sem NENHUM assunto ativo cadastrado não trava o encerramento", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${interruptores(true, false)}
        update public.atendimento_assuntos set archived_at = now() where organization_id = '${ORG_A}';
        select (${encerrar(conv, ANA, null, null)}).id;
        ${registro(conv)}
        rollback;
      `),
    );
    expect(out[0]).toBe("closed|NULO|NULO|Ana Atendente");
  });

  it("exigir resumo: 9 letras recusa, 10 fecha, e o texto é guardado sem os espaços das pontas", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${interruptores(false, true)}
        ${recusa("encerramento_resumo_obrigatorio", encerrar(conv, ANA, null, null))}
        ${recusa("encerramento_resumo_obrigatorio", encerrar(conv, ANA, null, "   123456789   "))}
        select (${encerrar(conv, ANA, null, "  1234567890  ")}).id;
        ${registro(conv)}
        rollback;
      `),
    );
    expect(out[0]).toBe("closed|NULO|1234567890|Ana Atendente");
  });

  it("quebra de linha e tabulação não contam como letra: dez ENTERs não são um resumo", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const chamada = (texto: string) =>
      `public.fn_atendimento_encerrar('${ORG_A}', '${conv}', null, '${ANA}', null, ${texto})`;
    const out = linhas(
      sql(`
        begin;
        ${interruptores(false, true)}
        ${recusa("encerramento_resumo_obrigatorio", chamada("repeat(chr(10), 12)"))}
        ${recusa("encerramento_resumo_obrigatorio", chamada("chr(9) || chr(10) || '123456789' || chr(13) || chr(10) || ' '"))}
        select (${chamada("chr(10) || '1234567890' || chr(10)")}).id;
        ${registro(conv)}
        rollback;
      `),
    );
    expect(out[0]).toBe("closed|NULO|1234567890|Ana Atendente");
  });

  it("resumo em BRANCO apaga o que havia; NULL preserva — e com a exigência ligada o branco é recusado", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const reabrir = `select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'open', null, '${BIA}', true)).id;`;
    const out = linhas(
      sql(`
        begin;
        select (${encerrar(conv, ANA, WIFI, "Texto que vai ser apagado.")}).id;
        ${reabrir}
        select (${encerrar(conv, BIA, null, "")}).id;
        ${registro(conv)}
        ${reabrir}
        select (${encerrar(conv, BIA, null, "Texto novo, com dez letras.")}).id;
        ${reabrir}
        ${interruptores(false, true)}
        ${recusa("encerramento_resumo_obrigatorio", encerrar(conv, BIA, null, "   "))}
        select '@@' || (closed_at is null) || '|' || closure_summary from public.atendimentos where conversation_id = '${conv}';
        rollback;
      `),
    );
    // Apagou o resumo, e o ASSUNTO (que não foi informado) ficou.
    expect(out[0]).toBe(`closed|${WIFI}|NULO|Bia Gestora`);
    // A recusa não apagou nada: o atendimento segue aberto com o texto anterior.
    expect(out[1]).toBe("true|Texto novo, com dez letras.");
  });

  it("resumo com mais de 2000 letras é recusado mesmo com os interruptores desligados", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const erro = erroAoRodar(
      `begin; select public.fn_atendimento_encerrar('${ORG_A}', '${conv}', null, '${ANA}', null, repeat('a', 2001)); rollback;`,
    );
    expect(erro).toMatch(/encerramento_resumo_longo/);
  });

  it("assunto de outra organização, arquivado, inexistente ou de time arquivado é inválido", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${recusa("encerramento_assunto_invalido", encerrar(conv, ANA, ASSUNTO_B, null))}
        ${recusa("encerramento_assunto_invalido", encerrar(conv, ANA, ANTIGO, null))}
        ${recusa("encerramento_assunto_invalido", encerrar(conv, ANA, "a2930000-0000-4000-8000-00000000ffff", null))}
        update public.attendance_teams set archived_at = now() where id = '${TIME_COBRANCA}';
        ${recusa("encerramento_assunto_invalido", encerrar(conv, ANA, BOLETO, null))}
        select '@@' || (closed_at is null) from public.atendimentos where conversation_id = '${conv}';
        rollback;
      `),
    );
    expect(out[0]).toBe("true");
  });

  it("status que não é terminal é recusado", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    expect(erroAoRodar(`begin; select ${encerrar(conv, ANA, null, null, "open")}; rollback;`)).toMatch(/invalid_status/);
  });

  it("fecha com assunto e resumo: grava os dois, o evento leva o assunto e NÃO leva o resumo", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${interruptores(true, true)}
        select (${encerrar(conv, ANA, WIFI, "Orientei a mudar o roteador de lugar.")}).id;
        ${registro(conv)}
        select '@@' || coalesce(payload->>'assunto', 'NULO') || '|' || coalesce(payload->>'assunto_time', 'NULO') || '|' || (payload::text like '%roteador%')
          from public.conversation_events where conversation_id = '${conv}' and type = 'closed';
        select '@@' || (a.team_id is null) || '|' || (c.team_id is null)
          from public.atendimentos a join public.conversations c on c.id = a.conversation_id where c.id = '${conv}';
        rollback;
      `),
    );
    expect(out[0]).toBe(`closed|${WIFI}|Orientei a mudar o roteador de lugar.|Ana Atendente`);
    expect(out[1]).toBe("Wi-Fi|Suporte|false");
    // O setor do assunto é classificação: o time do atendimento e o da conversa não mudam.
    expect(out[2]).toBe("true|true");
  });

  it("estado terminal pelo PATCH (archived) passa pela mesma regra", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${interruptores(false, true)}
        ${recusa("encerramento_resumo_obrigatorio", encerrar(conv, ANA, null, null, "archived"))}
        select (${encerrar(conv, ANA, null, "Arquivada a pedido do cliente.", "archived")}).id;
        select '@@' || closed_status || '|' || closure_summary from public.atendimentos where conversation_id = '${conv}';
        rollback;
      `),
    );
    expect(out[0]).toBe("archived|Arquivada a pedido do cliente.");
  });

  it("reabrir e fechar de novo SEM campos preserva o registro, mesmo com os dois interruptores ligados", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${interruptores(true, true)}
        select (${encerrar(conv, ANA, WIFI, "Trocou a senha do Wi-Fi.")}).id;
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'open', null, '${BIA}', true)).id;
        select '@@' || (closed_at is null) || '|' || assunto_id || '|' || closure_summary from public.atendimentos where conversation_id = '${conv}';
        select (${encerrar(conv, BIA, null, null)}).id;
        ${registro(conv)}
        select '@@' || count(*) from public.atendimentos where conversation_id = '${conv}';
        rollback;
      `),
    );
    expect(out[0]).toBe(`true|${WIFI}|Trocou a senha do Wi-Fi.`);
    expect(out[1]).toBe(`closed|${WIFI}|Trocou a senha do Wi-Fi.|Bia Gestora`);
    expect(out[2]).toBe("1");
  });

  it("quem chega depois de a conversa já estar fechada NÃO sobrescreve o registro", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        select (${encerrar(conv, ANA, WIFI, "Registro de quem fechou.")}).id;
        select (${encerrar(conv, BIA, BOLETO, "Registro de quem chegou depois.")}).id;
        ${registro(conv)}
        rollback;
      `),
    );
    expect(out[0]).toBe(`closed|${WIFI}|Registro de quem fechou.|Ana Atendente`);
  });

  it("o cliente volta: o atendimento NOVO nasce sem registro e é exigido de novo", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${interruptores(true, true)}
        select (${encerrar(conv, ANA, WIFI, "Primeiro atendimento resolvido.")}).id;
        insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, sent_at)
        values ('${ORG_A}', '${conv}', '${SESSAO_A}', '${CONTATO_A}', 'text', 'inbound', 'received', 'ai', 'voltei', clock_timestamp());
        ${recusa("encerramento_assunto_obrigatorio", encerrar(conv, ANA, null, null))}
        select '@@' || count(*) || '|' || count(*) filter (where closed_at is null) || '|' || count(*) filter (where assunto_id is not null)
          from public.atendimentos where conversation_id = '${conv}';
        rollback;
      `),
    );
    expect(out[0]).toBe("2|1|1");
  });

  it("conversa de grupo não tem atendimento: fecha sem exigência", () => {
    const out = linhas(
      sql(`
        begin;
        ${interruptores(true, true)}
        insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
        values ('${GRUPO}', '${ORG_A}', '${CONTATO_A2}', '${SESSAO_A}', 'open', true);
        select '@@' || (${encerrar(GRUPO, ANA, null, null)}).status;
        select '@@' || count(*) from public.atendimentos where conversation_id = '${GRUPO}';
        rollback;
      `),
    );
    expect(out).toEqual(["closed", "0"]);
  });
});

describe("LGPD: anonimizar o contato", () => {
  it("zera o resumo dos atendimentos dele e preserva o assunto", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const outra = conversaDe(ORG_A, CONTATO_A2);
    const out = linhas(
      sql(`
        begin;
        select (${encerrar(conv, ANA, WIFI, "Maria reclamou do sinal no quarto.")}).id;
        select (${encerrar(outra, ANA, BOLETO, "Outro cliente, outro resumo.")}).id;
        select public.fn_lgpd_cascade_redact_contact('${ORG_A}', '${CONTATO_A}', gen_random_uuid());
        select '@@' || coalesce(closure_summary, 'NULO') || '|' || assunto_id from public.atendimentos where conversation_id = '${conv}';
        select '@@' || coalesce(closure_summary, 'NULO') from public.atendimentos where conversation_id = '${outra}';
        rollback;
      `),
    );
    expect(out[0]).toBe(`NULO|${WIFI}`);
    // O vizinho de carteira não é tocado: o gatilho é por contato.
    expect(out[1]).toBe("Outro cliente, outro resumo.");
  });

  it("contato JÁ anonimizado não ganha resumo novo, e a exigência do resumo não trava o encerramento", () => {
    // O gatilho de redação só dispara na TRANSIÇÃO para anonimizado. Sem esta
    // regra, o operador que anonimiza com a conversa aberta e depois a fecha
    // escrevendo "Fulano pediu a exclusão dos dados" deixaria o nome gravado
    // para sempre — a anonimização já passou, e nada mais apagaria o texto.
    const conv = conversaDe(ORG_A, CONTATO_A);
    const out = linhas(
      sql(`
        begin;
        ${interruptores(false, true)}
        select public.fn_lgpd_cascade_redact_contact('${ORG_A}', '${CONTATO_A}', gen_random_uuid());
        -- Se a cascata tiver encerrado a conversa, reabre: o que se mede é o
        -- encerramento por PESSOA depois da anonimização.
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'open', null, '${BIA}', true)).id;
        select '@@' || (closed_at is null) from public.atendimentos where conversation_id = '${conv}' order by started_at desc limit 1;
        select (${encerrar(conv, ANA, WIFI, "Maria Souza pediu a exclusão dos dados.")}).id;
        ${registro(conv)}
        select (public.fn_service_status_com_ator('${ORG_A}', '${conv}', 'open', null, '${BIA}', true)).id;
        select (${encerrar(conv, ANA, null, null)}).id;
        ${registro(conv)}
        rollback;
      `),
    );
    expect(out[0], "controle: havia atendimento aberto para encerrar").toBe("true");
    expect(out[1]).toBe(`closed|${WIFI}|NULO|Ana Atendente`);
    expect(out[2]).toBe(`closed|${WIFI}|NULO|Ana Atendente`);
  });
});

describe("fn_metricas_de_assuntos", () => {
  it("conta por assunto e time no período, separa os sem assunto e não enxerga o vizinho", () => {
    const conv = conversaDe(ORG_A, CONTATO_A);
    const outra = conversaDe(ORG_A, CONTATO_A2);
    const vizinha = conversaDe(ORG_B, CONTATO_B);
    const out = linhas(
      sql(`
        begin;
        select (${encerrar(conv, ANA, WIFI, null)}).id;
        select (${encerrar(outra, ANA, null, null)}).id;
        select (public.fn_atendimento_encerrar('${ORG_B}', '${vizinha}', null, '${BETO}', '${ASSUNTO_B}', null)).id;
        select '@@' || coalesce(assunto_nome, 'SEM') || '|' || coalesce(assunto_team_nome, '-') || '|' || coalesce(atendimento_team_nome, '-') || '|' || total
          from public.fn_metricas_de_assuntos('${ORG_A}', now() - interval '1 hour', now() + interval '1 hour')
         order by 1;
        select '@@fora:' || count(*) from public.fn_metricas_de_assuntos('${ORG_A}', now() - interval '3 hours', now() - interval '2 hours');
        rollback;
      `),
    );
    expect(out).toEqual(["SEM|-|-|1", "Wi-Fi|Suporte|-|1", "fora:0"]);
  });

  it("só o serviço chama", () => {
    expect(
      erroAoRodar(`begin; ${jwt(BIA)} select * from public.fn_metricas_de_assuntos('${ORG_A}', now() - interval '1 hour', now()); rollback;`),
    ).toMatch(/permission denied/);
  });
});
