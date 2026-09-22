import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JanelaDoAtendimento } from "@/lib/atendimento/janela-do-atendimento";
import { ATENDIMENTO_VIGENTE } from "@/lib/schemas/messaging";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// Mockado para provar, sem tocar o Postgres, QUEM `dadosViaSupabase` chama
// quando ninguém injeta `deps`: se o padrão real fosse trocado por um stub
// silencioso (ou esquecido), nenhum destes testes notaria sem este mock.
vi.mock("@/lib/atendimento/janela-do-atendimento", () => ({ janelaDoAtendimento: vi.fn() }));

const { dadosViaSupabase } = await import("@/lib/classificador-comercial/dados");
const { logger } = await import("@/lib/logger");
const { janelaDoAtendimento } = await import("@/lib/atendimento/janela-do-atendimento");
const { MARCADOR_NAO_LIDA } = await import("@/workers/media-derive-worker");

/** Builder falso: registra filtros e devolve `resultado` no fim da cadeia. */
function dbQueDevolve(porTabela: Record<string, { data: unknown; error: { message: string } | null }>) {
  const filtros: Array<[string, string, unknown[]]> = [];
  return {
    filtros,
    db: {
      from(tabela: string) {
        const cadeia: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit", "gte", "lt"]) {
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

/** Janela sem piso nem teto — o comportamento de antes de o recorte por atendimento existir. */
const janelaSemPiso = async (): Promise<JanelaDoAtendimento> => ({ ok: true, desde: null, ate: null });

describe("dadosViaSupabase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("temCardAberto", () => {
    it("filtra organização, contato e status open", async () => {
      const { db, filtros } = dbQueDevolve({ crm_leads: { data: { id: "lead-1" }, error: null } });
      expect(await dadosViaSupabase(db).temCardAberto("org-1", "contato-1")).toBe(true);
      expect(filtros).toContainEqual(["crm_leads", "eq", ["organization_id", "org-1"]]);
      expect(filtros).toContainEqual(["crm_leads", "eq", ["contact_id", "contato-1"]]);
      expect(filtros).toContainEqual(["crm_leads", "eq", ["status", "open"]]);
    });

    it("sem linha é false; erro de banco LANÇA (o drain tenta de novo)", async () => {
      expect(await dadosViaSupabase(dbQueDevolve({ crm_leads: { data: null, error: null } }).db).temCardAberto("o", "c")).toBe(
        false,
      );
      await expect(
        dadosViaSupabase(dbQueDevolve({ crm_leads: { data: null, error: { message: "fora" } } }).db).temCardAberto("o", "c"),
      ).rejects.toThrow("fora");
    });
  });

  describe("contatoBloqueado", () => {
    it("usa a string de select exata (coluna a menos zera a leitura em silêncio)", async () => {
      const { db, filtros } = dbQueDevolve({ contacts: { data: { is_blocked: false }, error: null } });
      await dadosViaSupabase(db).contatoBloqueado("org-1", "contato-1");
      expect(filtros).toContainEqual(["contacts", "select", ["is_blocked"]]);
      expect(filtros).toContainEqual(["contacts", "eq", ["organization_id", "org-1"]]);
      expect(filtros).toContainEqual(["contacts", "eq", ["id", "contato-1"]]);
    });

    it("is_blocked true vira true", async () => {
      const { db } = dbQueDevolve({ contacts: { data: { is_blocked: true }, error: null } });
      expect(await dadosViaSupabase(db).contatoBloqueado("o", "c")).toBe(true);
    });

    it("linha ausente vira false", async () => {
      const { db } = dbQueDevolve({ contacts: { data: null, error: null } });
      expect(await dadosViaSupabase(db).contatoBloqueado("o", "c")).toBe(false);
    });

    it("erro de banco LANÇA", async () => {
      const { db } = dbQueDevolve({ contacts: { data: null, error: { message: "fora" } } });
      await expect(dadosViaSupabase(db).contatoBloqueado("o", "c")).rejects.toThrow("fora");
    });
  });

  describe("mensagem", () => {
    it("usa a string de select exata e filtra por organização", async () => {
      const { db, filtros } = dbQueDevolve({ messages: { data: { type: "text", media_derived_status: null }, error: null } });
      await dadosViaSupabase(db).mensagem("org-1", "msg-1");
      expect(filtros).toContainEqual(["messages", "select", ["type, media_derived_status"]]);
      expect(filtros).toContainEqual(["messages", "eq", ["organization_id", "org-1"]]);
      expect(filtros).toContainEqual(["messages", "eq", ["id", "msg-1"]]);
    });

    it("sem linha vira null", async () => {
      const { db } = dbQueDevolve({ messages: { data: null, error: null } });
      expect(await dadosViaSupabase(db).mensagem("o", "m")).toBeNull();
    });

    it("erro de banco LANÇA", async () => {
      const { db } = dbQueDevolve({ messages: { data: null, error: { message: "fora" } } });
      await expect(dadosViaSupabase(db).mensagem("o", "m")).rejects.toThrow("fora");
    });
  });

  describe("regra", () => {
    it("filtra organizations por id e lê settings.crm.nascimento_do_card", async () => {
      const { db, filtros } = dbQueDevolve({
        organizations: { data: { settings: { crm: { nascimento_do_card: { modo: "classificador", limiar: 0.8 } } } }, error: null },
      });
      expect(await dadosViaSupabase(db).regra("org-1")).toEqual({ modo: "classificador", limiar: 0.8 });
      expect(filtros).toContainEqual(["organizations", "select", ["settings"]]);
      expect(filtros).toContainEqual(["organizations", "eq", ["id", "org-1"]]);
    });

    it("erro de banco LANÇA — nunca cai pro padrão toda_conversa dentro do worker", async () => {
      const { db } = dbQueDevolve({ organizations: { data: null, error: { message: "fora" } } });
      await expect(dadosViaSupabase(db).regra("org-1")).rejects.toThrow("fora");
    });

    it("organização inexistente LANÇA", async () => {
      const { db } = dbQueDevolve({ organizations: { data: null, error: null } });
      await expect(dadosViaSupabase(db).regra("org-1")).rejects.toThrow(/inexistente/);
    });
  });

  describe("ultimasMensagens", () => {
    it("usa a string de select exata", async () => {
      const { db, filtros } = dbQueDevolve({ messages: { data: [], error: null } });
      await dadosViaSupabase(db, { janela: janelaSemPiso }).ultimasMensagens("org-1", "conversa-1", 24);
      expect(filtros).toContainEqual(["messages", "select", ["direction, type, status, body, media_derived_text, revoked_at"]]);
    });

    it("devolve em ordem cronológica, sem sistema/reação/apagada/saída-falha, e rotula a descrição de mídia (não é fala do cliente)", async () => {
      const linhas = [
        { direction: "inbound", type: "audio", status: "received", body: null, media_derived_text: "quero o plano de 1 giga", revoked_at: null },
        { direction: "outbound", type: "system", status: "sent", body: "atendimento aberto", media_derived_text: null, revoked_at: null },
        { direction: "inbound", type: "reaction", status: "received", body: "👍", media_derived_text: null, revoked_at: null },
        { direction: "inbound", type: "text", status: "received", body: "mensagem apagada", media_derived_text: null, revoked_at: "2026-09-22T10:00:00Z" },
        { direction: "outbound", type: "text", status: "sent", body: "Olá!", media_derived_text: null, revoked_at: null },
        { direction: "outbound", type: "text", status: "failed", body: "nunca chegou", media_derived_text: null, revoked_at: null },
        { direction: "inbound", type: "image", status: "received", body: "olha a fatura", media_derived_text: "foto de uma fatura", revoked_at: null },
      ]; // do MAIS NOVO para o mais velho, como a consulta devolve
      const { db, filtros } = dbQueDevolve({ messages: { data: linhas, error: null } });
      const r = await dadosViaSupabase(db, { janela: janelaSemPiso }).ultimasMensagens("org-1", "conversa-1", 24);
      expect(r).toEqual([
        { direcao: "inbound", texto: "olha a fatura [imagem: foto de uma fatura]" },
        { direcao: "outbound", texto: "Olá!" },
        { direcao: "inbound", texto: "quero o plano de 1 giga" },
      ]);
      expect(filtros).toContainEqual(["messages", "eq", ["organization_id", "org-1"]]);
      expect(filtros).toContainEqual(["messages", "eq", ["conversation_id", "conversa-1"]]);
      expect(filtros).toContainEqual(["messages", "order", ["sent_at", { ascending: false }]]);
    });

    it("áudio: a transcrição é FALA DIRETA do cliente, junto do body se houver — sem colchetes", async () => {
      const linhas = [
        { direction: "inbound", type: "audio", status: "received", body: "urgente", media_derived_text: "preciso saber o valor", revoked_at: null },
      ];
      const { db } = dbQueDevolve({ messages: { data: linhas, error: null } });
      const r = await dadosViaSupabase(db, { janela: janelaSemPiso }).ultimasMensagens("org-1", "conversa-1", 24);
      expect(r).toEqual([{ direcao: "inbound", texto: "urgente — preciso saber o valor" }]);
    });

    it("o marcador de mídia NÃO LIDA não é fala: sozinho vira texto null; com legenda, sobra só a legenda", async () => {
      // Do mais novo para o mais velho, como o banco devolve (`order desc`).
      const linhas = [
        { direction: "inbound", type: "image", status: "received", body: "olha isso", media_derived_text: MARCADOR_NAO_LIDA, revoked_at: null },
        { direction: "inbound", type: "audio", status: "received", body: null, media_derived_text: `  ${MARCADOR_NAO_LIDA} `, revoked_at: null },
      ];
      const { db } = dbQueDevolve({ messages: { data: linhas, error: null } });
      const r = await dadosViaSupabase(db, { janela: janelaSemPiso }).ultimasMensagens("org-1", "conversa-1", 24);
      // Sem isto, o Jev lia "[o cliente enviou uma mídia que não consegui
      // interpretar]" como se fosse o cliente falando — e respondia "não comercial".
      expect(r).toEqual([
        { direcao: "inbound", texto: null },
        { direcao: "inbound", texto: "olha isso" },
      ]);
    });

    it("descarta linha com direction fora do CHECK (inbound/outbound), sem mentir o tipo, e avisa no log sem conteúdo da mensagem", async () => {
      const linhas = [
        // Em tese o CHECK do banco só permite inbound/outbound; mesmo assim a
        // leitura não confia cegamente — uma linha com direção desconhecida é
        // descartada, não forçada a caber no tipo.
        { direction: "desconhecida", type: "text", status: "received", body: "linha estranha", media_derived_text: null, revoked_at: null },
        { direction: "inbound", type: "text", status: "received", body: "oi", media_derived_text: null, revoked_at: null },
      ];
      const { db } = dbQueDevolve({ messages: { data: linhas, error: null } });
      const r = await dadosViaSupabase(db, { janela: janelaSemPiso }).ultimasMensagens("org-1", "conversa-1", 24);
      expect(r).toEqual([{ direcao: "inbound", texto: "oi" }]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [mensagemDoLog, contexto] = vi.mocked(logger.warn).mock.calls[0]!;
      expect(mensagemDoLog).not.toContain("linha estranha");
      expect(contexto).toEqual({ organization_id: "org-1", quantidade: 1 });
    });

    it("recorta pelo atendimento vigente: com `desde`, aplica gte(sent_at, desde)", async () => {
      const { db, filtros } = dbQueDevolve({ messages: { data: [], error: null } });
      const janela = async (): Promise<JanelaDoAtendimento> => ({ ok: true, desde: "2026-09-20T12:00:00Z", ate: null });
      await dadosViaSupabase(db, { janela }).ultimasMensagens("org-1", "conversa-1", 24);
      expect(filtros).toContainEqual(["messages", "gte", ["sent_at", "2026-09-20T12:00:00Z"]]);
      expect(filtros.some(([, metodo]) => metodo === "lt")).toBe(false);
    });

    it("chama a janela com (db, organização, conversa, ATENDIMENTO_VIGENTE) — nunca outro episódio", async () => {
      const { db } = dbQueDevolve({ messages: { data: [], error: null } });
      const janela = vi.fn(async (): Promise<JanelaDoAtendimento> => ({ ok: true, desde: null, ate: null }));
      await dadosViaSupabase(db, { janela }).ultimasMensagens("org-1", "conversa-1", 24);
      expect(janela).toHaveBeenCalledWith(db, "org-1", "conversa-1", ATENDIMENTO_VIGENTE);
    });

    it("sem `deps`, o padrão é a `janelaDoAtendimento` REAL — não um stub silencioso", async () => {
      const { db } = dbQueDevolve({ messages: { data: [], error: null } });
      vi.mocked(janelaDoAtendimento).mockResolvedValueOnce({ ok: true, desde: null, ate: null });
      // Nenhum `deps` passado: se o parâmetro padrão de `dadosViaSupabase`
      // fosse trocado por outra coisa (ou removido), este mock do módulo
      // real nunca seria chamado, e a asserção abaixo pegaria.
      await dadosViaSupabase(db).ultimasMensagens("org-1", "conversa-1", 24);
      expect(janelaDoAtendimento).toHaveBeenCalledWith(db, "org-1", "conversa-1", ATENDIMENTO_VIGENTE);
    });

    it("recorta pelo atendimento vigente: com `desde` E `ate`, aplica os dois limites", async () => {
      const { db, filtros } = dbQueDevolve({ messages: { data: [], error: null } });
      const janela = async (): Promise<JanelaDoAtendimento> => ({
        ok: true,
        desde: "2026-09-20T12:00:00Z",
        ate: "2026-09-21T09:00:00Z",
      });
      await dadosViaSupabase(db, { janela }).ultimasMensagens("org-1", "conversa-1", 24);
      expect(filtros).toContainEqual(["messages", "gte", ["sent_at", "2026-09-20T12:00:00Z"]]);
      expect(filtros).toContainEqual(["messages", "lt", ["sent_at", "2026-09-21T09:00:00Z"]]);
    });

    it("sem atendimento encontrado: sem piso — a conversa inteira, como a régua documenta", async () => {
      const { db, filtros } = dbQueDevolve({ messages: { data: [], error: null } });
      const janela = async (): Promise<JanelaDoAtendimento> => ({ ok: false, motivo: "atendimento_nao_encontrado" });
      await dadosViaSupabase(db, { janela }).ultimasMensagens("org-1", "conversa-1", 24);
      expect(filtros.some(([, metodo]) => metodo === "gte" || metodo === "lt")).toBe(false);
    });

    it("erro ao ler o episódio LANÇA (o drain tenta de novo)", async () => {
      const { db } = dbQueDevolve({ messages: { data: [], error: null } });
      const janela = async (): Promise<JanelaDoAtendimento> => ({ ok: false, motivo: "erro_de_leitura", detalhe: "fora" });
      await expect(dadosViaSupabase(db, { janela }).ultimasMensagens("org-1", "conversa-1", 24)).rejects.toThrow("fora");
    });
  });
});
