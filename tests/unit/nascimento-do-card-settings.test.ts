import { describe, expect, it, vi } from "vitest";

import {
  NASCIMENTO_DO_CARD_PADRAO,
  nascimentoDoCard,
  nascimentoDoCardWriteSchema,
} from "@/lib/schemas/settings";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe("nascimentoDoCard — leitura que perdoa", () => {
  it("organização sem a chave lê como toda_conversa, o comportamento de sempre", () => {
    expect(nascimentoDoCard({})).toEqual({ modo: "toda_conversa", limiar: 0.7 });
    expect(nascimentoDoCard(null)).toEqual(NASCIMENTO_DO_CARD_PADRAO);
  });

  it("lê o modo classificador e o limiar gravados", () => {
    expect(nascimentoDoCard({ crm: { nascimento_do_card: { modo: "classificador", limiar: 0.8 } } })).toEqual({
      modo: "classificador",
      limiar: 0.8,
    });
  });

  it("lixo cai no padrão — na dúvida, o card nasce", () => {
    expect(nascimentoDoCard({ crm: { nascimento_do_card: { modo: "talvez", limiar: "alto" } } })).toEqual(
      NASCIMENTO_DO_CARD_PADRAO,
    );
    expect(nascimentoDoCard({ crm: "x" })).toEqual(NASCIMENTO_DO_CARD_PADRAO);
  });

  it("não confunde a vizinha cliente_pela_agenda", () => {
    expect(nascimentoDoCard({ crm: { cliente_pela_agenda: true } }).modo).toBe("toda_conversa");
  });
});

describe("nascimentoDoCardWriteSchema — escrita estrita", () => {
  it("aceita só os limiares da tela", () => {
    expect(nascimentoDoCardWriteSchema.safeParse({ modo: "classificador", limiar: 0.7 }).success).toBe(true);
    expect(nascimentoDoCardWriteSchema.safeParse({ modo: "classificador", limiar: 0.75 }).success).toBe(false);
    expect(nascimentoDoCardWriteSchema.safeParse({ modo: "outro", limiar: 0.7 }).success).toBe(false);
  });
});

describe("lerNascimentoDoCard — servidor, nunca lança", () => {
  it("falha de leitura devolve o padrão (o card nasce como sempre)", async () => {
    const { lerNascimentoDoCard } = await import("@/lib/leads/modo-de-nascimento");
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "fora" } }) }) }),
      }),
    } as never;
    expect(await lerNascimentoDoCard(db, "org-1")).toEqual(NASCIMENTO_DO_CARD_PADRAO);
  });

  it("lê a regra gravada", async () => {
    const { lerNascimentoDoCard } = await import("@/lib/leads/modo-de-nascimento");
    const settings = { crm: { nascimento_do_card: { modo: "classificador", limiar: 0.9 } } };
    const db = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings }, error: null }) }) }) }),
    } as never;
    expect(await lerNascimentoDoCard(db, "org-1")).toEqual({ modo: "classificador", limiar: 0.9 });
  });
});
