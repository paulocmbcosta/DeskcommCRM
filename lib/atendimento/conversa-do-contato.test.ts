import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  COLUNAS_DA_CONVERSA_DO_CONTATO,
  conversaEncerrada,
  conversaMaisRecentePorContato,
  portaDaConversa,
} from "./conversa-do-contato";

const linha = (mudancas: Record<string, unknown> = {}) => ({
  id: "conv-1",
  contact_id: "contato-1",
  status: "open",
  channel_session_id: "sessao-1",
  last_message_preview: "oi",
  last_message_at: "2026-10-01T12:00:00Z",
  unread_count_for_assignee: 0,
  ...mudancas,
});

describe("a porta que a conversa do contato oferece", () => {
  it("sem conversa: chamar", () => {
    expect(portaDaConversa(null)).toBe("chamar");
    expect(portaDaConversa(undefined)).toBe("chamar");
  });

  it("atendimento em andamento: abrir a conversa — é lá que se responde", () => {
    for (const status of ["open", "claimed", "pending", "ai_handling"]) {
      expect(portaDaConversa({ status }), status).toBe("abrir");
    }
  });

  it("atendimento ENCERRADO: chamar de novo — e não abrir o que acabou", () => {
    // O relato de 2026-10-05: a conversa existia, encerrada desde 25/09, e a tela
    // levava para ela em vez de oferecer o começo de um atendimento novo.
    for (const status of ["closed", "resolved", "archived"]) {
      expect(portaDaConversa({ status }), status).toBe("chamar_de_novo");
    }
  });

  it("estado desconhecido não vira 'encerrada' por omissão", () => {
    // Oferecer "chamar" para quem está em atendimento é o erro caro: a pessoa
    // escreveria por fora da conversa em andamento.
    expect(conversaEncerrada(undefined)).toBe(false);
    expect(conversaEncerrada(null)).toBe(false);
    expect(conversaEncerrada("um_estado_que_nao_existe")).toBe(false);
  });
});

describe("a conversa anexada ao contato carrega o ESTADO", () => {
  it("leva estado e conexão — sem eles a tela não sabe se o atendimento acabou", () => {
    const mapa = conversaMaisRecentePorContato([linha({ status: "closed", unread_count_for_assignee: null })]);
    expect(mapa.get("contato-1")).toEqual({
      id: "conv-1",
      preview: "oi",
      last_message_at: "2026-10-01T12:00:00Z",
      unread: 0,
      status: "closed",
      channel_session_id: "sessao-1",
    });
  });

  it("a primeira linha de cada contato vence — a consulta já vem da mais recente", () => {
    const mapa = conversaMaisRecentePorContato([
      linha({ id: "nova", status: "closed" }),
      linha({ id: "velha", status: "open" }),
      linha({ id: "de-outro", contact_id: "contato-2" }),
    ]);
    expect(mapa.get("contato-1")?.id).toBe("nova");
    expect(mapa.get("contato-2")?.id).toBe("de-outro");
  });

  it("as duas rotas pedem as MESMAS colunas e usam o mesmo anexador", () => {
    // Eram duas cópias da mesma função, uma em cada rota. Uma delas esquecer o
    // estado deixaria aquela tela com o defeito e todas as outras verdes.
    expect(COLUNAS_DA_CONVERSA_DO_CONTATO).toMatch(/\bstatus\b/);
    expect(COLUNAS_DA_CONVERSA_DO_CONTATO).toMatch(/\bchannel_session_id\b/);
    for (const rota of ["app/api/v1/contacts/_handler.ts", "app/api/v1/pipelines/[id]/board/route.ts"]) {
      const fonte = readFileSync(rota, "utf8");
      expect(fonte, `${rota} não pede as colunas compartilhadas`).toMatch(/COLUNAS_DA_CONVERSA_DO_CONTATO/);
      expect(fonte, `${rota} não usa o anexador compartilhado`).toMatch(/conversaMaisRecentePorContato\(/);
      expect(fonte, `${rota} voltou a montar a conversa à mão`).not.toMatch(/last_message_preview/);
    }
  });
});
