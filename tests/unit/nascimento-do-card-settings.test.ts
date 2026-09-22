import { describe, expect, it, vi } from "vitest";

import {
  LIMIARES_DO_CLASSIFICADOR,
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

  it("duas leituras de lixo NÃO compartilham instância, e mutar uma não contamina a outra", () => {
    const a = nascimentoDoCard({ crm: "x" });
    const b = nascimentoDoCard({ crm: "x" });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    (a as { modo: string }).modo = "classificador";
    expect(b.modo).toBe("toda_conversa");
    expect(nascimentoDoCard({ crm: "x" }).modo).toBe("toda_conversa");
  });

  describe("limiar fora das opções da tela arredonda para a mais próxima", () => {
    const casos: [number, number][] = [
      [0.75, 0.7],
      [0.76, 0.8],
      [0.5, 0.6],
      [0.95, 0.9],
      ...LIMIARES_DO_CLASSIFICADOR.map((limiar): [number, number] => [limiar, limiar]),
    ];

    it.each(casos)("%s → %s", (gravado, esperado) => {
      expect(
        nascimentoDoCard({ crm: { nascimento_do_card: { modo: "classificador", limiar: gravado } } }),
      ).toEqual({ modo: "classificador", limiar: esperado });
    });

    it("fora de [0.5, 0.95] cai no padrão inteiro do campo (0.7), sem mexer no modo", () => {
      expect(nascimentoDoCard({ crm: { nascimento_do_card: { modo: "classificador", limiar: 0.4 } } })).toEqual({
        modo: "classificador",
        limiar: 0.7,
      });
    });

    it("modo inválido cai no padrão do campo sem mexer num limiar válido", () => {
      expect(nascimentoDoCard({ crm: { nascimento_do_card: { modo: "x", limiar: 0.9 } } })).toEqual({
        modo: "toda_conversa",
        limiar: 0.9,
      });
    });

    it("o padrão está entre as opções da tela", () => {
      expect(LIMIARES_DO_CLASSIFICADOR as readonly number[]).toContain(NASCIMENTO_DO_CARD_PADRAO.limiar);
    });
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
  it("falha de leitura devolve o padrão, filtra a organização e loga com organization_id", async () => {
    const { lerNascimentoDoCard } = await import("@/lib/leads/modo-de-nascimento");
    const { logger } = await import("@/lib/logger");
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: null, error: { message: "fora" } }) }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const db = { from } as never;

    expect(await lerNascimentoDoCard(db, "org-1")).toEqual(NASCIMENTO_DO_CARD_PADRAO);

    expect(from).toHaveBeenCalledWith("organizations");
    expect(select).toHaveBeenCalledWith("settings");
    expect(eq).toHaveBeenCalledWith("id", "org-1");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ organization_id: "org-1" }),
    );
  });

  it("lê a regra gravada e filtra pela organização pedida", async () => {
    const { lerNascimentoDoCard } = await import("@/lib/leads/modo-de-nascimento");
    const settings = { crm: { nascimento_do_card: { modo: "classificador", limiar: 0.9 } } };
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: { settings }, error: null }) }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const db = { from } as never;

    expect(await lerNascimentoDoCard(db, "org-2")).toEqual({ modo: "classificador", limiar: 0.9 });

    expect(from).toHaveBeenCalledWith("organizations");
    expect(select).toHaveBeenCalledWith("settings");
    expect(eq).toHaveBeenCalledWith("id", "org-2");
  });
});
