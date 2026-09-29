// @vitest-environment node
/**
 * A CHAVE DE VOZ DO TELEFONE NÃO É CHAVE DE MODELO DE LINGUAGEM.
 *
 * A chave da ElevenLabs mora em `ai_provider_credentials` (provider
 * `elevenlabs`), a mesma tabela das chaves de Anthropic, OpenAI, Google e
 * OpenRouter. Toda tela que tratava "credencial ativa" como "provedor de modelo"
 * passaria a oferecer a chave de voz para pensar — e o caso mais direto é o
 * `LegacyRecovery` da página do agente, em que o provedor é TEXTO LIVRE: quem
 * digitasse `elevenlabs` via a chave de voz no seletor de credencial do modelo.
 *
 * O critério mora num lugar só (`lib/ai/pontos/provedores.ts`); aqui se prova o
 * critério e que as duas páginas de agente o aplicam ANTES de entregar as
 * credenciais aos componentes que escolhem modelo.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const LINHAS = vi.hoisted(() => ({
  credenciais: [
    { id: "cred-anthropic", organization_id: "org-1", provider: "anthropic", label: "Claude", api_key_last4: "aaaa" },
    { id: "cred-voz", organization_id: "org-1", provider: "elevenlabs", label: "ElevenLabs", api_key_last4: "1234" },
    { id: "cred-openrouter", organization_id: "org-1", provider: "openrouter", label: "OR", api_key_last4: "bbbb" },
  ],
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("redirect");
  }),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => ({ id: "user-1" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "org-1", name: "Org", role: "admin" })),
}));
vi.mock("@/lib/channels/selectable", () => ({ listSelectableChannels: vi.fn(async () => []) }));
vi.mock("@/lib/instalacao/ambiente", () => ({ lerAmbiente: () => ({ chavesDeProvedor: {} }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from(tabela: string) {
      const lista: Record<string, unknown[]> = {
        ai_provider_credentials_safe: LINHAS.credenciais,
      };
      const unico: Record<string, unknown> = {
        ai_agents: { id: "agente-1", organization_id: "org-1", kind: "rag_bot", published_version_id: null },
      };
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "not", "order", "limit", "in"]) cadeia[m] = () => cadeia;
      cadeia.maybeSingle = () => Promise.resolve({ data: unico[tabela] ?? null, error: null });
      cadeia.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: lista[tabela] ?? [], error: null }).then(ok);
      return cadeia;
    },
  })),
}));
// Os componentes de tela ficam de fora: interessa o que a PÁGINA entrega a eles.
vi.mock("@/app/app/ai/agents/[id]/_components/AgentForm", () => ({ AgentForm: () => null }));
vi.mock("@/app/app/ai/agents/[id]/_components/AgentTabs", () => ({ AgentTabs: () => null }));
vi.mock("@/app/app/ai/agents/[id]/_components/LegacyRecovery", () => ({ LegacyRecovery: () => null }));
vi.mock("@/app/app/ai/agents/[id]/_components/AgentOperation", () => ({ AgentOperation: () => null }));

import {
  PROVEDORES,
  PROVEDORES_QUE_NAO_SAO_MODELO,
  PROVEDOR_DE_VOZ,
  credenciaisDeModelo,
  ehProvedorDeModelo,
} from "@/lib/ai/pontos/provedores";

import AgentEditorPage from "@/app/app/ai/agents/[id]/page";
import NewAgentPage from "@/app/app/ai/agents/new/page";

/** Toda prop `credentials` que a página entregou a algum componente da árvore. */
function credenciaisEntregues(no: ReactNode, achadas: Array<Array<{ provider: string }>> = []) {
  if (Array.isArray(no)) {
    for (const filho of no) credenciaisEntregues(filho, achadas);
    return achadas;
  }
  if (!isValidElement(no)) return achadas;
  const props = (no as ReactElement<Record<string, unknown>>).props;
  if (Array.isArray(props.credentials)) achadas.push(props.credentials as Array<{ provider: string }>);
  credenciaisEntregues(props.children as ReactNode, achadas);
  return achadas;
}

describe("o critério: quem é provedor de modelo", () => {
  it("a chave de voz não é; todo provedor que o motor executa é", () => {
    expect(PROVEDOR_DE_VOZ).toBe("elevenlabs");
    expect(ehProvedorDeModelo(PROVEDOR_DE_VOZ)).toBe(false);
    for (const p of PROVEDORES) expect(ehProvedorDeModelo(p.id)).toBe(true);
  });

  it("as duas listas nunca se cruzam: nada que não é modelo entra em PROVEDORES", () => {
    for (const p of PROVEDORES) expect(PROVEDORES_QUE_NAO_SAO_MODELO.has(p.id)).toBe(false);
  });

  it("credenciaisDeModelo tira só a de voz, e mantém a ordem das outras", () => {
    expect(credenciaisDeModelo(LINHAS.credenciais).map((c) => c.id)).toEqual(["cred-anthropic", "cred-openrouter"]);
  });
});

describe("as páginas de agente não oferecem a chave de voz para escolher modelo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("novo agente: o formulário recebe só credenciais de modelo", async () => {
    const entregues = credenciaisEntregues(await NewAgentPage());
    expect(entregues).toHaveLength(1);
    expect(entregues[0]!.map((c) => c.provider)).toEqual(["anthropic", "openrouter"]);
  });

  it("editar agente: as abas e a recuperação recebem só credenciais de modelo", async () => {
    const entregues = credenciaisEntregues(await AgentEditorPage({ params: Promise.resolve({ id: "agente-1" }) }));
    // AgentTabs e LegacyRecovery (o agente do dublê não tem versão publicada).
    expect(entregues).toHaveLength(2);
    for (const lista of entregues) expect(lista.map((c) => c.provider)).toEqual(["anthropic", "openrouter"]);
  });
});
