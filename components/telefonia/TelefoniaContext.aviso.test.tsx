/**
 * A SAÍDA QUE A OPERADORA RECUSA APARECE PARA QUEM DISCOU.
 *
 * Medido em produção (2026-09-28): a operadora devolveu 404 em 0,2 s, o
 * Asterisk derrubou o ramal com um BYE comum e o painel da ligação sumiu sem
 * explicação — o JsSIP não distingue "a operadora recusou" de "acabou". O
 * porquê está no banco (`end_reason`), gravado pelo worker DEPOIS de derrubar o
 * ramal. Aqui se mede o caminho inteiro do navegador: o provider com um JsSIP
 * de mentira, a API respondendo como a real (primeiro ainda viva, depois
 * encerrada) e o painel de verdade na tela.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const jssip = vi.hoisted(() => ({ sessao: null as null | { emit(nome: string, ev?: unknown): void } }));

vi.mock("jssip", () => {
  type Ouvinte = (ev?: unknown) => void;
  class Emissor {
    private ouvintes = new Map<string, Ouvinte[]>();
    on(nome: string, fn: Ouvinte) {
      this.ouvintes.set(nome, [...(this.ouvintes.get(nome) ?? []), fn]);
    }
    emit(nome: string, ev?: unknown) {
      for (const fn of this.ouvintes.get(nome) ?? []) fn(ev);
    }
  }
  class Sessao extends Emissor {
    connection = null;
    terminate() {
      this.emit("ended");
    }
  }
  class UA extends Emissor {
    start() {
      queueMicrotask(() => this.emit("registered"));
    }
    stop() {}
    register() {}
    call() {
      const s = new Sessao();
      jssip.sessao = s;
      this.emit("newRTCSession", { session: s, originator: "local", request: { getHeader: () => undefined } });
      return s;
    }
  }
  class WebSocketInterface {}
  return { default: { UA, WebSocketInterface }, UA, WebSocketInterface };
});

const api = vi.hoisted(() => ({
  estado: { status: "ringing", end_reason: null as string | null, answered_at: null as string | null },
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: vi.fn(async (url: string) => {
      if (url === "/api/v1/telefonia/ramal") {
        return { data: { ativo: true, usuario: "ramal-u1", senha: "s", ws_url: "wss://x/telefonia/ws", numeros: [] } };
      }
      if (url === "/api/v1/telefonia/chamadas") return { data: { id: "vc-1", destino: "c-vc-1" } };
      throw new Error(`POST inesperado ${url}`);
    }),
    get: vi.fn(async (url: string) => {
      if (url !== "/api/v1/telefonia/chamadas/vc-1") throw new Error(`GET inesperado ${url}`);
      return {
        data: {
          id: "vc-1",
          direction: "outbound",
          peer_phone: "+5561995140098",
          ended_at: null,
          conversation_id: null,
          contact_id: null,
          contact_name: null,
          ...api.estado,
        },
      };
    }),
  },
}));

import { PainelDoTelefone } from "./PainelDoTelefone";
import { TelefoniaProvider, useTelefonia } from "./TelefoniaContext";

function Discador() {
  const { pronto, ligar } = useTelefonia();
  return (
    <button type="button" disabled={!pronto} onClick={() => void ligar({ numero: "61995140098" })}>
      ligar
    </button>
  );
}

function pintar() {
  return render(
    <TelefoniaProvider>
      <Discador />
      <PainelDoTelefone />
    </TelefoniaProvider>,
  );
}

async function discarEAcabar(fim: { end_reason: string; answered_at?: string | null }) {
  pintar();
  const botao = await screen.findByRole("button", { name: "ligar" });
  await waitFor(() => expect(botao).toBeEnabled());
  await userEvent.click(botao);
  await screen.findByRole("region", { name: "Ligação em andamento" });
  // O Asterisk derruba o ramal ANTES de o worker gravar o motivo: a primeira
  // leitura depois do fim ainda vê a ligação viva.
  act(() => jssip.sessao!.emit("ended"));
  expect(screen.queryByRole("region", { name: "Ligação em andamento" })).toBeNull();
  api.estado = { status: "ended", end_reason: fim.end_reason, answered_at: fim.answered_at ?? null };
}

beforeEach(() => {
  api.estado = { status: "ringing", end_reason: null, answered_at: null };
  jssip.sessao = null;
});
afterEach(() => cleanup());

describe("o fim da saída na tela de quem discou", () => {
  it("a operadora recusou (nao_completada): o aviso pede para conferir o número e o prefixo", async () => {
    await discarEAcabar({ end_reason: "nao_completada_16" });
    const aviso = await screen.findByRole("status", {}, { timeout: 4_000 });
    expect(aviso).toHaveTextContent(
      "A operadora não completou a ligação. Confira o número e o prefixo de discagem do número SIP.",
    );
    expect(aviso).toHaveAttribute("data-telefonia", "aviso-do-fim");

    await userEvent.click(screen.getByRole("button", { name: "Fechar aviso" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ocupado tem frase própria", async () => {
    await discarEAcabar({ end_reason: "ocupado_17" });
    expect(await screen.findByRole("status", {}, { timeout: 4_000 })).toHaveTextContent("O número chamado está ocupado.");
  });

  it("quem desligou foi o próprio atendente: nenhum aviso", async () => {
    await discarEAcabar({ end_reason: "atendente_desligou" });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
