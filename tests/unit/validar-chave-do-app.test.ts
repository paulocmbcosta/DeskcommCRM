/**
 * `validarChaveDoApp` confere a chave secreta direto com o app informado — o
 * caminho de quando o token é de um app e o webhook do número vem de outro
 * (virada do 4063 da Totus, 2026-09-24).
 *
 * O token de app (`<id>|<chave>`) é credencial: vai no header, nunca na URL,
 * que acaba em log.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { validarChaveDoApp } from "@/lib/channels/meta/validate-credentials";

const APP = "690936200035931";
const CHAVE = "chave-do-app-do-webhook-32-carac";

function stub(status: number, corpo: unknown) {
  const spy = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => corpo });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("validarChaveDoApp", () => {
  it("⭐ chave certa: a Meta devolve o próprio app — ok, com o nome", async () => {
    const spy = stub(200, { id: APP, name: "6140637232 - Totus" });
    expect(await validarChaveDoApp({ appId: APP, appSecret: CHAVE, graphVersion: "v21.0" })).toEqual({
      ok: true,
      nomeDoApp: "6140637232 - Totus",
    });
    const [url, init] = spy.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(`https://graph.facebook.com/v21.0/${APP}?fields=id,name`);
    expect(url).not.toContain(CHAVE);
    expect(init.headers.Authorization).toBe(`Bearer ${APP}|${CHAVE}`);
  });

  it("chave errada: o motivo da Meta volta para a tela", async () => {
    stub(400, { error: { message: "Invalid OAuth access token signature." } });
    expect(await validarChaveDoApp({ appId: APP, appSecret: "errada" })).toEqual({
      ok: false,
      motivo: "Invalid OAuth access token signature.",
    });
  });

  it("resposta de OUTRO app não conta como confirmação", async () => {
    stub(200, { id: "111", name: "outro" });
    expect((await validarChaveDoApp({ appId: APP, appSecret: CHAVE })).ok).toBe(false);
  });

  it("rede caída diz que é rede, não chave ruim", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const r = await validarChaveDoApp({ appId: APP, appSecret: CHAVE });
    expect(r).toEqual({ ok: false, motivo: "rede indisponível: ECONNRESET" });
  });
});
