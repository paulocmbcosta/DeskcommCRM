import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { FERRAMENTAS_DE_ENVIO } from "@/lib/agent-engine/edge/llm/fila-de-envio";
import { applyPreviewPolicy } from "@/lib/agent-engine/agent/preview";

/**
 * A LIGAÇÃO das ferramentas do conector no turno — o que nenhum teste das peças toca.
 * Prova que as quatro decisões estão escritas no código que roda; cada uma quebraria
 * em silêncio num refactor. NÃO prova que um modelo de verdade escolhe a ferramenta —
 * isso é o e2e (`tests/e2e/conector-ixc-no-painel.spec.ts`).
 */
const TURNO = fs.readFileSync(path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

describe("ferramentas do conector no turno", () => {
  it("o turno as monta e a saída delas passa pela cadeia com conteudoDoSistema", () => {
    expect(TURNO).toContain("montarFerramentasDoConector(");
    const bloco = TURNO.slice(TURNO.indexOf("montarFerramentasDoConector("));
    expect(bloco.slice(0, 4000)).toMatch(/runBeforeSend\(\{[\s\S]*conteudoDoSistema: true/);
    expect(bloco.slice(0, 4000)).toMatch(/seq \+= 1/);
  });

  it("capacidade ligada sem conector vira aviso na Central", () => {
    const bloco = TURNO.slice(TURNO.indexOf("montarFerramentasDoConector("));
    expect(bloco.slice(0, 5000)).toContain("avisarCapacidadesAusentes(");
  });

  it("a cobrança entra na fila de envio (ordem com o send_message)", () => {
    expect(FERRAMENTAS_DE_ENVIO).toContain("crm_enviar_cobranca_erp");
  });

  it("no botão Testar as duas viram proposta: nada é consultado nem enviado", async () => {
    let executou = false;
    const real = { description: "x", inputSchema: {} as never, execute: async () => { executou = true; return {}; } };
    const preview = { kind: "sandbox", contactId: "lead-real", result: { proposals: [] as unknown[], impediments: [], candidates: [] } };
    const tools = applyPreviewPolicy(
      { crm_consultar_cliente_erp: real, crm_enviar_cobranca_erp: real } as never,
      preview as never,
      {} as never,
      () => [],
    ) as unknown as Record<string, { execute: (a: unknown) => Promise<{ status?: string }> }>;
    for (const nome of ["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]) {
      expect((await tools[nome]!.execute({})).status).toBe("proposal_only");
    }
    expect(executou).toBe(false);
    expect(preview.result.proposals).toHaveLength(2);
  });
});
