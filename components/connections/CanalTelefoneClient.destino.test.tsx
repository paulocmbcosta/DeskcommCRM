/**
 * "QUANDO LIGAREM: TOCAR NO TIME OU TOCAR O MENU" (desenho da fase 2, §6.2 —
 * Conexões › Telefone › Números), medido pelo que a pessoa vê e pelo que a tela
 * manda à API.
 *
 * O `apiClient` é o de VERDADE, sobre um `fetch` simulado que responde como as
 * rotas respondem (`{ data }`, ou `{ error: { code, message } }` de `fail()`), e
 * o `useT` também: sem provider é português; com `<IdiomaProvider locale="es">`
 * é o espanhol do dicionário. Assim a recusa chega à tela na forma que o cliente
 * entrega — inclusive o 504 de um proxy com HTML, que a tela não pode mostrar.
 *
 * O que se prova:
 *  - o destino é UM só: tocar no time manda `menu_id: null`, tocar o menu manda
 *    `time_id: null` (o CHECK da 0288 recusaria os dois);
 *  - o cartão diz qual menu atende o número, e editar sem mexer mantém o menu;
 *  - o menu com a fala pendente aparece desabilitado, com o motivo; sem menu
 *    nenhum, a tela diz onde criar e não salva "tocar o menu" vazio;
 *  - o número que aponta para um time ou menu ARQUIVADO diz isso no cartão, e o
 *    formulário mostra o destino marcado e só salva com outro;
 *  - a recusa da rota aparece com a frase dela; o 504 do proxy, com a frase da
 *    tela — nunca o HTML, nunca a senha;
 *  - a criação manda `Idempotency-Key`, a MESMA ao repetir o mesmo formulário
 *    (a resposta que se perdeu) e outra quando o formulário muda;
 *  - a lista de menus que não carregou é dita, e não vira "nenhum menu"; a lista
 *    de NÚMEROS que não carregou também não vira "nenhum número conectado";
 *  - o salvar que falhou relê a lista de números (a resposta perdida de um número
 *    que foi criado aparece na hora);
 *  - o motivo do bloqueio descreve o seletor e o botão (`aria-describedby`);
 *  - "Criar um menu" abre a aba Menus em OUTRA aba, sem descartar o formulário,
 *    e a lista de menus é relida quando a pessoa volta.
 */
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { makeQueryClient } from "@/lib/query/client";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { CanalTelefoneClient } from "./CanalTelefoneClient";

const T_SUPORTE = "11111111-1111-4111-8111-111111111111";
const T_FINANCEIRO = "22222222-2222-4222-8222-222222222222";
const T_ANTIGO = "33333333-3333-4333-8333-333333333333";
const SENHA = "senha-sip-de-teste";
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

/** O recorte de `MenuPublico` que a aba Números lê: id, nome e se pode ser ligado a um número. */
const menu = (id: string, nome: string, pronto = true) => ({
  id,
  nome,
  time_padrao_id: T_SUPORTE,
  time_padrao_nome: "Suporte",
  opcoes: [],
  fala: null,
  fala_invalida: null,
  pronto,
  numeros: [],
  ultimos_7_dias: { total: 0, por_tecla: {}, sem_escolha: 0, tecla_errada: 0, desligou_no_menu: 0 },
});

interface Numero {
  id: string;
  nome: string;
  numero: string;
  servidor: string;
  porta: number;
  transporte: "udp" | "tcp";
  usuario: string;
  prefixo: string | null;
  time_id: string | null;
  time_nome: string | null;
  time_arquivado: boolean;
  menu_id: string | null;
  menu_nome: string | null;
  menu_arquivado: boolean;
  status: string;
  status_reason: string | null;
}

const numero = (extra: Partial<Numero> = {}): Numero => ({
  id: "n1",
  nome: "Totus 3025",
  numero: "+556136861503",
  servidor: "voip.totussistema.com.br",
  porta: 5060,
  transporte: "udp",
  usuario: "6136861503",
  prefixo: "0",
  time_id: T_SUPORTE,
  time_nome: "Suporte",
  time_arquivado: false,
  menu_id: null,
  menu_nome: null,
  menu_arquivado: false,
  status: "WORKING",
  status_reason: null,
  ...extra,
});

interface Servidor {
  numeros: Numero[];
  menus: ReturnType<typeof menu>[];
  times: ReturnType<typeof time>[];
}
let servidor: Servidor;
type Rota = (corpo: Record<string, unknown>) => Response | Promise<Response>;
/** Respostas trocadas, na ordem: cada chamada à rota consome a primeira da fila. */
const trocadas = new Map<string, Rota[]>();

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
}
const dados = (d: unknown, status = 200) => json(status, { data: d });
const recusa = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const proxy = (status: number) => new Response(HTML_DO_PROXY, { status, headers: { "Content-Type": "text/html" } });

/** O número como a rota o devolve depois de gravar: com os nomes do destino (como `numerosDaOrg`). */
function gravar(n: Numero, c: Record<string, unknown>): Numero {
  const t = servidor.times.find((x) => x.id === c.time_id);
  const m = servidor.menus.find((x) => x.id === c.menu_id);
  return Object.assign(n, {
    nome: String(c.nome),
    time_id: (c.time_id as string | null) ?? null,
    time_nome: t?.name ?? null,
    time_arquivado: false,
    menu_id: (c.menu_id as string | null) ?? null,
    menu_nome: m?.nome ?? null,
    menu_arquivado: false,
  });
}

function rotaPadrao(metodo: string, url: string): Rota | null {
  if (metodo === "GET" && url === "/api/v1/telefonia/numeros") {
    return () => dados(structuredClone({ oferecida: true, numeros: servidor.numeros }));
  }
  if (metodo === "GET" && url === "/api/v1/telefonia/menus") {
    return () => dados(structuredClone({ oferecida: true, menus: servidor.menus }));
  }
  if (metodo === "GET" && url === "/api/v1/conversations/teams") return () => dados(structuredClone(servidor.times));
  if (metodo === "POST" && url === "/api/v1/telefonia/numeros") {
    return (c) => {
      const novo = gravar(numero({ id: `n${servidor.numeros.length + 1}`, numero: "+556130001111" }), c);
      servidor.numeros.push(novo);
      return dados(novo, 201);
    };
  }
  const um = /^\/api\/v1\/telefonia\/numeros\/([^/]+)$/.exec(url);
  if (metodo === "PATCH" && um) {
    return (c) => {
      const n = servidor.numeros.find((x) => x.id === um[1]);
      return n ? dados(gravar(n, c)) : recusa(404, "nao_encontrado", "Número não encontrado.");
    };
  }
  return null;
}

const fetchFalso = vi.fn(async (url: string, init: RequestInit = {}) => {
  const metodo = init.method ?? "GET";
  const corpo = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const fila = trocadas.get(`${metodo} ${url}`);
  const rota = (fila && fila.length > 0 ? fila.shift() : undefined) ?? rotaPadrao(metodo, url);
  if (!rota) throw new Error(`rota inesperada: ${metodo} ${url}`);
  return rota(corpo);
});

/** As chamadas que a tela fez a uma rota: o corpo e os cabeçalhos. */
function chamadas(metodo: string, url: string): { corpo: Record<string, unknown>; headers: Record<string, string> }[] {
  return fetchFalso.mock.calls
    .filter(([u, i]) => u === url && (i?.method ?? "GET") === metodo)
    .map(([, i]) => ({
      corpo: typeof i?.body === "string" ? (JSON.parse(i.body) as Record<string, unknown>) : {},
      headers: (i?.headers ?? {}) as Record<string, string>,
    }));
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

function pintar(
  envolver: (filho: ReactNode) => ReactNode = (f) => f,
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  render(<QueryClientProvider client={qc}>{envolver(<CanalTelefoneClient />)}</QueryClientProvider>);
  return qc;
}

async function cartaoDo(nome: string): Promise<HTMLElement> {
  return (await screen.findByText(nome)).closest("[data-telefonia-numero]") as HTMLElement;
}

async function editar(user: ReturnType<typeof usuario>, nome = "Totus 3025", rotulo = "Editar"): Promise<HTMLElement> {
  await user.click(within(await cartaoDo(nome)).getByRole("button", { name: rotulo }));
  return document.querySelector("[data-telefonia-formulario]") as HTMLElement;
}

async function escolher(user: ReturnType<typeof usuario>, combobox: HTMLElement, opcao: string) {
  await user.click(combobox);
  await user.click(await screen.findByRole("option", { name: opcao }));
}

const destino = (f: HTMLElement) => within(f).getByRole("combobox", { name: "Quando ligarem" });
const seletorDeTime = (f: HTMLElement) => within(f).getByRole("combobox", { name: "Time que recebe as ligações" });
const seletorDeMenu = (f: HTMLElement) => within(f).getByRole("combobox", { name: "Menu que atende as ligações" });
const salvarDe = (f: HTMLElement) => within(f).getByRole("button", { name: /Salvar e conectar|Salvando/ });

beforeEach(() => {
  trocadas.clear();
  fetchFalso.mockClear();
  for (const f of Object.values(toast)) f.mockClear();
  vi.stubGlobal("fetch", fetchFalso);
  servidor = {
    numeros: [numero()],
    menus: [menu("m1", "Principal"), menu("m2", "Noturno", false)],
    times: [time(T_SUPORTE, "Suporte"), time(T_FINANCEIRO, "Financeiro"), time(T_ANTIGO, "Cobrança antiga", true)],
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  focusManager.setFocused(undefined);
});

describe("Quando ligarem — o número toca o time OU o menu", () => {
  it(
    "o cartão diz o menu, e salvar sem mexer mantém o menu (e só ele)",
    async () => {
      servidor.numeros = [numero({ time_id: null, time_nome: null, menu_id: "m1", menu_nome: "Principal" })];
      const user = usuario();
      pintar();
      const cartao = await cartaoDo("Totus 3025");
      expect(cartao).toHaveTextContent("Quando ligarem: menu Principal");
      expect(cartao).not.toHaveTextContent("Recebe:");

      const f = await editar(user);
      expect(destino(f)).toHaveTextContent("Tocar o menu");
      await waitFor(() => expect(seletorDeMenu(f)).toHaveTextContent("Principal"));
      expect(within(f).queryByRole("combobox", { name: "Time que recebe as ligações" })).toBeNull();

      await user.click(salvarDe(f));
      await waitFor(() => expect(chamadas("PATCH", "/api/v1/telefonia/numeros/n1")).toHaveLength(1));
      expect(chamadas("PATCH", "/api/v1/telefonia/numeros/n1")[0]!.corpo).toMatchObject({ menu_id: "m1", time_id: null });
    },
    TETO_MS,
  );

  it(
    "de 'tocar no time' para 'tocar o menu': o menu com a fala pendente aparece desabilitado, com o motivo, e o PATCH leva só o menu",
    async () => {
      const user = usuario();
      pintar();
      expect(await cartaoDo("Totus 3025")).toHaveTextContent("Recebe: Suporte");

      const f = await editar(user);
      expect(destino(f)).toHaveTextContent("Tocar no time");
      expect(seletorDeTime(f)).toHaveTextContent("Suporte");

      await escolher(user, destino(f), "Tocar o menu");
      // Tocar o menu sem escolher qual: não há o que salvar.
      expect(salvarDe(f)).toBeDisabled();

      await user.click(seletorDeMenu(f));
      expect(await screen.findByRole("option", { name: "Noturno — fala pendente" })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("option", { name: "Escolha o menu" })).toHaveAttribute("aria-disabled", "true");
      await user.click(screen.getByRole("option", { name: "Principal" }));
      expect(salvarDe(f)).toBeEnabled();

      await user.click(salvarDe(f));
      await waitFor(() => expect(chamadas("PATCH", "/api/v1/telefonia/numeros/n1")).toHaveLength(1));
      const corpo = chamadas("PATCH", "/api/v1/telefonia/numeros/n1")[0]!.corpo;
      expect(corpo).toMatchObject({ menu_id: "m1", time_id: null });
      expect(corpo).not.toHaveProperty("senha");

      await waitFor(() => expect(document.querySelector("[data-telefonia-formulario]")).toBeNull());
      await waitFor(() => expect(screen.getByText(/Quando ligarem: menu Principal/)).toBeInTheDocument());
      expect(toast.success).toHaveBeenCalledWith("Número salvo. Conectando à operadora…");
    },
    TETO_MS,
  );

  it(
    "de 'tocar o menu' para 'tocar no time': o PATCH leva só o time — nunca os dois",
    async () => {
      servidor.numeros = [numero({ time_id: null, time_nome: null, menu_id: "m1", menu_nome: "Principal" })];
      const user = usuario();
      pintar();
      const f = await editar(user);
      await escolher(user, destino(f), "Tocar no time");
      await escolher(user, seletorDeTime(f), "Financeiro");
      await user.click(salvarDe(f));

      await waitFor(() => expect(chamadas("PATCH", "/api/v1/telefonia/numeros/n1")).toHaveLength(1));
      expect(chamadas("PATCH", "/api/v1/telefonia/numeros/n1")[0]!.corpo).toMatchObject({
        time_id: T_FINANCEIRO,
        menu_id: null,
      });
      await waitFor(() => expect(screen.getByText("Recebe: Financeiro")).toBeInTheDocument());
    },
    TETO_MS,
  );

  it(
    "sem menu criado: diz onde criar e não salva 'tocar o menu' vazio",
    async () => {
      servidor.menus = [];
      const user = usuario();
      pintar();
      const f = await editar(user);
      await escolher(user, destino(f), "Tocar o menu");

      expect(await within(f).findByText("Nenhum menu criado ainda. Crie um na aba Menus.")).toBeInTheDocument();
      expect(within(f).getByRole("link", { name: "Criar um menu" })).toHaveAttribute(
        "href",
        "/app/connections?aba=telefone&sub=menus",
      );
      expect(salvarDe(f)).toBeDisabled();
    },
    TETO_MS,
  );

  it(
    "a lista de menus não carregou: a tela diz, e não finge que não há menu",
    async () => {
      trocadas.set("GET /api/v1/telefonia/menus", [() => proxy(504)]);
      const user = usuario();
      pintar();
      const f = await editar(user);
      await escolher(user, destino(f), "Tocar o menu");
      expect(await within(f).findByText("Não foi possível carregar os menus. Recarregue a página.")).toBeInTheDocument();
      expect(within(f).queryByText("Nenhum menu criado ainda. Crie um na aba Menus.")).toBeNull();
      expect(document.body.textContent).not.toContain("Gateway");
    },
    TETO_MS,
  );
});

describe("Quando ligarem — o destino arquivado", () => {
  it(
    "time ARQUIVADO: o cartão diz; o formulário mostra o time marcado e só salva com outro",
    async () => {
      servidor.numeros = [numero({ time_id: T_ANTIGO, time_nome: "Cobrança antiga", time_arquivado: true })];
      const user = usuario();
      pintar();
      const cartao = await cartaoDo("Totus 3025");
      expect(cartao.querySelector("[data-destino-arquivado]")).toHaveTextContent(
        "O time deste número foi arquivado e não recebe ligações. Edite o número e escolha outro time.",
      );

      const f = await editar(user);
      await waitFor(() => expect(seletorDeTime(f)).toHaveTextContent("Cobrança antiga — arquivado"));
      expect(salvarDe(f)).toBeDisabled();
      expect(f.querySelector("[data-destino-bloqueado]")).toHaveTextContent(
        "O time escolhido foi arquivado e não recebe ligações. Escolha outro time.",
      );
      // O time arquivado não é opção válida: aparece só como o valor de agora, desabilitado.
      await user.click(seletorDeTime(f));
      expect(await screen.findByRole("option", { name: "Cobrança antiga — arquivado" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await user.click(screen.getByRole("option", { name: "Suporte" }));

      expect(f.querySelector("[data-destino-bloqueado]")).toBeNull();
      await user.click(salvarDe(f));
      await waitFor(() => expect(chamadas("PATCH", "/api/v1/telefonia/numeros/n1")).toHaveLength(1));
      expect(chamadas("PATCH", "/api/v1/telefonia/numeros/n1")[0]!.corpo).toMatchObject({ time_id: T_SUPORTE, menu_id: null });
    },
    TETO_MS,
  );

  it("time arquivado há pouco (a lista de times já sabe, a do número ainda não): o cartão também diz", async () => {
    servidor.numeros = [numero({ time_id: T_ANTIGO, time_nome: "Cobrança antiga", time_arquivado: false })];
    pintar();
    const cartao = await cartaoDo("Totus 3025");
    await waitFor(() => expect(cartao.querySelector("[data-destino-arquivado]")).not.toBeNull());
  });

  it(
    "menu ARQUIVADO: o cartão diz; o formulário mostra o menu marcado e só salva com outro destino",
    async () => {
      servidor.numeros = [
        numero({ time_id: null, time_nome: null, menu_id: "m9", menu_nome: "Antigo", menu_arquivado: true }),
      ];
      const user = usuario();
      pintar();
      const cartao = await cartaoDo("Totus 3025");
      expect(cartao).toHaveTextContent("Quando ligarem: menu Antigo");
      expect(cartao.querySelector("[data-destino-arquivado]")).toHaveTextContent(
        "O menu deste número foi arquivado e não atende mais as ligações. Edite o número e escolha outro destino.",
      );

      const f = await editar(user);
      await waitFor(() => expect(seletorDeMenu(f)).toHaveTextContent("Antigo — arquivado"));
      expect(salvarDe(f)).toBeDisabled();
      expect(f.querySelector("[data-destino-bloqueado]")).toHaveTextContent(
        "O menu escolhido foi arquivado. Escolha outro menu ou toque no time.",
      );

      await escolher(user, seletorDeMenu(f), "Principal");
      expect(salvarDe(f)).toBeEnabled();
      await user.click(salvarDe(f));
      await waitFor(() => expect(chamadas("PATCH", "/api/v1/telefonia/numeros/n1")).toHaveLength(1));
      expect(chamadas("PATCH", "/api/v1/telefonia/numeros/n1")[0]!.corpo).toMatchObject({ menu_id: "m1", time_id: null });
    },
    TETO_MS,
  );
});

describe("Quando ligarem — o menu de agora com a fala pendente", () => {
  it(
    "o menu do número ficou com a fala pendente: o seletor o marca, e o motivo trava o salvar e descreve o seletor e o botão",
    async () => {
      servidor.numeros = [numero({ time_id: null, time_nome: null, menu_id: "m1", menu_nome: "Principal" })];
      servidor.menus = [menu("m1", "Principal", false)];
      const user = usuario();
      pintar();
      const f = await editar(user);
      await waitFor(() => expect(seletorDeMenu(f)).toHaveTextContent("Principal — fala pendente"));
      const motivo = "A fala deste menu ainda não está pronta. Gere a prévia e salve o menu na aba Menus.";
      expect(f.querySelector("[data-destino-bloqueado]")).toHaveTextContent(motivo);
      expect(salvarDe(f)).toBeDisabled();
      expect(seletorDeMenu(f)).toHaveAccessibleDescription(motivo);
      expect(salvarDe(f)).toHaveAccessibleDescription(motivo);
    },
    TETO_MS,
  );

  it(
    "o motivo do time arquivado descreve o seletor de time; escolhido outro, a descrição sai",
    async () => {
      servidor.numeros = [numero({ time_id: T_ANTIGO, time_nome: "Cobrança antiga", time_arquivado: true })];
      const user = usuario();
      pintar();
      const f = await editar(user);
      const motivo = "O time escolhido foi arquivado e não recebe ligações. Escolha outro time.";
      await waitFor(() => expect(seletorDeTime(f)).toHaveAccessibleDescription(motivo));
      expect(salvarDe(f)).toHaveAccessibleDescription(motivo);

      await escolher(user, seletorDeTime(f), "Suporte");
      expect(seletorDeTime(f)).not.toHaveAttribute("aria-describedby");
      expect(salvarDe(f)).not.toHaveAttribute("aria-describedby");
    },
    TETO_MS,
  );
});

describe("Quando ligarem — criar um menu sem perder o formulário", () => {
  it(
    "o link abre a aba Menus em OUTRA aba, e a lista de menus é relida quando a pessoa volta",
    async () => {
      servidor.menus = [];
      const user = usuario();
      // O cliente da APLICAÇÃO (refetchOnWindowFocus: false por padrão): a releitura
      // ao voltar tem de ser pedida por esta tela.
      pintar((x) => x, makeQueryClient());
      const f = await editar(user);
      await user.type(within(f).getByLabelText("Senha"), SENHA);
      await escolher(user, destino(f), "Tocar o menu");

      const link = await within(f).findByRole("link", { name: "Criar um menu" });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener");

      // Na outra aba, a pessoa cria o menu; volta a esta.
      servidor.menus = [menu("m1", "Principal")];
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await waitFor(() => expect(within(f).queryByText("Nenhum menu criado ainda. Crie um na aba Menus.")).toBeNull());
      await escolher(user, seletorDeMenu(f), "Principal");
      // O formulário ficou: a senha digitada segue no campo.
      expect(within(f).getByLabelText("Senha")).toHaveValue(SENHA);
      expect(salvarDe(f)).toBeEnabled();
    },
    TETO_MS,
  );
});

describe("Quando ligarem — recusas e a criação", () => {
  it(
    "a lista de números não carregou: a tela diz, e não finge que não há número",
    async () => {
      trocadas.set("GET /api/v1/telefonia/numeros", [() => proxy(504)]);
      pintar();
      expect(await screen.findByText("Não foi possível carregar os números. Recarregue a página.")).toBeInTheDocument();
      expect(screen.queryByText("Nenhum número conectado ainda.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Adicionar número" })).toBeNull();
      expect(document.body.textContent).not.toContain("Gateway");
    },
    TETO_MS,
  );

  it(
    "a resposta da criação se perdeu, mas o número foi criado: a lista é relida e o número aparece na hora",
    async () => {
      trocadas.set("POST /api/v1/telefonia/numeros", [
        (c) => {
          // O servidor gravou; a resposta nunca chegou.
          servidor.numeros.push(gravar(numero({ id: "n2", numero: "+556130001111" }), c));
          throw new TypeError("Failed to fetch");
        },
      ]);
      const user = usuario();
      pintar();
      await user.click(await screen.findByRole("button", { name: "Adicionar outro número" }));
      const f = document.querySelector("[data-telefonia-formulario]") as HTMLElement;
      await user.type(within(f).getByLabelText("Nome"), "Central");
      await user.type(within(f).getByLabelText("Número"), "(61) 3000-1111");
      await user.type(within(f).getByLabelText("Servidor SIP"), "voip.operadora.com.br");
      await user.type(within(f).getByLabelText("Usuário"), "6130001111");
      await user.type(within(f).getByLabelText("Senha"), SENHA);
      await user.click(salvarDe(f));

      expect(await within(f).findByRole("alert")).toHaveTextContent(
        "Não foi possível salvar o número. Tente de novo em instantes.",
      );
      // O número criado aparece enquanto o formulário segue aberto, com a falha.
      expect(await cartaoDo("Central")).toHaveTextContent("Nenhum time recebe as ligações deste número");
      expect(document.querySelector("[data-telefonia-formulario]")).not.toBeNull();
    },
    TETO_MS,
  );

  it(
    "a recusa da rota aparece com a frase dela; o 504 do proxy, com a frase da tela — nunca o HTML, nunca a senha",
    async () => {
      const frase =
        "A fala desse menu ainda não está pronta. Gere a prévia e salve o menu na aba Menus antes de ligar o menu ao número.";
      trocadas.set("PATCH /api/v1/telefonia/numeros/n1", [
        () => recusa(422, "menu_com_fala_pendente", frase),
        () => proxy(504),
      ]);
      const user = usuario();
      pintar();
      const f = await editar(user);
      await user.type(within(f).getByLabelText("Senha"), SENHA);
      await escolher(user, destino(f), "Tocar o menu");
      await escolher(user, seletorDeMenu(f), "Principal");

      await user.click(salvarDe(f));
      expect(await within(f).findByRole("alert")).toHaveTextContent(frase);
      // O formulário fica aberto, com o que a pessoa escolheu.
      expect(document.querySelector("[data-telefonia-formulario]")).not.toBeNull();
      expect(seletorDeMenu(f)).toHaveTextContent("Principal");

      await user.click(salvarDe(f));
      await waitFor(() =>
        expect(within(f).getByRole("alert")).toHaveTextContent("Não foi possível salvar o número. Tente de novo em instantes."),
      );
      expect(document.body.textContent).not.toContain("Gateway");
      expect(document.body.textContent).not.toContain("<html");
      expect(document.body.textContent).not.toContain(SENHA);
      expect(toast.error).not.toHaveBeenCalled();
    },
    TETO_MS,
  );

  it(
    "número novo tocando o menu: Idempotency-Key a MESMA ao repetir o formulário, outra quando ele muda",
    async () => {
      trocadas.set("POST /api/v1/telefonia/numeros", [
        () => {
          throw new TypeError("Failed to fetch");
        },
        () => proxy(504),
      ]);
      const user = usuario();
      pintar();
      await user.click(await screen.findByRole("button", { name: "Adicionar outro número" }));
      const f = document.querySelector("[data-telefonia-formulario]") as HTMLElement;
      await user.type(within(f).getByLabelText("Nome"), "Central");
      await user.type(within(f).getByLabelText("Número"), "(61) 3000-1111");
      await user.type(within(f).getByLabelText("Servidor SIP"), "voip.operadora.com.br");
      await user.type(within(f).getByLabelText("Usuário"), "6130001111");
      await user.type(within(f).getByLabelText("Senha"), SENHA);
      await escolher(user, destino(f), "Tocar o menu");
      await escolher(user, seletorDeMenu(f), "Principal");

      await user.click(salvarDe(f));
      expect(await within(f).findByRole("alert")).toHaveTextContent(
        "Não foi possível salvar o número. Tente de novo em instantes.",
      );
      await user.click(salvarDe(f));
      await waitFor(() => expect(chamadas("POST", "/api/v1/telefonia/numeros")).toHaveLength(2));

      // A pessoa corrige a senha: é outro formulário, e outra chave.
      await user.type(within(f).getByLabelText("Senha"), "2");
      await user.click(salvarDe(f));
      await waitFor(() => expect(chamadas("POST", "/api/v1/telefonia/numeros")).toHaveLength(3));

      const [a, b, c] = chamadas("POST", "/api/v1/telefonia/numeros");
      expect(a!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(b!.headers["Idempotency-Key"]).toBe(a!.headers["Idempotency-Key"]);
      expect(c!.headers["Idempotency-Key"]).not.toBe(a!.headers["Idempotency-Key"]);
      expect(c!.corpo).toMatchObject({ menu_id: "m1", time_id: null, nome: "Central" });

      await waitFor(() => expect(document.querySelector("[data-telefonia-formulario]")).toBeNull());
      expect(await cartaoDo("Central")).toHaveTextContent("Quando ligarem: menu Principal");
    },
    TETO_MS,
  );
});

describe("Quando ligarem — em espanhol", () => {
  it(
    "o cartão, a escolha do destino e o aviso de arquivado saem no espanhol do dicionário",
    async () => {
      servidor.numeros = [
        numero({ time_id: null, time_nome: null, menu_id: "m1", menu_nome: "Principal" }),
        numero({ id: "n2", nome: "Recepção", time_id: T_ANTIGO, time_nome: "Cobrança antiga", time_arquivado: true }),
      ];
      const user = usuario();
      pintar((f) => <IdiomaProvider locale="es">{f}</IdiomaProvider>);
      expect(await cartaoDo("Totus 3025")).toHaveTextContent("Cuando llamen: menú Principal");
      expect((await cartaoDo("Recepção")).querySelector("[data-destino-arquivado]")).toHaveTextContent(
        "El equipo de este número fue archivado y no recibe llamadas. Edita el número y elige otro equipo.",
      );

      const f = await editar(user, "Totus 3025");
      const quando = within(f).getByRole("combobox", { name: "Cuando llamen" });
      expect(quando).toHaveTextContent("Reproducir el menú");
      await user.click(quando);
      expect(await screen.findByRole("option", { name: "Sonar en el equipo" })).toBeInTheDocument();
    },
    TETO_MS,
  );
});
