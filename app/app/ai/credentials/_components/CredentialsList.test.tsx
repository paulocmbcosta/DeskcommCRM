/**
 * A LISTA DE CREDENCIAIS DE MODELO NÃO MOSTRA A CHAVE DE VOZ.
 *
 * A chave da ElevenLabs mora em `ai_provider_credentials`, a mesma tabela das
 * chaves de modelo, e chega a esta tela na mesma lista. Ela tem cartão próprio
 * (`CartaoElevenLabs`). Sem o filtro central (`credenciaisDeModelo`), ela contava
 * como "já tem credencial" e escondia o estado vazio de quem ainda não cadastrou
 * nenhum modelo — o agente não pensa, e a tela dizia que estava tudo certo.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CredentialRow } from "@/hooks/ai/useCredentials";
import { PROVEDOR_DE_VOZ } from "@/lib/ai/pontos/provedores";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));

const api = vi.hoisted(() => ({ linhas: [] as unknown[] }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(async () => ({ data: api.linhas })), post: vi.fn(), delete: vi.fn() },
}));

import { CredentialsList } from "./CredentialsList";

function linha(extra: Partial<CredentialRow>): CredentialRow {
  return {
    id: "c1",
    organization_id: "o1",
    provider: "anthropic",
    label: "Produção",
    api_key_last4: "abcd",
    validated_at: "2026-09-02T00:00:00Z",
    validation_error: null,
    models_available: null,
    is_active: true,
    created_by: null,
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    ...extra,
  };
}

const deVoz = linha({
  id: "cred-voz",
  provider: PROVEDOR_DE_VOZ as string as CredentialRow["provider"],
  label: "ElevenLabs",
  api_key_last4: "1234",
});

function pintar(linhas: CredentialRow[]) {
  api.linhas = linhas;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CredentialsList initialData={linhas} canWrite usageMap={{}} />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("a lista de Credenciais de IA é só de modelo de linguagem", () => {
  it("a chave de voz não aparece entre as de modelo", () => {
    pintar([linha({ id: "cred-claude", label: "Claude" }), deVoz]);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.queryByText("ElevenLabs")).toBeNull();
    expect(screen.queryByText("…1234")).toBeNull();
  });

  it("só a chave de voz cadastrada: a lista de modelo continua vazia e diz isso", () => {
    pintar([deVoz]);
    expect(screen.getByText("Nenhuma chave cadastrada ainda")).toBeInTheDocument();
    expect(screen.queryByText("ElevenLabs")).toBeNull();
  });
});
