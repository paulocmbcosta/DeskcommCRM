// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O Supabase de mentira. `null` = o teste não deve tocar no banco (o leitor
 * entra por parâmetro). Com tabelas, cada uma devolve o que o teste disse — o
 * dublê não filtra: quem prova o filtro é a lista de `filtros`.
 */
const banco = vi.hoisted(() => ({
  tabelas: null as null | Record<string, { data: unknown; error: { message: string } | null }>,
  filtros: [] as Array<[string, unknown]>,
  consultadas: [] as string[],
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (!banco.tabelas) throw new Error("o teste não fala com o Supabase: o leitor entra por parâmetro");
    return {
      from: (tabela: string) => {
        banco.consultadas.push(tabela);
        const q = {
          select: () => q,
          eq: (coluna: string, valor: unknown) => {
            banco.filtros.push([`${tabela}.${coluna}`, valor]);
            return q;
          },
          in: (coluna: string, valores: unknown) => {
            banco.filtros.push([`${tabela}.${coluna}`, valores]);
            return q;
          },
          then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
            Promise.resolve(banco.tabelas![tabela] ?? { data: [], error: null }).then(ok, falha),
        };
        return q;
      },
    };
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { logger } from "@/lib/logger";

import {
  comTranscricaoDasLigacoes,
  lerTranscricoesDasLigacoes,
  ligacoesDeContatoLiberado,
  type LeitorDeTranscricoes,
} from "./transcricao-da-ligacao";

const ORG = "0be7a70c-0000-4000-8000-000000000001";
const VC = "0be7a70c-0000-4000-8000-0000000000aa";
const OUTRA_VC = "0be7a70c-0000-4000-8000-0000000000ab";

const ligacao = (id: string, transcricao?: unknown) => ({
  id: `msg-${id}`,
  external_id: `ligacao:${id}`,
  metadata: {
    voice_call: {
      id,
      direcao: "inbound",
      desfecho: "atendida",
      gravacao: { situacao: "pronta", duracao_ms: 61_000 },
      ...(transcricao !== undefined ? { transcricao } : {}),
    },
    outra_chave: 1,
  },
});
const texto = { id: "msg-texto", external_id: "wamid.1", metadata: {} };

const leitor = (linhas: Record<string, { estado: "pending" | "ready" | "empty" | "failed"; resumo: string | null }>) =>
  vi.fn<LeitorDeTranscricoes>(async () => new Map(Object.entries(linhas)));

const transcricaoDe = (m: { metadata: unknown }) =>
  ((m.metadata as { voice_call?: Record<string, unknown> }).voice_call ?? {}).transcricao;

const CONTATO = "0be7a70c-0000-4000-8000-0000000000c1";
const OUTRO_CONTATO = "0be7a70c-0000-4000-8000-0000000000c2";

beforeEach(() => {
  banco.tabelas = null;
  banco.filtros = [];
  banco.consultadas = [];
});

describe("ligacoesDeContatoLiberado — de quais ligações a transcrição PODE sair", () => {
  it("só a ligação cujo contato volta como NÃO anonimizado; a pergunta é presa à organização", async () => {
    banco.tabelas = {
      voice_calls: { data: [{ id: VC, contact_id: CONTATO }, { id: OUTRA_VC, contact_id: OUTRO_CONTATO }], error: null },
      // O que o banco devolve para `is_anonymized = false`: só o primeiro.
      contacts: { data: [{ id: CONTATO }], error: null },
    };
    expect([...(await ligacoesDeContatoLiberado(ORG, [VC, OUTRA_VC]))]).toEqual([VC]);
    expect(banco.filtros).toEqual(
      expect.arrayContaining([
        ["voice_calls.organization_id", ORG],
        ["voice_calls.id", [VC, OUTRA_VC]],
        ["contacts.organization_id", ORG],
        ["contacts.is_anonymized", false],
        ["contacts.id", [CONTATO, OUTRO_CONTATO]],
      ]),
    );
  });

  it("ligação que a consulta não devolve e ligação SEM contato ficam de fora (falha fechado)", async () => {
    banco.tabelas = { voice_calls: { data: [{ id: VC, contact_id: null }], error: null }, contacts: { data: [{ id: CONTATO }], error: null } };
    expect((await ligacoesDeContatoLiberado(ORG, [VC, OUTRA_VC])).size).toBe(0);
    // Sem contato a conferir, a segunda consulta nem acontece.
    expect(banco.consultadas).toEqual(["voice_calls"]);
  });

  it("lista vazia: nada a conferir, nenhuma consulta", async () => {
    banco.tabelas = {};
    expect((await ligacoesDeContatoLiberado(ORG, [])).size).toBe(0);
    expect(banco.consultadas).toEqual([]);
  });

  it.each(["voice_calls", "contacts"])("a consulta a %s falha: LANÇA — quem chama não entrega nada", async (tabela) => {
    banco.tabelas = {
      voice_calls: { data: [{ id: VC, contact_id: CONTATO }], error: null },
      contacts: { data: [{ id: CONTATO }], error: null },
      [tabela]: { data: null, error: { message: "banco fora" } },
    };
    await expect(ligacoesDeContatoLiberado(ORG, [VC])).rejects.toThrow("banco fora");
  });
});

describe("lerTranscricoesDasLigacoes — o leitor de verdade", () => {
  it("a transcrição de contato ANONIMIZADO não sai, mesmo com a linha na tabela", async () => {
    banco.tabelas = {
      voice_call_transcripts: {
        data: [
          { voice_call_id: VC, status: "ready", summary: "Resumo do contato liberado." },
          { voice_call_id: OUTRA_VC, status: "ready", summary: "Resumo do contato anonimizado." },
        ],
        error: null,
      },
      voice_calls: { data: [{ id: VC, contact_id: CONTATO }, { id: OUTRA_VC, contact_id: OUTRO_CONTATO }], error: null },
      contacts: { data: [{ id: CONTATO }], error: null },
    };
    const lidas = await lerTranscricoesDasLigacoes(ORG, [VC, OUTRA_VC]);
    expect([...lidas.keys()]).toEqual([VC]);
    expect(JSON.stringify([...lidas.values()])).not.toContain("anonimizado");
    expect(banco.filtros).toEqual(expect.arrayContaining([["voice_call_transcripts.organization_id", ORG]]));
  });

  it("sem transcrição nenhuma: não gasta as consultas da anonimização", async () => {
    banco.tabelas = { voice_call_transcripts: { data: [], error: null } };
    expect((await lerTranscricoesDasLigacoes(ORG, [VC])).size).toBe(0);
    expect(banco.consultadas).toEqual(["voice_call_transcripts"]);
  });

  it("estado que este código não conhece fica de fora", async () => {
    banco.tabelas = {
      voice_call_transcripts: { data: [{ voice_call_id: VC, status: "em_revisao", summary: "x" }], error: null },
    };
    expect((await lerTranscricoesDasLigacoes(ORG, [VC])).size).toBe(0);
  });

  it("não deu para conferir a anonimização: lança — e a listagem, que o chama, não entrega nada", async () => {
    banco.tabelas = {
      voice_call_transcripts: { data: [{ voice_call_id: VC, status: "ready", summary: "Segredo da ligação." }], error: null },
      voice_calls: { data: null, error: { message: "banco fora" } },
    };
    await expect(lerTranscricoesDasLigacoes(ORG, [VC])).rejects.toThrow("banco fora");
    const [m] = await comTranscricaoDasLigacoes([ligacao(VC, { situacao: "pronta" })], { organizationId: ORG, podeLer: true });
    expect(transcricaoDe(m!)).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain("Segredo");
  });
});

describe("comTranscricaoDasLigacoes", () => {
  it("conversa sem ligação transcrita: devolve a MESMA lista, sem ir ao banco", async () => {
    const ler = leitor({});
    const mensagens = [texto, ligacao(VC)];
    expect(await comTranscricaoDasLigacoes(mensagens, { organizationId: ORG, podeLer: true }, ler)).toBe(mensagens);
    expect(ler).not.toHaveBeenCalled();
  });

  it("quem pode ouvir recebe a situação da TABELA e o resumo da transcrição pronta", async () => {
    const ler = leitor({ [VC]: { estado: "ready", resumo: " O cliente pediu a segunda via. " } });
    const [m] = await comTranscricaoDasLigacoes([ligacao(VC, { situacao: "processando" })], { organizationId: ORG, podeLer: true }, ler);
    expect(transcricaoDe(m!)).toEqual({ situacao: "pronta", resumo: "O cliente pediu a segunda via." });
    expect(ler).toHaveBeenCalledWith(ORG, [VC]);
    // O resto do cartão e do metadado não muda.
    const vc = (m!.metadata as { voice_call: Record<string, unknown>; outra_chave: number }).voice_call;
    expect(vc.gravacao).toEqual({ situacao: "pronta", duracao_ms: 61_000 });
    expect((m!.metadata as { outra_chave: number }).outra_chave).toBe(1);
  });

  it.each([
    ["pending", "processando"],
    ["empty", "sem_fala"],
    ["failed", "falhou"],
  ] as const)("estado %s vira situação %s, e NUNCA leva resumo", async (estado, situacao) => {
    const ler = leitor({ [VC]: { estado, resumo: "resumo que não devia sair" } });
    const [m] = await comTranscricaoDasLigacoes([ligacao(VC, { situacao: "pronta" })], { organizationId: ORG, podeLer: true }, ler);
    expect(transcricaoDe(m!)).toEqual({ situacao, resumo: null });
  });

  it("quem NÃO pode ouvir (papel de leitura, token, agente) não recebe nada — e a tabela nem é consultada", async () => {
    const ler = leitor({ [VC]: { estado: "ready", resumo: "Segredo da ligação." } });
    const [m] = await comTranscricaoDasLigacoes([ligacao(VC, { situacao: "pronta" })], { organizationId: ORG, podeLer: false }, ler);
    expect(transcricaoDe(m!)).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain("Segredo");
    expect(ler).not.toHaveBeenCalled();
    // A gravação segue no cartão: quem não ouve ainda vê que a ligação foi gravada.
    expect((m!.metadata as { voice_call: Record<string, unknown> }).voice_call.gravacao).toBeDefined();
  });

  it("`podeLer` como pergunta: só é feita quando a página tem ligação transcrita — e vale a resposta", async () => {
    const pergunta = vi.fn(async () => true);
    const ler = leitor({ [VC]: { estado: "ready", resumo: "Resumo." } });
    await comTranscricaoDasLigacoes([texto, ligacao(OUTRA_VC)], { organizationId: ORG, podeLer: pergunta }, ler);
    expect(pergunta).not.toHaveBeenCalled();
    const [m] = await comTranscricaoDasLigacoes([ligacao(VC, { situacao: "pronta" })], { organizationId: ORG, podeLer: pergunta }, ler);
    expect(pergunta).toHaveBeenCalledTimes(1);
    expect(transcricaoDe(m!)).toEqual({ situacao: "pronta", resumo: "Resumo." });

    const nao = vi.fn(async () => false);
    const [n] = await comTranscricaoDasLigacoes([ligacao(VC, { situacao: "pronta" })], { organizationId: ORG, podeLer: nao }, ler);
    expect(transcricaoDe(n!)).toBeUndefined();
  });

  it("a pergunta que LANÇA (não deu para conferir o segundo fator) conta como 'não pode': nada é entregue", async () => {
    const ler = leitor({ [VC]: { estado: "ready", resumo: "Segredo da ligação." } });
    const [m] = await comTranscricaoDasLigacoes(
      [ligacao(VC, { situacao: "pronta" })],
      {
        organizationId: ORG,
        podeLer: async () => {
          throw new Error("auth fora");
        },
      },
      ler,
    );
    expect(transcricaoDe(m!)).toBeUndefined();
    expect(ler).not.toHaveBeenCalled();
  });

  it("projeção sem linha na tabela (apagada pela retenção ou pela anonimização): o cartão cala", async () => {
    const ler = leitor({});
    const [m] = await comTranscricaoDasLigacoes([ligacao(VC, { situacao: "pronta" })], { organizationId: ORG, podeLer: true }, ler);
    expect(transcricaoDe(m!)).toBeUndefined();
  });

  it("um resumo PLANTADO na projeção não chega à tela: só vale o da tabela", async () => {
    const ler = leitor({ [VC]: { estado: "ready", resumo: null } });
    const [m] = await comTranscricaoDasLigacoes(
      [ligacao(VC, { situacao: "pronta", resumo: "texto plantado no metadado" })],
      { organizationId: ORG, podeLer: true },
      ler,
    );
    expect(transcricaoDe(m!)).toEqual({ situacao: "pronta", resumo: null });
  });

  it("a consulta falha: na dúvida, nada é entregue — e o erro vai ao log", async () => {
    const ler = vi.fn<LeitorDeTranscricoes>(async () => {
      throw new Error("banco fora");
    });
    const [m] = await comTranscricaoDasLigacoes([ligacao(VC, { situacao: "pronta" })], { organizationId: ORG, podeLer: true }, ler);
    expect(transcricaoDe(m!)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("só mensagem que É o registro de uma ligação: `voice_call` plantado noutra mensagem não vira consulta", async () => {
    const ler = leitor({ [VC]: { estado: "ready", resumo: "Resumo." } });
    const plantada = { id: "x", external_id: "wamid.2", metadata: { voice_call: { id: VC, transcricao: { situacao: "pronta" } } } };
    const [m] = await comTranscricaoDasLigacoes([plantada], { organizationId: ORG, podeLer: true }, ler);
    expect(m).toBe(plantada);
    expect(ler).not.toHaveBeenCalled();
  });

  it("várias ligações na página: uma consulta só, cada cartão com a sua", async () => {
    const ler = leitor({ [VC]: { estado: "ready", resumo: "Primeira." }, [OUTRA_VC]: { estado: "pending", resumo: null } });
    const r = await comTranscricaoDasLigacoes(
      [ligacao(VC, { situacao: "pronta" }), texto, ligacao(OUTRA_VC, { situacao: "processando" })],
      { organizationId: ORG, podeLer: true },
      ler,
    );
    expect(ler).toHaveBeenCalledTimes(1);
    expect(ler.mock.calls[0]![1].sort()).toEqual([VC, OUTRA_VC].sort());
    expect(transcricaoDe(r[0]!)).toEqual({ situacao: "pronta", resumo: "Primeira." });
    expect(r[1]).toBe(texto);
    expect(transcricaoDe(r[2]!)).toEqual({ situacao: "processando", resumo: null });
  });

  it("não muta a mensagem que recebeu", async () => {
    const original = ligacao(VC, { situacao: "processando" });
    const copia = structuredClone(original);
    await comTranscricaoDasLigacoes([original], { organizationId: ORG, podeLer: true }, leitor({ [VC]: { estado: "ready", resumo: "R." } }));
    expect(original).toEqual(copia);
  });
});
