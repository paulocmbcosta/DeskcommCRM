/**
 * `vincular` — o INSERT idempotente e a PROMOÇÃO no `23505`.
 *
 * O admin falso reproduz só as dias formas que `vincular` usa:
 * `from(t).insert(payload)` (devolve `{error}`) e
 * `from(t).update(payload).eq()...in().select()` (devolve `{data, error}`,
 * `data` com N linhas simulando quantas a promoção afetou). Cada chamada é
 * registrada em `chamadas` para provar o QUE foi escrito e COM QUE FILTRO.
 */
import { describe, expect, it } from "vitest";

import { vincular } from "./vinculos";

type Chamada =
  | { op: "insert"; payload: Record<string, unknown> }
  | { op: "update"; payload: Record<string, unknown>; filtros: Record<string, unknown> };

function adminFalso(opts: { erroDoInsert?: { code: string; message: string } | null; linhasPromovidas?: number }) {
  const chamadas: Chamada[] = [];
  return {
    chamadas,
    from(_tabela: string) {
      return {
        insert: async (payload: Record<string, unknown>) => {
          chamadas.push({ op: "insert", payload });
          return { error: opts.erroDoInsert ?? null };
        },
        update: (payload: Record<string, unknown>) => {
          const filtros: Record<string, unknown> = {};
          const chain = {
            eq: (coluna: string, valor: unknown) => {
              filtros[coluna] = valor;
              return chain;
            },
            in: (coluna: string, valores: unknown) => {
              filtros[coluna] = valores;
              return chain;
            },
            select: async () => {
              chamadas.push({ op: "update", payload, filtros });
              const n = opts.linhasPromovidas ?? 0;
              return { data: Array.from({ length: n }, () => ({ contact_id: "contato-1" })), error: null };
            },
          };
          return chain;
        },
      };
    },
  };
}

/** `vincular` espera o client real (`ReturnType<typeof createAdminClient>`); o falso só precisa da forma que ele usa. */
function comoAdmin(admin: ReturnType<typeof adminFalso>): Parameters<typeof vincular>[0]["admin"] {
  return admin as never;
}

const PEDIDO_BASE = {
  orgId: "org-1",
  contactId: "contato-1",
  conector: "ixc" as const,
  externalId: "10",
  userId: "user-1",
};

describe("vincular — insert sem conflito", () => {
  it("cria a linha e devolve vinculou:true, promovido:false — sem tocar em update nenhum", async () => {
    const admin = adminFalso({ erroDoInsert: null });
    const resultado = await vincular({ admin: comoAdmin(admin), ...PEDIDO_BASE, verificadoPor: "telefone" });
    expect(resultado).toEqual({ vinculou: true, promovido: false });
    expect(admin.chamadas).toEqual([{ op: "insert", payload: expect.objectContaining({ verificado_por: "telefone" }) }]);
  });
});

describe("vincular — 23505 (linha já existe)", () => {
  it("(a) chega documento, linha existente é MAIS FRACA (telefone) → PROMOVE e devolve true", async () => {
    const admin = adminFalso({ erroDoInsert: { code: "23505", message: "dup" }, linhasPromovidas: 1 });
    const resultado = await vincular({ admin: comoAdmin(admin), ...PEDIDO_BASE, verificadoPor: "documento" });
    expect(resultado).toEqual({ vinculou: true, promovido: true });
    expect(admin.chamadas).toEqual([
      expect.objectContaining({ op: "insert" }),
      {
        op: "update",
        payload: expect.objectContaining({ verificado_por: "documento", created_by: "user-1" }),
        filtros: expect.objectContaining({
          organization_id: "org-1",
          contact_id: "contato-1",
          conector: "ixc",
          external_id: "10",
          verificado_por: ["telefone"],
        }),
      },
    ]);
  });

  it("(a) chega manual, linha existente é MAIS FRACA (telefone) → PROMOVE e devolve true", async () => {
    const admin = adminFalso({ erroDoInsert: { code: "23505", message: "dup" }, linhasPromovidas: 1 });
    const resultado = await vincular({ admin: comoAdmin(admin), ...PEDIDO_BASE, verificadoPor: "manual" });
    expect(resultado).toEqual({ vinculou: true, promovido: true });
    const update = admin.chamadas[1];
    expect(update).toMatchObject({ op: "update", filtros: { verificado_por: ["telefone", "documento"] } });
  });

  it("(b) chega telefone → NUNCA promove: nem tenta o update, devolve false", async () => {
    const admin = adminFalso({ erroDoInsert: { code: "23505", message: "dup" }, linhasPromovidas: 1 });
    const resultado = await vincular({ admin: comoAdmin(admin), ...PEDIDO_BASE, verificadoPor: "telefone" });
    expect(resultado).toEqual({ vinculou: false, promovido: false });
    // Só o insert foi tentado — nenhum update, mesmo que o banco de mentira
    // estivesse pronto para "promover" 1 linha se fosse chamado.
    expect(admin.chamadas).toEqual([expect.objectContaining({ op: "insert" })]);
  });

  it("(c) linha existente é 'documento' e chega 'manual' → PROMOVE (confirmação humana é mais forte que documento informado)", async () => {
    // Decisão registrada no PR: 'documento' é uma das formas MAIS FRACAS que
    // 'manual', então o filtro do update inclui as duas ("telefone" e
    // "documento") — se a linha real estiver em qualquer uma delas, promove.
    const admin = adminFalso({ erroDoInsert: { code: "23505", message: "dup" }, linhasPromovidas: 1 });
    const resultado = await vincular({ admin: comoAdmin(admin), ...PEDIDO_BASE, verificadoPor: "manual" });
    expect(resultado).toEqual({ vinculou: true, promovido: true });
    expect(admin.chamadas[1]).toMatchObject({ filtros: { verificado_por: expect.arrayContaining(["documento"]) } });
  });

  it("mesma forma nos dois lados (ex.: documento + documento) → filtro não casa nada, devolve false", async () => {
    // O admin falso simula "0 linhas afetadas": o filtro pede 'telefone' (mais
    // fraca que documento) e a linha real já é 'documento' — não é mais fraca
    // que ELA MESMA, então o update de verdade não teria casado.
    const admin = adminFalso({ erroDoInsert: { code: "23505", message: "dup" }, linhasPromovidas: 0 });
    const resultado = await vincular({ admin: comoAdmin(admin), ...PEDIDO_BASE, verificadoPor: "documento" });
    expect(resultado).toEqual({ vinculou: false, promovido: false });
  });

  it("erro que não é 23505 sobe — não é caso de duplicata", async () => {
    const admin = adminFalso({ erroDoInsert: { code: "23503", message: "fk violation" } });
    await expect(vincular({ admin: comoAdmin(admin), ...PEDIDO_BASE, verificadoPor: "manual" })).rejects.toThrow("fk violation");
  });
});
