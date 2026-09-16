import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * OS TIMES DE ATENDIMENTO NÃO VAZAM ENTRE ORGANIZAÇÕES — E NINGUÉM ESCREVE NELES
 * PELA REST.
 *
 * ═══ Por que um arquivo próprio, e não uma linha em rls-isolation.test.ts ═══
 *
 * Mecânica: `tests/invariants/**` é congelado por `loop/hooks/freeze-invariants.sh`
 * — arquivo NOVO (status `A`) passa, arquivo MODIFICADO (`M`) é bloqueado.
 * Acrescentar as duas tabelas na lista fixa daquele arquivo exigiria a env de
 * escape, e a autorização para usá-la não é minha para tomar. As duas tabelas
 * são declaradas em `PROVA_PROPRIA` de `rls-completude-varredura.test.ts`
 * citando ESTE arquivo — que é a porta que aquela varredura abre, com todas as
 * letras, para prova comportamental que vive fora de `TABLES`.
 *
 * ═══ O que este arquivo prova ═══
 *
 * 1. Controle positivo: quem é da organização lê os times dela. Sem isto, o
 *    jeito trivial de deixar o arquivo verde é quebrar a feature inteira — e
 *    toda asserção de isolamento passa por ausência de dado.
 * 2. Isolamento: ZERO linhas do vizinho, nas duas tabelas, nos dois sentidos.
 * 3. O GRANT é o portão estreito. A policy é `for all` (doutrina do CLAUDE.md),
 *    mas `authenticated` só tem SELECT — então a REST não escreve, mesmo com a
 *    policy permitindo a linha. Policy e grant são catracas diferentes e a
 *    segunda é a que fecha a porta; medi-la é medir a que está na frente.
 * 4. A RPC de escrita recusa organização alheia. E recusa com o JWT do
 *    MANAGER de A, não do agent: com o agent, `team_forbidden` sairia porque
 *    ele não é gestor, e o teste passaria mesmo que `fn_role_at_least`
 *    ignorasse a organização por completo — verde por acerto, que é o modo de
 *    falha que este repo já pagou caro.
 * 5. A FK COMPOSTA `(organization_id, user_id)` → `user_organizations` é a
 *    afirmação central do desenho ("torna IMPOSSÍVEL, e não só improvável,
 *    alocar num time alguém de outra organização"). Afirmação de segurança sem
 *    gate é prosa, então ela tem caso próprio.
 *
 * Conectar como `postgres` mediria NADA (`rolbypassrls = t`). Aqui é
 * `set role authenticated` + `request.jwt.claims`, o mesmo caminho da produção.
 *
 * Os casos que passam pela RPC rodam dentro de `begin … rollback`, de propósito:
 * sem isso o time que a RPC cria entraria na contagem do controle positivo e as
 * asserções deste arquivo passariam a depender da ORDEM em que o vitest resolveu
 * rodá-las.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

function ultimaLinha(out: string): string {
  const linhas = out.split("\n");
  const ultima = linhas[linhas.length - 1];
  if (ultima === undefined) throw new Error(`saída vazia do psql`);
  return ultima.trim();
}

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const ultima = ultimaLinha(out);
  if (!/^\d+$/.test(ultima)) {
    throw new Error(`saída inesperada do psql: ${out}`);
  }
  return Number(ultima);
}

/**
 * Roda um script que TEM que falhar e devolve o stderr do psql.
 *
 * Com `ON_ERROR_STOP=1` o psql aborta e sai diferente de zero, então
 * `execFileSync` levanta — e o erro carrega o `stderr` como string, porque o
 * `encoding: "utf8"` acima vale para os três descritores. O `throw` do final é
 * o que impede o caso de passar por não ter medido nada: script que PASSOU onde
 * a prova exige falha é exatamente o defeito que estes casos existem para pegar.
 */
function erroAoRodar(script: string): string {
  try {
    sql(script);
  } catch (e) {
    const erro = e as { stderr?: unknown; message?: unknown };
    if (typeof erro.stderr === "string" && erro.stderr.trim() !== "") return erro.stderr;
    return String(erro.message ?? e);
  }
  throw new Error(
    "o script PASSOU, e esta prova exige que ele falhe — a proteção que ela mede não está lá",
  );
}

// UUIDs próprios deste arquivo, para ele e os demais invariantes não disputarem
// as mesmas linhas quando rodarem na mesma base.
const ORG_A = "7ea40000-0000-4000-8000-00000000000a";
const ORG_B = "7ea40000-0000-4000-8000-00000000000b";
const AGENT_A = "7ea41111-0000-4000-8000-00000000000a";
const MANAGER_A = "7ea41111-0000-4000-8000-00000000000d";
const AGENT_B = "7ea41111-0000-4000-8000-00000000000b";
const TEAM_A = "7ea42222-0000-4000-8000-00000000000a";
const TEAM_B = "7ea42222-0000-4000-8000-00000000000b";

const TABELAS_DE_TIME = ["attendance_teams", "attendance_team_members"] as const;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}',   'times-agent-a@invariant.test'),
      ('${MANAGER_A}', 'times-mgr-a@invariant.test'),
      ('${AGENT_B}',   'times-agent-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'times-inv-a', 'Times Invariant A', 'Times A'),
      ('${ORG_B}', 'times-inv-b', 'Times Invariant B', 'Times B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_B}',   '${ORG_B}', 'agent',   now())
      on conflict do nothing;

    -- Um time POR ORGANIZAÇÃO, cada um com o atendente daquele lado dentro.
    -- O membro é o que dá substância ao controle positivo de
    -- attendance_team_members: sem ele, a asserção de ZERO do vizinho passaria
    -- numa tabela simplesmente vazia.
    insert into public.attendance_teams (id, organization_id, name, slug, description) values
      ('${TEAM_A}', '${ORG_A}', 'Suporte', 'suporte', 'Quando o cliente já comprou e algo não funciona'),
      ('${TEAM_B}', '${ORG_B}', 'Suporte', 'suporte', 'Mesmo slug do vizinho de propósito: o unique é por organização')
      on conflict (id) do nothing;

    insert into public.attendance_team_members (organization_id, team_id, user_id) values
      ('${ORG_A}', '${TEAM_A}', '${AGENT_A}'),
      ('${ORG_B}', '${TEAM_B}', '${AGENT_B}')
      on conflict do nothing;
  `);
});

describe("times de atendimento — isolamento entre organizações", () => {
  // O controle positivo vem PRIMEIRO de propósito: sem ele, quebrar a feature
  // inteira deixaria as asserções de isolamento verdes por ausência de dado.
  it.each(TABELAS_DE_TIME)("o agent da org A lê a PRÓPRIA org em %s (controle positivo)", (tabela) => {
    const proprias = countAs(
      AGENT_A,
      `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`,
    );
    expect(proprias).toBe(1);
  });

  it.each(TABELAS_DE_TIME)("o agent da org A lê ZERO linhas da org B em %s", (tabela) => {
    const vizinha = countAs(
      AGENT_A,
      `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`,
    );
    expect(vizinha).toBe(0);
  });

  it.each(TABELAS_DE_TIME)("o agent da org B lê ZERO linhas da org A em %s", (tabela) => {
    const vizinha = countAs(
      AGENT_B,
      `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`,
    );
    expect(vizinha).toBe(0);
  });
});

describe("times de atendimento — a escrita não passa pela REST", () => {
  it("`authenticated` não tem INSERT em attendance_teams, nem na própria org", () => {
    // A policy `for all` DEIXARIA esta linha passar — ela é da organização do
    // usuário. Quem recusa é o GRANT, que só tem SELECT. É por isso que a
    // mensagem esperada é `permission denied` e não uma violação de policy:
    // são catracas diferentes, e esta mede a que está na frente.
    const stderr = erroAoRodar(`
      begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${AGENT_A}"}', true);
      insert into public.attendance_teams (organization_id, name, slug)
        values ('${ORG_A}', 'Time pela REST', 'time-pela-rest');
      rollback;
    `);
    expect(stderr).toMatch(/permission denied/i);
    expect(stderr).toMatch(/attendance_teams/);
  });

  it("`authenticated` não tem INSERT em attendance_team_members, nem na própria org", () => {
    const stderr = erroAoRodar(`
      begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${AGENT_A}"}', true);
      insert into public.attendance_team_members (organization_id, team_id, user_id)
        values ('${ORG_A}', '${TEAM_A}', '${MANAGER_A}');
      rollback;
    `);
    expect(stderr).toMatch(/permission denied/i);
    expect(stderr).toMatch(/attendance_team_members/);
  });
});

describe("fn_save_attendance_team — a RPC é a única porta, e ela confere a organização", () => {
  it("o manager da org A cria time na PRÓPRIA org, com membro (controle positivo)", () => {
    // Sem este caso, `team_forbidden` abaixo passaria com a RPC quebrada de
    // qualquer jeito — inclusive recusando TODA chamada. E é aqui que a FK
    // composta e a validação de membros (`for share` + `get diagnostics`) são
    // exercitadas pela primeira vez.
    const out = sql(`
      begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', true);
      select public.fn_save_attendance_team(
        '${ORG_A}', null, 'Cobrança', 'cobranca',
        'Quando é sobre boleto, fatura ou pagamento',
        '{}'::jsonb, array['${AGENT_A}']::uuid[]
      ) ->> 'id' is not null;
      select count(*)
        from public.attendance_team_members m
        join public.attendance_teams t on t.id = m.team_id
       where t.organization_id = '${ORG_A}'
         and t.slug = 'cobranca'
         and m.user_id = '${AGENT_A}';
      rollback;
    `);
    expect(ultimaLinha(out)).toBe("1");
  });

  it("o manager da org A NÃO cria time na org B (team_forbidden)", () => {
    const stderr = erroAoRodar(`
      begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', true);
      select public.fn_save_attendance_team(
        '${ORG_B}', null, 'Invasão', 'invasao', '', '{}'::jsonb, '{}'::uuid[]
      );
      rollback;
    `);
    expect(stderr).toMatch(/team_forbidden/);
  });

  it("o manager da org A NÃO aloca no time dele alguém da org B (FK composta)", () => {
    // A afirmação central do desenho, medida: a capacidade é do atendente e o
    // atendente é de UMA organização. Quem recusa aqui é a validação de membros
    // da RPC; a FK composta é a segunda catraca, para o caso de alguém um dia
    // escrever na tabela por outro caminho.
    const stderr = erroAoRodar(`
      begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', true);
      select public.fn_save_attendance_team(
        '${ORG_A}', '${TEAM_A}', 'Suporte', 'suporte', '',
        '{}'::jsonb, array['${AGENT_B}']::uuid[]
      );
      rollback;
    `);
    expect(stderr).toMatch(/team_invalid_members/);
  });
});
