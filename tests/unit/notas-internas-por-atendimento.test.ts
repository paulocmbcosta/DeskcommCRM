/**
 * A NOTA INTERNA PERTENCE AO ATENDIMENTO EM QUE FOI ESCRITA.
 *
 * ─── O defeito, relatado pelo dono do produto em 2026-09-19 ─────────────────
 *
 * "As mensagens de nota interna ainda estão aparecendo no atendimento aberto e
 * no encerrado." A tela mostra UM atendimento por vez (migration 0266): as
 * mensagens eram recortadas pela janela do episódio, e as notas internas — que
 * entram no MESMO thread, intercaladas por horário — vinham da conversa inteira:
 *
 *     const q     = useMessagesRealtime(conversationId, atendimentoId);
 *     const notes = useConversationNotes(conversationId);        // ← sem o episódio
 *
 * A nota "cliente pediu boleto, enviei 2ª via" do Financeiro aparecia dentro do
 * atendimento novo do Suporte; e a nota de hoje aparecia ao abrir o atendimento
 * encerrado na semana passada.
 *
 * ─── Por que uma régua só ───────────────────────────────────────────────────
 *
 * A regra da janela morava dentro do handler de mensagens. Copiá-la para a rota
 * de notas criaria duas réguas — e a segunda sempre diverge (um dia alguém muda
 * "fechamento não é fronteira" num lugar só). Ela virou
 * `lib/atendimento/janela-do-atendimento.ts`, e este arquivo guarda as duas
 * coisas: a regra, e que ninguém a reescreva por fora.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { janelaDoAtendimento } from "@/lib/atendimento/janela-do-atendimento";

interface Chamada {
  metodo: string;
  args: unknown[];
}

function fakeDb(episodios: Array<{ id: string; started_at: string }>, erro: string | null = null) {
  const chamadas: Chamada[] = [];
  const tabelas: string[] = [];
  const client = {
    from: (tabela: string) => {
      tabelas.push(tabela);
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) =>
                ok(erro ? { data: null, error: { message: erro } } : { data: episodios, error: null });
            }
            return (...args: unknown[]) => {
              chamadas.push({ metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client: client as never, chamadas, tabelas };
}

// Três atendimentos na mesma conversa: financeiro (seg), suporte (qua), de novo (sex).
const SEG = { id: "11111111-1111-4111-8111-111111111111", started_at: "2026-09-14T10:00:00Z" };
const QUA = { id: "22222222-2222-4222-8222-222222222222", started_at: "2026-09-16T10:00:00Z" };
const SEX = { id: "33333333-3333-4333-8333-333333333333", started_at: "2026-09-18T10:00:00Z" };

describe("a janela de um atendimento — [início deste, início do próximo)", () => {
  it("o VIGENTE é o último episódio: tem piso e não tem teto", async () => {
    const { client } = fakeDb([SEG, QUA, SEX]);
    expect(await janelaDoAtendimento(client, "org-1", "conv-1", "vigente")).toEqual({
      ok: true,
      desde: SEX.started_at,
      ate: null,
    });
  });

  it("⭐ um episódio do MEIO tem os dois lados — é o que separa a nota do Financeiro da do Suporte", async () => {
    const { client } = fakeDb([SEG, QUA, SEX]);
    expect(await janelaDoAtendimento(client, "org-1", "conv-1", QUA.id)).toEqual({
      ok: true,
      desde: QUA.started_at,
      ate: SEX.started_at,
    });
  });

  it("o PRIMEIRO não tem piso: a mensagem que abre a conversa é anterior à linha dela", async () => {
    const { client } = fakeDb([SEG, QUA, SEX]);
    expect(await janelaDoAtendimento(client, "org-1", "conv-1", SEG.id)).toEqual({
      ok: true,
      desde: null,
      ate: QUA.started_at,
    });
  });

  it("um atendimento só: vigente e primeiro ao mesmo tempo — nada a recortar", async () => {
    const { client } = fakeDb([SEG]);
    expect(await janelaDoAtendimento(client, "org-1", "conv-1", "vigente")).toEqual({
      ok: true,
      desde: null,
      ate: null,
    });
  });

  it("sem episódio nenhum (grupo, conversa anterior ao backfill): a conversa inteira é a resposta honesta", async () => {
    const { client } = fakeDb([]);
    expect(await janelaDoAtendimento(client, "org-1", "conv-1", "vigente")).toEqual({
      ok: true,
      desde: null,
      ate: null,
    });
  });

  it("id que não é desta conversa é RECUSADO — nunca vira 'sem recorte'", async () => {
    // Cair em `desde: null, ate: null` aqui mostraria a conversa inteira para
    // quem pediu um atendimento que não existe nela.
    const { client } = fakeDb([SEG, QUA]);
    expect(await janelaDoAtendimento(client, "org-1", "conv-1", SEX.id)).toEqual({
      ok: false,
      motivo: "atendimento_nao_encontrado",
    });
  });

  it("falha de leitura é dita, não engolida", async () => {
    const { client } = fakeDb([], "boom");
    expect(await janelaDoAtendimento(client, "org-1", "conv-1", "vigente")).toEqual({
      ok: false,
      motivo: "erro_de_leitura",
      detalhe: "boom",
    });
  });

  it("filtra pela organização E pela conversa, e ordena do mais antigo para o mais novo", async () => {
    const { client, chamadas, tabelas } = fakeDb([SEG]);
    await janelaDoAtendimento(client, "org-1", "conv-1", "vigente");
    expect(tabelas).toEqual(["atendimentos"]);
    const eqs = chamadas.filter((c) => c.metodo === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["organization_id", "org-1"]);
    expect(eqs).toContainEqual(["conversation_id", "conv-1"]);
    const ordens = chamadas.filter((c) => c.metodo === "order");
    expect(ordens[0]?.args).toEqual(["started_at", { ascending: true }]);
  });
});

/**
 * ⭐ A GUARDA QUE SEGURA O DEFEITO DO LADO DE FORA.
 *
 * A janela certa num arquivo não adianta se uma das pontas não a usa — e foi
 * exatamente assim que o defeito existiu: a regra estava correta, e as notas
 * nunca a consultaram. Estes casos leem a FONTE das quatro pontas.
 */
describe("mensagens e notas usam a MESMA janela, de ponta a ponta", () => {
  const ler = (p: string) => readFileSync(p, "utf8");
  const mensagens = ler("app/api/v1/messages/_handler.ts");
  const notas = ler("app/api/v1/conversations/[id]/notes/route.ts");
  const hookDeNotas = ler("hooks/inbox/useConversationNotes.ts");
  const thread = ler("components/inbox/ChatThread.tsx");

  it("as duas rotas chamam `janelaDoAtendimento` — nenhuma reescreve a regra lendo `atendimentos` por conta própria", () => {
    for (const [nome, fonte] of [
      ["mensagens", mensagens],
      ["notas", notas],
    ] as const) {
      expect(fonte, `${nome} não usa a régua única`).toContain("janelaDoAtendimento(");
      expect(fonte, `${nome} lê atendimentos por fora da régua`).not.toContain('.from("atendimentos")');
    }
  });

  it("a rota de notas recorta por `created_at`, nos dois lados da janela", () => {
    expect(notas).toContain('gte("created_at", janela.desde)');
    expect(notas).toContain('lt("created_at", janela.ate)');
  });

  it("o hook de notas PEDE o recorte — e sem id pede o vigente, como o de mensagens", () => {
    expect(hookDeNotas).toContain("atendimento_id=${atendimentoId ?? ATENDIMENTO_VIGENTE}");
    // A chave guarda o episódio: sem isso, abrir um atendimento antigo serviria
    // do cache as notas do atual.
    expect(hookDeNotas).toContain('["notes", conversationId, atendimentoId ?? ATENDIMENTO_VIGENTE]');
  });

  it("⭐ o thread entrega o MESMO episódio às duas listas", () => {
    // O defeito, literal: `useConversationNotes(conversationId)` — sem o episódio.
    expect(thread).toContain("useMessagesRealtime(conversationId, atendimentoId)");
    expect(thread).toContain("useConversationNotes(conversationId, atendimentoId)");
    expect(thread).not.toMatch(/useConversationNotes\(conversationId\)/);
  });

  it("criar e apagar nota invalidam pelo PREFIXO que a chave nova preserva", () => {
    expect(ler("hooks/inbox/useCreateNote.ts")).toContain('queryKey: ["notes", args.conversation_id]');
    expect(ler("hooks/inbox/useDeleteNote.ts")).toContain('queryKey: ["notes", conversationId]');
  });
});
