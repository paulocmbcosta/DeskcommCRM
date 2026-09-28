// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { armazemDoSupabase } from "./armazem";

/**
 * O cliente de serviço falso: só `storage.from(bucket)` com as quatro operações
 * que o armazém usa. Cada operação devolve `{ data, error }`, como o storage-js.
 */
function clienteFalso(respostas: {
  download?: () => { data: Blob | null; error: unknown };
  upload?: () => { data: unknown; error: unknown };
  list?: (pasta: string, o: { offset?: number }) => { data: unknown[] | null; error: unknown };
}) {
  const baldes: string[] = [];
  const upload = vi.fn(async (..._a: unknown[]) => respostas.upload?.() ?? { data: {}, error: null });
  const download = vi.fn(async (..._a: unknown[]) => respostas.download?.() ?? { data: null, error: null });
  const list = vi.fn(async (pasta: string, o: { offset?: number }) => respostas.list?.(pasta, o) ?? { data: [], error: null });
  const admin = {
    storage: {
      from: (b: string) => {
        baldes.push(b);
        return { upload, download, list, remove: vi.fn(async () => ({ data: [], error: null })) };
      },
    },
  } as unknown as SupabaseClient;
  return { admin, baldes, upload, download, list };
}

/** O erro que o storage-js monta a partir de uma resposta HTTP (`StorageApiError`): tem `status`. */
const erroHttp = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status, __isStorageError: true });

describe("armazemDoSupabase.baixar — 'não existe' é diferente de 'o Storage falhou'", () => {
  it("objeto existente: os bytes, do bucket phone-prompts", async () => {
    const c = clienteFalso({ download: () => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }) });
    expect(await armazemDoSupabase(c.admin).baixar("org/h.ulaw")).toEqual(new Uint8Array([1, 2, 3]));
    expect(c.baldes).toEqual(["phone-prompts"]);
    expect(c.download.mock.calls[0]![0]).toBe("org/h.ulaw");
  });

  it.each([400, 404])("HTTP %i (a régua de `exists()` do storage-js): o objeto não existe → null", async (status) => {
    const c = clienteFalso({ download: () => ({ data: null, error: erroHttp(status) }) });
    expect(await armazemDoSupabase(c.admin).baixar("org/h.ulaw")).toBeNull();
  });

  it("5xx, 401 ou falha de rede: LANÇA — quem chama não pode confundir com 'não existe' e pagar uma síntese", async () => {
    for (const error of [erroHttp(500), erroHttp(401), Object.assign(new Error("fetch failed"), { __isStorageError: true })]) {
      const c = clienteFalso({ download: () => ({ data: null, error }) });
      await expect(armazemDoSupabase(c.admin).baixar("org/h.ulaw")).rejects.toThrow(/armazem_download/);
    }
  });
});

describe("armazemDoSupabase.enviar", () => {
  it("grava como audio/basic (o único tipo que o bucket aceita), com upsert", async () => {
    const c = clienteFalso({});
    await armazemDoSupabase(c.admin).enviar("org/h.ulaw", new Uint8Array(8));
    expect(c.upload.mock.calls[0]).toEqual(["org/h.ulaw", new Uint8Array(8), { contentType: "audio/basic", upsert: true }]);
  });

  it("o Storage recusa: lança", async () => {
    const c = clienteFalso({ upload: () => ({ data: null, error: erroHttp(500) }) });
    await expect(armazemDoSupabase(c.admin).enviar("org/h.ulaw", new Uint8Array(8))).rejects.toThrow(/armazem_envio/);
  });
});

describe("armazemDoSupabase.listarObjetos — para a limpeza do worker", () => {
  it("pagina até a página incompleta, pula as pastas e devolve o caminho completo com a data", async () => {
    const pagina = (n: number, inicio: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `id-${inicio + i}`, name: `${inicio + i}.ulaw`, created_at: "2026-09-28T10:00:00Z" }));
    const c = clienteFalso({
      list: (_pasta, o) =>
        o.offset === 0
          ? { data: [{ id: null, name: "subpasta" }, ...pagina(999, 0)], error: null }
          : { data: pagina(2, 999), error: null },
    });
    const objetos = await armazemDoSupabase(c.admin).listarObjetos("org");
    expect(c.list).toHaveBeenCalledTimes(2);
    expect(objetos).toHaveLength(1001);
    expect(objetos[0]).toEqual({ caminho: "org/0.ulaw", criadoEm: new Date("2026-09-28T10:00:00Z") });
    expect(objetos.some((o) => o.caminho.endsWith("subpasta"))).toBe(false);
  });
});
