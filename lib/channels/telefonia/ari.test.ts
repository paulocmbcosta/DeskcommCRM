// @vitest-environment node
/**
 * ClienteAri.tocarFala / pararFala — a ARI toca as falas do telefone (URA,
 * aguarde, aviso) e a URA pode interromper uma fala em andamento.
 *
 * Fatos medidos na VPS de produção (Task 0), que este teste reflete:
 *  - POST /channels/{id}/play com `media=sound:<caminho sem extensão>`
 *    responde 201 e devolve `{ id, media_uri, target_uri, language, state }`;
 *  - o fim do playback (`GET /playbacks/{id}`) responde 404 quando já
 *    terminou — parar um playback que já acabou NÃO é erro.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClienteAri, ErroAri } from "./ari";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ari = () => new ClienteAri({ baseUrl: "http://asterisk:8088", senha: "segredo-ari" });

describe("ClienteAri.tocarFala", () => {
  it("POST /channels/<id>/play com a mídia na query e a senha SÓ no header (201 medido na VPS)", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "pb-1", state: "queued" }), { status: 201 }));
    vi.stubGlobal("fetch", f);

    const r = await ari().tocarFala("canal-1", "sound:/var/lib/deskcomm/falas/org/abc");

    expect(r).toEqual({ id: "pb-1", state: "queued" });
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      "http://asterisk:8088/ari/channels/canal-1/play?media=sound%3A%2Fvar%2Flib%2Fdeskcomm%2Ffalas%2Forg%2Fabc",
    );
    expect(init.method).toBe("POST");
    expect(String(url)).not.toContain("segredo-ari");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it("5xx vira ErroAri (não é engolido)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 502 })));

    await expect(ari().tocarFala("canal-1", "sound:/x")).rejects.toBeInstanceOf(ErroAri);
  });
});

describe("ClienteAri.pararFala", () => {
  it("DELETE /playbacks/<id>", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);

    await ari().pararFala("pb-1");

    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://asterisk:8088/ari/playbacks/pb-1");
    expect(init.method).toBe("DELETE");
  });

  it("404 (playback já terminou) NÃO é erro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await expect(ari().pararFala("pb-ja-terminou")).resolves.toBeUndefined();
  });

  it("5xx continua erro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

    await expect(ari().pararFala("pb-1")).rejects.toBeInstanceOf(ErroAri);
  });
});
