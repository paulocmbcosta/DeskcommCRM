/**
 * O LIMITE DE DIAS DA COBRANÇA PELA IA É COLUNA COM FAIXA — MEDIDO (migration 0274).
 *
 * A IA não envia fatura com mais de N dias de atraso: encaminha à Cobrança (regra
 * do dono, 22/09). N é configuração da TELA, e o CHECK é quem impede um N que
 * desligaria a regra em silêncio (0, negativo) ou a tornaria absurda.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "c0de0274-0000-4000-8000-00000000000a";

function tenta(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

describe("conector_conexoes.cobranca_encaminha_apos_dias", () => {
  it("existe, é integer not null e nasce 60", () => {
    const linha = sql(`
      select data_type || '|' || is_nullable || '|' || column_default
        from information_schema.columns
       where table_schema = 'public' and table_name = 'conector_conexoes'
         and column_name = 'cobranca_encaminha_apos_dias';`).trim();
    expect(linha).toBe("integer|NO|60");
  });

  it("o CHECK recusa 0 e 3651 e aceita 1, 60 e 3650", () => {
    sql(`insert into organizations (id, slug, legal_name, display_name)
         values ('${ORG}', 'limite-cobranca-0274', 'Limite 0274', 'Limite 0274') on conflict (id) do nothing;
         delete from conector_conexoes where organization_id = '${ORG}';
         insert into conector_conexoes (organization_id, conector, base_url, token_encrypted, token_iv, token_tag, token_last4)
         values ('${ORG}', 'ixc', 'https://erp.exemplo', '\\x00', '\\x00', '\\x00', 'abcd');`);
    for (const ok of [1, 60, 3650]) {
      expect(tenta(`update conector_conexoes set cobranca_encaminha_apos_dias = ${ok} where organization_id = '${ORG}';`)).toBeNull();
    }
    for (const ruim of [0, -5, 3651]) {
      expect(tenta(`update conector_conexoes set cobranca_encaminha_apos_dias = ${ruim} where organization_id = '${ORG}';`)).toContain("check constraint");
    }
    sql(`delete from organizations where id = '${ORG}';`);
  });
});
