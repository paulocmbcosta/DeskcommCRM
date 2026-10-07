/**
 * O NAVEGADOR ATENDE SOZINHO O TOQUE QUE ELE PEDIU — E SÓ ESSE (fila visível,
 * entrega 3).
 *
 * "Atender", na aba Telefone, pede ao servidor que a ligação da fila toque no
 * ramal de quem clicou; o toque chega com o cabeçalho `X-Fila-Atender` e a ordem
 * que a rota devolveu, e o navegador atende sem um segundo clique.
 *
 * O risco é o outro lado: um toque atendido sem a pessoa pedir é um microfone
 * aberto sem aviso. Por isso a regra é medida NOS DOIS SENTIDOS, com o provider
 * de verdade, um JsSIP de mentira e o painel de verdade na tela:
 *
 *  - atende, sem clique, o toque que traz a ordem que ESTA aba guardou há menos
 *    de 15 s — e esse toque não toca (nem som, nem o aviso de ligação chegando);
 *  - NÃO atende: a ordem de outro, o toque sem ordem guardada (outra aba), o
 *    toque sem o cabeçalho (ligação comum, transferência, interna), o pedido
 *    vencido, o pedido recusado, a mesma ordem pela segunda vez, e o toque que
 *    chega com a pessoa já em ligação. Em todos, o caminho é o de sempre: a tela
 *    de toque, com o som, esperando o clique.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));
const avisos = vi.hoisted(() => ({ showApiError: vi.fn() }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: avisos.showApiError }));

interface SessaoDeMentira {
  emit(nome: string, ev?: unknown): void;
  answer: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}
interface UaDeMentira {
  /** Um INVITE chegando a este ramal, com os cabeçalhos dados; `preparar` mexe na sessão ANTES de o provider vê-la. */
  chegar(cabecalhos?: Record<string, string>, preparar?: (s: SessaoDeMentira) => void): SessaoDeMentira;
}
const jssip = vi.hoisted(() => ({ ua: null as UaDeMentira | null }));

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
    answer = vi.fn();
    terminate = vi.fn();
  }
  class UA extends Emissor {
    constructor() {
      super();
      jssip.ua = this as unknown as UaDeMentira;
    }
    start() {
      queueMicrotask(() => this.emit("registered"));
    }
    stop() {}
    register() {}
    chegar(cabecalhos: Record<string, string> = {}, preparar?: (s: Sessao) => void) {
      const s = new Sessao();
      preparar?.(s);
      this.emit("newRTCSession", {
        session: s,
        originator: "remote",
        request: {
          getHeader: (nome: string) => cabecalhos[nome],
          from: { display_name: "Cliente da Fila", uri: { user: "5561999990000" } },
        },
      });
      return s;
    }
  }
  class WebSocketInterface {}
  return { default: { UA, WebSocketInterface }, UA, WebSocketInterface };
});

const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: api.post, get: api.get } }));

import { CABECALHO_DO_ATENDER } from "@/lib/channels/telefonia/ordens-da-fila";

import { PainelDoTelefone } from "./PainelDoTelefone";
import { TelefoniaProvider, useTelefonia } from "./TelefoniaContext";

const LIGACAO = "0a0a0a0a-0000-4000-8000-00000000000a";
const ORDEM = "0b0b0b0b-0000-4000-8000-00000000000b";
const OUTRA_ORDEM = "0c0c0c0c-0000-4000-8000-00000000000c";
const AGORA = new Date("2026-10-07T12:00:00Z").getTime();
/** Como o JsSIP é chamado para atender — pelo clique e pelo atendimento automático. */
const COMO_SE_ATENDE = { mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: [] } };

/** O som de toque (`useToque`) abre um `AudioContext`: contar as aberturas é contar os toques. */
const som = { aberturas: 0 };
class AudioContextDeMentira {
  currentTime = 0;
  destination = {};
  constructor() {
    som.aberturas += 1;
  }
  createOscillator() {
    return { frequency: { value: 0 }, connect: () => ({ connect: () => undefined }), start: () => undefined, stop: () => undefined };
  }
  createGain() {
    return { gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined } };
  }
  close() {
    return Promise.resolve();
  }
}

function Sonda() {
  const { pronto, ligacao, atenderDaFila } = useTelefonia();
  const [resposta, setResposta] = useState("ainda não pediu");
  return (
    <>
      <button type="button" disabled={!pronto} onClick={() => void atenderDaFila(LIGACAO).then((r) => setResposta(String(r)))}>
        pedir para atender
      </button>
      <output data-testid="resposta">{resposta}</output>
      <output data-testid="fase">{ligacao?.fase ?? "sem ligação"}</output>
    </>
  );
}

async function montar() {
  render(
    <TelefoniaProvider>
      <Sonda />
      <PainelDoTelefone />
    </TelefoniaProvider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "pedir para atender" })).toBeEnabled());
}

/** O clique em "Atender" da fila, até a rota responder. */
async function pedir() {
  await userEvent.click(screen.getByRole("button", { name: "pedir para atender" }));
  await waitFor(() => expect(screen.getByTestId("resposta")).not.toHaveTextContent("ainda não pediu"));
}

function chegar(cabecalhos: Record<string, string> = {}, preparar?: (s: SessaoDeMentira) => void): SessaoDeMentira {
  let s: SessaoDeMentira | null = null;
  act(() => {
    s = jssip.ua!.chegar({ "X-Ligacao-Id": LIGACAO, ...cabecalhos }, preparar);
  });
  return s!;
}

const fase = () => screen.getByTestId("fase").textContent;
const telaDeToque = () => screen.queryByRole("alertdialog", { name: "Ligação recebida" });
const painel = () => screen.queryByRole("region", { name: "Ligação em andamento" });

/** O caminho de sempre: a tela de toque, com o som, e NINGUÉM atendeu pela pessoa. */
function tocouComoSempre(s: SessaoDeMentira) {
  expect(s.answer).not.toHaveBeenCalled();
  expect(fase()).toBe("tocando");
  expect(telaDeToque()).not.toBeNull();
  expect(painel()).toBeNull();
  expect(som.aberturas).toBe(1);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
  vi.clearAllMocks();
  jssip.ua = null;
  som.aberturas = 0;
  (window as unknown as { AudioContext: unknown }).AudioContext = AudioContextDeMentira;
  api.post.mockImplementation(async (url: string) => {
    if (url === "/api/v1/telefonia/ramal") {
      return { data: { ativo: true, usuario: "ramal-u1", senha: "s", ws_url: "wss://x/telefonia/ws", numeros: [] } };
    }
    if (url === `/api/v1/telefonia/chamadas/${LIGACAO}/atender`) return { data: { ordem_id: ORDEM } };
    throw new Error(`POST inesperado ${url}`);
  });
  api.get.mockImplementation(async (url: string) => {
    if (url !== `/api/v1/telefonia/chamadas/${LIGACAO}`) throw new Error(`GET inesperado ${url}`);
    return {
      data: {
        id: LIGACAO,
        status: "ringing",
        direction: "inbound",
        peer_phone: "+5561999990000",
        answered_at: null,
        ended_at: null,
        end_reason: null,
        conversation_id: "conv-da-fila",
        contact_id: "contato-1",
        contact_name: "Maria do Cadastro",
      },
    };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe("o pedido de atender uma ligação da fila", () => {
  it("vai à rota de atender DA LIGAÇÃO e devolve a ordem, para a tela acompanhar", async () => {
    await montar();
    await pedir();
    expect(api.post).toHaveBeenCalledWith(`/api/v1/telefonia/chamadas/${LIGACAO}/atender`, {});
    expect(screen.getByTestId("resposta")).toHaveTextContent(ORDEM);
    expect(avisos.showApiError).not.toHaveBeenCalled();
    // Pedir não é atender: nada toca nem conecta até o toque chegar.
    expect(fase()).toBe("sem ligação");
  });

  it("a recusa da rota vira o aviso com o motivo, e o pedido devolve `null`", async () => {
    const recusa = new Error("Você está em outra ligação.");
    api.post.mockImplementation(async (url: string) => {
      if (url === "/api/v1/telefonia/ramal") {
        return { data: { ativo: true, usuario: "ramal-u1", senha: "s", ws_url: "wss://x/telefonia/ws", numeros: [] } };
      }
      throw recusa;
    });
    await montar();
    await pedir();
    expect(screen.getByTestId("resposta")).toHaveTextContent("null");
    expect(avisos.showApiError).toHaveBeenCalledWith(recusa);
  });

  it("o nome do cabeçalho é o combinado com o worker", () => {
    // O worker escreve este nome no INVITE (`PJSIP_HEADER(add,X-Fila-Atender)`):
    // trocar a constante sem trocar o worker faria o toque chegar como comum.
    expect(CABECALHO_DO_ATENDER).toBe("X-Fila-Atender");
  });
});

describe("o toque que ESTE navegador pediu é atendido sozinho", () => {
  it("com a ordem guardada, o toque com o cabeçalho da MESMA ordem é atendido sem clique — e não toca", async () => {
    await montar();
    await pedir();
    const s = chegar({ "X-Fila-Atender": ORDEM });

    expect(s.answer).toHaveBeenCalledTimes(1);
    expect(s.answer).toHaveBeenCalledWith(COMO_SE_ATENDE);
    // Nasce "atendendo": o painel de baixo, com "Conectando…" — nunca a tela de toque.
    expect(fase()).toBe("atendendo");
    expect(telaDeToque()).toBeNull();
    expect(painel()).toHaveAttribute("data-telefonia", "atendendo");
    expect(painel()).toHaveTextContent("Recebida · Conectando…");
    // E sem o som de toque: quem pediu não precisa ser chamado.
    expect(som.aberturas).toBe(0);
  });

  it("faltando um instante para o prazo (14,9 s), ainda atende", async () => {
    await montar();
    await pedir();
    vi.setSystemTime(AGORA + 14_900);
    const s = chegar({ "X-Fila-Atender": ORDEM });
    expect(s.answer).toHaveBeenCalledTimes(1);
    expect(fase()).toBe("atendendo");
  });

  it("quando a sessão confirma, vira `em_ligacao`, como qualquer recebida", async () => {
    await montar();
    await pedir();
    const s = chegar({ "X-Fila-Atender": ORDEM });
    act(() => s.emit("confirmed"));
    expect(fase()).toBe("em_ligacao");
    expect(painel()).toHaveAttribute("data-telefonia", "em_ligacao");
  });

  it("quando a sessão falha (microfone negado, o cliente desligou), limpa como hoje", async () => {
    await montar();
    await pedir();
    const s = chegar({ "X-Fila-Atender": ORDEM });
    act(() => s.emit("failed", { cause: "User Denied Media Access" }));
    expect(fase()).toBe("sem ligação");
    expect(painel()).toBeNull();
    expect(telaDeToque()).toBeNull();
  });

  it("a leitura da ligação continua valendo: o nome do contato e a conversa chegam ao painel", async () => {
    await montar();
    await pedir();
    chegar({ "X-Fila-Atender": ORDEM });
    expect(await screen.findByText("Maria do Cadastro")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir a conversa" })).toHaveAttribute("href", "/app/inbox?id=conv-da-fila");
    expect(api.get).toHaveBeenCalledWith(`/api/v1/telefonia/chamadas/${LIGACAO}`);
    expect(fase()).toBe("atendendo");
  });

  it("enquanto conecta, a leitura se REPETE (a tela de toque lê uma vez só)", async () => {
    await montar();
    await pedir();
    chegar({ "X-Fila-Atender": ORDEM });
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 4_000 });
    expect(fase()).toBe("atendendo");
  });

  it("CONTROLE — a tela de toque lê a ligação uma vez, e não de novo", async () => {
    await montar();
    chegar();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 1_800));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(fase()).toBe("tocando");
  });

  it("se o JsSIP recusar o atendimento na hora, o toque cai na tela de sempre — nunca fica preso em 'Conectando…'", async () => {
    await montar();
    await pedir();
    // A sessão já nasce recusando `answer` (o `InvalidStateError` do JsSIP).
    const s = chegar({ "X-Fila-Atender": ORDEM }, (sessao) =>
      sessao.answer.mockImplementation(() => {
        throw new Error("InvalidStateError");
      }),
    );
    expect(s.answer).toHaveBeenCalledTimes(1);
    expect(fase()).toBe("tocando");
    expect(telaDeToque()).not.toBeNull();
    expect(som.aberturas).toBe(1);
  });
});

describe("NENHUM outro toque é atendido pela pessoa", () => {
  it("o cabeçalho de OUTRA ordem (a que um colega pediu) — mesmo com um pedido meu guardado", async () => {
    await montar();
    await pedir();
    tocouComoSempre(chegar({ "X-Fila-Atender": OUTRA_ORDEM }));
  });

  it("sem pedido guardado (o clique foi em outra aba), o toque com o cabeçalho é o de sempre", async () => {
    await montar();
    tocouComoSempre(chegar({ "X-Fila-Atender": ORDEM }));
  });

  it.each([
    ["a ligação comum do rodízio (sem cabeçalho nenhum)", {}],
    ["a transferência chegando", { "X-Transferencia": "transf" }],
    ["a que eu transferi e voltou", { "X-Transferencia": "volta" }],
    ["a consulta de um colega", { "X-Transferencia": "consulta" }],
    ["a ligação interna", { "X-Interna-De": "u-colega" }],
    ["o cabeçalho vazio", { "X-Fila-Atender": "" }],
  ] as Array<[string, Record<string, string>]>)("com um pedido guardado, %s NÃO é atendida sozinha", async (_caso, cabecalhos) => {
    await montar();
    await pedir();
    tocouComoSempre(chegar(cabecalhos));
  });

  it("o pedido vence em 15 s: o toque que chega depois é o de sempre", async () => {
    await montar();
    await pedir();
    vi.setSystemTime(AGORA + 15_000);
    tocouComoSempre(chegar({ "X-Fila-Atender": ORDEM }));
  });

  it("o pedido que a rota recusou não guarda nada", async () => {
    api.post.mockImplementation(async (url: string) => {
      if (url === "/api/v1/telefonia/ramal") {
        return { data: { ativo: true, usuario: "ramal-u1", senha: "s", ws_url: "wss://x/telefonia/ws", numeros: [] } };
      }
      throw new Error("Outra pessoa já está cuidando desta ligação.");
    });
    await montar();
    await pedir();
    tocouComoSempre(chegar({ "X-Fila-Atender": ORDEM }));
  });

  it("a resposta da rota sem a ordem não guarda nada", async () => {
    api.post.mockImplementation(async (url: string) => {
      if (url === "/api/v1/telefonia/ramal") {
        return { data: { ativo: true, usuario: "ramal-u1", senha: "s", ws_url: "wss://x/telefonia/ws", numeros: [] } };
      }
      return { data: {} };
    });
    await montar();
    await pedir();
    expect(screen.getByTestId("resposta")).toHaveTextContent("null");
    tocouComoSempre(chegar({ "X-Fila-Atender": "undefined" }));
  });

  it("a ordem vale UMA vez: o segundo toque com o mesmo cabeçalho é o de sempre", async () => {
    await montar();
    await pedir();
    const primeira = chegar({ "X-Fila-Atender": ORDEM });
    expect(primeira.answer).toHaveBeenCalledTimes(1);
    act(() => primeira.emit("ended"));
    expect(fase()).toBe("sem ligação");

    tocouComoSempre(chegar({ "X-Fila-Atender": ORDEM }));
  });

  it("já em ligação: o toque com a ordem certa é recusado (ocupado) como qualquer segundo toque, e a ligação em curso não muda", async () => {
    await montar();
    const emCurso = chegar();
    act(() => emCurso.emit("confirmed"));
    expect(fase()).toBe("em_ligacao");
    await pedir();

    const segunda = chegar({ "X-Fila-Atender": ORDEM });
    expect(segunda.answer).not.toHaveBeenCalled();
    expect(segunda.terminate).toHaveBeenCalledWith({ status_code: 486, reason_phrase: "Busy Here" });
    expect(fase()).toBe("em_ligacao");
  });
});

describe("CONTROLE — atender pelo clique segue igual", () => {
  it("a tela de toque atende com o clique em Atender, do mesmo jeito que o atendimento automático", async () => {
    await montar();
    const s = chegar();
    tocouComoSempre(s);
    await userEvent.click(screen.getByRole("button", { name: "Atender" }));
    expect(s.answer).toHaveBeenCalledTimes(1);
    expect(s.answer).toHaveBeenCalledWith(COMO_SE_ATENDE);
  });

  it("sem o provider do telefone, pedir para atender não faz nada e devolve `null`", async () => {
    // Fora do provider vale o contexto padrão: quem o chama recebe "não deu", sem pedido nenhum.
    function Direto() {
      const { atenderDaFila } = useTelefonia();
      const [r, setR] = useState("…");
      return (
        <button type="button" onClick={() => void atenderDaFila(LIGACAO).then((v) => setR(String(v)))}>
          direto {r}
        </button>
      );
    }
    render(<Direto />);
    await userEvent.click(screen.getByRole("button", { name: /direto/ }));
    expect(await screen.findByRole("button", { name: "direto null" })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
