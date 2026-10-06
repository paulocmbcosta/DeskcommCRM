/**
 * O EVENTO DAS ORDENS DA FILA — a leitura do evento de usuário da ARI que leva
 * "atender" e "mover" da tela para o worker. A mecânica (puxar, mover) mora no
 * controlador e é provada em `controle.test.ts`; aqui, só o que o evento
 * precisa ter para ser uma ordem.
 */
import { describe, expect, it } from "vitest";

import { canal } from "./dubles-de-teste";
import {
  ACOES_DA_FILA,
  CABECALHO_DO_ATENDER,
  EVENTO_DA_FILA,
  TOQUE_DE_QUEM_PUXOU_MS,
  lerOrdemDaFila,
} from "./ordens-da-fila";
import { EVENTO_DA_TRANSFERENCIA } from "./transferencia";

const O1 = "0f000000-0000-4000-8000-000000000001";

const evento = (userevent: unknown, eventname: unknown = EVENTO_DA_FILA) => ({ type: "ChannelUserevent", eventname, userevent });
const variaveis = { acao: "atender", ordem_id: O1, voice_call_id: "vc-1" };

describe("o evento das ordens da fila", () => {
  it("o vocabulário que a rota e o navegador importam não muda de nome sem quebrar aqui", () => {
    expect(EVENTO_DA_FILA).toBe("telefonia_fila");
    expect(CABECALHO_DO_ATENDER).toBe("X-Fila-Atender");
    expect(ACOES_DA_FILA).toEqual(["atender", "mover"]);
    expect(TOQUE_DE_QUEM_PUXOU_MS).toBe(10_000);
    // O nome não pode ser o da transferência: o controlador separa as duas ordens por ele.
    expect(EVENTO_DA_FILA).not.toBe(EVENTO_DA_TRANSFERENCIA);
  });

  it("lê as duas ações, com os ids como vieram", () => {
    expect(lerOrdemDaFila(evento(variaveis))).toEqual({ acao: "atender", ordemId: O1, voiceCallId: "vc-1" });
    expect(lerOrdemDaFila(evento({ ...variaveis, acao: "mover" }))).toEqual({ acao: "mover", ordemId: O1, voiceCallId: "vc-1" });
  });

  it("nome de outro evento → null (a transferência não é ordem da fila)", () => {
    expect(lerOrdemDaFila(evento(variaveis, EVENTO_DA_TRANSFERENCIA))).toBeNull();
    expect(lerOrdemDaFila(evento(variaveis, "outra"))).toBeNull();
    // Sem nome nenhum (o `undefined` do helper viraria o nome certo — por isso o objeto à mão).
    expect(lerOrdemDaFila({ type: "ChannelUserevent", userevent: variaveis })).toBeNull();
    expect(lerOrdemDaFila(evento(variaveis, null))).toBeNull();
    expect(lerOrdemDaFila({ type: "StasisStart", channel: canal("cli-1", "PJSIP/tronco-x-00000001"), args: [] })).toBeNull();
  });

  it("ação desconhecida, ids sujos ou variáveis ausentes → null", () => {
    expect(lerOrdemDaFila(evento({ ...variaveis, acao: "sequestrar" }))).toBeNull();
    expect(lerOrdemDaFila(evento({ ...variaveis, acao: undefined }))).toBeNull();
    // O id da ordem vai ao banco: tem de ser uuid.
    expect(lerOrdemDaFila(evento({ ...variaveis, ordem_id: "x'; drop" }))).toBeNull();
    expect(lerOrdemDaFila(evento({ ...variaveis, ordem_id: "ordem-1" }))).toBeNull();
    expect(lerOrdemDaFila(evento({ ...variaveis, ordem_id: 7 }))).toBeNull();
    // O da ligação é procurado na memória do worker: basta ser um identificador limpo.
    expect(lerOrdemDaFila(evento({ ...variaveis, voice_call_id: "../../etc" }))).toBeNull();
    expect(lerOrdemDaFila(evento({ ...variaveis, voice_call_id: "" }))).toBeNull();
    expect(lerOrdemDaFila(evento({ ...variaveis, voice_call_id: "v".repeat(65) }))).toBeNull();
    expect(lerOrdemDaFila(evento(undefined))).toBeNull();
    expect(lerOrdemDaFila(evento("acao=atender"))).toBeNull();
    expect(lerOrdemDaFila(evento(null))).toBeNull();
  });

  it("o `eventname` repetido dentro de `userevent` é ignorado: quem manda é o do evento", () => {
    // O Asterisk repete o nome dentro das variáveis — a ordem é a mesma com ele…
    expect(lerOrdemDaFila(evento({ eventname: EVENTO_DA_FILA, ...variaveis }))).toEqual({
      acao: "atender",
      ordemId: O1,
      voiceCallId: "vc-1",
    });
    // …e uma VARIÁVEL com o nome certo não transforma outro evento em ordem da fila.
    expect(lerOrdemDaFila(evento({ eventname: EVENTO_DA_FILA, ...variaveis }, "outra"))).toBeNull();
    // Nem o contrário: o nome de dentro, diferente, não desfaz a ordem.
    expect(lerOrdemDaFila(evento({ eventname: "outra", ...variaveis }))).not.toBeNull();
  });

  it("nada além dos ids e da ação sai do evento (o resto se relê do banco)", () => {
    const lida = lerOrdemDaFila(evento({ ...variaveis, organization_id: "org-de-outro", to_user_id: "alguem", kind: "move" }));
    expect(lida).toEqual({ acao: "atender", ordemId: O1, voiceCallId: "vc-1" });
    expect(Object.keys(lida!)).toEqual(["acao", "ordemId", "voiceCallId"]);
  });
});
