/**
 * O PRIMEIRO TOQUE DA LIGAÇÃO FEITA CONTRA POSTGRES REAL (migration 0294).
 *
 * A ligação feita que ninguém atendia virava "Ligação sem resposta" na conversa,
 * o mesmo registro para quem deixou o telefone do cliente chamar até a rede
 * desistir e para quem deu um toque e desligou. A 0294 guarda QUANDO o telefone
 * começou a chamar (`voice_calls.peer_ringing_at`), e o registro da conversa
 * passa a levar por quanto tempo chamou (`metadata.voice_call.toque_ms`) — o
 * cartão mostra isso embaixo do selo, com quem encerrou.
 *
 * O controlador é provado com um banco de mentira (controle.test.ts); aqui se
 * prova o SQL, no schema de verdade, sempre com DUAS organizações (o worker usa
 * `pg.Pool` fora da RLS, e a única catraca é o `organization_id` de cada escrita):
 *
 *  1. `encerrarLigacao` grava o instante do toque na MESMA escrita que fecha, no
 *     relógio do banco: `ended_at - peer_ringing_at` é o tempo que o worker
 *     mediu, ao milissegundo — sem depender do relógio de quem chama;
 *  2. sem a medida (o telefone não chamou), a coluna fica nula, e o registro da
 *     conversa sai SEM tempo — nunca um tempo que ninguém mediu;
 *  3. o registro da feita não atendida leva o tempo e o motivo, e o leitor do
 *     cartão (`comoAcabouASaidaSemResposta`) entende os dois; a atendida não leva
 *     tempo de toque;
 *  4. a escrita fica presa à organização, e fechar duas vezes não mexe no instante;
 *  5. o instante é só da linha do TELEFONE (CHECK): a do WaCalls, que a REST
 *     escreve com o JWT do agent, não o aceita — e a do telefone a REST não altera;
 *  6. o bloco do baseline se cura sozinho: com o CHECK derrubado e uma linha
 *     fora da regra, reaplicá-lo limpa a linha e recria o CHECK.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as repo from "@/lib/channels/telefonia/repositorio";
import { ATENDENTE_DESLIGOU, comoAcabouASaidaSemResposta } from "@/lib/telefonia/fim-da-saida";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de0294-0000-4000-8000-00000000000a";
const OUTRA = "c0de0294-0000-4000-8000-00000000000b";
const ANA = "c0de0294-1111-4000-8000-000000000001";
const BRUNO = "c0de0294-1111-4000-8000-000000000002";
const NUMERO = "c0de0294-5555-4000-8000-000000000001";
const NUMERO_OUTRA = "c0de0294-5555-4000-8000-000000000002";
const CHECK = "voice_calls_peer_ringing_so_no_telefone_check";

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, 'ana-toque@invariant.test', '{"full_name":"Ana do Toque"}'),
       ($2, 'bruno-toque@invariant.test', '{"full_name":"Bruno do Toque"}')
     on conflict (id) do nothing`,
    [ANA, BRUNO],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'toque-0294-a', 'Toque 0294 A', 'Toque A'), ($2, 'toque-0294-b', 'Toque 0294 B', 'Toque B')
     on conflict (id) do nothing`,
    [ORG, OUTRA],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $3, 'agent', now()), ($2, $4, 'agent', now())
     on conflict do nothing`,
    [ANA, BRUNO, ORG, OUTRA],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
     values
       ($1, $3, 'sip_trunk', '\\x00', 'STARTING', 'Toque A', '+556130000294',
        'voip.exemplo-0294.com.br', 5060, 'udp', 'u0294a', '\\x00'),
       ($2, $4, 'sip_trunk', '\\x00', 'STARTING', 'Toque B', '+556130000295',
        'voip.exemplo-0295.com.br', 5060, 'udp', 'u0294b', '\\x00')
     on conflict (id) do nothing`,
    [NUMERO, NUMERO_OUTRA, ORG, OUTRA],
  );
});

afterAll(async () => {
  await pool.end();
});

/** O pedido de ligação de saída de `dono`, como a rota o deixa antes de o ramal discar. */
async function feita(org: string, tronco: string, dono: string, ref: string): Promise<string> {
  const contato = await repo.acharOuCriarContato(pool, org, `+55619888${ref.replace(/\D/g, "").padStart(5, "0").slice(-5)}`, "Cliente do toque");
  const conversa = await repo.acharOuCriarConversa(pool, org, contato, tronco, null);
  const id = await repo.criarLigacao(pool, {
    organizationId: org,
    troncoId: tronco,
    sipCallRef: ref,
    direcao: "outbound",
    numeroDoOutroLado: "+5561988880294",
    contactId: contato,
    conversationId: conversa,
    teamId: null,
    status: "starting",
  });
  await pool.query("update public.voice_calls set owner_user_id = $2, created_by = $2 where id = $1", [id, dono]);
  return id;
}

/** O que ficou na linha: o instante do toque e, pelo relógio do BANCO, quanto tempo ele ficou do fim. */
const naLinha = async (id: string) =>
  (
    await pool.query<{ peer_ringing_at: Date | null; ended_at: Date | null; toque_ms: string | null; status: string }>(
      `select peer_ringing_at, ended_at, status,
              round(extract(epoch from (ended_at - peer_ringing_at)) * 1000) as toque_ms
         from public.voice_calls where id = $1`,
      [id],
    )
  ).rows[0]!;

/** O `metadata.voice_call` do registro que `registrarNaConversa` gravou para a ligação `id`. */
const registroDaLigacao = async (org: string, id: string) =>
  (
    await pool.query<{ vc: Record<string, unknown> }>(
      "select metadata->'voice_call' as vc from public.messages where organization_id = $1 and external_id = $2",
      [org, `ligacao:${id}`],
    )
  ).rows[0]?.vc;

describe("o instante do primeiro toque entra na escrita que fecha a ligação", () => {
  it("deu um toque e desligou: 4,2 s do toque ao fim, medidos no relógio do banco", async () => {
    const id = await feita(ORG, NUMERO, ANA, "toque-0294-1");
    const l = await repo.encerrarLigacao(pool, ORG, id, ATENDENTE_DESLIGOU, 4_200);
    expect(l).toMatchObject({ id, end_reason: ATENDENTE_DESLIGOU, status: "ended" });
    // A linha devolvida já traz as duas pontas — é dela que o registro da conversa sai.
    expect(repo.toqueDaSaidaSemResposta(l!)).toBe(4_200);
    expect(Number((await naLinha(id)).toque_ms)).toBe(4_200);
  });

  it("o tempo é o do worker, não a diferença de relógios: o instante gravado é o `now()` do banco menos o que ele mediu", async () => {
    const id = await feita(ORG, NUMERO, ANA, "toque-0294-2");
    const antes = (await pool.query<{ agora: Date }>("select now() as agora")).rows[0]!.agora;
    await repo.encerrarLigacao(pool, ORG, id, "sem_resposta_19", 38_000);
    const l = await naLinha(id);
    expect(Number(l.toque_ms)).toBe(38_000);
    // O toque ficou 38 s ANTES do fechamento — no passado do banco, não no futuro.
    expect(l.peer_ringing_at!.getTime()).toBeLessThan(antes.getTime());
    expect(antes.getTime() - l.peer_ringing_at!.getTime()).toBeLessThanOrEqual(38_000);
  });

  it("o telefone não chamou (sem a medida): a coluna fica nula", async () => {
    const id = await feita(ORG, NUMERO, ANA, "toque-0294-3");
    const l = await repo.encerrarLigacao(pool, ORG, id, ATENDENTE_DESLIGOU);
    expect(l!.peer_ringing_at ?? null).toBeNull();
    expect(repo.toqueDaSaidaSemResposta(l!)).toBeNull();
    expect((await naLinha(id)).peer_ringing_at).toBeNull();
  });

  it("presa à organização, e fechar de novo não mexe no instante", async () => {
    const id = await feita(ORG, NUMERO, ANA, "toque-0294-4");
    // Com a organização de B, a ligação de A nem fecha nem ganha toque.
    expect(await repo.encerrarLigacao(pool, OUTRA, id, ATENDENTE_DESLIGOU, 9_000)).toBeNull();
    expect(await naLinha(id)).toMatchObject({ status: "starting", peer_ringing_at: null });

    await repo.encerrarLigacao(pool, ORG, id, ATENDENTE_DESLIGOU, 4_000);
    const primeira = await naLinha(id);
    // Idempotente: a segunda vez não acha nada para fechar — e não reescreve o toque.
    expect(await repo.encerrarLigacao(pool, ORG, id, "sem_resposta_19", 50_000)).toBeNull();
    const segunda = await naLinha(id);
    expect(segunda.peer_ringing_at!.getTime()).toBe(primeira.peer_ringing_at!.getTime());
    expect(Number(segunda.toque_ms)).toBe(4_000);
  });
});

describe("o registro da conversa conta quanto chamou e quem encerrou", () => {
  it("a feita que o atendente desligou: tempo, motivo e o nome de quem ligou — e o leitor do cartão entende", async () => {
    const id = await feita(ORG, NUMERO, ANA, "toque-0294-5");
    const l = await repo.encerrarLigacao(pool, ORG, id, ATENDENTE_DESLIGOU, 4_200);
    await repo.registrarNaConversa(pool, l!, "sem_resposta", null);
    const vc = await registroDaLigacao(ORG, id);
    expect(vc).toMatchObject({
      direcao: "outbound",
      desfecho: "sem_resposta",
      motivo: ATENDENTE_DESLIGOU,
      atendente_nome: "Ana do Toque",
      toque_ms: 4_200,
    });
    expect(comoAcabouASaidaSemResposta({ motivo: vc!.motivo as string, toque_ms: vc!.toque_ms as number })).toEqual({
      fim: "atendente_desligou",
      toqueMs: 4_200,
    });
  });

  it("a que a rede desistiu: 'ninguém atendeu', com o tempo; cada organização com a sua", async () => {
    const id = await feita(OUTRA, NUMERO_OUTRA, BRUNO, "toque-0294-6");
    const l = await repo.encerrarLigacao(pool, OUTRA, id, "sem_resposta_19", 38_000);
    await repo.registrarNaConversa(pool, l!, "sem_resposta", null);
    const vc = await registroDaLigacao(OUTRA, id);
    expect(vc).toMatchObject({ motivo: "sem_resposta_19", atendente_nome: "Bruno do Toque", toque_ms: 38_000 });
    expect(comoAcabouASaidaSemResposta({ motivo: vc!.motivo as string, toque_ms: vc!.toque_ms as number })).toEqual({
      fim: "ninguem_atendeu",
      toqueMs: 38_000,
    });
    // O registro é da organização da ligação: a outra não o vê.
    expect(await registroDaLigacao(ORG, id)).toBeUndefined();
  });

  it("o telefone não chamou: o registro sai SEM a chave do tempo", async () => {
    const id = await feita(ORG, NUMERO, ANA, "toque-0294-7");
    const l = await repo.encerrarLigacao(pool, ORG, id, ATENDENTE_DESLIGOU);
    await repo.registrarNaConversa(pool, l!, "sem_resposta", null);
    const vc = await registroDaLigacao(ORG, id);
    expect(vc).toMatchObject({ motivo: ATENDENTE_DESLIGOU });
    expect(vc).not.toHaveProperty("toque_ms");
  });

  it("atendida: o instante do toque fica na linha, e o registro não ganha tempo de toque", async () => {
    const id = await feita(ORG, NUMERO, ANA, "toque-0294-8");
    await repo.marcarAtendida(pool, ORG, id, ANA);
    const l = await repo.encerrarLigacao(pool, ORG, id, "cliente_desligou", 25_000);
    expect(l!.peer_ringing_at).not.toBeNull();
    await repo.registrarNaConversa(pool, l!, "atendida", 5_000);
    const vc = await registroDaLigacao(ORG, id);
    expect(vc).toMatchObject({ desfecho: "atendida", duracao_ms: 5_000 });
    expect(vc).not.toHaveProperty("toque_ms");
  });
});

describe("o instante do toque é só da linha do telefone", () => {
  /** A DML como `authenticated` com o JWT de `usuario` (o PostgREST), desfeita no fim. */
  async function comoMembro(usuario: string, dml: string): Promise<{ linhas: number } | { erro: string }> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: usuario })]);
      const r = await c.query(dml);
      return { linhas: r.rowCount ?? 0 };
    } catch (e) {
      return { erro: e instanceof Error ? e.message : String(e) };
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  }

  it("a linha do WaCalls recusa o instante — para o agent pela REST e para o worker", async () => {
    const insert = (valor: string) => `
      insert into public.voice_calls
        (organization_id, channel_session_id, wacalls_call_id, direction, peer_phone, status, created_by, owner_user_id, peer_ringing_at)
      values ('${ORG}', '${NUMERO}', 'wa-0294-' || gen_random_uuid(), 'outbound', '+5561999990294', 'starting', '${ANA}', '${ANA}', ${valor})`;
    // Controle positivo: sem o instante, o INSERT do WaCalls entra como hoje.
    expect(await comoMembro(ANA, insert("null"))).toEqual({ linhas: 1 });
    const recusa = await comoMembro(ANA, insert("now()"));
    expect("erro" in recusa ? recusa.erro : "passou").toContain(CHECK);
    await expect(pool.query(insert("now()"))).rejects.toThrow(CHECK);
  });

  it("a linha do telefone a REST não altera: o agent não forja o toque da própria ligação", async () => {
    const id = await feita(ORG, NUMERO, ANA, "toque-0294-9");
    const r = await comoMembro(ANA, `update public.voice_calls set peer_ringing_at = now() - interval '50 seconds' where id = '${id}'`);
    expect(r).toEqual({ linhas: 0 });
    expect((await naLinha(id)).peer_ringing_at).toBeNull();
  });
});

describe("o bloco do baseline se cura sozinho", () => {
  /** O bloco da 0294, como o `update.sh` o reaplica. */
  function blocoDoBaseline(): string {
    const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
    const inicio = baseline.indexOf("-- ---- telefonia: o instante do primeiro toque na ligação feita (migration 0294) ----");
    const fim = baseline.indexOf("\n-- ---- ", inicio + 10);
    if (inicio < 0 || fim < 0) throw new Error("bloco da 0294 não encontrado no baseline");
    return baseline.slice(inicio, fim);
  }

  it("CHECK derrubado e linha do WaCalls com o instante: reaplicar limpa a linha e recria o CHECK validado", async () => {
    const validado = async () =>
      (
        await pool.query<{ convalidated: boolean }>(
          "select convalidated from pg_constraint where conrelid = 'public.voice_calls'::regclass and conname = $1",
          [CHECK],
        )
      ).rows[0]?.convalidated;
    expect(await validado()).toBe(true);

    await pool.query(`alter table public.voice_calls drop constraint ${CHECK}`);
    const { rows } = await pool.query<{ id: string }>(
      `insert into public.voice_calls
         (organization_id, channel_session_id, wacalls_call_id, direction, peer_phone, status, peer_ringing_at)
       values ($1, $2, 'wa-0294-fora-da-regra', 'outbound', '+5561999990294', 'ended', now())
       returning id`,
      [ORG, NUMERO],
    );
    // O toque de uma ligação do telefone não pode sumir na cura.
    const doTelefone = await feita(ORG, NUMERO, ANA, "toque-0294-10");
    await repo.encerrarLigacao(pool, ORG, doTelefone, ATENDENTE_DESLIGOU, 6_000);

    const bloco = blocoDoBaseline();
    await pool.query(bloco);
    await pool.query(bloco); // duas vezes: reaplicar não quebra nem duplica

    expect(await validado()).toBe(true);
    expect((await naLinha(rows[0]!.id)).peer_ringing_at).toBeNull();
    expect(Number((await naLinha(doTelefone)).toque_ms)).toBe(6_000);
  });
});
