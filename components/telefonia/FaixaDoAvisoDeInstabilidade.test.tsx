/**
 * A FAIXA DO AVISO DE INSTABILIDADE (desenho da fase 2, §6.4), medida pelo que a
 * pessoa vê e pelo que a tela pergunta à API.
 *
 * O `apiClient` é o de VERDADE, sobre um `fetch` simulado que responde como a
 * rota `GET /api/v1/telefonia/emergencias` responde: `{ oferecida, pode_mudar,
 * ligados, times }`. A faixa lê `ligados` (o que QUALQUER membro recebe) e mostra
 * o "Desligar" só com `pode_mudar` — a mesma régua das escritas, decidida pela
 * sessão no servidor.
 *
 * O que se prova:
 *  - todo membro vê o time e a HORA LOCAL em que o aviso desliga; o atendente,
 *    sem botão; o time arquivado ganha o selo;
 *  - gerente desliga pela faixa e ela some sem recarregar; a recusa diz a frase
 *    da rota, e o 504 de um proxy nunca chega à tela como HTML;
 *  - custo: instalação sem telefonia ou pessoa sem organização não perguntam
 *    nada; relê a cada minuto e ao voltar o foco; o prazo vencido relê na hora;
 *  - a leitura que falha não quebra nada nem deixa na tela uma faixa que não
 *    pode mais ser confirmada.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";
import type { AvisoNaFaixa, AvisosNaResposta } from "@/lib/telefonia/vocabulario";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
const avisos = vi.hoisted(() => ({ sucesso: vi.fn(), erro: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: avisos.sucesso, error: avisos.erro } }));

const sessao = vi.hoisted(() => ({ comOrganizacao: true }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", is_platform_admin: false, support: null },
    activeOrg: sessao.comOrganizacao ? { orgId: "o1", name: "Org", role: "agent" } : null,
  }),
}));

import { FaixaDoAvisoDeInstabilidade } from "./FaixaDoAvisoDeInstabilidade";

const URL_DOS_AVISOS = "/api/v1/telefonia/emergencias";
/** A faixa pede SÓ a faixa: a leitura completa do gerente (com nome pedido à Auth) não é dela. */
const URL_DA_FAIXA = `${URL_DOS_AVISOS}?so=ligados`;
const HTML_DO_PROXY = "<html><body><h1>504 Gateway Time-out</h1><p>nginx</p></body></html>";
/** Meio-dia no fuso da máquina: "hoje" não vira "amanhã" no meio do teste. */
const AGORA = new Date(2026, 8, 29, 12, 0, 0);
const hora = (h: number, m: number) => new Date(2026, 8, 29, h, m, 0).toISOString();

// ─── O servidor simulado ─────────────────────────────────────────────────────

let servidor: AvisosNaResposta;
type Rota = () => Response | Promise<Response>;
const trocadas = new Map<string, Rota>();

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
}
const recusa = (status: number, code: string, message: string) => json(status, { error: { code, message } });

function aviso(extra: Partial<AvisoNaFaixa> = {}): AvisoNaFaixa {
  return { team_id: "t1", time_nome: "Suporte", expira_em: hora(14, 5), arquivado: false, ...extra };
}

const fetchFalso = vi.fn(async (url: string, init: RequestInit = {}) => {
  const metodo = init.method ?? "GET";
  const trocada = trocadas.get(`${metodo} ${url}`);
  if (trocada) return trocada();
  if (metodo === "GET" && url === URL_DA_FAIXA) return json(200, { data: structuredClone(servidor) });
  const desligar = /^\/api\/v1\/telefonia\/emergencias\/([^/]+)$/.exec(url);
  if (metodo === "DELETE" && desligar) {
    const antes = servidor.ligados.length;
    servidor.ligados = servidor.ligados.filter((a) => a.team_id !== desligar[1]);
    return json(200, { data: { desligado: servidor.ligados.length < antes } });
  }
  throw new Error(`rota inesperada: ${metodo} ${url}`);
});

const leituras = () => fetchFalso.mock.calls.filter(([u, i]) => u === URL_DA_FAIXA && (i?.method ?? "GET") === "GET").length;

// ─── A tela ──────────────────────────────────────────────────────────────────

function pintar({ oferecida = true }: { oferecida?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <FaixaDoAvisoDeInstabilidade oferecida={oferecida} />
    </QueryClientProvider>,
  );
  return qc;
}

const usuario = () => userEvent.setup({ delay: null });
const faixa = () => document.querySelector("[data-faixa-aviso-de-instabilidade]");
/** Espera a faixa visível — a região viva (`role="status"`) existe sempre, vazia sem aviso. */
const acharFaixa = () =>
  waitFor(() => {
    const f = faixa();
    expect(f).not.toBeNull();
    return f as HTMLElement;
  });
const regiao = () => screen.queryByRole("status");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: AGORA });
  trocadas.clear();
  fetchFalso.mockClear();
  avisos.sucesso.mockClear();
  avisos.erro.mockClear();
  vi.stubGlobal("fetch", fetchFalso);
  sessao.comOrganizacao = true;
  servidor = { oferecida: true, pode_mudar: false, ligados: [aviso()], times: null };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("faixa do aviso de instabilidade — o que cada um vê", () => {
  it("atendente vê o time e a hora local em que o aviso desliga, mas não o botão", async () => {
    pintar();
    const f = await acharFaixa();
    expect(regiao()).toContainElement(f);
    expect(f).toHaveTextContent("Aviso de instabilidade ligado no telefone do Suporte");
    expect(f).toHaveTextContent("desliga às 14:05");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("aviso sem prazo diz 'até alguém desligar'; o de time arquivado ganha o selo", async () => {
    servidor.ligados = [
      aviso({ team_id: "t1", time_nome: "Suporte", expira_em: null }),
      aviso({ team_id: "t2", time_nome: "Vendas", arquivado: true }),
    ];
    pintar();
    const f = await acharFaixa();
    const suporte = f.querySelector('[data-aviso-na-faixa="t1"]') as HTMLElement;
    const vendas = f.querySelector('[data-aviso-na-faixa="t2"]') as HTMLElement;
    expect(suporte).toHaveTextContent("até alguém desligar");
    expect(suporte.querySelector("[data-time-arquivado]")).toBeNull();
    expect(vendas).toHaveTextContent("Aviso de instabilidade ligado no telefone do Vendas");
    expect(vendas.querySelector("[data-time-arquivado]")).toHaveTextContent("Time arquivado");
  });

  it("o prazo de outro dia leva a data junto da hora", async () => {
    servidor.ligados = [aviso({ expira_em: new Date(2026, 8, 30, 1, 30, 0).toISOString() })];
    pintar();
    expect(await acharFaixa()).toHaveTextContent("desliga às 30/09 01:30");
  });

  it("sem aviso ligado, nada aparece — mas a região viva já está montada, vazia, para anunciar o aviso que chegar", async () => {
    servidor.ligados = [];
    pintar();
    await waitFor(() => expect(leituras()).toBe(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(faixa()).toBeNull();
    expect(regiao()).toHaveAttribute("aria-live", "polite");
    expect(regiao()).toBeEmptyDOMElement();
  });

  it("a frase vem inteira do dicionário, com o nome e a hora no lugar do marcador (o espanhol também)", async () => {
    for (const [chave, marcador] of [
      ["Aviso de instabilidade ligado no telefone do {time}", "{time}"],
      ["desliga às {hora}", "{hora}"],
      ["Ligado às {hora}", "{hora}"],
      ["Ligado às {hora} por {nome}", "{nome}"],
    ] as const) {
      expect(traduzir(chave, "es"), chave).not.toBe(chave);
      expect(traduzir(chave, "es"), chave).toContain(marcador);
    }
    pintar();
    const f = await acharFaixa();
    expect(f.textContent).not.toMatch(/\{(time|hora)\}/);
  });
});

describe("faixa do aviso de instabilidade — gerente e admin desligam por ela", () => {
  beforeEach(() => {
    servidor.pode_mudar = true;
  });

  it("desliga pela faixa, e ela some sem recarregar", async () => {
    pintar();
    await usuario().click(await screen.findByRole("button", { name: "Desligar o aviso do time Suporte" }));
    expect(fetchFalso).toHaveBeenCalledWith(`${URL_DOS_AVISOS}/t1`, expect.objectContaining({ method: "DELETE" }));
    await waitFor(() => expect(faixa()).toBeNull());
    expect(avisos.sucesso).toHaveBeenCalledWith("Aviso de instabilidade desligado.");
  });

  it("o aviso já tinha sido desligado por outra pessoa: diz isso, e a faixa some", async () => {
    trocadas.set(`DELETE ${URL_DOS_AVISOS}/t1`, () => {
      servidor.ligados = [];
      return json(200, { data: { desligado: false } });
    });
    pintar();
    await usuario().click(await screen.findByRole("button", { name: "Desligar o aviso do time Suporte" }));
    await waitFor(() => expect(faixa()).toBeNull());
    expect(avisos.sucesso).toHaveBeenCalledWith("O aviso de instabilidade já estava desligado.");
  });

  it("a recusa da rota chega com a frase dela, e a faixa fica", async () => {
    trocadas.set(`DELETE ${URL_DOS_AVISOS}/t1`, () =>
      recusa(409, "gravacao_em_andamento", "Este time está sendo alterado por outra pessoa agora. Tente de novo em instantes."),
    );
    pintar();
    await usuario().click(await screen.findByRole("button", { name: "Desligar o aviso do time Suporte" }));
    await waitFor(() =>
      expect(avisos.erro).toHaveBeenCalledWith("Este time está sendo alterado por outra pessoa agora. Tente de novo em instantes."),
    );
    expect(faixa()).not.toBeNull();
  });

  it("o 504 de um proxy vira a frase genérica — nunca o HTML dele", async () => {
    trocadas.set(`DELETE ${URL_DOS_AVISOS}/t1`, () => new Response(HTML_DO_PROXY, { status: 504, headers: { "Content-Type": "text/html" } }));
    pintar();
    await usuario().click(await screen.findByRole("button", { name: "Desligar o aviso do time Suporte" }));
    await waitFor(() => expect(avisos.erro).toHaveBeenCalledWith("Não foi possível desligar o aviso. Tente de novo em instantes."));
    expect(JSON.stringify(avisos.erro.mock.calls)).not.toContain("nginx");
  });
});

describe("faixa do aviso de instabilidade — quanto ela custa e como falha", () => {
  it("instalação sem telefonia: não pergunta nada à API, nem monta a região viva", async () => {
    pintar({ oferecida: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(fetchFalso).not.toHaveBeenCalled();
    expect(faixa()).toBeNull();
    expect(regiao()).toBeNull();
  });

  it.each([
    [401, "unauthenticated", "Auth required."],
    [403, "forbidden_role", "Permissão insuficiente."],
  ])("a leitura recusada com %i: o relógio do minuto para, mas a volta do foco ainda relê", async (status, code, message) => {
    trocadas.set(`GET ${URL_DA_FAIXA}`, () => recusa(status, code, message));
    pintar();
    await waitFor(() => expect(leituras()).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(121_000);
    });
    expect(leituras()).toBe(1);
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(leituras()).toBe(2));
    expect(faixa()).toBeNull();
  });

  it("um 401 passageiro (a Auth piscou): a volta do foco relê, a leitura boa traz a faixa e religa o relógio do minuto", async () => {
    trocadas.set(`GET ${URL_DA_FAIXA}`, () => recusa(401, "unauthenticated", "Auth required."));
    pintar();
    await waitFor(() => expect(leituras()).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(leituras()).toBe(1);

    // A Auth voltou. A pessoa volta à aba: a leitura boa traz a faixa.
    trocadas.clear();
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await acharFaixa();
    expect(leituras()).toBe(2);

    // E o relógio do minuto voltou: o aviso desligado em outra aba sai daqui sozinho.
    servidor.ligados = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    await waitFor(() => expect(leituras()).toBe(3));
    await waitFor(() => expect(faixa()).toBeNull());
  });

  it("um prazo distante (30 dias) não dispara a releitura na hora: o relógio respeita o teto do setTimeout", async () => {
    servidor.ligados = [aviso({ expira_em: new Date(AGORA.getTime() + 30 * 86_400_000).toISOString() })];
    pintar();
    await acharFaixa();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(leituras()).toBe(1);
  });

  it("sem organização ativa: não pergunta nada à API", async () => {
    sessao.comOrganizacao = false;
    pintar();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("relê a cada minuto: o aviso ligado em outra aba aparece sem recarregar", async () => {
    servidor.ligados = [];
    pintar();
    await waitFor(() => expect(leituras()).toBe(1));
    servidor.ligados = [aviso()];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(leituras()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(leituras()).toBe(2));
    expect(await acharFaixa()).toHaveTextContent("Suporte");
  });

  it("relê ao voltar o foco", async () => {
    servidor.ligados = [];
    pintar();
    await waitFor(() => expect(leituras()).toBe(1));
    servidor.ligados = [aviso()];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(leituras()).toBe(1);
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(leituras()).toBe(2));
    expect(await acharFaixa()).toHaveTextContent("Suporte");
  });

  it("o prazo passou: relê na hora e a faixa some, sem esperar o minuto", async () => {
    servidor.ligados = [aviso({ expira_em: new Date(AGORA.getTime() + 5_000).toISOString() })];
    pintar();
    await acharFaixa();
    // A passada do worker desligou o aviso no banco; a leitura seguinte já não o traz.
    servidor.ligados = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    await waitFor(() => expect(faixa()).toBeNull());
    expect(leituras()).toBe(2);
  });

  it("a leitura falhou: nada aparece, e nada quebra", async () => {
    trocadas.set(`GET ${URL_DA_FAIXA}`, () => new Response(HTML_DO_PROXY, { status: 504, headers: { "Content-Type": "text/html" } }));
    pintar();
    await waitFor(() => expect(leituras()).toBe(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(faixa()).toBeNull();
    expect(document.body.textContent).not.toContain("nginx");
  });

  it.each([
    ["500 da rota", () => recusa(500, "internal_error", "Erro interno.")],
    ["504 de um proxy, com HTML", () => new Response(HTML_DO_PROXY, { status: 504, headers: { "Content-Type": "text/html" } })],
  ])(
    "a PRIMEIRA leitura falhou (%s): a releitura de um minuto recupera a faixa, sem troca de foco",
    async (_caso, falha) => {
      trocadas.set(`GET ${URL_DA_FAIXA}`, falha);
      pintar();
      await waitFor(() => expect(leituras()).toBe(1));
      await act(async () => {
        await Promise.resolve();
      });
      expect(faixa()).toBeNull();
      expect(document.body.textContent).not.toContain("nginx");

      // A API voltou. Nenhum evento de foco: só o relógio.
      trocadas.clear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      await waitFor(() => expect(leituras()).toBe(2));
      expect(await acharFaixa()).toHaveTextContent("Aviso de instabilidade ligado no telefone do Suporte");
    },
  );

  it("a releitura falhou com o aviso na tela: a faixa sai, em vez de afirmar o que não dá mais para confirmar", async () => {
    const qc = pintar();
    await acharFaixa();
    trocadas.set(`GET ${URL_DA_FAIXA}`, () => recusa(500, "internal_error", "Erro interno."));
    await act(async () => {
      await qc.invalidateQueries();
    });
    await waitFor(() => expect(faixa()).toBeNull());
  });
});
