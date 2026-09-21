// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { asSchema } from "ai";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  setoresDaTransferencia,
  type SetorDaTransferencia,
} from "@/lib/agent-engine/agent/human-handoff";
import {
  AGENT_TOOL_DEFS,
  ferramentaDeTransferencia,
} from "@/lib/agent-engine/agent/inbound-turn";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/**
 * A ferramenta de transferência carrega o catálogo de setores DENTRO dela.
 *
 * Medido em produção: com os setores abaixo, o modelo não consultou `crm_list_teams`
 * e passou `team: "fornecedores"` — que não existe. A recusa ensina e ele se corrige,
 * mas gasta um step e arrisca terminar o turno sem transferir. Com o catálogo no
 * schema, o slug válido está na frente dele no momento da chamada.
 */

const SETORES: SetorDaTransferencia[] = [
  { slug: "cancelamentos", name: "Cancelamentos", description: "Pedido de cancelamento do plano." },
  { slug: "cobranca", name: "Cobrança", description: "Boleto, 2ª via, pagamento em atraso." },
  { slug: "comercial", name: "Comercial", description: "Planos, preços e contratação." },
  {
    slug: "fornecedores-e-parceiros",
    name: "Fornecedores e parceiros",
    description: "Quem quer VENDER para a empresa\nou propor parceria.",
  },
  { slug: "suporte-tecnico", name: "Suporte técnico", description: "" },
];

async function jsonSchemaDe(setores: SetorDaTransferencia[]) {
  const def = ferramentaDeTransferencia(setores);
  return (await asSchema(def.inputSchema).jsonSchema) as {
    properties: { team: { enum?: string[]; type?: string } };
  };
}

describe("sem setores, a ferramenta é exatamente a de antes", () => {
  it("devolve o MESMO objeto de AGENT_TOOL_DEFS — descrição e schema", () => {
    expect(ferramentaDeTransferencia([])).toBe(AGENT_TOOL_DEFS.request_human_handoff);
  });

  it("e `team` segue texto livre, sem enum", async () => {
    const schema = await jsonSchemaDe([]);
    expect(schema.properties.team.enum).toBeUndefined();
    expect(schema.properties.team.type).toBe("string");
  });
});

describe("com setores, o catálogo vai dentro da ferramenta", () => {
  it("`team` ganha enum com os slugs ativos, na ordem recebida", async () => {
    const schema = await jsonSchemaDe(SETORES);
    expect(schema.properties.team.enum).toEqual(SETORES.map((s) => s.slug));
  });

  it("a descrição lista slug — nome — quando usar de cada setor", () => {
    const { description } = ferramentaDeTransferencia(SETORES);
    expect(description).toContain("- comercial — Comercial — Planos, preços e contratação.");
    expect(description).toContain(
      "- fornecedores-e-parceiros — Fornecedores e parceiros — Quem quer VENDER para a empresa ou propor parceria.",
    );
    // Sem "quando usar" cadastrado, a linha não ganha um travessão pendurado.
    expect(description.endsWith("\n- suporte-tecnico — Suporte técnico")).toBe(true);
  });

  it("o resto da descrição (avisar antes, nunca 'já chamei') continua o mesmo texto", () => {
    const base = AGENT_TOOL_DEFS.request_human_handoff.description;
    const { description } = ferramentaDeTransferencia(SETORES);
    const antesDoDestino = base.slice(0, base.indexOf("DESTINO:"));
    expect(antesDoDestino.length).toBeGreaterThan(100);
    expect(description.startsWith(antesDoDestino)).toBe(true);
    // O parágrafo trocado é o que mandava consultar antes de transferir.
    expect(description).not.toContain("consulte crm_list_teams e passe o slug");
  });

  it("pede o NOME ao falar com o cliente — o slug é da ferramenta", () => {
    expect(ferramentaDeTransferencia(SETORES).description).toMatch(/fale o NOME do setor, nunca o slug/);
  });

  it("slug fora da lista ainda passa pela validação do SDK — a recusa que ensina é a nossa", async () => {
    // `z.enum` faria o SDK recusar antes do execute, com um erro de validação cru.
    // A regra do schema LARGO desta ferramenta manda o slug inválido chegar a
    // `applyRequestHumanHandoff`, que devolve a lista e o "nada foi alterado".
    const validado = await asSchema(ferramentaDeTransferencia(SETORES).inputSchema).validate!({
      team: "fornecedores",
    });
    expect(validado.success).toBe(true);
  });

  it("mesma entrada, mesmos bytes — a ferramenta está no prefixo cacheado", async () => {
    const a = ferramentaDeTransferencia(SETORES);
    const b = ferramentaDeTransferencia(SETORES);
    expect(a.description).toBe(b.description);
    expect(JSON.stringify(await asSchema(a.inputSchema).jsonSchema)).toBe(
      JSON.stringify(await asSchema(b.inputSchema).jsonSchema),
    );
  });

  it("nada volátil entra: o tipo do setor só tem slug, nome e 'quando usar'", () => {
    // "Aberto agora" e elegíveis mudam a cada minuto; no prefixo, derrubariam o
    // cache da organização a cada turno. Um campo a mais no setor seria o começo.
    const chaves: Array<keyof SetorDaTransferencia> = ["slug", "name", "description"];
    const setor: SetorDaTransferencia = { slug: "x", name: "X", description: "" };
    expect(Object.keys(setor).sort()).toEqual([...chaves].sort());
    expect(ferramentaDeTransferencia([setor]).description).not.toMatch(/aberto agora|open_now|eligible/i);
  });
});

describe("a leitura do catálogo nunca derruba o turno", () => {
  const log = (): Logger & { warn: ReturnType<typeof vi.fn> } =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never;

  it("lê os setores ativos da organização pela query do validador", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: "t1", slug: "comercial", name: "Comercial", description: "Planos." }],
    });
    const setores = await setoresDaTransferencia({ query } as unknown as pg.Pool, "org-1", log());
    expect(setores).toEqual([{ slug: "comercial", name: "Comercial", description: "Planos." }]);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/from attendance_teams/);
    expect(sql).toMatch(/organization_id = \$1 and archived_at is null/);
    expect(params).toEqual(["org-1"]);
  });

  it("falha de leitura devolve [] e registra — a ferramenta volta à forma antiga", async () => {
    const l = log();
    const query = vi.fn().mockRejectedValue(new Error("connection terminated"));
    const setores = await setoresDaTransferencia({ query } as unknown as pg.Pool, "org-1", l);
    expect(setores).toEqual([]);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(ferramentaDeTransferencia(setores)).toBe(AGENT_TOOL_DEFS.request_human_handoff);
  });
});

/**
 * FIAÇÃO — o turno monta a ferramenta com o catálogo lido NELE.
 *
 * Guarda de ligação; o comportamento com banco de verdade está em
 * `tests/invariants/transferencia-conhece-os-setores.test.ts`.
 */
describe("fiação — o turno entrega o catálogo à ferramenta", () => {
  const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

  it("a ferramenta do turno sai de `ferramentaDeTransferencia`, não da definição fixa", () => {
    expect(FONTE).toMatch(/request_human_handoff: tool\(\{\s*\.\.\.ferramentaDeTransferencia\(setoresDoTurno\)/);
    expect(FONTE).not.toMatch(/\.\.\.AGENT_TOOL_DEFS\.request_human_handoff/);
  });

  it("o catálogo é lido pelo `pool` do turno (sem HTTP na prévia), com o tenant do turno", () => {
    expect(FONTE).toMatch(/await setoresDaTransferencia\(pool, tenantId, runLog\)/);
  });

  it("o handoff determinístico (antes do modelo) não passa pelo catálogo", () => {
    // Pedido explícito de humano por regex silencia o turno antes do modelo e vai à
    // fila geral — decisão que este conserto não muda. O catálogo é lido DEPOIS do
    // `return` desse caminho: nem uma consulta a mais nele.
    const deteccao = FONTE.indexOf("detectHumanHandoffRequest(texto)");
    const retorno = FONTE.indexOf("return; // bot silencia: o aviso já saiu", deteccao);
    const leitura = FONTE.indexOf("await setoresDaTransferencia(");
    expect(deteccao).toBeGreaterThan(-1);
    expect(retorno).toBeGreaterThan(deteccao);
    expect(leitura).toBeGreaterThan(retorno);
    expect(FONTE.slice(deteccao, retorno)).not.toMatch(/setoresDoTurno|setoresDaTransferencia/);
  });
});
