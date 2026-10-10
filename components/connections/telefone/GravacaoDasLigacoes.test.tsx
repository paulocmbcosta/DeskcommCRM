/**
 * A ABA GRAVAÇÃO (F3), medida pelo que a pessoa vê e pelo que a tela manda à API.
 * O `apiClient` é o de verdade, sobre um `fetch` simulado que responde como a rota.
 *
 *  - telefonia desligada: o cartão de sempre;
 *  - sem o aviso pronto: diz o porquê, aponta Voz e falas, e o interruptor não liga;
 *  - com o aviso pronto: liga, escolhe a retenção e salva com os dois campos;
 *  - ligada e o aviso sumiu: desligar continua possível;
 *  - a recusa da rota chega à pessoa (showApiError).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FalaPublica } from "@/lib/telefonia/vocabulario";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/telefonia/OuvirFala", () => ({
  OuvirFala: ({ falaId }: { falaId: string }) => <span data-ouvir-fala={falaId} />,
}));

import { showApiError } from "@/components/feedback/ApiErrorToast";

import { GravacaoDasLigacoes } from "./GravacaoDasLigacoes";

const AVISO: FalaPublica = {
  id: "fala-aviso",
  tipo: "recording_notice",
  texto: "Esta ligação poderá ser gravada.",
  voice_id: "v1",
  hash: "a".repeat(64),
  status: "ready",
  erro: null,
  duracao_ms: 2500,
  atualizada_em: "2026-09-29T22:00:00.000Z",
};

let servidor: {
  oferecida: boolean;
  ativa: boolean;
  retencao_dias: number;
  retencoes: number[];
  aviso: FalaPublica | null;
  transcrever: boolean;
  transcricao_com_chave: boolean | null;
};
let respostaDoPut: (corpo: Record<string, unknown>) => Response;

const json = (status: number, corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

const fetchFalso = vi.fn(async (url: string, init: RequestInit = {}) => {
  const metodo = init.method ?? "GET";
  if (metodo === "GET" && url === "/api/v1/telefonia/gravacao") return json(200, { data: structuredClone(servidor) });
  if (metodo === "PUT" && url === "/api/v1/telefonia/gravacao") {
    return respostaDoPut(JSON.parse(String(init.body)) as Record<string, unknown>);
  }
  throw new Error(`rota inesperada: ${metodo} ${url}`);
});

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  fetchFalso.mockClear();
  vi.mocked(showApiError).mockClear();
  vi.stubGlobal("fetch", fetchFalso);
  servidor = {
    oferecida: true,
    ativa: false,
    retencao_dias: 90,
    retencoes: [30, 60, 90, 180, 365, 730, 1825],
    aviso: null,
    transcrever: false,
    transcricao_com_chave: true,
  };
  respostaDoPut = (c) => {
    servidor = { ...servidor, ativa: Boolean(c.ativa), retencao_dias: Number(c.retencao_dias), transcrever: Boolean(c.transcrever) };
    return json(200, { data: { ativa: c.ativa, retencao_dias: c.retencao_dias, transcrever: c.transcrever } });
  };
});

function pintar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <GravacaoDasLigacoes />
    </QueryClientProvider>,
  );
}

const interruptor = () => screen.getByRole("switch", { name: "Gravar as ligações" });
const transcricao = () => screen.getByRole("switch", { name: "Transcrever as ligações gravadas" });
const salvar = () => screen.getByRole("button", { name: "Salvar" });
const puts = () =>
  fetchFalso.mock.calls.filter(([, i]) => i?.method === "PUT").map(([, i]) => JSON.parse(String(i!.body)));

describe("aba Gravação", () => {
  it("telefonia desligada nesta instalação: o cartão de sempre", async () => {
    servidor.oferecida = false;
    pintar();
    expect(await screen.findByText("Telefonia desligada nesta instalação")).toBeInTheDocument();
  });

  it("sem o aviso pronto: explica, aponta Voz e falas, e o interruptor não liga", async () => {
    pintar();
    await screen.findByText("Gravação das ligações");
    expect(document.querySelector('[data-aviso-de-gravacao="ausente"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "Criar o aviso em Voz e falas" })).toHaveAttribute(
      "href",
      "/app/connections?aba=telefone&sub=falas",
    );
    expect(interruptor()).toBeDisabled();
    expect(salvar()).toBeDisabled();
  });

  it("com o aviso pronto: mostra o texto, liga, e salva com a retenção escolhida", async () => {
    servidor.aviso = AVISO;
    pintar();
    await screen.findByText("“Esta ligação poderá ser gravada.”");
    expect(document.querySelector('[data-ouvir-fala="fala-aviso"]')).not.toBeNull();
    const u = userEvent.setup({ delay: null });
    await u.click(interruptor());
    await u.click(screen.getByRole("combobox", { name: "Guardar as gravações por" }));
    await u.click(await screen.findByRole("option", { name: "1 ano" }));
    await u.click(salvar());
    await waitFor(() => expect(puts()).toEqual([{ ativa: true, retencao_dias: 365, transcrever: false }]));
    await waitFor(() => expect(document.querySelector('[data-gravacao-do-telefone="ligada"]')).not.toBeNull());
  }, 30_000);

  it("ligada e o aviso deixou de estar pronto: desligar continua possível", async () => {
    servidor.ativa = true;
    servidor.aviso = { ...AVISO, status: "failed", erro: "sem_credito" };
    pintar();
    await screen.findByText("Gravação das ligações");
    expect(interruptor()).toBeEnabled();
    const u = userEvent.setup({ delay: null });
    await u.click(interruptor());
    await u.click(salvar());
    await waitFor(() => expect(puts()).toEqual([{ ativa: false, retencao_dias: 90, transcrever: false }]));
  });

  it("transcrição: com a gravação desligada o interruptor não liga, e a tela diz por quê", async () => {
    pintar();
    await screen.findByText("Gravação das ligações");
    expect(transcricao()).not.toBeChecked();
    expect(transcricao()).toBeDisabled();
    expect(document.querySelector("[data-transcricao-sem-gravacao]")).not.toBeNull();
    expect(document.querySelector("[data-transcricao-sem-chave]")).toBeNull();
  });

  it("transcrição: sem chave da OpenAI não liga, e aponta onde cadastrar", async () => {
    servidor.ativa = true;
    servidor.aviso = AVISO;
    servidor.transcricao_com_chave = false;
    pintar();
    await screen.findByText("Gravação das ligações");
    expect(transcricao()).toBeDisabled();
    expect(document.querySelector("[data-transcricao-sem-chave]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Abrir os provedores de IA" })).toHaveAttribute("href", "/app/ai/providers");
  });

  it("transcrição: a rota não soube dizer se há chave — a tela não afirma que falta, e deixa tentar", async () => {
    servidor.ativa = true;
    servidor.aviso = AVISO;
    servidor.transcricao_com_chave = null;
    pintar();
    await screen.findByText("Gravação das ligações");
    expect(transcricao()).toBeEnabled();
    expect(document.querySelector("[data-transcricao-sem-chave]")).toBeNull();
  });

  it("transcrição: com a gravação ligada e a chave cadastrada, liga e salva os três campos", async () => {
    servidor.ativa = true;
    servidor.aviso = AVISO;
    pintar();
    await screen.findByText("Gravação das ligações");
    expect(salvar()).toBeDisabled();
    const u = userEvent.setup({ delay: null });
    await u.click(transcricao());
    await u.click(salvar());
    await waitFor(() => expect(puts()).toEqual([{ ativa: true, retencao_dias: 90, transcrever: true }]));
    await waitFor(() => expect(document.querySelector('[data-transcricao-do-telefone="ligada"]')).not.toBeNull());
    const { toast } = await import("sonner");
    expect(toast.success).toHaveBeenCalledWith("Transcrição ligada. As próximas ligações gravadas serão transcritas.");
  });

  it("transcrição: ligar a gravação e a transcrição juntas, num salvar só", async () => {
    servidor.aviso = AVISO;
    pintar();
    await screen.findByText("Gravação das ligações");
    const u = userEvent.setup({ delay: null });
    expect(transcricao()).toBeDisabled();
    await u.click(interruptor());
    expect(transcricao()).toBeEnabled();
    await u.click(transcricao());
    await u.click(salvar());
    await waitFor(() => expect(puts()).toEqual([{ ativa: true, retencao_dias: 90, transcrever: true }]));
  });

  it("transcrição: ligada e a chave sumiu — desligar continua possível", async () => {
    servidor.ativa = true;
    servidor.aviso = AVISO;
    servidor.transcrever = true;
    servidor.transcricao_com_chave = false;
    pintar();
    await screen.findByText("Gravação das ligações");
    expect(transcricao()).toBeChecked();
    expect(transcricao()).toBeEnabled();
    const u = userEvent.setup({ delay: null });
    await u.click(transcricao());
    await u.click(salvar());
    await waitFor(() => expect(puts()).toEqual([{ ativa: true, retencao_dias: 90, transcrever: false }]));
  });

  it("transcrição: a tela avisa para onde vão o áudio E o texto (dois operadores), que custa, que conta no teto e que 'quem falou' é estimativa", async () => {
    pintar();
    await screen.findByText("Gravação das ligações");
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("enviado à OpenAI");
    // O resumo é feito pelo modelo de conversa da organização — que pode ser de outro provedor.
    expect(texto).toContain("o texto que volta vai ao modelo de IA escolhido em Agente de IA › Provedores");
    expect(texto).toContain("cobra por minuto de áudio");
    expect(texto).toContain("contam no teto de gasto de IA");
    expect(texto).toContain("a indicação de quem falou é uma estimativa");
    expect(texto).toContain("as antigas não são transcritas");
  });

  it("a recusa da rota (409 sem aviso) chega à pessoa", async () => {
    servidor.aviso = AVISO;
    respostaDoPut = () => json(409, { error: { code: "aviso_de_gravacao_ausente", message: "Gere o aviso." } });
    pintar();
    await screen.findByText("Gravação das ligações");
    const u = userEvent.setup({ delay: null });
    await u.click(interruptor());
    await u.click(salvar());
    await waitFor(() => expect(showApiError).toHaveBeenCalled());
  });
});
