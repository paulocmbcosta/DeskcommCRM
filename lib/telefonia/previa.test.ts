// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PortaDoArmazem } from "./armazem";
import { ErroDaElevenLabs, sintetizar as sintetizarDeVerdade } from "./elevenlabs";
import { caminhoDaFala, hashDaFala } from "./falas";
import { gerarPrevia, type PedidoDePrevia } from "./previa";
import { STATUS_DA_FALHA } from "./servico-de-falas";

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA = "00000000-0000-4000-8000-00000000000b";
const VOZ = { voiceId: "voz-1", modelId: "eleven_multilingual_v2" };
const TEXTO = "Aguarde, por favor.";

class ArmazemFalso implements Pick<PortaDoArmazem, "baixar" | "enviar"> {
  objetos = new Map<string, Uint8Array>();
  falharEnvio = false;
  /** O Storage fora do ar na LEITURA: a porta de verdade lança (não é "não existe"). */
  falharBaixar = false;
  enviar = async (caminho: string, bytes: Uint8Array) => {
    if (this.falharEnvio) throw new Error("storage fora");
    this.objetos.set(caminho, bytes);
  };
  baixar = async (caminho: string) => {
    if (this.falharBaixar) throw new Error("armazem_download: StorageApiError 503");
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
});

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

  it("sem chave: a prévia já guardada segue ouvível; texto novo é sem_chave", async () => {
    await gerarPrevia(pedido());
    expect(await gerarPrevia(pedido({ chave: null }))).toMatchObject({ ok: true, reaproveitada: true });
    expect(await gerarPrevia(pedido({ chave: null, texto: "Outro texto." }))).toEqual({ ok: false, motivo: "sem_chave" });
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

  it("erro que não é da ElevenLabs na síntese: erro_do_provedor", async () => {
    sintetizar.mockRejectedValueOnce(new TypeError("boom"));
    expect(await gerarPrevia(pedido())).toEqual({ ok: false, motivo: "erro_do_provedor" });
  });

  it("Storage fora do ar na gravação: armazenamento", async () => {
    armazem.falharEnvio = true;
    expect(await gerarPrevia(pedido())).toEqual({ ok: false, motivo: "armazenamento" });
  });

  it("Storage fora do ar na LEITURA: armazenamento — sem pagar uma síntese por um áudio que talvez já esteja guardado", async () => {
    armazem.falharBaixar = true;
    expect(await gerarPrevia(pedido())).toEqual({ ok: false, motivo: "armazenamento" });
    expect(sintetizar).not.toHaveBeenCalled();
    expect(consumirCota).not.toHaveBeenCalled();
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
