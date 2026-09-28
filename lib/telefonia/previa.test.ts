// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

import type { PortaDoArmazem } from "./armazem";
import { ErroDaElevenLabs, sintetizar as sintetizarDeVerdade } from "./elevenlabs";
import { caminhoDaFala, hashDaFala } from "./falas";
import { gerarPrevia, type PedidoDePrevia } from "./previa";
import { STATUS_DA_FALHA } from "./servico-de-falas";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA = "00000000-0000-4000-8000-00000000000b";
const VOZ = { voiceId: "voz-1", modelId: "eleven_multilingual_v2" };
const TEXTO = "Aguarde, por favor.";

/** O Storage em memória, com a regra da porta de verdade: o primeiro a gravar um caminho vence. */
class ArmazemFalso implements Pick<PortaDoArmazem, "baixar" | "enviar"> {
  objetos = new Map<string, Uint8Array>();
  falharEnvio = false;
  /** O Storage fora do ar na LEITURA: a porta de verdade lança (não é "não existe"). */
  falharBaixar = false;
  /** Quantas leituras passam antes de `falharBaixar` valer (para falhar só a releitura). */
  leiturasAntesDeFalhar = 0;
  enviar = async (caminho: string, bytes: Uint8Array) => {
    if (this.falharEnvio) throw new Error("armazem_envio: StorageApiError 500: Internal Server Error");
    if (this.objetos.has(caminho)) return "ja_existia" as const;
    this.objetos.set(caminho, new Uint8Array(bytes));
    return "gravado" as const;
  };
  baixar = async (caminho: string) => {
    if (this.falharBaixar) {
      if (this.leiturasAntesDeFalhar > 0) this.leiturasAntesDeFalhar--;
      else throw new Error("armazem_download: StorageApiError 503: Service Unavailable");
    }
    const b = this.objetos.get(caminho);
    return b ? new Uint8Array(b) : null;
  };
}

let armazem: ArmazemFalso;
let sintetizar: ReturnType<typeof vi.fn>;
let consumirCota: ReturnType<typeof vi.fn>;

const pedido = (p: Partial<PedidoDePrevia> = {}): PedidoDePrevia => ({
  armazem,
  sintetizar: sintetizar as unknown as PedidoDePrevia["sintetizar"],
  consumirCota: consumirCota as unknown as PedidoDePrevia["consumirCota"],
  organizationId: ORG,
  texto: TEXTO,
  chave: "sk_x",
  voz: VOZ,
  ...p,
});

beforeEach(() => {
  armazem = new ArmazemFalso();
  sintetizar = vi.fn(async () => new Uint8Array(1600));
  consumirCota = vi.fn(async () => true);
  for (const f of Object.values(vi.mocked(logger))) f.mockClear();
});

/** Tudo o que foi para o log, como texto — para provar o que NÃO foi. */
const tudoNoLog = () => JSON.stringify(Object.values(vi.mocked(logger)).map((f) => f.mock.calls));

describe("gerarPrevia — a ÚNICA hora em que a ElevenLabs é chamada", () => {
  it("prévia nova: gasta uma da cota, sintetiza UMA vez e grava em <org>/<hash>.ulaw", async () => {
    const r = await gerarPrevia(pedido());
    const hash = hashDaFala(TEXTO, VOZ.voiceId, VOZ.modelId);
    expect(r).toMatchObject({ ok: true, hash, duracaoMs: 200, reaproveitada: false });
    expect(sintetizar).toHaveBeenCalledTimes(1);
    expect(sintetizar).toHaveBeenCalledWith({ chave: "sk_x", voiceId: "voz-1", modelId: "eleven_multilingual_v2", texto: TEXTO });
    expect(consumirCota).toHaveBeenCalledTimes(1);
    expect([...armazem.objetos.keys()]).toEqual([caminhoDaFala(ORG, hash)]);
  });

  it("o mesmo texto com a mesma voz de novo (espaços nas pontas não contam): reaproveita — nem ElevenLabs, nem cota", async () => {
    await gerarPrevia(pedido());
    sintetizar.mockClear();
    consumirCota.mockClear();
    const r = await gerarPrevia(pedido({ texto: `  ${TEXTO}  ` }));
    expect(r).toMatchObject({ ok: true, reaproveitada: true, duracaoMs: 200 });
    expect(sintetizar).not.toHaveBeenCalled();
    expect(consumirCota).not.toHaveBeenCalled();
  });

  it("voz trocada é outro hash: vai à ElevenLabs de novo", async () => {
    await gerarPrevia(pedido());
    await gerarPrevia(pedido({ voz: { voiceId: "voz-2", modelId: VOZ.modelId } }));
    expect(sintetizar).toHaveBeenCalledTimes(2);
  });

  it("o mesmo texto já guardado na pasta de OUTRA organização não é reaproveitado: cada organização paga e guarda o seu", async () => {
    const hash = hashDaFala(TEXTO, VOZ.voiceId, VOZ.modelId);
    armazem.objetos.set(caminhoDaFala(OUTRA, hash), new Uint8Array(1600));
    expect(await gerarPrevia(pedido())).toMatchObject({ ok: true, reaproveitada: false });
    expect(sintetizar).toHaveBeenCalledTimes(1);
    expect(armazem.objetos.has(caminhoDaFala(ORG, hash))).toBe(true);
  });

  it("sem voz: sem_voz, e nada é chamado", async () => {
    expect(await gerarPrevia(pedido({ voz: null }))).toEqual({ ok: false, motivo: "sem_voz" });
    expect(sintetizar).not.toHaveBeenCalled();
  });

  it("sem chave: a prévia já guardada segue ouvível; texto novo é sem_chave, e a cota fica intacta", async () => {
    await gerarPrevia(pedido());
    consumirCota.mockClear();
    expect(await gerarPrevia(pedido({ chave: null }))).toMatchObject({ ok: true, reaproveitada: true });
    expect(await gerarPrevia(pedido({ chave: null, texto: "Outro texto." }))).toEqual({ ok: false, motivo: "sem_chave" });
    expect(consumirCota).not.toHaveBeenCalled();
  });

  it.each(["../x", "voz com espaço", "", "a".repeat(65)])(
    "voice_id fora do formato (%j): voz_inexistente ANTES da cota e da ElevenLabs",
    async (voiceId) => {
      expect(await gerarPrevia(pedido({ voz: { voiceId, modelId: VOZ.modelId } }))).toEqual({ ok: false, motivo: "voz_inexistente" });
      expect(consumirCota).not.toHaveBeenCalled();
      expect(sintetizar).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["vazio", "   "],
    ["com mais de 1000 caracteres (o CHECK da 0288)", "a".repeat(1001)],
    ["com o caractere NUL", "Aguarde\u0000, por favor."],
  ])("texto %s: texto_recusado ANTES da cota e da ElevenLabs", async (_caso, texto) => {
    expect(await gerarPrevia(pedido({ texto }))).toEqual({ ok: false, motivo: "texto_recusado" });
    expect(consumirCota).not.toHaveBeenCalled();
    expect(sintetizar).not.toHaveBeenCalled();
  });

  it("1000 caracteres cabem (o limite é inclusivo)", async () => {
    expect(await gerarPrevia(pedido({ texto: "a".repeat(1000) }))).toMatchObject({ ok: true, reaproveitada: false });
  });

  it("cota da hora esgotada: limite_de_previas, e a ElevenLabs não é chamada", async () => {
    consumirCota.mockResolvedValueOnce(false);
    expect(await gerarPrevia(pedido())).toEqual({ ok: false, motivo: "limite_de_previas" });
    expect(sintetizar).not.toHaveBeenCalled();
  });

  it("status HTTP: a cota NOSSA esgotada sai 429; toda falha da ElevenLabs sai 422 ou 502, nunca 429/503", async () => {
    consumirCota.mockResolvedValueOnce(false);
    const r = await gerarPrevia(pedido());
    expect(r.ok ? null : STATUS_DA_FALHA[r.motivo]).toBe(429);
    const daElevenLabs = ["chave_invalida", "sem_credito", "texto_recusado", "voz_inexistente", "limite_de_uso", "sem_resposta", "erro_do_provedor"] as const;
    for (const motivo of daElevenLabs) {
      sintetizar.mockRejectedValueOnce(new ErroDaElevenLabs(motivo, 400));
      const falha = await gerarPrevia(pedido({ texto: `Texto ${motivo}` }));
      expect(falha).toEqual({ ok: false, motivo });
      expect([422, 502], motivo).toContain(STATUS_DA_FALHA[motivo]);
    }
  });

  it("cota esgotada NÃO impede reouvir a prévia guardada: reaproveitar não gasta cota", async () => {
    await gerarPrevia(pedido());
    consumirCota.mockResolvedValue(false);
    expect(await gerarPrevia(pedido())).toMatchObject({ ok: true, reaproveitada: true });
  });

  it("a ElevenLabs recusa: o motivo dela, e nada fica no Storage", async () => {
    sintetizar.mockRejectedValueOnce(new ErroDaElevenLabs("sem_credito", 401));
    expect(await gerarPrevia(pedido())).toEqual({ ok: false, motivo: "sem_credito" });
    expect(armazem.objetos.size).toBe(0);
  });

  it("erro que não é da ElevenLabs na síntese: erro_do_provedor, e o log leva só a classe (a mensagem pode ter a chave)", async () => {
    sintetizar.mockRejectedValueOnce(new TypeError("boom sk_x"));
    expect(await gerarPrevia(pedido())).toEqual({ ok: false, motivo: "erro_do_provedor" });
    expect(vi.mocked(logger).error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger).error.mock.calls[0]![1]).toMatchObject({ etapa: "sintetizar", organization_id: ORG, classe: "TypeError" });
    expect(tudoNoLog()).not.toContain("sk_x");
  });

  it("Storage fora do ar na GRAVAÇÃO: armazenamento com paga: true — a ElevenLabs cobrou e o áudio não ficou; a causa vai para o log", async () => {
    armazem.falharEnvio = true;
    expect(await gerarPrevia(pedido())).toEqual({ ok: false, motivo: "armazenamento", paga: true });
    expect(sintetizar).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger).error).toHaveBeenCalledTimes(1);
    const [, contexto] = vi.mocked(logger).error.mock.calls[0]!;
    expect(contexto).toMatchObject({
      etapa: "gravar_storage",
      organization_id: ORG,
      causa: expect.stringContaining("StorageApiError 500"),
    });
    expect(tudoNoLog()).not.toContain("sk_x");
    expect(tudoNoLog()).not.toContain(TEXTO);
  });

  it("Storage fora do ar na LEITURA: armazenamento SEM paga — nada foi cobrado por um áudio que talvez já esteja guardado", async () => {
    armazem.falharBaixar = true;
    expect(await gerarPrevia(pedido())).toEqual({ ok: false, motivo: "armazenamento" });
    expect(sintetizar).not.toHaveBeenCalled();
    expect(consumirCota).not.toHaveBeenCalled();
    expect(vi.mocked(logger).error.mock.calls[0]![1]).toMatchObject({ etapa: "ler_storage", causa: expect.stringContaining("503") });
  });

  it("duas prévias do MESMO texto ao mesmo tempo: as duas pagam, mas ouvem o MESMO áudio — o que ficou guardado", async () => {
    const liberar: Array<() => void> = [];
    sintetizar.mockImplementation(async () => {
      const n = sintetizar.mock.calls.length;
      await new Promise<void>((r) => liberar.push(r));
      return new Uint8Array(1600).fill(n);
    });
    const a = gerarPrevia(pedido());
    const b = gerarPrevia(pedido());
    await vi.waitFor(() => expect(liberar).toHaveLength(2));
    liberar[0]!();
    const ra = await a;
    liberar[1]!();
    const rb = await b;

    const guardado = armazem.objetos.get(caminhoDaFala(ORG, hashDaFala(TEXTO, VOZ.voiceId, VOZ.modelId)))!;
    expect(guardado).toEqual(new Uint8Array(1600).fill(1));
    expect(ra).toMatchObject({ ok: true, reaproveitada: false });
    expect(rb).toMatchObject({ ok: true, reaproveitada: false });
    expect(ra.ok && ra.audio).toEqual(guardado);
    expect(rb.ok && rb.audio).toEqual(guardado);
  });

  it("gravou outra antes e a releitura falha: armazenamento com paga: true", async () => {
    const hash = hashDaFala(TEXTO, VOZ.voiceId, VOZ.modelId);
    // A 1ª leitura não acha nada; entre ela e o envio, outra prévia grava o objeto; a releitura cai.
    armazem.baixar = vi.fn(async () => null) as unknown as ArmazemFalso["baixar"];
    const enviarOriginal = armazem.enviar;
    armazem.enviar = (async (caminho: string, bytes: Uint8Array) => {
      armazem.objetos.set(caminho, new Uint8Array(1600).fill(9));
      armazem.baixar = (async () => {
        throw new Error("armazem_download: StorageApiError 503: Service Unavailable");
      }) as ArmazemFalso["baixar"];
      return enviarOriginal(caminho, bytes);
    }) as ArmazemFalso["enviar"];
    expect(await gerarPrevia(pedido())).toEqual({ ok: false, motivo: "armazenamento", paga: true });
    expect(armazem.objetos.get(caminhoDaFala(ORG, hash))).toEqual(new Uint8Array(1600).fill(9));
    expect(vi.mocked(logger).error.mock.calls[0]![1]).toMatchObject({ etapa: "reler_storage" });
  });
});

describe("gerarPrevia com o cliente DE VERDADE da ElevenLabs e um fetch falso que conta", () => {
  it("1ª prévia: UMA requisição de síntese; a 2ª do mesmo texto e voz: nenhuma requisição a mais", async () => {
    const fetchFalso = vi.fn(async () => new Response(new Uint8Array(1600) as BodyInit, { status: 200, headers: { "Content-Type": "audio/basic" } }));
    const pedidoReal = pedido({
      sintetizar: (p) => sintetizarDeVerdade(p, { fetch: fetchFalso as unknown as typeof fetch, baseUrl: "http://elevenlabs-falsa.local" }),
    });

    const primeira = await gerarPrevia(pedidoReal);
    expect(primeira).toMatchObject({ ok: true, reaproveitada: false, duracaoMs: 200 });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://elevenlabs-falsa.local/v1/text-to-speech/voz-1?output_format=ulaw_8000");
    expect(init.method).toBe("POST");

    const segunda = await gerarPrevia(pedidoReal);
    expect(segunda).toMatchObject({ ok: true, reaproveitada: true, duracaoMs: 200 });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });
});
