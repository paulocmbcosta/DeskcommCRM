/**
 * A ABA VOZ E FALAS (desenho da fase 2, §4 e §6.2), medida pelo que a pessoa vê
 * e pelo que a tela manda à API:
 *  - sem a chave, diz onde cadastrar; com a telefonia desligada, o cartão de
 *    sempre; com a leitura falhando, diz que falhou (e não "sem chave");
 *  - as três falas gerais aparecem com o texto sugerido (o de "fora do horário"
 *    com o WhatsApp conectado, quando houver), e o ESTADO de cada uma está sempre
 *    à vista: ainda não gerada, prévia não salva, em uso, em uso com a voz
 *    anterior, falhou com o motivo;
 *  - "Salvar e usar" só destrava com a prévia do texto que está no campo, e manda
 *    o hash DESSA prévia — editar o texto, ou trocar a voz, pede prévia de novo;
 *  - a cota de prévias (429 `limite_de_previas`), a prévia paga e não guardada
 *    (`paga: true`) e o salvar recusado por `previa_ausente` aparecem na tela com
 *    a frase que diz o que fazer.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { FalaPublica } from "@/lib/telefonia/vocabulario";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
// Os tocadores têm teste próprio; aqui basta saber QUAL deles a tela mostra, e com o quê.
vi.mock("@/components/telefonia/OuvirFala", () => ({
  OuvirFala: ({ falaId }: { falaId: string }) => <span data-ouvir-fala={falaId} />,
}));
vi.mock("@/components/telefonia/OuvirPrevia", () => ({
  OuvirPrevia: ({ audio }: { audio: Uint8Array }) => <span data-ouvir-previa={audio.length} />,
}));

const HASH = "d".repeat(64);
const HASH_EM_USO = "e".repeat(64);

const api = vi.hoisted(() => ({
  voz: null as unknown,
  erroDaVoz: null as unknown,
  erroDasVozes: null as unknown,
  canais: [] as unknown[],
  post: vi.fn(),
  put: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) => {
      if (url === "/api/v1/telefonia/voz/vozes") {
        if (api.erroDasVozes) throw api.erroDasVozes;
        return {
          data: {
            vozes: [
              { voice_id: "v1", nome: "Ana", categoria: null, amostra_url: null },
              { voice_id: "v2", nome: "Bruno", categoria: null, amostra_url: null },
            ],
          },
        };
      }
      if (url === "/api/v1/telefonia/voz") {
        if (api.erroDaVoz) throw api.erroDaVoz;
        return { data: structuredClone(api.voz) };
      }
      throw new Error(`GET inesperado: ${url}`);
    }),
    post: api.post,
    put: api.put,
  },
}));
vi.mock("@/hooks/channels/useChannelSessions", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("@/hooks/channels/useChannelSessions")),
  useChannelSessions: () => ({ data: api.canais, isLoading: false, isError: false, schemaOutdated: false }),
}));

import { MENSAGEM_DA_FALHA_DA_FALA } from "@/lib/telefonia/vocabulario";
import { TEXTO_SUGERIDO } from "@/lib/telefonia/texto-do-menu";

import { VozEFalas } from "./VozEFalas";

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

function pintar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <VozEFalas />
    </QueryClientProvider>,
  );
  return qc;
}

async function cartao(tipo: string): Promise<HTMLElement> {
  await screen.findByText("Fora do horário");
  return document.querySelector(`[data-fala-geral="${tipo}"]`) as HTMLElement;
}

const salvarDe = (c: HTMLElement) => within(c).getByRole("button", { name: /Salvar e usar/ });
const estadoDe = (c: HTMLElement) => c.querySelector("[data-estado-da-fala]")?.getAttribute("data-estado-da-fala");

beforeEach(() => {
  api.post.mockReset();
  api.put.mockReset();
  api.post.mockImplementation(async () => ({
    data: { hash: HASH, duracao_ms: 1000, reaproveitada: false, audio_base64: "//8=" },
  }));
  api.put.mockImplementation(async () => ({ data: { fala: null } }));
  api.canais = [];
  api.erroDaVoz = null;
  api.erroDasVozes = null;
  api.voz = {
    oferecida: true,
    chave: { cadastrada: true, last4: "1234" },
    voz: { voice_id: "v1", model_id: "eleven_multilingual_v2" },
    falas: { waiting: null, nobody: null, after_hours: null },
  };
});
afterEach(() => cleanup());

describe("aba Voz e falas — o que aparece antes de qualquer fala", () => {
  it("sem a chave da ElevenLabs: explica e aponta para Credenciais de IA, sem cartão de fala", async () => {
    api.voz = { ...(api.voz as object), chave: { cadastrada: false, last4: null } };
    pintar();
    const link = await screen.findByRole("link", { name: "Cadastrar a chave em Credenciais de IA" });
    expect(link).toHaveAttribute("href", "/app/ai/credentials");
    expect(document.querySelectorAll("[data-fala-geral]")).toHaveLength(0);
  });

  it("telefonia desligada na instalação: o mesmo cartão da aba Números", async () => {
    api.voz = { ...(api.voz as object), oferecida: false };
    pintar();
    expect(await screen.findByText("Telefonia desligada nesta instalação")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-fala-geral]")).toHaveLength(0);
  });

  it("a leitura falhou: diz que falhou, e não que falta a chave", async () => {
    api.erroDaVoz = new ApiError(500, "internal_error", undefined, "r0", "HTTP 500");
    pintar();
    expect(await screen.findByText("Não foi possível carregar a voz do telefone. Recarregue a página.")).toBeInTheDocument();
    expect(screen.queryByText("Falta a chave da ElevenLabs")).toBeNull();
  });

  it("a ElevenLabs fora do ar ao listar as vozes: a frase da rota, e não 'confira a chave'", async () => {
    api.erroDasVozes = new ApiError(502, "sem_resposta", undefined, "r1", MENSAGEM_DA_FALHA_DA_FALA.sem_resposta);
    pintar();
    expect(await screen.findByText(MENSAGEM_DA_FALHA_DA_FALA.sem_resposta)).toBeInTheDocument();
    expect(screen.queryByText(/Confira a chave/)).toBeNull();
  });

  it("sem voz escolhida: 'Gerar prévia' fica travado e a tela diz por quê", async () => {
    api.voz = { ...(api.voz as object), voz: null };
    pintar();
    const c = await cartao("waiting");
    expect(within(c).getByRole("button", { name: /Gerar prévia/ })).toBeDisabled();
    expect(within(c).getByText("Escolha a voz acima antes de gerar.")).toBeInTheDocument();
  });
});

describe("aba Voz e falas — gerar prévia, ouvir, salvar e usar", () => {
  it("as três falas com o texto sugerido; 'Salvar e usar' só depois da prévia, e com o hash dela", async () => {
    api.put.mockImplementation(async (_url: string, corpo: { texto: string; hash: string }) => {
      const nova = falaEmUso({ id: "fala-nova", tipo: "after_hours", texto: corpo.texto, hash: corpo.hash });
      (api.voz as { falas: Record<string, FalaPublica | null> }).falas.after_hours = nova;
      return { data: { fala: nova } };
    });
    pintar();
    const c = await cartao("after_hours");
    expect(document.querySelectorAll("[data-fala-geral]")).toHaveLength(3);
    expect(within(c).getByRole("textbox")).toHaveValue(TEXTO_SUGERIDO.after_hours);
    expect(estadoDe(c)).toBe("ausente");
    expect(salvarDe(c)).toBeDisabled();
    expect(c.querySelector("[data-ouvir-previa]")).toBeNull();

    await userEvent.click(within(c).getByRole("button", { name: /Gerar prévia/ }));
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/telefonia/falas/previa",
      { texto: TEXTO_SUGERIDO.after_hours },
      { timeoutMs: 60_000 },
    );
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    expect(estadoDe(c)).toBe("previa");
    expect(within(c).getByText("Prévia não salva")).toBeInTheDocument();
    // "Ouvir" toca o áudio que veio na resposta ("//8=" = 2 bytes de μ-law).
    expect(c.querySelector("[data-ouvir-previa]")?.getAttribute("data-ouvir-previa")).toBe("2");

    await userEvent.click(salvarDe(c));
    expect(api.put).toHaveBeenCalledWith("/api/v1/telefonia/falas/gerais/after_hours", {
      texto: TEXTO_SUGERIDO.after_hours,
      hash: HASH,
    });
    // Salva: a aba relê a voz, e a fala passa a "Em uso", com o áudio SALVO para ouvir.
    await waitFor(() => expect(estadoDe(c)).toBe("em-uso"));
    expect(c.querySelector('[data-ouvir-fala="fala-nova"]')).not.toBeNull();
    expect(salvarDe(c)).toBeDisabled();
  });

  it("editar o texto depois da prévia pede prévia de novo, e a prévia antiga some", async () => {
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(within(c).getByRole("button", { name: /Gerar prévia/ }));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    await userEvent.type(within(c).getByRole("textbox"), " Obrigado.");
    expect(salvarDe(c)).toBeDisabled();
    expect(c.querySelector("[data-ouvir-previa]")).toBeNull();
    expect(within(c).getByText("Gere a prévia deste texto e ouça antes de salvar.")).toBeInTheDocument();
  });

  it(
    "trocar a voz depois da prévia pede prévia de novo (o hash da prévia é da voz anterior)",
    { timeout: TETO_MS },
    async () => {
      api.put.mockImplementation(async (url: string, corpo: { voice_id?: string }) => {
        if (url === "/api/v1/telefonia/voz") {
          (api.voz as { voz: { voice_id: string } }).voz.voice_id = corpo.voice_id as string;
          return { data: { voice_id: corpo.voice_id } };
        }
        return { data: { fala: null } };
      });
      const user = usuario();
      pintar();
      const c = await cartao("waiting");
      await user.click(within(c).getByRole("button", { name: /Gerar prévia/ }));
      await waitFor(() => expect(salvarDe(c)).toBeEnabled());

      await user.click(screen.getByRole("combobox", { name: "Voz" }));
      await user.click(await screen.findByRole("option", { name: "Bruno" }));
      expect(api.put).toHaveBeenCalledWith("/api/v1/telefonia/voz", { voice_id: "v2" });

      await waitFor(() => expect(salvarDe(c)).toBeDisabled());
      expect(estadoDe(c)).toBe("ausente");
      expect(c.querySelector("[data-ouvir-previa]")).toBeNull();
    },
  );

  it("com um WhatsApp conectado, o 'fora do horário' sugerido já traz o número — e segue editável", async () => {
    api.canais = [
      { id: "c1", meio: "site_chat", status: "WORKING", phone_number: null },
      { id: "c2", meio: "whatsapp", status: "WORKING", phone_number: "+5561999990000" },
    ];
    pintar();
    const campo = within(await cartao("after_hours")).getByRole("textbox") as HTMLTextAreaElement;
    expect(campo.value).toContain("(61) 99999-0000");
    await userEvent.clear(campo);
    await userEvent.type(campo, "Fechado.");
    expect(campo.value).toBe("Fechado.");
  });
});

describe("aba Voz e falas — o estado da fala em uso", () => {
  it("fala salva com a voz atual: 'Em uso', o texto dela no campo e o áudio salvo para ouvir", async () => {
    (api.voz as { falas: Record<string, FalaPublica | null> }).falas.nobody = falaEmUso();
    pintar();
    const c = await cartao("nobody");
    expect(estadoDe(c)).toBe("em-uso");
    expect(within(c).getByRole("textbox")).toHaveValue("Ninguém pôde atender agora.");
    expect(c.querySelector('[data-ouvir-fala="fala-1"]')).not.toBeNull();
    expect(salvarDe(c)).toBeDisabled();
  });

  it("fala salva com OUTRA voz: 'Em uso, com a voz anterior' (as ligações ainda tocam a voz antiga)", async () => {
    (api.voz as { falas: Record<string, FalaPublica | null> }).falas.nobody = falaEmUso({ voice_id: "v0" });
    pintar();
    const c = await cartao("nobody");
    expect(estadoDe(c)).toBe("outra-voz");
    expect(within(c).getByText("Em uso, com a voz anterior")).toBeInTheDocument();
  });

  it("regerar a prévia do MESMO texto em uso destrava o salvar (é o conserto de um áudio que sumiu)", async () => {
    (api.voz as { falas: Record<string, FalaPublica | null> }).falas.nobody = falaEmUso();
    api.post.mockImplementationOnce(async () => ({
      data: { hash: HASH_EM_USO, duracao_ms: 2100, reaproveitada: false, audio_base64: "//8=" },
    }));
    pintar();
    const c = await cartao("nobody");
    await userEvent.click(within(c).getByRole("button", { name: /Gerar prévia/ }));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    await userEvent.click(salvarDe(c));
    expect(api.put).toHaveBeenCalledWith("/api/v1/telefonia/falas/gerais/nobody", {
      texto: "Ninguém pôde atender agora.",
      hash: HASH_EM_USO,
    });
  });
});

describe("aba Voz e falas — as falhas aparecem com o que fazer", () => {
  it("429 da cota de prévias: a mensagem aparece na hora, e nada fica para salvar", async () => {
    api.post.mockRejectedValueOnce(
      new ApiError(429, "limite_de_previas", undefined, "r2", MENSAGEM_DA_FALHA_DA_FALA.limite_de_previas),
    );
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(within(c).getByRole("button", { name: /Gerar prévia/ }));
    expect(await within(c).findByText(/Muitas prévias geradas na última hora/)).toBeInTheDocument();
    expect(estadoDe(c)).toBe("falhou");
    expect(salvarDe(c)).toBeDisabled();
    expect(within(c).getByRole("button", { name: /Gerar prévia/ })).toBeEnabled();
  });

  it("a prévia foi paga e não guardada (`paga: true`): diz que foi gerada mas não guardada", async () => {
    const frase = "A fala foi gerada, mas não foi guardada. Gerar de novo consome outra geração da ElevenLabs.";
    api.post.mockRejectedValueOnce(new ApiError(502, "armazenamento", { paga: true }, "r3", frase));
    pintar();
    const c = await cartao("nobody");
    await userEvent.click(within(c).getByRole("button", { name: /Gerar prévia/ }));
    expect(await within(c).findByText(new RegExp(frase.slice(0, 40)))).toBeInTheDocument();
    expect(within(c).queryByText(/Não foi possível gerar a prévia/)).toBeNull();
    expect(salvarDe(c)).toBeDisabled();
  });

  it("falha sem frase da rota (código conhecido): a frase do vocabulário, não o código cru", async () => {
    api.post.mockRejectedValueOnce(new ApiError(422, "sem_credito", undefined, "r4"));
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(within(c).getByRole("button", { name: /Gerar prévia/ }));
    expect(await within(c).findByText(new RegExp(MENSAGEM_DA_FALHA_DA_FALA.sem_credito.slice(0, 30)))).toBeInTheDocument();
    expect(within(c).queryByText(/sem_credito/)).toBeNull();
  });

  it("salvar recusado por `previa_ausente`: explica 'gere a prévia de novo' e volta a pedir a prévia", async () => {
    api.put.mockRejectedValueOnce(
      new ApiError(422, "previa_ausente", undefined, "r5", MENSAGEM_DA_FALHA_DA_FALA.previa_ausente),
    );
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(within(c).getByRole("button", { name: /Gerar prévia/ }));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    await userEvent.click(salvarDe(c));
    const alerta = await within(c).findByRole("alert");
    expect(alerta).toHaveTextContent(/Gere a prévia de novo/);
    expect(salvarDe(c)).toBeDisabled();
    expect(c.querySelector("[data-ouvir-previa]")).toBeNull();
  });

  it("salvar recusado por outra gravação em andamento (409): a prévia continua valendo para tentar de novo", async () => {
    api.put.mockRejectedValueOnce(
      new ApiError(409, "gravacao_em_andamento", undefined, "r6", MENSAGEM_DA_FALHA_DA_FALA.gravacao_em_andamento),
    );
    pintar();
    const c = await cartao("waiting");
    await userEvent.click(within(c).getByRole("button", { name: /Gerar prévia/ }));
    await waitFor(() => expect(salvarDe(c)).toBeEnabled());
    await userEvent.click(salvarDe(c));
    expect(await within(c).findByRole("alert")).toHaveTextContent(/em andamento/);
    expect(salvarDe(c)).toBeEnabled();
  });
});
