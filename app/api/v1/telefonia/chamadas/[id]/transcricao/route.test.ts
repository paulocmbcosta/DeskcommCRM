// @vitest-environment node
/**
 * A LEITURA AUDITADA DA TRANSCRIÇÃO (F4): atendente ou acima; a mensagem da
 * ligação vem pelo cliente de SESSÃO (a RLS decide quem enxerga a conversa); a
 * transcrição vem pelo cliente de serviço, presa à organização da sessão; só a
 * transcrição PRONTA entrega texto, e cada entrega é uma linha na auditoria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const VC = "3f1c2b8e-9a4d-4c6e-8f00-1234567890ab";
const CONVERSA = "6a0f5d1e-2222-4c6e-8f00-000000000002";
const MSG = "6a0f5d1e-1111-4c6e-8f00-000000000001";
const CONTATO = "6a0f5d1e-3333-4c6e-8f00-000000000003";

const estado = vi.hoisted(() => ({
  /** O que a RLS devolveria para a sessão: `null` = a conversa não é visível. */
  mensagem: null as null | { id: string; conversation_id: string | null },
  ligacao: null as null | { id: string; conversation_id: string | null },
  /** A linha de voice_call_transcripts, como o cliente de serviço a lê. */
  transcricao: null as null | { status: string; segments: unknown; summary: string | null; audio_duration_ms: number | null },
  erroDaTranscricao: null as null | { message: string },
  /** O contato da ligação, como o cliente de serviço o lê (`null` = ligação sem contato). */
  contatoDaLigacao: null as null | string,
  /** `contacts.is_anonymized` do contato da ligação. */
  anonimizado: false,
  erroDaAnonimizacao: null as null | { message: string },
  filtros: [] as Array<[string, unknown]>,
  leiturasDeServico: 0,
  papelOk: true,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () =>
    estado.papelOk
      ? {
          ok: true,
          user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
          org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "agent" },
        }
      : { ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }) },
  ),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const consulta = (dado: () => { data: unknown; error: unknown }, tabela: string) => {
  const q = {
    select: () => q,
    eq: (coluna: string, valor: unknown) => {
      estado.filtros.push([`${tabela}.${coluna}`, valor]);
      return q;
    },
    maybeSingle: async () => dado(),
  };
  return q;
};
/** Consulta de LISTA (sem `maybeSingle`): o resultado sai ao aguardar a própria consulta. */
const lista = (dado: () => { data: unknown; error: unknown }, tabela: string) => {
  const q = {
    select: () => q,
    eq: (coluna: string, valor: unknown) => {
      estado.filtros.push([`${tabela}.${coluna}`, valor]);
      return q;
    },
    in: (coluna: string, valores: unknown) => {
      estado.filtros.push([`${tabela}.${coluna}`, valores]);
      return q;
    },
    then: (ok: (v: { data: unknown; error: unknown }) => unknown, falha?: (e: unknown) => unknown) =>
      Promise.resolve(dado()).then(ok, falha),
  };
  return q;
};
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (tabela: string) => {
      if (tabela === "messages") return consulta(() => ({ data: estado.mensagem, error: null }), "sessao.messages");
      if (tabela === "voice_calls") return consulta(() => ({ data: estado.ligacao, error: null }), "sessao.voice_calls");
      // A sessão NUNCA lê a transcrição: a tabela não tem grant para o membro.
      throw new Error(`a sessão não lê ${tabela}`);
    },
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (tabela: string) => {
      // A conferência da anonimização (`ligacoesDeContatoLiberado`): a ligação e,
      // dela, o contato — perguntando pelos NÃO anonimizados.
      if (tabela === "voice_calls") {
        return lista(
          () => ({ data: [{ id: VC, contact_id: estado.contatoDaLigacao }], error: estado.erroDaAnonimizacao }),
          "servico.voice_calls",
        );
      }
      if (tabela === "contacts") {
        return lista(() => ({ data: estado.anonimizado ? [] : [{ id: CONTATO }], error: null }), "servico.contacts");
      }
      if (tabela !== "voice_call_transcripts") throw new Error(`o cliente de serviço só lê a transcrição, não ${tabela}`);
      estado.leiturasDeServico += 1;
      return consulta(() => ({ data: estado.transcricao, error: estado.erroDaTranscricao }), "servico.voice_call_transcripts");
    },
  })),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";

import { GET } from "./route";

const ler = (id = VC) =>
  GET(new NextRequest(`https://crm.exemplo.com.br/api/v1/telefonia/chamadas/${id}/transcricao`), {
    params: Promise.resolve({ id }),
  });

const TRECHOS = [
  { inicio_ms: 0, fim_ms: 1000, quem: "atendente", texto: "Totus," },
  { inicio_ms: 1000, fim_ms: 1900, quem: "atendente", texto: "boa tarde." },
  { inicio_ms: 2400, fim_ms: 6000, quem: "cliente", texto: "Estou sem internet." },
];

beforeEach(() => {
  estado.mensagem = { id: MSG, conversation_id: CONVERSA };
  estado.ligacao = { id: VC, conversation_id: CONVERSA };
  estado.transcricao = { status: "ready", segments: TRECHOS, summary: " O cliente está sem internet. ", audio_duration_ms: 61_000 };
  estado.erroDaTranscricao = null;
  estado.contatoDaLigacao = CONTATO;
  estado.anonimizado = false;
  estado.erroDaAnonimizacao = null;
  estado.filtros = [];
  estado.leiturasDeServico = 0;
  estado.papelOk = true;
  vi.mocked(audit).mockClear();
  vi.mocked(requireRole).mockClear();
});

describe("GET /api/v1/telefonia/chamadas/[id]/transcricao", () => {
  it("atendente que enxerga a conversa: as falas juntas por quem falou, o resumo, e UMA linha na auditoria", async () => {
    const r = await ler();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("agent");
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({
      situacao: "pronta",
      resumo: "O cliente está sem internet.",
      falas: [
        { quem: "atendente", inicio_ms: 0, texto: "Totus, boa tarde." },
        { quem: "cliente", inicio_ms: 2400, texto: "Estou sem internet." },
      ],
      duracao_ms: 61_000,
      estimativa: true,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "phone.transcript_read",
      organizationId: ORG,
      resourceType: "voice_call",
      resourceId: VC,
      metadata: { conversation_id: CONVERSA },
    });
  });

  it("a auditoria nunca leva o texto da ligação", async () => {
    await ler();
    expect(JSON.stringify(vi.mocked(audit).mock.calls[0]![0])).not.toContain("internet");
  });

  it("toda consulta é presa à organização da SESSÃO e à ligação do caminho", async () => {
    await ler();
    expect(estado.filtros).toEqual(
      expect.arrayContaining([
        ["sessao.messages.organization_id", ORG],
        ["sessao.messages.external_id", `ligacao:${VC}`],
        ["sessao.voice_calls.organization_id", ORG],
        ["sessao.voice_calls.id", VC],
        ["servico.voice_call_transcripts.organization_id", ORG],
        ["servico.voice_call_transcripts.voice_call_id", VC],
        ["servico.voice_calls.organization_id", ORG],
        ["servico.voice_calls.id", [VC]],
        ["servico.contacts.organization_id", ORG],
        ["servico.contacts.is_anonymized", false],
        ["servico.contacts.id", [CONTATO]],
      ]),
    );
  });

  it("contato ANONIMIZADO: 404 mesmo com a linha da transcrição lá — ela nem é lida, e nada é auditado", async () => {
    // O caso que o apagamento não cobre: um membro marcou o contato pela REST
    // antes, e a anonimização de verdade respondeu "já estava" sem redigir nada.
    estado.anonimizado = true;
    const r = await ler();
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toContain("internet");
    expect(estado.leiturasDeServico).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("ligação sem contato: 404 — sem contato não há como dizer que não foi anonimizado", async () => {
    estado.contatoDaLigacao = null;
    expect((await ler()).status).toBe(404);
    expect(estado.leiturasDeServico).toBe(0);
  });

  it("não deu para conferir a anonimização: 500, e a transcrição não é lida — na dúvida, não entrega", async () => {
    estado.erroDaAnonimizacao = { message: "timeout" };
    expect((await ler()).status).toBe(500);
    expect(estado.leiturasDeServico).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("papel abaixo de atendente: recusado antes de qualquer leitura", async () => {
    estado.papelOk = false;
    const r = await ler();
    expect(r.status).toBe(403);
    expect(estado.filtros).toEqual([]);
    expect(estado.leiturasDeServico).toBe(0);
  });

  it("a conversa não é visível para quem pede (RLS): 404, e a transcrição NEM é lida", async () => {
    estado.mensagem = null;
    const r = await ler();
    expect(r.status).toBe(404);
    expect(estado.leiturasDeServico).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("mensagem `ligacao:*` plantada em OUTRA conversa: 404, e a transcrição nem é lida", async () => {
    estado.mensagem = { id: MSG, conversation_id: "6a0f5d1e-9999-4c6e-8f00-000000000009" };
    const r = await ler();
    expect(r.status).toBe(404);
    expect(estado.leiturasDeServico).toBe(0);
  });

  it("ligação que a sessão não lê: 404", async () => {
    estado.ligacao = null;
    expect((await ler()).status).toBe(404);
    expect(estado.leiturasDeServico).toBe(0);
  });

  it("id que não é uuid: 404 sem consultar nada", async () => {
    const r = await ler("1 or 1=1");
    expect(r.status).toBe(404);
    expect(estado.filtros).toEqual([]);
  });

  it("ligação sem transcrição (não pedida, apagada pela retenção ou pela anonimização): 404, sem auditoria", async () => {
    estado.transcricao = null;
    expect((await ler()).status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", "processando"],
    ["empty", "sem_fala"],
    ["failed", "falhou"],
  ])("estado %s: responde a situação %s SEM texto e SEM auditar — nada foi lido", async (status, situacao) => {
    estado.transcricao = { status, segments: TRECHOS, summary: "resumo que não devia sair", audio_duration_ms: 1 };
    const r = await ler();
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ situacao, resumo: null, falas: [], duracao_ms: null, estimativa: true });
    expect(audit).not.toHaveBeenCalled();
  });

  it("estado desconhecido (worker mais novo): 404, em vez de inventar uma situação", async () => {
    estado.transcricao = { status: "em_revisao", segments: TRECHOS, summary: null, audio_duration_ms: null };
    expect((await ler()).status).toBe(404);
  });

  it("trechos tortos no banco não derrubam a leitura: o que não é trecho fica de fora", async () => {
    estado.transcricao = { status: "ready", segments: [null, { texto: "sem tempo" }, TRECHOS[2]], summary: null, audio_duration_ms: null };
    const r = await ler();
    expect((await r.json()).data).toMatchObject({
      resumo: null,
      falas: [{ quem: "cliente", inicio_ms: 2400, texto: "Estou sem internet." }],
      duracao_ms: null,
    });
  });

  it("falha ao ler a transcrição: 500, sem auditar", async () => {
    estado.erroDaTranscricao = { message: "timeout" };
    expect((await ler()).status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});
