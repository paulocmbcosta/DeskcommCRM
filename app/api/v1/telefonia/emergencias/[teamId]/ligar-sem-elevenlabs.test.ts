// @vitest-environment node
/**
 * D15 PELA ROTA, COM A CAMADA DE BANCO DE VERDADE: a rota de ligar o aviso de
 * instabilidade NÃO CARREGA o cliente da ElevenLabs, e ligar NÃO FAZ chamada de
 * rede nenhuma.
 *
 * "Não carrega": o cliente (`lib/telefonia/elevenlabs.ts`) é uma fábrica que
 * LANÇA AO CARREGAR, e todo o grafo de módulos da rota é o DE VERDADE — a rota,
 * `emergencias.ts`, `falas.ts`, `armazem.ts`, `vocabulario.ts` (com o
 * `STATUS_DA_FALHA`). Nenhum módulo da telefonia é trocado por mock; se qualquer
 * um passasse a importar o cliente (direto ou por um módulo no meio, como o
 * `servico-de-falas.ts`), este arquivo ficaria vermelho ao carregar. Portas em
 * memória só para o banco (`getRequestPool`), para o Storage
 * (`armazemDaInstalacao` devolve um armazém falso; o resto de armazem.ts é o
 * real) e para sessão, auditoria e telefonia oferecida.
 *
 * "Não chama": nos dois caminhos do ligar — o texto NOVO (confere a prévia no
 * Storage, com prazo) e o texto SALVO sem mudança (não vai ao Storage) — o
 * `fetch` global não é chamado nenhuma vez.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloArmazem from "@/lib/telefonia/armazem";

const ORG = "22222222-2222-4222-8222-222222222222";
const TIME = "44444444-4444-4444-8444-444444444444";
const h = vi.hoisted(() => ({ banco: null as unknown, armazem: null as unknown }));

vi.mock("@/lib/telefonia/elevenlabs", () => {
  throw new Error("ligar o aviso carregou o cliente da ElevenLabs (D15)");
});
vi.mock("@/lib/telefonia/armazem", async () => ({
  ...(await vi.importActual<typeof ModuloArmazem>("@/lib/telefonia/armazem")),
  armazemDaInstalacao: vi.fn(() => h.armazem),
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "manager" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => h.banco) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: vi.fn(() => ({ baseUrl: "http://a", senha: "x" })) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { caminhoDaFala, hashDaFala } from "@/lib/telefonia/falas";

import { PUT } from "./route";

const VOZ = { voice_id: "voz-1", model_id: "eleven_multilingual_v2" };
const TEXTO = "Estamos com instabilidade no sistema.";
const HASH = hashDaFala(TEXTO, VOZ.voice_id, VOZ.model_id);

interface Fala {
  id: string;
  tipo: string;
  texto: string;
  voice_id: string;
  model_id: string;
  status: string;
  erro: null;
  duracao_ms: number;
  atualizada_em: Date;
  content_hash: string;
  storage_path: string;
}

/** O banco mínimo do ligar: o time, a voz, a fala e a transação. */
function bancoEmMemoria() {
  const falas = new Map<string, Fala>();
  const time = { falaId: null as string | null, desde: null as Date | null };
  const executar = async (sqlBruto: string, p: unknown[] = []) => {
    const s = sqlBruto.replace(/\s+/g, " ").trim();
    const linhas = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (["begin", "commit", "rollback"].includes(s) || s.startsWith("set local lock_timeout")) return linhas([]);
    if (s.startsWith("select id, name as nome")) {
      return linhas(
        p[0] === TIME && p[1] === ORG
          ? [{ id: TIME, nome: "Suporte", fala_id: time.falaId, desde: time.desde, expira_em: null, ativado_por: null, arquivado: false }]
          : [],
      );
    }
    if (s.startsWith("select voice_id, model_id from phone_settings")) return linhas([VOZ]);
    if (s.includes("from phone_prompts where id = $1 and organization_id = $2")) {
      const f = falas.get(p[0] as string);
      return linhas(f ? [f] : []);
    }
    if (s.startsWith("insert into phone_prompts")) {
      const f: Fala = {
        id: "66666666-6666-4666-8666-666666666666",
        tipo: p[1] as string,
        texto: p[2] as string,
        voice_id: p[3] as string,
        model_id: p[4] as string,
        content_hash: p[5] as string,
        storage_path: p[6] as string,
        duracao_ms: p[7] as number,
        status: p[8] as string,
        erro: null,
        atualizada_em: new Date("2026-09-28T13:00:00Z"),
      };
      falas.set(f.id, f);
      return linhas([f]);
    }
    if (s.startsWith("update attendance_teams set phone_emergency_prompt_id")) {
      Object.assign(time, { falaId: p[2], desde: p[3] });
      return linhas([{}]);
    }
    throw new Error(`consulta inesperada: ${s}`);
  };
  return {
    falas,
    time,
    query: executar,
    connect: async () => ({ query: executar, release: () => undefined }),
  };
}

let fetchGlobal: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchGlobal = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("ligar o aviso fez uma chamada de rede");
  });
});
afterEach(() => fetchGlobal.mockRestore());

const ligar = (corpo: unknown) =>
  PUT(
    new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/emergencias/${TIME}`, { method: "PUT", body: JSON.stringify(corpo) }),
    { params: Promise.resolve({ teamId: TIME }) },
  );

describe("ligar o aviso não alcança a ElevenLabs — rota e camada de banco de verdade", () => {
  it("texto NOVO: confere a prévia no Storage (com prazo), grava a fala e liga — sem ElevenLabs e sem rede", async () => {
    const banco = bancoEmMemoria();
    const baixar = vi.fn(async (caminho: string, opcoes?: { signal?: AbortSignal }) =>
      caminho === caminhoDaFala(ORG, HASH) && opcoes?.signal ? new Uint8Array(1600) : null,
    );
    h.banco = banco;
    h.armazem = { baixar };

    const r = await ligar({ fala: { texto: TEXTO, hash: HASH }, duracao: "1h" });

    expect(r.status).toBe(200);
    expect(baixar).toHaveBeenCalledTimes(1);
    expect(banco.falas.size).toBe(1);
    expect(banco.time.falaId).toBe("66666666-6666-4666-8666-666666666666");
    expect(fetchGlobal).not.toHaveBeenCalled();
  });

  it("texto SALVO, sem mudança: liga sem Storage nenhum — nem com ele fora do ar", async () => {
    const banco = bancoEmMemoria();
    banco.falas.set("fala-salva", {
      id: "fala-salva",
      tipo: "emergency",
      texto: TEXTO,
      voice_id: VOZ.voice_id,
      model_id: VOZ.model_id,
      status: "ready",
      erro: null,
      duracao_ms: 200,
      atualizada_em: new Date("2026-09-27T10:00:00Z"),
      content_hash: HASH,
      storage_path: caminhoDaFala(ORG, HASH),
    });
    banco.time.falaId = "fala-salva";
    const baixar = vi.fn(async () => {
      throw new Error("armazem_download: StorageApiError 503");
    });
    h.banco = banco;
    h.armazem = { baixar };

    const r = await ligar({ fala: { texto: TEXTO, hash: HASH } });

    expect(r.status).toBe(200);
    expect(baixar).not.toHaveBeenCalled();
    expect(banco.time).toMatchObject({ falaId: "fala-salva" });
    expect(banco.time.desde).toBeInstanceOf(Date);
    expect(fetchGlobal).not.toHaveBeenCalled();
  });
});
