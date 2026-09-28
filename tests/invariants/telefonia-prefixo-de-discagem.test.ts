/**
 * O PREFIXO DE DISCAGEM DO NÚMERO SIP É COLUNA COM RÉGUA — MEDIDO (migration 0287).
 *
 * O valor vai colado na frente do número DENTRO do destino PJSIP
 * (`PJSIP/<prefixo><número>@tronco-<id>`): um `@`, uma `/` ou um `&` mudariam
 * para onde o Asterisk disca. Três portas aplicam a MESMA régua, e as três têm
 * de continuar iguais:
 *
 *   1. o Zod da rota (`numeroSchema`, que usa `prefixoDeDiscagemValido`);
 *   2. o worker, ao montar o destino (`enderecoDeSaida`, em `pjsip.ts`);
 *   3. o CHECK do banco — a única que a REST não contorna.
 *
 * As duas primeiras leem `PREFIXO_DE_DISCAGEM` (`conta-sip.ts`). O caso "o CHECK
 * cita a mesma expressão" lê `pg_get_constraintdef` do banco vivo, EXTRAI a
 * expressão e compara com `toBe` — não com `toContain`, que aprovaria
 * `^[0-9]{1,40}$` porque contém `^[0-9]{1,4`.
 *
 * O caso auto-curativo reproduz o que a doutrina de migrations (item 8) teme:
 * CHECK derrubado à mão + valor fora da régua faz o `add constraint` falhar, e o
 * `update.sh` (sem ON_ERROR_STOP) segue em frente com a coluna sem CHECK. O
 * BLOCO DO APÊNDICE — lido do `supabase/baseline.sql` pelo rótulo, não copiado
 * à mão — tem de normalizar a linha e recriar o CHECK sem erro.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PREFIXO_DE_DISCAGEM } from "@/lib/channels/telefonia/conta-sip";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "c0de0287-0000-4000-8000-00000000000a";
const NUMERO = "c0de0287-0000-4000-8000-0000000000b1";
const CONSTRAINT = "channel_sessions_sip_dial_prefix_check";

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const ROTULO_0287 = "-- ---- telefonia SIP: prefixo de discagem por número (migration 0287) ----";

/** O bloco rotulado da 0287, do rótulo até o próximo rótulo de apêndice — o texto que o self-host aplica. */
function blocoDa0287(): string {
  const inicio = BASELINE.indexOf(ROTULO_0287);
  if (inicio === -1) throw new Error("rótulo da 0287 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO_0287, inicio + 1) !== -1) throw new Error("rótulo da 0287 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO_0287.length);
  if (fim === -1) throw new Error("fim do bloco da 0287 não encontrado");
  return BASELINE.slice(inicio, fim);
}

/** A expressão regular do CHECK, LIDA do banco — a que está entre aspas depois de `~`. */
function expressaoDoCheck(): string {
  const def = sql(`
    select pg_get_constraintdef(oid)
      from pg_constraint
     where conname = '${CONSTRAINT}' and conrelid = 'public.channel_sessions'::regclass;`).trim();
  const m = def.match(/~\s*'([^']+)'/);
  if (!m) throw new Error(`não consegui extrair a expressão de "${def}"`);
  return m[1]!;
}

function tenta(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

afterEach(() => {
  sql(`delete from channel_sessions where organization_id = '${ORG}'; delete from organizations where id = '${ORG}';`);
});

function criarNumero(): void {
  sql(`insert into organizations (id, slug, legal_name, display_name)
       values ('${ORG}', 'prefixo-discagem-0287', 'Prefixo 0287', 'Prefixo 0287') on conflict (id) do nothing;
       delete from channel_sessions where organization_id = '${ORG}';
       insert into channel_sessions
         (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
          sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
       values ('${NUMERO}', '${ORG}', 'sip_trunk', '\\x00', 'STARTING', 'Totus', '+556136861503',
               'voip.exemplo-0287.com.br', 5060, 'udp', 'u0287', '\\x00');`);
}

const gravar = (valor: string | null) =>
  tenta(
    `update channel_sessions set sip_dial_prefix = ${valor === null ? "null" : `'${valor}'`} where id = '${NUMERO}';`,
  );

describe("channel_sessions.sip_dial_prefix", () => {
  it("existe, é text e aceita nulo (nulo = DDD + número, o comportamento anterior)", () => {
    const linha = sql(`
      select data_type || '|' || is_nullable
        from information_schema.columns
       where table_schema = 'public' and table_name = 'channel_sessions'
         and column_name = 'sip_dial_prefix';`).trim();
    expect(linha).toBe("text|YES");
  });

  it("o CHECK do banco cita EXATAMENTE a régua do TypeScript (PREFIXO_DE_DISCAGEM)", () => {
    expect(expressaoDoCheck()).toBe(PREFIXO_DE_DISCAGEM.source);
  });

  it("o normalizador do apêndice (o `update` antes do CHECK) usa a MESMA expressão do CHECK vivo", () => {
    const doUpdate = blocoDa0287().match(/!~\s*'([^']+)'/);
    expect(doUpdate, `não encontrei o "!~" do normalizador no bloco do apêndice:\n${blocoDa0287()}`).not.toBeNull();
    expect(doUpdate![1]).toBe(expressaoDoCheck());
  });

  it("aceita 1 a 4 dígitos e nulo; recusa vazio, 5 dígitos e qualquer não-dígito", () => {
    criarNumero();
    for (const ok of ["0", "015", "0021", null]) {
      expect(gravar(ok), `recusou ${String(ok)}`).toBeNull();
    }
    for (const ruim of ["", "01234", "0a", "0@10.0.0.5", "0/x", "0,1", " 0"]) {
      expect(gravar(ruim), `aceitou ${JSON.stringify(ruim)}`).toContain("check constraint");
    }
  });

  it("auto-curativo: CHECK derrubado + valor fora da régua → reaplicar o bloco do apêndice anula o valor e recria o CHECK", () => {
    criarNumero();
    sql(`
      alter table channel_sessions drop constraint if exists ${CONSTRAINT};
      update channel_sessions set sip_dial_prefix = '0@evil' where id = '${NUMERO}';
    `);
    // Controle: o valor ruim está lá e nada o barra — sem isto o resto não prova nada.
    expect(sql(`select sip_dial_prefix from channel_sessions where id = '${NUMERO}';`).trim()).toBe("0@evil");
    expect(
      sql(`select count(*) from pg_constraint where conname = '${CONSTRAINT}' and conrelid = 'public.channel_sessions'::regclass;`).trim(),
    ).toBe("0");

    sql(blocoDa0287());

    expect(sql(`select coalesce(sip_dial_prefix, '<nulo>') from channel_sessions where id = '${NUMERO}';`).trim()).toBe(
      "<nulo>",
    );
    expect(gravar("0@evil"), "o CHECK não foi recriado ao reaplicar o apêndice").toContain("check constraint");
    // E o valor bom sobrevive ao reaplicar (o normalizador não apaga prefixo válido).
    expect(gravar("0")).toBeNull();
    sql(blocoDa0287());
    expect(sql(`select sip_dial_prefix from channel_sessions where id = '${NUMERO}';`).trim()).toBe("0");
  });
});
