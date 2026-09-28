import { describe, expect, it } from "vitest";

import { binaParaE164, numeroParaLigar } from "./numero";

describe("numeroParaLigar — o que o CRM aceita discar", () => {
  it.each([
    ["(61) 3686-1503", "+556136861503", "6136861503"],
    ["61 98888-7777", "+5561988887777", "61988887777"],
    ["+55 61 3686 1503", "+556136861503", "6136861503"],
    ["5561988887777", "+5561988887777", "61988887777"],
    ["061 3686-1503", "+556136861503", "6136861503"],
    ["0 15 61 3686 1503", "+556136861503", "6136861503"],
    ["0xx61 36861503", "+556136861503", "6136861503"],
  ])("%s → %s (disca %s)", (bruto, e164, discar) => {
    expect(numeroParaLigar(bruto)).toEqual({ ok: true, e164, discar });
  });

  it.each([
    ["", "vazio"],
    ["   ", "vazio"],
    ["+1 212 555 0100", "internacional"],
    ["+351 912 345 678", "internacional"],
    ["00 1 212 555 0100", "internacional"],
    ["0900 123 4567", "nao_geografico"],
    ["0300 123 4567", "nao_geografico"],
    ["0303 123 4567", "nao_geografico"],
    ["0500 123 4567", "nao_geografico"],
    ["0800 123 4567", "nao_geografico"],
    ["4004-1234", "nao_geografico"],
    ["190", "sem_ddd"],
    ["3686-1503", "sem_ddd"],
    ["20 3686-1503", "ddd_invalido"],
    ["61 1686-1503", "invalido"],
    ["61 8888-77777", "invalido"],
    ["123456789012", "invalido"],
  ])("recusa %j (%s)", (bruto, motivo) => {
    expect(numeroParaLigar(bruto)).toEqual({ ok: false, motivo });
  });
});

describe("binaParaE164 — quem ligou, sem política", () => {
  it.each([
    ["6136861503", "+556136861503"],
    ["061988887777", "+5561988887777"],
    ["+5561988887777", "+5561988887777"],
    ["5561988887777", "+5561988887777"],
    ["00351912345678", "+351912345678"],
  ])("%s → %s", (bruto, e164) => {
    expect(binaParaE164(bruto)).toBe(e164);
  });

  it.each(["", "anonymous", "Restricted", "123"])("sem número utilizável: %j", (bruto) => {
    expect(binaParaE164(bruto)).toBeNull();
  });
});
