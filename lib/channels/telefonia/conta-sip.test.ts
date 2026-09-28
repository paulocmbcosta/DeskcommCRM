/**
 * O SERVIDOR SIP É A OPERADORA — NUNCA A REDE DO PRÓPRIO SERVIDOR.
 *
 * O servidor digitado vira destino de REGISTER e OPTIONS a cada 25 s, na porta
 * que o admin escolher, saindo do Asterisk — que mora na rede interna do
 * compose, ao lado do Redis sem senha, do app e da ARI. A regex antiga aceitava
 * `localhost`, `127.0.0.1`, `asterisk`, `redis`, `10.x` e `169.254.169.254`
 * (metadados da nuvem): o formulário de "número de telefone" era uma sonda da
 * rede interna. Estes casos medem a régua que a rota (Zod) e o worker
 * (`problemaDoTronco`) compartilham.
 */
import { describe, expect, it } from "vitest";

import {
  motivoDoServidorInvalido,
  normalizarServidor,
  portaSipValida,
  prefixoDeDiscagemValido,
  servidorSipValido,
  usuarioSipValido,
} from "./conta-sip";

describe("servidor SIP: só endereço público", () => {
  it.each([
    "voip.totussistema.com.br",
    "VOIP.TotusSistema.com.br",
    "sip.operadora-exemplo.net",
    "45.5.156.58",
    "8.8.8.8",
    "172.32.0.1", // logo depois de 172.16/12
    "192.169.0.1", // logo depois de 192.168/16
    "11.0.0.1", // logo depois de 10/8
  ])("aceita %s", (host) => {
    expect(motivoDoServidorInvalido(host)).toBeNull();
    expect(servidorSipValido(host)).toBe(true);
  });

  it.each([
    ["localhost", "loopback por nome"],
    ["telefone.localhost", "subdomínio de localhost"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback é a /8 inteira"],
    ["0.0.0.0", "este host"],
    ["10.0.0.5", "10/8"],
    ["172.16.0.1", "172.16/12 — início"],
    ["172.31.255.254", "172.16/12 — fim (redes do Docker)"],
    ["192.168.1.10", "192.168/16"],
    ["169.254.169.254", "metadados da nuvem (link-local)"],
    ["asterisk", "serviço do compose"],
    ["redis", "serviço do compose"],
    ["app", "serviço do compose"],
    ["2130706433", "127.0.0.1 em decimal, rótulo único"],
  ])("recusa %s (%s) como interno", (host) => {
    expect(motivoDoServidorInvalido(host)).toBe("interno");
    expect(servidorSipValido(host)).toBe(false);
  });

  it.each([
    ["0x7f.1", "127.0.0.1 em hexadecimal: inet_aton aceitaria"],
    ["0177.0.0.1", "127.0.0.1 em octal"],
    ["012.0.0.1", "10.0.0.1 em octal"],
    ["127.1", "IP abreviado"],
    ["256.1.1.1", "octeto fora da faixa"],
    ["voip.exemplo.com,sip:evil.example", "vírgula: viraria um segundo contato na AOR"],
    ["voip.exemplo.com:5060", "porta colada (a rota tira antes; a coluna crua não pode ter)"],
    ["sip:voip.exemplo.com", "esquema colado"],
    ["voip exemplo.com", "espaço"],
    ["voip.exemplo.com\nx", "quebra de linha"],
    ["", "vazio"],
  ])("recusa %j (%s) pelo formato", (host) => {
    expect(motivoDoServidorInvalido(host)).toBe("formato");
  });

  it("a normalização tira esquema e porta e baixa a caixa — e o resultado passa na régua", () => {
    expect(normalizarServidor("  SIP:Voip.TotusSistema.com.br:5080 ")).toBe("voip.totussistema.com.br");
    expect(normalizarServidor("sips:45.5.156.58:5061")).toBe("45.5.156.58");
    expect(servidorSipValido(normalizarServidor("sip:voip.totussistema.com.br:5060"))).toBe(true);
  });
});

describe("usuário e porta", () => {
  it.each(["6136861503", "totus_3025", "a.b-c", "user,comma"])("aceita o usuário %j", (u) => {
    expect(usuarioSipValido(u)).toBe(true);
  });

  it.each(["", "a@b", "a:b", "a;b", "a<b", 'a"b', "a b", "a\tb", "a\u0001b", "x".repeat(65)])(
    "recusa o usuário %j",
    (u) => {
      expect(usuarioSipValido(u)).toBe(false);
    },
  );

  it("porta de 1 a 65535, inteira", () => {
    expect(portaSipValida(5060)).toBe(true);
    expect(portaSipValida(1)).toBe(true);
    expect(portaSipValida(65535)).toBe(true);
    expect(portaSipValida(0)).toBe(false);
    expect(portaSipValida(65536)).toBe(false);
    expect(portaSipValida(5060.5)).toBe(false);
    expect(portaSipValida(Number.NaN)).toBe(false);
  });
});

describe("prefixo de discagem: só dígitos, de 1 a 4", () => {
  it.each(["0", "015", "0021", "9"])("aceita %j", (p) => {
    expect(prefixoDeDiscagemValido(p)).toBe(true);
  });

  // Tudo o que mudaria o destino PJSIP (`PJSIP/<prefixo><número>@tronco-<id>`)
  // ou não é prefixo de ninguém.
  it.each(["", "01234", "0a", "+55", "0@10.0.0.5", "0/1", "0,1", "0&x", " 0", "0\n", "０"])("recusa %j", (p) => {
    expect(prefixoDeDiscagemValido(p)).toBe(false);
  });
});
