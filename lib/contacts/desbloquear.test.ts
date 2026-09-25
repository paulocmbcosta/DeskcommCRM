/**
 * A porta de volta do opt-out.
 *
 * O que estes casos protegem:
 *
 * 1. **A org filtra as DUAS queries.** É admin client — sem o `.eq` de
 *    organization_id, um gerente de uma org desbloquearia contato de outra.
 * 2. **O UPDATE é condicional** a `is_blocked = true` e `is_anonymized = false`.
 *    Perder a corrida é 409, nunca uma segunda linha de auditoria.
 * 3. **O audit leva quem, por quê e o QUÊ foi desfeito** — é o que responde ao
 *    titular que pergunta por que voltou a receber mensagem.
 * 4. **Anonimizado não desbloqueia** (LGPD é irreversível).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

import { desbloquearContato, desbloquearContatoSchema } from "./desbloquear";

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const CTX = { organizationId: ORG, actorUserId: EU, requestId: "req-1" };

type Linha = {
  id: string;
  is_blocked: boolean;
  is_anonymized: boolean;
  blocked_reason: string | null;
  blocked_at: string | null;
} | null;

/**
 * Admin falso que REGISTRA cada filtro. Leitura devolve `linha`; a escrita
 * devolve a linha só se os filtros condicionais baterem com `estadoNaEscrita`
 * — é assim que se simula outro gerente desbloqueando no meio.
 */
function adminFalso(linha: Linha, estadoNaEscrita?: Linha) {
  const chamadas: { op: string; filtros: Array<[string, unknown]>; payload?: unknown }[] = [];
  const client = {
    from: (tabela: string) => {
      expect(tabela).toBe("contacts");
      const registro: { op: string; filtros: Array<[string, unknown]>; payload?: unknown } = {
        op: "select",
        filtros: [],
      };
      chamadas.push(registro);
      const builder = {
        select: () => builder,
        update: (payload: unknown) => {
          registro.op = "update";
          registro.payload = payload;
          return builder;
        },
        eq: (col: string, val: unknown) => {
          registro.filtros.push([col, val]);
          return builder;
        },
        maybeSingle: async () => {
          if (registro.op === "select") return { data: linha, error: null };
          const alvo = estadoNaEscrita === undefined ? linha : estadoNaEscrita;
          const bate =
            alvo !== null &&
            registro.filtros.every(([c, v]) => (alvo as Record<string, unknown>)[c] === v || c === "organization_id");
          return { data: bate ? { id: alvo!.id } : null, error: null };
        },
      };
      return builder;
    },
  };
  return { client: client as never, chamadas };
}

const BLOQUEADO: Linha = {
  id: CONTATO,
  is_blocked: true,
  is_anonymized: false,
  blocked_reason: "stop_keyword",
  blocked_at: "2026-09-25T12:00:00.000Z",
};

beforeEach(() => vi.clearAllMocks());

describe("desbloquearContatoSchema", () => {
  it("exige motivo de pelo menos 10 caracteres, sem contar espaço", () => {
    expect(desbloquearContatoSchema.safeParse({ motivo: "   curto    " }).success).toBe(false);
    expect(desbloquearContatoSchema.safeParse({}).success).toBe(false);
    expect(desbloquearContatoSchema.safeParse({ motivo: "x".repeat(501) }).success).toBe(false);
    const ok = desbloquearContatoSchema.safeParse({ motivo: "  falso positivo do opt-out  " });
    expect(ok.success && ok.data.motivo).toBe("falso positivo do opt-out");
  });
});

describe("desbloquearContato", () => {
  it("zera as três colunas, filtra a org nas duas queries e audita quem, por quê e o quê", async () => {
    const { client, chamadas } = adminFalso(BLOQUEADO);

    const r = await desbloquearContato(client, CTX, CONTATO, { motivo: "cliente queria cancelar o plano" });

    expect(r).toEqual({
      contact_id: CONTATO,
      is_blocked: false,
      bloqueio_anterior: { reason: "stop_keyword", blocked_at: "2026-09-25T12:00:00.000Z" },
    });
    expect(chamadas).toHaveLength(2);
    for (const c of chamadas) expect(c.filtros).toContainEqual(["organization_id", ORG]);

    const escrita = chamadas[1]!;
    expect(escrita.payload).toEqual({ is_blocked: false, blocked_reason: null, blocked_at: null });
    expect(escrita.filtros).toContainEqual(["is_blocked", true]);
    expect(escrita.filtros).toContainEqual(["is_anonymized", false]);

    expect(deps.audit).toHaveBeenCalledTimes(1);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.unblocked",
        actorUserId: EU,
        organizationId: ORG,
        resourceType: "contact",
        resourceId: CONTATO,
        metadata: expect.objectContaining({
          motivo: "cliente queria cancelar o plano",
          blocked_reason_anterior: "stop_keyword",
          blocked_at_anterior: "2026-09-25T12:00:00.000Z",
        }),
      }),
    );
  });

  it("contato inexistente (ou de outra org) é 404 e não escreve nada", async () => {
    const { client, chamadas } = adminFalso(null);
    await expect(desbloquearContato(client, CTX, CONTATO, { motivo: "qualquer motivo aqui" })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(chamadas.filter((c) => c.op === "update")).toHaveLength(0);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("anonimizado é 403 lgpd_anonymization_irreversible", async () => {
    const { client } = adminFalso({ ...BLOQUEADO!, is_anonymized: true });
    await expect(desbloquearContato(client, CTX, CONTATO, { motivo: "qualquer motivo aqui" })).rejects.toMatchObject({
      status: 403,
      code: "lgpd_anonymization_irreversible",
    });
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("quem não está bloqueado é 409 — desbloquear duas vezes não vira duas linhas de auditoria", async () => {
    const { client } = adminFalso({ ...BLOQUEADO!, is_blocked: false, blocked_reason: null, blocked_at: null });
    await expect(desbloquearContato(client, CTX, CONTATO, { motivo: "qualquer motivo aqui" })).rejects.toMatchObject({
      status: 409,
      code: "state_conflict",
    });
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("perder a corrida (outro gerente desbloqueou entre ler e escrever) é 409, sem auditoria", async () => {
    const { client } = adminFalso(BLOQUEADO, { ...BLOQUEADO!, is_blocked: false });
    await expect(desbloquearContato(client, CTX, CONTATO, { motivo: "qualquer motivo aqui" })).rejects.toMatchObject({
      status: 409,
      code: "state_conflict",
    });
    expect(deps.audit).not.toHaveBeenCalled();
  });
});
