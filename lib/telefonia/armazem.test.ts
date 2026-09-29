// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { armazemDoSupabase, comPrazoDeLeitura, type PortaDoArmazem } from "./armazem";

/**
 * O erro que o storage-js monta a partir de uma resposta HTTP (`StorageApiError`):
 * `status` é o HTTP; `statusCode`, `code` e a mensagem vêm do corpo do Storage.
 */
const erroDoStorage = (status: number, corpo: { statusCode?: string; code?: string; message: string }) =>
  Object.assign(new Error(corpo.message), {
    name: "StorageApiError",
    status,
    statusCode: corpo.statusCode ?? String(status),
    code: corpo.code,
    __isStorageError: true,
  });

/** O que o Storage responde, nas duas gerações do corpo de erro (com e sem `code`). */
const OBJETO_AUSENTE = [
  erroDoStorage(400, { statusCode: "404", message: "Object not found" }),
  erroDoStorage(404, { statusCode: "404", code: "NoSuchKey", message: "Object not found" }),
];
const BUCKET_AUSENTE = [
  erroDoStorage(400, { statusCode: "404", message: "Bucket not found" }),
  erroDoStorage(404, { statusCode: "404", code: "NoSuchBucket", message: "Bucket not found" }),
];
const JA_EXISTE = erroDoStorage(400, { statusCode: "409", code: "Duplicate", message: "The resource already exists" });

/**
 * O Storage em memória atrás de `admin.storage.from(bucket)`: `upload` respeita o
 * `upsert` (sem ele, o segundo a gravar recebe o 409 do Storage de verdade),
 * `download` responde "Object not found" para o que não existe, `list` pagina e
 * `remove` apaga. `falha` força uma resposta de erro na próxima operação.
 */
function clienteFalso(opcoes: { falha?: Partial<Record<"upload" | "download" | "list" | "remove", unknown>> } = {}) {
  const objetos = new Map<string, Uint8Array>();
  const baldes: string[] = [];
  const falha = { ...opcoes.falha };
  const upload = vi.fn(async (caminho: string, bytes: Uint8Array, o: { upsert?: boolean; contentType?: string }) => {
    if (falha.upload) return { data: null, error: falha.upload };
    if (objetos.has(caminho) && !o.upsert) return { data: null, error: JA_EXISTE };
    objetos.set(caminho, new Uint8Array(bytes));
    return { data: { path: caminho }, error: null };
  });
  const download = vi.fn(async (caminho: string) => {
    if (falha.download) return { data: null, error: falha.download };
    const b = objetos.get(caminho);
    return b ? { data: new Blob([b as BlobPart]), error: null } : { data: null, error: OBJETO_AUSENTE[0] };
  });
  const list = vi.fn(async (pasta: string, o: { limit?: number; offset?: number }) => {
    if (falha.list) return { data: null, error: falha.list };
    const nomes = new Set<string>();
    const entradas: { id: string | null; name: string; created_at?: string }[] = [];
    for (const caminho of [...objetos.keys()].sort()) {
      const resto = pasta ? (caminho.startsWith(`${pasta}/`) ? caminho.slice(pasta.length + 1) : null) : caminho;
      if (resto === null) continue;
      const [primeiro, ...depois] = resto.split("/");
      if (nomes.has(primeiro!)) continue;
      nomes.add(primeiro!);
      entradas.push(
        depois.length > 0 ? { id: null, name: primeiro! } : { id: `id-${caminho}`, name: primeiro!, created_at: "2026-09-28T10:00:00Z" },
      );
    }
    const inicio = o.offset ?? 0;
    return { data: entradas.slice(inicio, inicio + (o.limit ?? 100)), error: null };
  });
  const remove = vi.fn(async (caminhos: string[]) => {
    if (falha.remove) return { data: null, error: falha.remove };
    for (const c of caminhos) objetos.delete(c);
    return { data: caminhos.map((name) => ({ name })), error: null };
  });
  const admin = {
    storage: {
      from: (b: string) => {
        baldes.push(b);
        return { upload, download, list, remove };
      },
    },
  } as unknown as SupabaseClient;
  return { admin, objetos, baldes, upload, download, list, remove };
}

describe("armazemDoSupabase.baixar — 'não existe' é diferente de 'o Storage falhou'", () => {
  it("objeto existente: os bytes, do bucket phone-prompts", async () => {
    const c = clienteFalso();
    c.objetos.set("org/h.ulaw", new Uint8Array([1, 2, 3]));
    expect(await armazemDoSupabase(c.admin).baixar("org/h.ulaw")).toEqual(new Uint8Array([1, 2, 3]));
    expect(c.baldes).toEqual(["phone-prompts"]);
    expect(c.download.mock.calls[0]![0]).toBe("org/h.ulaw");
  });

  it.each(OBJETO_AUSENTE.map((e) => [e.status, e.code ?? "sem code", e]))(
    "'Object not found' (HTTP %i, %s): o objeto não existe → null",
    async (_status, _code, error) => {
      const c = clienteFalso({ falha: { download: error } });
      expect(await armazemDoSupabase(c.admin).baixar("org/h.ulaw")).toBeNull();
    },
  );

  it.each(BUCKET_AUSENTE.map((e) => [e.status, e.code ?? "sem code", e]))(
    "'Bucket not found' (HTTP %i, %s) NÃO é 'objeto não existe': LANÇA — sem bucket não há onde guardar a síntese paga",
    async (_status, _code, error) => {
      const c = clienteFalso({ falha: { download: error } });
      await expect(armazemDoSupabase(c.admin).baixar("org/h.ulaw")).rejects.toThrow(/armazem_download: .*Bucket not found/);
    },
  );

  it("5xx, 401 ou falha de rede: LANÇA — quem chama não pode confundir com 'não existe' e pagar uma síntese", async () => {
    const falhas = [
      erroDoStorage(500, { message: "Internal Server Error" }),
      erroDoStorage(401, { statusCode: "403", message: "invalid signature" }),
      Object.assign(new Error("fetch failed"), { name: "StorageUnknownError", __isStorageError: true }),
    ];
    for (const error of falhas) {
      const c = clienteFalso({ falha: { download: error } });
      await expect(armazemDoSupabase(c.admin).baixar("org/h.ulaw")).rejects.toThrow(/armazem_download/);
    }
  });
});

describe("armazemDoSupabase.enviar — o primeiro a gravar vence", () => {
  it("grava como audio/basic (o único tipo que o bucket aceita), SEM upsert", async () => {
    const c = clienteFalso();
    expect(await armazemDoSupabase(c.admin).enviar("org/h.ulaw", new Uint8Array(8))).toBe("gravado");
    expect(c.upload.mock.calls[0]).toEqual(["org/h.ulaw", new Uint8Array(8), { contentType: "audio/basic", upsert: false }]);
  });

  it("dois envios ao MESMO caminho: o segundo recebe 'ja_existia' e o objeto guardado segue sendo o do primeiro", async () => {
    const c = clienteFalso();
    const armazem = armazemDoSupabase(c.admin);
    expect(await armazem.enviar("org/h.ulaw", new Uint8Array([1, 1]))).toBe("gravado");
    expect(await armazem.enviar("org/h.ulaw", new Uint8Array([2, 2]))).toBe("ja_existia");
    expect(await armazem.baixar("org/h.ulaw")).toEqual(new Uint8Array([1, 1]));
  });

  it("o conflito também é reconhecido pelo HTTP 409 das versões novas do Storage", async () => {
    const c = clienteFalso({ falha: { upload: erroDoStorage(409, { code: "Duplicate", message: "The resource already exists" }) } });
    expect(await armazemDoSupabase(c.admin).enviar("org/h.ulaw", new Uint8Array(8))).toBe("ja_existia");
  });

  it("o Storage recusa por outro motivo (5xx, bucket ausente): lança", async () => {
    for (const error of [erroDoStorage(500, { message: "Internal Server Error" }), BUCKET_AUSENTE[0]]) {
      const c = clienteFalso({ falha: { upload: error } });
      await expect(armazemDoSupabase(c.admin).enviar("org/h.ulaw", new Uint8Array(8))).rejects.toThrow(/armazem_envio/);
    }
  });
});

describe("armazemDoSupabase.apagar — para a limpeza do worker", () => {
  it("apaga os caminhos pedidos, e só eles", async () => {
    const c = clienteFalso();
    for (const k of ["org/a.ulaw", "org/b.ulaw", "org/c.ulaw"]) c.objetos.set(k, new Uint8Array(1));
    await armazemDoSupabase(c.admin).apagar(["org/a.ulaw", "org/c.ulaw"]);
    expect(c.remove.mock.calls[0]![0]).toEqual(["org/a.ulaw", "org/c.ulaw"]);
    expect([...c.objetos.keys()]).toEqual(["org/b.ulaw"]);
  });

  it("lista vazia: nem chama o Storage", async () => {
    const c = clienteFalso();
    await armazemDoSupabase(c.admin).apagar([]);
    expect(c.remove).not.toHaveBeenCalled();
  });

  it("o Storage recusa: lança — quem limpa precisa saber que não limpou", async () => {
    const c = clienteFalso({ falha: { remove: erroDoStorage(500, { message: "Internal Server Error" }) } });
    await expect(armazemDoSupabase(c.admin).apagar(["org/a.ulaw"])).rejects.toThrow(/armazem_remocao/);
  });
});

describe("armazemDoSupabase.listarPastas / listarObjetos — para a limpeza do worker", () => {
  const org = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

  it("listarPastas pagina até o fim: 1001 organizações, as 1001 pastas", async () => {
    const c = clienteFalso();
    for (let i = 0; i < 1001; i++) c.objetos.set(`${org(i)}/h.ulaw`, new Uint8Array(1));
    const pastas = await armazemDoSupabase(c.admin).listarPastas();
    expect(pastas).toHaveLength(1001);
    expect(new Set(pastas).size).toBe(1001);
    expect(c.list).toHaveBeenCalledTimes(2);
  });

  it("listarPastas deixa de fora o arquivo solto na raiz (não é pasta de organização)", async () => {
    const c = clienteFalso();
    c.objetos.set("solto.ulaw", new Uint8Array(1));
    c.objetos.set(`${org(1)}/h.ulaw`, new Uint8Array(1));
    expect(await armazemDoSupabase(c.admin).listarPastas()).toEqual([org(1)]);
  });

  it("listarObjetos pagina até a página incompleta, pula as pastas e devolve o caminho completo com a data", async () => {
    const c = clienteFalso();
    for (let i = 0; i < 1001; i++) c.objetos.set(`org/${String(i).padStart(4, "0")}.ulaw`, new Uint8Array(1));
    c.objetos.set("org/subpasta/x.ulaw", new Uint8Array(1));
    const objetos = await armazemDoSupabase(c.admin).listarObjetos("org");
    expect(c.list).toHaveBeenCalledTimes(2);
    expect(objetos).toHaveLength(1001);
    expect(objetos[0]).toEqual({ caminho: "org/0000.ulaw", criadoEm: new Date("2026-09-28T10:00:00Z") });
    expect(objetos.some((o) => o.caminho.includes("subpasta"))).toBe(false);
  });

  it("a listagem falha: lança", async () => {
    const c = clienteFalso({ falha: { list: erroDoStorage(500, { message: "Internal Server Error" }) } });
    await expect(armazemDoSupabase(c.admin).listarPastas()).rejects.toThrow(/armazem_lista/);
    await expect(armazemDoSupabase(c.admin).listarObjetos("org")).rejects.toThrow(/armazem_lista/);
  });
});

describe("armazemDoSupabase.baixar com AbortSignal — o prazo de quem não pode esperar", () => {
  it("SEM opções, o download é chamado como sempre foi: só com o caminho (os outros chamadores não mudam)", async () => {
    const c = clienteFalso();
    c.objetos.set("org/h.ulaw", new Uint8Array([1]));
    await armazemDoSupabase(c.admin).baixar("org/h.ulaw");
    expect(c.download.mock.calls[0]).toEqual(["org/h.ulaw"]);
  });

  it("COM o sinal, ele chega ao download do storage-js (o terceiro parâmetro, `FetchParameters`)", async () => {
    const c = clienteFalso();
    c.objetos.set("org/h.ulaw", new Uint8Array([1]));
    const controle = new AbortController();
    await armazemDoSupabase(c.admin).baixar("org/h.ulaw", { signal: controle.signal });
    expect(c.download.mock.calls[0]).toEqual(["org/h.ulaw", {}, { signal: controle.signal }]);
  });

  it("abortado, o storage-js devolve erro sem status: LANÇA (não é 'o objeto não existe')", async () => {
    const abortado = Object.assign(new Error("This operation was aborted"), { name: "StorageUnknownError", __isStorageError: true });
    const c = clienteFalso({ falha: { download: abortado } });
    await expect(armazemDoSupabase(c.admin).baixar("org/h.ulaw", { signal: AbortSignal.abort() })).rejects.toThrow(/armazem_download/);
  });
});

describe("comPrazoDeLeitura — a leitura que desiste", () => {
  const armazemQue = (baixar: PortaDoArmazem["baixar"]) => ({ baixar: vi.fn(baixar) });

  it("dentro do prazo: devolve o que o armazém devolveu (bytes ou null), com um sinal que NÃO foi abortado", async () => {
    const a = armazemQue(async () => new Uint8Array([7]));
    expect(await comPrazoDeLeitura(a, 1_000).baixar("org/h.ulaw")).toEqual(new Uint8Array([7]));
    const sinal = a.baixar.mock.calls[0]![1]!.signal!;
    expect(sinal.aborted).toBe(false);
    const ausente = armazemQue(async () => null);
    expect(await comPrazoDeLeitura(ausente, 1_000).baixar("org/h.ulaw")).toBeNull();
  });

  it("o armazém falhou dentro do prazo: a falha sobe como veio", async () => {
    const a = armazemQue(async () => {
      throw new Error("armazem_download: StorageApiError 500");
    });
    await expect(comPrazoDeLeitura(a, 1_000).baixar("org/h.ulaw")).rejects.toThrow("StorageApiError 500");
  });

  it("o armazém não responde: desiste no prazo, LANÇA (falha, não ausência) e ABORTA o pedido em curso", async () => {
    const a = armazemQue(() => new Promise(() => undefined));
    const inicio = Date.now();
    await expect(comPrazoDeLeitura(a, 40).baixar("org/h.ulaw")).rejects.toThrow(/armazem_download: .*prazo de 40 ms/);
    expect(Date.now() - inicio).toBeLessThan(1_000);
    expect(a.baixar.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});
