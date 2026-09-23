import { beforeEach, describe, expect, it, vi } from "vitest";

import { FAIXA_DO_LIMITE } from "@/lib/conectores/limite-de-cobranca";

const requireRole = vi.fn();
vi.mock("@/lib/auth/require-role", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));

const requireSupportWrite = vi.fn();
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: (...a: unknown[]) => requireSupportWrite(...a) }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

// Sem isto, importar a rota arrasta `obterConector` de verdade → `./ixc` → todo
// o conector IXC por transitividade. A rota só usa `conector.id` aqui.
vi.mock("@/lib/conectores/registro", () => ({
  obterConector: (id: string) => (id === "ixc" ? { id: "ixc" } : null),
}));

const salvarLimite = vi.fn();
const lerPublica = vi.fn();
// `FAIXA_DO_LIMITE` vem do módulo REAL (`limite-de-cobranca.ts` não importa
// nada — seguro de rodar aqui). Escrevê-la à mão de novo aqui seria o mesmo
// erro que este arquivo existe para vigiar: apertar a constante de verdade
// para `max: 1825` deixaria a ROTA recusando 3000 e este teste continuaria
// verde, porque estaria testando contra um número que ninguém mais usa.
vi.mock("@/lib/conectores/conexao", async () => ({
  ...(await import("@/lib/conectores/limite-de-cobranca")),
  salvarLimiteDeCobranca: (...a: unknown[]) => salvarLimite(...a),
  lerConexaoPublica: (...a: unknown[]) => lerPublica(...a),
  lerCredencial: vi.fn(),
  removerConexao: vi.fn(),
  salvarConexao: vi.fn(),
}));

const audit = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));

import { PATCH } from "@/app/api/v1/conectores/[conector]/conexao/route";

const pedido = (corpo: unknown) =>
  new Request("http://x/api/v1/conectores/ixc/conexao", { method: "PATCH", body: JSON.stringify(corpo) }) as never;
const params = { params: Promise.resolve({ conector: "ixc" }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireSupportWrite.mockResolvedValue(null);
  requireRole.mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org-1", role: "admin" } });
  lerPublica.mockResolvedValue({ conector: "ixc", cobranca_encaminha_apos_dias: 45 });
  // `salvarLimiteDeCobranca` devolve a LINHA atualizada (ou null, se não havia
  // conexão) — não mais um booleano.
  salvarLimite.mockResolvedValue({ conector: "ixc", cobranca_encaminha_apos_dias: 45 });
});

describe("PATCH /api/v1/conectores/[conector]/conexao — o limite de dias", () => {
  it("acompanhamento sem permissão de escrita barra ANTES de checar o papel — requireRole nem é chamado", async () => {
    const bloqueada = new Response(null, { status: 403 });
    requireSupportWrite.mockResolvedValueOnce(bloqueada);
    const r = await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params);
    expect(r).toBe(bloqueada);
    expect(requireRole).not.toHaveBeenCalled();
    expect(salvarLimite).not.toHaveBeenCalled();
  });

  it("é de admin", async () => {
    await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
  });

  it("requireRole nega: nada é gravado", async () => {
    const negada = new Response(null, { status: 403 });
    requireRole.mockResolvedValueOnce({ ok: false, response: negada });
    const r = await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params);
    expect(r).toBe(negada);
    expect(salvarLimite).not.toHaveBeenCalled();
  });

  it("grava, audita de quanto para quanto, e não pede o token", async () => {
    lerPublica.mockResolvedValueOnce({ conector: "ixc", cobranca_encaminha_apos_dias: 60 });
    // O valor devolvido pelo BANCO (99) é DIFERENTE do pedido (45) de propósito:
    // prova que `para` vem de `atualizada` (o que o banco realmente gravou),
    // não de `parsed.data` (o que foi pedido) — os dois quase sempre coincidem
    // na prática, e é exatamente por isso que um teste com os dois iguais não
    // provaria nada.
    salvarLimite.mockResolvedValueOnce({ conector: "ixc", cobranca_encaminha_apos_dias: 99 });
    const r = await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params);
    expect(r.status).toBe(200);
    expect(salvarLimite).toHaveBeenCalledWith(expect.anything(), "org-1", "ixc", 45);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "conector.preferencias_alteradas", metadata: expect.objectContaining({ de: 60, para: 99 }) }),
    );
    // A rota lê "antes" uma vez e usa a linha que `salvarLimiteDeCobranca`
    // devolve — não relê depois. Duas idas ao banco, não três.
    expect(lerPublica).toHaveBeenCalledTimes(1);
  });

  it("recusa fora da faixa, fração e campo desconhecido", async () => {
    for (const corpo of [
      { cobranca_encaminha_apos_dias: FAIXA_DO_LIMITE.min - 1 },
      { cobranca_encaminha_apos_dias: FAIXA_DO_LIMITE.max + 1 },
      { cobranca_encaminha_apos_dias: 1.5 },
      { cobranca_encaminha_apos_dias: 30, organization_id: "x" },
    ]) {
      expect((await PATCH(pedido(corpo), params)).status).toBe(422);
    }
    expect(salvarLimite).not.toHaveBeenCalled();
  });

  it("conector desligado: 404", async () => {
    salvarLimite.mockResolvedValue(null);
    expect((await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params)).status).toBe(404);
  });
});
