import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/**
 * O texto ENTRE dois marcadores únicos do baseline (exclusive do marcador de
 * fim) — lido do arquivo real, nunca copiado, para não poder divergir dele.
 */
function entre(inicio: string, fim: string): string {
  const i = BASELINE.indexOf(inicio);
  if (i === -1) throw new Error(`marcador de início não encontrado no baseline: ${inicio}`);
  if (BASELINE.indexOf(inicio, i + 1) !== -1) throw new Error(`marcador de início repetido no baseline: ${inicio}`);
  const j = BASELINE.indexOf(fim, i + inicio.length);
  if (j === -1) throw new Error(`marcador de fim não encontrado no baseline: ${fim}`);
  return BASELINE.slice(i, j);
}

/** O backfill da 0279 — o `update` que roda em TODO update.sh, extraído do baseline. */
function backfillDa0279(): string {
  return entre(
    "-- Backfill: quem espera hoje recebe a última entrada",
    "create index if not exists conversations_org_espera_desde",
  );
}

/** A cura da 0285 para o backfill acima — também extraída do baseline. */
function curaDa0285(): string {
  return entre("-- ---- cura 0285: início ----", "-- ---- cura 0285: fim ----");
}

/**
 * Migration 0285 — a Assistente dispensa a espera de uma fala que não pede
 * resposta ("ok, obrigado"). A dispensa é a RPC `fn_dispensar_espera` (a mesma
 * que o worker chama): um UPDATE condicional em `espera_desde` (fora da lista
 * de colunas do trigger) mais o evento `espera_dispensada`, na mesma
 * transação. O trigger precisa: (1) não ressuscitar a espera num UPDATE de
 * status; (2) desfazer a dispensa quando o cliente escreve de novo, contando
 * da mensagem NOVA; (3) limpar tudo quando a empresa responde.
 */
const CONTATO = "dddddddd-3333-4000-8000-000000000285";
const CONVERSA = "dddddddd-4444-4000-8000-000000000285";

function col(nome: string, conversa = CONVERSA): string {
  return lastLine(sql(`select coalesce(${nome}::text, '(null)') from public.conversations where id = '${conversa}';`));
}
function mensagem(direcao: "inbound" | "outbound", em: string, conversa = CONVERSA): void {
  sql(`select public.fn_mark_conversation_message('${conversa}'::uuid, '${direcao}', 'x', '${em}'::timestamptz);`);
}
/**
 * Uma entrada como a ingestão grava: a linha em `messages` (carimbo do
 * provedor em SEGUNDOS, `created_at` do servidor) e o carimbo na conversa.
 */
function entrada(em: string, conversa = CONVERSA, contato = CONTATO): string {
  const id = lastLine(
    // CTE: um `insert ... returning` solto faz o psql imprimir "INSERT 0 1" por último.
    sql(`with nova as (
           insert into public.messages
             (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, sent_at)
           values ('${GOV_ORG}', '${conversa}', '${GOV_SESSION}', '${contato}', 'text', 'inbound', 'received', 'crm', 'ok obrigado', '${em}'::timestamptz)
           returning id)
         select id from nova;`),
  );
  mensagem("inbound", em, conversa);
  return id;
}
/** O que o worker leu antes de perguntar ao Jev. */
function leitura(conversa = CONVERSA): { espera: string; ultima: string } {
  const [espera, ultima] = lastLine(
    sql(`select coalesce(espera_desde::text, ''), coalesce(last_inbound_at::text, '') from public.conversations where id = '${conversa}';`),
  ).split("|");
  return { espera: espera!, ultima: ultima! };
}
/** A RPC do worker, com a leitura feita ANTES (padrão: agora). `t` = dispensou. */
function dispensar(mensagemId: string, lida = leitura(), conversa = CONVERSA, org = GOV_ORG): string {
  const espera = lida.espera ? `'${lida.espera}'::timestamptz` : "null";
  const ultima = lida.ultima ? `'${lida.ultima}'::timestamptz` : "null";
  return lastLine(
    sql(`select public.fn_dispensar_espera('${org}'::uuid, '${conversa}'::uuid, ${espera}, ${ultima}, '${mensagemId}'::uuid, '{"probabilidade":0.05}'::jsonb);`),
  );
}
function eventosDeDispensa(conversa = CONVERSA): number {
  return Number(
    lastLine(sql(`select count(*) from public.conversation_events where conversation_id = '${conversa}' and type = 'espera_dispensada';`)),
  );
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
  let ultima = "";

  it("dispensar zera a espera, guarda a original e registra o evento na mesma transação", () => {
    ultima = entrada("2026-09-26 10:00:00+00");
    const antes = eventosDeDispensa();
    expect(dispensar(ultima)).toBe("t");
    expect(col("espera_desde")).toBe("(null)");
    expect(col("espera_dispensada_desde")).toBe("2026-09-26 10:00:00+00");
    expect(col("espera_dispensada_ate")).toBe("2026-09-26 10:00:00+00");
    expect(eventosDeDispensa()).toBe(antes + 1);
  });

  it("um UPDATE de status NÃO ressuscita a espera dispensada", () => {
    sql(`update public.conversations set status = 'pending' where id = '${CONVERSA}';`);
    sql(`update public.conversations set status = 'open' where id = '${CONVERSA}';`);
    expect(col("espera_desde")).toBe("(null)");
    expect(col("espera_dispensada_ate")).toBe("2026-09-26 10:00:00+00");
  });

  it("mensagem nova do cliente NO MESMO SEGUNDO desfaz a dispensa (o carimbo do provedor é em segundos)", () => {
    // `last_inbound_at` não muda (greatest de dois valores iguais): só o
    // carimbo em segundos não distinguiria "a mesma fala" de "fala nova".
    entrada("2026-09-26 10:00:00+00");
    expect(col("espera_desde")).toBe("2026-09-26 10:00:00+00");
    expect(col("espera_dispensada_ate")).toBe("(null)");
    expect(col("espera_dispensada_desde")).toBe("(null)");
  });

  it("mensagem nova do cliente desfaz a dispensa e conta DA MENSAGEM NOVA", () => {
    ultima = entrada("2026-09-26 10:05:00+00");
    expect(dispensar(ultima)).toBe("t");
    ultima = entrada("2026-09-26 10:20:00+00");
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
    expect(col("espera_dispensada_ate")).toBe("(null)");
    expect(col("espera_dispensada_desde")).toBe("(null)");
  });

  it("mensagem ATRASADA (carimbo anterior à dispensa) também desfaz a dispensa", () => {
    expect(dispensar(ultima)).toBe("t");
    entrada("2026-09-26 10:10:00+00");
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
    expect(col("espera_dispensada_ate")).toBe("(null)");
  });

  it("a RPC recusa quando chegou entrada mais nova que a lida — mesmo no mesmo segundo", () => {
    // O worker leu, o Jev pensou, e uma pergunta chegou no MESMO segundo:
    // `espera_desde` e `last_inbound_at` continuam iguais aos lidos, mas a
    // mensagem nova existe — o evento dela decide de novo.
    const lida = leitura();
    const eventos = eventosDeDispensa();
    entrada("2026-09-26 10:20:00+00");
    expect(leitura()).toEqual(lida);
    expect(dispensar(ultima, lida)).toBe("f");
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
    expect(col("espera_dispensada_ate")).toBe("(null)");
    expect(eventosDeDispensa()).toBe(eventos);
  });

  it("a RPC recusa org errada, mensagem de outra conversa e leitura velha", () => {
    const eventos = eventosDeDispensa();
    const nova = entrada("2026-09-26 10:21:00+00");
    expect(dispensar(nova, leitura(), CONVERSA, "00000000-0000-4000-8000-000000000000")).toBe("f");
    expect(dispensar("00000000-0000-4000-8000-000000000001")).toBe("f");
    expect(dispensar(nova, { espera: "2026-09-26 09:00:00+00", ultima: "2026-09-26 10:21:00+00" })).toBe("f");
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
    expect(eventosDeDispensa()).toBe(eventos);
    ultima = nova;
  });

  it("religar devolve a espera ORIGINAL e trava a Assistente", () => {
    expect(dispensar(ultima)).toBe("t");
    manter();
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
    expect(col("espera_mantida_em")).not.toBe("(null)");
    expect(dispensar(ultima)).toBe("f"); // a trava: `espera_mantida_em is null`
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
  });

  it("a resposta da empresa encerra o ciclo e limpa a trava", () => {
    mensagem("outbound", "2026-09-26 10:30:00+00");
    expect(col("espera_desde")).toBe("(null)");
    expect(col("espera_mantida_em")).toBe("(null)");
    expect(col("espera_dispensada_ate")).toBe("(null)");
  });

  it("depois da resposta, a próxima entrada abre ciclo novo, dispensável", () => {
    ultima = entrada("2026-09-26 11:00:00+00");
    expect(col("espera_desde")).toBe("2026-09-26 11:00:00+00");
    expect(dispensar(ultima)).toBe("t");
    expect(col("espera_desde")).toBe("(null)");
  });

  it("encerrar limpa a dispensa", () => {
    sql(`update public.conversations set status = 'closed' where id = '${CONVERSA}';`);
    expect(col("espera_dispensada_ate")).toBe("(null)");
    expect(col("espera_dispensada_desde")).toBe("(null)");
  });

  it("a RPC é só do service_role: anon e authenticated não executam", () => {
    const fn = "public.fn_dispensar_espera(uuid, uuid, timestamptz, timestamptz, uuid, jsonb)";
    expect(
      lastLine(
        sql(`select has_function_privilege('anon', '${fn}', 'execute')::text || ',' ||
                    has_function_privilege('authenticated', '${fn}', 'execute')::text || ',' ||
                    has_function_privilege('service_role', '${fn}', 'execute')::text;`),
      ),
    ).toBe("false,false,true");
  });
});

/**
 * O backfill da 0279 roda em TODO `update.sh` e não conhece a dispensa (nasceu
 * antes dela): ele reescreve `espera_desde` a partir de `last_inbound_at`
 * sempre que a conversa está "sem resposta", inclusive quando a dispensa está
 * ativa — e essa reescrita não passa pelas colunas do trigger, então ele não
 * dispara para corrigir. Sem a cura da 0285, todo `update.sh` ressuscitaria o
 * termômetro de uma conversa dispensada. Conversa própria (não a `CONVERSA` das
 * describes acima) para não depender de ordem de execução.
 */
describe("0285 — cura do backfill da 0279 (extraída do baseline real, não copiada)", () => {
  const CONTATO_CURA = "dddddddd-3333-4000-8000-000000000286";
  const CONVERSA_CURA = "dddddddd-4444-4000-8000-000000000286";

  function colCura(nome: string): string {
    return lastLine(
      sql(`select coalesce(${nome}::text, '(null)') from public.conversations where id = '${CONVERSA_CURA}';`),
    );
  }

  beforeAll(() => {
    seedGov();
    sql(`
      delete from public.conversations where id = '${CONVERSA_CURA}';
      insert into public.contacts (id, organization_id, display_name)
        values ('${CONTATO_CURA}', '${GOV_ORG}', 'Contato cura 0285') on conflict do nothing;
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
        values ('${CONVERSA_CURA}', '${GOV_ORG}', '${CONTATO_CURA}', '${GOV_SESSION}', 'open');
    `);
  });

  it("sem a cura, o backfill da 0279 ressuscitaria o termômetro dispensado — e a cura desfaz", () => {
    sql(
      `select public.fn_mark_conversation_message('${CONVERSA_CURA}'::uuid, 'inbound', 'x', '2026-09-26 12:00:00+00'::timestamptz);`,
    );
    sql(`update public.conversations
            set espera_dispensada_desde = espera_desde,
                espera_dispensada_ate   = last_inbound_at,
                espera_desde            = null
          where id = '${CONVERSA_CURA}' and espera_desde is not null and espera_mantida_em is null;`);
    expect(colCura("espera_desde")).toBe("(null)");
    expect(colCura("espera_dispensada_ate")).toBe("2026-09-26 12:00:00+00");

    // Reproduz o defeito: o texto do backfill da 0279, LIDO do baseline real.
    sql(backfillDa0279());
    expect(colCura("espera_desde"), "o backfill da 0279 não ressuscitou o termômetro — a reprodução não vale").toBe(
      "2026-09-26 12:00:00+00",
    );
    expect(colCura("espera_dispensada_ate")).toBe("2026-09-26 12:00:00+00");

    // A cura da 0285, também LIDA do baseline real, desfaz a ressurreição.
    sql(curaDa0285());
    expect(colCura("espera_desde")).toBe("(null)");
    expect(colCura("espera_dispensada_ate"), "a cura não pode apagar a dispensa, só a ressurreição").toBe(
      "2026-09-26 12:00:00+00",
    );
  });

  /** Grava o estado cru, sem trigger — é como uma dispensa velha fica num banco de clone. */
  function estadoCru(sets: string): void {
    sql(`set session_replication_role = replica;
         update public.conversations set ${sets} where id = '${CONVERSA_CURA}';
         set session_replication_role = origin;`);
  }

  it("a cura limpa a dispensa VENCIDA: entrada mais nova que ela devolve a espera, desde a entrada", () => {
    estadoCru(`status = 'open', last_inbound_at = '2026-09-26 12:00:00+00', last_outbound_at = null, service_closed_at = null,
               espera_desde = null, espera_dispensada_ate = '2026-09-26 11:00:00+00', espera_dispensada_desde = '2026-09-26 11:00:00+00'`);
    sql(curaDa0285());
    expect(colCura("espera_dispensada_ate")).toBe("(null)");
    expect(colCura("espera_dispensada_desde")).toBe("(null)");
    expect(colCura("espera_desde")).toBe("2026-09-26 12:00:00+00");
  });

  it("a cura limpa a dispensa de conversa que não espera mais (respondida ou encerrada)", () => {
    estadoCru(`status = 'open', last_inbound_at = '2026-09-26 12:00:00+00', last_outbound_at = '2026-09-26 12:05:00+00',
               espera_desde = null, espera_dispensada_ate = '2026-09-26 12:00:00+00', espera_dispensada_desde = '2026-09-26 12:00:00+00'`);
    sql(curaDa0285());
    expect(colCura("espera_dispensada_ate")).toBe("(null)");
    expect(colCura("espera_dispensada_desde")).toBe("(null)");
    expect(colCura("espera_desde")).toBe("(null)");

    estadoCru(`status = 'closed', last_outbound_at = null,
               espera_desde = '2026-09-26 12:00:00+00', espera_dispensada_ate = '2026-09-26 12:00:00+00', espera_dispensada_desde = '2026-09-26 12:00:00+00'`);
    sql(curaDa0285());
    expect(colCura("espera_dispensada_ate")).toBe("(null)");
    expect(colCura("espera_desde")).toBe("(null)");
  });

  it("a cura é idempotente e não toca a dispensa legítima", () => {
    estadoCru(`status = 'open', last_inbound_at = '2026-09-26 12:00:00+00', last_outbound_at = null,
               espera_desde = null, espera_dispensada_ate = '2026-09-26 12:00:00+00', espera_dispensada_desde = '2026-09-26 11:59:00+00'`);
    sql(curaDa0285());
    sql(curaDa0285());
    expect(colCura("espera_desde")).toBe("(null)");
    expect(colCura("espera_dispensada_ate")).toBe("2026-09-26 12:00:00+00");
    expect(colCura("espera_dispensada_desde")).toBe("2026-09-26 11:59:00+00");
  });
});
