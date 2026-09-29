/**
 * O CARTÃO DO AVISO DE INSTABILIDADE EM CONFIGURAÇÕES › TIMES, e a janela de
 * ligar (desenho da fase 2, §4 e §6.3), medidos pelo que a pessoa vê e pelo que a
 * tela manda à API.
 *
 * O `apiClient` é o de VERDADE, sobre um `fetch` simulado que responde como as
 * rotas respondem: o GET com `{ oferecida, pode_mudar, ligados, times }`, a
 * prévia (`POST /api/v1/telefonia/falas/previa`), o PUT que liga (`{ aviso }`) e o
 * DELETE que desliga (`{ desligado }`). Cada falha chega na forma que o cliente
 * entrega: o corpo `{ error: { code, message } }` das nossas rotas e o 504 de um
 * proxy com HTML, cuja "mensagem" o cliente inventa e a tela não pode mostrar.
 *
 * O que se prova:
 *  - texto novo: "Ligar" só destrava depois de "Gerar prévia" E "Ouvir", e manda
 *    o hash da prévia OUVIDA; editar o texto depois disso trava de novo;
 *  - o texto já gravado, sem mudança: liga direto, com o hash dele, sem prévia;
 *  - a duração escolhida vai no pedido; ligado, o cartão diz quando, por quem e
 *    até quando (hora local), e "Desligar agora" o devolve a desligado;
 *  - recusa do ligar com a frase da rota (e a prévia que o servidor não achou
 *    sai da tela); 504 de proxy vira a frase genérica;
 *  - os botões seguem `pode_mudar`; sem telefonia ou sem a lista, nada aparece;
 *  - enquanto liga, o campo e "Gerar prévia" travam; enquanto gera, "Ligar" trava.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TEXTO_SUGERIDO } from "@/lib/telefonia/texto-do-menu";
import type { DuracaoDaEmergencia } from "@/lib/telefonia/vencimento-da-emergencia";
import {
  MENSAGEM_DA_FALHA_DA_FALA,
  type AvisoDoTimePublico,
  type AvisosNaResposta,
  type FalaPublica,
} from "@/lib/telefonia/vocabulario";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
const avisos = vi.hoisted(() => ({ sucesso: vi.fn(), erro: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: avisos.sucesso, error: avisos.erro } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "o1", name: "Org", role: "manager" },
  }),
}));
// Os tocadores têm teste próprio. O "Ouvir" de verdade toca o áudio; aqui basta que
// ele avise que a pessoa ouviu — e que a tela diga QUAL tocador mostra.
vi.mock("./OuvirFala", () => ({
  OuvirFala: ({ falaId, nome }: { falaId: string; nome?: string }) => <span data-ouvir-fala={falaId} data-nome={nome} />,
}));
vi.mock("./OuvirPrevia", () => ({
  OuvirPrevia: ({ aoOuvir }: { aoOuvir?: () => void }) => (
    <button type="button" data-previa-audio="" onClick={() => aoOuvir?.()}>
      Ouvir
    </button>
  ),
}));

import { AvisoDeInstabilidadeDoTime } from "./AvisoDeInstabilidadeDoTime";

const URL_DOS_AVISOS = "/api/v1/telefonia/emergencias";
const URL_DO_TIME = `${URL_DOS_AVISOS}/t1`;
const URL_DA_PREVIA = "/api/v1/telefonia/falas/previa";
const HASH_PREVIA = "1".repeat(64);
const HASH_GRAVADO = "2".repeat(64);
const HTML_DO_PROXY = "<html><body><h1>504 Gateway Time-out</h1><p>nginx</p></body></html>";
/** Meio-dia no fuso da máquina: "hoje" não vira "amanhã" no meio do teste. */
const AGORA = new Date(2026, 8, 29, 12, 0, 0);
const HORAS: Record<DuracaoDaEmergencia, number | null> = { "1h": 1, "2h": 2, "4h": 4, indefinida: null };

// ─── O servidor simulado ─────────────────────────────────────────────────────

let servidor: AvisosNaResposta;
type Rota = (corpo: Record<string, unknown>) => Response | Promise<Response>;
const trocadas = new Map<string, Rota>();

function json(status: number, corpo: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", ...headers } });
}
const dados = (d: unknown) => json(200, { data: d });
/** A recusa como `fail()` a escreve: `{ error: { code, message } }`. */
const recusa = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message } }, headers);
const proxy = () => new Response(HTML_DO_PROXY, { status: 504, headers: { "Content-Type": "text/html" } });

function falaGravada(extra: Partial<FalaPublica> = {}): FalaPublica {
  return {
    id: "f9",
    tipo: "emergency",
    texto: "Instabilidade no sistema.",
    voice_id: "v1",
    hash: HASH_GRAVADO,
    status: "ready",
    erro: null,
    duracao_ms: 2000,
    atualizada_em: "2026-09-28T13:00:00.000Z",
    ...extra,
  };
}

function timeDesligado(extra: Partial<AvisoDoTimePublico> = {}): AvisoDoTimePublico {
  return {
    team_id: "t1",
    time_nome: "Suporte",
    arquivado: false,
    ativa: false,
    desde: null,
    expira_em: null,
    ligada_por: null,
    fala: null,
    ...extra,
  };
}

const doTime = () => servidor.times!.find((a) => a.team_id === "t1")!;

function rotaPadrao(metodo: string, url: string): Rota | null {
  if (metodo === "GET" && url === URL_DOS_AVISOS) {
    return () => {
      const times = servidor.times ?? [];
      const ligados = times
        .filter((a) => a.ativa)
        .map((a) => ({ team_id: a.team_id, time_nome: a.time_nome, expira_em: a.expira_em, arquivado: a.arquivado }));
      return dados(structuredClone({ ...servidor, ligados }));
    };
  }
  if (metodo === "POST" && url === URL_DA_PREVIA) {
    return () => dados({ hash: HASH_PREVIA, duracao_ms: 2000, reaproveitada: false, audio_base64: "//8=" });
  }
  if (metodo === "PUT" && url === URL_DO_TIME) {
    return (c) => {
      const fala = c.fala as { texto: string; hash: string };
      const horas = HORAS[c.duracao as DuracaoDaEmergencia];
      Object.assign(doTime(), {
        ativa: true,
        desde: new Date().toISOString(),
        expira_em: horas === null ? null : new Date(Date.now() + horas * 3_600_000).toISOString(),
        ligada_por: "Ana",
        fala: falaGravada({ id: "f10", texto: fala.texto, hash: fala.hash }),
      });
      return dados({ aviso: structuredClone(doTime()) });
    };
  }
  if (metodo === "DELETE" && url === URL_DO_TIME) {
    return () => {
      const estava = doTime().ativa;
      Object.assign(doTime(), { ativa: false, desde: null, expira_em: null, ligada_por: null });
      return dados({ desligado: estava });
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

function pintar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AvisoDeInstabilidadeDoTime teamId="t1" />
    </QueryClientProvider>,
  );
  return qc;
}

const cartao = async () => {
  await waitFor(() => expect(document.querySelector('[data-aviso-de-instabilidade="t1"]')).not.toBeNull());
  return document.querySelector('[data-aviso-de-instabilidade="t1"]') as HTMLElement;
};

async function abrirJanela(): Promise<HTMLElement> {
  pintar();
  const c = await cartao();
  await usuario().click(within(c).getByRole("button", { name: "Ligar aviso" }));
  return screen.findByRole("dialog");
}
const ligarDe = (j: HTMLElement) => within(j).getByRole("button", { name: /^(Ligar|Ligando…)$/ });
const gerarDe = (j: HTMLElement) => within(j).getByRole("button", { name: /Gerar prévia|Gerando a prévia/ });
const passoDe = (j: HTMLElement) => j.querySelector("[data-passo-do-aviso]")?.getAttribute("data-passo-do-aviso");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: AGORA });
  trocadas.clear();
  fetchFalso.mockClear();
  avisos.sucesso.mockClear();
  avisos.erro.mockClear();
  vi.stubGlobal("fetch", fetchFalso);
  servidor = { oferecida: true, pode_mudar: true, ligados: [], times: [timeDesligado()] };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("janela do aviso — a prévia ouvida antes de ligar (§6.3)", () => {
  it(
    "texto novo: 'Ligar' só depois de gerar a prévia E ouvir, e manda o hash da prévia ouvida",
    async () => {
      const u = usuario();
      const j = await abrirJanela();
      expect(within(j).getByRole("textbox", { name: "Texto do aviso" })).toHaveValue(TEXTO_SUGERIDO.emergency);
      expect(ligarDe(j)).toBeDisabled();
      expect(passoDe(j)).toBe("falta-previa");

      await u.click(gerarDe(j));
      await within(j).findByRole("button", { name: "Ouvir" });
      expect(enviados("POST", URL_DA_PREVIA)).toEqual([{ texto: TEXTO_SUGERIDO.emergency }]);
      expect(ligarDe(j)).toBeDisabled();
      expect(passoDe(j)).toBe("falta-ouvir");

      await u.click(within(j).getByRole("button", { name: "Ouvir" }));
      await waitFor(() => expect(ligarDe(j)).toBeEnabled());
      expect(passoDe(j)).toBe("pronto");
      await u.click(ligarDe(j));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(enviados("PUT", URL_DO_TIME)).toEqual([{ fala: { texto: TEXTO_SUGERIDO.emergency, hash: HASH_PREVIA }, duracao: "2h" }]);
      expect(avisos.sucesso).toHaveBeenCalledWith("Aviso de instabilidade ligado.");
      const c = await cartao();
      await waitFor(() => expect(c).toHaveAttribute("data-ativo", "sim"));
      expect(c).toHaveTextContent("Ligado às 12:00 por Ana · desliga às 14:00");
    },
    TETO_MS,
  );

  it(
    "editar o texto depois de ouvir: a prévia não vale mais, e 'Ligar' trava de novo",
    async () => {
      const u = usuario();
      const j = await abrirJanela();
      await u.click(gerarDe(j));
      await u.click(await within(j).findByRole("button", { name: "Ouvir" }));
      await waitFor(() => expect(ligarDe(j)).toBeEnabled());

      await u.type(within(j).getByRole("textbox", { name: "Texto do aviso" }), " Voltamos logo.");
      expect(ligarDe(j)).toBeDisabled();
      expect(within(j).queryByRole("button", { name: "Ouvir" })).toBeNull();
      expect(passoDe(j)).toBe("falta-previa");
      expect(j).toHaveTextContent("Gere a prévia e ouça o aviso antes de ligar.");
    },
    TETO_MS,
  );

  it(
    "o texto do aviso já gravado, sem mudança: liga direto, com o hash dele e sem prévia",
    async () => {
      doTime().fala = falaGravada();
      const j = await abrirJanela();
      expect(within(j).getByRole("textbox", { name: "Texto do aviso" })).toHaveValue("Instabilidade no sistema.");
      expect(passoDe(j)).toBe("gravado");
      // O áudio gravado dá para ouvir antes de ligar (sem custo na ElevenLabs).
      expect(j.querySelector('[data-ouvir-fala="f9"]')).not.toBeNull();
      expect(ligarDe(j)).toBeEnabled();
      await usuario().click(ligarDe(j));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(enviados("POST", URL_DA_PREVIA)).toEqual([]);
      expect(enviados("PUT", URL_DO_TIME)).toEqual([{ fala: { texto: "Instabilidade no sistema.", hash: HASH_GRAVADO }, duracao: "2h" }]);
    },
    TETO_MS,
  );

  it(
    "a duração escolhida vai no pedido",
    async () => {
      doTime().fala = falaGravada();
      const u = usuario();
      const j = await abrirJanela();
      await u.click(within(j).getByRole("combobox", { name: "Desligar sozinho depois de" }));
      await u.click(await screen.findByRole("option", { name: "1 hora" }));
      await u.click(ligarDe(j));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(enviados("PUT", URL_DO_TIME)).toEqual([{ fala: { texto: "Instabilidade no sistema.", hash: HASH_GRAVADO }, duracao: "1h" }]);
      await waitFor(async () => expect(await cartao()).toHaveTextContent("desliga às 13:00"));
    },
    TETO_MS,
  );

  it(
    "enquanto liga, o campo e 'Gerar prévia' travam; enquanto gera a prévia, 'Ligar' trava",
    async () => {
      doTime().fala = falaGravada();
      const u = usuario();
      const j = await abrirJanela();

      const previa = segurada();
      trocadas.set(`POST ${URL_DA_PREVIA}`, previa.rota);
      await u.click(gerarDe(j));
      await waitFor(() => expect(gerarDe(j)).toHaveTextContent("Gerando a prévia…"));
      expect(ligarDe(j)).toBeDisabled();
      previa.soltar(dados({ hash: HASH_GRAVADO, duracao_ms: 2000, reaproveitada: true, audio_base64: "//8=" }));
      await waitFor(() => expect(ligarDe(j)).toBeEnabled());

      const put = segurada();
      trocadas.set(`PUT ${URL_DO_TIME}`, put.rota);
      await u.click(ligarDe(j));
      await waitFor(() => expect(ligarDe(j)).toHaveTextContent("Ligando…"));
      expect(gerarDe(j)).toBeDisabled();
      expect(within(j).getByRole("textbox", { name: "Texto do aviso" })).toBeDisabled();
      put.soltar(dados({ aviso: structuredClone(doTime()) }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    },
    TETO_MS,
  );
});

describe("janela do aviso — quando ligar é recusado", () => {
  it(
    "o áudio da prévia sumiu: a frase da rota, e a prévia sai da tela (é preciso gerar de novo)",
    async () => {
      const mensagem = "O áudio deste texto não foi encontrado. Gere a prévia de novo antes de ligar.";
      trocadas.set(`PUT ${URL_DO_TIME}`, () => recusa(422, "previa_ausente", mensagem));
      const u = usuario();
      const j = await abrirJanela();
      await u.click(gerarDe(j));
      await u.click(await within(j).findByRole("button", { name: "Ouvir" }));
      await waitFor(() => expect(ligarDe(j)).toBeEnabled());
      await u.click(ligarDe(j));

      expect(await within(j).findByRole("alert")).toHaveTextContent(mensagem);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(within(j).queryByRole("button", { name: "Ouvir" })).toBeNull();
      expect(ligarDe(j)).toBeDisabled();
      expect(avisos.sucesso).not.toHaveBeenCalled();
    },
    TETO_MS,
  );

  it(
    "o time foi arquivado no meio: a frase da rota, e a janela fica aberta",
    async () => {
      const mensagem = "Este time está arquivado e não recebe ligações: o aviso não pode ser ligado nele.";
      trocadas.set(`PUT ${URL_DO_TIME}`, () => recusa(409, "time_arquivado", mensagem));
      doTime().fala = falaGravada();
      const j = await abrirJanela();
      await usuario().click(ligarDe(j));
      expect(await within(j).findByRole("alert")).toHaveTextContent(mensagem);
    },
    TETO_MS,
  );

  it(
    "o 504 de um proxy vira a frase genérica — nunca o HTML dele",
    async () => {
      trocadas.set(`PUT ${URL_DO_TIME}`, proxy);
      doTime().fala = falaGravada();
      const j = await abrirJanela();
      await usuario().click(ligarDe(j));
      expect(await within(j).findByRole("alert")).toHaveTextContent("Não foi possível ligar o aviso. Tente de novo em instantes.");
      expect(document.body.textContent).not.toContain("nginx");
    },
    TETO_MS,
  );

  it(
    "a cota de prévias estourada (429 com uma hora de espera): a frase da rota na hora, sem botão girando",
    async () => {
      const mensagem = MENSAGEM_DA_FALHA_DA_FALA.limite_de_previas;
      trocadas.set(`POST ${URL_DA_PREVIA}`, () => recusa(429, "limite_de_previas", mensagem, { "Retry-After": "3600" }));
      const j = await abrirJanela();
      await usuario().click(gerarDe(j));
      expect(await within(j).findByRole("alert")).toHaveTextContent(mensagem);
      expect(gerarDe(j)).toHaveTextContent("Gerar prévia");
      expect(ligarDe(j)).toBeDisabled();
      expect(enviados("POST", URL_DA_PREVIA)).toHaveLength(1);
    },
    TETO_MS,
  );
});

describe("cartão do aviso no time", () => {
  it(
    "ligado: diz quando, por quem e até quando; 'Desligar agora' o devolve a desligado",
    async () => {
      Object.assign(doTime(), {
        ativa: true,
        desde: new Date(2026, 8, 29, 11, 30).toISOString(),
        expira_em: new Date(2026, 8, 29, 13, 30).toISOString(),
        ligada_por: "Ana",
        fala: falaGravada(),
      });
      pintar();
      const c = await cartao();
      await waitFor(() => expect(c).toHaveAttribute("data-ativo", "sim"));
      expect(c).toHaveTextContent("Ligado às 11:30 por Ana · desliga às 13:30");
      expect(c).toHaveTextContent("Instabilidade no sistema.");
      expect(c.querySelector('[data-ouvir-fala="f9"]')).toHaveAttribute("data-nome", "Aviso de instabilidade do time Suporte");
      expect(within(c).queryByRole("button", { name: "Ligar aviso" })).toBeNull();

      await usuario().click(within(c).getByRole("button", { name: "Desligar agora" }));
      await waitFor(() => expect(c).toHaveAttribute("data-ativo", "nao"));
      expect(enviados("DELETE", URL_DO_TIME)).toHaveLength(1);
      expect(avisos.sucesso).toHaveBeenCalledWith("Aviso de instabilidade desligado.");
    },
    TETO_MS,
  );

  it("desligado e sem texto gravado: explica o que o aviso faz", async () => {
    pintar();
    const c = await cartao();
    expect(c).toHaveAttribute("data-ativo", "nao");
    expect(c).toHaveTextContent(
      "Nenhum aviso gravado ainda. Toda ligação de fora que entrar na fila deste time ouve o aviso inteiro antes de tocar nos atendentes.",
    );
    expect(within(c).getByRole("button", { name: "Ligar aviso" })).toBeInTheDocument();
  });

  it("sem `pode_mudar`, o estado aparece mas nenhum botão", async () => {
    servidor.pode_mudar = false;
    Object.assign(doTime(), { ativa: true, desde: new Date(2026, 8, 29, 11, 30).toISOString(), ligada_por: "Ana" });
    pintar();
    const c = await cartao();
    expect(c).toHaveTextContent("Ligado às 11:30 por Ana · até alguém desligar");
    expect(within(c).queryByRole("button", { name: /Desligar|Ligar/ })).toBeNull();
  });

  it("instalação sem telefonia: o cartão não aparece", async () => {
    servidor = { oferecida: false, pode_mudar: true, ligados: [], times: [] };
    pintar();
    await waitFor(() => expect(fetchFalso).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector("[data-aviso-de-instabilidade]")).toBeNull();
  });

  it("sem a lista dos times (papel que só recebe a faixa): o cartão não aparece", async () => {
    servidor.times = null;
    pintar();
    await waitFor(() => expect(fetchFalso).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector("[data-aviso-de-instabilidade]")).toBeNull();
  });

  it("a leitura falhou: diz que falhou, sem o HTML do proxy", async () => {
    trocadas.set(`GET ${URL_DOS_AVISOS}`, proxy);
    pintar();
    const c = await cartao();
    expect(c).toHaveTextContent("Não foi possível carregar o aviso de instabilidade do telefone. Recarregue a página.");
    expect(document.body.textContent).not.toContain("nginx");
    expect(within(c).queryByRole("button")).toBeNull();
  });
});
