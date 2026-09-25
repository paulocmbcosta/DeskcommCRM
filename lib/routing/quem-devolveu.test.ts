import { describe, expect, it } from "vitest";

import { quemDevolveuAFila } from "./quem-devolveu";

const ANA = "ana";
const BIA = "bia";

describe("quemDevolveuAFila — quem fica fora do rodízio desta conversa", () => {
  it("quem devolveu à fila do time (team_transfer, sem destinatário) fica de fora", () => {
    expect(quemDevolveuAFila({ reason: "team_transfer", from_user_id: ANA, to_user_id: null })).toBe(ANA);
  });

  it("assim que outra pessoa recebe, ninguém mais fica de fora", () => {
    expect(quemDevolveuAFila({ reason: "routing", from_user_id: null, to_user_id: BIA })).toBeNull();
  });

  it("liberar (release) não é devolver ao time: não exclui ninguém", () => {
    expect(quemDevolveuAFila({ reason: "release", from_user_id: ANA, to_user_id: null })).toBeNull();
  });

  it("encaminhamento sem dono anterior não tem quem excluir", () => {
    expect(quemDevolveuAFila({ reason: "team_transfer", from_user_id: null, to_user_id: null })).toBeNull();
  });

  it("sem evento no atendimento atual, ninguém fica de fora", () => {
    expect(quemDevolveuAFila(null)).toBeNull();
  });
});
