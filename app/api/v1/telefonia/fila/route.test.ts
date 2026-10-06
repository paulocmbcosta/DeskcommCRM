// @vitest-environment node
/**
 * A LEITURA DA FILA DO TELEFONE PELA ROTA (aba Telefone; migration 0295):
 * qualquer membro lê (a régua é viewer); a organização é a da SESSÃO — a rota nem
 * recebe o pedido, não há corpo nem query de onde tirar outra; sem a telefonia
 * oferecida na instalação, responde "desligada" sem tocar no banco.
 *
 * A leitura é COMPARTILHADA por 1,5 s por organização: no pico todo navegador
 * pede junto, e uma leitura do banco serve a todos — mas nunca a de uma
 * organização para outra, e a leitura que falhou não fica guardada.
 *
 * O SQL é provado no Postgres real (tests/invariants/telefonia-fila-da-tela.test.ts);
 * aqui ele é uma porta. O `Map` das leituras é do módulo: cada caso importa a
 * rota de novo (`vi.resetModules`), com os dublês de sempre.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FilaDoTelefone } from "@/lib/telefonia/fila";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const POOL = { pool: "da-rota" };
const AGORA = new Date("2026-10-06T15:00:00.000Z");

const dubles = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getRequestPool: vi.fn(),
  configAriDoAmbiente: vi.fn(),
  lerFilaDoTelefone: vi.fn(),
}));
const estado = vi.hoisted(() => ({ org: "", papel: "viewer", idioma: "pt-BR" }));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: dubles.requireRole }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: dubles.getRequestPool }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: dubles.configAriDoAmbiente }));
vi.mock("@/lib/channels/telefonia/fila-da-tela", () => ({ lerFilaDoTelefone: dubles.lerFilaDoTelefone }));

/** A fila de uma organização, marcada com ela: dá para ver de QUEM é a resposta que chegou. */
const filaDe = (org: string): FilaDoTelefone => ({
  ativa: true,
  agora: AGORA.toISOString(),
  times: [{ id: `time-de-${org}`, nome: "Suporte", espera_maxima_s: 120 }],
  numeros: [],
  ligacoes: [],
  perdidas: [],
});

/** A rota, importada de novo: o `Map` das leituras começa vazio em cada caso. */
const rota = async () => (await import("./route")).GET;
const corpoDe = async (r: Response) => ((await r.json()) as { data: FilaDoTelefone }).data;
const erroDe = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"], now: AGORA });
  estado.org = ORG;
  estado.papel = "viewer";
  estado.idioma = "pt-BR";
  for (const d of Object.values(dubles)) d.mockReset();
  dubles.requireRole.mockImplementation(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "bia@exemplo.com", full_name: "Bia", idioma: estado.idioma },
    org: { orgId: estado.org, name: "Org", role: estado.papel },
  }));
  dubles.getRequestPool.mockImplementation(() => POOL);
  dubles.configAriDoAmbiente.mockImplementation(() => ({ baseUrl: "http://asterisk:8088", senha: "x" }));
  dubles.lerFilaDoTelefone.mockImplementation(async (_db: unknown, org: string) => filaDe(org));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/v1/telefonia/fila", () => {
  it("qualquer membro lê: a régua é viewer, e a rota nem recebe o pedido (não há corpo nem query)", async () => {
    const GET = await rota();
    expect(GET.length).toBe(0);
    expect((await GET()).status).toBe(200);
    expect(dubles.requireRole.mock.calls[0]![0]).toBe("viewer");
    expect(dubles.requireRole.mock.calls[0]![1]).toMatchObject({ resource: "telefonia_fila" });
  });

  it.each([401, 403])("sem sessão ou sem papel (%i): a resposta do `requireRole` volta intacta, sem ler nada", async (status) => {
    const recusa = Response.json({ error: { code: "x", message: "y" } }, { status });
    dubles.requireRole.mockResolvedValueOnce({ ok: false, response: recusa });
    const r = await (await rota())();
    expect(r).toBe(recusa);
    expect(dubles.configAriDoAmbiente).not.toHaveBeenCalled();
    expect(dubles.getRequestPool).not.toHaveBeenCalled();
    expect(dubles.lerFilaDoTelefone).not.toHaveBeenCalled();
  });

  it("telefonia não oferecida nesta instalação: `ativa: false` e listas vazias, sem ler o banco", async () => {
    dubles.configAriDoAmbiente.mockReturnValue(null);
    const r = await (await rota())();
    expect(r.status).toBe(200);
    expect(await corpoDe(r)).toEqual({ ativa: false, agora: AGORA.toISOString(), times: [], numeros: [], ligacoes: [], perdidas: [] });
    expect(dubles.getRequestPool).not.toHaveBeenCalled();
    expect(dubles.lerFilaDoTelefone).not.toHaveBeenCalled();
  });

  it("ligada: lê com a conexão do app e a organização DA SESSÃO, e devolve o que leu", async () => {
    const r = await (await rota())();
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Request-Id")).toBeTruthy();
    expect(await corpoDe(r)).toEqual(filaDe(ORG));
    expect(dubles.lerFilaDoTelefone).toHaveBeenCalledTimes(1);
    expect(dubles.lerFilaDoTelefone.mock.calls[0]).toEqual([POOL, ORG]);
  });

  describe("a leitura compartilhada por 1,5 s", () => {
    it("pedidos AO MESMO TEMPO da mesma organização dividem uma leitura só", async () => {
      let soltar: (f: FilaDoTelefone) => void = () => undefined;
      dubles.lerFilaDoTelefone.mockImplementationOnce(() => new Promise<FilaDoTelefone>((res) => (soltar = res)));
      const GET = await rota();
      const pedidos = [GET(), GET(), GET()];
      // Deixa os três chegarem à leitura antes de ela responder.
      await vi.waitFor(() => expect(dubles.lerFilaDoTelefone).toHaveBeenCalled());
      await Promise.resolve();
      soltar(filaDe(ORG));
      const respostas = await Promise.all(pedidos);
      expect(respostas.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(dubles.lerFilaDoTelefone).toHaveBeenCalledTimes(1);
    });

    it("dois pedidos seguidos dentro de 1,5 s = uma leitura; depois de 1,6 s = outra", async () => {
      const GET = await rota();
      await GET();
      vi.setSystemTime(AGORA.getTime() + 1_400);
      await GET();
      expect(dubles.lerFilaDoTelefone).toHaveBeenCalledTimes(1);

      vi.setSystemTime(AGORA.getTime() + 1_600);
      await GET();
      expect(dubles.lerFilaDoTelefone).toHaveBeenCalledTimes(2);
    });

    it("de organizações DIFERENTES são duas leituras, e cada uma recebe a SUA fila — nunca a que a outra acabou de ler", async () => {
      const GET = await rota();
      const daPrimeira = await corpoDe(await GET());
      estado.org = OUTRA_ORG;
      const daSegunda = await corpoDe(await GET());
      estado.org = ORG;
      const deNovoDaPrimeira = await corpoDe(await GET());

      expect(dubles.lerFilaDoTelefone.mock.calls.map((c) => c[1])).toEqual([ORG, OUTRA_ORG]);
      expect(daPrimeira.times[0]!.id).toBe(`time-de-${ORG}`);
      expect(daSegunda.times[0]!.id).toBe(`time-de-${OUTRA_ORG}`);
      expect(deNovoDaPrimeira.times[0]!.id).toBe(`time-de-${ORG}`);
    });
  });

  describe("a leitura que falha", () => {
    it("responde 500 com a frase da rota, e a seguinte tenta de novo — não fica presa no erro", async () => {
      dubles.lerFilaDoTelefone.mockRejectedValueOnce(new Error("banco fora"));
      const GET = await rota();
      const r = await GET();
      expect(r.status).toBe(500);
      expect(await erroDe(r)).toEqual({ code: "internal_error", message: "Não foi possível ler a fila do telefone." });

      // No MESMO instante (dentro da janela de 1,5 s): o erro não é servido de novo.
      const depois = await GET();
      expect(depois.status).toBe(200);
      expect(dubles.lerFilaDoTelefone).toHaveBeenCalledTimes(2);
    });

    it("a mensagem do banco não vaza na resposta, e sai no idioma de quem pede", async () => {
      estado.idioma = "es";
      dubles.lerFilaDoTelefone.mockRejectedValueOnce(new Error('relation "voice_calls" does not exist'));
      const r = await (await rota())();
      const erro = await erroDe(r);
      expect(erro.message).toBe("No se pudo leer la cola del teléfono.");
      expect(JSON.stringify(erro)).not.toMatch(/voice_calls/);
    });

    it("sem a conexão do app configurada (o pool lança na hora): 500, e não uma exceção solta", async () => {
      dubles.getRequestPool.mockImplementationOnce(() => {
        throw new Error("SUPABASE_DB_URL ausente");
      });
      const r = await (await rota())();
      expect(r.status).toBe(500);
      expect((await erroDe(r)).code).toBe("internal_error");
      expect(dubles.lerFilaDoTelefone).not.toHaveBeenCalled();
    });
  });
});
