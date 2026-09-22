import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { dadosViaSupabase } = await import("@/lib/classificador-comercial/dados");

/** Builder falso: registra filtros e devolve `resultado` no fim da cadeia. */
function dbQueDevolve(porTabela: Record<string, { data: unknown; error: { message: string } | null }>) {
  const filtros: Array<[string, string, unknown[]]> = [];
  return {
    filtros,
    db: {
      from(tabela: string) {
        const cadeia: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit"]) {
          cadeia[m] = (...args: unknown[]) => {
            filtros.push([tabela, m, args]);
            return cadeia;
          };
        }
        cadeia.maybeSingle = async () => porTabela[tabela];
        cadeia.then = (resolve: (v: unknown) => void) => Promise.resolve(porTabela[tabela]).then(resolve);
        return cadeia;
      },
    } as never,
  };
}

describe("dadosViaSupabase", () => {
  it("temCardAberto filtra organização, contato e status open", async () => {
    const { db, filtros } = dbQueDevolve({ crm_leads: { data: { id: "lead-1" }, error: null } });
    expect(await dadosViaSupabase(db).temCardAberto("org-1", "contato-1")).toBe(true);
    expect(filtros).toContainEqual(["crm_leads", "eq", ["organization_id", "org-1"]]);
    expect(filtros).toContainEqual(["crm_leads", "eq", ["contact_id", "contato-1"]]);
    expect(filtros).toContainEqual(["crm_leads", "eq", ["status", "open"]]);
  });

  it("temCardAberto sem linha é false; erro de banco LANÇA (o drain tenta de novo)", async () => {
    expect(await dadosViaSupabase(dbQueDevolve({ crm_leads: { data: null, error: null } }).db).temCardAberto("o", "c")).toBe(false);
    await expect(
      dadosViaSupabase(dbQueDevolve({ crm_leads: { data: null, error: { message: "fora" } } }).db).temCardAberto("o", "c"),
    ).rejects.toThrow("fora");
  });

  it("ultimasMensagens devolve em ordem cronológica, sem sistema, reação ou apagada, e usa a transcrição", async () => {
    const linhas = [
      { direction: "inbound", type: "audio", body: null, media_derived_text: "quero o plano de 1 giga", revoked_at: null },
      { direction: "outbound", type: "system", body: "atendimento aberto", media_derived_text: null, revoked_at: null },
      { direction: "inbound", type: "reaction", body: "👍", media_derived_text: null, revoked_at: null },
      { direction: "inbound", type: "text", body: "mensagem apagada", media_derived_text: null, revoked_at: "2026-09-22T10:00:00Z" },
      { direction: "outbound", type: "text", body: "Olá!", media_derived_text: null, revoked_at: null },
      { direction: "inbound", type: "image", body: "olha a fatura", media_derived_text: "foto de uma fatura", revoked_at: null },
    ]; // do MAIS NOVO para o mais velho, como a consulta devolve
    const { db, filtros } = dbQueDevolve({ messages: { data: linhas, error: null } });
    const r = await dadosViaSupabase(db).ultimasMensagens("org-1", "conversa-1", 24);
    expect(r).toEqual([
      { direcao: "inbound", texto: "olha a fatura — foto de uma fatura" },
      { direcao: "outbound", texto: "Olá!" },
      { direcao: "inbound", texto: "quero o plano de 1 giga" },
    ]);
    expect(filtros).toContainEqual(["messages", "eq", ["organization_id", "org-1"]]);
    expect(filtros).toContainEqual(["messages", "eq", ["conversation_id", "conversa-1"]]);
    expect(filtros).toContainEqual(["messages", "order", ["sent_at", { ascending: false }]]);
  });

  it("ultimasMensagens descarta linha com direction fora do CHECK (inbound/outbound), sem mentir o tipo", async () => {
    const linhas = [
      // Em tese o CHECK do banco só permite inbound/outbound; mesmo assim a
      // leitura não confia cegamente — uma linha com direção desconhecida é
      // descartada, não forçada a caber no tipo.
      { direction: "desconhecida", type: "text", body: "linha estranha", media_derived_text: null, revoked_at: null },
      { direction: "inbound", type: "text", body: "oi", media_derived_text: null, revoked_at: null },
    ];
    const { db } = dbQueDevolve({ messages: { data: linhas, error: null } });
    const r = await dadosViaSupabase(db).ultimasMensagens("org-1", "conversa-1", 24);
    expect(r).toEqual([{ direcao: "inbound", texto: "oi" }]);
  });
});
