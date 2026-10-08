import { describe, expect, it } from "vitest";

import {
  estadoDaTranscricao,
  JANELA_DA_TRANSCRICAO_MS,
  soATranscricaoDoAudio,
  TAMANHO_DO_TRECHO,
  trechoDaTranscricao,
} from "@/lib/inbox/transcricao-do-audio";
import { MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";

/**
 * A TRANSCRIÇÃO DO ÁUDIO — a regra, sem tela.
 *
 * Três perguntas, e cada uma tem um jeito mudo de dar errado:
 *
 *   1. O que SAI do servidor. Errar para mais é mandar ao navegador a
 *      transcrição de uma mensagem apagada ou de um contato anonimizado.
 *   2. O que o balão MOSTRA. Errar para mais é exibir como fala do cliente um
 *      texto que não é (o marcador do agente) ou prometer "transcrevendo" num
 *      áudio que nunca será transcrito.
 *   3. Onde o trecho CORTA. Errar é oferecer um "Ler mais" que não revela nada.
 */

const AGORA = Date.parse("2026-10-08T12:00:00.000Z");
const haSegundos = (s: number) => new Date(AGORA - s * 1000).toISOString();

function audio(over: Record<string, unknown> = {}) {
  return {
    type: "audio",
    direction: "inbound" as const,
    created_at: haSegundos(3600),
    revoked_at: null,
    media_url: null,
    media_storage_path: "org/conv/msg.ogg",
    media_derived_text: "Oi, eu queria saber do meu boleto.",
    media_derived_status: "ready",
    ...over,
  };
}

describe("soATranscricaoDoAudio — o que a listagem deixa sair", () => {
  it("áudio com arquivo: a transcrição sai como está", () => {
    const m = audio();
    expect(soATranscricaoDoAudio(m)).toBe(m);
  });

  it("áudio ainda só com a URL do provedor (arquivo não guardado): sai", () => {
    const m = audio({ media_storage_path: null, media_url: "https://provedor/arquivo" });
    expect(soATranscricaoDoAudio(m).media_derived_text).toBe(m.media_derived_text);
  });

  it.each(["image", "document", "video", "text"])(
    "%s: o derivado NÃO sai (descrição e extração não são transcrição)",
    (type) => {
      const saida = soATranscricaoDoAudio(audio({ type }));
      expect(saida.media_derived_text).toBeNull();
      expect(saida.media_derived_status).toBeNull();
    },
  );

  it("apagada pelo autor: a transcrição não segue no JSON", () => {
    const saida = soATranscricaoDoAudio(audio({ revoked_at: haSegundos(10) }));
    expect(saida.media_derived_text).toBeNull();
    expect(saida.media_derived_status).toBeNull();
  });

  it("sem arquivo nenhum (o estado em que a anonimização deixa a linha): não sai", () => {
    const saida = soATranscricaoDoAudio(audio({ media_storage_path: null, media_url: null }));
    expect(saida.media_derived_text).toBeNull();
    expect(saida.media_derived_status).toBeNull();
  });

  it("não mexe nos outros campos nem na linha original", () => {
    const m = audio({ type: "image", body: "legenda" });
    const saida = soATranscricaoDoAudio(m);
    expect(saida).toMatchObject({ type: "image", body: "legenda" });
    expect(m.media_derived_text).toBe("Oi, eu queria saber do meu boleto.");
  });
});

describe("estadoDaTranscricao — o que o balão mostra", () => {
  it("pronta, com texto: mostra o texto", () => {
    expect(estadoDaTranscricao(audio(), AGORA)).toEqual({
      tipo: "texto",
      texto: "Oi, eu queria saber do meu boleto.",
    });
  });

  it("pronta e vazia: o áudio foi lido e não havia fala", () => {
    expect(estadoDaTranscricao(audio({ media_derived_text: "  " }), AGORA)).toEqual({
      tipo: "sem_fala",
    });
  });

  it("o marcador do agente NUNCA aparece como fala do cliente", () => {
    expect(estadoDaTranscricao(audio({ media_derived_text: MARCADOR_NAO_LIDA }), AGORA)).toEqual({
      tipo: "indisponivel",
    });
  });

  it("falhou em todas as tentativas: indisponível", () => {
    expect(
      estadoDaTranscricao(audio({ media_derived_status: "failed", media_derived_text: null }), AGORA),
    ).toEqual({ tipo: "indisponivel" });
  });

  it("áudio recebido agora, ainda sem derivado: transcrevendo", () => {
    const m = audio({ media_derived_status: null, media_derived_text: null, created_at: haSegundos(5) });
    expect(estadoDaTranscricao(m, AGORA)).toEqual({ tipo: "transcrevendo" });
  });

  it("passou da janela sem derivado: para de prometer", () => {
    const m = audio({
      media_derived_status: null,
      media_derived_text: null,
      created_at: new Date(AGORA - JANELA_DA_TRANSCRICAO_MS).toISOString(),
    });
    expect(estadoDaTranscricao(m, AGORA)).toBeNull();
  });

  it("áudio gravado pelo atendente não é transcrito: nada, mesmo recém-enviado", () => {
    const m = audio({
      direction: "outbound",
      media_derived_status: null,
      media_derived_text: null,
      created_at: haSegundos(2),
    });
    expect(estadoDaTranscricao(m, AGORA)).toBeNull();
  });

  it("áudio enviado que TEM derivado (resposta pelo celular): mostra", () => {
    expect(estadoDaTranscricao(audio({ direction: "outbound" }), AGORA)?.tipo).toBe("texto");
  });

  it("quem não é áudio não tem transcrição, com derivado ou sem", () => {
    expect(estadoDaTranscricao(audio({ type: "image" }), AGORA)).toBeNull();
  });

  it("os campos ausentes (mensagem otimista) e a data ilegível não quebram", () => {
    const semCampos = { type: "audio", direction: "inbound" as const, created_at: "não é data" };
    expect(estadoDaTranscricao(semCampos, AGORA)).toBeNull();
  });
});

describe("trechoDaTranscricao — onde corta", () => {
  it("texto curto aparece inteiro e sem o que abrir", () => {
    expect(trechoDaTranscricao("Oi, tudo bem?")).toEqual({ trecho: "Oi, tudo bem?", cortou: false });
  });

  it("pouco acima do trecho ainda aparece inteiro — abrir revelaria duas palavras", () => {
    const texto = "palavra ".repeat(22).trim(); // 175 caracteres
    expect(texto.length).toBeGreaterThan(TAMANHO_DO_TRECHO);
    expect(trechoDaTranscricao(texto)).toEqual({ trecho: texto, cortou: false });
  });

  it("texto longo corta em fim de palavra, com reticências", () => {
    const texto = "Bom dia, eu estou sem internet desde ontem à noite e já reiniciei o aparelho. ".repeat(6);
    const { trecho, cortou } = trechoDaTranscricao(texto);
    expect(cortou).toBe(true);
    expect(trecho.endsWith("…")).toBe(true);
    expect(trecho.length).toBeLessThanOrEqual(TAMANHO_DO_TRECHO + 1);
    // O que vem antes das reticências é o COMEÇO do texto, inteiro até ali, e
    // termina numa palavra completa (o caractere seguinte no original é espaço).
    const semReticencias = trecho.slice(0, -1);
    expect(texto.startsWith(semReticencias)).toBe(true);
    expect(/[\s.,;:!?]/.test(texto[semReticencias.length]!)).toBe(true);
  });

  it("não termina em pontuação solta antes das reticências", () => {
    const texto = `${"a".repeat(TAMANHO_DO_TRECHO - 2)}, ${"b ".repeat(80)}`;
    expect(trechoDaTranscricao(texto).trecho).toBe(`${"a".repeat(TAMANHO_DO_TRECHO - 2)}…`);
  });

  it("uma 'palavra' sem espaço corta no limite, sem partir caractere composto", () => {
    const texto = "😀".repeat(300);
    const { trecho, cortou } = trechoDaTranscricao(texto);
    expect(cortou).toBe(true);
    expect(trecho).toBe(`${"😀".repeat(TAMANHO_DO_TRECHO)}…`);
  });

  it("quebras de linha contam como um espaço na hora de medir o trecho", () => {
    const texto = `linha um\n\n\n${"resto do áudio ".repeat(30)}`;
    expect(trechoDaTranscricao(texto).trecho.startsWith("linha um resto do áudio")).toBe(true);
  });
});
