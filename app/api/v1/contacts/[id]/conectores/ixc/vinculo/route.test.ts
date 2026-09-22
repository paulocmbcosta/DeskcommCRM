/**
 * POST .../conectores/ixc/vinculo — o caminho da PROMOÇÃO (achado crítico da
 * re-revisão do lote): um contato com vínculo antigo `verificado_por='telefone'`
 * clica "É este" (`{ cadastro_id }`), o `23505` da linha existente batia, e
 * `vincular` devolvia `false` sem tocar em nada — o contato ficava PRESO, sem
 * jeito de sair de "escolher". Agora `vincular` promove a linha, e este teste
 * prova isso PELA ROTA (não só pela função isolada): `contextoIxc` é mockado
 * para devolver um admin de mentira que reproduz `insert`/`update` de verdade,
 * e `vincular` roda por inteiro — sem mock — contra esse admin falso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  contextoIxc: vi.fn(),
  limparErroSeHavia: vi.fn(),
  respostaDaFalha: vi.fn(),
  clientesPorTelefone: vi.fn(),
  clientesPorDocumento: vi.fn(),
  requireSupportWrite: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../_contexto", () => ({
  contextoIxc: deps.contextoIxc,
  limparErroSeHavia: deps.limparErroSeHavia,
  respostaDaFalha: deps.respostaDaFalha,
}));
vi.mock("@/lib/conectores/ixc/identificar", () => ({
  clientesPorTelefone: deps.clientesPorTelefone,
  clientesPorDocumento: deps.clientesPorDocumento,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.requireSupportWrite }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

import { POST } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONTATO_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const CADASTRO_ID = "10";

/**
 * Admin de mentira com uma linha JÁ EXISTENTE `verificado_por='telefone'` para
 * este contato+cadastro: o INSERT bate no 23505 (simulado), e o UPDATE de
 * promoção — que é código de PRODUÇÃO de `vincular`, não mock — só "acha" a
 * linha porque o filtro `.in("verificado_por", [...])` inclui "telefone".
 */
function adminComVinculoPorTelefone() {
  const chamadas: { op: string; filtros?: Record<string, unknown>; payload?: unknown }[] = [];
  return {
    chamadas,
    from() {
      return {
        insert: async (payload: Record<string, unknown>) => {
          chamadas.push({ op: "insert", payload });
          return { error: { code: "23505", message: "duplicate key" } };
        },
        update: (payload: Record<string, unknown>) => {
          const filtros: Record<string, unknown> = {};
          const chain = {
            eq: (c: string, v: unknown) => {
              filtros[c] = v;
              return chain;
            },
            in: (c: string, v: unknown) => {
              filtros[c] = v;
              return chain;
            },
            select: async () => {
              chamadas.push({ op: "update", payload, filtros });
              // A linha real é 'telefone', que está em qualquer lista de
              // "mais fracas que" recebida — promove.
              const promoveu = Array.isArray(filtros.verificado_por) && filtros.verificado_por.includes("telefone");
              return { data: promoveu ? [{ contact_id: CONTATO_ID }] : [], error: null };
            },
          };
          return chain;
        },
      };
    },
  };
}

function req(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/v1/contacts/${CONTATO_ID}/conectores/ixc/vinculo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rota() {
  return { params: Promise.resolve({ id: CONTATO_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.requireSupportWrite.mockResolvedValue(null);
  deps.limparErroSeHavia.mockResolvedValue(undefined);
});

describe("POST vinculo — promoção da linha existente (o beco sem saída consertado)", () => {
  it("cadastro_id de um contato com vínculo por telefone → a linha vira manual, 201, audita promovido:true", async () => {
    const admin = adminComVinculoPorTelefone();
    deps.contextoIxc.mockResolvedValue({
      ok: true,
      admin,
      orgId: ORG_ID,
      contato: { id: CONTATO_ID, phone_number: "+5511987654321" },
      userId: USER_ID,
      credencial: { baseUrl: "https://erp.exemplo.com.br", token: "1:x" },
      t: (s: string) => s,
      idioma: "pt-BR",
    });
    // O servidor confere: o cadastro pedido tem de estar entre os candidatos
    // que o telefone deste contato devolve agora.
    deps.clientesPorTelefone.mockResolvedValue([{ id: CADASTRO_ID, nome: "Maria", documento: "***", ativo: true }]);

    const res = await POST(req({ cadastro_id: CADASTRO_ID }), rota());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { cadastros: string[] } };
    expect(body.data.cadastros).toEqual([CADASTRO_ID]);

    // A promoção de verdade aconteceu: insert (bateu 23505) + update (achou a
    // linha 'telefone' e trocou para 'manual').
    expect(admin.chamadas.map((c) => c.op)).toEqual(["insert", "update"]);
    expect(admin.chamadas[1]).toMatchObject({
      payload: expect.objectContaining({ verificado_por: "manual", created_by: USER_ID }),
      filtros: expect.objectContaining({ verificado_por: ["telefone", "documento"] }),
    });

    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conector.vinculo_criado",
        metadata: expect.objectContaining({ conector: "ixc", cadastro: CADASTRO_ID, verificado_por: "manual", promovido: true }),
      }),
    );
  });
});
