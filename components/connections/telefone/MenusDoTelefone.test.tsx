/**
 * A ABA MENUS (desenho da fase 2, §6.2 e §8), medida pelo que a pessoa vê e pelo
 * que a tela manda à API.
 *
 * O `apiClient` é o de VERDADE, sobre um `fetch` simulado que responde como as
 * rotas respondem (`{ data }`, ou `{ error: { code, message, details } }` de
 * `fail()`), e o `useT` também: sem provider é português; com
 * `<IdiomaProvider locale="es">` é o espanhol do dicionário. Assim cada falha
 * chega à tela na forma que o cliente entrega — inclusive o 504 de um proxy com
 * HTML, cuja "mensagem" o cliente inventa e a tela não pode mostrar.
 *
 * O que se prova:
 *  - o cartão diz o que o menu faz (tecla → time, padrão, números) e o que as
 *    ligações ENCERRADAS fizeram nele — com o alerta de menu que confunde
 *    (`menuConfunde`), o laço de retorno da URA;
 *  - um time arquivado no menu aparece no cartão e trava o salvar no editor;
 *  - arquivar: em uso não se oferece; a recusa da rota (corrida) vem com a
 *    frase dela, que nomeia os números;
 *  - o editor segue o fluxo do dono (D15): sem mexer na fala, salva com o hash
 *    da fala em uso; texto novo só salva depois de "Gerar prévia" DAQUELE texto;
 *  - tecla repetida, opção sem time e menu sem opção não chegam à rota;
 *  - salvar barrado porque o áudio da fala sumiu (`previa_ausente`) diz qual
 *    fala e pede a prévia de novo — e o salvar só volta depois dela;
 *  - a criação manda `Idempotency-Key`, a MESMA ao repetir o mesmo menu;
 *  - a fala montada das opções sai no idioma de quem monta (`FRASE_DA_OPCAO`).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { FRASE_DA_OPCAO } from "@/lib/telefonia/texto-do-menu";
import {
  MENSAGEM_DA_FALHA_DA_FALA,
  type FalaPublica,
  type MenuPublico,
  type UltimosSeteDias,
} from "@/lib/telefonia/vocabulario";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
// Os tocadores têm teste próprio; aqui basta saber QUAL deles a tela mostra, e com o quê.
vi.mock("@/components/telefonia/OuvirFala", () => ({
  OuvirFala: ({ falaId, nome }: { falaId: string; nome?: string }) => <span data-ouvir-fala={falaId} data-nome={nome} />,
}));
vi.mock("@/components/telefonia/OuvirPrevia", () => ({
  OuvirPrevia: ({ audio, nome }: { audio: Uint8Array; nome?: string }) => (
    <span data-ouvir-previa={audio.length} data-nome={nome} />
  ),
}));

import { MenusDoTelefone } from "./MenusDoTelefone";

const T_SUPORTE = "11111111-1111-4111-8111-111111111111";
const T_FINANCEIRO = "22222222-2222-4222-8222-222222222222";
const T_ANTIGO = "33333333-3333-4333-8333-333333333333";
const HASH_EM_USO = "e".repeat(64);
const HASH_INVALIDA = "c".repeat(64);
const HASH_NOVO = "f".repeat(64);
const HTML_DO_PROXY = "<html><body><h1>504 Gateway Time-out</h1><p>nginx</p></body></html>";

// ─── O servidor simulado ─────────────────────────────────────────────────────

const time = (id: string, name: string, archived = false) => ({
  id,
  name,
  slug: name.toLowerCase(),
  description: "",
  aberto_agora: true,
  horario_invalido: false,
  archived,
  pode_iniciar: true,
});

const SEMANA_VAZIA: UltimosSeteDias = { total: 0, por_tecla: {}, sem_escolha: 0, tecla_errada: 0, desligou_no_menu: 0 };

function fala(extra: Partial<FalaPublica> = {}): FalaPublica {
  return {
    id: "fala-menu",
    tipo: "menu",
    texto: "Para Suporte, digite 1. Para Financeiro, digite 2.",
    voice_id: "v1",
    hash: HASH_EM_USO,
    status: "ready",
    erro: null,
    duracao_ms: 3000,
    atualizada_em: "2026-09-28T13:00:00.000Z",
    ...extra,
  };
}

function menuPrincipal(extra: Partial<MenuPublico> = {}): MenuPublico {
  return {
    id: "m1",
    nome: "Principal",
    time_padrao_id: T_SUPORTE,
    time_padrao_nome: "Suporte",
    // Como a rota devolve: pela tecla em ordem de texto — o 0 vem primeiro.
    opcoes: [
      { tecla: "0", time_id: T_FINANCEIRO, time_nome: "Financeiro" },
      { tecla: "1", time_id: T_SUPORTE, time_nome: "Suporte" },
    ],
    fala: fala({ texto: "Para Suporte, digite 1. Para Financeiro, digite 0." }),
    fala_invalida: null,
    pronto: true,
    numeros: [],
    ultimos_7_dias: { total: 10, por_tecla: { "1": 4, "0": 1 }, sem_escolha: 4, tecla_errada: 1, desligou_no_menu: 0 },
    ...extra,
  };
}

interface Servidor {
  oferecida: boolean;
  menus: MenuPublico[];
  voz: { oferecida: boolean; chave: { cadastrada: boolean; last4: string | null }; voz: { voice_id: string; model_id: string } | null; falas: Record<string, null> };
  times: ReturnType<typeof time>[];
}
let servidor: Servidor;
type Rota = (corpo: Record<string, unknown>) => Response | Promise<Response>;
const trocadas = new Map<string, Rota>();

function json(status: number, corpo: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", ...headers } });
}
const dados = (d: unknown, status = 200) => json(status, { data: d });
/** A recusa como `fail()` a escreve: `{ error: { code, message, details? } }`. */
const recusa = (status: number, code: string, message?: string, details?: object, headers: Record<string, string> = {}) =>
  json(status, { error: { code, ...(message ? { message } : {}), ...(details ? { details } : {}) } }, headers);
const proxy = (status: number) => new Response(HTML_DO_PROXY, { status, headers: { "Content-Type": "text/html" } });

/** O menu que a rota devolve depois de gravar — com os nomes dos times, como `descreverMenu`. */
function gravado(id: string, c: Record<string, unknown>): MenuPublico {
  const nome = (tid: string) => servidor.times.find((x) => x.id === tid)?.name ?? "";
  const f = c.fala as { texto: string; hash: string };
  const fi = c.fala_invalida as { texto: string; hash: string } | null;
  return {
    id,
    nome: String(c.nome),
    time_padrao_id: String(c.time_padrao_id),
    time_padrao_nome: nome(String(c.time_padrao_id)),
    opcoes: (c.opcoes as { tecla: string; time_id: string }[]).map((o) => ({ ...o, time_nome: nome(o.time_id) })),
    fala: fala({ id: `fala-${id}`, texto: f.texto, hash: f.hash }),
    fala_invalida: fi ? fala({ id: `invalida-${id}`, tipo: "invalid", texto: fi.texto, hash: fi.hash }) : null,
    pronto: true,
    numeros: [],
    ultimos_7_dias: SEMANA_VAZIA,
  };
}

function rotaPadrao(metodo: string, url: string): Rota | null {
  if (metodo === "GET" && url === "/api/v1/telefonia/menus") {
    return () => dados(structuredClone({ oferecida: servidor.oferecida, menus: servidor.menus }));
  }
  if (metodo === "GET" && url === "/api/v1/telefonia/voz") return () => dados(structuredClone(servidor.voz));
  if (metodo === "GET" && url === "/api/v1/conversations/teams") return () => dados(structuredClone(servidor.times));
  if (metodo === "POST" && url === "/api/v1/telefonia/falas/previa") {
    return () => dados({ hash: HASH_NOVO, duracao_ms: 1000, reaproveitada: false, audio_base64: "//8=" });
  }
  if (metodo === "POST" && url === "/api/v1/telefonia/menus") {
    return (c) => {
      const menu = gravado(`m${servidor.menus.length + 1}`, c);
      servidor.menus.push(menu);
      return dados({ menu }, 201);
    };
  }
  const umMenu = /^\/api\/v1\/telefonia\/menus\/([^/]+)$/.exec(url);
  if (metodo === "PATCH" && umMenu) {
    return (c) => {
      const menu = gravado(umMenu[1]!, c);
      servidor.menus = servidor.menus.map((m) => (m.id === menu.id ? menu : m));
      return dados({ menu });
    };
  }
  if (metodo === "DELETE" && umMenu) {
    return () => {
      servidor.menus = servidor.menus.filter((m) => m.id !== umMenu[1]);
      return dados({ arquivado: true });
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

/** As chamadas que a tela fez a uma rota: o corpo e os cabeçalhos. */
function chamadas(metodo: string, url: string): { corpo: unknown; headers: Record<string, string> }[] {
  return fetchFalso.mock.calls
    .filter(([u, i]) => u === url && (i?.method ?? "GET") === metodo)
    .map(([, i]) => ({
      corpo: typeof i?.body === "string" ? JSON.parse(i.body) : undefined,
      headers: (i?.headers ?? {}) as Record<string, string>,
    }));
}
const enviados = (metodo: string, url: string) => chamadas(metodo, url).map((c) => c.corpo);

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

/** Radix Select em jsdom é caro, e o custo varia com a carga da máquina (ver EndForm.test.tsx). */
const TETO_MS = 30_000;
const usuario = () => userEvent.setup({ delay: null });

function pintar(envolver: (filho: ReactNode) => ReactNode = (f) => f) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{envolver(<MenusDoTelefone />)}</QueryClientProvider>);
  return qc;
}

async function cartaoDo(nome: string): Promise<HTMLElement> {
  return (await screen.findByText(nome, { selector: "[data-menu] *" })).closest("[data-menu]") as HTMLElement;
}

async function abrirEditor(nome = "Principal"): Promise<HTMLElement> {
  const cartao = await cartaoDo(nome);
  await userEvent.click(within(cartao).getByRole("button", { name: "Editar" }));
  return document.querySelector("[data-editor-de-menu]") as HTMLElement;
}

const salvarDe = (e: HTMLElement) => within(e).getByRole("button", { name: /Salvar menu|Salvando/ });
const campoDoMenu = (e: HTMLElement) => within(e).getByRole("textbox", { name: "Fala do menu" });
const campoDaInvalida = (e: HTMLElement) => within(e).getByRole("textbox", { name: "Fala de tecla inválida (opcional)" });
const gerarDe = (e: HTMLElement, qual: "menu" | "invalid") =>
  e.querySelector(`[data-gerar-previa="${qual}"]`) as HTMLButtonElement;
const alertaDe = (e: HTMLElement, qual: "menu" | "invalida" | "geral") =>
  e.querySelector(`[data-falha-do-salvar="${qual}"]`);

async function escolher(user: ReturnType<typeof usuario>, combobox: HTMLElement, opcao: string) {
  await user.click(combobox);
  await user.click(await screen.findByRole("option", { name: opcao }));
}

beforeEach(() => {
  trocadas.clear();
  fetchFalso.mockClear();
  toast.success.mockClear();
  vi.stubGlobal("fetch", fetchFalso);
  servidor = {
    oferecida: true,
    menus: [menuPrincipal()],
    voz: {
      oferecida: true,
      chave: { cadastrada: true, last4: "1234" },
      voz: { voice_id: "v1", model_id: "eleven_multilingual_v2" },
      falas: { waiting: null, nobody: null, after_hours: null },
    },
    times: [time(T_SUPORTE, "Suporte"), time(T_FINANCEIRO, "Financeiro"), time(T_ANTIGO, "Cobrança antiga", true)],
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("aba Menus — o cartão de cada menu", () => {
  it("diz o que o menu faz (tecla → time na ordem falada, padrão, números) e o estado da fala", async () => {
    servidor.menus = [menuPrincipal({ numeros: ["Recepção · (61) 3686-1503"] })];
    pintar();
    const cartao = await cartaoDo("Principal");
    const teclas = [...cartao.querySelectorAll("[data-opcao-no-cartao]")].map((li) => li.textContent);
    // O 0 por último, como a fala o diz — não na ordem de texto em que a rota devolve.
    expect(teclas).toEqual(["Tecla 1 → Suporte", "Tecla 0 → Financeiro"]);
    expect(within(cartao).getByText(/Padrão \(sem escolha\): Suporte/)).toBeInTheDocument();
    expect(within(cartao).getByText(/Recepção · \(61\) 3686-1503/)).toBeInTheDocument();
    expect(cartao.querySelector("[data-estado-da-fala]")?.getAttribute("data-estado-da-fala")).toBe("em-uso");
    expect(cartao.querySelector('[data-ouvir-fala="fala-menu"]')?.getAttribute("data-nome")).toBe("Principal");
  });

  it("os últimos 7 dias, com o alerta quando muita gente não escolhe opção nenhuma", async () => {
    pintar();
    const semana = within(await cartaoDo("Principal")).getByTestId("menu-ultimos-7-dias");
    expect(semana).toHaveTextContent("10 ligações");
    expect(semana).toHaveTextContent("Tecla 1 (Suporte): 4");
    expect(semana).toHaveTextContent("Tecla 0 (Financeiro): 1");
    expect(semana).toHaveTextContent("Sem escolha: 4");
    expect(semana).toHaveTextContent("Tecla errada: 1");
    expect(semana).toHaveTextContent("Desligou no menu: 0");
    expect(semana.querySelector("[data-menu-confunde]")).not.toBeNull();
  });

  it("menu que funciona: sem alerta; menu que ninguém usou ainda: diz isso, sem números", async () => {
    servidor.menus = [
      menuPrincipal({
        ultimos_7_dias: { total: 10, por_tecla: { "1": 8, "0": 1 }, sem_escolha: 1, tecla_errada: 0, desligou_no_menu: 0 },
      }),
      menuPrincipal({ id: "m2", nome: "Noturno", ultimos_7_dias: SEMANA_VAZIA }),
    ];
    pintar();
    const bom = within(await cartaoDo("Principal")).getByTestId("menu-ultimos-7-dias");
    expect(bom).toHaveTextContent("10 ligações");
    expect(bom.querySelector("[data-menu-confunde]")).toBeNull();
    const novo = within(await cartaoDo("Noturno")).getByTestId("menu-ultimos-7-dias");
    expect(novo).toHaveTextContent("Nenhuma ligação passou por este menu ainda.");
    expect(novo.querySelector("[data-menu-confunde]")).toBeNull();
  });

  it("uma ligação só: '1 ligação', no singular", async () => {
    servidor.menus = [
      menuPrincipal({ ultimos_7_dias: { total: 1, por_tecla: { "1": 1 }, sem_escolha: 0, tecla_errada: 0, desligou_no_menu: 0 } }),
    ];
    pintar();
    expect(within(await cartaoDo("Principal")).getByTestId("menu-ultimos-7-dias")).toHaveTextContent(/^Últimos 7 dias1 ligação/);
  });

  it("um time do menu foi arquivado: o cartão avisa, nomeando o time", async () => {
    servidor.menus = [
      menuPrincipal({ time_padrao_id: T_ANTIGO, time_padrao_nome: "Cobrança antiga" }),
    ];
    pintar();
    const cartao = await cartaoDo("Principal");
    const aviso = await waitFor(() => {
      const a = cartao.querySelector("[data-time-arquivado]");
      expect(a).not.toBeNull();
      return a!;
    });
    expect(aviso).toHaveTextContent(/Cobrança antiga/);
    expect(aviso).toHaveTextContent(/Edite o menu e escolha outro time/);
  });

  it("telefonia desligada na instalação: o mesmo cartão das outras abas", async () => {
    servidor.oferecida = false;
    pintar();
    expect(await screen.findByText("Telefonia desligada nesta instalação")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-menu]")).toHaveLength(0);
  });

  it("a leitura recusada por papel (403): diz quem pode, sem botão nenhum", async () => {
    trocadas.set("GET /api/v1/telefonia/menus", () => recusa(403, "forbidden_role", "Permissão insuficiente."));
    pintar();
    expect(await screen.findByText("Só quem administra a organização gerencia os menus de voz.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a leitura falhou no proxy (504 com HTML): frase nossa, nunca o HTML", async () => {
    trocadas.set("GET /api/v1/telefonia/menus", () => proxy(504));
    pintar();
    expect(await screen.findByText("Não foi possível carregar os menus. Recarregue a página.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Gateway|nginx|HTTP 50/);
  });

  it("sem a chave da ElevenLabs: diz onde resolver e não oferece menu novo", async () => {
    servidor.voz.chave = { cadastrada: false, last4: null };
    servidor.voz.voz = null;
    pintar();
    expect(
      await screen.findByText("Para gerar a fala do menu, cadastre a chave da ElevenLabs e escolha a voz na aba Voz e falas."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Novo menu" })).toBeDisabled();
  });

  it("sem time ativo nenhum: diz que o menu precisa de um time, e onde criar", async () => {
    servidor.menus = [];
    servidor.times = [time(T_ANTIGO, "Cobrança antiga", true)];
    pintar();
    const link = await screen.findByRole("link", { name: "Criar um time" });
    expect(link).toHaveAttribute("href", "/app/settings/teams");
    expect(screen.getByRole("button", { name: "Novo menu" })).toBeDisabled();
  });
});

describe("aba Menus — arquivar", () => {
  it("menu que atende um número: 'Arquivar' não é oferecido, e a tela diz o que fazer antes", async () => {
    servidor.menus = [menuPrincipal({ numeros: ["Recepção · (61) 3686-1503"] })];
    pintar();
    const cartao = await cartaoDo("Principal");
    expect(within(cartao).getByRole("button", { name: "Arquivar" })).toBeDisabled();
    expect(within(cartao).getByText(/Para arquivar, troque antes o destino/)).toBeInTheDocument();
  });

  it("menu sem número: confirma, arquiva e sai da lista", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(true);
    pintar();
    const cartao = await cartaoDo("Principal");
    await userEvent.click(within(cartao).getByRole("button", { name: "Arquivar" }));
    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(chamadas("DELETE", "/api/v1/telefonia/menus/m1")).toHaveLength(1);
    await waitFor(() => expect(document.querySelector("[data-menu]")).toBeNull());
    expect(toast.success).toHaveBeenCalledWith("Menu arquivado.");
  });

  it("desistir na confirmação não arquiva nada", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    pintar();
    await userEvent.click(within(await cartaoDo("Principal")).getByRole("button", { name: "Arquivar" }));
    expect(chamadas("DELETE", "/api/v1/telefonia/menus/m1")).toHaveLength(0);
  });

  it("a rota recusa porque um número passou a usar o menu (409): a frase dela, nomeando o número", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const frase = "Este menu está em uso por: Recepção · (61) 3686-1503. Troque o destino do número antes de arquivar.";
    trocadas.set("DELETE /api/v1/telefonia/menus/m1", () => recusa(409, "menu_em_uso", frase, { numeros: [] }));
    pintar();
    const cartao = await cartaoDo("Principal");
    await userEvent.click(within(cartao).getByRole("button", { name: "Arquivar" }));
    expect(await within(cartao).findByRole("alert")).toHaveTextContent(frase);
  });

  it("o proxy devolveu 504 com HTML ao arquivar: frase nossa, nunca o HTML", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    trocadas.set("DELETE /api/v1/telefonia/menus/m1", () => proxy(504));
    pintar();
    const cartao = await cartaoDo("Principal");
    await userEvent.click(within(cartao).getByRole("button", { name: "Arquivar" }));
    expect(await within(cartao).findByRole("alert")).toHaveTextContent(
      "Não foi possível arquivar o menu. Tente de novo em instantes.",
    );
    expect(cartao.textContent).not.toMatch(/Gateway|nginx|HTTP 50/);
  });
});

describe("aba Menus — o editor", () => {
  it("editar sem mexer na fala: 'Salvar menu' manda o texto e o hash da fala em uso, sem gerar prévia", async () => {
    pintar();
    const editor = await abrirEditor();
    await userEvent.click(salvarDe(editor));
    expect(enviados("POST", "/api/v1/telefonia/falas/previa")).toHaveLength(0);
    expect(enviados("PATCH", "/api/v1/telefonia/menus/m1")).toEqual([
      {
        nome: "Principal",
        opcoes: [
          { tecla: "1", time_id: T_SUPORTE },
          { tecla: "0", time_id: T_FINANCEIRO },
        ],
        time_padrao_id: T_SUPORTE,
        fala: { texto: "Para Suporte, digite 1. Para Financeiro, digite 0.", hash: HASH_EM_USO },
        fala_invalida: null,
      },
    ]);
    await waitFor(() => expect(document.querySelector("[data-editor-de-menu]")).toBeNull());
    expect(toast.success).toHaveBeenCalledWith("Menu salvo.");
  });

  it("a fala de tecla inválida em uso vai com o hash dela; apagar o texto tira a fala do menu", async () => {
    servidor.menus = [
      menuPrincipal({ fala_invalida: fala({ id: "fala-inv", tipo: "invalid", texto: "Opção inválida.", hash: HASH_INVALIDA }) }),
    ];
    pintar();
    let editor = await abrirEditor();
    expect(campoDaInvalida(editor)).toHaveValue("Opção inválida.");
    await userEvent.click(salvarDe(editor));
    expect(enviados("PATCH", "/api/v1/telefonia/menus/m1")[0]).toMatchObject({
      fala_invalida: { texto: "Opção inválida.", hash: HASH_INVALIDA },
    });

    await waitFor(() => expect(document.querySelector("[data-editor-de-menu]")).toBeNull());
    editor = await abrirEditor();
    await userEvent.clear(campoDaInvalida(editor));
    await userEvent.click(salvarDe(editor));
    expect(enviados("PATCH", "/api/v1/telefonia/menus/m1")[1]).toMatchObject({ fala_invalida: null });
  });

  it("texto novo: 'Salvar menu' só depois de 'Gerar prévia' daquele texto, e manda o hash novo", async () => {
    pintar();
    const editor = await abrirEditor();
    await userEvent.clear(campoDoMenu(editor));
    await userEvent.type(campoDoMenu(editor), "Para Suporte, digite 1.");
    expect(salvarDe(editor)).toBeDisabled();
    expect(within(editor).getByText("Gere a prévia de cada fala que mudou antes de salvar o menu.")).toBeInTheDocument();
    expect(editor.querySelector('[data-estado-da-fala]')?.getAttribute("data-estado-da-fala")).toBe("em-uso");

    await userEvent.click(gerarDe(editor, "menu"));
    const previa = chamadas("POST", "/api/v1/telefonia/falas/previa");
    expect(previa.map((c) => c.corpo)).toEqual([{ texto: "Para Suporte, digite 1." }]);
    await waitFor(() => expect(salvarDe(editor)).toBeEnabled());
    expect(editor.querySelector('[data-estado-da-fala]')?.getAttribute("data-estado-da-fala")).toBe("previa");
    expect(editor.querySelector("[data-ouvir-previa]")?.getAttribute("data-nome")).toBe("Fala do menu");

    await userEvent.click(salvarDe(editor));
    expect(enviados("PATCH", "/api/v1/telefonia/menus/m1")[0]).toMatchObject({
      fala: { texto: "Para Suporte, digite 1.", hash: HASH_NOVO },
    });
  });

  it("a última opção não sai: um menu sem opção não existe", async () => {
    pintar();
    const editor = await abrirEditor();
    const remover = () => within(editor).getAllByRole("button", { name: "Remover opção" });
    expect(remover()).toHaveLength(2);
    await userEvent.click(remover()[1]!);
    expect(remover()).toHaveLength(1);
    expect(remover()[0]).toBeDisabled();
  });

  it("tecla repetida: a tela diz e não salva", { timeout: TETO_MS }, async () => {
    const user = usuario();
    pintar();
    const editor = await abrirEditor();
    const teclas = within(editor).getAllByRole("combobox", { name: "Tecla da opção" });
    await escolher(user, teclas[1]!, "1");
    expect(within(editor).getByText("Cada tecla só pode levar a um time.")).toBeInTheDocument();
    expect(salvarDe(editor)).toBeDisabled();
    await user.click(salvarDe(editor));
    expect(enviados("PATCH", "/api/v1/telefonia/menus/m1")).toHaveLength(0);
  });

  it("time arquivado no editor: a opção diz qual, o salvar trava, e escolher outro time destrava", { timeout: TETO_MS }, async () => {
    const user = usuario();
    servidor.menus = [
      menuPrincipal({
        opcoes: [
          { tecla: "1", time_id: T_SUPORTE, time_nome: "Suporte" },
          { tecla: "2", time_id: T_ANTIGO, time_nome: "Cobrança antiga" },
        ],
      }),
    ];
    pintar();
    const editor = await abrirEditor();
    const times = within(editor).getAllByRole("combobox", { name: "Time da opção" });
    await waitFor(() => expect(times[1]).toHaveTextContent("Cobrança antiga (arquivado)"));
    expect(within(editor).getByText("Um time escolhido foi arquivado. Escolha outro time.")).toBeInTheDocument();
    expect(salvarDe(editor)).toBeDisabled();

    await user.click(times[1]!);
    // O arquivado aparece para dizer o que ESTAVA escolhido, mas não se escolhe de novo.
    expect(await screen.findByRole("option", { name: "Cobrança antiga (arquivado)" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: "Financeiro" }));
    await waitFor(() => expect(salvarDe(editor)).toBeEnabled());
  });

  it(
    "menu novo: a fala nasce das opções, a prévia dela libera o salvar, e a criação vai com Idempotency-Key",
    { timeout: TETO_MS },
    async () => {
      const user = usuario();
      servidor.menus = [];
      pintar();
      await user.click(await screen.findByRole("button", { name: "Novo menu" }));
      const editor = document.querySelector("[data-editor-de-menu]") as HTMLElement;
      await user.type(within(editor).getByRole("textbox", { name: "Nome do menu" }), "Atendimento");
      await escolher(user, within(editor).getByRole("combobox", { name: "Time da opção" }), "Suporte");
      await user.click(within(editor).getByRole("button", { name: "Adicionar opção" }));
      await escolher(user, within(editor).getAllByRole("combobox", { name: "Time da opção" })[1]!, "Financeiro");
      expect(within(editor).getByText("Escolha o time padrão.")).toBeInTheDocument();
      await escolher(user, within(editor).getByRole("combobox", { name: "Time padrão (quem não escolhe nada)" }), "Suporte");

      expect(campoDoMenu(editor)).toHaveValue("Para Suporte, digite 1. Para Financeiro, digite 2.");
      expect(salvarDe(editor)).toBeDisabled();
      await user.click(gerarDe(editor, "menu"));
      await waitFor(() => expect(salvarDe(editor)).toBeEnabled());

      // A primeira tentativa esbarra noutra gravação; a segunda, igual, é a MESMA criação.
      trocadas.set("POST /api/v1/telefonia/menus", () =>
        recusa(409, "gravacao_em_andamento", "Outra gravação deste menu está em andamento. Tente de novo em instantes."),
      );
      await user.click(salvarDe(editor));
      expect(await within(editor).findByRole("alert")).toHaveTextContent(/em andamento/);
      trocadas.delete("POST /api/v1/telefonia/menus");
      await user.click(salvarDe(editor));

      const criacoes = chamadas("POST", "/api/v1/telefonia/menus");
      expect(criacoes).toHaveLength(2);
      expect(criacoes[0]!.corpo).toEqual({
        nome: "Atendimento",
        opcoes: [
          { tecla: "1", time_id: T_SUPORTE },
          { tecla: "2", time_id: T_FINANCEIRO },
        ],
        time_padrao_id: T_SUPORTE,
        fala: { texto: "Para Suporte, digite 1. Para Financeiro, digite 2.", hash: HASH_NOVO },
        fala_invalida: null,
      });
      const chave = criacoes[0]!.headers["Idempotency-Key"];
      expect(chave).toMatch(/^[0-9a-f-]{36}$/);
      expect(criacoes[1]!.headers["Idempotency-Key"]).toBe(chave);
      expect(await cartaoDo("Atendimento")).not.toBeNull();
    },
  );

  it(
    "menu novo com outro conteúdo depois de uma recusa: chave nova (a antiga era de OUTRO menu)",
    { timeout: TETO_MS },
    async () => {
      const user = usuario();
      servidor.menus = [];
      trocadas.set("POST /api/v1/telefonia/menus", () =>
        recusa(409, "gravacao_em_andamento", "Outra gravação deste menu está em andamento. Tente de novo em instantes."),
      );
      pintar();
      await user.click(await screen.findByRole("button", { name: "Novo menu" }));
      const editor = document.querySelector("[data-editor-de-menu]") as HTMLElement;
      const nome = within(editor).getByRole("textbox", { name: "Nome do menu" });
      await user.type(nome, "Atendimento");
      await escolher(user, within(editor).getByRole("combobox", { name: "Time da opção" }), "Suporte");
      await escolher(user, within(editor).getByRole("combobox", { name: "Time padrão (quem não escolhe nada)" }), "Suporte");
      await user.click(gerarDe(editor, "menu"));
      await waitFor(() => expect(salvarDe(editor)).toBeEnabled());
      await user.click(salvarDe(editor));
      await within(editor).findByRole("alert");
      await user.type(nome, " 2");
      await user.click(salvarDe(editor));
      const [a, b] = chamadas("POST", "/api/v1/telefonia/menus");
      expect(b!.headers["Idempotency-Key"]).not.toBe(a!.headers["Idempotency-Key"]);
    },
  );
});

describe("aba Menus — o editor quando a rota recusa", () => {
  it("o áudio da fala do menu sumiu (`previa_ausente`): a frase diz qual fala, e o salvar volta só depois da prévia", async () => {
    const frase = "O áudio da fala do menu não foi encontrado. Gere a prévia de novo e salve.";
    trocadas.set("PATCH /api/v1/telefonia/menus/m1", () => recusa(422, "previa_ausente", frase, { fala: "menu" }));
    pintar();
    const editor = await abrirEditor();
    await userEvent.click(salvarDe(editor));
    await waitFor(() => expect(alertaDe(editor, "menu")).toHaveTextContent(frase));
    // A fala em uso não serve mais: salvar de novo daria a mesma recusa.
    expect(salvarDe(editor)).toBeDisabled();

    trocadas.delete("PATCH /api/v1/telefonia/menus/m1");
    await userEvent.click(gerarDe(editor, "menu"));
    await waitFor(() => expect(salvarDe(editor)).toBeEnabled());
    await userEvent.click(salvarDe(editor));
    expect(enviados("PATCH", "/api/v1/telefonia/menus/m1")[1]).toMatchObject({
      fala: { texto: "Para Suporte, digite 1. Para Financeiro, digite 0.", hash: HASH_NOVO },
    });
  });

  it("o Storage não respondeu ao conferir a fala de tecla inválida: a frase fica ao lado DELA, e dá para tentar de novo", async () => {
    const frase =
      "Não foi possível conferir o áudio da fala de opção inválida agora. Tente de novo em instantes; se continuar, gere a prévia de novo.";
    servidor.menus = [
      menuPrincipal({ fala_invalida: fala({ id: "fala-inv", tipo: "invalid", texto: "Opção inválida.", hash: HASH_INVALIDA }) }),
    ];
    trocadas.set("PATCH /api/v1/telefonia/menus/m1", () => recusa(502, "armazenamento", frase, { fala: "invalida" }));
    pintar();
    const editor = await abrirEditor();
    await userEvent.click(salvarDe(editor));
    await waitFor(() => expect(alertaDe(editor, "invalida")).toHaveTextContent(frase));
    expect(alertaDe(editor, "menu")).toBeNull();
    expect(salvarDe(editor)).toBeEnabled();
  });

  it("o time foi arquivado por outra pessoa enquanto se editava (422): a frase da rota", async () => {
    const frase = "Algum time escolhido não existe nesta organização ou está arquivado.";
    trocadas.set("PATCH /api/v1/telefonia/menus/m1", () => recusa(422, "time_invalido", frase));
    pintar();
    const editor = await abrirEditor();
    await userEvent.click(salvarDe(editor));
    await waitFor(() => expect(alertaDe(editor, "geral")).toHaveTextContent(frase));
  });

  it("o proxy devolveu 504 com HTML no salvar: frase nossa, nunca o HTML — e dá para tentar de novo", async () => {
    trocadas.set("PATCH /api/v1/telefonia/menus/m1", () => proxy(504));
    pintar();
    const editor = await abrirEditor();
    await userEvent.click(salvarDe(editor));
    await waitFor(() =>
      expect(alertaDe(editor, "geral")).toHaveTextContent("Não foi possível salvar o menu. Tente de novo em instantes."),
    );
    expect(editor.textContent).not.toMatch(/Gateway|nginx|HTTP 50|<html/);
    expect(salvarDe(editor)).toBeEnabled();
  });

  it("a cota de prévias estourou (429, 1 h): a frase aparece NA HORA, sem repetir o pedido", async () => {
    trocadas.set("POST /api/v1/telefonia/falas/previa", () =>
      recusa(429, "limite_de_previas", MENSAGEM_DA_FALHA_DA_FALA.limite_de_previas, undefined, { "Retry-After": "3600" }),
    );
    pintar();
    const editor = await abrirEditor();
    await userEvent.type(campoDoMenu(editor), " Obrigado.");
    await userEvent.click(gerarDe(editor, "menu"));
    expect(await within(editor).findByText(/Muitas prévias geradas na última hora/)).toBeInTheDocument();
    expect(chamadas("POST", "/api/v1/telefonia/falas/previa")).toHaveLength(1);
    expect(salvarDe(editor)).toBeDisabled();
  });
});

describe("aba Menus — um gesto por vez", () => {
  it("enquanto salva, 'Gerar prévia' e os campos ficam travados", async () => {
    const patch = segurada();
    trocadas.set("PATCH /api/v1/telefonia/menus/m1", patch.rota);
    pintar();
    const editor = await abrirEditor();
    await userEvent.click(salvarDe(editor));
    await waitFor(() => expect(salvarDe(editor)).toHaveTextContent("Salvando…"));
    expect(gerarDe(editor, "menu")).toBeDisabled();
    expect(campoDoMenu(editor)).toBeDisabled();
    expect(within(editor).getByRole("textbox", { name: "Nome do menu" })).toBeDisabled();
    patch.soltar(dados({ menu: null }));
    await waitFor(() => expect(document.querySelector("[data-editor-de-menu]")).toBeNull());
  });

  it("enquanto a prévia é gerada, 'Salvar menu' fica travado", async () => {
    const previa = segurada();
    trocadas.set("POST /api/v1/telefonia/falas/previa", previa.rota);
    pintar();
    const editor = await abrirEditor();
    await userEvent.click(gerarDe(editor, "menu"));
    await waitFor(() => expect(editor.querySelector('[data-estado-da-previa="gerando"]')).not.toBeNull());
    expect(salvarDe(editor)).toBeDisabled();
    previa.soltar(dados({ hash: HASH_NOVO, duracao_ms: 900, reaproveitada: false, audio_base64: "//8=" }));
    await waitFor(() => expect(salvarDe(editor)).toBeEnabled());
  });

  it("com um menu aberto no editor, os outros não abrem (o rascunho não se perde)", async () => {
    servidor.menus = [menuPrincipal(), menuPrincipal({ id: "m2", nome: "Noturno" })];
    pintar();
    await abrirEditor("Principal");
    expect(within(await cartaoDo("Noturno")).getByRole("button", { name: "Editar" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Novo menu" })).toBeNull();
  });
});

describe("aba Menus — em espanhol", () => {
  it("a frase de cada opção tem espanhol no dicionário (o gate só confere t() com texto literal)", () => {
    expect(DICIONARIO[FRASE_DA_OPCAO]?.es).toBe("Para {time}, marque {tecla}.");
  });

  it("a fala montada das opções sai no idioma de quem monta", { timeout: TETO_MS }, async () => {
    const user = usuario();
    servidor.menus = [];
    pintar((f) => <IdiomaProvider locale="es">{f}</IdiomaProvider>);
    await user.click(await screen.findByRole("button", { name: "Nuevo menú" }));
    const editor = document.querySelector("[data-editor-de-menu]") as HTMLElement;
    await escolher(user, within(editor).getByRole("combobox", { name: "Equipo de la opción" }), "Suporte");
    expect(within(editor).getByRole("textbox", { name: "Locución del menú" })).toHaveValue("Para Suporte, marque 1.");
  });
});
