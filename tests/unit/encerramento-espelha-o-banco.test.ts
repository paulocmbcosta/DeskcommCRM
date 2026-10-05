import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MENSAGENS_DE_RECUSA,
  NOME_DO_ASSUNTO_MAXIMO,
  RESUMO_MAXIMO,
  RESUMO_MINIMO,
} from "@/lib/atendimento/encerramento";
import { MENSAGEM_DA_TELA, RECUSAS_DO_BANCO } from "@/lib/atendimento/assuntos";

/**
 * O TYPESCRIPT DIZ OS MESMOS NÚMEROS QUE O BANCO (migration 0293).
 *
 * A regra do encerramento é aplicada pela função `fn_atendimento_encerrar`; a
 * tela repete os limites só para avisar antes de mandar. São duas cópias da
 * mesma régua, e a que manda é a do banco: se alguém mudar o mínimo do resumo
 * num lado só, a janela passaria a deixar enviar o que o banco recusa (ou a
 * barrar o que ele aceitaria) — com todos os outros testes verdes.
 *
 * Lê a MIGRATION, e não o baseline: o baseline carrega várias versões da mesma
 * função, e `tests/unit/manifest-x-migrations.test.ts` já garante que os dois
 * andam juntos.
 */
const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261005230000_0293_encerramento_assunto_e_resumo.sql"),
  "utf8",
);

describe("limites do encerramento: TypeScript × migration 0293", () => {
  it("o mínimo do resumo é o da função", () => {
    expect(migration).toContain(`char_length(coalesce(v_resumo, '')) < ${RESUMO_MINIMO} then`);
  });

  it("o teto do resumo é o da função e o do CHECK", () => {
    expect(migration).toContain(`char_length(coalesce(v_resumo, '')) > ${RESUMO_MAXIMO} then`);
    expect(migration).toContain(`char_length(closure_summary) <= ${RESUMO_MAXIMO}`);
  });

  it("o teto do nome do assunto é o da função e o do CHECK", () => {
    expect(migration).toContain(`char_length(v_nome) > ${NOME_DO_ASSUNTO_MAXIMO} then`);
    expect(migration).toContain(`char_length(btrim(name)) between 1 and ${NOME_DO_ASSUNTO_MAXIMO}`);
  });

  it("toda recusa que o TypeScript conhece é levantada pela função, e vice-versa", () => {
    const levantadas = [...migration.matchAll(/raise exception '(encerramento_[a-z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(levantadas)].sort()).toEqual([...MENSAGENS_DE_RECUSA].sort());
  });

  it("toda recusa do cadastro de assuntos tem código e frase na rota", () => {
    const levantadas = [...migration.matchAll(/raise exception '(assunto_[a-z_]+)'/g)].map((m) => m[1]!);
    for (const mensagem of new Set(levantadas)) {
      expect(RECUSAS_DO_BANCO[mensagem], `falta mapear ${mensagem}`).toBeDefined();
      expect(MENSAGEM_DA_TELA[RECUSAS_DO_BANCO[mensagem]!.code]).toBeTruthy();
    }
  });
});
