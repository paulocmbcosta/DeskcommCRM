/**
 * A FILA DO TELEFONE NA TELA — o hook.
 *
 * Nos testes de componente ele é dublado; aqui é ele mesmo, sobre um `apiClient`
 * e um `useRealtimeChannel` simulados. O que se prende:
 *  - a leitura traz a defasagem entre o relógio do banco e o do navegador (é
 *    dela que todo relógio da aba sai);
 *  - sem telefonia na organização (`ativa: false`) NADA é assinado — a tabela de
 *    ligações de quem não tem telefone não tem o que avisar;
 *  - com telefonia, a assinatura é a de `voice_calls` DESTA organização, e uma
 *    rajada de avisos vira UMA releitura (o juntador);
 *  - sem organização ativa, nem a leitura sai.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { RELEITURA_DE_SEGURANCA_MS, useFilaDoTelefone } from "./useFilaDoTelefone";

function fila(over: Partial<FilaDoTelefone> = {}): FilaDoTelefone {
  return { ativa: true, agora: new Date().toISOString(), times: [], numeros: [], ligacoes: [], perdidas: [], ...over };
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(() => useFilaDoTelefone(), { wrapper });
}

beforeEach(() => {
  orgRef.current = { orgId: ORG };
  respostaRef.current = fila();
  canalRef.current = null;
  get.mockClear();
});
afterEach(() => vi.useRealTimers());

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

  it("a rede de segurança relê a cada 15 s", () => {
    expect(RELEITURA_DE_SEGURANCA_MS).toBe(15_000);
  });
});

describe("useFilaDoTelefone — o tempo real", () => {
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

  it("uma rajada de avisos vira UMA releitura", async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.data?.ativa).toBe(true));
    await waitFor(() => expect(canalRef.current?.enabled).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);

    // O worker escreve na linha a cada toque: cinco avisos no mesmo instante.
    act(() => {
      for (let i = 0; i < 5; i++) canalRef.current?.onChange({});
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    // E não mais que isso: espera além da janela do juntador para ver que parou.
    await new Promise((r) => setTimeout(r, 700));
    expect(get).toHaveBeenCalledTimes(2);
  });
});
