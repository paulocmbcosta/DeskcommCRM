/**
 * `conectorDoAgente` — o motor chega ao conector SÓ por aqui (importante 11 da
 * revisão do lote B). `./ixc` é substituído por um dublê sem depender do IXC de
 * verdade: o que se testa é a REGRA do registro (pular quem não declara
 * `agente`, devolver o primeiro ligado, `null` sem nenhum), não o conector.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` é IÇADO para o topo do arquivo — uma variável comum, declarada
// depois, ainda não existiria quando a fábrica do mock rodasse (a mensagem de
// erro do próprio Vitest aponta pra isto). `vi.hoisted` sobe JUNTO.
const { conectoresLigados, agenteFalso, conectorIxcDublado } = vi.hoisted(() => {
  const agenteFalso = { consultar: vi.fn(), enviarCobranca: vi.fn() };
  return {
    conectoresLigados: vi.fn(),
    agenteFalso,
    // `agente` começa presente; um teste o apaga pra simular conector sem cobrança.
    conectorIxcDublado: { agente: agenteFalso as typeof agenteFalso | undefined },
  };
});
vi.mock("./conexao", () => ({ conectoresLigados }));
vi.mock("./ixc", () => ({ conectorIxc: conectorIxcDublado }));

import { conectorDoAgente } from "./registro";

beforeEach(() => {
  conectoresLigados.mockReset();
  conectorIxcDublado.agente = agenteFalso;
});

describe("conectorDoAgente", () => {
  it("devolve o primeiro conector LIGADO que declara `agente`", async () => {
    conectoresLigados.mockResolvedValue(["ixc"]);
    const r = await conectorDoAgente({} as never, "org-1");
    expect(r).toEqual({ id: "ixc", agente: agenteFalso });
  });

  it("nenhum conector ligado: null", async () => {
    conectoresLigados.mockResolvedValue([]);
    expect(await conectorDoAgente({} as never, "org-1")).toBeNull();
  });

  it("conector ligado SEM `agente` é PULADO — nunca devolve com agente ausente", async () => {
    conectorIxcDublado.agente = undefined;
    conectoresLigados.mockResolvedValue(["ixc"]);
    expect(await conectorDoAgente({} as never, "org-1")).toBeNull();
  });
});
