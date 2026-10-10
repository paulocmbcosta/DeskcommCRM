import { describe, expect, it, vi } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";
import type { TranscricaoComTrechos } from "@/lib/messaging/media/transcription";
import { NAV_CATALOG } from "@/lib/navigation/catalogo";
import { TRECHOS_POR_BLOCO } from "@/lib/telefonia/resumo-da-ligacao";

import type { ContextoDaTranscricao, TranscricaoPendente } from "./repositorio-das-transcricoes";
import {
  CENTAVOS_POR_MINUTO_DO_TRANSCRITOR,
  ESPERAS_S,
  MAX_TENTATIVAS,
  PRAZO_TOTAL_MS,
  TranscricoesDaTelefonia,
  avisoDeFalha,
  avisoDeTeto,
  avisoSemChave,
  classeDoErro,
  type PortasDaTranscricao,
} from "./transcricoes";

const ORG = "0be7a70c-0000-4000-8000-000000000001";
const VC = "0be7a70c-0000-4000-8000-0000000000aa";
const CONVERSA = "0be7a70c-0000-4000-8000-0000000000bb";
const MENSAGEM = "0be7a70c-0000-4000-8000-0000000000cc";
const CAMINHO = `${ORG}/${CONVERSA}/${MENSAGEM}.mp3`;
const AGORA = new Date("2026-10-09T15:00:00Z");

const contexto = (p: Partial<ContextoDaTranscricao> = {}): ContextoDaTranscricao => ({
  sentido: "recebida",
  empresa: "Totus Telecom",
  idioma: "pt-BR",
  ligada: true,
  gravacao: "stored",
  anonimizado: false,
  contactId: "0be7a70c-0000-4000-8000-0000000000dd",
  conversationId: CONVERSA,
  mensagemId: MENSAGEM,
  caminho: CAMINHO,
  ...p,
});

/** `tentativas` é a tentativa em curso: 1 = a primeira (a reserva já a contou). */
const pendente = (p: Partial<TranscricaoPendente> = {}): TranscricaoPendente => ({
  vcId: VC,
  organizationId: ORG,
  tentativas: 1,
  pedidaEm: new Date(AGORA.getTime() - 5_000),
  ...p,
});

const FALA_SECRETA = "meu CPF é 123 e moro na Rua das Flores";

function dubles(p: { ctx?: ContextoDaTranscricao | null; chave?: string | null } = {}) {
  const registros: Array<{ nivel: string; msg: string; campos?: Record<string, unknown> }> = [];
  const banco = {
    pedir: vi.fn(async () => true),
    pedirAsQueFaltam: vi.fn(async () => 0),
    reservar: vi.fn(async (): Promise<TranscricaoPendente[]> => []),
    reservarUma: vi.fn(async (): Promise<TranscricaoPendente | null> => pendente()),
    contexto: vi.fn(async () => (p.ctx === undefined ? contexto() : p.ctx)),
    concluir: vi.fn(
      async (
        _p: Parameters<PortasDaTranscricao["banco"]["concluir"]>[0],
        _limites?: Parameters<PortasDaTranscricao["banco"]["concluir"]>[1],
      ): Promise<"gravada" | "descartada"> => "gravada",
    ),
    reagendar: vi.fn(async () => undefined),
    falhar: vi.fn(async () => true),
    avisar: vi.fn(async () => undefined),
    descartar: vi.fn(async () => undefined),
    registrarUso: vi.fn(async (_p: Parameters<PortasDaTranscricao["banco"]["registrarUso"]>[0]) => undefined),
  };
  const arquivo = { baixar: vi.fn(async () => Buffer.from([1, 2, 3])) };
  const transcritor = {
    chave: vi.fn(async () => (p.chave === undefined ? "sk-org" : p.chave)),
    transcrever: vi.fn(async (): Promise<TranscricaoComTrechos> => ({
      text: `Totus, boa tarde. ${FALA_SECRETA}`,
      language: "portuguese",
      durationSeconds: 120,
      segments: [
        { start: 0, end: 1.9, text: "Totus, boa tarde." },
        { start: 2.4, end: 6, text: FALA_SECRETA },
      ],
    })),
  };
  const resumidor = {
    perguntar: vi.fn(async (_org: string, _pedido: { system: string; user: string }) =>
      JSON.stringify({ resumo: "O cliente informou os dados para o cadastro.", falas: [[1, "A"], [2, "C"]] }),
    ),
  };
  const orcamento = { conferir: vi.fn(async (_org: string, _contato: string | null): Promise<"segue" | "teto"> => "segue") };
  const log = {
    info: (msg: string, campos?: Record<string, unknown>) => registros.push({ nivel: "info", msg, campos }),
    warn: (msg: string, campos?: Record<string, unknown>) => registros.push({ nivel: "warn", msg, campos }),
    error: (msg: string, campos?: Record<string, unknown>) => registros.push({ nivel: "error", msg, campos }),
  };
  const servico = new TranscricoesDaTelefonia({
    banco,
    arquivo,
    transcritor,
    resumidor,
    orcamento,
    log,
    agora: () => AGORA,
    // Sem esperar de verdade entre as tentativas de gravar.
    prazos: { esperasParaGravarMs: [0, 0] },
  });
  return { servico, banco, arquivo, transcritor, resumidor, orcamento, registros };
}

describe("TranscricoesDaTelefonia — o caminho de uma ligação", () => {
  it("baixa a gravação, transcreve, resume e grava: texto, trechos com quem falou e resumo", async () => {
    const d = dubles();
    expect(await d.servico.processar(pendente())).toBe("pronta");

    expect(d.arquivo.baixar).toHaveBeenCalledWith(CAMINHO);
    expect(d.transcritor.transcrever).toHaveBeenCalledWith("sk-org", expect.any(Buffer), "pt");
    const gravado = d.banco.concluir.mock.calls[0]![0];
    expect(gravado).toMatchObject({
      organizationId: ORG,
      vcId: VC,
      estado: "ready",
      texto: `Totus, boa tarde. ${FALA_SECRETA}`,
      resumo: "O cliente informou os dados para o cadastro.",
      modelo: "whisper-1",
      duracaoMs: 120_000,
    });
    expect(gravado.trechos).toEqual([
      { inicio_ms: 0, fim_ms: 1900, quem: "atendente", texto: "Totus, boa tarde." },
      { inicio_ms: 2400, fim_ms: 6000, quem: "cliente", texto: FALA_SECRETA },
    ]);
  });

  it("o pedido ao modelo leva a empresa, o sentido e os trechos numerados", async () => {
    const d = dubles({ ctx: contexto({ sentido: "feita", idioma: "es" }) });
    await d.servico.processar(pendente());
    const pedido = d.resumidor.perguntar.mock.calls[0]![1];
    expect(pedido.system).toContain("Totus Telecom");
    expect(pedido.system).toContain("em espanhol");
    expect(pedido.user).toContain("feita (a empresa ligou para o cliente)");
    expect(pedido.user).toContain("1. Totus, boa tarde.");
    expect(d.transcritor.transcrever).toHaveBeenCalledWith("sk-org", expect.any(Buffer), "es");
  });

  it("registra o uso do transcritor com o custo pelo tempo de áudio", async () => {
    const d = dubles();
    await d.servico.processar(pendente());
    expect(d.banco.registrarUso).toHaveBeenCalledTimes(1);
    expect(d.banco.registrarUso.mock.calls[0]![0]).toMatchObject({
      organizationId: ORG,
      proposito: "transcricao_de_ligacao",
      modelo: "whisper-1",
      custoCents: 2 * CENTAVOS_POR_MINUTO_DO_TRANSCRITOR,
      erro: null,
    });
  });

  it("NENHUMA linha de log leva o texto da ligação nem a chave", async () => {
    const d = dubles();
    await d.servico.processar(pendente());
    const tudo = JSON.stringify(d.registros);
    expect(d.registros.length).toBeGreaterThan(0);
    expect(tudo).not.toContain("CPF");
    expect(tudo).not.toContain("boa tarde");
    expect(tudo).not.toContain("sk-org");
    expect(tudo).not.toContain("cadastro");
  });

  it("gravação sem fala: fica `empty`, e o modelo de conversa nem é chamado", async () => {
    const d = dubles();
    d.transcritor.transcrever.mockResolvedValueOnce({ text: "", language: null, durationSeconds: 3, segments: [] });
    expect(await d.servico.processar(pendente())).toBe("sem_fala");
    expect(d.banco.concluir.mock.calls[0]![0]).toMatchObject({ estado: "empty", texto: null, trechos: [], resumo: null });
    expect(d.resumidor.perguntar).not.toHaveBeenCalled();
  });

  it("a mesma ligação pedida duas vezes ao mesmo tempo só é feita uma", async () => {
    const d = dubles();
    const [a, b] = await Promise.all([d.servico.processar(pendente()), d.servico.processar(pendente())]);
    expect([a, b].sort()).toEqual(["em_curso", "pronta"]);
    expect(d.transcritor.transcrever).toHaveBeenCalledTimes(1);
  });
});

describe("TranscricoesDaTelefonia — quando o pedido deixou de valer", () => {
  it.each([
    ["a organização desligou a transcrição", contexto({ ligada: false })],
    ["o contato foi anonimizado", contexto({ anonimizado: true })],
    ["a gravação venceu", contexto({ gravacao: "expired" })],
    ["a ligação sumiu", null],
  ])("%s: descarta, e NADA vai ao provedor", async (_nome, ctx) => {
    const d = dubles({ ctx });
    expect(await d.servico.processar(pendente())).toBe("descartada");
    expect(d.banco.descartar).toHaveBeenCalledWith(ORG, VC);
    expect(d.transcritor.chave).not.toHaveBeenCalled();
    expect(d.arquivo.baixar).not.toHaveBeenCalled();
    expect(d.transcritor.transcrever).not.toHaveBeenCalled();
    expect(d.resumidor.perguntar).not.toHaveBeenCalled();
    expect(d.banco.concluir).not.toHaveBeenCalled();
  });

  it.each([
    ["o arquivo não é o da gravação", contexto({ caminho: `${ORG}/${CONVERSA}/outra-mensagem.mp3` })],
    ["o arquivo é de outra organização", contexto({ caminho: `0be7a70c-0000-4000-8000-0000000000ff/${CONVERSA}/${MENSAGEM}.mp3` })],
    ["a mensagem da ligação não existe", contexto({ mensagemId: null, caminho: null })],
  ])("%s: falha TERMINAL (a linha fica, senão a passada pediria de novo a cada minuto), sem ir ao provedor e sem aviso na Central", async (_nome, ctx) => {
    const d = dubles({ ctx });
    expect(await d.servico.processar(pendente())).toBe("falhou");
    expect(d.banco.falhar).toHaveBeenCalledWith(ORG, VC, "arquivo_invalido", null);
    expect(d.banco.descartar).not.toHaveBeenCalled();
    expect(d.banco.reagendar).not.toHaveBeenCalled();
    expect(d.arquivo.baixar).not.toHaveBeenCalled();
    expect(d.transcritor.transcrever).not.toHaveBeenCalled();
  });

  it("anonimizada no meio do caminho: a gravação do texto é recusada pelo banco e o desfecho é `descartada`", async () => {
    const d = dubles();
    d.banco.concluir.mockResolvedValueOnce("descartada" as never);
    expect(await d.servico.processar(pendente())).toBe("descartada");
  });
});

describe("TranscricoesDaTelefonia — quando falha", () => {
  it("sem chave: a Central é avisada já na primeira vez, e a ligação volta para a fila", async () => {
    const d = dubles({ chave: null });
    expect(await d.servico.processar(pendente())).toBe("adiada");
    expect(d.banco.avisar).toHaveBeenCalledWith(ORG, avisoSemChave("pt-BR"));
    expect(d.banco.reagendar).toHaveBeenCalledWith(ORG, VC, ESPERAS_S[0], "sem_chave");
    expect(d.arquivo.baixar).not.toHaveBeenCalled();
    expect(d.transcritor.transcrever).not.toHaveBeenCalled();
  });

  it("sem chave até a última tentativa: dada como perdida, com o aviso da chave", async () => {
    const d = dubles({ chave: null });
    expect(await d.servico.processar(pendente({ tentativas: MAX_TENTATIVAS }))).toBe("falhou");
    expect(d.banco.falhar).toHaveBeenCalledWith(ORG, VC, "sem_chave", avisoSemChave("pt-BR"));
    expect(d.banco.reagendar).not.toHaveBeenCalled();
  });

  it("teto de gasto de IA atingido: NADA é baixado nem enviado, e a ligação espera como numa falha", async () => {
    const d = dubles();
    d.orcamento.conferir.mockResolvedValueOnce("teto");
    expect(await d.servico.processar(pendente())).toBe("adiada");
    expect(d.orcamento.conferir).toHaveBeenCalledWith(ORG, contexto().contactId);
    expect(d.banco.reagendar).toHaveBeenCalledWith(ORG, VC, ESPERAS_S[0], "teto_de_gasto");
    expect(d.arquivo.baixar).not.toHaveBeenCalled();
    expect(d.transcritor.transcrever).not.toHaveBeenCalled();
    expect(d.banco.registrarUso).not.toHaveBeenCalled();
  });

  it("teto de gasto até a última tentativa: perdida, com o aviso que diz que foi o teto (e não a chave)", async () => {
    const d = dubles();
    d.orcamento.conferir.mockResolvedValueOnce("teto");
    expect(await d.servico.processar(pendente({ tentativas: MAX_TENTATIVAS }))).toBe("falhou");
    expect(d.banco.falhar).toHaveBeenCalledWith(ORG, VC, "teto_de_gasto", avisoDeTeto("pt-BR"));
    expect(avisoDeTeto("pt-BR").titulo).not.toBe(avisoDeFalha("pt-BR").titulo);
  });

  it("os avisos mandam a pessoa à tela que resolve — com o nome que a navegação dá a ela, nos dois idiomas", () => {
    // O aviso de teto já apontou "Provedores", onde não há teto nenhum. O nome
    // sai do catálogo de navegação: tela renomeada lá reprova aqui.
    const tela = (href: string) => {
      const destino = NAV_CATALOG.find((d) => d.href === href);
      if (!destino) throw new Error(`a navegação não tem ${href}`);
      return destino.label;
    };
    const teto = tela("/app/ai/usage");
    const provedores = tela("/app/ai/providers");
    expect(avisoDeTeto("pt-BR").corpo).toContain(`Agente de IA → ${teto}`);
    expect(avisoDeTeto("pt-BR").corpo).not.toContain(`Agente de IA → ${provedores}`);
    expect(avisoDeTeto("es").corpo).toContain(`Agente de IA → ${traduzir(teto, "es")}`);
    expect(avisoDeTeto("es").corpo).not.toBe(avisoDeTeto("pt-BR").corpo);
    // A chave, essa sim, mora em Provedores.
    expect(avisoSemChave("pt-BR").corpo).toContain(`Agente de IA → ${provedores}`);
    expect(avisoDeFalha("pt-BR").corpo).toContain(`Agente de IA → ${provedores}`);
  });

  it("o teto só é conferido DEPOIS de saber que há o que transcrever e que há chave", async () => {
    const semChave = dubles({ chave: null });
    await semChave.servico.processar(pendente());
    expect(semChave.orcamento.conferir).not.toHaveBeenCalled();
    const desligada = dubles({ ctx: contexto({ ligada: false }) });
    await desligada.servico.processar(pendente());
    expect(desligada.orcamento.conferir).not.toHaveBeenCalled();
  });

  it("o provedor recusa: conta a tentativa, registra o erro e espera cada vez mais", async () => {
    for (const [tentativas, espera] of [
      [1, ESPERAS_S[0]],
      [2, ESPERAS_S[1]],
      [4, ESPERAS_S[3]],
    ] as const) {
      const d = dubles();
      d.transcritor.transcrever.mockRejectedValueOnce(new Error("transcription_429"));
      expect(await d.servico.processar(pendente({ tentativas }))).toBe("adiada");
      expect(d.banco.reagendar).toHaveBeenCalledWith(ORG, VC, espera, "transcription_429");
      expect(d.banco.registrarUso.mock.calls[0]![0]).toMatchObject({ erro: "transcription_429", custoCents: null });
      expect(d.banco.concluir).not.toHaveBeenCalled();
    }
  });

  it("na última tentativa a transcrição é dada como perdida e a Central avisa", async () => {
    const d = dubles();
    d.transcritor.transcrever.mockRejectedValueOnce(new Error("transcription_401"));
    expect(await d.servico.processar(pendente({ tentativas: MAX_TENTATIVAS }))).toBe("falhou");
    expect(d.banco.falhar).toHaveBeenCalledWith(ORG, VC, "transcription_401", avisoDeFalha("pt-BR"));
  });

  it("o worker caiu no meio das tentativas anteriores (reservada além do limite sem nunca registrar falha): não tenta de novo, e NADA vai ao provedor", async () => {
    // A reserva conta a tentativa. Uma ligação que derruba o worker chega aqui
    // como a 6ª reserva sem ter passado por `reagendar` nem `falhar`.
    const d = dubles();
    expect(await d.servico.processar(pendente({ tentativas: MAX_TENTATIVAS + 1 }))).toBe("falhou");
    expect(d.banco.falhar).toHaveBeenCalledWith(ORG, VC, "tentativas_esgotadas", avisoDeFalha("pt-BR"));
    expect(d.arquivo.baixar).not.toHaveBeenCalled();
    expect(d.transcritor.transcrever).not.toHaveBeenCalled();
  });

  it("a última tentativa permitida ainda é feita: o limite não corta uma a menos", async () => {
    const d = dubles();
    expect(await d.servico.processar(pendente({ tentativas: MAX_TENTATIVAS }))).toBe("pronta");
  });

  it("pedida há mais que o prazo total e reservada de novo: perdida sem nova ida ao provedor", async () => {
    const d = dubles();
    const velha = pendente({ tentativas: 2, pedidaEm: new Date(AGORA.getTime() - PRAZO_TOTAL_MS - 1) });
    expect(await d.servico.processar(velha)).toBe("falhou");
    expect(d.transcritor.transcrever).not.toHaveBeenCalled();
  });

  it("o prazo total vence DURANTE a tentativa (a transcrição demorou): a falha dela já é a definitiva", async () => {
    let agora = AGORA.getTime();
    const d = dubles();
    const servico = new TranscricoesDaTelefonia({
      banco: d.banco,
      arquivo: d.arquivo,
      transcritor: d.transcritor,
      resumidor: d.resumidor,
      orcamento: d.orcamento,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      agora: () => new Date(agora),
    });
    d.transcritor.transcrever.mockImplementationOnce(async () => {
      agora += 2 * 60_000;
      throw new Error("transcription_503");
    });
    const quase = pendente({ tentativas: 2, pedidaEm: new Date(AGORA.getTime() - PRAZO_TOTAL_MS + 60_000) });
    expect(await servico.processar(quase)).toBe("falhou");
    expect(d.banco.falhar).toHaveBeenCalledWith(ORG, VC, "transcription_503", avisoDeFalha("pt-BR"));
  });

  it("o Storage não entrega o arquivo: nova tentativa, sem chamar o provedor", async () => {
    const d = dubles();
    d.arquivo.baixar.mockRejectedValueOnce(new Error("storage_download"));
    expect(await d.servico.processar(pendente())).toBe("adiada");
    expect(d.banco.reagendar).toHaveBeenCalledWith(ORG, VC, ESPERAS_S[0], "storage_download");
    expect(d.transcritor.transcrever).not.toHaveBeenCalled();
    expect(d.banco.registrarUso).not.toHaveBeenCalled();
  });

  it("o banco fora no meio: não lança, e a ligação volta quando a reserva vencer", async () => {
    const d = dubles();
    d.banco.contexto.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    expect(await d.servico.processar(pendente())).toBe("adiada");
    // A mensagem crua do erro não vai ao log — só a classe.
    expect(JSON.stringify(d.registros)).not.toContain("connection terminated");
  });

  it("o banco tropeça ao GRAVAR o resultado: insiste, e o que já foi pago ao provedor não é refeito", async () => {
    const d = dubles();
    d.banco.concluir.mockRejectedValueOnce(new Error("Connection terminated unexpectedly")).mockRejectedValueOnce(new Error("pool is ending"));
    expect(await d.servico.processar(pendente())).toBe("pronta");
    expect(d.banco.concluir).toHaveBeenCalledTimes(3);
    expect(d.transcritor.transcrever).toHaveBeenCalledTimes(1);
    expect(d.resumidor.perguntar).toHaveBeenCalledTimes(1);
    expect(d.banco.reagendar).not.toHaveBeenCalled();
  });

  it("o banco não grava em nenhuma tentativa: a falha fica registrada na linha (com espera), em vez de sumir até a reserva vencer", async () => {
    const d = dubles();
    d.banco.concluir.mockRejectedValue(new Error("invalid input syntax for type json"));
    expect(await d.servico.processar(pendente())).toBe("adiada");
    expect(d.banco.concluir).toHaveBeenCalledTimes(3);
    expect(d.banco.reagendar).toHaveBeenCalledWith(ORG, VC, ESPERAS_S[0], "gravar_falhou");
    expect(JSON.stringify(d.registros)).not.toContain("invalid input syntax");
  });

  it("gravar que não responde (o banco esperando uma trava) tem prazo: não segura a fila das outras ligações", async () => {
    const d = dubles();
    const servico = new TranscricoesDaTelefonia({
      banco: d.banco,
      arquivo: d.arquivo,
      transcritor: d.transcritor,
      resumidor: d.resumidor,
      orcamento: d.orcamento,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      agora: () => AGORA,
      prazos: { gravarMs: 20, esperasParaGravarMs: [0] },
    });
    d.banco.concluir.mockImplementation(() => new Promise(() => undefined));
    expect(await servico.processar(pendente())).toBe("adiada");
    expect(d.banco.concluir).toHaveBeenCalledTimes(2);
    expect(d.banco.reagendar).toHaveBeenCalledWith(ORG, VC, ESPERAS_S[0], "gravar_falhou");
  });

  it("a tentativa de gravar que estoura o prazo fica marcada como ABANDONADA — e só ela: a que ainda corre, não", async () => {
    const d = dubles();
    const marcas: Array<() => boolean> = [];
    const noMomento: boolean[] = [];
    const servico = new TranscricoesDaTelefonia({
      banco: d.banco,
      arquivo: d.arquivo,
      transcritor: d.transcritor,
      resumidor: d.resumidor,
      orcamento: d.orcamento,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      agora: () => AGORA,
      prazos: { gravarMs: 20, esperasParaGravarMs: [0] },
    });
    d.banco.concluir.mockImplementation((_p, limites) => {
      marcas.push(limites!.abandonada);
      // Ao COMEÇAR, a tentativa não está abandonada; a anterior, que estourou, está.
      noMomento.push(limites!.abandonada());
      if (marcas.length === 1) return new Promise(() => undefined);
      return Promise.resolve("gravada" as const);
    });
    expect(await servico.processar(pendente())).toBe("pronta");
    expect(noMomento).toEqual([false, false]);
    expect(marcas[0]!()).toBe(true);
    expect(marcas[1]!()).toBe(false);
    // O que já foi pago não é refeito por causa de uma tentativa lenta de gravar.
    expect(d.transcritor.transcrever).toHaveBeenCalledTimes(1);
  });

  it("caractere nulo no texto do transcritor ou no resumo não chega ao banco (o Postgres o recusa, e a recusa custaria tudo de novo)", async () => {
    const d = dubles();
    d.transcritor.transcrever.mockResolvedValueOnce({
      text: "x",
      language: "portuguese",
      durationSeconds: 5,
      segments: [{ start: 0, end: 2, text: "Alô\u0000, bom dia." }],
    });
    d.resumidor.perguntar.mockResolvedValueOnce(JSON.stringify({ resumo: "Cumprimento\u0000 inicial.", falas: [[1, "C"]] }));
    await d.servico.processar(pendente());
    const gravado = d.banco.concluir.mock.calls[0]![0];
    expect(JSON.stringify(gravado)).not.toContain("\\u0000");
    expect(gravado.trechos[0]!.texto).toBe("Alô, bom dia.");
    expect(gravado.texto).toBe("Alô, bom dia.");
    expect(gravado.resumo).toBe("Cumprimento inicial.");
  });

  it("a telemetria que falha não derruba a transcrição", async () => {
    const d = dubles();
    d.banco.registrarUso.mockRejectedValueOnce(new Error("llm_calls fora"));
    expect(await d.servico.processar(pendente())).toBe("pronta");
  });
});

describe("TranscricoesDaTelefonia — o resumo nunca derruba a transcrição", () => {
  it("o modelo de conversa falha: o texto é guardado sem resumo e sem quem falou", async () => {
    const d = dubles();
    d.resumidor.perguntar.mockRejectedValueOnce(new Error("budget_exceeded"));
    expect(await d.servico.processar(pendente())).toBe("pronta");
    const gravado = d.banco.concluir.mock.calls[0]![0];
    expect(gravado.estado).toBe("ready");
    expect(gravado.resumo).toBeNull();
    expect(gravado.trechos.map((t) => t.quem)).toEqual([null, null]);
    expect(gravado.texto).toContain("Totus, boa tarde.");
  });

  it("resposta que não é o formato pedido: mesma coisa — e o texto do transcritor não muda", async () => {
    const d = dubles();
    d.resumidor.perguntar.mockResolvedValueOnce("Desculpe, não posso ajudar com isso.");
    expect(await d.servico.processar(pendente())).toBe("pronta");
    const gravado = d.banco.concluir.mock.calls[0]![0];
    expect(gravado.resumo).toBeNull();
    expect(gravado.trechos.map((t) => t.texto)).toEqual(["Totus, boa tarde.", FALA_SECRETA]);
  });

  it("o modelo NÃO reescreve a ligação: o que ele devolver além das letras é ignorado", async () => {
    const d = dubles();
    d.resumidor.perguntar.mockResolvedValueOnce(
      JSON.stringify({ resumo: "Ok.", falas: [[1, "C"], [2, "A"]], trechos: ["texto inventado", "outro"] }),
    );
    await d.servico.processar(pendente());
    const gravado = d.banco.concluir.mock.calls[0]![0];
    expect(gravado.trechos.map((t) => t.texto)).toEqual(["Totus, boa tarde.", FALA_SECRETA]);
    expect(gravado.trechos.map((t) => t.quem)).toEqual(["cliente", "atendente"]);
  });
});

describe("TranscricoesDaTelefonia — a ligação longa vai em blocos", () => {
  const longa = (n: number) => ({
    text: "x",
    language: "portuguese",
    durationSeconds: n * 3,
    segments: Array.from({ length: n }, (_, i) => ({ start: i * 3, end: i * 3 + 2, text: `trecho ${i + 1}` })),
  });
  const respostaDoBloco = (pedido: { user: string }, resumo: string | null) => {
    const numeros = [...pedido.user.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    return JSON.stringify({ ...(resumo ? { resumo } : {}), falas: numeros.map((n) => [n, n % 2 ? "A" : "C"]) });
  };

  it("cada bloco leva o resumo até ali, e o resumo final é o do último", async () => {
    const d = dubles();
    const n = 2 * TRECHOS_POR_BLOCO + 50;
    d.transcritor.transcrever.mockResolvedValueOnce(longa(n));
    let bloco = 0;
    d.resumidor.perguntar.mockImplementation(async (_org, pedido) => respostaDoBloco(pedido, `resumo ${(bloco += 1)}`));

    expect(await d.servico.processar(pendente())).toBe("pronta");
    expect(d.resumidor.perguntar).toHaveBeenCalledTimes(3);
    const pedidos = d.resumidor.perguntar.mock.calls.map((c) => c[1]);
    expect(pedidos[0]!.user).not.toContain("Resumo até aqui");
    expect(pedidos[1]!.user).toContain("Resumo até aqui: resumo 1");
    expect(pedidos[2]!.user).toContain("Resumo até aqui: resumo 2");
    expect(pedidos[1]!.user).toContain(`${TRECHOS_POR_BLOCO + 1}. trecho ${TRECHOS_POR_BLOCO + 1}`);

    const gravado = d.banco.concluir.mock.calls[0]![0];
    expect(gravado.resumo).toBe("resumo 3");
    expect(gravado.trechos).toHaveLength(n);
    expect(gravado.trechos.every((t) => t.quem !== null)).toBe(true);
    expect(gravado.trechos[TRECHOS_POR_BLOCO]!.quem).toBe("atendente");
  });

  it("um bloco sem resumo: a ligação fica SEM resumo (um resumo parcial mentiria), mas quem falou vale", async () => {
    const d = dubles();
    d.transcritor.transcrever.mockResolvedValueOnce(longa(TRECHOS_POR_BLOCO + 10));
    let bloco = 0;
    d.resumidor.perguntar.mockImplementation(async (_org, pedido) =>
      respostaDoBloco(pedido, (bloco += 1) === 1 ? null : "só o fim"),
    );
    await d.servico.processar(pendente());
    const gravado = d.banco.concluir.mock.calls[0]![0];
    expect(gravado.resumo).toBeNull();
    expect(gravado.trechos.every((t) => t.quem !== null)).toBe(true);
    // O bloco seguinte não recebe como "até aqui" um resumo que não existe.
    expect(d.resumidor.perguntar.mock.calls[1]![1].user).not.toContain("Resumo até aqui");
  });

  it("o modelo para de responder no meio: sem resumo, e o que já foi marcado fica", async () => {
    const d = dubles();
    d.transcritor.transcrever.mockResolvedValueOnce(longa(TRECHOS_POR_BLOCO + 10));
    d.resumidor.perguntar
      .mockImplementationOnce(async (_org, pedido) => respostaDoBloco(pedido, "começo"))
      .mockRejectedValueOnce(new Error("resumo_sem_resposta"));
    expect(await d.servico.processar(pendente())).toBe("pronta");
    const gravado = d.banco.concluir.mock.calls[0]![0];
    expect(gravado.resumo).toBeNull();
    expect(gravado.trechos[0]!.quem).toBe("atendente");
    expect(gravado.trechos[TRECHOS_POR_BLOCO]!.quem).toBeNull();
  });
});

describe("TranscricoesDaTelefonia — o pedido", () => {
  const assentar = () => new Promise((r) => setTimeout(r, 0));

  it("aoGuardar: pede, reserva e transcreve logo", async () => {
    const d = dubles();
    d.servico.aoGuardar(ORG, VC);
    await assentar();
    await assentar();
    expect(d.banco.pedir).toHaveBeenCalledWith(ORG, VC);
    expect(d.banco.reservarUma).toHaveBeenCalledWith(ORG, VC, expect.any(Number));
    expect(d.banco.concluir).toHaveBeenCalledTimes(1);
  });

  it("aoGuardar: organização que não ligou a transcrição não gera pedido nem ida ao provedor", async () => {
    const d = dubles();
    d.banco.pedir.mockResolvedValueOnce(false);
    d.servico.aoGuardar(ORG, VC);
    await assentar();
    expect(d.banco.reservarUma).not.toHaveBeenCalled();
    expect(d.transcritor.transcrever).not.toHaveBeenCalled();
  });

  it("aoGuardar NUNCA lança — quem chama é o processamento da gravação", async () => {
    const d = dubles();
    d.banco.pedir.mockRejectedValueOnce(new Error("relation voice_call_transcripts does not exist"));
    expect(() => d.servico.aoGuardar(ORG, VC)).not.toThrow();
    await assentar();
    expect(d.registros.some((r) => r.nivel === "warn")).toBe(true);
  });

  it("a passada repõe o pedido perdido e faz as pendentes em série, na ordem", async () => {
    const d = dubles();
    const outra = "0be7a70c-0000-4000-8000-0000000000ee";
    d.banco.pedirAsQueFaltam.mockResolvedValueOnce(2);
    d.banco.reservar.mockResolvedValueOnce([pendente(), pendente({ vcId: outra })]);
    await d.servico.passada();
    expect(d.banco.pedirAsQueFaltam).toHaveBeenCalledTimes(1);
    expect(d.banco.concluir.mock.calls.map((c) => c[0].vcId)).toEqual([VC, outra]);
  });
});

describe("classeDoErro", () => {
  it("deixa passar só os códigos deste módulo; o resto vira o nome do erro", () => {
    expect(classeDoErro(new Error("transcription_429"))).toBe("transcription_429");
    expect(classeDoErro(new Error("download_sem_resposta"))).toBe("download_sem_resposta");
    expect(classeDoErro("sem_chave")).toBe("sem_chave");
    expect(classeDoErro(new TypeError("fetch failed: o cliente disse que mora na Rua X"))).toBe("TypeError");
    expect(classeDoErro({ qualquer: "coisa" })).toBe("erro");
    expect(classeDoErro("Texto com espaço")).toBe("erro");
  });
});
