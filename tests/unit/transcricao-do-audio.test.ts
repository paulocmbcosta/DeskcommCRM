import { describe, expect, it } from "vitest";

import {
  estadoDaTranscricao,
  JANELA_DA_TRANSCRICAO_MS,
  soATranscricaoDoAudio,
  TAMANHO_DO_TRECHO,
  temTranscricaoAEntregar,
  trechoDaTranscricao,
} from "@/lib/inbox/transcricao-do-audio";
import { MARCADOR_NAO_LIDA, MAX_DERIVED_CHARS } from "@/lib/messaging/media/derivable";

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

describe("soATranscricaoDoAudio — o que a listagem entrega", () => {
  const LIBERADO = true;
  const NAO_LIBERADO = false;

  it("áudio com arquivo, de contato liberado: a transcrição sai como está", () => {
    const m = audio();
    expect(soATranscricaoDoAudio(m, LIBERADO)).toBe(m);
  });

  it("áudio ainda só com a URL do provedor (arquivo não guardado): sai", () => {
    const m = audio({ media_storage_path: null, media_url: "https://provedor/arquivo" });
    expect(soATranscricaoDoAudio(m, LIBERADO).media_derived_text).toBe(m.media_derived_text);
  });

  it.each(["image", "document", "video", "text"])(
    "%s: o derivado NÃO sai (descrição e extração não são transcrição)",
    (type) => {
      const saida = soATranscricaoDoAudio(audio({ type }), LIBERADO);
      expect(saida.media_derived_text).toBeNull();
      expect(saida.media_derived_status).toBeNull();
    },
  );

  it("apagada pelo autor: a transcrição não é entregue", () => {
    const saida = soATranscricaoDoAudio(audio({ revoked_at: haSegundos(10) }), LIBERADO);
    expect(saida.media_derived_text).toBeNull();
    expect(saida.media_derived_status).toBeNull();
  });

  it("contato NÃO liberado (anonimizado, ou não deu para saber): não sai, mesmo com o áudio intacto", () => {
    // O botão "Anonimizar" da ficha não toca em `messages`: a linha fica com o
    // arquivo e com o derivado. Quem barra é o fato do contato, não a mídia.
    const saida = soATranscricaoDoAudio(audio(), NAO_LIBERADO);
    expect(saida.media_derived_text).toBeNull();
    expect(saida.media_derived_status).toBeNull();
  });

  it("sem arquivo nenhum (como a cascata de anonimização deixa a linha): não sai", () => {
    const saida = soATranscricaoDoAudio(audio({ media_storage_path: null, media_url: null }), LIBERADO);
    expect(saida.media_derived_text).toBeNull();
    expect(saida.media_derived_status).toBeNull();
  });

  it("não mexe nos outros campos nem na linha original", () => {
    const m = audio({ type: "image", body: "legenda" });
    const saida = soATranscricaoDoAudio(m, LIBERADO);
    expect(saida).toMatchObject({ type: "image", body: "legenda" });
    expect(m.media_derived_text).toBe("Oi, eu queria saber do meu boleto.");
  });

  it("só o áudio com texto pede a conferência do contato", () => {
    expect(temTranscricaoAEntregar(audio())).toBe(true);
    expect(temTranscricaoAEntregar(audio({ media_derived_text: null, media_derived_status: null }))).toBe(false);
    // Imagem com descrição não custa consulta: o derivado dela nunca sai.
    expect(temTranscricaoAEntregar(audio({ type: "image" }))).toBe(false);
  });
});

describe("estadoDaTranscricao — o que o balão mostra", () => {
  it("pronta, com texto: mostra o texto", () => {
    expect(estadoDaTranscricao(audio(), AGORA)).toEqual({
      tipo: "texto",
      texto: "Oi, eu queria saber do meu boleto.",
      incompleta: false,
    });
  });

  it("texto que bateu no teto do derivado é marcado como incompleto", () => {
    // `deriveMediaText` corta em MAX_DERIVED_CHARS: o áudio continua além dali.
    const noTeto = estadoDaTranscricao(audio({ media_derived_text: "a".repeat(MAX_DERIVED_CHARS) }), AGORA);
    expect(noTeto).toMatchObject({ tipo: "texto", incompleta: true });
    const abaixo = estadoDaTranscricao(audio({ media_derived_text: "a".repeat(MAX_DERIVED_CHARS - 1) }), AGORA);
    expect(abaixo).toMatchObject({ tipo: "texto", incompleta: false });
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

  it("leitura que NÃO traz o derivado (super-admin, mensagem otimista): nada, nem 'transcrevendo'", () => {
    // `undefined` ≠ `null`. Com as colunas ausentes a tela não sabe o estado, e
    // o texto nunca chegaria por esse caminho — anunciar seria prometer à toa.
    const semCampos = { type: "audio", direction: "inbound" as const, created_at: haSegundos(5) };
    expect(estadoDaTranscricao(semCampos, AGORA)).toBeNull();
  });

  it("navegador com o relógio poucos segundos atrasado ainda vê 'transcrevendo'", () => {
    // `created_at` é do servidor: para um navegador atrasado, o áudio que acabou
    // de chegar está "no futuro". É o caso comum, não o exótico.
    const m = audio({
      media_derived_status: null,
      media_derived_text: null,
      created_at: new Date(AGORA + 5_000).toISOString(),
    });
    expect(estadoDaTranscricao(m, AGORA)).toEqual({ tipo: "transcrevendo" });
  });

  it("data ilegível, ou longe no futuro, não vira 'transcrevendo'", () => {
    const pendente = { media_derived_status: null, media_derived_text: null };
    expect(estadoDaTranscricao(audio({ ...pendente, created_at: "não é data" }), AGORA)).toBeNull();
    const longe = new Date(AGORA + JANELA_DA_TRANSCRICAO_MS).toISOString();
    expect(estadoDaTranscricao(audio({ ...pendente, created_at: longe }), AGORA)).toBeNull();
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

  it("exatamente no limite da folga não corta; um caractere além, corta", () => {
    const noLimite = `${"palavra ".repeat(22)}abcd`; // 180
    expect(noLimite.length).toBe(180);
    expect(trechoDaTranscricao(noLimite).cortou).toBe(false);
    expect(trechoDaTranscricao(`${noLimite}e`).cortou).toBe(true);
  });

  it("texto curto com MUITAS quebras de linha vira corrido — não ocupa a tela, e nenhuma palavra some", () => {
    const empilhado = Array.from({ length: 30 }, (_, i) => `p${i}`).join("\n\n");
    const { trecho, cortou } = trechoDaTranscricao(empilhado);
    expect(cortou).toBe(false);
    expect(trecho).not.toContain("\n");
    expect(trecho.split(" ")).toHaveLength(30);
  });

  it("texto curto com poucas quebras fica como veio", () => {
    expect(trechoDaTranscricao("Oi.\nTudo bem?").trecho).toBe("Oi.\nTudo bem?");
  });

  it("quebras de linha contam como um espaço na hora de medir o trecho", () => {
    const texto = `linha um\n\n\n${"resto do áudio ".repeat(30)}`;
    expect(trechoDaTranscricao(texto).trecho.startsWith("linha um resto do áudio")).toBe(true);
  });
});
