// @vitest-environment node
/**
 * A LEITURA DA FILA DO TELEFONE PELA ROTA (aba Telefone; migration 0295):
 * qualquer membro lê (a régua é viewer); a organização é a da SESSÃO — a rota nem
 * recebe o pedido, não há corpo nem query de onde tirar outra; sem a telefonia
 * oferecida na instalação, responde "desligada" sem tocar no banco.
 *
 * VOO ÚNICO COM FILA DE UM, por organização: nenhum pedido recebe uma leitura que
 * COMEÇOU antes de ele chegar. Quem chega com uma leitura em curso entra na
 * próxima, que só começa quando a em curso termina — e não antes de 500 ms do
 * início dela. Nunca a leitura de uma organização para outra; a que falhou não
 * fica guardada; e nada sobra na memória depois.
 *
 * O SQL é provado no Postgres real (tests/invariants/telefonia-fila-da-tela.test.ts);
 * aqui ele é uma porta, com o relógio falso e — nos casos do voo — a promessa de
 * cada leitura do banco resolvida à mão. O estado das leituras é do módulo: cada
 * caso importa a rota de novo (`vi.resetModules`), com os dublês de sempre.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FilaDoTelefone } from "@/lib/telefonia/fila";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const POOL = { pool: "da-rota" };
const AGORA = new Date("2026-10-06T15:00:00.000Z");
const T0 = AGORA.getTime();

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

/**
 * A fila de uma organização, marcada com ela e com QUAL leitura do banco a
 * trouxe (`leitura-N` no lugar do número): dá para ver de quem é, e de quando
 * é, a resposta que chegou.
 */
const filaDe = (org: string, leitura = 1): FilaDoTelefone => ({
  ativa: true,
  agora: AGORA.toISOString(),
  times: [{ id: `time-de-${org}`, nome: "Suporte", espera_maxima_s: 120 }],
  numeros: [{ id: `leitura-${leitura}`, nome: null, numero: null }],
  ligacoes: [],
  perdidas: [],
});

/** A rota, importada de novo: o estado das leituras começa vazio em cada caso. */
const modulo = () => import("./route");
const rota = async () => (await modulo()).GET;
const corpoDe = async (r: Response) => ((await r.json()) as { data: FilaDoTelefone }).data;
const erroDe = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;

// ─── O banco na mão ──────────────────────────────────────────────────────────

/** Uma leitura que a rota pediu ao banco: de quem, quando começou, e os dois jeitos de ela acabar. */
interface LeituraDoBanco {
  org: string;
  comecouEm: number;
  responder: () => void;
  falhar: () => void;
}
/** As leituras pedidas, na ordem. Cada uma só acaba quando o teste mandar. */
let banco: LeituraDoBanco[] = [];

function bancoNaMao(): void {
  dubles.lerFilaDoTelefone.mockImplementation(
    (_db: unknown, org: string) =>
      new Promise<FilaDoTelefone>((resolve, reject) => {
        const n = banco.length + 1;
        banco.push({ org, comecouEm: Date.now(), responder: () => resolve(filaDe(org, n)), falhar: () => reject(new Error("banco fora")) });
      }),
  );
}

type Rota = () => Promise<Response>;
/** Um pedido: quando chegou e a resposta, que sai quando a leitura dele acabar. */
const pedir = (GET: Rota) => ({ chegouEm: Date.now(), resposta: GET() });
/** De QUAL leitura do banco (1ª, 2ª…) veio esta resposta. */
const qualLeitura = async (r: Response) => Number((await corpoDe(r)).numeros[0]!.id.replace("leitura-", ""));
/** O relógio anda (e tudo o que estava para acontecer até lá acontece). */
const passar = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Sem andar o relógio: deixa os pedidos chegarem aonde iam chegar. */
const assentar = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: AGORA });
  banco = [];
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

  describe("voo único com fila de um: ninguém recebe o que foi lido antes de pedir", () => {
    it("(a) o cenário da revisão: B chega DURANTE a leitura de A e recebe uma leitura que começou depois de B chegar", async () => {
      bancoNaMao();
      const GET = await rota();
      // t=0: A lê. Em t=300 ms o banco muda e o Realtime avisa todo mundo; em t=700 ms B relê.
      const a = pedir(GET);
      await assentar();
      expect(banco).toHaveLength(1);
      await passar(700);
      const b = pedir(GET);
      await assentar();
      // B não abre uma leitura concorrente — e não fica com a de A, que começou antes da mudança.
      expect(banco).toHaveLength(1);

      await passar(100);
      banco[0]!.responder();
      await assentar();
      // A leitura de A durou mais que o intervalo mínimo: a próxima começa no FIM dela.
      expect(banco).toHaveLength(2);
      expect(banco[1]!.comecouEm).toBe(T0 + 800);
      expect(banco[1]!.comecouEm).toBeGreaterThanOrEqual(b.chegouEm);
      banco[1]!.responder();

      expect(await qualLeitura(await a.resposta)).toBe(1);
      expect(await qualLeitura(await b.resposta)).toBe(2);
    });

    it("(b) 20 pedidos chegando durante uma leitura: 2 leituras do banco no total, e os 20 recebem a segunda", async () => {
      bancoNaMao();
      const GET = await rota();
      const primeiro = pedir(GET);
      await assentar();
      const vinte: Array<ReturnType<typeof pedir>> = [];
      for (let i = 0; i < 20; i++) {
        await passar(10);
        vinte.push(pedir(GET));
      }
      await assentar();
      expect(banco).toHaveLength(1);

      // t=200 ms: a primeira acaba. A segunda espera os 500 ms desde o INÍCIO da primeira.
      banco[0]!.responder();
      await assentar();
      expect(banco).toHaveLength(1);
      await passar(299);
      expect(banco).toHaveLength(1);
      await passar(1);
      expect(banco).toHaveLength(2);
      expect(banco[1]!.comecouEm - banco[0]!.comecouEm).toBe(500);
      for (const p of vinte) expect(banco[1]!.comecouEm).toBeGreaterThanOrEqual(p.chegouEm);

      banco[1]!.responder();
      const leituras = await Promise.all(vinte.map(async (p) => qualLeitura(await p.resposta)));
      expect(leituras).toEqual(Array.from({ length: 20 }, () => 2));
      expect(await qualLeitura(await primeiro.resposta)).toBe(1);
      // E não sobra leitura nenhuma por fazer.
      await passar(5_000);
      expect(banco).toHaveLength(2);
    });

    it("(c) dois pedidos em sequência, sem sobreposição, com menos de 500 ms entre eles: a segunda leitura só começa aos 500 ms", async () => {
      bancoNaMao();
      const GET = await rota();
      const um = pedir(GET);
      await assentar();
      banco[0]!.responder();
      expect(await qualLeitura(await um.resposta)).toBe(1);

      await passar(100);
      const dois = pedir(GET);
      let respondido = false;
      void dois.resposta.then(() => (respondido = true));
      await assentar();
      // Não lê na hora (o intervalo mínimo) — e não recebe a leitura que já acabou, que começou antes dele.
      expect(banco).toHaveLength(1);
      await passar(399);
      expect(banco).toHaveLength(1);
      expect(respondido).toBe(false);
      await passar(1);
      expect(banco).toHaveLength(2);
      expect(banco[1]!.comecouEm).toBe(T0 + 500);

      banco[1]!.responder();
      expect(await qualLeitura(await dois.resposta)).toBe(2);
    });

    it("passado o intervalo, sem leitura em curso, o pedido lê NA HORA", async () => {
      bancoNaMao();
      const GET = await rota();
      const um = pedir(GET);
      await assentar();
      banco[0]!.responder();
      await um.resposta;

      await passar(500);
      const dois = pedir(GET);
      await assentar();
      expect(banco).toHaveLength(2);
      expect(banco[1]!.comecouEm).toBe(T0 + 500);
      banco[1]!.responder();
      expect(await qualLeitura(await dois.resposta)).toBe(2);
    });

    it("(d) organizações diferentes não se esperam nem se misturam", async () => {
      bancoNaMao();
      const GET = await rota();
      const deA = pedir(GET);
      await assentar();
      estado.org = OUTRA_ORG;
      const deB = pedir(GET);
      await assentar();
      // B não espera a leitura de A, nem o intervalo de A: lê no mesmo instante.
      expect(banco.map((l) => l.org)).toEqual([ORG, OUTRA_ORG]);
      expect(banco[1]!.comecouEm).toBe(banco[0]!.comecouEm);

      // Quem chega durante cada uma entra na próxima DA SUA organização.
      const outroDeB = pedir(GET);
      estado.org = ORG;
      const outroDeA = pedir(GET);
      await assentar();
      expect(banco).toHaveLength(2);

      // A de B acaba; a de A segue em curso. Só a próxima de B começa.
      banco[1]!.responder();
      expect((await corpoDe(await deB.resposta)).times[0]!.id).toBe(`time-de-${OUTRA_ORG}`);
      await passar(500);
      expect(banco.map((l) => l.org)).toEqual([ORG, OUTRA_ORG, OUTRA_ORG]);
      banco[0]!.responder();
      await assentar();
      expect(banco.map((l) => l.org)).toEqual([ORG, OUTRA_ORG, OUTRA_ORG, ORG]);
      banco[2]!.responder();
      banco[3]!.responder();

      const respostas = await Promise.all([deA.resposta, outroDeA.resposta, outroDeB.resposta].map(async (r) => corpoDe(await r)));
      expect(respostas.map((c) => [c.times[0]!.id, c.numeros[0]!.id])).toEqual([
        [`time-de-${ORG}`, "leitura-1"],
        [`time-de-${ORG}`, "leitura-4"],
        [`time-de-${OUTRA_ORG}`, "leitura-3"],
      ]);
      expect(dubles.lerFilaDoTelefone.mock.calls.map((c) => c[1])).toEqual([ORG, OUTRA_ORG, OUTRA_ORG, ORG]);
    });

    it("(e) a leitura que rejeita: quem estava nela recebe 500; quem chegou durante ela lê de novo e recebe 200", async () => {
      bancoNaMao();
      const GET = await rota();
      const zero = pedir(GET);
      await assentar();
      // Dois chegam durante a 1ª leitura: dividem a 2ª.
      const um = pedir(GET);
      const dois = pedir(GET);
      await assentar();
      banco[0]!.responder();
      await passar(500);
      expect(banco).toHaveLength(2);
      // Um terceiro chega durante a 2ª — a que vai falhar: é da 3ª.
      const tres = pedir(GET);
      await assentar();

      banco[1]!.falhar();
      const [r1, r2] = await Promise.all([um.resposta, dois.resposta]);
      expect([r1.status, r2.status]).toEqual([500, 500]);
      expect(await erroDe(r1)).toEqual({ code: "internal_error", message: "Não foi possível ler a fila do telefone." });

      // A falha não envenena a próxima: ela começa no prazo de sempre e lê o banco de novo.
      await passar(500);
      expect(banco).toHaveLength(3);
      banco[2]!.responder();
      const r3 = await tres.resposta;
      expect(r3.status).toBe(200);
      expect(await qualLeitura(r3)).toBe(3);
      expect((await zero.resposta).status).toBe(200);
    });

    it("a leitura que falha sozinha: 500 com a frase da rota; o pedido seguinte não recebe o erro guardado — lê de novo", async () => {
      bancoNaMao();
      const GET = await rota();
      const um = pedir(GET);
      await assentar();
      banco[0]!.falhar();
      const r = await um.resposta;
      expect(r.status).toBe(500);
      expect(await erroDe(r)).toEqual({ code: "internal_error", message: "Não foi possível ler a fila do telefone." });

      // No MESMO instante: espera o intervalo mínimo (a falha também conta para ele) e lê de novo.
      const dois = pedir(GET);
      await assentar();
      expect(banco).toHaveLength(1);
      await passar(500);
      expect(banco).toHaveLength(2);
      banco[1]!.responder();
      const depois = await dois.resposta;
      expect(depois.status).toBe(200);
      expect(await qualLeitura(depois)).toBe(2);
    });

    it("(f) depois de tudo, nada fica guardado: nem leitura, nem fila de espera, nem relógio armado", async () => {
      bancoNaMao();
      const { GET, organizacoesComLeitura } = await modulo();
      expect(organizacoesComLeitura()).toBe(0);

      // A: uma leitura rápida, com um pedido na fila dela. B: uma leitura lenta, que falha, sem ninguém atrás.
      const a1 = pedir(GET);
      await assentar();
      const a2 = pedir(GET);
      estado.org = OUTRA_ORG;
      const b1 = pedir(GET);
      await assentar();
      expect(organizacoesComLeitura()).toBe(2);

      banco[0]!.responder();
      await a1.resposta;
      // A leitura de A acabou, mas a vaga dela dura até os 500 ms — é o que segura a próxima.
      expect(organizacoesComLeitura()).toBe(2);
      await passar(500);
      expect(banco.map((l) => l.org)).toEqual([ORG, OUTRA_ORG, ORG]);
      banco[2]!.responder();
      await a2.resposta;

      await passar(400);
      banco[1]!.falhar();
      expect((await b1.resposta).status).toBe(500);
      // B: a leitura passou dos 500 ms e não havia próxima — a entrada some quando ela termina.
      await assentar();
      expect(organizacoesComLeitura()).toBe(1);
      // A: a 2ª leitura acabou e não há próxima — a entrada some quando o intervalo dela passa.
      await passar(100);
      expect(organizacoesComLeitura()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      // E pelo comportamento: quem pede agora, de qualquer das duas, lê na hora — não há nada à frente.
      const depoisB = pedir(GET);
      estado.org = ORG;
      const depoisA = pedir(GET);
      await assentar();
      expect(banco.map((l) => l.org)).toEqual([ORG, OUTRA_ORG, ORG, OUTRA_ORG, ORG]);
      banco[3]!.responder();
      banco[4]!.responder();
      expect((await depoisA.resposta).status).toBe(200);
      expect((await depoisB.resposta).status).toBe(200);
      await passar(500);
      expect(organizacoesComLeitura()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("a leitura que falha", () => {
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
