/**
 * O PIX QUE VAI PARA O CLIENTE — conferido antes de sair, e desenhado aqui.
 *
 * O "copia e cola" é um BR Code (EMV): começa em `000201` e termina em `6304` +
 * quatro hexadecimais que são o CRC16 de TUDO o que vem antes. É dinheiro: uma
 * string cortada no meio por um proxy, ou com um caractere a menos, vira um QR
 * que o banco do cliente recusa — ou, pior, que ninguém confere. Por isso o CRC é
 * recalculado aqui, e código que não fecha NÃO é enviado.
 *
 * O QR code é gerado por nós, a partir do copia-e-cola conferido. O IXC devolve
 * uma imagem pronta, mas ela é pequena (~2 KB) e é um SEGUNDO dado: gerar do
 * mesmo texto que o cliente vai colar garante que a câmera e o copiar-e-colar
 * pagam a mesma coisa.
 */
import QRCode from "qrcode";

/** CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — o do padrão do BR Code. */
export function crc16DoBrCode(texto: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(texto, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** O copia-e-cola tem forma de BR Code E o CRC fecha? */
export function copiaEColaIntegro(codigo: string): boolean {
  if (!/^000201[\x20-\x7E -ÿ]{20,}6304[0-9A-Fa-f]{4}$/.test(codigo)) return false;
  return crc16DoBrCode(codigo.slice(0, -4)) === codigo.slice(-4).toUpperCase();
}

/**
 * PNG do QR code. 600px com margem de 4 módulos (a "zona de silêncio" que o
 * padrão pede): o cliente abre a imagem no WhatsApp e aponta OUTRO celular, ou
 * tira print e sobe no app do banco — nos dois casos resolução e margem é o que
 * decide se lê de primeira.
 */
export async function qrCodeDoPix(copiaECola: string): Promise<Buffer> {
  return QRCode.toBuffer(copiaECola, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 4,
    width: 600,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
}
