// @vitest-environment node
/**
 * O PROCESSAMENTO DAS GRAVAÇÕES (F3, DYD-53) com dublês: baixar pela ARI →
 * converter → subir ao Storage → anexar → apagar o WAV; e o que acontece quando
 * cada passo falha. O SQL das portas do banco é provado no Postgres real
 * (tests/invariants/telefonia-gravacao.test.ts); aqui, a ordem e as decisões.
 */
import { writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EstadoDaGravacao } from "@/lib/telefonia/gravacao";

import {
  GravacoesDaTelefonia,
  type AriDaGravacao,
  type BancoDaGravacao,
  type ConversorDaGravacao,
  type StorageDaGravacao,
} from "./gravacoes";

const ORG = "00000000-0000-4000-8000-00000000000a";
const VC = "3f1c2b8e-9a4d-4c6e-8f00-1234567890ab";
const OUTRO = "3f1c2b8e-9a4d-4c6e-8f00-1234567890ac";
const MSG = "6a0f5d1e-1111-4c6e-8f00-000000000001";
const CONVERSA = "6a0f5d1e-2222-4c6e-8f00-000000000002";
const FIM = new Date("2026-09-29T22:00:00Z");

class AriFalsa implements AriDaGravacao {
  chamadas: Array<[string, ...unknown[]]> = [];
  /** Bytes do WAV que o "Asterisk" entrega; `null` = 404. */
  wav: number | null = 44 + 16_000 * 61;
  guardadas: string[] = [];
  falharGravar = false;
  gravarPonte = async (p: string, n: string, t: number) => {
    this.chamadas.push(["gravarPonte", p, n, t]);
    if (this.falharGravar) throw new Error("ari 500");
  };
  pararGravacao = async (n: string) => {
    this.chamadas.push(["pararGravacao", n]);
  };
  tocarNaPonte = async (p: string, m: string) => {
    this.chamadas.push(["tocarNaPonte", p, m]);
  };
  baixarGravacao = async (n: string, destino: string) => {
    this.chamadas.push(["baixarGravacao", n]);
    if (this.wav === null) return "ausente" as const;
    await writeFile(destino, Buffer.alloc(this.wav));
    return { bytes: this.wav };
  };
  apagarGravacao = async (n: string) => {
    this.chamadas.push(["apagarGravacao", n]);
  };
  listarGravacoes = async () => this.guardadas;
  nomes() {
    return this.chamadas.map((c) => c[0]);
  }
}

class BancoFalso implements BancoDaGravacao {
  eventos: Array<[string, ...unknown[]]> = [];
  mensagem: { id: string; conversationId: string } | null = { id: MSG, conversationId: CONVERSA };
  resultadoDoAnexar: "anexada" | "anonimizada" = "anexada";
  marcar = true;
  falharMarcar = false;
  falharAnexar = false;
  estadosAtuais = new Map<string, EstadoDaGravacao | null>();
  pendentesAtuais: Array<{ vcId: string; organizationId: string; fimEm: Date }> = [];
  politica = async () => ({ gravar: true, aviso: null });
  marcarGravando = async (org: string, id: string, avisoEm: Date) => {
    this.eventos.push(["marcarGravando", org, id, avisoEm.toISOString()]);
    if (this.falharMarcar) throw new Error("banco fora do ar");
    return this.marcar;
  };
  pendentes = async () => this.pendentesAtuais;
  mensagemDaLigacao = async () => this.mensagem;
  anexar = async (p: { organizationId: string; vcId: string; mensagemId: string; caminho: string; bytes: number; duracaoMs: number }) => {
    this.eventos.push(["anexar", p]);
    if (this.falharAnexar) throw new Error("banco fora do ar");
    return this.resultadoDoAnexar;
  };
  falhar = async (org: string, id: string) => {
    this.eventos.push(["falhar", org, id]);
    return true;
  };
  descartar = async (org: string, id: string) => {
    this.eventos.push(["descartar", org, id]);
  };
  estados = async (ids: string[]) => new Map(ids.filter((id) => this.estadosAtuais.has(id)).map((id) => [id, this.estadosAtuais.get(id)!]));
  tem(nome: string) {
    return this.eventos.filter((e) => e[0] === nome);
  }
}

class StorageFalso implements StorageDaGravacao {
  subidos: Array<[string, string]> = [];
  apagados: string[] = [];
  falharSubir = false;
  subir = async (caminho: string, _arquivo: string, mime: string) => {
    if (this.falharSubir) throw new Error("storage fora do ar");
    this.subidos.push([caminho, mime]);
  };
  apagar = async (caminho: string) => {
    this.apagados.push(caminho);
  };
}

class ConversorFalso implements ConversorDaGravacao {
  convertidos: Array<[string, string]> = [];
  falhar = false;
  converter = async (entrada: string, saida: string) => {
    if (this.falhar) throw new Error("ffmpeg_exit_1: codec");
    this.convertidos.push([entrada, saida]);
    await writeFile(saida, Buffer.alloc(183_000));
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let ari: AriFalsa;
let banco: BancoFalso;
let storage: StorageFalso;
let conversor: ConversorFalso;
let agora: Date;
let g: GravacoesDaTelefonia;

beforeEach(() => {
  ari = new AriFalsa();
  banco = new BancoFalso();
  storage = new StorageFalso();
  conversor = new ConversorFalso();
  agora = new Date(FIM.getTime() + 2_000);
  g = new GravacoesDaTelefonia({ ari, banco, storage, conversor, log, agora: () => agora });
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
});
afterEach(() => {
  expect(log.error).not.toHaveBeenCalled();
});

const pendente = { vcId: VC, organizationId: ORG, fimEm: FIM };

describe("processar — o caminho feliz", () => {
  it("baixa, converte, sobe no caminho da mensagem, anexa com a duração do WAV e apaga o WAV do Asterisk", async () => {
    expect(await g.processar(pendente)).toBe("anexada");
    expect(ari.nomes()).toEqual(["baixarGravacao", "apagarGravacao"]);
    expect(ari.chamadas[0]).toEqual(["baixarGravacao", `g-${VC}`]);
    expect(conversor.convertidos).toHaveLength(1);
    expect(storage.subidos).toEqual([[`${ORG}/${CONVERSA}/${MSG}.mp3`, "audio/mpeg"]]);
    expect(banco.tem("anexar")).toEqual([
      [
        "anexar",
        { organizationId: ORG, vcId: VC, mensagemId: MSG, caminho: `${ORG}/${CONVERSA}/${MSG}.mp3`, bytes: 183_000, duracaoMs: 61_000 },
      ],
    ]);
  });

  it("mensagem anonimizada no meio do caminho: o arquivo recém-subido é apagado e a gravação descartada", async () => {
    banco.resultadoDoAnexar = "anonimizada";
    expect(await g.processar(pendente)).toBe("anonimizada");
    expect(storage.apagados).toEqual([`${ORG}/${CONVERSA}/${MSG}.mp3`]);
    expect(banco.tem("descartar")).toEqual([["descartar", ORG, VC]]);
    expect(ari.nomes()).toContain("apagarGravacao");
  });
});

describe("processar — o que ainda não deu", () => {
  it("o Asterisk ainda não tem o arquivo, logo depois do fim: espera, sem falhar", async () => {
    ari.wav = null;
    expect(await g.processar(pendente)).toBe("esperando");
    expect(banco.tem("falhar")).toEqual([]);
    expect(ari.nomes()).not.toContain("apagarGravacao");
  });

  it("passados 2 min sem arquivo: perdida (e a Central fica sabendo pelo banco)", async () => {
    ari.wav = null;
    agora = new Date(FIM.getTime() + 2 * 60_000);
    expect(await g.processar(pendente)).toBe("perdida");
    expect(banco.tem("falhar")).toEqual([["falhar", ORG, VC]]);
  });

  it("a mensagem da ligação ainda não existe: espera; 30 min depois, perdida", async () => {
    banco.mensagem = null;
    expect(await g.processar(pendente)).toBe("esperando");
    agora = new Date(FIM.getTime() + 30 * 60_000);
    expect(await g.processar(pendente)).toBe("perdida");
  });

  it("Storage fora: espera e avisa no log UMA vez; 30 min depois, perdida e o WAV apagado", async () => {
    storage.falharSubir = true;
    expect(await g.processar(pendente)).toBe("esperando");
    expect(await g.processar(pendente)).toBe("esperando");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(ari.nomes()).not.toContain("apagarGravacao");

    agora = new Date(FIM.getTime() + 30 * 60_000);
    expect(await g.processar(pendente)).toBe("perdida");
    expect(banco.tem("falhar")).toHaveLength(1);
    expect(ari.nomes()).toContain("apagarGravacao");
  });

  it("conversor quebrado: nada sobe, nada é anexado", async () => {
    conversor.falhar = true;
    expect(await g.processar(pendente)).toBe("esperando");
    expect(storage.subidos).toEqual([]);
    expect(banco.tem("anexar")).toEqual([]);
  });

  it("o banco falha ao anexar: tenta de novo (o upload é upsert, subir outra vez não duplica)", async () => {
    banco.falharAnexar = true;
    expect(await g.processar(pendente)).toBe("esperando");
    banco.falharAnexar = false;
    expect(await g.processar(pendente)).toBe("anexada");
    expect(storage.subidos).toHaveLength(2);
  });

  it("a mesma gravação duas vezes ao mesmo tempo: a segunda volta sem fazer nada", async () => {
    const [a, b] = await Promise.all([g.processar(pendente), g.processar(pendente)]);
    expect([a, b].sort()).toEqual(["anexada", "em_curso"]);
    expect(storage.subidos).toHaveLength(1);
  });
});

describe("a porta do controlador", () => {
  it("comecar: a ARI grava a ponte com o nome da ligação e o teto de 2 h, e SÓ ENTÃO o banco marca", async () => {
    const aviso = new Date("2026-09-29T21:59:00Z");
    expect(await g.comecar({ org: ORG, vcId: VC, ponte: `p-${VC}`, avisoEm: aviso })).toBe(true);
    expect(ari.chamadas).toEqual([["gravarPonte", `p-${VC}`, `g-${VC}`, 7_200]]);
    expect(banco.tem("marcarGravando")).toEqual([["marcarGravando", ORG, VC, aviso.toISOString()]]);
  });

  it("comecar: a ARI falha → lança (o controlador segue sem gravar) e o banco não é marcado", async () => {
    ari.falharGravar = true;
    await expect(g.comecar({ org: ORG, vcId: VC, ponte: "p", avisoEm: new Date() })).rejects.toThrow();
    expect(banco.tem("marcarGravando")).toEqual([]);
  });

  it.each([
    ["o banco não marca", () => (banco.marcar = false)],
    ["o banco lança", () => (banco.falharMarcar = true)],
  ])("comecar: %s → a gravação é parada e apagada, e devolve false", async (_nome, preparar) => {
    preparar();
    expect(await g.comecar({ org: ORG, vcId: VC, ponte: "p", avisoEm: new Date() })).toBe(false);
    expect(ari.nomes()).toEqual(["gravarPonte", "pararGravacao", "apagarGravacao"]);
  });

  it("parar e tocar o aviso vão à ARI pelo nome da ligação e pela ponte", async () => {
    await g.parar(VC);
    expect(await g.tocarAvisoNaPonte("p-1", "sound:/x")).toBe(true);
    expect(ari.chamadas).toEqual([
      ["pararGravacao", `g-${VC}`],
      ["tocarNaPonte", "p-1", "sound:/x"],
    ]);
  });

  it("aoEncerrar: processa sozinho logo depois do fim", async () => {
    vi.useFakeTimers();
    try {
      g.aoEncerrar(ORG, VC);
      expect(storage.subidos).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(storage.subidos).toHaveLength(1), { timeout: 2_000 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("passada", () => {
  it("processa as pendentes e apaga só as órfãs de ligação em estado terminal", async () => {
    banco.pendentesAtuais = [pendente];
    const TERMINADA = "3f1c2b8e-9a4d-4c6e-8f00-1234567890ad";
    const PERDIDA = "3f1c2b8e-9a4d-4c6e-8f00-1234567890ae";
    const GRAVANDO = "3f1c2b8e-9a4d-4c6e-8f00-1234567890af";
    const SEM_LINHA = "3f1c2b8e-9a4d-4c6e-8f00-1234567890b0";
    ari.guardadas = [`g-${TERMINADA}`, `g-${PERDIDA}`, `g-${GRAVANDO}`, `g-${SEM_LINHA}`, `g-${OUTRO}`, "sonda-g-1"];
    banco.estadosAtuais.set(TERMINADA, "stored");
    banco.estadosAtuais.set(PERDIDA, "failed");
    banco.estadosAtuais.set(GRAVANDO, "recording");
    banco.estadosAtuais.set(OUTRO, null);

    await g.passada();

    expect(storage.subidos).toHaveLength(1);
    const apagadas = ari.chamadas.filter((c) => c[0] === "apagarGravacao").map((c) => c[1]);
    // A da pendente (depois de guardada) e as duas órfãs terminais. Nunca a que grava,
    // a sem linha, a não gravada, nem o que não é gravação de ligação.
    expect(apagadas.sort()).toEqual([`g-${PERDIDA}`, `g-${TERMINADA}`, `g-${VC}`].sort());
  });
});
