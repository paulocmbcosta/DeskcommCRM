/**
 * OS OBJETOS PJSIP DO TRONCO — o que vai para o Asterisk, campo a campo.
 *
 * O caso que abriu este arquivo (revisão de segurança, 2026-09-28): o endpoint
 * do tronco herdava o `identify_by=username,ip` do Asterisk e não tem `auth` de
 * entrada. Medido num Asterisk 20 com exatamente estes objetos: uma INVITE com
 * `From: <sip:tronco-<id>@qualquer>` casava o tronco pelo nome, era atendida,
 * e o `P-Asserted-Identity` inventado virava o número do cliente. Com
 * `identify_by=ip` e nenhum `identify`, a mesma INVITE leva 401; a ligação real
 * segue casando pelo `line` do registro (medido na VPS no mesmo dia).
 */
import { describe, expect, it } from "vitest";

import { objetosDoTronco, problemaDoTronco, type ObjetoPjsip, type TroncoSip } from "./pjsip";

const tronco: TroncoSip = {
  id: "11111111-1111-4111-8111-111111111111",
  servidor: "voip.totussistema.com.br",
  porta: 5060,
  transporte: "udp",
  usuario: "6136861503",
  senha: "segredo",
};

const campo = (o: ObjetoPjsip | undefined, nome: string) => o?.campos.filter((c) => c.attribute === nome).map((c) => c.value);

describe("o tronco só é reconhecido pelo próprio registro", () => {
  const objetos = objetosDoTronco(tronco);
  const endpoint = objetos.find((o) => o.tipo === "endpoint");
  const registro = objetos.find((o) => o.tipo === "registration");

  it("o endpoint se identifica SÓ por IP — nunca pelo nome no From", () => {
    expect(campo(endpoint, "identify_by")).toEqual(["ip"]);
  });

  it("e nenhum objeto `identify` acompanha o tronco: por IP, nada casa", () => {
    // `identify_by=ip` com um `identify` casando o IP da operadora devolveria o
    // furo por outro caminho — qualquer INVITE vinda daquele IP (de qualquer
    // cliente da operadora) cairia neste tronco.
    expect(objetos.map((o) => o.tipo)).not.toContain("identify");
  });

  it("a ligação real continua casando pelo `line` do registro, apontado para ESTE endpoint", () => {
    expect(campo(registro, "line")).toEqual(["yes"]);
    expect(campo(registro, "endpoint")).toEqual([endpoint!.id]);
  });

  it("o endpoint confia na identidade que chega — por isso a identificação precisa ser estrita", () => {
    // Se alguém tirar o `trust_id_inbound`, este teste pede que reavalie a
    // decisão acima em vez de deixá-la órfã.
    expect(campo(endpoint, "trust_id_inbound")).toEqual(["yes"]);
    expect(campo(endpoint, "auth")).toEqual([]);
  });
});

describe("problemaDoTronco — a régua antes de virar campo PJSIP", () => {
  it("tronco da tela passa", () => {
    expect(problemaDoTronco(tronco)).toBeNull();
  });

  it.each([
    [{ servidor: "voip.exemplo.com,sip:evil.example" }, "servidor_invalido"],
    [{ servidor: "redis" }, "servidor_invalido"],
    [{ servidor: "127.0.0.1" }, "servidor_invalido"],
    [{ servidor: "169.254.169.254" }, "servidor_invalido"],
    [{ usuario: "a;transport=tcp" }, "usuario_invalido"],
    [{ usuario: "a@evil.example" }, "usuario_invalido"],
    [{ porta: 0 }, "porta_invalida"],
    [{ porta: 70000 }, "porta_invalida"],
  ] as const)("recusa %j → %s", (mudanca, motivo) => {
    expect(problemaDoTronco({ ...tronco, ...mudanca })).toBe(motivo);
  });
});
