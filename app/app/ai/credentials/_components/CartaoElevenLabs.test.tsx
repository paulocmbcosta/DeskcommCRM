/**
 * O CARTÃO DA ELEVENLABS (desenho da fase 2, §6.1).
 *
 * O que se prova aqui, pela tela:
 *  - cada estado da chave tem texto próprio, e o cartão LÊ O MOTIVO do último
 *    teste — o `credentialStatus` genérico diria "Inválida" para os três motivos,
 *    e "a ElevenLabs recusou a chave" pede uma ação muito diferente de "a
 *    ElevenLabs está fora do ar" ou "a conta está sem crédito";
 *  - "Testar" passa pelo `revalidate`, que responde 200 com o motivo;
 *  - quem não é admin vê o estado, mas não o campo nem o "Testar";
 *  - a chave colada nunca volta à tela depois de salva — só os 4 últimos dígitos.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAVE_DA_VOZ } from "@/components/connections/telefone/api";
import type { CredentialRow } from "@/hooks/ai/useCredentials";
import { PROVEDOR_DE_VOZ } from "@/lib/ai/pontos/provedores";
import { ApiError } from "@/lib/api/types";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const efeitos = vi.hoisted(() => ({
  toastSucesso: vi.fn(),
  toastErro: vi.fn(),
  erroDaApi: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: efeitos.toastSucesso, error: efeitos.toastErro } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: efeitos.erroDaApi }));

/** O "servidor": as linhas que a lista de credenciais devolve agora. */
const api = vi.hoisted(() => ({
  linhas: [] as unknown[],
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: api.get, put: api.put, post: api.post },
}));

import { CartaoElevenLabs } from "./CartaoElevenLabs";

const CHAVE_NOVA = "sk_chave_de_teste_0000005678";

function linhaDeVoz(extra: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "cred-voz",
    organization_id: "org-1",
    // A coluna é de vocabulário aberto: a linha de voz existe no banco, embora
    // `Provider` só conheça os provedores de modelo.
    provider: PROVEDOR_DE_VOZ as string as CredentialRow["provider"],
    label: "ElevenLabs",
    api_key_last4: "1234",
    validated_at: "2026-09-28T13:00:00.000Z",
    validation_error: null,
    models_available: null,
    is_active: true,
    created_by: null,
    created_at: "2026-09-28T13:00:00.000Z",
    updated_at: "2026-09-28T13:00:00.000Z",
    ...extra,
  };
}

const linhaDeModelo: CredentialRow = {
  ...linhaDeVoz(),
  id: "cred-claude",
  provider: "anthropic",
  label: "Claude",
  api_key_last4: "aaaa",
};

function pintar(linhas: CredentialRow[], podeEditar: boolean) {
  api.linhas = linhas;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CartaoElevenLabs credenciaisIniciais={linhas} podeEditar={podeEditar} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.linhas = [];
  api.get.mockImplementation(async () => ({ data: api.linhas }));
});
afterEach(() => cleanup());

describe("os estados da chave, com texto claro", () => {
  it("não cadastrada: diz que falta a chave e não oferece Testar", async () => {
    pintar([linhaDeModelo], true);
    expect(await screen.findByText("Não cadastrada")).toBeInTheDocument();
    expect(screen.getByText(/Nenhuma chave cadastrada/)).toBeInTheDocument();
    expect(screen.getByLabelText("Chave da ElevenLabs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Testar" })).toBeNull();
  });

  it("validada: os 4 últimos dígitos e o selo de validada", async () => {
    pintar([linhaDeModelo, linhaDeVoz()], true);
    expect(await screen.findByText("…1234")).toBeInTheDocument();
    expect(screen.getByText("Validada")).toBeInTheDocument();
    // A chave de MODELO da mesma lista não é a de voz: nada dela aparece aqui.
    expect(screen.queryByText("…aaaa")).toBeNull();
  });

  it("chave recusada (chave_invalida): diz que a ElevenLabs recusou, não um 'Inválida' genérico", async () => {
    pintar([linhaDeVoz({ validated_at: null, validation_error: "chave_invalida" })], true);
    expect(await screen.findByText("Chave recusada")).toBeInTheDocument();
    expect(screen.getByText(/recusou esta chave no último teste/)).toBeInTheDocument();
    expect(screen.queryByText("Inválida")).toBeNull();
  });

  it.each(["sem_resposta", "erro_do_provedor"])(
    "ElevenLabs fora do ar (%s): a chave continua valendo",
    async (motivo) => {
      pintar([linhaDeVoz({ validation_error: motivo })], true);
      expect(await screen.findByText("ElevenLabs fora do ar")).toBeInTheDocument();
      expect(screen.getByText(/A chave continua guardada/)).toBeInTheDocument();
      expect(screen.queryByText("Chave recusada")).toBeNull();
    },
  );

  it("sem crédito (sem_credito): manda recarregar a conta, não trocar a chave", async () => {
    pintar([linhaDeVoz({ validation_error: "sem_credito" })], true);
    expect(await screen.findByText("Sem crédito")).toBeInTheDocument();
    expect(screen.getByText(/recarregue a conta/)).toBeInTheDocument();
    expect(screen.queryByText("Chave recusada")).toBeNull();
  });

  it("provider elevenlabs com OUTRO rótulo não é a chave de voz (mesmo critério de estadoDaChaveDeVoz/chaveDeVoz)", async () => {
    pintar([linhaDeVoz({ label: "Outra coisa", api_key_last4: "9999" })], true);
    expect(await screen.findByText("Não cadastrada")).toBeInTheDocument();
    expect(screen.queryByText("…9999")).toBeNull();
  });

  it("outra_falha com motivo CONHECIDO (limite_de_uso) mostra a mensagem própria do motivo", async () => {
    pintar([linhaDeVoz({ validation_error: "limite_de_uso" })], true);
    expect(await screen.findByText("Falha no teste")).toBeInTheDocument();
    expect(screen.getByText(/pediu para esperar um pouco/)).toBeInTheDocument();
  });

  it("motivo DESCONHECIDO no último teste: nunca mostra o código cru ao usuário", async () => {
    pintar([linhaDeVoz({ validation_error: "codigo_que_o_cartao_nao_conhece" })], true);
    expect(await screen.findByText("Falha no teste")).toBeInTheDocument();
    // Nem o código cru, nem os parênteses que o envolviam antes desta correção.
    expect(screen.queryByText(/codigo_que_o_cartao_nao_conhece/)).toBeNull();
    expect(document.body.textContent).not.toContain("codigo_que_o_cartao_nao_conhece");
  });
});

describe("Testar usa o revalidate e lê o motivo que ele devolve", () => {
  it("o revalidate responde 200 com sem_resposta: o cartão passa a 'fora do ar', sem dizer que a chave é ruim", async () => {
    pintar([linhaDeVoz()], true);
    api.post.mockImplementationOnce(async () => {
      api.linhas = [linhaDeVoz({ validation_error: "sem_resposta" })];
      return { data: api.linhas[0] };
    });
    await userEvent.click(await screen.findByRole("button", { name: "Testar" }));
    expect(await screen.findByText("ElevenLabs fora do ar")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/api/v1/ai/credentials/cred-voz/revalidate", {});
    expect(efeitos.toastSucesso).not.toHaveBeenCalled();
  });

  it("o revalidate aceita: avisa que a ElevenLabs aceitou e o selo volta a validada", async () => {
    pintar([linhaDeVoz({ validation_error: "sem_credito" })], true);
    api.post.mockImplementationOnce(async () => {
      api.linhas = [linhaDeVoz()];
      return { data: api.linhas[0] };
    });
    await userEvent.click(await screen.findByRole("button", { name: "Testar" }));
    expect(await screen.findByText("Validada")).toBeInTheDocument();
    expect(efeitos.toastSucesso).toHaveBeenCalledWith("A ElevenLabs aceitou a chave.");
  });

  it("Testar: se a própria chamada falhar (rede, 500), o erro vai pelo showApiError e o botão volta a habilitar", async () => {
    pintar([linhaDeVoz()], true);
    api.post.mockRejectedValueOnce(new ApiError(500, "internal_error", undefined, "req-5", "Erro interno."));
    const botao = await screen.findByRole("button", { name: "Testar" });
    await userEvent.click(botao);
    await waitFor(() => expect(efeitos.erroDaApi).toHaveBeenCalledTimes(1));
    expect(efeitos.toastSucesso).not.toHaveBeenCalled();
    // Não trava em "Testando…": o estado da chave (validada) segue o mesmo de antes.
    expect(await screen.findByRole("button", { name: "Testar" })).toBeEnabled();
    expect(screen.getByText("Validada")).toBeInTheDocument();
  });
});

describe("só admin cadastra, troca ou testa", () => {
  it("manager vê o estado e o motivo, mas não o campo nem o Testar", async () => {
    pintar([linhaDeVoz({ validation_error: "sem_credito" })], false);
    expect(await screen.findByText("…1234")).toBeInTheDocument();
    expect(screen.getByText("Sem crédito")).toBeInTheDocument();
    expect(screen.queryByLabelText("Trocar a chave")).toBeNull();
    expect(screen.queryByRole("button", { name: "Salvar chave" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Testar" })).toBeNull();
    expect(screen.getByText(/Só um administrador/)).toBeInTheDocument();
  });

  it("manager sem chave cadastrada: vê que falta, sem campo", async () => {
    pintar([], false);
    expect(await screen.findByText("Não cadastrada")).toBeInTheDocument();
    expect(screen.queryByLabelText("Chave da ElevenLabs")).toBeNull();
  });
});

describe("a chave colada", () => {
  it("o campo é de senha, sem autocompletar e sem nome (um envio nativo não a põe na URL)", async () => {
    pintar([linhaDeVoz()], true);
    const campo = await screen.findByLabelText("Trocar a chave");
    expect(campo).toHaveAttribute("type", "password");
    expect(campo).toHaveAttribute("autocomplete", "off");
    expect(campo).not.toHaveAttribute("name");
  });

  it("depois de salva, nunca volta à tela: o campo esvazia e só os 4 últimos aparecem", async () => {
    const espioes = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    pintar([linhaDeVoz()], true);
    api.put.mockImplementationOnce(async () => {
      api.linhas = [linhaDeVoz({ api_key_last4: "5678" })];
      return { data: { cadastrada: true, last4: "5678", validada_em: "2026-09-29T10:00:00.000Z" } };
    });

    const campo = await screen.findByLabelText("Trocar a chave");
    await userEvent.type(campo, CHAVE_NOVA);
    await userEvent.click(screen.getByRole("button", { name: "Salvar chave" }));

    expect(api.put).toHaveBeenCalledWith("/api/v1/telefonia/voz/chave", { chave: CHAVE_NOVA });
    expect(await screen.findByText("…5678")).toBeInTheDocument();
    await waitFor(() => expect(campo).toHaveValue(""));
    expect(document.body.innerHTML).not.toContain(CHAVE_NOVA);
    expect(window.location.href).not.toContain(CHAVE_NOVA);
    for (const espiao of espioes) {
      expect(JSON.stringify(espiao.mock.calls)).not.toContain(CHAVE_NOVA);
      espiao.mockRestore();
    }
    expect(efeitos.toastSucesso).toHaveBeenCalledWith("Chave da ElevenLabs salva e validada.");
  });

  it("chave recusada pelo PUT: a razão aparece AO LADO do campo e diz que nada foi salvo", async () => {
    pintar([linhaDeVoz()], true);
    api.put.mockRejectedValueOnce(
      new ApiError(422, "chave_invalida", undefined, "req-1", "A ElevenLabs recusou a chave. Confira a chave em Credenciais de IA."),
    );
    await userEvent.type(await screen.findByLabelText("Trocar a chave"), "sk_errada_000000");
    await userEvent.click(screen.getByRole("button", { name: "Salvar chave" }));
    const alerta = await screen.findByRole("alert");
    // Literal "recusou a chave" (sem "esta"): é o que o e2e da Task 23 confere.
    expect(alerta).toHaveTextContent("A ElevenLabs recusou a chave, e ela não foi salva.");
    expect(screen.getByLabelText("Trocar a chave")).toHaveAttribute("aria-invalid", "true");
    // A chave guardada antes continua a mesma.
    expect(screen.getByText("…1234")).toBeInTheDocument();
  });

  it("ElevenLabs fora do ar no PUT: não culpa a chave", async () => {
    pintar([], true);
    api.put.mockRejectedValueOnce(
      new ApiError(502, "sem_resposta", undefined, "req-2", "A ElevenLabs não respondeu. Tente de novo em instantes."),
    );
    await userEvent.type(await screen.findByLabelText("Chave da ElevenLabs"), "sk_qualquer_000000");
    await userEvent.click(screen.getByRole("button", { name: "Salvar chave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A ElevenLabs não respondeu, e a chave não foi salva.");
  });

  it("limite de uso no PUT: diz que a chave não foi salva, não só 'espere um pouco'", async () => {
    pintar([], true);
    // A mensagem que a ROTA manda hoje para `limite_de_uso` é a genérica do
    // motivo (`MENSAGEM_DA_FALHA_DA_FALA.limite_de_uso`), que não fala em
    // salvar nada — quem só mostrasse `e.message` diria "espere um pouco" e
    // deixaria a pessoa achando que a chave foi guardada.
    api.put.mockRejectedValueOnce(
      new ApiError(422, "limite_de_uso", undefined, "req-4", "A ElevenLabs pediu para esperar um pouco. Tente de novo em instantes."),
    );
    await userEvent.type(await screen.findByLabelText("Chave da ElevenLabs"), "sk_qualquer_000000");
    await userEvent.click(screen.getByRole("button", { name: "Salvar chave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A ElevenLabs recusou por limite de uso da conta, e a chave não foi salva.",
    );
  });

  it("recusa que o cartão não conhece: mostra a mensagem da rota", async () => {
    pintar([], true);
    api.put.mockRejectedValueOnce(
      new ApiError(500, "internal_error", undefined, "req-3", "Não foi possível guardar a chave agora. Tente de novo em instantes."),
    );
    await userEvent.type(await screen.findByLabelText("Chave da ElevenLabs"), "sk_qualquer_000000");
    await userEvent.click(screen.getByRole("button", { name: "Salvar chave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível guardar a chave agora.");
  });
});

describe("salvar a chave relê a aba Voz e falas", () => {
  it("a consulta da aba (CHAVE_DA_VOZ) é invalidada — a MESMA constante, não uma cópia da chave de cache", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A aba Voz e falas já leu "sem chave" nesta sessão do navegador.
    qc.setQueryData(CHAVE_DA_VOZ, { oferecida: true, chave: { cadastrada: false, last4: null } });
    api.put.mockImplementationOnce(async () => {
      api.linhas = [linhaDeVoz({ api_key_last4: "5678" })];
      return { data: { cadastrada: true, last4: "5678", validada_em: "2026-09-29T10:00:00.000Z" } };
    });
    render(
      <QueryClientProvider client={qc}>
        <CartaoElevenLabs credenciaisIniciais={[]} podeEditar />
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText("Chave da ElevenLabs"), CHAVE_NOVA);
    await userEvent.click(screen.getByRole("button", { name: "Salvar chave" }));
    await waitFor(() => expect(qc.getQueryState(CHAVE_DA_VOZ)?.isInvalidated).toBe(true));
  });
});
