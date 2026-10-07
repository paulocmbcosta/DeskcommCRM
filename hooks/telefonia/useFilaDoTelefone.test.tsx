/**
 * A FILA DO TELEFONE NA TELA — o hook.
 *
 * Nos testes de componente ele é dublado; aqui é ele mesmo, sobre um `apiClient`
 * e um `useRealtimeChannel` simulados. O que se prende:
 *  - a leitura traz a defasagem entre o relógio do banco e o do navegador (é
 *    dela que todo relógio da aba sai);
 *  - sem telefonia na organização (`ativa: false`) NADA é assinado nem relido;
 *  - com telefonia, a assinatura é a de `voice_calls` DESTA organização;
 *  - A CARGA: cada pedido à rota custa várias chamadas ao banco só para
 *    autenticar, por navegador. Por isso os avisos do tempo real são juntados
 *    com folga (800 ms de espera, no máximo uma releitura a cada 4 s), e a aba
 *    ESCONDIDA não relê — nem pelo aviso, nem pela rede de segurança de 15 s:
 *    ela marca o dado como velho e relê quando a pessoa volta.
 *
 * Os casos de tempo usam relógio simulado e medem a ROTA (quantas vezes foi
 * chamada, e quando), com os números escritos aqui — e não importados do hook:
 * um teste que lê a constante do código aprova qualquer valor que ela tiver.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseRealtimeChannelOpts } from "@/hooks/realtime/useRealtimeChannel";
import type { FilaDoTelefone } from "@/lib/telefonia/fila";

const ORG = "00000000-0000-4000-8000-0000000000aa";

const orgRef: { current: { orgId: string } | null } = { current: { orgId: ORG } };
const respostaRef: { current: FilaDoTelefone } = { current: fila() };
const get = vi.fn(async (_url: string) => ({ data: respostaRef.current }));
/** A última configuração que o hook entregou ao canal de tempo real. */
const canalRef: { current: UseRealtimeChannelOpts | null } = { current: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ activeOrg: orgRef.current }) }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: UseRealtimeChannelOpts) => {
    canalRef.current = opts;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));

import { CHAVE_DA_FILA_DO_TELEFONE, useFilaDoTelefone } from "./useFilaDoTelefone";

function fila(over: Partial<FilaDoTelefone> = {}): FilaDoTelefone {
  return { ativa: true, agora: new Date().toISOString(), times: [], numeros: [], ligacoes: [], perdidas: [], ...over };
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  return { qc, ...renderHook(() => useFilaDoTelefone(), { wrapper }) };
}

// ─── a aba do navegador, visível ou escondida ──────────────────────────────
// O jsdom diz sempre "visible". A propriedade é sobreposta NESTE documento, e o
// evento é o mesmo que o navegador dispara (ele sobe até a janela, que é onde o
// TanStack Query escuta para reler ao voltar o foco).
let visibilidade: DocumentVisibilityState = "visible";
beforeAll(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibilidade });
});
afterAll(() => {
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

beforeEach(() => {
  orgRef.current = { orgId: ORG };
  respostaRef.current = fila();
  canalRef.current = null;
  visibilidade = "visible";
  get.mockClear();
});
afterEach(() => {
  // Desmonta ANTES de devolver o relógio: os timers do hook são do relógio simulado.
  cleanup();
  vi.useRealTimers();
  visibilidade = "visible";
});

describe("useFilaDoTelefone — a leitura", () => {
  it("lê a rota da fila e mede a defasagem do relógio do banco contra o deste navegador", async () => {
    // O banco está 90 s na frente: sem a defasagem, "aguardando há" nasceria
    // 1:30 menor do que é, e "cai em" 1:30 maior.
    respostaRef.current = fila({ agora: new Date(Date.now() + 90_000).toISOString() });
    const { result } = montar();
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(get).toHaveBeenCalledWith("/api/v1/telefonia/fila");
    expect(result.current.data?.ativa).toBe(true);
    // Folga de 5 s: entre montar a resposta e o hook ler `Date.now()` passa tempo real.
    expect(Math.abs((result.current.data?.defasagemMs ?? 0) - 90_000)).toBeLessThan(5_000);
  });

  it("um `agora` ilegível não envenena os relógios: a defasagem cai para zero", async () => {
    respostaRef.current = fila({ agora: "não é data" });
    const { result } = montar();
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.defasagemMs).toBe(0);
  });

  it("sem organização ativa, não lê nem assina", async () => {
    orgRef.current = null;
    const { result } = montar();
    await act(async () => {
      await Promise.resolve();
    });
    expect(get).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(canalRef.current?.enabled).toBe(false);
    expect(canalRef.current?.postgresChanges).toBeUndefined();
  });
});

describe("useFilaDoTelefone — a assinatura do tempo real", () => {
  it("sem telefonia na organização, NÃO assina nada", async () => {
    respostaRef.current = fila({ ativa: false });
    const { result } = montar();
    await waitFor(() => expect(result.current.data?.ativa).toBe(false));

    expect(canalRef.current?.enabled).toBe(false);
    expect(canalRef.current?.postgresChanges).toBeUndefined();
  });

  it("com telefonia, assina `voice_calls` DESTA organização", async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.data?.ativa).toBe(true));

    await waitFor(() => expect(canalRef.current?.enabled).toBe(true));
    expect(canalRef.current?.postgresChanges).toEqual({
      event: "*",
      schema: "public",
      table: "voice_calls",
      filter: `organization_id=eq.${ORG}`,
    });
    expect(canalRef.current?.name).toContain(ORG);
  });
});

// ─── daqui para baixo, relógio simulado ────────────────────────────────────

/** Anda o relógio simulado, dentro do `act` (o hook redesenha quando a leitura chega). */
const passar = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Deixa assentar o que já está pendente (a resposta da rota, o aviso aos observadores) sem andar o relógio. */
async function assentar() {
  await passar(0);
  await passar(0);
}

/** O Realtime entregou uma mudança de `voice_calls`. */
const aviso = () => act(() => canalRef.current?.onChange({}));

/** A aba do navegador some (outra aba em primeiro plano, janela minimizada) ou volta. */
async function aba(estado: DocumentVisibilityState) {
  visibilidade = estado;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
  });
  await assentar();
}

/** Monta com o relógio simulado e espera a primeira leitura: a rota foi chamada UMA vez. */
async function montarNoRelogio() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  const montado = montar();
  await assentar();
  expect(get).toHaveBeenCalledTimes(1);
  return montado;
}

/** A rota foi chamada `n` vezes ao todo (a primeira leitura conta). */
const leituras = (n: number) => expect(get).toHaveBeenCalledTimes(n);

describe("os avisos do tempo real são juntados com folga", () => {
  it("um aviso com a aba visível vira UMA releitura, 800 ms depois", async () => {
    await montarNoRelogio();
    expect(canalRef.current?.enabled).toBe(true);

    await aviso();
    await passar(799);
    leituras(1);
    await passar(1);
    leituras(2);

    // E é uma só: nada mais sai por conta daquele aviso.
    await passar(10_000);
    leituras(2);
  });

  it("uma rajada de 10 avisos em 1 s vira UMA releitura — e o que chegou depois dela é lido 4 s adiante, não perdido", async () => {
    await montarNoRelogio();

    // O worker escreve na linha a cada toque: um aviso a cada 100 ms, de 0 a 900 ms.
    for (let i = 0; i < 10; i++) {
      await aviso();
      await passar(100);
    }
    // Fim do segundo: UMA releitura (a dos 800 ms), por dez avisos.
    leituras(2);

    // Os avisos dos 800 e 900 ms chegaram DEPOIS dela: a mudança que eles
    // anunciam é lida na vez seguinte — 4 s depois da primeira, aos 4.800 ms.
    await passar(3_799);
    leituras(2);
    await passar(1);
    leituras(3);

    // E acabou: dez avisos custaram duas releituras, não dez.
    await passar(5_000);
    leituras(3);
  });

  it("um aviso 1 s depois de uma releitura espera a vez: a próxima só sai 4 s depois da anterior", async () => {
    await montarNoRelogio();

    await aviso();
    await passar(800);
    leituras(2); // a releitura, no instante T

    await passar(1_000);
    await aviso(); // T + 1 s
    await passar(2_999);
    leituras(2); // T + 3.999 ms: ainda não
    await passar(1);
    leituras(3); // T + 4 s
  });
});

describe("a aba escondida não relê", () => {
  it("aviso com a aba escondida: NENHUMA chamada à rota; ao voltar, ela é chamada", async () => {
    await montarNoRelogio();

    await aba("hidden");
    await aviso();
    await aviso();
    // Bem além da espera (800 ms) e do intervalo (4 s) do juntador.
    await passar(10_000);
    leituras(1);

    await aba("visible");
    leituras(2);
  });

  it("o aviso na aba escondida MARCA o dado como velho — é por isso que a volta relê, mesmo com a leitura ainda fresca", async () => {
    const { qc } = await montarNoRelogio();
    const estado = () => qc.getQueryState([...CHAVE_DA_FILA_DO_TELEFONE, ORG]);
    expect(estado()?.isInvalidated).toBe(false);

    // A leitura tem 100 ms: pelo relógio, ainda não é velha (1 s).
    await passar(100);
    await aba("hidden");
    await aviso();
    leituras(1);
    expect(estado()?.isInvalidated).toBe(true);

    await passar(100);
    await aba("visible");
    leituras(2);
    expect(estado()?.isInvalidated).toBe(false);
  });

  it("CONTROLE — sem aviso nenhum, esconder e voltar com a leitura fresca não relê", async () => {
    // Sem este caso, o de cima passaria também num mundo em que voltar o foco
    // relê SEMPRE — e não diria nada sobre a marca de "velho".
    await montarNoRelogio();

    await passar(100);
    await aba("hidden");
    await passar(100);
    await aba("visible");
    leituras(1);
  });

  it("a aba some ENTRE o aviso e a hora de reler: não relê, marca como velho, e relê na volta", async () => {
    const { qc } = await montarNoRelogio();

    await aviso(); // visível: a releitura fica marcada para daqui a 800 ms
    await passar(300);
    await aba("hidden");
    await passar(10_000);
    leituras(1);
    expect(qc.getQueryState([...CHAVE_DA_FILA_DO_TELEFONE, ORG])?.isInvalidated).toBe(true);

    await aba("visible");
    leituras(2);
  });

  it("de volta à aba, os avisos voltam a reler pela folga de sempre", async () => {
    await montarNoRelogio();
    await aba("hidden");
    await aviso();
    await aba("visible");
    leituras(2); // a releitura da volta

    await passar(5_000);
    await aviso();
    await passar(799);
    leituras(2);
    await passar(1);
    leituras(3);
  });
});

describe("a rede de segurança de 15 s", () => {
  it("com a aba visível e a telefonia ligada, a rota é chamada de novo aos 15 s — e de novo aos 30", async () => {
    await montarNoRelogio();

    await passar(14_900);
    leituras(1);
    await passar(200); // 15,1 s
    leituras(2);

    await passar(14_700); // 29,8 s
    leituras(2);
    await passar(400); // 30,2 s
    leituras(3);
  });

  it("sem telefonia na organização (`ativa: false`), nada é relido", async () => {
    respostaRef.current = fila({ ativa: false });
    await montarNoRelogio();

    await passar(60_000);
    leituras(1);
  });

  it("com a aba ESCONDIDA a rede de segurança não roda; ao voltar, relê", async () => {
    await montarNoRelogio();

    await aba("hidden");
    await passar(60_000);
    leituras(1);

    await aba("visible");
    leituras(2);
  });
});
