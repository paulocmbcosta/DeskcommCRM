/**
 * O CARTÃO "FILA DO TELEFONE" EM CONFIGURAÇÕES › TIMES (migration 0295), medido
 * pelo que a pessoa vê e pelo que a tela manda à API.
 *
 * O `apiClient` é o de VERDADE, sobre um `fetch` simulado que responde como as
 * rotas respondem: o GET com `{ oferecida, times }` e o PUT com `{ time }` — ou a
 * recusa `{ error: { code, message } }`.
 *
 * O que se prova:
 *  - o seletor mostra o que VALE: o padrão ("2 minutos — padrão") ou o configurado;
 *  - trocar o valor grava na hora, em segundos; escolher o padrão manda `null`;
 *  - enquanto grava, o seletor trava e mostra o escolhido; a recusa vira aviso com
 *    a frase da rota, e o seletor volta ao que vale;
 *  - um valor fora das opções aparece como opção a mais, em segundos;
 *  - sem telefonia, ou para um time que não veio na leitura, nada aparece; a
 *    leitura que falha sem dado vira a mensagem.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EsperaDoTime, EsperaDosTimesNaResposta } from "@/lib/telefonia/espera-do-time";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
const avisos = vi.hoisted(() => ({ sucesso: vi.fn(), erro: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: avisos.sucesso, error: avisos.erro, warning: avisos.erro, info: avisos.erro } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "o1", name: "Org", role: "manager" },
  }),
}));

import { EsperaMaximaDoTime } from "./EsperaMaximaDoTime";

const URL_DA_ESPERA = "/api/v1/telefonia/fila/times";
const URL_DO_TIME = `${URL_DA_ESPERA}/t1`;

// ─── O servidor simulado ─────────────────────────────────────────────────────

let servidor: EsperaDosTimesNaResposta;
type Rota = (corpo: Record<string, unknown>) => Response | Promise<Response>;
const trocadas = new Map<string, Rota>();

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
}
const dados = (d: unknown) => json(200, { data: d });
/** A recusa como `fail()` a escreve: `{ error: { code, message } }`. */
const recusa = (status: number, code: string, message: string) => json(status, { error: { code, message } });

const doTime = (espera: number | null): EsperaDoTime => ({ team_id: "t1", espera_maxima_s: espera, em_vigor_s: espera ?? 120 });

function rotaPadrao(metodo: string, url: string): Rota | null {
  if (metodo === "GET" && url === URL_DA_ESPERA) return () => dados(structuredClone(servidor));
  if (metodo === "PUT" && url === URL_DO_TIME) {
    return (c) => {
      const time = doTime(c.espera_maxima_s as number | null);
      servidor.times = servidor.times.map((x) => (x.team_id === "t1" ? time : x));
      return dados({ time });
    };
  }
  return null;
}

const fetchFalso = vi.fn(async (url: string, init: RequestInit = {}) => {
  const metodo = init.method ?? "GET";
  const corpo = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const rota = trocadas.get(`${metodo} ${url}`) ?? rotaPadrao(metodo, url);
  if (!rota) throw new Error(`rota inesperada: ${metodo} ${url}`);
  return rota(corpo);
});

/** Os corpos que a tela mandou a uma rota. */
function enviados(metodo: string, url: string): unknown[] {
  return fetchFalso.mock.calls
    .filter(([u, i]) => u === url && (i?.method ?? "GET") === metodo)
    .map(([, i]) => (typeof i?.body === "string" ? JSON.parse(i.body) : undefined));
}

/** Uma resposta que só sai quando o teste mandar — para ver a tela NO MEIO do pedido. */
function segurada(): { rota: Rota; soltar: (r: Response) => void } {
  let soltar: (r: Response) => void = () => undefined;
  const pendente = new Promise<Response>((res) => {
    soltar = res;
  });
  return { rota: () => pendente, soltar: (r) => soltar(r) };
}

// ─── A tela ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  // Radix Select usa pointer capture e scrollIntoView; o jsdom não implementa nenhum dos dois.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

/** Radix em jsdom é caro, e o custo varia com a carga da máquina (ver VozEFalas.test.tsx). */
const TETO_MS = 30_000;
const usuario = () => userEvent.setup({ delay: null });

function pintar(teamId = "t1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <EsperaMaximaDoTime teamId={teamId} />
    </QueryClientProvider>,
  );
}

const cartao = async () => {
  await waitFor(() => expect(document.querySelector('[data-espera-da-fila="t1"]')).not.toBeNull());
  return document.querySelector('[data-espera-da-fila="t1"]') as HTMLElement;
};
const seletorDe = (c: HTMLElement) => within(c).getByRole("combobox", { name: "Espera máxima" });

/** Abre o seletor e escolhe a opção pelo rótulo. */
async function escolher(c: HTMLElement, opcao: string) {
  const u = usuario();
  await u.click(seletorDe(c));
  await u.click(await screen.findByRole("option", { name: opcao }));
}

beforeEach(() => {
  trocadas.clear();
  fetchFalso.mockClear();
  avisos.sucesso.mockClear();
  avisos.erro.mockClear();
  vi.stubGlobal("fetch", fetchFalso);
  servidor = { oferecida: true, times: [doTime(null), { team_id: "t2", espera_maxima_s: 900, em_vigor_s: 900 }] };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("o cartão da fila do telefone do time", () => {
  it("sem configuração, mostra o padrão; e diz o que a espera faz", async () => {
    pintar();
    const c = await cartao();
    expect(seletorDe(c)).toHaveTextContent("2 minutos — padrão");
    expect(c).toHaveTextContent("Fila do telefone");
    expect(c).toHaveTextContent('Depois disso a ligação cai e vira "Ligar de volta" na Central.');
  });

  it("com a espera configurada, mostra o que VALE para ESTE time — não o do vizinho", async () => {
    servidor.times = [doTime(300), { team_id: "t2", espera_maxima_s: 900, em_vigor_s: 900 }];
    pintar();
    expect(seletorDe(await cartao())).toHaveTextContent("5 minutos");
  });

  it(
    "as opções são 2, 5, 10, 15, 20 e 30 minutos, com o padrão marcado",
    async () => {
      pintar();
      await usuario().click(seletorDe(await cartao()));
      const opcoes = (await screen.findAllByRole("option")).map((o) => o.textContent);
      expect(opcoes).toEqual(["2 minutos — padrão", "5 minutos", "10 minutos", "15 minutos", "20 minutos", "30 minutos"]);
    },
    TETO_MS,
  );

  it(
    "trocar para 10 minutos grava na hora, em segundos, e o seletor passa a mostrá-lo",
    async () => {
      pintar();
      const c = await cartao();
      await escolher(c, "10 minutos");
      await waitFor(() => expect(enviados("PUT", URL_DO_TIME)).toEqual([{ espera_maxima_s: 600 }]));
      await waitFor(() => expect(avisos.sucesso).toHaveBeenCalledWith("Espera máxima do telefone salva."));
      await waitFor(() => expect(seletorDe(c)).toHaveTextContent("10 minutos"));
      await waitFor(() => expect(seletorDe(c)).toBeEnabled());
    },
    TETO_MS,
  );

  it(
    "escolher o padrão manda `null` — o time volta a seguir o padrão do produto",
    async () => {
      servidor.times = [doTime(600)];
      pintar();
      const c = await cartao();
      expect(seletorDe(c)).toHaveTextContent("10 minutos");
      await escolher(c, "2 minutos — padrão");
      await waitFor(() => expect(enviados("PUT", URL_DO_TIME)).toEqual([{ espera_maxima_s: null }]));
      await waitFor(() => expect(seletorDe(c)).toHaveTextContent("2 minutos — padrão"));
    },
    TETO_MS,
  );

  it(
    "enquanto grava, o seletor trava e mostra o escolhido; quando a resposta chega, destrava",
    async () => {
      const put = segurada();
      trocadas.set(`PUT ${URL_DO_TIME}`, put.rota);
      pintar();
      const c = await cartao();
      await escolher(c, "15 minutos");
      await waitFor(() => expect(seletorDe(c)).toBeDisabled());
      expect(seletorDe(c)).toHaveTextContent("15 minutos");

      servidor.times = [doTime(900)];
      put.soltar(dados({ time: doTime(900) }));
      await waitFor(() => expect(seletorDe(c)).toBeEnabled());
      expect(seletorDe(c)).toHaveTextContent("15 minutos");
    },
    TETO_MS,
  );

  it(
    "a recusa da rota vira aviso com a frase dela, e o seletor volta ao que vale",
    async () => {
      trocadas.set(`PUT ${URL_DO_TIME}`, () => recusa(409, "time_arquivado", "Este time está arquivado."));
      pintar();
      const c = await cartao();
      await escolher(c, "20 minutos");
      await waitFor(() => expect(avisos.erro).toHaveBeenCalled());
      expect(avisos.erro.mock.calls[0]![0]).toBe("Este time está arquivado.");
      expect(avisos.sucesso).not.toHaveBeenCalled();
      await waitFor(() => expect(seletorDe(c)).toBeEnabled());
      expect(seletorDe(c)).toHaveTextContent("2 minutos — padrão");
    },
    TETO_MS,
  );

  it(
    "um valor fora das opções (gravado por outro caminho) aparece como opção a mais, em segundos",
    async () => {
      servidor.times = [doTime(45)];
      pintar();
      const c = await cartao();
      expect(seletorDe(c)).toHaveTextContent("45 segundos");
      await usuario().click(seletorDe(c));
      const opcoes = (await screen.findAllByRole("option")).map((o) => o.textContent);
      expect(opcoes[0]).toBe("45 segundos");
      expect(opcoes).toHaveLength(7);
    },
    TETO_MS,
  );
});

describe("quando o cartão não aparece", () => {
  it("telefonia não oferecida nesta instalação: nada na tela — quem decide é `oferecida`, não a lista", async () => {
    // A rota manda a lista vazia; com o time nela, fica provado que é a marca que esconde o cartão.
    servidor = { oferecida: false, times: [doTime(null)] };
    pintar();
    await waitFor(() => expect(enviados("GET", URL_DA_ESPERA)).toHaveLength(1));
    // Dá tempo de a resposta chegar à tela antes de afirmar a ausência.
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector("[data-espera-da-fila]")).toBeNull();
  });

  it("o time que não veio na leitura (arquivado): nada na tela", async () => {
    pintar("t9");
    await waitFor(() => expect(enviados("GET", URL_DA_ESPERA)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector("[data-espera-da-fila]")).toBeNull();
  });

  it("a leitura que falha sem dado na tela vira a mensagem — sem seletor", async () => {
    trocadas.set(`GET ${URL_DA_ESPERA}`, () => recusa(500, "internal_error", "boom"));
    pintar();
    const c = await cartao();
    expect(c).toHaveAttribute("data-falha-da-leitura");
    expect(c).toHaveTextContent("Não foi possível carregar a espera da fila do telefone. Recarregue a página.");
    expect(within(c).queryByRole("combobox")).toBeNull();
  });
});
