import { describe, expect, it } from "vitest";

import { copiaEColaIntegro, crc16DoBrCode, qrCodeDoPix } from "./pix";

/** O exemplo do Manual de Padrões para Iniciação do Pix (BCB) — CRC conhecido: 1D3D. */
const BR_CODE_DO_BCB =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";

describe("crc16DoBrCode", () => {
  it("é CRC16/CCITT-FALSE — o valor de conferência canônico de '123456789' é 29B1", () => {
    expect(crc16DoBrCode("123456789")).toBe("29B1");
  });

  it("fecha com o exemplo do manual do Banco Central", () => {
    expect(crc16DoBrCode(BR_CODE_DO_BCB.slice(0, -4))).toBe("1D3D");
  });
});

describe("copiaEColaIntegro — código que não fecha NÃO é enviado", () => {
  it("aceita o BR Code íntegro (CRC em maiúscula ou minúscula)", () => {
    expect(copiaEColaIntegro(BR_CODE_DO_BCB)).toBe(true);
    expect(copiaEColaIntegro(BR_CODE_DO_BCB.slice(0, -4) + "1d3d")).toBe(true);
  });

  it("recusa um caractere trocado, um caractere a menos e o fim cortado", () => {
    expect(copiaEColaIntegro(BR_CODE_DO_BCB.replace("Fulano", "Fulana"))).toBe(false);
    expect(copiaEColaIntegro(BR_CODE_DO_BCB.replace("BRASILIA", "BRASILI"))).toBe(false);
    expect(copiaEColaIntegro(BR_CODE_DO_BCB.slice(0, -10))).toBe(false);
  });

  it("recusa o que nem tem forma de BR Code", () => {
    for (const lixo of ["", "000201", "https://pix.exemplo/qr/abc", "<html>erro</html>", "  "]) {
      expect(copiaEColaIntegro(lixo)).toBe(false);
    }
  });
});

describe("qrCodeDoPix", () => {
  it("gera um PNG de verdade, com resolução para ser lido de outra tela", async () => {
    const png = await qrCodeDoPix(BR_CODE_DO_BCB);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR: largura e altura em big-endian nos bytes 16–23.
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(600);
    expect(png.readUInt32BE(20)).toBe(png.readUInt32BE(16));
  });
});
