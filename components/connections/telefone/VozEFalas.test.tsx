/**
 * A ABA VOZ E FALAS (desenho da fase 2, §4 e §6.2), medida pelo que a pessoa vê
 * e pelo que a tela manda à API.
 *
 * O `apiClient` é o de VERDADE, sobre um `fetch` simulado que responde como as
 * rotas respondem: cada falha chega à tela na forma que o cliente entrega — o
 * 429 da cota com `Retry-After` de uma hora (que o cliente lança na hora, sem
 * esperar), o corpo `{ error: { code, message } }` das nossas rotas, e o 504 de
 * um proxy com HTML, cuja "mensagem" o cliente inventa e a tela não pode mostrar.
 *
 * O que se prova:
 *  - sem a chave, diz onde cadastrar; telefonia desligada, o cartão de sempre;
 *  - as três falas gerais com o texto sugerido, cada campo com o nome da SUA fala;
 *  - o ESTADO sempre à vista, e a falha da prévia ao lado do "Em uso", sem
 *    apagá-lo (a fala em uso continua tocando); a falha some ao editar o texto;
 *  - "Salvar e usar" só com a prévia do texto do campo, com o hash dela; editar o
 *    texto ou trocar a voz pede prévia de novo;
 *  - enquanto salva, "Gerar prévia" e o campo ficam travados (nada de pagar uma
 *    prévia no meio do salvar, nem perder o que se digitou);
 *  - cota estourada, prévia paga e não guardada, `previa_ausente`, 409 e 504:
 *    cada um com a frase que diz o que fazer.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { MENSAGEM_DA_FALHA_DA_FALA, type FalaGeral, type FalaPublica } from "@/lib/telefonia/vocabulario";
import { TEXTO_SUGERIDO } from "@/lib/telefonia/texto-do-menu";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
// Os tocadores têm teste próprio; aqui basta saber QUAL deles a tela mostra, e com o quê.
vi.mock("@/components/telefonia/OuvirFala", () => ({
  OuvirFala: ({ falaId, nome }: { falaId: string; nome?: string }) => <span data-ouvir-fala={falaId} data-nome={nome} />,
}));
vi.mock("@/components/telefonia/OuvirPrevia", () => ({
  OuvirPrevia: ({ audio, nome }: { audio: Uint8Array; nome?: string }) => (
    <span data-ouvir-previa={audio.length} data-nome={nome} />
  ),
}));

import { VozEFalas } from "./VozEFalas";

const HASH = "d".repeat(64);
const HASH_EM_USO = "e".repeat(64);
const HTML_DO_PROXY = "<html><body><h1>504 Gateway Time-out</h1><p>nginx</p></body></html>";

// ─── O servidor simulado ─────────────────────────────────────────────────────

interface VozNoServidor {
  oferecida: boolean;
  chave: { cadastrada: boolean; last4: string | null };
  voz: { voice_id: string; model_id: string } | null;
  falas: Record<FalaGeral, FalaPublica | null>;
}

let voz: VozNoServidor;
let canais: unknown[];
type Rota = (corpo: Record<string, unknown>) => Response | Promise<Response>;
const trocadas = new Map<string, Rota>();

function json(status: number, corpo: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", ...headers } });
}
const dados = (d: unknown) => json(200, { data: d });
/** A recusa como `fail()` a escreve: `{ error: { code, message, details? } }`. */
const recusa = (status: number, code: string, message?: string, extra: object = {}, headers: Record<string, string> = {}) =>
  json(status, { error: { code, ...(message ? { message } : {}), ...extra } }, headers);
const proxy = (status: number) => new Response(HTML_DO_PROXY, { status, headers: { "Content-Type": "text/html" } });

function falaEmUso(extra: Partial<FalaPublica> = {}): FalaPublica {
  return {
    id: "fala-1",
    tipo: "nobody",
    texto: "Ninguém pôde atender agora.",
    voice_id: "v1",
    hash: HASH_EM_USO,
    status: "ready",
    erro: null,
    duracao_ms: 2000,
    atualizada_em: "2026-09-29T10:00:00.000Z",
    ...extra,
  };
}

function rotaPadrao(metodo: string, url: string): Rota | null {
  if (metodo === "GET" && url === "/api/v1/telefonia/voz") return () => dados(structuredClone(voz));
  if (metodo === "GET" && url === "/api/v1/telefonia/voz/vozes") {
    return () =>
      dados({
        vozes: [
          { voice_id: "v1", nome: "Ana", categoria: null, amostra_url: null },
          { voice_id: "v2", nome: "Bruno", categoria: null, amostra_url: null },
        ],
      });
  }
  if (metodo === "GET" && url === "/api/v1/channel-sessions") return () => json(200, { data: canais });
  if (metodo === "POST" && url === "/api/v1/telefonia/falas/previa") {
    return () => dados({ hash: HASH, duracao_ms: 1000, reaproveitada: false, audio_base64: "//8=" });
  }
  if (metodo === "PUT" && url === "/api/v1/telefonia/voz") {
    return (c) => {
      voz.voz = { voice_id: String(c.voice_id), model_id: "eleven_multilingual_v2" };
      return dados({ voice_id: c.voice_id });
    };
  }
  const geral = /^\/api\/v1\/telefonia\/falas\/gerais\/(waiting|nobody|after_hours)$/.exec(url);
  if (metodo === "PUT" && geral) {
    const tipo = geral[1] as FalaGeral;
    return (c) => {
      const fala = falaEmUso({
        id: `fala-${tipo}`,
        tipo,
        texto: String(c.texto),
        hash: String(c.hash),
        voice_id: voz.voz?.voice_id ?? "v1",
      });
      voz.falas[tipo] = fala;
      return dados({ fala });
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

/** Radix Select em jsdom é caro, e o custo varia com a carga da máquina (ver EndForm.test.tsx). */
const TETO_MS = 30_000;
const usuario = () => userEvent.setup({ delay: null });

function pintar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <VozEFalas />
    </QueryClientProvider>,
  );
  return qc;
}

async function cartao(tipo: FalaGeral): Promise<HTMLElement> {
  await screen.findByText("Fora do horário");
  return document.querySelector(`[data-fala-geral="${tipo}"]`) as HTMLElement;
}

const gerarDe = (c: HTMLElement) => within(c).getByRole("button", { name: /Gerar prévia|Gerando a prévia/ });
const salvarDe = (c: HTMLElement) => within(c).getByRole("button", { name: /Salvar e usar|Salvando/ });
const campoDe = (c: HTMLElement) => within(c).getByRole("textbox");
/** O estado da FALA (o que as ligações tocam, ou a prévia pendente). */
const estadoDe = (c: HTMLElement) => c.querySelector("[data-estado-da-fala]")?.getAttribute("data-estado-da-fala");
/** O que está acontecendo com a PRÉVIA agora (gerando, falhou), ao lado do estado da fala. */
const previaDe = (c: HTMLElement) => c.querySelector("[data-estado-da-previa]")?.getAttribute("data-estado-da-previa") ?? null;

beforeEach(() => {
  trocadas.clear();
  fetchFalso.mockClear();
  vi.stubGlobal("fetch", fetchFalso);
  canais = [];
  voz = {
    oferecida: true,
    chave: { cadastrada: true, last4: "1234" },
    voz: { voice_id: "v1", model_id: "eleven_multilingual_v2" },
    falas: { waiting: null, nobody: null, after_hours: null, recording_notice: null },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("aba Voz e falas — o que aparece antes de qualquer fala", () => {
  it("sem a chave da ElevenLabs: explica e aponta para Credenciais de IA, sem cartão de fala", async () => {
    voz.chave = { cadastrada: false, last4: null };
    pintar();
    const link = await screen.findByRole("link", { name: "Cadastrar a chave em Credenciais de IA" });
    expect(link).toHaveAttribute("href", "/app/ai/credentials");
    expect(document.querySelectorAll("[data-fala-geral]")).toHaveLength(0);
  });

  it("telefonia desligada na instalação: o mesmo cartão da aba Números", async () => {
    voz.oferecida = false;
    pintar();
    expect(await screen.findByText("Telefonia desligada nesta instalação")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-fala-geral]")).toHaveLength(0);
  });

  it("a leitura falhou: diz que falhou, e não que falta a chave", async () => {
    trocadas.set("GET /api/v1/telefonia/voz", () => recusa(500, "internal_error", "Erro interno."));
    pintar();
    expect(await screen.findByText("Não foi possível carregar a voz do telefone. Recarregue a página.")).toBeInTheDocument();
    expect(screen.queryByText("Falta a chave da ElevenLabs")).toBeNull();
  });

  it("a ElevenLabs fora do ar ao listar as vozes: a frase da rota, e não 'confira a chave'", async () => {
    trocadas.set("GET /api/v1/telefonia/voz/vozes", () =>
      recusa(502, "sem_resposta", MENSAGEM_DA_FALHA_DA_FALA.sem_resposta),
    );
    pintar();
    expect(await screen.findByText(MENSAGEM_DA_FALHA_DA_FALA.sem_resposta)).toBeInTheDocument();
    expect(screen.queryByText(/Confira a chave/)).toBeNull();
  });

  it("o proxy devolveu HTML ao listar as vozes: frase nossa, nunca o HTML nem 'HTTP 502'", async () => {
    trocadas.set("GET /api/v1/telefonia/voz/vozes", () => proxy(502));
    pintar();
    expect(
      await screen.findByText("Não foi possível listar as vozes da sua conta da ElevenLabs. Tente de novo em instantes."),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Gateway|nginx|HTTP 50/);
  });

  it("sem voz escolhida: 'Gerar prévia' fica travado e a tela diz por quê", async () => {
    voz.voz = null;
    pintar();
    const c = await cartao("waiting");
    expect(gerarDe(c)).toBeDisabled();
    expect(within(c).getByText("Escolha a voz acima antes de gerar.")).toBeInTheDocument();
  });

  it("cada campo de texto tem o nome da SUA fala (o leitor de tela distingue os três)", async () => {
    pintar();
    await cartao("waiting");
    expect(screen.getByRole("textbox", { name: "Texto da fala: Aguarde" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Texto da fala: Ninguém atendeu" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Texto da fala: Fora do horário" })).toBeInTheDocument();
  });
});

describe("aba Voz e falas — gerar prévia, ouvir, salvar e usar", () => {
  it("as quatro falas com o texto sugerido; 'Salvar e usar' só depois da prévia, e com o hash dela", async () => {
    const post = vi.spyOn(apiClient, "post");
    pintar();
    const c = await cartao("after_hours");
    // As três da fila e o aviso de gravação (0289), que também nasce com o texto sugerido.
    expect(document.querySelectorAll("[data-fala-geral]")).toHaveLength(4);
    expect(campoDe(await cartao("recording_notice"))).toHaveValue(TEXTO_SUGERIDO.recording_notice);
    expect(campoDe(c)).toHaveValue(TEXTO_SUGERIDO.after_hours);
    expect(estadoDe(c)).toBe("ausente");
    expect(salvarDe(c)).toBeDisabled();
    expect(c.querySelector("[data-ouvir-previa]")).toBeNull();

    await userEvent.click(gerarDe(c));
    // A síntese de 1000 caracteres pode passar dos 30 s do prazo padrão de escrita.
    expect(post).toHaveBeenCalledWith(
      "/api/v1/telefonia/falas/previa",
      { texto: TEXTO_SUGERIDO.after_hours },
      { timeoutMs: 60_000 },
    );
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    expect(estadoDe(c)).toBe("previa");
    expect(within(c).getByText("Prévia não salva")).toBeInTheDocument();
    // "Ouvir" toca o áudio que veio na resposta ("//8=" = 2 bytes de μ-law), com o nome da fala.
    const tocador = c.querySelector("[data-ouvir-previa]");
    expect(tocador?.getAttribute("data-ouvir-previa")).toBe("2");
    expect(tocador?.getAttribute("data-nome")).toBe("Fora do horário");

    await userEvent.click(salvarDe(c));
    expect(enviados("PUT", "/api/v1/telefonia/falas/gerais/after_hours")).toEqual([
      { texto: TEXTO_SUGERIDO.after_hours, hash: HASH },
    ]);
    // Salva: a aba relê a voz, e a fala passa a "Em uso", com o áudio SALVO para ouvir.
    await waitFor(() => expect(estadoDe(c)).toBe("em-uso"));
    expect(c.querySelector('[data-ouvir-fala="fala-after_hours"]')).not.toBeNull();
    expect(salvarDe(c)).toBeDisabled();
  });

  it("editar o texto depois da prévia pede prévia de novo, e a prévia antiga some", async () => {
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(gerarDe(c));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    await userEvent.type(campoDe(c), " Obrigado.");
    expect(salvarDe(c)).toBeDisabled();
    expect(c.querySelector("[data-ouvir-previa]")).toBeNull();
    expect(within(c).getByText("Gere a prévia deste texto e ouça antes de salvar.")).toBeInTheDocument();
  });

  it(
    "trocar a voz depois da prévia pede prévia de novo (o hash da prévia é da voz anterior)",
    { timeout: TETO_MS },
    async () => {
      const user = usuario();
      pintar();
      const c = await cartao("waiting");
      await user.click(gerarDe(c));
      await waitFor(() => expect(salvarDe(c)).toBeEnabled());

      await user.click(screen.getByRole("combobox", { name: "Voz" }));
      await user.click(await screen.findByRole("option", { name: "Bruno" }));
      expect(enviados("PUT", "/api/v1/telefonia/voz")).toEqual([{ voice_id: "v2" }]);

      await waitFor(() => expect(salvarDe(c)).toBeDisabled());
      expect(estadoDe(c)).toBe("ausente");
      expect(c.querySelector("[data-ouvir-previa]")).toBeNull();
    },
  );

  it("com um WhatsApp conectado, o 'fora do horário' sugerido já traz o número — e segue editável", async () => {
    canais = [
      { id: "c1", meio: "site_chat", status: "WORKING", phone_number: null },
      { id: "c2", meio: "whatsapp", status: "WORKING", phone_number: "+5561999990000" },
    ];
    pintar();
    const c = await cartao("after_hours");
    await waitFor(() => expect((campoDe(c) as HTMLTextAreaElement).value).toContain("(61) 99999-0000"));
    await userEvent.clear(campoDe(c));
    await userEvent.type(campoDe(c), "Fechado.");
    expect(campoDe(c)).toHaveValue("Fechado.");
  });

  it("enquanto salva, 'Gerar prévia' e o campo ficam travados — e destravam quando o salvar termina", async () => {
    const put = segurada();
    trocadas.set("PUT /api/v1/telefonia/falas/gerais/waiting", put.rota);
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(gerarDe(c));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());

    await userEvent.click(salvarDe(c));
    await waitFor(() => expect(salvarDe(c)).toHaveTextContent("Salvando…"));
    expect(gerarDe(c)).toBeDisabled();
    expect(campoDe(c)).toBeDisabled();
    // Nenhuma prévia nova pode ser paga no meio do salvar.
    await userEvent.click(gerarDe(c));
    expect(enviados("POST", "/api/v1/telefonia/falas/previa")).toHaveLength(1);

    const fala = falaEmUso({ id: "fala-waiting", tipo: "waiting", texto: TEXTO_SUGERIDO.waiting, hash: HASH });
    voz.falas.waiting = fala;
    put.soltar(dados({ fala }));
    await waitFor(() => expect(estadoDe(c)).toBe("em-uso"));
    expect(gerarDe(c)).toBeEnabled();
    expect(campoDe(c)).toBeEnabled();
    expect(campoDe(c)).toHaveValue(TEXTO_SUGERIDO.waiting);
  });

  it("enquanto a prévia é gerada, 'Salvar e usar' fica travado", async () => {
    const previa = segurada();
    trocadas.set("POST /api/v1/telefonia/falas/previa", previa.rota);
    pintar();
    const c = await cartao("nobody");
    await userEvent.click(gerarDe(c));
    await waitFor(() => expect(previaDe(c)).toBe("gerando"));
    expect(gerarDe(c)).toBeDisabled();
    expect(salvarDe(c)).toBeDisabled();
    previa.soltar(dados({ hash: HASH, duracao_ms: 900, reaproveitada: false, audio_base64: "//8=" }));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    expect(previaDe(c)).toBeNull();
  });
});

describe("aba Voz e falas — o estado da fala em uso", () => {
  it("fala salva com a voz atual: 'Em uso', o texto dela no campo e o áudio salvo para ouvir", async () => {
    voz.falas.nobody = falaEmUso();
    pintar();
    const c = await cartao("nobody");
    expect(estadoDe(c)).toBe("em-uso");
    expect(campoDe(c)).toHaveValue("Ninguém pôde atender agora.");
    const tocador = c.querySelector('[data-ouvir-fala="fala-1"]');
    expect(tocador?.getAttribute("data-nome")).toBe("Ninguém atendeu");
    expect(salvarDe(c)).toBeDisabled();
  });

  it("fala salva com OUTRA voz: 'Em uso, com a voz anterior' (as ligações ainda tocam a voz antiga)", async () => {
    voz.falas.nobody = falaEmUso({ voice_id: "v0" });
    pintar();
    const c = await cartao("nobody");
    expect(estadoDe(c)).toBe("outra-voz");
    expect(within(c).getByText("Em uso, com a voz anterior")).toBeInTheDocument();
  });

  it("regerar a prévia do MESMO texto em uso destrava o salvar (é o conserto de um áudio que sumiu)", async () => {
    voz.falas.nobody = falaEmUso();
    trocadas.set("POST /api/v1/telefonia/falas/previa", () =>
      dados({ hash: HASH_EM_USO, duracao_ms: 2100, reaproveitada: false, audio_base64: "//8=" }),
    );
    pintar();
    const c = await cartao("nobody");
    await userEvent.click(gerarDe(c));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    await userEvent.click(salvarDe(c));
    expect(enviados("PUT", "/api/v1/telefonia/falas/gerais/nobody")).toEqual([
      { texto: "Ninguém pôde atender agora.", hash: HASH_EM_USO },
    ]);
  });

  it("a falha da prévia de um texto novo NÃO apaga o 'Em uso' — e some quando a pessoa edita o texto", async () => {
    voz.falas.nobody = falaEmUso();
    trocadas.set("POST /api/v1/telefonia/falas/previa", () =>
      recusa(422, "sem_credito", MENSAGEM_DA_FALHA_DA_FALA.sem_credito),
    );
    pintar();
    const c = await cartao("nobody");
    await userEvent.type(campoDe(c), " Obrigado.");
    await userEvent.click(gerarDe(c));
    await waitFor(() => expect(previaDe(c)).toBe("falhou"));
    expect(within(c).getByText(new RegExp(MENSAGEM_DA_FALHA_DA_FALA.sem_credito.slice(0, 30)))).toBeInTheDocument();
    // A fala salva continua tocando nas ligações: o selo dela fica.
    expect(estadoDe(c)).toBe("em-uso");

    await userEvent.type(campoDe(c), "!");
    expect(previaDe(c)).toBeNull();
    expect(within(c).queryByText(new RegExp(MENSAGEM_DA_FALHA_DA_FALA.sem_credito.slice(0, 30)))).toBeNull();
  });

  it("o estado da fala é anunciado ao leitor de tela sem roubar o foco", async () => {
    pintar();
    const c = await cartao("waiting");
    const estado = c.querySelector("[data-estado-da-fala]")?.closest("[aria-live]");
    expect(estado?.getAttribute("aria-live")).toBe("polite");
  });
});

describe("aba Voz e falas — as falhas aparecem com o que fazer", () => {
  it("429 da cota (Retry-After de 1 h): a frase aparece NA HORA, sem repetir o pedido", async () => {
    trocadas.set("POST /api/v1/telefonia/falas/previa", () =>
      recusa(429, "limite_de_previas", MENSAGEM_DA_FALHA_DA_FALA.limite_de_previas, {}, { "Retry-After": "3600" }),
    );
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(gerarDe(c));
    expect(await within(c).findByText(/Muitas prévias geradas na última hora/)).toBeInTheDocument();
    expect(enviados("POST", "/api/v1/telefonia/falas/previa")).toHaveLength(1);
    expect(previaDe(c)).toBe("falhou");
    expect(estadoDe(c)).toBe("ausente");
    expect(salvarDe(c)).toBeDisabled();
    expect(gerarDe(c)).toBeEnabled();
  });

  it("a prévia foi paga e não guardada (`paga: true`): diz que foi gerada mas não guardada", async () => {
    const frase = "A fala foi gerada, mas não foi guardada. Gerar de novo consome outra geração da ElevenLabs.";
    trocadas.set("POST /api/v1/telefonia/falas/previa", () =>
      recusa(502, "armazenamento", frase, { details: { paga: true } }),
    );
    pintar();
    const c = await cartao("nobody");
    await userEvent.click(gerarDe(c));
    expect(await within(c).findByText(new RegExp(frase.slice(0, 40)))).toBeInTheDocument();
    expect(within(c).queryByText(/Não foi possível gerar a prévia/)).toBeNull();
    expect(salvarDe(c)).toBeDisabled();
  });

  it("o proxy devolveu 504 com HTML na prévia: frase nossa, nunca 'HTTP 504' nem o HTML", async () => {
    trocadas.set("POST /api/v1/telefonia/falas/previa", () => proxy(504));
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(gerarDe(c));
    expect(
      await within(c).findByText(/Não foi possível gerar a prévia. Tente de novo em instantes./),
    ).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/Gateway|nginx|HTTP 50|<html/);
  });

  it("recusa sem frase (código conhecido): a frase do vocabulário, não o código cru", async () => {
    trocadas.set("POST /api/v1/telefonia/falas/previa", () => recusa(422, "sem_credito"));
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(gerarDe(c));
    expect(await within(c).findByText(new RegExp(MENSAGEM_DA_FALHA_DA_FALA.sem_credito.slice(0, 30)))).toBeInTheDocument();
    expect(c.textContent).not.toContain("sem_credito");
  });

  it("salvar recusado por `previa_ausente`: explica 'gere a prévia de novo' e volta a pedir a prévia", async () => {
    trocadas.set("PUT /api/v1/telefonia/falas/gerais/waiting", () =>
      recusa(422, "previa_ausente", MENSAGEM_DA_FALHA_DA_FALA.previa_ausente),
    );
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(gerarDe(c));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    await userEvent.click(salvarDe(c));
    expect(await within(c).findByRole("alert")).toHaveTextContent(/Gere a prévia de novo/);
    expect(salvarDe(c)).toBeDisabled();
    expect(c.querySelector("[data-ouvir-previa]")).toBeNull();
  });

  it("salvar recusado por outra gravação em andamento (409): a prévia continua valendo para tentar de novo", async () => {
    trocadas.set("PUT /api/v1/telefonia/falas/gerais/waiting", () =>
      recusa(409, "gravacao_em_andamento", MENSAGEM_DA_FALHA_DA_FALA.gravacao_em_andamento),
    );
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(gerarDe(c));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    await userEvent.click(salvarDe(c));
    expect(await within(c).findByRole("alert")).toHaveTextContent(/em andamento/);
    expect(salvarDe(c)).toBeEnabled();
  });

  it("o proxy devolveu 504 com HTML no salvar: frase nossa, e a prévia fica para tentar de novo", async () => {
    trocadas.set("PUT /api/v1/telefonia/falas/gerais/waiting", () => proxy(504));
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(gerarDe(c));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    await userEvent.click(salvarDe(c));
    expect(await within(c).findByRole("alert")).toHaveTextContent(
      "Não foi possível salvar a fala. Tente de novo em instantes.",
    );
    expect(c.textContent).not.toMatch(/Gateway|nginx|HTTP 50|<html/);
    expect(salvarDe(c)).toBeEnabled();
  });
});
