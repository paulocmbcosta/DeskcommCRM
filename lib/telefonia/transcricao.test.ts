import { describe, expect, it } from "vitest";

import {
  ESTADOS_DA_TRANSCRICAO,
  SITUACAO_DO_ESTADO,
  SITUACOES_DA_TRANSCRICAO,
  falasDaTranscricao,
  ligacaoDoExternalId,
  marcaDeTempo,
  textoCorrido,
  transcricaoDaLigacao,
  trechosDaTranscricao,
  type TrechoDaTranscricao,
} from "./transcricao";

const trecho = (inicio: number, fim: number, quem: TrechoDaTranscricao["quem"], texto: string): TrechoDaTranscricao => ({
  inicio_ms: inicio,
  fim_ms: fim,
  quem,
  texto,
});

describe("vocabulário da transcrição", () => {
  it("todo estado do banco tem uma situação de tela, e toda situação é do vocabulário", () => {
    for (const estado of ESTADOS_DA_TRANSCRICAO) {
      expect(SITUACOES_DA_TRANSCRICAO).toContain(SITUACAO_DO_ESTADO[estado]);
    }
    expect(new Set(Object.values(SITUACAO_DO_ESTADO)).size).toBe(ESTADOS_DA_TRANSCRICAO.length);
  });
});

describe("trechosDaTranscricao", () => {
  it("lê o que o worker grava", () => {
    expect(
      trechosDaTranscricao([
        { inicio_ms: 0, fim_ms: 1200, quem: "atendente", texto: " Totus, boa tarde. " },
        { inicio_ms: 1300, fim_ms: 2000, quem: "cliente", texto: "Oi." },
      ]),
    ).toEqual([trecho(0, 1200, "atendente", "Totus, boa tarde."), trecho(1300, 2000, "cliente", "Oi.")]);
  });

  it("não lança com jsonb torto: o que não é trecho fica de fora", () => {
    expect(trechosDaTranscricao(null)).toEqual([]);
    expect(trechosDaTranscricao({ inicio_ms: 0 })).toEqual([]);
    expect(
      trechosDaTranscricao([null, "texto", [1], { texto: "sem tempo" }, { inicio_ms: -1, texto: "negativo" }, { inicio_ms: 5, texto: "  " }]),
    ).toEqual([]);
  });

  it("quem fora do vocabulário vira nulo, e o texto continua valendo", () => {
    expect(trechosDaTranscricao([{ inicio_ms: 10, fim_ms: 20, quem: "supervisor", texto: "Alô" }])).toEqual([
      trecho(10, 20, null, "Alô"),
    ]);
  });

  it("fim ilegível ou antes do início vale o início", () => {
    expect(trechosDaTranscricao([{ inicio_ms: 500, fim_ms: "x", quem: null, texto: "a" }])[0]?.fim_ms).toBe(500);
    expect(trechosDaTranscricao([{ inicio_ms: 500, fim_ms: 100, quem: null, texto: "a" }])[0]?.fim_ms).toBe(500);
  });
});

describe("transcricaoDaLigacao", () => {
  it("lê a situação e o resumo que a listagem entrega", () => {
    expect(transcricaoDaLigacao({ situacao: "pronta", resumo: " O cliente pediu a segunda via. " })).toEqual({
      situacao: "pronta",
      resumo: "O cliente pediu a segunda via.",
    });
    expect(transcricaoDaLigacao({ situacao: "processando" })).toEqual({ situacao: "processando", resumo: null });
  });

  it("situação desconhecida ou metadado torto: o cartão cala", () => {
    expect(transcricaoDaLigacao({ situacao: "em_revisao" })).toBeNull();
    expect(transcricaoDaLigacao(null)).toBeNull();
    expect(transcricaoDaLigacao("pronta")).toBeNull();
    expect(transcricaoDaLigacao([{ situacao: "pronta" }])).toBeNull();
  });

  it("resumo que não é texto não entra", () => {
    expect(transcricaoDaLigacao({ situacao: "pronta", resumo: { x: 1 } })).toEqual({ situacao: "pronta", resumo: null });
  });
});

describe("falasDaTranscricao", () => {
  it("junta os trechos seguidos da mesma pessoa e separa quando muda quem fala", () => {
    const falas = falasDaTranscricao([
      trecho(0, 1000, "atendente", "Totus,"),
      trecho(1000, 2000, "atendente", "boa tarde."),
      trecho(2500, 3000, "cliente", "Oi,"),
      trecho(3000, 4000, "cliente", "estou sem internet."),
      trecho(4500, 5000, "atendente", "Um momento."),
    ]);
    expect(falas).toEqual([
      { quem: "atendente", inicio_ms: 0, texto: "Totus, boa tarde." },
      { quem: "cliente", inicio_ms: 2500, texto: "Oi, estou sem internet." },
      { quem: "atendente", inicio_ms: 4500, texto: "Um momento." },
    ]);
  });

  it("nenhuma palavra some", () => {
    const trechos = Array.from({ length: 80 }, (_, i) =>
      trecho(i * 1000, i * 1000 + 900, i % 7 === 0 ? "cliente" : "atendente", `palavra${i} e mais um pouco de fala para encher`),
    );
    const falas = falasDaTranscricao(trechos);
    expect(falas.map((f) => f.texto).join(" ")).toBe(textoCorrido(trechos));
  });

  it("uma pausa longa abre outra fala da mesma pessoa", () => {
    const falas = falasDaTranscricao([
      trecho(0, 1000, "atendente", "Vou verificar."),
      trecho(61_000, 62_000, "atendente", "Voltei."),
    ]);
    expect(falas).toHaveLength(2);
    expect(falas[1]?.inicio_ms).toBe(61_000);
  });

  it("fala longa demais é quebrada, para não virar um parágrafo sem fim", () => {
    const trechos = Array.from({ length: 40 }, (_, i) => trecho(i * 1000, i * 1000 + 900, "atendente", "x".repeat(50)));
    const falas = falasDaTranscricao(trechos);
    expect(falas.length).toBeGreaterThan(1);
    for (const f of falas) expect(f.texto.length).toBeLessThanOrEqual(700);
  });

  it("trecho sem quem definido não se mistura com o de quem tem", () => {
    const falas = falasDaTranscricao([trecho(0, 1000, null, "Alô?"), trecho(1000, 2000, "cliente", "Oi.")]);
    expect(falas.map((f) => f.quem)).toEqual([null, "cliente"]);
  });
});

describe("marcaDeTempo", () => {
  it("minutos e segundos; com hora quando passa de 60 min", () => {
    expect(marcaDeTempo(0)).toBe("0:00");
    expect(marcaDeTempo(7_400)).toBe("0:07");
    expect(marcaDeTempo(760_000)).toBe("12:40");
    expect(marcaDeTempo(3_795_000)).toBe("1:03:15");
    expect(marcaDeTempo(-5)).toBe("0:00");
  });
});

describe("ligacaoDoExternalId", () => {
  it("só `ligacao:<uuid>` vira id", () => {
    expect(ligacaoDoExternalId("ligacao:0be7a70c-0000-4000-8000-000000000001")).toBe("0be7a70c-0000-4000-8000-000000000001");
    expect(ligacaoDoExternalId("ligacao:abc")).toBeNull();
    expect(ligacaoDoExternalId("wamid.123")).toBeNull();
    expect(ligacaoDoExternalId(null)).toBeNull();
    expect(ligacaoDoExternalId("ligacao:0be7a70c-0000-4000-8000-000000000001' or 1=1")).toBeNull();
  });
});
