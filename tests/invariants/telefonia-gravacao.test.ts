/**
 * O SQL DA GRAVAÇÃO DAS LIGAÇÕES CONTRA POSTGRES REAL (migration 0289, DYD-53).
 *
 * O controlador e o processamento são provados com bancos de mentira; aqui se
 * prova o outro lado — que cada consulta (lib/channels/telefonia/repositorio-das-gravacoes.ts
 * e o registro da ligação em repositorio.ts) faz, no schema de verdade, o que o
 * worker espera. Sempre com DUAS organizações: o worker usa `pg.Pool` FORA da
 * RLS, e a única catraca é o `organization_id` que cada consulta filtra à mão.
 *
 *  1. a política só devolve o aviso PRONTO e da organização; a FK composta
 *     recusa apontar o aviso para a fala de outra organização;
 *  2. `marcarGravando` só vale na ligação do telefone desta organização, e o
 *     CHECK recusa gravação na linha do WaCalls (escrita pela REST);
 *  3. a ligação gravada nasce na conversa com a projeção "processando";
 *     anexar MESCLA a projeção (o resto do `voice_call` fica) e vira `stored`;
 *  4. mensagem anonimizada no meio do caminho: nada é escrito;
 *  5. perdida: `failed`, projeção "falhou" e UM aviso na Central para duas falhas;
 *  6. a anonimização do contato apaga o arquivo da gravação (a cascata da 0235
 *     põe o caminho na fila de remoção do Storage) — sem mudar a função.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as repo from "@/lib/channels/telefonia/repositorio";
import * as gravacoes from "@/lib/channels/telefonia/repositorio-das-gravacoes";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de0289-9000-4000-8000-00000000000a";
const OUTRA = "c0de0289-9000-4000-8000-00000000000b";
const ANA = "c0de0289-9111-4000-8000-000000000001";
const AVISO = "c0de0289-9333-4000-8000-000000000001";
const AVISO_FALHOU = "c0de0289-9333-4000-8000-000000000002";
const AVISO_OUTRA = "c0de0289-9333-4000-8000-000000000003";
const NUMERO = "c0de0289-9555-4000-8000-000000000001";
const NUMERO_OUTRA = "c0de0289-9555-4000-8000-000000000002";
const hash = (c: string) => c.repeat(64);
const caminho = (org: string, c: string) => `${org}/${hash(c)}.ulaw`;

let seq = 0;

beforeAll(async () => {
  await pool.query(
    `insert into private.app_secrets (name, value)
     values ('nuvemshop_oauth_key', 'chave-de-teste-do-harness-0289-gravacao-nao-e-segredo')
     on conflict (name) do nothing`,
  );
  await pool.query(`insert into auth.users (id, email) values ($1, 'ana-gravacao@invariant.test') on conflict (id) do nothing`, [ANA]);
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'gravacao-a', 'Gravação A', 'Gravação A'), ($2, 'gravacao-b', 'Gravação B', 'Gravação B')
     on conflict (id) do nothing`,
    [ORG, OUTRA],
  );
  await pool.query(
    `insert into public.phone_prompts
       (id, organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status, error)
     values
       ($1, $4, 'recording_notice', 'Esta ligação poderá ser gravada.', 'v', 'm', $6, $8, 2500, 'ready', null),
       ($2, $4, 'recording_notice', 'Aviso que falhou.', 'v', 'm', $7, null, null, 'failed', 'sem_credito'),
       ($3, $5, 'recording_notice', 'Aviso de B.', 'v', 'm', $6, $9, 2500, 'ready', null)
     on conflict (id) do nothing`,
    [AVISO, AVISO_FALHOU, AVISO_OUTRA, ORG, OUTRA, hash("a"), hash("b"), caminho(ORG, "a"), caminho(OUTRA, "a")],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
     values
       ($1, $3, 'sip_trunk', '\\x00', 'STARTING', 'Gravação A', '+556130009289',
        'voip.exemplo-9289.com.br', 5060, 'udp', 'u9289', public.fn_encrypt_oauth('senha-de-teste-9289')),
       ($2, $4, 'sip_trunk', '\\x00', 'STARTING', 'Gravação B', '+556130009290',
        'voip.exemplo-9290.com.br', 5060, 'udp', 'u9290', public.fn_encrypt_oauth('senha-de-teste-9290'))
     on conflict (id) do nothing`,
    [NUMERO, NUMERO_OUTRA, ORG, OUTRA],
  );
});

afterAll(async () => {
  await pool.end();
});

/** Uma ligação recebida da organização, com contato e conversa, já atendida. */
async function ligacao(org: string, numero: string) {
  const e164 = `+55619988${String(++seq).padStart(5, "0")}`;
  const contactId = await repo.acharOuCriarContato(pool, org, e164, null);
  const conversationId = await repo.acharOuCriarConversa(pool, org, contactId, numero, null);
  const vcId = await repo.criarLigacao(pool, {
    organizationId: org,
    troncoId: numero,
    sipCallRef: `canal-gravacao-${seq}`,
    direcao: "inbound",
    numeroDoOutroLado: e164,
    contactId,
    conversationId,
    teamId: null,
    status: "ringing",
  });
  await repo.marcarAtendida(pool, org, vcId, ANA);
  return { vcId, contactId, conversationId };
}

/** Encerra e registra na conversa, como o `finalizar` do controlador. */
async function encerrarERegistrar(org: string, vcId: string) {
  const l = await repo.encerrarLigacao(pool, org, vcId, "cliente_desligou");
  if (!l) throw new Error("não encerrou");
  await repo.registrarNaConversa(pool, l, "atendida", 61_000);
  return l;
}

const metadadoDa = async (org: string, vcId: string) =>
  (
    await pool.query<{ metadata: Record<string, unknown>; media_storage_path: string | null; media_mime: string | null }>(
      "select metadata, media_storage_path, media_mime from messages where organization_id = $1 and external_id = $2",
      [org, `ligacao:${vcId}`],
    )
  ).rows[0];
const estadoDa = async (vcId: string) =>
  (await pool.query<{ recording_status: string | null; recording_notice_at: Date | null }>(
    "select recording_status, recording_notice_at from voice_calls where id = $1",
    [vcId],
  )).rows[0];

describe("a política da organização", () => {
  it("sem linha em phone_settings: não grava", async () => {
    expect(await gravacoes.politicaDeGravacao(pool, OUTRA)).toEqual({ gravar: false, aviso: null });
  });

  it("ligada com o aviso pronto: grava, e o aviso volta com caminho e duração", async () => {
    await pool.query(
      `insert into phone_settings (organization_id, recording_enabled, recording_notice_prompt_id)
       values ($1, true, $2)
       on conflict (organization_id) do update set recording_enabled = true, recording_notice_prompt_id = $2`,
      [ORG, AVISO],
    );
    expect(await gravacoes.politicaDeGravacao(pool, ORG)).toEqual({
      gravar: true,
      aviso: { id: AVISO, storagePath: caminho(ORG, "a"), duracaoMs: 2500 },
    });
  });

  it("aviso que não está pronto não volta — e então o worker não grava", async () => {
    await pool.query("update phone_settings set recording_notice_prompt_id = $2 where organization_id = $1", [ORG, AVISO_FALHOU]);
    expect(await gravacoes.politicaDeGravacao(pool, ORG)).toEqual({ gravar: true, aviso: null });
    await pool.query("update phone_settings set recording_notice_prompt_id = $2 where organization_id = $1", [ORG, AVISO]);
  });

  it("a FK composta recusa o aviso de OUTRA organização", async () => {
    await expect(
      pool.query("update phone_settings set recording_notice_prompt_id = $2 where organization_id = $1", [ORG, AVISO_OUTRA]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("a retenção padrão é 90 dias, e o CHECK recusa fora de 7..3650", async () => {
    const { rows } = await pool.query("select recording_retention_days from phone_settings where organization_id = $1", [ORG]);
    expect(rows[0].recording_retention_days).toBe(90);
    await expect(
      pool.query("update phone_settings set recording_retention_days = 3 where organization_id = $1", [ORG]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("o ciclo da gravação na ligação", () => {
  it("marcarGravando: só a ligação do telefone desta organização, uma vez", async () => {
    const { vcId } = await ligacao(ORG, NUMERO);
    const aviso = new Date("2026-09-29T22:00:00Z");
    expect(await gravacoes.marcarGravando(pool, OUTRA, vcId, aviso)).toBe(false);
    expect((await estadoDa(vcId))?.recording_status).toBeNull();
    expect(await gravacoes.marcarGravando(pool, ORG, vcId, aviso)).toBe(true);
    expect(await gravacoes.marcarGravando(pool, ORG, vcId, new Date())).toBe(false);
    const e = await estadoDa(vcId);
    expect(e?.recording_status).toBe("recording");
    expect(e?.recording_notice_at?.toISOString()).toBe(aviso.toISOString());
  });

  it("o CHECK recusa gravação na linha do WaCalls e estado fora do vocabulário", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into voice_calls (organization_id, channel_session_id, provider, wacalls_call_id, direction, peer_phone, status)
       values ($1, $2, 'wacalls', 'wacalls-gravacao-1', 'inbound', '+5561900000000', 'ended') returning id`,
      [ORG, NUMERO],
    );
    await expect(
      pool.query("update voice_calls set recording_status = 'recording' where id = $1", [rows[0]!.id]),
    ).rejects.toMatchObject({ code: "23514" });
    const { vcId } = await ligacao(ORG, NUMERO);
    await expect(pool.query("update voice_calls set recording_status = 'gravando' where id = $1", [vcId])).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("gravada: nasce 'processando' na conversa; anexar MESCLA e vira stored", async () => {
    const { vcId } = await ligacao(ORG, NUMERO);
    await gravacoes.marcarGravando(pool, ORG, vcId, new Date());
    const l = await encerrarERegistrar(ORG, vcId);
    expect(l.recording_status).toBe("recording");

    const antes = await metadadoDa(ORG, vcId);
    expect((antes?.metadata.voice_call as Record<string, unknown>).gravacao).toEqual({ situacao: "processando", duracao_ms: null });

    expect((await gravacoes.gravacoesPendentes(pool, 50)).map((p) => p.vcId)).toContain(vcId);
    const msg = await gravacoes.mensagemDaLigacao(pool, ORG, vcId);
    expect(msg).not.toBeNull();
    expect(await gravacoes.mensagemDaLigacao(pool, OUTRA, vcId)).toBeNull();

    const destino = `${ORG}/${msg!.conversationId}/${msg!.id}.mp3`;
    expect(
      await gravacoes.anexarGravacao(pool, {
        organizationId: ORG,
        vcId,
        mensagemId: msg!.id,
        caminho: destino,
        bytes: 183_000,
        duracaoMs: 61_000,
      }),
    ).toBe("anexada");

    const depois = await metadadoDa(ORG, vcId);
    const vc = depois?.metadata.voice_call as Record<string, unknown>;
    expect(vc.gravacao).toEqual({ situacao: "pronta", duracao_ms: 61_000 });
    // O resto do cartão ficou: a projeção entrou por jsonb_set, não por cima.
    expect(vc.id).toBe(vcId);
    expect(vc.desfecho).toBe("atendida");
    expect(depois?.media_storage_path).toBe(destino);
    expect(depois?.media_mime).toBe("audio/mpeg");
    expect((await estadoDa(vcId))?.recording_status).toBe("stored");
    expect((await gravacoes.gravacoesPendentes(pool, 50)).map((p) => p.vcId)).not.toContain(vcId);
  });

  it("não gravada: o registro não tem a chave da gravação", async () => {
    const { vcId } = await ligacao(ORG, NUMERO);
    await encerrarERegistrar(ORG, vcId);
    expect((await metadadoDa(ORG, vcId))?.metadata.voice_call).not.toHaveProperty("gravacao");
  });

  it("anexar de OUTRA organização não escreve nada", async () => {
    const { vcId } = await ligacao(ORG, NUMERO);
    await gravacoes.marcarGravando(pool, ORG, vcId, new Date());
    await encerrarERegistrar(ORG, vcId);
    const msg = await gravacoes.mensagemDaLigacao(pool, ORG, vcId);
    expect(
      await gravacoes.anexarGravacao(pool, {
        organizationId: OUTRA,
        vcId,
        mensagemId: msg!.id,
        caminho: `${OUTRA}/x/y.mp3`,
        bytes: 1,
        duracaoMs: 1,
      }),
    ).toBe("anonimizada");
    expect((await metadadoDa(ORG, vcId))?.media_storage_path).toBeNull();
    expect((await estadoDa(vcId))?.recording_status).toBe("recording");
  });

  it("mensagem anonimizada no meio do caminho: nada é escrito; descartar vira expired", async () => {
    const { vcId } = await ligacao(ORG, NUMERO);
    await gravacoes.marcarGravando(pool, ORG, vcId, new Date());
    await encerrarERegistrar(ORG, vcId);
    const msg = await gravacoes.mensagemDaLigacao(pool, ORG, vcId);
    await pool.query("update messages set metadata = '{}'::jsonb where id = $1", [msg!.id]);
    expect(
      await gravacoes.anexarGravacao(pool, {
        organizationId: ORG,
        vcId,
        mensagemId: msg!.id,
        caminho: `${ORG}/${msg!.conversationId}/${msg!.id}.mp3`,
        bytes: 1,
        duracaoMs: 1,
      }),
    ).toBe("anonimizada");
    expect((await metadadoDa(ORG, vcId))?.media_storage_path).toBeNull();
    await gravacoes.descartarGravacao(pool, ORG, vcId);
    expect((await estadoDa(vcId))?.recording_status).toBe("expired");
  });

  it("perdida: failed, projeção 'falhou', e UM aviso na Central para duas falhas", async () => {
    const a = await ligacao(ORG, NUMERO);
    const b = await ligacao(ORG, NUMERO);
    for (const { vcId } of [a, b]) {
      await gravacoes.marcarGravando(pool, ORG, vcId, new Date());
      await encerrarERegistrar(ORG, vcId);
    }
    expect(await gravacoes.falharGravacao(pool, ORG, a.vcId)).toBe(true);
    expect(await gravacoes.falharGravacao(pool, ORG, a.vcId)).toBe(false);
    expect(await gravacoes.falharGravacao(pool, ORG, b.vcId)).toBe(true);

    expect((await estadoDa(a.vcId))?.recording_status).toBe("failed");
    const vc = (await metadadoDa(ORG, a.vcId))?.metadata.voice_call as Record<string, unknown>;
    expect(vc.gravacao).toEqual({ situacao: "falhou", duracao_ms: null });
    expect(vc.id).toBe(a.vcId);

    const { rows } = await pool.query(
      "select count(*)::int as n from agent_inbox_items where organization_id = $1 and kind = 'phone_recording_failed' and status = 'open'",
      [ORG],
    );
    expect(rows[0].n).toBe(1);
  });

  it("estadosDasGravacoes: o estado de cada ligação pedida", async () => {
    const { vcId } = await ligacao(ORG, NUMERO);
    const estados = await gravacoes.estadosDasGravacoes(pool, [vcId, "c0de0289-9999-4000-8000-000000000000"]);
    expect(estados.get(vcId)).toBeNull();
    expect(estados.has("c0de0289-9999-4000-8000-000000000000")).toBe(false);
  });
});

describe("LGPD — anonimizar o contato apaga a gravação", () => {
  it("a cascata da 0235 põe o arquivo da gravação na fila de remoção do Storage", async () => {
    const { vcId, contactId } = await ligacao(ORG, NUMERO);
    await gravacoes.marcarGravando(pool, ORG, vcId, new Date());
    await encerrarERegistrar(ORG, vcId);
    const msg = await gravacoes.mensagemDaLigacao(pool, ORG, vcId);
    const destino = `${ORG}/${msg!.conversationId}/${msg!.id}.mp3`;
    await gravacoes.anexarGravacao(pool, { organizationId: ORG, vcId, mensagemId: msg!.id, caminho: destino, bytes: 1, duracaoMs: 1 });

    await pool.query("select public.fn_lgpd_cascade_redact_contact($1, $2, gen_random_uuid())", [ORG, contactId]);

    const { rows } = await pool.query(
      "select bucket from storage_redaction_queue where organization_id = $1 and object_path = $2",
      [ORG, destino],
    );
    expect(rows.map((r) => r.bucket)).toEqual(["whatsapp-media"]);
    const depois = await metadadoDa(ORG, vcId);
    expect(depois?.media_storage_path).toBeNull();
    expect(depois?.metadata).toEqual({});
  });
});
