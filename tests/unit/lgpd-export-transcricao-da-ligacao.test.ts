// @vitest-environment node
/**
 * A SITUAÇÃO DA TRANSCRIÇÃO NO RELATÓRIO DE DADOS DO TITULAR (F4, 0298).
 *
 * O coletor diz, para cada ligação, se ela tem transcrição — só a situação. Três
 * respostas diferentes, que não podem se confundir:
 *
 *  - `{ status }` — há uma linha de transcrição;
 *  - `null`       — a consulta respondeu, e esta ligação não tem transcrição;
 *  - campo AUSENTE — a consulta FALHOU: o coletor não sabe.
 *
 * A terceira virava a segunda (achado da revisão dos consertos): com a leitura
 * falhando, toda ligação saía com `transcricao: null`, e um relatório entregue
 * ao titular afirmaria "não há transcrição" de uma ligação que tem.
 *
 * O Supabase daqui é de mentira e responde vazio a tudo, menos às duas tabelas
 * em jogo — o resto do coletor tem os seus testes (tests/invariants/).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "0be7a70c-0000-4000-8000-000000000001";
const CONTATO = "0be7a70c-0000-4000-8000-0000000000c1";
const LIGACAO_COM = "0be7a70c-0000-4000-8000-0000000000aa";
const LIGACAO_SEM = "0be7a70c-0000-4000-8000-0000000000ab";

const banco = vi.hoisted(() => ({
  transcricoes: { data: [] as unknown, error: null as null | { message: string } },
  selects: [] as Array<[string, string]>,
  filtros: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const resposta = () => {
        if (tabela === "voice_calls") {
          return {
            data: [LIGACAO_COM, LIGACAO_SEM].map((id) => ({
              id,
              direction: "inbound",
              peer_phone: "+5561999990000",
              status: "ended",
              end_reason: null,
              started_at: "2026-10-09T12:00:00Z",
              answered_at: "2026-10-09T12:00:05Z",
              ended_at: "2026-10-09T12:03:00Z",
              duration_ms: 175_000,
              recording_status: "stored",
            })),
            error: null,
          };
        }
        if (tabela === "voice_call_transcripts") return banco.transcricoes;
        return { data: [], error: null, count: 0 };
      };
      // Qualquer método de consulta devolve a própria consulta; aguardá-la entrega a resposta.
      const q: Record<string, unknown> = new Proxy(
        {},
        {
          get: (_alvo, metodo) => {
            if (metodo === "then") {
              return (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(resposta()).then(ok, falha);
            }
            if (metodo === "maybeSingle" || metodo === "single") return async () => ({ data: null, error: null });
            return (...args: unknown[]) => {
              if (metodo === "select") banco.selects.push([tabela, String(args[0])]);
              if (metodo === "eq" || metodo === "in") banco.filtros.push([`${tabela}.${String(args[0])}`, args[1]]);
              return q;
            };
          },
        },
      );
      return q;
    },
  }),
}));

import { collectExportData } from "@/lib/lgpd/export-collector";

const pedido = { organizationId: ORG, requestId: "0be7a70c-0000-4000-8000-0000000000f1", contactId: CONTATO, externalCustomerId: null };

beforeEach(() => {
  banco.transcricoes = { data: [{ voice_call_id: LIGACAO_COM, status: "ready" }], error: null };
  banco.selects = [];
  banco.filtros = [];
});

describe("LGPD: a situação da transcrição das ligações no relatório", () => {
  it("a ligação transcrita leva a situação; a que não tem leva `null` — e a consulta é presa à organização e às ligações do titular", async () => {
    const dados = await collectExportData(pedido);
    const porId = new Map(dados.voice_calls.map((v) => [v.id, v]));
    expect(porId.get(LIGACAO_COM)?.transcricao).toEqual({ status: "ready" });
    expect(porId.get(LIGACAO_SEM)?.transcricao).toBeNull();
    expect(banco.filtros).toEqual(
      expect.arrayContaining([
        ["voice_call_transcripts.organization_id", ORG],
        ["voice_call_transcripts.voice_call_id", [LIGACAO_COM, LIGACAO_SEM]],
      ]),
    );
    // Só a situação: o texto e o resumo nunca são pedidos ao banco.
    expect(banco.selects.filter(([t]) => t === "voice_call_transcripts").map(([, colunas]) => colunas)).toEqual(["voice_call_id, status"]);
  });

  it("a leitura FALHA: o campo fica AUSENTE em todas — o relatório não afirma 'não tem' do que não conseguiu ler", async () => {
    banco.transcricoes = { data: null, error: { message: "timeout" } };
    const dados = await collectExportData(pedido);
    expect(dados.voice_calls).toHaveLength(2);
    for (const v of dados.voice_calls) {
      expect("transcricao" in v, `a ligação ${v.id} afirma algo sobre a transcrição`).toBe(false);
    }
  });
});
