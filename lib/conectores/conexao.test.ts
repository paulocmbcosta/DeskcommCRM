/**
 * `lerLimiteDeCobranca` — o baseline é o contrato, o erro de banco SOBE.
 *
 * Decisão da revisão do Lote C: a versão anterior devolvia o padrão (60) em
 * QUALQUER erro do PostgREST, inclusive `42703` (coluna ausente — clone com o
 * baseline não aplicado). Isso escondia a instalação quebrada atrás de um
 * número que parece normal. Hoje só DUAS situações caem no padrão — ausência
 * de LINHA e valor NULO —, e as duas são estados válidos do banco, não erro.
 */
import { describe, expect, it } from "vitest";

import { lerLimiteDeCobranca } from "./conexao";
import { LIMITE_PADRAO_DA_COBRANCA } from "./limite-de-cobranca";

/** O admin falso reproduz só `from(t).select(...).eq().eq().maybeSingle()`, que é o que `lerLimiteDeCobranca` usa. */
function adminFalso(resultado: { data: { cobranca_encaminha_apos_dias: number | null } | null; error: { message: string } | null }) {
  return {
    from(_tabela: string) {
      return {
        select: (_colunas: string) => ({
          eq: (_c1: string, _v1: unknown) => ({
            eq: (_c2: string, _v2: unknown) => ({
              maybeSingle: async () => resultado,
            }),
          }),
        }),
      };
    },
  };
}

function comoAdmin(admin: ReturnType<typeof adminFalso>): Parameters<typeof lerLimiteDeCobranca>[0] {
  return admin as never;
}

describe("lerLimiteDeCobranca", () => {
  it("erro do PostgREST (ex.: 42703, coluna ausente) LANÇA — não cai no padrão", async () => {
    const admin = adminFalso({ data: null, error: { message: 'column "cobranca_encaminha_apos_dias" does not exist' } });
    await expect(lerLimiteDeCobranca(comoAdmin(admin), "org-1", "ixc")).rejects.toThrow(
      "cobranca_encaminha_apos_dias",
    );
  });

  it("sem linha de conexão (conector nunca ligado) → padrão do dono", async () => {
    const admin = adminFalso({ data: null, error: null });
    await expect(lerLimiteDeCobranca(comoAdmin(admin), "org-1", "ixc")).resolves.toBe(LIMITE_PADRAO_DA_COBRANCA);
  });

  it("linha existe mas o valor é nulo → padrão do dono", async () => {
    const admin = adminFalso({ data: { cobranca_encaminha_apos_dias: null }, error: null });
    await expect(lerLimiteDeCobranca(comoAdmin(admin), "org-1", "ixc")).resolves.toBe(LIMITE_PADRAO_DA_COBRANCA);
  });

  it("valor válido → o valor, não o padrão", async () => {
    const admin = adminFalso({ data: { cobranca_encaminha_apos_dias: 45 }, error: null });
    await expect(lerLimiteDeCobranca(comoAdmin(admin), "org-1", "ixc")).resolves.toBe(45);
  });
});
