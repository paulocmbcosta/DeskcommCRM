/**
 * `conector_conexoes` E `contato_vinculos_externos` SÃO SERVER-SIDE ONLY — MEDIDO.
 *
 * ## O que se pagaria
 *
 * `conector_conexoes` guarda o token do ERP de um terceiro — no IXC medido em
 * 2026-09-19, um token "só de leitura" que lê senha de central, senha PPPoE e
 * senha de Wi-Fi de 11 mil pessoas. `contato_vinculos_externos` diz qual cadastro
 * do ERP é cada contato. A anon key vai para o browser: tabela servida pelo
 * PostgREST e "protegida por policy" depende de a policy estar certa.
 *
 * O `supabase/baseline.sql` traz `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES
 * TO anon/authenticated`, e o Supabase real tem o mesmo default ACL: **tabela nova
 * nasce concedida.** O que protege é o `revoke` da 0271. Este arquivo mede
 * **privilégio** (o que sobra no dia em que alguém escrever "só uma policy de
 * leitura") **e comportamento** (`permission denied`, que distingue "a policy
 * barrou" de "o privilégio não existe").
 *
 * Irmão declarado de `credencial-do-google-e-server-side.test.ts`, que é o molde.
 * A diferença: estas duas SÃO tenant-aware, e quem grava nelas é o `service_role`,
 * que ignora RLS. Por isso há dois casos a mais — as duas catracas que sobram
 * quando a ROTA erra: o trigger que recusa vínculo com contato de outra
 * organização, e o que apaga o vínculo quando o contato é anonimizado.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = ["conector_conexoes", "contato_vinculos_externos"] as const;

const ORG_A = "c0de0271-0000-4000-8000-00000000000a";
const ORG_B = "c0de0271-0000-4000-8000-00000000000b";
const CONTATO_A = "c0de0271-1111-4000-8000-00000000000a";
const CONTATO_B = "c0de0271-1111-4000-8000-00000000000b";

function erroSob(papel: string, comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/** O modo de falha interessante é `null`: o comando PASSOU e a tabela está exposta. */
function esperaBarrado(papel: string, comando: string): void {
  const erro = erroSob(papel, comando);
  expect(erro, `\`${papel}\` executou "${comando}" SEM erro — a tabela está exposta`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

function privilegiosDe(tabela: string, papel: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = '${tabela}' and grantee = '${papel}';
  `).trim();
}

function limpar(): void {
  sql(`
    delete from public.contato_vinculos_externos where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.conector_conexoes where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.contacts where id in ('${CONTATO_A}', '${CONTATO_B}');
    delete from public.organizations where id in ('${ORG_A}', '${ORG_B}');
  `);
}

beforeAll(() => {
  limpar();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'conector-inv-a', 'Conector Invariant A', 'Conector A'),
      ('${ORG_B}', 'conector-inv-b', 'Conector Invariant B', 'Conector B');
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${ORG_A}', 'Contato do conector A'),
      ('${CONTATO_B}', '${ORG_B}', 'Contato do conector B');
  `);
});

afterAll(limpar);

describe.each(TABELAS)("o PostgREST não serve `%s`", (tabela) => {
  it("`anon` não tem privilégio NENHUM", () => {
    expect(privilegiosDe(tabela, "anon")).toBe("NENHUM");
  });

  it("`authenticated` também não — nenhuma tela lê isto pelo client de sessão", () => {
    expect(privilegiosDe(tabela, "authenticated")).toBe("NENHUM");
  });

  it("`service_role` CONTINUA com privilégio — controle positivo da sonda", () => {
    // Sem este caso, uma sonda com o nome da tabela trocado devolveria NENHUM para
    // todo mundo e os dois casos de cima passariam por acidente.
    const privilegios = privilegiosDe(tabela, "service_role");
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(privilegios).toContain(p);
  });

  it("`anon` e `authenticated` são BARRADOS ao ler — permission denied, não zero linhas", () => {
    esperaBarrado("anon", `select id from public.${tabela}`);
    esperaBarrado("authenticated", `select id from public.${tabela}`);
  });

  it("a RLS está LIGADA e não há policy — servir esta tabela nunca foi a intenção", () => {
    expect(sql(`select relrowsecurity from pg_class where oid = 'public.${tabela}'::regclass;`).trim()).toBe("t");
    expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${tabela}';`).trim()).toBe("0");
  });
});

describe("`authenticated` não grava nem com o id certo na mão", () => {
  it("não cria conexão", () => {
    esperaBarrado(
      "authenticated",
      `insert into public.conector_conexoes (organization_id, conector, base_url, token_encrypted, token_iv, token_tag, token_last4)
       values ('${ORG_A}', 'ixc', 'https://invasor.exemplo', '\\x00', '\\x00', '\\x00', '0000')`,
    );
  });

  it("não cria vínculo", () => {
    esperaBarrado(
      "authenticated",
      `insert into public.contato_vinculos_externos (organization_id, contact_id, conector, external_id, verificado_por)
       values ('${ORG_A}', '${CONTATO_A}', 'ixc', '1', 'manual')`,
    );
  });
});

describe("as duas catracas que sobram quando a ROTA erra (quem grava é o service_role, que ignora RLS)", () => {
  it("vínculo com contato da MESMA organização entra — controle positivo", () => {
    sql(`
      insert into public.contato_vinculos_externos (organization_id, contact_id, conector, external_id, verificado_por)
      values ('${ORG_A}', '${CONTATO_A}', 'ixc', '100', 'telefone');
    `);
    expect(sql(`select count(*) from public.contato_vinculos_externos where contact_id = '${CONTATO_A}';`).trim()).toBe("1");
  });

  it("vínculo que junta a organização A com o contato de B é RECUSADO pelo banco", () => {
    let erro: string | null = null;
    try {
      sql(`
        insert into public.contato_vinculos_externos (organization_id, contact_id, conector, external_id, verificado_por)
        values ('${ORG_A}', '${CONTATO_B}', 'ixc', '200', 'manual');
      `);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro, "o banco aceitou um vínculo cruzando organizações").not.toBeNull();
    expect(erro).toContain("vinculo_externo_de_outra_organizacao");
  });

  it("o mesmo cadastro duas vezes no mesmo contato bate na unique (a rota captura 23505)", () => {
    let erro: string | null = null;
    try {
      sql(`
        insert into public.contato_vinculos_externos (organization_id, contact_id, conector, external_id, verificado_por)
        values ('${ORG_A}', '${CONTATO_A}', 'ixc', '100', 'manual');
      `);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro).toContain("contato_vinculos_externos_unico");
  });

  it("conector fora do vocabulário é recusado pelo CHECK", () => {
    let erro: string | null = null;
    try {
      sql(`
        insert into public.contato_vinculos_externos (organization_id, contact_id, conector, external_id, verificado_por)
        values ('${ORG_A}', '${CONTATO_A}', 'sistema_inventado', '1', 'manual');
      `);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro).toContain("contato_vinculos_externos_conector_check");
  });

  it("LGPD: anonimizar o contato APAGA o vínculo — o id do ERP reidentifica a pessoa", () => {
    // Controle: o vínculo está lá antes.
    expect(sql(`select count(*) from public.contato_vinculos_externos where contact_id = '${CONTATO_A}';`).trim()).toBe("1");
    // Uma edição qualquer NÃO apaga (o trigger só age na virada de `is_anonymized`).
    sql(`update public.contacts set display_name = 'Renomeado' where id = '${CONTATO_A}';`);
    expect(sql(`select count(*) from public.contato_vinculos_externos where contact_id = '${CONTATO_A}';`).trim()).toBe("1");

    sql(`update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${CONTATO_A}';`);
    expect(sql(`select count(*) from public.contato_vinculos_externos where contact_id = '${CONTATO_A}';`).trim()).toBe("0");
  });

  it("apagar a organização leva a conexão junto (cascade) — token órfão não fica para trás", () => {
    sql(`
      insert into public.conector_conexoes (organization_id, conector, base_url, token_encrypted, token_iv, token_tag, token_last4)
      values ('${ORG_B}', 'ixc', 'https://erp.exemplo.com.br', '\\x00', '\\x00', '\\x00', 'abcd');
      delete from public.contacts where id = '${CONTATO_B}';
      delete from public.organizations where id = '${ORG_B}';
    `);
    expect(sql(`select count(*) from public.conector_conexoes where organization_id = '${ORG_B}';`).trim()).toBe("0");
  });
});
