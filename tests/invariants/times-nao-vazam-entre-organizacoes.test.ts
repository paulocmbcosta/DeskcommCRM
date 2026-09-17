import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * OS TIMES DE ATENDIMENTO NÃO VAZAM ENTRE ORGANIZAÇÕES — E NINGUÉM ESCREVE NELES
 * PELA REST.
 *
 * ═══ Por que um arquivo próprio, e não uma linha em rls-isolation.test.ts ═══
 *
 * Porque o molde de `TABLES` mede UMA propriedade com UMA fixture, e a garantia
 * destas tabelas é uma PILHA de quatro catracas.
 *
 * Aquele arquivo semeia um `agent` por organização e prova, por tabela, duas
 * coisas: que o vizinho lê zero e que o próprio lê mais que zero. É a régua
 * certa para isolamento de LEITURA, e as duas tabelas passariam nela. Mas o que
 * o desenho promete não é só leitura isolada — é que a escrita só entra por
 * RPC. Isso são quatro catracas empilhadas: a RLS, o GRANT (que só tem SELECT),
 * a conferência de organização DENTRO da RPC, e as duas FKs compostas. Três
 * delas precisam de papéis e fixtures que o molde não tem: um `manager` para
 * chamar a RPC, escrita direta como `postgres` para tirar GRANT e RLS da frente,
 * e os três papéis que o PostgREST assume para medir o GRANT.
 *
 * Registrar as tabelas em `TABLES` faria a metade de leitura CREDITAR a pilha
 * inteira: verde ali passaria a ler como "os times estão protegidos", quando o
 * que estaria medido é a catraca mais externa. Por isso elas entram em
 * `PROVA_PROPRIA` de `rls-completude-varredura.test.ts` citando ESTE arquivo —
 * que é a porta que aquela varredura abre, com todas as letras, para prova
 * comportamental que vive fora de `TABLES`.
 *
 * ⚠️ Esta seção já deu OUTRO motivo, e ele era falso: dizia que
 * `tests/invariants/**` é congelado por `loop/hooks/freeze-invariants.sh`.
 * Medido: `git config core.hooksPath` aponta para
 * `.agents/skills/deskcomm-contribuir/scripts/hooks`, que NÃO contém aquele
 * hook — ele é do gov-loop. A prova de que a mecânica não estava em vigor é
 * este próprio par de commits, que modificou `rls-completude-varredura.test.ts`
 * duas vezes sem nada bloquear. A conclusão (arquivo próprio) continua de pé,
 * pelo motivo acima; o mecanismo citado é que não existia.
 *
 * ═══ O que este arquivo prova ═══
 *
 * 1. Controle positivo: quem é da organização lê os times dela. Sem isto, o
 *    jeito trivial de deixar o arquivo verde é quebrar a feature inteira — e
 *    toda asserção de isolamento passa por ausência de dado.
 * 2. Isolamento: ZERO linhas do vizinho, nas duas tabelas, nos dois sentidos.
 * 3. O GRANT é o portão estreito, e ele é medido nos TRÊS papéis que o PostgREST
 *    assume — `anon`, `authenticated` e `service_role` —, não só no do meio. A
 *    policy é `for all` (doutrina do CLAUDE.md) e DEIXARIA a linha passar, já
 *    que ela é da organização do usuário; quem recusa é o grant, que só tem
 *    SELECT. Para `service_role` isso é o que mais importa: ele ignora RLS
 *    (`rolbypassrls`), então ali o grant não é a primeira catraca — é a única.
 * 4. A RPC de escrita recusa organização alheia. E recusa com o JWT do
 *    MANAGER de A, não do agent: com o agent, `team_forbidden` sairia porque
 *    ele não é gestor, e o teste passaria mesmo que `fn_role_at_least`
 *    ignorasse a organização por completo — verde por acerto, que é o modo de
 *    falha que este repo já pagou caro.
 * 5. As DUAS FKs compostas de `attendance_team_members` — `(organization_id,
 *    user_id)` → `user_organizations` e `(organization_id, team_id)` →
 *    `attendance_teams` — recusam o vínculo cross-org por ESCRITA DIRETA, com
 *    a RPC fora do caminho. É a afirmação central do desenho ("torna
 *    IMPOSSÍVEL, e não só improvável"), e ela só está medida assim.
 *
 *    ⚠️ ISTO JÁ ESTEVE ESCRITO AQUI SENDO FALSO. Havia um caso chamado "(FK
 *    composta)" que passava pela RPC, e uma sabotagem mostrou que apagar
 *    qualquer uma das duas FKs o deixava VERDE: a validação de membros da RPC
 *    levanta antes de a linha chegar à tabela, então a constraint nunca era
 *    alcançada. O caso media a catraca de cima e a prosa creditava a de baixo
 *    — falha em verde, com um docblock afirmando a proteção que faltava.
 *
 * ═══ Qual papel mede o quê ═══
 *
 * Os casos de LEITURA e os de RLS/GRANT usam `set role authenticated` +
 * `request.jwt.claims`, o mesmo caminho da produção: medi-los como `postgres`
 * não mediria nada, porque o superusuário tem `rolbypassrls = t`.
 *
 * Os dois casos de FK fazem o CONTRÁRIO, e de propósito: escrevem como
 * `postgres` justamente para que GRANT e RLS saiam da frente e a constraint
 * fique sendo o único obstáculo no caminho. Papel errado para a pergunta errada
 * é como uma catraca acaba respondendo pela outra.
 *
 * Todo caso que escreve roda dentro de `begin … rollback`. Sem isso, o time que
 * a RPC cria entraria na contagem do controle positivo, e as asserções deste
 * arquivo passariam a depender da ORDEM em que o vitest resolveu rodá-las.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

/**
 * ⚠️ `-q` É OBRIGATÓRIO, e a razão não é cosmética.
 *
 * `-tA` tira cabeçalho e rodapé do RESULTSET, mas não tira o COMMAND TAG: sem
 * `-q`, um script com transação imprime `BEGIN` e `ROLLBACK` no stdout, em
 * volta das linhas que interessam. Medido contra o Postgres real:
 *
 *     $ printf 'begin;\nselect 1;\nrollback;\n' | psql … -tA -f -
 *     BEGIN
 *     1
 *     ROLLBACK      ← é esta que uma leitura pela ÚLTIMA linha devolve
 *
 *     $ printf 'begin;\nselect 1;\nrollback;\n' | psql … -tA -q -f -
 *     1
 *
 * Sem a flag, o controle positivo da RPC — o ÚNICO caso que exercita o caminho
 * feliz de `fn_save_attendance_team` — compara `"ROLLBACK"` com `"1"` e fica
 * vermelho com o produto certo. Quem triasse o CI leria "a RPC de escrita está
 * quebrada" sobre uma RPC que funciona.
 *
 * O `stderr` não é tocado por `-q`, então `erroAoRodar` segue medindo o mesmo.
 */
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
      "-q",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

/**
 * Marcador das linhas que interessam, no molde de `sondasDesfeitas` em
 * `tests/invariants/audit-log-sob-o-default-acl-do-supabase.test.ts`.
 *
 * `-q` já limpa o command tag, e só com ele a leitura pela última linha
 * funcionaria. A MARCA é a segunda catraca, e ela guarda coisa diferente: um
 * `select` acrescentado no fim do script — um diagnóstico a mais, o movimento
 * mais natural do mundo — moveria a "última linha" sem que nada avisasse. Quem
 * depende de POSIÇÃO depende de o script não crescer; quem depende de NOME não.
 */
const MARCA = "SONDA|";

/** As linhas marcadas de um script, sem a marca, na ordem em que saíram. */
function sondas(script: string): string[] {
  return sql(script)
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
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

  // O MESMO controle positivo do outro lado, e não é simetria decorativa: sem
  // ele, "o agent da org B lê ZERO da org A" fica verde também quando AGENT_B
  // não enxerga NADA — semente engolida por um `on conflict do nothing`, que é
  // a classe de falha que `tests/db/banco-limpo-por-arquivo.ts` documenta como
  // já medida neste repo. Hoje não pode acontecer (UUIDs exclusivos deste
  // arquivo + banco novo por arquivo), e é justamente por depender dessas duas
  // condições que a asserção não devia depender delas.
  it.each(TABELAS_DE_TIME)("o agent da org B lê a PRÓPRIA org em %s (controle positivo)", (tabela) => {
    const proprias = countAs(
      AGENT_B,
      `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`,
    );
    expect(proprias).toBe(1);
  });

  it.each(TABELAS_DE_TIME)("o agent da org B lê ZERO linhas da org A em %s", (tabela) => {
    const vizinha = countAs(
      AGENT_B,
      `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`,
    );
    expect(vizinha).toBe(0);
  });
});

/** A linha que cada tabela tentaria inserir — toda ela da PRÓPRIA organização. */
const INSERCAO_LEGITIMA: Record<(typeof TABELAS_DE_TIME)[number], string> = {
  attendance_teams: `insert into public.attendance_teams (organization_id, name, slug)
        values ('${ORG_A}', 'Time pela REST', 'time-pela-rest');`,
  attendance_team_members: `insert into public.attendance_team_members (organization_id, team_id, user_id)
        values ('${ORG_A}', '${TEAM_A}', '${MANAGER_A}');`,
};

/**
 * OS TRÊS PAPÉIS QUE O POSTGREST ASSUME — a mesma lista de `PAPEIS` em
 * `tests/invariants/audit-log-sob-o-default-acl-do-supabase.test.ts`.
 *
 * Medir só `authenticated` deixava o título deste describe prometendo mais do
 * que a medição cobria, e o buraco não era teórico: `service_role` é o papel
 * que IGNORA RLS (`rolbypassrls`). Para ele, o GRANT não é a primeira catraca —
 * é a ÚNICA. No dia em que alguém lhe conceder `insert` (o movimento natural
 * quando um worker precisar escrever), o "escrita só por RPC" da spec se desfaz
 * e nada fica vermelho.
 *
 * `anon` entra pelo mesmo raciocínio, um degrau acima: ele não tem nem SELECT, e
 * é o papel que a anon key carrega para dentro do browser.
 */
const PAPEIS_DA_REST = [
  {
    papel: "anon",
    // Sem JWT: é exatamente o que a anon key manda quando ninguém logou.
    claims: "",
  },
  {
    papel: "authenticated",
    claims: `select set_config('request.jwt.claims', '{"sub":"${AGENT_A}"}', true);`,
  },
  {
    papel: "service_role",
    // O JWT de service role não carrega `sub`, e é assim que a RLS é ignorada.
    claims: "",
  },
] as const;

describe("times de atendimento — a escrita não passa pela REST", () => {
  // A policy `for all` DEIXARIA a linha de `authenticated` passar — ela é da
  // organização do usuário. Quem recusa é o GRANT, que só tem SELECT. É por
  // isso que a mensagem esperada é `permission denied` e não uma violação de
  // policy: são catracas diferentes, e esta mede a que está na frente.
  //
  // E o `permission denied` VIGIA o `revoke all` de verdade, em vez de medir uma
  // tabela que já nasceria fechada: o `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
  // TABLES` do corpo do `baseline.sql` roda ANTES do apêndice, então estas
  // tabelas nascem com ALL concedido aos três papéis e é o `revoke` da migration
  // que as fecha. Tirar o `revoke` deixa este describe vermelho.
  for (const { papel, claims } of PAPEIS_DA_REST) {
    for (const tabela of TABELAS_DE_TIME) {
      it(`\`${papel}\` não tem INSERT em ${tabela}, nem na própria org`, () => {
        const stderr = erroAoRodar(`
      begin;
      set local role ${papel};
      ${claims}
      ${INSERCAO_LEGITIMA[tabela]}
      rollback;
    `);
        expect(stderr).toMatch(/permission denied/i);
        expect(stderr).toMatch(new RegExp(tabela));
      });
    }
  }
});

describe("fn_save_attendance_team — a RPC é a única porta, e ela confere a organização", () => {
  it("o manager da org A cria time na PRÓPRIA org, com membro (controle positivo)", () => {
    // Sem este caso, `team_forbidden` abaixo passaria com a RPC quebrada de
    // qualquer jeito — inclusive recusando TODA chamada. E é aqui que a FK
    // composta e a validação de membros (`for share` + `get diagnostics`) são
    // exercitadas pela primeira vez.
    const lidas = sondas(`
      begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', true);
      select '${MARCA}' || (public.fn_save_attendance_team(
        '${ORG_A}', null, 'Cobrança', 'cobranca',
        'Quando é sobre boleto, fatura ou pagamento',
        '{}'::jsonb, array['${AGENT_A}']::uuid[]
      ) ->> 'id' is not null)::text;
      select '${MARCA}' || count(*)::text
        from public.attendance_team_members m
        join public.attendance_teams t on t.id = m.team_id
       where t.organization_id = '${ORG_A}'
         and t.slug = 'cobranca'
         and m.user_id = '${AGENT_A}';
      rollback;
    `);
    // A RPC devolveu um id, E o membro pedido está no time que ela criou.
    expect(lidas).toEqual(["true", "1"]);
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

  it("a RPC recusa membro de outra organização (validação de membros)", () => {
    // ⚠️ O NOME DESTE CASO JÁ FOI "(FK composta)", E ERA MENTIRA — falha em
    // verde, medida por sabotagem: apagar QUALQUER uma das duas FKs compostas
    // deixava este caso passando. A razão está na ORDEM dentro da RPC: com um
    // usuário de outra organização, o `perform … from user_organizations where
    // organization_id = p_org` acha 0 linhas e levanta `team_invalid_members`
    // ANTES de qualquer linha chegar a `attendance_team_members`. A FK nunca é
    // alcançada.
    //
    // O caso continua valendo — a validação da RPC é uma catraca de verdade e
    // merece gate. Ele só não é a catraca que o desenho chama de "impossível":
    // essa é a FK, e quem a mede é o describe abaixo.
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

/**
 * A FK COMPOSTA, MEDIDA ONDE ELA É A ÚNICA COISA QUE SOBRA.
 *
 * O desenho afirma que a FK `(organization_id, user_id)` → `user_organizations`
 * torna "IMPOSSÍVEL, e não só improvável" alocar num time alguém de outra
 * organização. "Improvável" é o que uma validação de aplicação entrega — e um
 * refactor a remove sem que nada acuse. "Impossível" é o que uma constraint
 * entrega, e afirmação dessa força precisa de um caso que só ela possa passar.
 *
 * Por isso estes dois escrevem DIRETO na tabela, como `postgres`: superusuário
 * ignora GRANT e ignora RLS (`rolbypassrls = t`), então o único obstáculo que
 * resta no caminho é a constraint. É a forma de medir a catraca de baixo sem
 * que as de cima respondam por ela.
 */
describe("attendance_team_members — as FKs compostas, sem a RPC na frente", () => {
  it("recusa membro de outra organização mesmo por escrita direta", () => {
    // TEAM_A é da ORG_A, então a FK de time está satisfeita e sobra uma só
    // suspeita: (ORG_A, AGENT_B) não existe em user_organizations.
    const stderr = erroAoRodar(`
      begin;
      insert into public.attendance_team_members (organization_id, team_id, user_id)
        values ('${ORG_A}', '${TEAM_A}', '${AGENT_B}');
      rollback;
    `);
    expect(stderr).toMatch(/violates foreign key constraint/i);
    expect(stderr).toMatch(/attendance_team_members_organization_id_user_id_fkey/);
  });

  it("recusa time de outra organização mesmo por escrita direta", () => {
    // O espelho: AGENT_A é da ORG_A, mas TEAM_B é da ORG_B. Sem este caso, a
    // outra metade da tenancy composta fica sem gate — e a sabotagem que
    // apagava a FK `(organization_id, team_id)` também passava em verde.
    const stderr = erroAoRodar(`
      begin;
      insert into public.attendance_team_members (organization_id, team_id, user_id)
        values ('${ORG_A}', '${TEAM_B}', '${AGENT_A}');
      rollback;
    `);
    expect(stderr).toMatch(/violates foreign key constraint/i);
    expect(stderr).toMatch(/attendance_team_members_organization_id_team_id_fkey/);
  });
});
