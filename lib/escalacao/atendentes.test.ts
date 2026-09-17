/**
 * Uma agenda ilegível tira O ATENDENTE, nunca a lista inteira.
 *
 * `attendant_availability.schedule` é `jsonb` sem CHECK, e a escrita não valida
 * conteúdo: `America/Asunción` — com o acento que um hispanofalante escreve
 * natural — entra no banco e o parser recusa na leitura. Enquanto
 * `podeAssumirAgora` fazia `.parse()`, UMA linha assim lançava dentro do
 * `roster.filter(...)` dos consumidores (o aviso ao lead no handoff e a
 * capacidade do agente) e derrubava a lista inteira — a organização ficava sem
 * nenhum elegível por causa da agenda de UMA pessoa, e sem sintoma que
 * apontasse a causa.
 *
 * O cenário tem gente BOA de propósito: sem ela, o caso passaria por acerto —
 * "nenhum elegível" também é o resultado de uma lista derrubada.
 */
import { describe, expect, it } from "vitest";

import { podeAssumirAgora, type AtendenteDoRoster } from "./atendentes";

const AGORA = new Date("2026-08-05T15:00:00.000Z");

/** Linha de roster que é elegível por construção — o que varia é o `over`. */
function doRoster(over: Partial<AtendenteDoRoster> = {}): AtendenteDoRoster {
  return {
    userId: "ana",
    papel: "agent",
    disponivel: true,
    capacidade: 5,
    agenda: { timezone: "America/Sao_Paulo", windows: [] },
    ultimoSinalDeVida: null,
    atualizadoEm: null,
    cargaAtual: 0,
    ...over,
  };
}

describe("podeAssumirAgora com agenda que o banco aceita e o parser não lê", () => {
  it("tira só o atendente de agenda ruim; os demais continuam elegíveis", () => {
    const roster = [
      doRoster({ userId: "boa" }),
      doRoster({ userId: "ruim", agenda: { timezone: "America/Asunción", windows: [] } }),
      doRoster({ userId: "outra-boa" }),
    ];
    // Este `filter` é o consumidor REAL, copiado de lib/ai/handoff/aviso-ao-lead.ts.
    const elegiveis = roster.filter((a) => podeAssumirAgora(a, AGORA)).map((a) => a.userId);
    expect(elegiveis).toEqual(["boa", "outra-boa"]);
  });

  it("agenda ilegível é FECHADO, nunca 24/7", () => {
    // Decisão do dono do produto: fechado é visível (a conversa espera na fila e
    // a Central avisa). Tratar como "sem restrição de horário" ofereceria um
    // atendente fora do expediente dele — mentira sem sintoma.
    const ruim = doRoster({ agenda: { timezone: "America/Asunción", windows: [] } });
    expect(podeAssumirAgora(ruim, AGORA)).toBe(false);

    // Controle: a MESMA linha com o fuso escrito sem acento é elegível. O que
    // muda o veredito é a agenda, não o resto do registro.
    const boa = doRoster({ agenda: { timezone: "America/Asuncion", windows: [] } });
    expect(podeAssumirAgora(boa, AGORA)).toBe(true);
  });
});
