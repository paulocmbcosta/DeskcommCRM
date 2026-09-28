// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import type { PortaDoArmazem } from "./armazem";
import {
  caminhoDaFala,
  conferirFala,
  descartarFala,
  falaParaSalvarSchema,
  hashDaFala,
  salvarFala,
  type LinhaDaFala,
  type PedidoDeSalvar,
} from "./falas";

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA = "00000000-0000-4000-8000-00000000000b";
const VOZ = { voiceId: "voz-1", modelId: "eleven_multilingual_v2" };
const TEXTO = "Aguarde, por favor.";
const HASH = hashDaFala(TEXTO, VOZ.voiceId, VOZ.modelId);

type Linha = LinhaDaFala & { organization_id: string; model_id: string };

/** O banco em memória: só as quatro consultas que `falas.ts` faz. `escritas` conta INSERT/UPDATE/DELETE. */
class BancoDeFalas {
  linhas = new Map<string, Linha>();
  escritas = 0;
  private seq = 0;
  db: Queryable = {
    query: (async (sqlBruto: string, p: unknown[] = []) => {
      const sql = sqlBruto.replace(/\s+/g, " ").trim();
      if (sql.startsWith("select") && sql.includes("from phone_prompts where id = $1")) {
        const l = this.linhas.get(p[0] as string);
        const rows = l && l.organization_id === p[1] ? [l] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("insert into phone_prompts")) {
        this.escritas++;
        const l: Linha = {
          id: `fala-${++this.seq}`,
          organization_id: p[0] as string,
          tipo: p[1] as Linha["tipo"],
          texto: p[2] as string,
          voice_id: p[3] as string,
          model_id: p[4] as string,
          content_hash: p[5] as string,
          storage_path: p[6] as string | null,
          duracao_ms: p[7] as number | null,
          status: p[8] as Linha["status"],
          erro: p[9] as string | null,
          atualizada_em: new Date("2026-09-28T13:00:00Z"),
        };
        this.linhas.set(l.id, l);
        return { rows: [l], rowCount: 1 };
      }
      if (sql.startsWith("update phone_prompts")) {
        this.escritas++;
        const l = this.linhas.get(p[0] as string);
        if (!l || l.organization_id !== p[1]) return { rows: [], rowCount: 0 };
        Object.assign(l, {
          texto: p[2], voice_id: p[3], model_id: p[4], content_hash: p[5],
          storage_path: p[6], duracao_ms: p[7], status: p[8], erro: p[9],
        });
        return { rows: [l], rowCount: 1 };
      }
      if (sql.startsWith("delete from phone_prompts")) {
        this.escritas++;
        const l = this.linhas.get(p[0] as string);
        if (!l || l.organization_id !== p[1]) return { rows: [], rowCount: 0 };
        this.linhas.delete(l.id);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`consulta inesperada: ${sql}`);
    }) as unknown as Queryable["query"],
  };
}

/** O Storage em memória. `baixar` é tudo o que o "Salvar e usar" usa. */
class ArmazemFalso implements Pick<PortaDoArmazem, "baixar"> {
  objetos = new Map<string, Uint8Array>();
  /** O Storage fora do ar: `baixar` lança, como a porta de verdade faz em falha que não é "não existe". */
  falharBaixar = false;
  baixar = async (caminho: string) => {
    if (this.falharBaixar) throw new Error("armazem_download: StorageApiError 500");
    const b = this.objetos.get(caminho);
    return b ? new Uint8Array(b) : null;
  };
}

let banco: BancoDeFalas;
let armazem: ArmazemFalso;

const pedido = (p: Partial<PedidoDeSalvar> = {}): PedidoDeSalvar => ({
  db: banco.db,
  armazem,
  organizationId: ORG,
  userId: "user-1",
  tipo: "waiting",
  texto: TEXTO,
  hash: HASH,
  falaAtualId: null,
  voz: VOZ,
  ...p,
});

/** A prévia que a rota da prévia teria gravado: 1600 bytes de μ-law = 200 ms. */
function previaNoStorage(org: string, hash: string) {
  armazem.objetos.set(caminhoDaFala(org, hash), new Uint8Array(1600));
}

beforeEach(() => {
  banco = new BancoDeFalas();
  armazem = new ArmazemFalso();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hashDaFala — sha256 de texto + voz + modelo, sem ambiguidade de concatenação", () => {
  it("é sha256 em hexadecimal minúsculo (a régua do CHECK phone_prompts_hash_check) e determinístico", () => {
    expect(HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDaFala(TEXTO, VOZ.voiceId, VOZ.modelId)).toBe(HASH);
  });

  it("muda quando muda o texto, a voz OU o modelo", () => {
    expect(hashDaFala("Outro.", VOZ.voiceId, VOZ.modelId)).not.toBe(HASH);
    expect(hashDaFala(TEXTO, "voz-2", VOZ.modelId)).not.toBe(HASH);
    expect(hashDaFala(TEXTO, VOZ.voiceId, "eleven_turbo_v2_5")).not.toBe(HASH);
  });

  it("um pedaço que muda de campo muda o hash: a fronteira entre os campos faz parte do que é resumido", () => {
    // Com os campos colados por um separador, estes pares dariam o MESMO texto de entrada.
    expect(hashDaFala("x\nt", "v", "m")).not.toBe(hashDaFala("t", "v\nx", "m"));
    expect(hashDaFala("t", "v", "m\nv")).not.toBe(hashDaFala("t", "v\nv", "m"));
    expect(hashDaFala("ab", "c", "m")).not.toBe(hashDaFala("b", "ac", "m"));
  });
});

describe("caminhoDaFala — só monta <org>/<hash>.ulaw, nunca um caminho qualquer", () => {
  it("monta o caminho do CHECK phone_prompts_storage_path_check", () => {
    expect(caminhoDaFala(ORG, HASH)).toBe(`${ORG}/${HASH}.ulaw`);
  });

  it("recusa organização que não é UUID e hash que não é sha256 — nenhum pedaço vira caminho de outra pasta", () => {
    expect(() => caminhoDaFala("../outra", HASH)).toThrow();
    expect(() => caminhoDaFala(ORG, "../../etc/passwd")).toThrow();
    expect(() => caminhoDaFala(ORG, `${HASH}/x`)).toThrow();
  });
});

describe("salvarFala — o 'Salvar e usar' (nunca chama a ElevenLabs)", () => {
  it("prévia no Storage e hash do texto com a voz atual: grava pronta, no caminho da organização, com a duração do objeto", async () => {
    previaNoStorage(ORG, HASH);
    const r = await salvarFala(pedido());
    expect(r).toMatchObject({ ok: true, mudou: true, fala: { status: "ready", duracao_ms: 200, texto: TEXTO, hash: HASH } });
    expect([...banco.linhas.values()][0]!.storage_path).toBe(`${ORG}/${HASH}.ulaw`);
  });

  it("não faz NENHUMA chamada de rede: o fetch global é contado e fica em zero", async () => {
    const fetchContado = vi.fn(async () => new Response(null, { status: 599 }));
    vi.stubGlobal("fetch", fetchContado);
    previaNoStorage(ORG, HASH);
    expect(await salvarFala(pedido())).toMatchObject({ ok: true, mudou: true });
    expect(await salvarFala(pedido({ texto: "Sem prévia." }))).toEqual({ ok: false, motivo: "previa_desatualizada" });
    expect(fetchContado).not.toHaveBeenCalled();
  });

  it("a mesma prévia de novo sobre a fala atual: nada muda e nada é escrito", async () => {
    previaNoStorage(ORG, HASH);
    const primeira = await salvarFala(pedido());
    const escritas = banco.escritas;
    const segunda = await salvarFala(pedido({ falaAtualId: primeira.ok ? primeira.fala.id : null }));
    expect(segunda).toMatchObject({ ok: true, mudou: false });
    expect(banco.escritas).toBe(escritas);
  });

  it("texto novo sobre a fala atual: regrava a MESMA linha com o hash novo — e não apaga o objeto antigo (é da limpeza do worker)", async () => {
    previaNoStorage(ORG, HASH);
    const primeira = await salvarFala(pedido());
    const novo = "Só um instante.";
    const hashNovo = hashDaFala(novo, VOZ.voiceId, VOZ.modelId);
    previaNoStorage(ORG, hashNovo);
    const segunda = await salvarFala(pedido({ texto: novo, hash: hashNovo, falaAtualId: primeira.ok ? primeira.fala.id : null }));
    expect(primeira.ok && segunda.ok && segunda.fala.id === primeira.fala.id).toBe(true);
    expect(banco.linhas.size).toBe(1);
    expect([...banco.linhas.values()][0]!).toMatchObject({ storage_path: `${ORG}/${hashNovo}.ulaw`, status: "ready" });
    expect(armazem.objetos.has(caminhoDaFala(ORG, HASH))).toBe(true);
  });

  it("hash que não é o do texto com a voz atual (texto editado depois da prévia, ou voz trocada): previa_desatualizada, nada gravado", async () => {
    previaNoStorage(ORG, HASH);
    expect(await salvarFala(pedido({ texto: "Outro texto." }))).toEqual({ ok: false, motivo: "previa_desatualizada" });
    expect(await salvarFala(pedido({ voz: { voiceId: "voz-2", modelId: VOZ.modelId } }))).toEqual({
      ok: false,
      motivo: "previa_desatualizada",
    });
    expect(banco.escritas).toBe(0);
  });

  it("hash certo, mas o objeto só existe na pasta de OUTRA organização: previa_ausente — o caminho é sempre o da sessão", async () => {
    previaNoStorage(OUTRA, HASH);
    expect(await salvarFala(pedido())).toEqual({ ok: false, motivo: "previa_ausente" });
    expect(banco.escritas).toBe(0);
  });

  it("objeto vazio no Storage: previa_ausente (uma fala pronta tem duração > 0)", async () => {
    armazem.objetos.set(caminhoDaFala(ORG, HASH), new Uint8Array(0));
    expect(await salvarFala(pedido())).toEqual({ ok: false, motivo: "previa_ausente" });
    expect(banco.escritas).toBe(0);
  });

  it("Storage fora do ar: armazenamento (502), não previa_ausente — e nada gravado", async () => {
    previaNoStorage(ORG, HASH);
    armazem.falharBaixar = true;
    expect(await salvarFala(pedido())).toEqual({ ok: false, motivo: "armazenamento" });
    expect(banco.escritas).toBe(0);
  });

  it("sem voz escolhida e hash novo: sem_voz", async () => {
    previaNoStorage(ORG, HASH);
    expect(await salvarFala(pedido({ voz: null }))).toEqual({ ok: false, motivo: "sem_voz" });
  });

  it("falaAtualId de OUTRA organização não é regravada: nasce uma linha nova da sessão", async () => {
    previaNoStorage(OUTRA, HASH);
    const daOutra = await salvarFala(pedido({ organizationId: OUTRA }));
    previaNoStorage(ORG, HASH);
    const r = await salvarFala(pedido({ falaAtualId: daOutra.ok ? daOutra.fala.id : null }));
    expect(r.ok && daOutra.ok && r.fala.id !== daOutra.fala.id).toBe(true);
    const linhaDaOutra = daOutra.ok ? banco.linhas.get(daOutra.fala.id)! : null;
    expect(linhaDaOutra).toMatchObject({ organization_id: OUTRA, storage_path: `${OUTRA}/${HASH}.ulaw` });
  });

  it("falaAtualId de OUTRO tipo não é regravada nem tomada como 'nada mudou': nasce uma linha do tipo pedido", async () => {
    previaNoStorage(ORG, HASH);
    const doMenu = await salvarFala(pedido({ tipo: "menu" }));
    const r = await salvarFala(pedido({ tipo: "waiting", falaAtualId: doMenu.ok ? doMenu.fala.id : null }));
    expect(r).toMatchObject({ ok: true, mudou: true, fala: { tipo: "waiting" } });
    expect(r.ok && doMenu.ok && r.fala.id !== doMenu.fala.id).toBe(true);
    expect(banco.linhas.size).toBe(2);
  });

  it("conferirFala não escreve nada: só diz o que salvarFala gravaria", async () => {
    previaNoStorage(ORG, HASH);
    expect(await conferirFala(pedido())).toMatchObject({
      ok: true,
      atual: null,
      nova: { hash: HASH, caminho: `${ORG}/${HASH}.ulaw`, duracaoMs: 200 },
    });
    expect(banco.escritas).toBe(0);
  });
});

describe("descartarFala", () => {
  it("apaga só a linha da organização e não toca o Storage", async () => {
    previaNoStorage(ORG, HASH);
    const r = await salvarFala(pedido());
    const id = r.ok ? r.fala.id : "";
    await descartarFala(banco.db, OUTRA, id);
    expect(banco.linhas.size).toBe(1);
    await descartarFala(banco.db, ORG, id);
    expect(banco.linhas.size).toBe(0);
    expect(armazem.objetos.has(caminhoDaFala(ORG, HASH))).toBe(true);
  });
});

describe("falaParaSalvarSchema — o corpo traz texto e hash, nunca caminho nem organização", () => {
  it("aceita texto e sha256; recusa hash fora da régua, texto vazio ou longo demais e campo a mais", () => {
    expect(falaParaSalvarSchema.safeParse({ texto: " Oi. ", hash: HASH })).toMatchObject({ success: true, data: { texto: "Oi.", hash: HASH } });
    expect(falaParaSalvarSchema.safeParse({ texto: "Oi.", hash: "../../etc/passwd" }).success).toBe(false);
    expect(falaParaSalvarSchema.safeParse({ texto: "Oi.", hash: HASH.toUpperCase() }).success).toBe(false);
    expect(falaParaSalvarSchema.safeParse({ texto: "  ", hash: HASH }).success).toBe(false);
    expect(falaParaSalvarSchema.safeParse({ texto: "a".repeat(1001), hash: HASH }).success).toBe(false);
    expect(falaParaSalvarSchema.safeParse({ texto: "Oi.", hash: HASH, caminho: `${OUTRA}/${HASH}.ulaw` }).success).toBe(false);
    expect(falaParaSalvarSchema.safeParse({ texto: "Oi.", hash: HASH, organization_id: OUTRA }).success).toBe(false);
  });
});
