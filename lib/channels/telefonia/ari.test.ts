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

    const r = await ari().tocarFala("canal-1", "sound:/var/lib/telefonia/falas/org/abc");

    expect(r).toEqual({ id: "pb-1", state: "queued" });
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      "http://asterisk:8088/ari/channels/canal-1/play?media=sound%3A%2Fvar%2Flib%2Ftelefonia%2Ffalas%2Forg%2Fabc",
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

/**
 * A GRAVAÇÃO DA PONTE (F3). Medido na VPS de produção em 2026-09-29, numa ponte
 * de sonda sem ligação: `POST /bridges/{id}/record` → 201 `state: "queued"`;
 * `POST /recordings/live/{nome}/stop` → 204; `GET /recordings/stored/{nome}/file`
 * → 200 `audio/wav` (PCM 8 kHz, 16 bits, mono, cabeçalho de 44 bytes);
 * `DELETE /recordings/stored/{nome}` → 204.
 */
describe("ClienteAri — gravação da ponte", () => {
  it("gravarPonte: WAV, sem bipe, teto de duração, sobrescreve, sem tecla que encerre", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ name: "g-1", state: "queued" }), { status: 201 }));
    vi.stubGlobal("fetch", f);

    await ari().gravarPonte("p-1", "g-1", 7200);

    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    const u = new URL(String(url));
    expect(u.pathname).toBe("/ari/bridges/p-1/record");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      name: "g-1",
      format: "wav",
      maxDurationSeconds: "7200",
      ifExists: "overwrite",
      beep: "false",
      terminateOn: "none",
    });
    expect(init.method).toBe("POST");
  });

  it("pararGravacao: POST /recordings/live/<nome>/stop; 404 (já parada) não é erro", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    await ari().pararGravacao("g-1");
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://asterisk:8088/ari/recordings/live/g-1/stop");
    expect(init.method).toBe("POST");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(ari().pararGravacao("g-1")).resolves.toBeUndefined();
  });

  it("tocarNaPonte: POST /bridges/<id>/play com a mídia, devolve o playback", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "pb-9" }), { status: 201 }));
    vi.stubGlobal("fetch", f);
    await expect(ari().tocarNaPonte("p-1", "sound:/var/lib/telefonia/falas/o/h")).resolves.toEqual({ id: "pb-9" });
    const [url] = f.mock.calls[0] as unknown as [URL];
    expect(String(url)).toBe("http://asterisk:8088/ari/bridges/p-1/play?media=sound%3A%2Fvar%2Flib%2Ftelefonia%2Ffalas%2Fo%2Fh");
  });

  it("baixarGravacao: grava o corpo no arquivo, sem carregar tudo; 404 é 'ausente'", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "ari-g-"));
    try {
      const corpo = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
      const f = vi.fn(async () => new Response(corpo, { status: 200, headers: { "Content-Type": "audio/wav" } }));
      vi.stubGlobal("fetch", f);
      const destino = join(dir, "g.wav");
      await expect(ari().baixarGravacao("g-1", destino)).resolves.toEqual({ bytes: 7 });
      expect(new Uint8Array(await readFile(destino))).toEqual(corpo);
      const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
      expect(String(url)).toBe("http://asterisk:8088/ari/recordings/stored/g-1/file");
      expect(init.method).toBe("GET");

      vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
      await expect(ari().baixarGravacao("g-2", join(dir, "g2.wav"))).resolves.toBe("ausente");

      vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
      await expect(ari().baixarGravacao("g-3", join(dir, "g3.wav"))).rejects.toBeInstanceOf(ErroAri);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("apagarGravacao: DELETE /recordings/stored/<nome>; 404 não é erro", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    await ari().apagarGravacao("g-1");
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://asterisk:8088/ari/recordings/stored/g-1");
    expect(init.method).toBe("DELETE");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(ari().apagarGravacao("g-1")).resolves.toBeUndefined();
  });

  it("listarGravacoes: os nomes das guardadas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ name: "g-1", format: "wav" }, { name: "sonda", format: "wav" }]), { status: 200 })),
    );
    await expect(ari().listarGravacoes()).resolves.toEqual(["g-1", "sonda"]);
  });

  it("nome com barra é recusado antes de ir à rede", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(ari().apagarGravacao("../x")).rejects.toThrow(/nome de gravação/);
    expect(f).not.toHaveBeenCalled();
  });
});
