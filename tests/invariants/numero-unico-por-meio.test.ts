import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MEIO_TELEFONE,
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_SEM_MENSAGEM,
  meioDoCanal,
} from "@/lib/channels/capabilities";

import { sql } from "./gov-helpers";

/**
 * 0292 · um número vive em UM canal ativo POR MEIO — mensagem e telefone não disputam.
 *
 * ## O defeito que fez este arquivo existir
 *
 * A trava `channel_sessions_phone_per_org_unique` é do snapshot e nasceu quando
 * `channel_sessions` só tinha transporte de WhatsApp: "o par (organização,
 * número) é único" era o mesmo que "um número não entra por dois transportes de
 * mensagem". A telefonia (0286) pôs o tronco SIP na mesma tabela e herdou a
 * trava "de graça" — e com ela a recusa de um caso legítimo e comum: o número
 * FIXO da empresa é, ao mesmo tempo, o número da API oficial do WhatsApp e a
 * linha de voz na operadora. Medido em produção em 2026-10-02: cadastrar em
 * Conexões › Telefone o número que já atendia pelo WhatsApp oficial respondia
 * "Esse número já está conectado nesta organização", para quem nunca o tinha
 * ligado na telefonia.
 *
 * ## O que se cobra aqui
 *
 * Comportamento, com o NOME da trava dentro do erro (a razão está no cabeçalho
 * de `channel-provider-schema.test.ts`): o par mensagem + telefone é ACEITO nos
 * dois sentidos; dois troncos ativos com o mesmo número seguem RECUSADOS; e a
 * trava entre transportes de mensagem não afrouxou.
 *
 * Lê o Postgres descartável que nasce do `supabase/baseline.sql` — o que o
 * self-hoster aplica —, e por isso a última seção reaplica o bloco do apêndice
 * sobre um banco que ainda tem a definição ANTIGA do índice: é o `update.sh` de
 * quem já instalou.
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/** O bloco do apêndice, do rótulo até o próximo rótulo (ou o fim do arquivo). */
function blocoDoBaseline(rotulo: string): string {
  const inicio = BASELINE.indexOf(rotulo);
  if (inicio === -1) throw new Error(`rótulo não encontrado no baseline: ${rotulo}`);
  if (BASELINE.indexOf(rotulo, inicio + 1) !== -1) throw new Error(`rótulo repetido no baseline: ${rotulo}`);
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + rotulo.length);
  return BASELINE.slice(inicio, fim === -1 ? undefined : fim);
}

const ROTULO_0107 = "-- ---- número único só entre canais ATIVOS (migration 0107) ----";
const ROTULO_0292 = "-- ---- o número é único por MEIO: mensagem e telefone não disputam (migration 0292) ----";

const TRAVA_DA_MENSAGEM = "channel_sessions_phone_per_org_unique";
const TRAVA_DO_TELEFONE = "channel_sessions_sip_phone_per_org_unique";

let serie = 0;
/** Org descartável por caso: as travas são por (organization_id, ...). */
function novaOrg(): string {
  const slug = `inv-0292-${Date.now()}-${++serie}`;
  sql(`insert into public.organizations (slug, legal_name, display_name) values ('${slug}', 'inv 0292', 'inv 0292');`);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

/** Insere um canal como service_role (RLS fora do caminho — o alvo é a trava). */
function inserir(org: string, cols: Record<string, string>): void {
  const nomes = ["organization_id", "webhook_secret_encrypted", ...Object.keys(cols)];
  const vals = [`'${org}'`, `'\\x00'::bytea`, ...Object.values(cols)];
  sql(`insert into public.channel_sessions (${nomes.join(", ")}) values (${vals.join(", ")});`);
}

const oficial = (org: string, fone: string, ref: string) =>
  inserir(org, {
    provider: `'meta_cloud'`,
    waha_session_name: "null",
    meta_phone_number_id: `'${ref}'`,
    phone_number: `'${fone}'`,
  });

/** A conta SIP é única entre os ativos da INSTALAÇÃO: cada tronco leva o seu usuário. */
const tronco = (org: string, fone: string, usuario: string, extra: Record<string, string> = {}) =>
  inserir(org, {
    provider: `'sip_trunk'`,
    waha_session_name: "null",
    sip_server: `'voip.inv-0292.com.br'`,
    sip_username: `'${usuario}'`,
    phone_number: `'${fone}'`,
    ...extra,
  });

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    // execFileSync joga o stderr do psql em `stderr`; a mensagem do Error só traz o exit.
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o INSERT passou — a trava não existe neste banco");
}

const ativosCom = (org: string, fone: string) =>
  sql(`select provider from public.channel_sessions
        where organization_id = '${org}' and phone_number = '${fone}' and archived_at is null
        order by provider`).split("\n");

const definicao = (indice: string) =>
  sql(`select pg_get_indexdef(i.indexrelid) from pg_index i
         join pg_class c on c.oid = i.indexrelid
        where c.relname = '${indice}' and c.relnamespace = 'public'::regnamespace`);

describe("0292 · o número é único por MEIO", () => {
  it("o número que já atende pelo WhatsApp oficial entra na telefonia — o caso do relato", () => {
    const org = novaOrg();
    oficial(org, "+556140637232", `inv-0292-a-${serie}`);
    tronco(org, "+556140637232", `u-0292-a-${serie}`);
    expect(ativosCom(org, "+556140637232")).toEqual(["meta_cloud", "sip_trunk"]);
  });

  it("e no sentido inverso: o número que já é telefone entra num transporte de mensagem", () => {
    const org = novaOrg();
    tronco(org, "+556140637233", `u-0292-b-${serie}`);
    // O WAHA grava o número DEPOIS de parear (health check): é um UPDATE, não um INSERT.
    inserir(org, { waha_session_name: `'s-0292-b-${serie}'` });
    sql(`update public.channel_sessions set phone_number = '+556140637233'
          where organization_id = '${org}' and provider = 'waha';`);
    expect(ativosCom(org, "+556140637233")).toEqual(["sip_trunk", "waha"]);
  });

  it("dois troncos ATIVOS com o mesmo número na mesma org: RECUSADO, pela trava da telefonia", () => {
    const org = novaOrg();
    tronco(org, "+556140637234", `u-0292-c1-${serie}`);
    const msg = erroDe(() => tronco(org, "+556140637234", `u-0292-c2-${serie}`));
    expect(msg).toMatch(new RegExp(TRAVA_DO_TELEFONE));
  });

  it("o tronco arquivado não ocupa o número (a regra da 0107 vale na trava nova)", () => {
    const org = novaOrg();
    tronco(org, "+556140637235", `u-0292-d1-${serie}`, { archived_at: "now()" });
    tronco(org, "+556140637235", `u-0292-d2-${serie}`);
    expect(ativosCom(org, "+556140637235")).toEqual(["sip_trunk"]);
  });

  it("dois transportes de MENSAGEM com o mesmo número seguem RECUSADOS — a trava antiga não afrouxou", () => {
    const org = novaOrg();
    inserir(org, { waha_session_name: `'s-0292-e-${serie}'`, phone_number: `'+556140637236'` });
    const msg = erroDe(() => oficial(org, "+556140637236", `inv-0292-e-${serie}`));
    expect(msg).toMatch(new RegExp(`"${TRAVA_DA_MENSAGEM}"`));
  });

  it("o mesmo número em DUAS organizações continua livre nas duas travas", () => {
    const [a, b] = [novaOrg(), novaOrg()];
    oficial(a, "+556140637237", `inv-0292-f1-${serie}`);
    oficial(b, "+556140637237", `inv-0292-f2-${serie}`);
    tronco(a, "+556140637237", `u-0292-f1-${serie}`);
    tronco(b, "+556140637237", `u-0292-f2-${serie}`);
    expect(ativosCom(a, "+556140637237")).toEqual(["meta_cloud", "sip_trunk"]);
    expect(ativosCom(b, "+556140637237")).toEqual(["meta_cloud", "sip_trunk"]);
  });

  /**
   * O predicado do índice nomeia o provider do telefone por extenso — o banco não
   * conhece `meioDoCanal`. Um segundo provider de telefone que nasça no
   * TypeScript sem passar por aqui cairia na trava da MENSAGEM, e o defeito
   * deste arquivo voltaria com outro nome.
   */
  it("o recorte do banco é o do TypeScript: telefone = os providers cujo meio é `phone`", () => {
    const deTelefone = [...PROVIDERS_DE_MENSAGEM, ...PROVIDERS_SEM_MENSAGEM].filter(
      (p) => meioDoCanal(p) === MEIO_TELEFONE,
    );
    expect(deTelefone).toEqual(["sip_trunk"]);

    expect(definicao(TRAVA_DA_MENSAGEM)).toMatch(
      /UNIQUE INDEX .*\(organization_id, phone_number\) WHERE \(\(archived_at IS NULL\) AND \(provider <> 'sip_trunk'::text\)\)/,
    );
    expect(definicao(TRAVA_DO_TELEFONE)).toMatch(
      /UNIQUE INDEX .*\(organization_id, phone_number\) WHERE \(\(archived_at IS NULL\) AND \(provider = 'sip_trunk'::text\)\)/,
    );
  });
});

describe("0292 · o `update.sh` de quem já instalou", () => {
  /**
   * O banco de quem está numa versão anterior: só a trava antiga, que não olha o
   * provider. Os canais dos casos de cima saem antes — o par mensagem + telefone
   * que eles gravaram é justamente o que a trava antiga não deixava existir, e
   * ela não nasceria sobre eles.
   */
  function voltarAoBancoAntigo(): void {
    sql(`
      delete from public.channel_sessions
       where organization_id in (select id from public.organizations where slug like 'inv-0292-%');
      drop index if exists public.${TRAVA_DO_TELEFONE};
      drop index if exists public.${TRAVA_DA_MENSAGEM};
      create unique index ${TRAVA_DA_MENSAGEM}
        on public.channel_sessions (organization_id, phone_number)
        where archived_at is null;
    `);
  }

  it("o bloco troca a definição antiga pela nova, e reaplicar não mexe em mais nada", () => {
    voltarAoBancoAntigo();
    const org = novaOrg();
    oficial(org, "+556140637238", `inv-0292-g-${serie}`);
    // Sonda do banco antigo: aqui o defeito EXISTE — senão o resto não prova conserto nenhum.
    expect(erroDe(() => tronco(org, "+556140637238", `u-0292-g0-${serie}`))).toMatch(
      new RegExp(`"${TRAVA_DA_MENSAGEM}"`),
    );

    sql(blocoDoBaseline(ROTULO_0292));
    tronco(org, "+556140637238", `u-0292-g-${serie}`);
    expect(ativosCom(org, "+556140637238")).toEqual(["meta_cloud", "sip_trunk"]);

    // O índice trocado não é reconstruído a cada `update.sh`: o oid dele é o mesmo depois.
    const oid = () => sql(`select '${TRAVA_DA_MENSAGEM}'::regclass::oid, '${TRAVA_DO_TELEFONE}'::regclass::oid`);
    const antes = oid();
    sql(blocoDoBaseline(ROTULO_0292));
    expect(oid()).toBe(antes);
  });

  it("com o par mensagem + telefone JÁ no banco, o baseline inteiro do número reaplica sem erro", () => {
    // O bloco da 0107 vem ANTES no arquivo e ainda diz `create unique index if
    // not exists` com a definição antiga: se ele tentasse recriá-la sobre este
    // banco, falharia por duplicata — e o `update.sh` mostraria o alarme a todo
    // cliente que tem o mesmo número nos dois meios.
    const org = novaOrg();
    sql(blocoDoBaseline(ROTULO_0292));
    oficial(org, "+556140637239", `inv-0292-h-${serie}`);
    tronco(org, "+556140637239", `u-0292-h-${serie}`);

    sql(blocoDoBaseline(ROTULO_0107));
    sql(blocoDoBaseline(ROTULO_0292));

    expect(ativosCom(org, "+556140637239")).toEqual(["meta_cloud", "sip_trunk"]);
    expect(definicao(TRAVA_DA_MENSAGEM)).toMatch(/provider <> 'sip_trunk'/);
  });
});
