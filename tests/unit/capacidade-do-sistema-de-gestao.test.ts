import { describe, expect, it } from "vitest";

import { NATIVAS_DO_MOTOR } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { FERRAMENTAS_DO_CONECTOR } from "@/lib/conectores/ferramentas-do-agente";
import { capacidadesAutomaticasDoPacote } from "@/lib/mcp/tools/selecao-por-pacote";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { getToolByName } from "@/lib/mcp/tools";

describe("as ferramentas do conector na tela", () => {
  it("estão no catálogo, com os ids da fonte única", () => {
    for (const id of FERRAMENTAS_DO_CONECTOR) expect(TOOL_CATALOG.map((t) => t.name)).toContain(id);
  });

  it("enviar cobrança é CRÍTICA: ligar o pacote Atender não a liga sozinha", () => {
    expect(TOOL_CATALOG.find((t) => t.name === "crm_enviar_cobranca_erp")?.risco).toBe("critico");
    expect(capacidadesAutomaticasDoPacote(TOOL_CATALOG, "atender")).not.toContain("crm_enviar_cobranca_erp");
  });

  it("o handler MCP RECUSA fora de uma conversa do agente (não consulta nem envia nada)", async () => {
    for (const id of FERRAMENTAS_DO_CONECTOR) {
      const r = (await getToolByName(id)!.handler({} as never, {} as never)) as { error?: string };
      expect(r.error).toMatch(/dentro de uma conversa/);
    }
  });

  it("a ponte MCP nunca as monta — nem no Conversador sem conector, nem no Operador", () => {
    for (const id of FERRAMENTAS_DO_CONECTOR) expect(NATIVAS_DO_MOTOR.has(id)).toBe(true);
  });
});
