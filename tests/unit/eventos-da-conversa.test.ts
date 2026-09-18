import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ORIGENS_JA_CONTADAS_PELA_CONVERSA,
  TIPOS_DE_EVENTO_DA_CONVERSA,
  descreverEventoDaConversa,
  rotuloDoAtendimento,
  type EventoDaConversa,
} from "@/lib/inbox/eventos-da-conversa";

/**
 * A LINHA DO TEMPO DA CONVERSA — o vocabulário e o que cada linha diz.
 *
 * `conversation_events.type` não tem CHECK no banco (vocabulário aberto, de
 * propósito), então o compilador não enxerga o que o trigger escreve. Este
 * arquivo é a ponte: lê os literais do corpo de
 * `fn_atendimento_acompanha_conversa` no baseline e cobra rótulo para cada um.
 * Tipo sem rótulo não quebra a tela — cai no genérico "Atividade registrada" —,
 * e é por isso que precisa de gate: ele falharia em silêncio.
 */
const t = (texto: string) => texto;

const evento = (over: Partial<EventoDaConversa>): EventoDaConversa => ({
  id: "e1",
  type: "opened",
  actor_kind: "system",
  actor_user_id: null,
  actor_name: null,
  atendimento_id: "a1",
  payload: {},
  created_at: "2026-09-18T12:00:00Z",
  ...over,
});

describe("o trigger e a tela falam o mesmo vocabulário", () => {
  const baseline = readFileSync("supabase/baseline.sql", "utf8");
  const inicio = baseline.indexOf("create or replace function public.fn_atendimento_acompanha_conversa()");
  const corpo = baseline.slice(inicio, baseline.indexOf("revoke execute on function public.fn_atendimento_acompanha_conversa()"));

  it("o instrumento acha o corpo do trigger (guarda de vacuidade)", () => {
    expect(inicio).toBeGreaterThan(-1);
    expect(corpo.length).toBeGreaterThan(2000);
  });

  it("todo tipo que o trigger escreve tem rótulo próprio na tela", () => {
    // Os literais que aparecem na posição do `type` dos INSERTs do trigger.
    const escritos = new Set<string>();
    for (const m of corpo.matchAll(/v_at,\s*'([a-z_]+)'/g)) escritos.add(m[1]!);
    for (const m of corpo.matchAll(/then '([a-z_]+)' else '([a-z_]+)' end/g)) {
      escritos.add(m[1]!);
      escritos.add(m[2]!);
    }
    expect(escritos.size).toBeGreaterThanOrEqual(8);
    const semRotulo = [...escritos].filter(
      (tipo) => !(TIPOS_DE_EVENTO_DA_CONVERSA as readonly string[]).includes(tipo),
    );
    expect(semRotulo, "tipo escrito pelo trigger e ausente de TIPOS_DE_EVENTO_DA_CONVERSA").toEqual([]);
  });

  it("nenhum tipo declarado cai no rótulo genérico", () => {
    for (const tipo of TIPOS_DE_EVENTO_DA_CONVERSA) {
      expect(descreverEventoDaConversa(evento({ type: tipo }), t).titulo, tipo).not.toBe("Atividade registrada");
    }
  });

  it("tipo DESCONHECIDO (banco mais novo que o código) não quebra: diz que algo aconteceu", () => {
    expect(descreverEventoDaConversa(evento({ type: "survey_sent" }), t).titulo).toBe("Atividade registrada");
  });
});

describe("a troca de dono são três gestos, e quem os separa é QUEM fez", () => {
  const payload = { to_user_id: "u-ana", to_user_name: "Ana", from_user_id: null, from_user_name: null };

  it("a própria pessoa: assumiu", () => {
    const d = descreverEventoDaConversa(
      evento({ type: "assigned", actor_kind: "user", actor_user_id: "u-ana", actor_name: "Ana", payload }),
      t,
    );
    expect(d.titulo).toBe("Atendimento assumido");
    expect(d.detalhe).toBe("Ana assumiu a conversa.");
  });

  it("outra pessoa: transferiu — e diz quem", () => {
    const d = descreverEventoDaConversa(
      evento({
        type: "assigned",
        actor_kind: "user",
        actor_user_id: "u-bia",
        actor_name: "Bia",
        payload: { ...payload, from_user_name: "Caio" },
      }),
      t,
    );
    expect(d.titulo).toBe("Conversa transferida");
    expect(d.detalhe).toBe("De Caio para Ana. Por Bia.");
  });

  it("ninguém (service role): o rodízio distribuiu", () => {
    const d = descreverEventoDaConversa(evento({ type: "assigned", actor_kind: "system", payload }), t);
    expect(d.titulo).toBe("Distribuída automaticamente");
  });

  it("homônimos não viram 'assumiu': a comparação é por id, não por nome", () => {
    const d = descreverEventoDaConversa(
      evento({ type: "assigned", actor_kind: "user", actor_user_id: "u-outra-ana", actor_name: "Ana", payload }),
      t,
    );
    expect(d.titulo).toBe("Conversa transferida");
  });
});

describe("o que cada linha diz", () => {
  it("o retorno do cliente abre atendimento NOVO e mostra o protocolo novo", () => {
    const d = descreverEventoDaConversa(
      evento({ type: "opened", payload: { protocol: "20260918000002", retorno: true } }),
      t,
    );
    expect(d.titulo).toBe("Novo atendimento aberto");
    expect(d.detalhe).toContain("20260918000002");
    expect(d.detalhe).toContain("O cliente voltou a escrever.");
  });

  it("encaminhar para um time nomeia o time e diz que espera operador", () => {
    const d = descreverEventoDaConversa(
      evento({ type: "team_changed", payload: { to_team_name: "Cobrança" } }),
      t,
    );
    expect(d.titulo).toBe("Transferida para a fila do time");
    expect(d.detalhe).toBe("Cobrança. Aguardando operador disponível.");
    expect(d.tom).toBe("espera");
  });

  it("encerrar diz POR QUEM — é a pergunta que o protocolo existe para responder", () => {
    const d = descreverEventoDaConversa(
      evento({ type: "closed", actor_kind: "user", actor_name: "Juliana", payload: { status: "resolved" } }),
      t,
    );
    expect(d.titulo).toBe("Conversa resolvida");
    expect(d.detalhe).toBe("Por Juliana.");
    expect(d.tom).toBe("fim");
  });

  it("encerramento do LEGADO (backfill) não inventa autor: nem 'por', nem 'automaticamente'", () => {
    const d = descreverEventoDaConversa(
      evento({ type: "closed", actor_kind: "system", payload: { status: "closed", backfill: true } }),
      t,
    );
    expect(d.titulo).toBe("Conversa encerrada");
    expect(d.detalhe).toBeNull();
  });

  it("CONTROLE: encerramento sem autor e sem backfill continua dizendo que foi automático", () => {
    const d = descreverEventoDaConversa(evento({ type: "closed", actor_kind: "system", payload: { status: "closed" } }), t);
    expect(d.detalhe).toBe("Encerrada automaticamente.");
  });

  it("reabrir avisa que o protocolo é o mesmo", () => {
    expect(descreverEventoDaConversa(evento({ type: "reopened" }), t).detalhe).toContain(
      "O protocolo continua o mesmo.",
    );
  });
});

describe("o que a conversa já conta não entra duas vezes", () => {
  it("as origens excluídas são as dos dois emissores de troca de comando", () => {
    expect(readFileSync("lib/inbox/atividade-de-comando.ts", "utf8")).toContain(
      `sourceModule: "${ORIGENS_JA_CONTADAS_PELA_CONVERSA[0]}"`,
    );
    expect(readFileSync("lib/agent-engine/agent/human-handoff.ts", "utf8")).toContain(
      `sourceModule: '${ORIGENS_JA_CONTADAS_PELA_CONVERSA[1]}'`,
    );
  });
});

describe("o rótulo do atendimento", () => {
  it("aberto enquanto não tem fechamento; depois, o status com que fechou", () => {
    expect(rotuloDoAtendimento({ closed_at: null, closed_status: null })).toBe("Em andamento");
    expect(rotuloDoAtendimento({ closed_at: "2026-09-18T12:00:00Z", closed_status: "resolved" })).toBe("Resolvida");
    expect(rotuloDoAtendimento({ closed_at: "2026-09-18T12:00:00Z", closed_status: "closed" })).toBe("Fechada");
  });
});
