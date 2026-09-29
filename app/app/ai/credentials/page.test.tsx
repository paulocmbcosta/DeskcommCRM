import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CARTÃO DA ELEVENLABS SÓ APARECE ONDE A INSTALAÇÃO OFERECE TELEFONIA
 * (`app/app/ai/credentials/page.tsx`, perto da linha 67).
 *
 * `configAriDoAmbiente()` lê `TELEFONIA_ARI_URL`/`TELEFONIA_ARI_PASSWORD` do
 * `process.env` de verdade (default do parâmetro), sem passar pelo `env.ts`
 * validado — por isso o teste alterna com `vi.stubEnv`, e não com um mock do
 * módulo: é o mesmo caminho que o `install.sh` de quem não ativou telefonia
 * percorre (as duas variáveis ausentes).
 */

const { requireAuthMock, resolveActiveOrgMock, createClientMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));

vi.mock("./_components/CredentialsList", () => ({
  CredentialsList: (props: { canWrite: boolean }) => (
    <div data-testid="credentials-list" data-can-write={String(props.canWrite)} />
  ),
}));
vi.mock("./_components/CartaoElevenLabs", () => ({
  CartaoElevenLabs: (props: { podeEditar: boolean }) => (
    <div data-testid="cartao-elevenlabs" data-pode-editar={String(props.podeEditar)} />
  ),
}));

import CredentialsPage from "./page";

/** Só a tabela de credenciais é lida quando a lista vem vazia (o uso publicado só é consultado com `credentials.length > 0`). */
function supabaseComListaVazia() {
  return {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          order: async () => ({ data: [] }),
        }),
      }),
    })),
  };
}

function pintarComPapel(role: "admin" | "manager") {
  requireAuthMock.mockResolvedValue({ idioma: "pt-BR", is_platform_admin: false, support: false });
  resolveActiveOrgMock.mockResolvedValue({ orgId: "org-1", name: "Org", role });
  createClientMock.mockResolvedValue(supabaseComListaVazia());
  return CredentialsPage();
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("o cartão da ElevenLabs só aparece com telefonia oferecida", () => {
  it("instalação SEM telefonia (as duas variáveis ausentes): o cartão não aparece, nem para admin", async () => {
    vi.stubEnv("TELEFONIA_ARI_URL", "");
    vi.stubEnv("TELEFONIA_ARI_PASSWORD", "");

    render(await pintarComPapel("admin"));

    expect(screen.getByTestId("credentials-list")).toBeInTheDocument();
    expect(screen.queryByTestId("cartao-elevenlabs")).toBeNull();
  });

  it("instalação COM telefonia, admin: o cartão aparece e podeEditar é true", async () => {
    vi.stubEnv("TELEFONIA_ARI_URL", "http://asterisk:8088");
    vi.stubEnv("TELEFONIA_ARI_PASSWORD", "segredo-ari");

    render(await pintarComPapel("admin"));

    expect(screen.getByTestId("cartao-elevenlabs")).toHaveAttribute("data-pode-editar", "true");
  });

  it("instalação COM telefonia, manager: o cartão aparece mas podeEditar é false", async () => {
    vi.stubEnv("TELEFONIA_ARI_URL", "http://asterisk:8088");
    vi.stubEnv("TELEFONIA_ARI_PASSWORD", "segredo-ari");

    render(await pintarComPapel("manager"));

    expect(screen.getByTestId("cartao-elevenlabs")).toHaveAttribute("data-pode-editar", "false");
  });

  it("só a URL sem a senha ainda conta como telefonia desligada", async () => {
    vi.stubEnv("TELEFONIA_ARI_URL", "http://asterisk:8088");
    vi.stubEnv("TELEFONIA_ARI_PASSWORD", "");

    render(await pintarComPapel("admin"));

    expect(screen.queryByTestId("cartao-elevenlabs")).toBeNull();
  });
});
