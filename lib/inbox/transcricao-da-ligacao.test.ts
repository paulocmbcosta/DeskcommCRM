// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("o teste não fala com o Supabase: o leitor entra por parâmetro");
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { logger } from "@/lib/logger";

import { comTranscricaoDasLigacoes, type LeitorDeTranscricoes } from "./transcricao-da-ligacao";

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
