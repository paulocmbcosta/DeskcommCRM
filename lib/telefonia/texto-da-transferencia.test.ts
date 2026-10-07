import { describe, expect, it } from "vitest";

import { DESFECHO_NA_TELA_MS, textoDaTransferencia, type EstadoParaOTexto } from "./texto-da-transferencia";

const AGORA = Date.parse("2026-09-30T13:00:00Z");
const base: EstadoParaOTexto = {
  fase: "em_ligacao",
  papelDaEntrada: null,
  transferencia: null,
  transferidaPor: null,
  ultimaTransferencia: null,
};
const aberta = (p: Partial<NonNullable<EstadoParaOTexto["transferencia"]>> = {}) => ({
  tipo: "blind" as const,
  de_nome: "Ana",
  para_nome: "Bruno",
  para_time: null,
  consulta: null,
  ...p,
});
const ultima = (p: Partial<NonNullable<EstadoParaOTexto["ultimaTransferencia"]>> = {}) => ({
  desfecho: "refused",
  motivo: "destino_em_ligacao",
  para_nome: "Bruno",
  para_time: null,
  fui_eu: true,
  fechada_em: new Date(AGORA - 5_000).toISOString(),
  ...p,
});

describe("o que o painel diz da transferência", () => {
  it("ligação comum: nada", () => {
    expect(textoDaTransferencia(base, AGORA)).toBeNull();
    expect(textoDaTransferencia({ ...base, fase: "tocando" }, AGORA)).toBeNull();
  });

  it("a ligação puxada da fila, enquanto conecta (`atendendo`): nada — nem com sobras de uma transferência no estado", () => {
    expect(textoDaTransferencia({ ...base, fase: "atendendo" }, AGORA)).toBeNull();
    expect(
      textoDaTransferencia({ ...base, fase: "atendendo", transferidaPor: "Ana", ultimaTransferencia: ultima() }, AGORA),
    ).toBeNull();
  });

  it("quem recebe vê quem transferiu, tocando e depois de atender", () => {
    expect(textoDaTransferencia({ ...base, fase: "tocando", papelDaEntrada: "transf", transferencia: aberta() }, AGORA)).toEqual({
      texto: "Transferida por {nome}",
      nome: "Ana",
      tom: "info",
    });
    expect(textoDaTransferencia({ ...base, papelDaEntrada: "transf", transferidaPor: "Ana" }, AGORA)).toMatchObject({
      texto: "Transferida por {nome}",
      nome: "Ana",
    });
  });

  it("quem recebe de volta vê que o colega não atendeu", () => {
    expect(textoDaTransferencia({ ...base, fase: "tocando", papelDaEntrada: "volta", transferencia: aberta() }, AGORA)).toEqual({
      texto: "{nome} não atendeu, o cliente voltou",
      nome: "Bruno",
      tom: "info",
    });
  });

  it("consultada: quem transfere vê chamando e depois falando; o colega vê o pedido", () => {
    expect(textoDaTransferencia({ ...base, transferencia: aberta({ tipo: "attended", consulta: "tocando" }) }, AGORA)?.texto).toBe(
      "Chamando {nome}… · cliente em espera",
    );
    expect(textoDaTransferencia({ ...base, transferencia: aberta({ tipo: "attended", consulta: "falando" }) }, AGORA)?.texto).toBe(
      "Falando com {nome} · cliente em espera",
    );
    expect(
      textoDaTransferencia({ ...base, papelDaEntrada: "consulta", transferencia: aberta({ tipo: "attended", consulta: "falando" }) }, AGORA),
    ).toMatchObject({ texto: "{nome} quer transferir um cliente para você", nome: "Ana" });
  });

  it("a recusa aparece com o motivo, só para quem pediu e só por um tempo", () => {
    expect(textoDaTransferencia({ ...base, ultimaTransferencia: ultima() }, AGORA)).toEqual({
      texto: "A pessoa está em outra ligação.",
      nome: null,
      tom: "erro",
    });
    expect(textoDaTransferencia({ ...base, ultimaTransferencia: ultima({ fui_eu: false }) }, AGORA)).toBeNull();
    expect(textoDaTransferencia({ ...base, ultimaTransferencia: ultima() }, AGORA + DESFECHO_NA_TELA_MS)).toBeNull();
    expect(textoDaTransferencia({ ...base, ultimaTransferencia: ultima({ motivo: "motivo_novo_do_worker" }) }, AGORA)?.texto).toBe(
      "A transferência não aconteceu.",
    );
  });

  it("para time: o nome do time", () => {
    expect(textoDaTransferencia({ ...base, transferencia: aberta({ para_nome: null, para_time: "Financeiro" }) }, AGORA)).toMatchObject({
      texto: "Transferindo para {nome}…",
      nome: "Financeiro",
    });
  });
});
