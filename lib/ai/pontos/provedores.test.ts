import { describe, expect, it } from "vitest";

import { ehLinhaDaChaveDeVoz, PROVEDOR_DE_VOZ, ROTULO_DA_CHAVE_DE_VOZ } from "./provedores";

/**
 * O CRITÉRIO ÚNICO de "esta linha de `ai_provider_credentials` é a chave de
 * voz" — usado por `ehChaveDeVoz` (o cartão em Credenciais de IA) e pela MESMA
 * dupla de constantes que `estadoDaChaveDeVoz`/`chaveDeVoz`
 * (`lib/telefonia/chave-elevenlabs.ts`) passam para a consulta SQL. Antes de
 * existir aqui, o rótulo "ElevenLabs" estava duplicado: uma cópia em
 * `chave-elevenlabs.ts` (server-only) e outra, solta, no componente cliente.
 */
describe("ehLinhaDaChaveDeVoz", () => {
  it("provider e rótulo certos, ativa: é a chave de voz", () => {
    expect(ehLinhaDaChaveDeVoz({ provider: PROVEDOR_DE_VOZ, label: ROTULO_DA_CHAVE_DE_VOZ, is_active: true })).toBe(
      true,
    );
  });

  it("provider certo mas rótulo diferente: NÃO é a chave de voz (coluna de vocabulário aberto)", () => {
    expect(ehLinhaDaChaveDeVoz({ provider: PROVEDOR_DE_VOZ, label: "Outra coisa", is_active: true })).toBe(false);
  });

  it("rótulo certo mas provider diferente: NÃO é a chave de voz", () => {
    expect(ehLinhaDaChaveDeVoz({ provider: "anthropic", label: ROTULO_DA_CHAVE_DE_VOZ, is_active: true })).toBe(
      false,
    );
  });

  it("provider e rótulo certos, mas inativa: NÃO é a chave de voz vigente", () => {
    expect(ehLinhaDaChaveDeVoz({ provider: PROVEDOR_DE_VOZ, label: ROTULO_DA_CHAVE_DE_VOZ, is_active: false })).toBe(
      false,
    );
  });

  it("sem `is_active` informado: só provider e rótulo decidem (quem já filtrou is_active na query não repete)", () => {
    expect(ehLinhaDaChaveDeVoz({ provider: PROVEDOR_DE_VOZ, label: ROTULO_DA_CHAVE_DE_VOZ })).toBe(true);
  });
});
