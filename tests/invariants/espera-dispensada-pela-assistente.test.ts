import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Migration 0285 — a Assistente dispensa a espera de uma fala que não pede
 * resposta ("ok, obrigado"). A dispensa é um UPDATE direto em `espera_desde`
 * (fora da lista de colunas do trigger), e o trigger precisa: (1) não
 * ressuscitar a espera num UPDATE de status; (2) desfazer a dispensa quando o
 * cliente escreve de novo, contando da mensagem NOVA; (3) limpar tudo quando a
 * empresa responde.
 */
const CONTATO = "dddddddd-3333-4000-8000-000000000285";
const CONVERSA = "dddddddd-4444-4000-8000-000000000285";

function col(nome: string): string {
  return lastLine(sql(`select coalesce(${nome}::text, '(null)') from public.conversations where id = '${CONVERSA}';`));
}
function mensagem(direcao: "inbound" | "outbound", em: string): void {
  sql(`select public.fn_mark_conversation_message('${CONVERSA}'::uuid, '${direcao}', 'x', '${em}'::timestamptz);`);
}
/** O que o worker faz: guarda o espera_desde e o zera, se nada mudou. */
function dispensar(): void {
  sql(`update public.conversations
          set espera_dispensada_desde = espera_desde,
              espera_dispensada_ate   = last_inbound_at,
              espera_desde            = null
        where id = '${CONVERSA}' and espera_desde is not null and espera_mantida_em is null;`);
}
/** O que a rota "Contar mesmo assim" faz. */
function manter(): void {
  sql(`update public.conversations
          set espera_desde = coalesce(espera_dispensada_desde, last_inbound_at),
              espera_dispensada_ate = null, espera_dispensada_desde = null,
              espera_mantida_em = now()
        where id = '${CONVERSA}' and espera_dispensada_ate is not null;`);
}

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.conversations where id = '${CONVERSA}';
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${GOV_ORG}', 'Contato 0285') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${GOV_ORG}', '${CONTATO}', '${GOV_SESSION}', 'open');
  `);
});

describe("0285 — espera dispensada pela Assistente", () => {
  it("dispensar zera a espera e guarda a original", () => {
    mensagem("inbound", "2026-09-26 10:00:00+00");
    dispensar();
    expect(col("espera_desde")).toBe("(null)");
    expect(col("espera_dispensada_desde")).toBe("2026-09-26 10:00:00+00");
    expect(col("espera_dispensada_ate")).toBe("2026-09-26 10:00:00+00");
  });

  it("um UPDATE de status NÃO ressuscita a espera dispensada", () => {
    sql(`update public.conversations set status = 'pending' where id = '${CONVERSA}';`);
    sql(`update public.conversations set status = 'open' where id = '${CONVERSA}';`);
    expect(col("espera_desde")).toBe("(null)");
    expect(col("espera_dispensada_ate")).toBe("2026-09-26 10:00:00+00");
  });

  it("mensagem nova do cliente desfaz a dispensa e conta DA MENSAGEM NOVA", () => {
    mensagem("inbound", "2026-09-26 10:20:00+00");
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
    expect(col("espera_dispensada_ate")).toBe("(null)");
    expect(col("espera_dispensada_desde")).toBe("(null)");
  });

  it("religar devolve a espera ORIGINAL e trava a Assistente", () => {
    dispensar();
    manter();
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
    expect(col("espera_mantida_em")).not.toBe("(null)");
    dispensar(); // a trava: o worker condiciona a `espera_mantida_em is null`
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
  });

  it("a resposta da empresa encerra o ciclo e limpa a trava", () => {
    mensagem("outbound", "2026-09-26 10:30:00+00");
    expect(col("espera_desde")).toBe("(null)");
    expect(col("espera_mantida_em")).toBe("(null)");
    expect(col("espera_dispensada_ate")).toBe("(null)");
  });

  it("depois da resposta, a próxima entrada abre ciclo novo, dispensável", () => {
    mensagem("inbound", "2026-09-26 11:00:00+00");
    expect(col("espera_desde")).toBe("2026-09-26 11:00:00+00");
    dispensar();
    expect(col("espera_desde")).toBe("(null)");
  });

  it("encerrar limpa a dispensa", () => {
    sql(`update public.conversations set status = 'closed' where id = '${CONVERSA}';`);
    expect(col("espera_dispensada_ate")).toBe("(null)");
    expect(col("espera_dispensada_desde")).toBe("(null)");
  });
});
