/**
 * A FAIXA E O PADRÃO do limite de dias da cobrança pela IA (migration 0274) —
 * fonte única para o Zod da rota, a mensagem de erro, o input da tela e o
 * invariante do banco (que confere, via `pg_get_constraintdef`, que o CHECK do
 * Postgres cita os MESMOS dois números que este arquivo).
 *
 * Vive num arquivo PRÓPRIO, fora de `conexao.ts`: aquele módulo importa
 * `lib/crypto/aes_gcm` (que usa `node:crypto` e `lib/env`), e a ficha do
 * conector em Configurações › Conectores (`ConectoresClient.tsx`) é
 * `"use client"` — arrastar aquilo para o bundle do navegador quebraria o
 * build. Este arquivo não importa nada: pode ser lido pelo servidor, pelo
 * cliente e pelo invariante sem risco nenhum.
 */

/** O CHECK do banco (migration 0274) guarda esta MESMA faixa — `tests/invariants/conector-limite-de-cobranca.test.ts` confere pelo `pg_get_constraintdef`. */
export const FAIXA_DO_LIMITE = { min: 1, max: 3650 } as const;

/** A regra do dono (22/09): sem configuração, fatura com MAIS de 60 dias de atraso vai para a Cobrança. */
export const LIMITE_PADRAO_DA_COBRANCA = 60;
