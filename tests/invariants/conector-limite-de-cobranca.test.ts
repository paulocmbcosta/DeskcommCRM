/**
 * O LIMITE DE DIAS DA COBRANÇA PELA IA É COLUNA COM FAIXA — MEDIDO (migration 0274).
 *
 * A IA não envia fatura com mais de N dias de atraso: encaminha à Cobrança (regra
 * do dono, 22/09). N é configuração da TELA, e o CHECK é quem impede um N que
 * desligaria a regra em silêncio (0, negativo) ou a tornaria absurda.
 *
 * ─── Uma fonte só para a faixa ──────────────────────────────────────────────
 *
 * `1..3650` não é mais um número escrito à mão aqui: vem de `FAIXA_DO_LIMITE`
 * (`lib/conectores/limite-de-cobranca.ts`), a MESMA constante que o Zod da rota,
 * a mensagem de erro e o `min`/`max` do input da tela usam. O caso "o CHECK do
 * banco cita a MESMA faixa" lê `pg_get_constraintdef` e compara com essa
 * constante — afrouxar só um dos dois lados (o TypeScript ou o SQL) fica
 * vermelho aqui.
 *
 * ─── O caso auto-curativo ───────────────────────────────────────────────────
 *
 * A doutrina de migrations (item 8) teme exatamente isto: um clone com uma
 * linha fora da faixa (NULL de uma versão antiga, ou lixo de bug) faz o
 * `add constraint` do apêndice falhar — e como o `update.sh` roda SEM
 * `ON_ERROR_STOP`, ele segue em frente com a coluna sem CHECK, e nenhum sintoma
 * visível. O caso "auto-curativo" reproduz isso (derruba o CHECK, grava um
 * valor fora da faixa) e reaplica o BLOCO DO APÊNDICE — lido do
 * `supabase/baseline.sql` pelo rótulo, não copiado à mão — provando que ele
 * normaliza a linha e recria o CHECK sem erro.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FAIXA_DO_LIMITE, LIMITE_PADRAO_DA_COBRANCA } from "@/lib/conectores/limite-de-cobranca";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "c0de0274-0000-4000-8000-00000000000a";
const CONSTRAINT = "conector_conexoes_cobranca_encaminha_apos_dias_check";

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const ROTULO_0274 = "-- ---- o limite de dias para a IA encaminhar a fatura à Cobrança (migration 0274) ----";

/** O bloco rotulado da 0274, do rótulo até o próximo rótulo de apêndice — o texto que o self-host aplica. */
function blocoDa0274(): string {
  const inicio = BASELINE.indexOf(ROTULO_0274);
  if (inicio === -1) throw new Error("rótulo da 0274 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO_0274, inicio + 1) !== -1) throw new Error("rótulo da 0274 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO_0274.length);
  if (fim === -1) throw new Error("fim do bloco da 0274 não encontrado");
  return BASELINE.slice(inicio, fim);
}

function tenta(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/** Roda depois de TODO teste — inclusive o que reprova no meio, para a fixture nunca sobreviver no banco compartilhado. */
afterEach(() => {
  sql(`delete from conector_conexoes where organization_id = '${ORG}'; delete from organizations where id = '${ORG}';`);
});

function criarConexao(): void {
  sql(`insert into organizations (id, slug, legal_name, display_name)
       values ('${ORG}', 'limite-cobranca-0274', 'Limite 0274', 'Limite 0274') on conflict (id) do nothing;
       delete from conector_conexoes where organization_id = '${ORG}';
       insert into conector_conexoes (organization_id, conector, base_url, token_encrypted, token_iv, token_tag, token_last4)
       values ('${ORG}', 'ixc', 'https://erp.exemplo', '\\x00', '\\x00', '\\x00', 'abcd');`);
}

describe("conector_conexoes.cobranca_encaminha_apos_dias", () => {
  it("existe, é integer not null e nasce no padrão do dono", () => {
    const linha = sql(`
      select data_type || '|' || is_nullable || '|' || column_default
        from information_schema.columns
       where table_schema = 'public' and table_name = 'conector_conexoes'
         and column_name = 'cobranca_encaminha_apos_dias';`).trim();
    expect(linha).toBe(`integer|NO|${LIMITE_PADRAO_DA_COBRANCA}`);
  });

  it("o CHECK do banco cita a MESMA faixa que o TypeScript (FAIXA_DO_LIMITE)", () => {
    const def = sql(`
      select pg_get_constraintdef(oid)
        from pg_constraint
       where conname = '${CONSTRAINT}' and conrelid = 'public.conector_conexoes'::regclass;`).trim();
    expect(def, "o CHECK do banco não citou o mínimo do TypeScript").toContain(String(FAIXA_DO_LIMITE.min));
    expect(def, "o CHECK do banco não citou o máximo do TypeScript").toContain(String(FAIXA_DO_LIMITE.max));
  });

  it("o CHECK recusa fora da faixa e aceita os extremos e o meio", () => {
    criarConexao();
    for (const ok of [FAIXA_DO_LIMITE.min, 60, FAIXA_DO_LIMITE.max]) {
      expect(tenta(`update conector_conexoes set cobranca_encaminha_apos_dias = ${ok} where organization_id = '${ORG}';`)).toBeNull();
    }
    for (const ruim of [FAIXA_DO_LIMITE.min - 1, -5, FAIXA_DO_LIMITE.max + 1]) {
      expect(tenta(`update conector_conexoes set cobranca_encaminha_apos_dias = ${ruim} where organization_id = '${ORG}';`)).toContain(
        "check constraint",
      );
    }
  });

  it("auto-curativo: CHECK derrubado + linha fora da faixa → reaplicar o bloco do apêndice normaliza a linha e recria o CHECK sem erro", () => {
    criarConexao();
    sql(`
      alter table conector_conexoes drop constraint if exists ${CONSTRAINT};
      update conector_conexoes set cobranca_encaminha_apos_dias = 0 where organization_id = '${ORG}';
    `);
    // controle: a linha está fora da faixa e não há CHECK nenhum barrando — se
    // isto falhar, o resto do teste não prova nada (mediria um estado que já
    // nasceu bom).
    expect(sql(`select cobranca_encaminha_apos_dias from conector_conexoes where organization_id = '${ORG}';`).trim()).toBe("0");
    expect(
      sql(`select count(*) from pg_constraint where conname = '${CONSTRAINT}' and conrelid = 'public.conector_conexoes'::regclass;`).trim(),
    ).toBe("0");

    sql(blocoDa0274());

    const normalizado = sql(`select cobranca_encaminha_apos_dias from conector_conexoes where organization_id = '${ORG}';`).trim();
    expect(normalizado, "a linha fora da faixa não foi normalizada ao reaplicar o apêndice").toBe(String(LIMITE_PADRAO_DA_COBRANCA));
    expect(
      tenta(`update conector_conexoes set cobranca_encaminha_apos_dias = 0 where organization_id = '${ORG}';`),
      "o CHECK não foi recriado ao reaplicar o apêndice",
    ).toContain("check constraint");
  });
});
