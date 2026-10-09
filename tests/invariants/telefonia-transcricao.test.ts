/**
 * O SQL DA TRANSCRIÇÃO DAS LIGAÇÕES CONTRA POSTGRES REAL (migration 0298, F4).
 *
 * O serviço do worker é provado com bancos de mentira
 * (lib/channels/telefonia/transcricoes.test.ts); aqui se prova o outro lado —
 * que cada consulta de lib/channels/telefonia/repositorio-das-transcricoes.ts
 * faz, no schema de verdade, o que o worker espera. Sempre com DUAS
 * organizações: o worker usa `pg.Pool` FORA da RLS, e a única catraca é o
 * `organization_id` que cada consulta filtra à mão.
 *
 *  1. a tabela é server-side only: `anon` e `authenticated` não têm grant nenhum,
 *     nem com o default ACL do Supabase concedido antes;
 *  2. "só daqui para frente": o pedido só nasce para a gravação GUARDADA de
 *     organização com a transcrição ligada, que terminou DEPOIS de ligar;
 *  3. o pedido nasce `pending` e o cartão diz "processando" — sem tocar no resto
 *     do `voice_call`;
 *  4. a reserva não entrega a mesma ligação duas vezes;
 *  5. concluir grava texto, trechos e resumo e a projeção vira "pronta" — sem
 *     NENHUM texto na linha de `messages`;
 *  6. contato anonimizado: concluir não escreve; e anonimizar DEPOIS apaga a
 *     transcrição pelos dois caminhos (o botão da ficha e a cascata);
 *  7. perdida: `failed`, projeção "falhou" e UM aviso na Central para duas falhas;
 *  8. a poda da gravação vencida apaga a transcrição junto;
 *  9. a mensagem da ligação que sai leva a transcrição;
 * 10. a política: ligar marca o instante (a régua do "só daqui para frente"),
 *     salvar de novo não o move, e ligar sem chave não grava nada.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as repo from "@/lib/channels/telefonia/repositorio";
import * as gravacoes from "@/lib/channels/telefonia/repositorio-das-gravacoes";
import * as transcricoes from "@/lib/channels/telefonia/repositorio-das-transcricoes";
import { lerPoliticaDaOrg, salvarPoliticaDaOrg } from "@/lib/telefonia/gravacao-da-org";
import * as poda from "@/lib/telefonia/poda-das-gravacoes";
import { trechosDaTranscricao } from "@/lib/telefonia/transcricao";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de0298-9000-4000-8000-00000000000a";
const OUTRA = "c0de0298-9000-4000-8000-00000000000b";
const ANA = "c0de0298-9111-4000-8000-000000000001";
const NUMERO = "c0de0298-9555-4000-8000-000000000001";
const NUMERO_OUTRA = "c0de0298-9555-4000-8000-000000000002";

const TRECHOS = [
  { inicio_ms: 0, fim_ms: 1900, quem: "atendente" as const, texto: "Totus, boa tarde." },
  { inicio_ms: 2400, fim_ms: 6000, quem: "cliente" as const, texto: "Estou sem internet desde ontem." },
];
const TEXTO = "Totus, boa tarde. Estou sem internet desde ontem.";
const RESUMO = "O cliente relatou que está sem internet desde ontem.";

let seq = 0;

beforeAll(async () => {
  await pool.query(
    `insert into private.app_secrets (name, value)
     values ('nuvemshop_oauth_key', 'chave-de-teste-do-harness-0298-transcricao-nao-e-segredo')
     on conflict (name) do nothing`,
  );
  await pool.query(`insert into auth.users (id, email) values ($1, 'ana-transcricao@invariant.test') on conflict (id) do nothing`, [ANA]);
  // A com idioma escolhido; B com o padrão do schema (`locale` é NOT NULL com default).
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name, locale)
     values ($1, 'transcricao-a', 'Transcrição A', 'Provedor Alfa', 'es') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name)
     values ($1, 'transcricao-b', 'Transcrição B', 'Provedor Beta') on conflict (id) do nothing`,
    [OUTRA],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted)
     values
       ($1, $3, 'sip_trunk', '\\x00', 'STARTING', 'Transcrição A', '+556130009298',
        'voip.exemplo-9298.com.br', 5060, 'udp', 'u9298', public.fn_encrypt_oauth('senha-de-teste-9298')),
       ($2, $4, 'sip_trunk', '\\x00', 'STARTING', 'Transcrição B', '+556130009299',
        'voip.exemplo-9299.com.br', 5060, 'udp', 'u9299', public.fn_encrypt_oauth('senha-de-teste-9299'))
     on conflict (id) do nothing`,
    [NUMERO, NUMERO_OUTRA, ORG, OUTRA],
  );
  // As duas organizações com a transcrição ligada há uma hora — cada caso que
  // precisa de outra política a muda e a devolve.
  await pool.query(
    `insert into phone_settings (organization_id, recording_enabled, transcription_enabled, transcription_enabled_at)
     values ($1, true, true, now() - interval '1 hour'), ($2, true, true, now() - interval '1 hour')
     on conflict (organization_id) do update
       set recording_enabled = true, transcription_enabled = true, transcription_enabled_at = now() - interval '1 hour'`,
    [ORG, OUTRA],
  );
});

afterAll(async () => {
  await pool.end();
});

/** Uma ligação recebida, atendida, gravada e GUARDADA (o que o worker deixa pronto antes da transcrição). */
async function gravada(org: string, numero: string) {
  const e164 = `+55619977${String(++seq).padStart(5, "0")}`;
  const contactId = await repo.acharOuCriarContato(pool, org, e164, null);
  const conversationId = await repo.acharOuCriarConversa(pool, org, contactId, numero, null);
  const vcId = await repo.criarLigacao(pool, {
    organizationId: org,
    troncoId: numero,
    sipCallRef: `canal-transcricao-${seq}`,
    direcao: "inbound",
    numeroDoOutroLado: e164,
    contactId,
    conversationId,
    teamId: null,
    status: "ringing",
  });
  await repo.marcarAtendida(pool, org, vcId, ANA);
  await gravacoes.marcarGravando(pool, org, vcId, new Date());
  const l = await repo.encerrarLigacao(pool, org, vcId, "cliente_desligou");
  if (!l) throw new Error("não encerrou");
  await repo.registrarNaConversa(pool, l, "atendida", 61_000);
  const msg = await gravacoes.mensagemDaLigacao(pool, org, vcId);
  if (!msg) throw new Error("sem mensagem da ligação");
  const caminho = `${org}/${msg.conversationId}/${msg.id}.mp3`;
  const r = await gravacoes.anexarGravacao(pool, { organizationId: org, vcId, mensagemId: msg.id, caminho, bytes: 183_000, duracaoMs: 61_000 });
  if (r !== "anexada") throw new Error(`gravação não anexada: ${r}`);
  return { vcId, contactId, conversationId, mensagemId: msg.id, caminho };
}

const linhaDa = async (vcId: string) =>
  (
    await pool.query<{
      status: string;
      organization_id: string;
      attempts: number;
      text: string | null;
      segments: unknown;
      summary: string | null;
      last_error: string | null;
      completed_at: Date | null;
    }>(
      "select status, organization_id, attempts, text, segments, summary, last_error, completed_at from voice_call_transcripts where voice_call_id = $1",
      [vcId],
    )
  ).rows[0];

const mensagemDa = async (org: string, vcId: string) =>
  (
    await pool.query<{ metadata: Record<string, unknown>; body: string | null; media_derived_text: string | null }>(
      "select metadata, body, media_derived_text from messages where organization_id = $1 and external_id = $2",
      [org, `ligacao:${vcId}`],
    )
  ).rows[0];

const projecaoDa = async (org: string, vcId: string) =>
  ((await mensagemDa(org, vcId))?.metadata.voice_call as Record<string, unknown> | undefined)?.transcricao;

const concluir = (org: string, vcId: string, p: Partial<Parameters<typeof transcricoes.concluirTranscricao>[1]> = {}) =>
  transcricoes.concluirTranscricao(pool, {
    organizationId: org,
    vcId,
    estado: "ready",
    texto: TEXTO,
    trechos: TRECHOS,
    resumo: RESUMO,
    idioma: "portuguese",
    modelo: "whisper-1",
    duracaoMs: 61_000,
    ...p,
  });

describe("a tabela é server-side only", () => {
  it("anon e authenticated não têm NENHUM privilégio; o service_role lê e escreve", async () => {
    const { rows } = await pool.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'voice_call_transcripts'
          and grantee in ('anon', 'authenticated', 'PUBLIC', 'service_role')`,
    );
    expect(rows.filter((r) => r.grantee !== "service_role")).toEqual([]);
    expect(rows.filter((r) => r.grantee === "service_role").map((r) => r.privilege_type).sort()).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
  });

  it("a RLS está ligada e NÃO há policy: mesmo com um grant concedido por engano, o membro não lê linha nenhuma", async () => {
    const { rows: rls } = await pool.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'public.voice_call_transcripts'::regclass",
    );
    expect(rls[0]?.relrowsecurity).toBe(true);
    const { rows: policies } = await pool.query("select 1 from pg_policies where schemaname = 'public' and tablename = 'voice_call_transcripts'");
    expect(policies).toEqual([]);

    const { vcId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    await concluir(ORG, vcId);
    const c = await pool.connect();
    try {
      await c.query("begin");
      // O default ACL de TABELAS de todo projeto Supabase concede isto a tabela nova.
      await c.query("grant select on public.voice_call_transcripts to authenticated");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ANA, role: "authenticated" })]);
      const { rows } = await c.query("select voice_call_id from public.voice_call_transcripts");
      expect(rows).toEqual([]);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("sem o grant (o estado real), a leitura do membro é recusada", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await expect(c.query("select 1 from public.voice_call_transcripts limit 1")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("o pedido — só daqui para frente", () => {
  it("gravação guardada de organização com a transcrição ligada: nasce pending, e o cartão diz 'processando'", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    expect(await projecaoDa(ORG, vcId)).toBeUndefined();

    expect(await transcricoes.pedirTranscricao(pool, ORG, vcId)).toBe(true);
    const linha = await linhaDa(vcId);
    expect(linha).toMatchObject({ status: "pending", organization_id: ORG, attempts: 0, text: null, summary: null });
    expect(await projecaoDa(ORG, vcId)).toEqual({ situacao: "processando" });
    // O resto do cartão ficou: a projeção entrou por jsonb_set.
    const vc = (await mensagemDa(ORG, vcId))?.metadata.voice_call as Record<string, unknown>;
    expect(vc.gravacao).toEqual({ situacao: "pronta", duracao_ms: 61_000 });
    expect(vc.desfecho).toBe("atendida");

    // Pedir de novo não cria outra nem reinicia a que existe.
    expect(await transcricoes.pedirTranscricao(pool, ORG, vcId)).toBe(false);
  });

  it("a organização da ligação é a que vale: pedir com a outra organização não cria nada", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    expect(await transcricoes.pedirTranscricao(pool, OUTRA, vcId)).toBe(false);
    expect(await linhaDa(vcId)).toBeUndefined();
  });

  it("transcrição desligada: nenhum pedido", async () => {
    await pool.query("update phone_settings set transcription_enabled = false where organization_id = $1", [ORG]);
    try {
      const { vcId } = await gravada(ORG, NUMERO);
      expect(await transcricoes.pedirTranscricao(pool, ORG, vcId)).toBe(false);
      await transcricoes.pedirAsQueFaltam(pool, 500);
      expect(await linhaDa(vcId)).toBeUndefined();
      expect(await projecaoDa(ORG, vcId)).toBeUndefined();
    } finally {
      await pool.query("update phone_settings set transcription_enabled = true where organization_id = $1", [ORG]);
    }
  });

  it("a ligação que terminou ANTES de ligar a transcrição não é transcrita — nem pela passada", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    await pool.query("update phone_settings set transcription_enabled_at = now() + interval '1 minute' where organization_id = $1", [ORG]);
    try {
      expect(await transcricoes.pedirTranscricao(pool, ORG, vcId)).toBe(false);
      await transcricoes.pedirAsQueFaltam(pool, 50);
      expect(await linhaDa(vcId)).toBeUndefined();
    } finally {
      await pool.query("update phone_settings set transcription_enabled_at = now() - interval '1 hour' where organization_id = $1", [ORG]);
    }
  });

  it("ligada sem o instante gravado (linha antiga, escrita à mão): não transcreve nada", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    await pool.query("update phone_settings set transcription_enabled_at = null where organization_id = $1", [ORG]);
    try {
      expect(await transcricoes.pedirTranscricao(pool, ORG, vcId)).toBe(false);
    } finally {
      await pool.query("update phone_settings set transcription_enabled_at = now() - interval '1 hour' where organization_id = $1", [ORG]);
    }
  });

  it("gravação que não está guardada (ainda gravando, perdida) não é pedida", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    await pool.query("update voice_calls set recording_status = 'failed' where id = $1", [vcId]);
    expect(await transcricoes.pedirTranscricao(pool, ORG, vcId)).toBe(false);
  });

  it("contato anonimizado não é pedido", async () => {
    const { vcId, contactId } = await gravada(ORG, NUMERO);
    await pool.query("update contacts set is_anonymized = true, anonymized_at = now() where id = $1", [contactId]);
    expect(await transcricoes.pedirTranscricao(pool, ORG, vcId)).toBe(false);
    await transcricoes.pedirAsQueFaltam(pool, 500);
    expect(await linhaDa(vcId)).toBeUndefined();
  });

  it("a passada repõe o pedido que se perdeu — das DUAS organizações, cada um na sua — e só das últimas 48 h", async () => {
    // As gravações guardadas que os casos de cima deixaram sem pedido entram
    // primeiro: daqui para baixo, o que a passada achar é só o que este caso criou.
    await transcricoes.pedirAsQueFaltam(pool, 500);
    const a = await gravada(ORG, NUMERO);
    const b = await gravada(OUTRA, NUMERO_OUTRA);
    const velha = await gravada(ORG, NUMERO);
    await pool.query("update phone_settings set transcription_enabled_at = now() - interval '10 days' where organization_id = $1", [ORG]);
    await pool.query("update voice_calls set ended_at = now() - interval '3 days' where id = $1", [velha.vcId]);
    try {
      expect(await transcricoes.pedirAsQueFaltam(pool, 50)).toBe(2);
      expect((await linhaDa(a.vcId))?.organization_id).toBe(ORG);
      expect((await linhaDa(b.vcId))?.organization_id).toBe(OUTRA);
      expect(await linhaDa(velha.vcId)).toBeUndefined();
      expect(await projecaoDa(OUTRA, b.vcId)).toEqual({ situacao: "processando" });
      // A segunda passada não acha mais nada.
      expect(await transcricoes.pedirAsQueFaltam(pool, 50)).toBe(0);
    } finally {
      await pool.query("update phone_settings set transcription_enabled_at = now() - interval '1 hour' where organization_id = $1", [ORG]);
      await pool.query("delete from voice_call_transcripts where voice_call_id = any($1::uuid[])", [[a.vcId, b.vcId]]);
    }
  });
});

describe("a reserva", () => {
  it("entrega as pendentes da vez UMA vez: quem chega depois não leva a mesma", async () => {
    await pool.query("delete from voice_call_transcripts");
    const a = await gravada(ORG, NUMERO);
    const b = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, a.vcId);
    await transcricoes.pedirTranscricao(pool, ORG, b.vcId);

    const primeira = await transcricoes.reservarPendentes(pool, 10, 600);
    expect(primeira.map((p) => p.vcId).sort()).toEqual([a.vcId, b.vcId].sort());
    expect(primeira[0]).toMatchObject({ organizationId: ORG, tentativas: 0 });
    expect(primeira[0]?.pedidaEm).toBeInstanceOf(Date);
    expect(await transcricoes.reservarPendentes(pool, 10, 600)).toEqual([]);
    expect(await transcricoes.reservarUma(pool, ORG, a.vcId, 600)).toBeNull();
  });

  it("reservarUma: só a da própria organização, e só enquanto está na vez", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    expect(await transcricoes.reservarUma(pool, OUTRA, vcId, 600)).toBeNull();
    expect((await transcricoes.reservarUma(pool, ORG, vcId, 600))?.vcId).toBe(vcId);
    expect(await transcricoes.reservarUma(pool, ORG, vcId, 600)).toBeNull();
  });

  it("reagendar conta a tentativa, guarda a classe do erro e devolve a ligação à fila só depois da espera", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    await transcricoes.reagendarTranscricao(pool, ORG, vcId, 300, "transcription_429");
    expect(await linhaDa(vcId)).toMatchObject({ status: "pending", attempts: 1, last_error: "transcription_429" });
    expect(await transcricoes.reservarUma(pool, ORG, vcId, 600)).toBeNull();
    await pool.query("update voice_call_transcripts set next_attempt_at = now() - interval '1 second' where voice_call_id = $1", [vcId]);
    expect((await transcricoes.reservarUma(pool, ORG, vcId, 600))?.tentativas).toBe(1);
  });
});

describe("o contexto que o worker lê", () => {
  it("devolve o sentido, o nome e o idioma da organização, a política e o arquivo da gravação", async () => {
    const g = await gravada(ORG, NUMERO);
    expect(await transcricoes.contextoDaTranscricao(pool, ORG, g.vcId)).toEqual({
      sentido: "recebida",
      empresa: "Provedor Alfa",
      idioma: "es",
      ligada: true,
      gravacao: "stored",
      anonimizado: false,
      contactId: g.contactId,
      conversationId: g.conversationId,
      mensagemId: g.mensagemId,
      caminho: g.caminho,
    });
    // A ligação de uma organização não é contexto para a outra.
    expect(await transcricoes.contextoDaTranscricao(pool, OUTRA, g.vcId)).toBeNull();
  });

  it("organização com o idioma padrão do schema lê pt-BR; com a política desligada, o contexto diz desligada", async () => {
    const g = await gravada(OUTRA, NUMERO_OUTRA);
    expect((await transcricoes.contextoDaTranscricao(pool, OUTRA, g.vcId))?.idioma).toBe("pt-BR");
    await pool.query("update phone_settings set transcription_enabled = false where organization_id = $1", [OUTRA]);
    try {
      expect((await transcricoes.contextoDaTranscricao(pool, OUTRA, g.vcId))?.ligada).toBe(false);
    } finally {
      await pool.query("update phone_settings set transcription_enabled = true where organization_id = $1", [OUTRA]);
    }
  });
});

describe("concluir", () => {
  it("grava texto, trechos e resumo; a projeção vira 'pronta' — e NENHUM texto vai para a linha de messages", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    expect(await concluir(ORG, vcId)).toBe("gravada");

    const linha = await linhaDa(vcId);
    expect(linha).toMatchObject({ status: "ready", text: TEXTO, summary: RESUMO, last_error: null });
    expect(linha?.completed_at).toBeInstanceOf(Date);
    // O jsonb volta legível pelo leitor central — o mesmo que a rota usa.
    expect(trechosDaTranscricao(linha?.segments)).toEqual(TRECHOS);

    const msg = await mensagemDa(ORG, vcId);
    expect((msg?.metadata.voice_call as Record<string, unknown>).transcricao).toEqual({ situacao: "pronta" });
    expect(msg?.media_derived_text).toBeNull();
    expect(JSON.stringify(msg)).not.toContain("sem internet");
  });

  it("sem fala: `empty`, projeção 'sem_fala', sem texto", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    expect(await concluir(ORG, vcId, { estado: "empty", texto: null, trechos: [], resumo: null })).toBe("gravada");
    expect(await linhaDa(vcId)).toMatchObject({ status: "empty", text: null, summary: null });
    expect(await projecaoDa(ORG, vcId)).toEqual({ situacao: "sem_fala" });
  });

  it("com a organização errada nada é escrito", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    expect(await concluir(OUTRA, vcId)).toBe("descartada");
    expect(await linhaDa(vcId)).toMatchObject({ status: "pending", text: null });
  });

  it("não reescreve a transcrição que já está pronta", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    await concluir(ORG, vcId);
    expect(await concluir(ORG, vcId, { texto: "outro texto", resumo: "outro resumo" })).toBe("descartada");
    expect(await linhaDa(vcId)).toMatchObject({ status: "ready", text: TEXTO, summary: RESUMO });
  });

  it("contato anonimizado no meio do caminho: NADA do texto é escrito, e o pedido sai", async () => {
    const { vcId, contactId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    // Anonimizado sem passar pelo trigger (a linha pending segue lá): é a corrida
    // que a conferência dentro do concluir existe para fechar.
    await pool.query("alter table contacts disable trigger trg_transcricoes_do_contato_anonimizado");
    try {
      await pool.query("update contacts set is_anonymized = true, anonymized_at = now() where id = $1", [contactId]);
    } finally {
      await pool.query("alter table contacts enable trigger trg_transcricoes_do_contato_anonimizado");
    }
    expect((await linhaDa(vcId))?.status).toBe("pending");

    expect(await concluir(ORG, vcId)).toBe("descartada");
    expect(await linhaDa(vcId)).toBeUndefined();
    expect(await projecaoDa(ORG, vcId)).toBeUndefined();
  });

  it("gravação que venceu no meio do caminho: nada é escrito", async () => {
    const { vcId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    await pool.query("update voice_calls set recording_status = 'expired' where id = $1", [vcId]);
    expect(await concluir(ORG, vcId)).toBe("descartada");
    expect(await linhaDa(vcId)).toBeUndefined();
  });
});

describe("LGPD — anonimizar o contato apaga a transcrição", () => {
  it("o sinal é contacts.is_anonymized: a transcrição pronta e a projeção saem, e só as DESTE contato", async () => {
    const alvo = await gravada(ORG, NUMERO);
    const vizinho = await gravada(ORG, NUMERO);
    for (const g of [alvo, vizinho]) {
      await transcricoes.pedirTranscricao(pool, ORG, g.vcId);
      await concluir(ORG, g.vcId);
    }
    // O caminho do botão da ficha: só o contato muda; `messages` não é tocada por ele.
    await pool.query("update contacts set is_anonymized = true, anonymized_at = now() where id = $1", [alvo.contactId]);

    expect(await linhaDa(alvo.vcId)).toBeUndefined();
    expect(await projecaoDa(ORG, alvo.vcId)).toBeUndefined();
    // O resto do cartão ficou.
    expect(((await mensagemDa(ORG, alvo.vcId))?.metadata.voice_call as Record<string, unknown>).desfecho).toBe("atendida");
    expect((await linhaDa(vizinho.vcId))?.status).toBe("ready");
    expect(await projecaoDa(ORG, vizinho.vcId)).toEqual({ situacao: "pronta" });
  });

  it("a cascata do worker de LGPD também: a transcrição sai junto com a gravação", async () => {
    const { vcId, contactId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    await concluir(ORG, vcId);
    const { rows: pedido } = await pool.query<{ id: string }>(
      `insert into lgpd_requests (organization_id, request_type, source, scope, contact_id, due_at)
       values ($1, 'redact', 'manual', 'contact', $2, now() + interval '15 days') returning id`,
      [ORG, contactId],
    );
    await pool.query("select public.fn_lgpd_cascade_redact_contact($1, $2, $3)", [ORG, contactId, pedido[0]!.id]);
    expect(await linhaDa(vcId)).toBeUndefined();
  });

  it("um membro que marca o contato como anonimizado pela REST também dispara a limpeza (a função é definer)", async () => {
    const { vcId, contactId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    await concluir(ORG, vcId);
    await pool.query(
      `insert into public.user_organizations (organization_id, user_id, role) values ($1, $2, 'agent')
       on conflict do nothing`,
      [ORG, ANA],
    );
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ANA, role: "authenticated" })]);
      const r = await c.query("update public.contacts set is_anonymized = true, anonymized_at = now() where id = $1", [contactId]);
      await c.query("commit");
      // Se a RLS de `contacts` um dia barrar este UPDATE, o caso deixa de medir
      // o trigger — e tem de dizer isso em vez de passar calado.
      expect(r.rowCount).toBe(1);
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    expect(await linhaDa(vcId)).toBeUndefined();
  });

  it("voltar is_anonymized para falso e outras escritas do contato não apagam nada", async () => {
    const { vcId, contactId } = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, vcId);
    await concluir(ORG, vcId);
    await pool.query("update contacts set display_name = 'Outro Nome', is_anonymized = false where id = $1", [contactId]);
    expect((await linhaDa(vcId))?.status).toBe("ready");
  });
});

describe("perdida", () => {
  it("failed, projeção 'falhou' e UM aviso na Central para duas falhas; a de outra organização tem o seu", async () => {
    await pool.query("delete from agent_inbox_items where kind = 'phone_transcription_failed'");
    const aviso = { titulo: "A transcrição de uma ligação não saiu", corpo: "O serviço de transcrição falhou." };
    const a = await gravada(ORG, NUMERO);
    const b = await gravada(ORG, NUMERO);
    const c = await gravada(OUTRA, NUMERO_OUTRA);
    for (const [org, g] of [[ORG, a], [ORG, b], [OUTRA, c]] as const) await transcricoes.pedirTranscricao(pool, org, g.vcId);

    expect(await transcricoes.falharTranscricao(pool, ORG, a.vcId, "transcription_401", aviso)).toBe(true);
    expect(await transcricoes.falharTranscricao(pool, ORG, b.vcId, "transcription_401", aviso)).toBe(true);
    // A mesma de novo não transita (já não está pending).
    expect(await transcricoes.falharTranscricao(pool, ORG, a.vcId, "transcription_401", aviso)).toBe(false);
    // Com a organização errada, nada.
    expect(await transcricoes.falharTranscricao(pool, ORG, c.vcId, "transcription_401", aviso)).toBe(false);
    expect(await transcricoes.falharTranscricao(pool, OUTRA, c.vcId, "transcription_401", aviso)).toBe(true);

    expect(await linhaDa(a.vcId)).toMatchObject({ status: "failed", attempts: 1, last_error: "transcription_401" });
    expect(await projecaoDa(ORG, a.vcId)).toEqual({ situacao: "falhou" });
    expect((await linhaDa(c.vcId))?.status).toBe("failed");
    const { rows } = await pool.query<{ organization_id: string; n: number }>(
      `select organization_id, count(*)::int as n from agent_inbox_items
        where kind = 'phone_transcription_failed' and status = 'open' group by 1 order by 1`,
    );
    expect(rows).toEqual([
      { organization_id: ORG, n: 1 },
      { organization_id: OUTRA, n: 1 },
    ]);
  });

  it("descartar tira o pedido pendente e a projeção — mas não desfaz a transcrição pronta", async () => {
    const pendente = await gravada(ORG, NUMERO);
    const pronta = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, pendente.vcId);
    await transcricoes.pedirTranscricao(pool, ORG, pronta.vcId);
    await concluir(ORG, pronta.vcId);

    await transcricoes.descartarTranscricao(pool, OUTRA, pendente.vcId);
    expect((await linhaDa(pendente.vcId))?.status).toBe("pending");
    await transcricoes.descartarTranscricao(pool, ORG, pendente.vcId);
    expect(await linhaDa(pendente.vcId)).toBeUndefined();
    expect(await projecaoDa(ORG, pendente.vcId)).toBeUndefined();

    await transcricoes.descartarTranscricao(pool, ORG, pronta.vcId);
    expect((await linhaDa(pronta.vcId))?.status).toBe("ready");
    expect(await projecaoDa(ORG, pronta.vcId)).toEqual({ situacao: "pronta" });
  });
});

describe("retenção e saída da mensagem", () => {
  it("a poda da gravação vencida apaga a transcrição e tira a projeção, e a gravação fica 'expirada'", async () => {
    const g = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, g.vcId);
    await concluir(ORG, g.vcId);

    await poda.marcarExpirada(pool, {
      vcId: g.vcId,
      organizationId: ORG,
      mensagemId: g.mensagemId,
      conversationId: g.conversationId,
      caminho: g.caminho,
    });
    expect(await linhaDa(g.vcId)).toBeUndefined();
    const vc = (await mensagemDa(ORG, g.vcId))?.metadata.voice_call as Record<string, unknown>;
    expect(vc.transcricao).toBeUndefined();
    expect(vc.gravacao).toEqual({ situacao: "expirada", duracao_ms: 61_000 });
  });

  it("a poda com a organização errada não apaga a transcrição de ninguém", async () => {
    const g = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, g.vcId);
    await concluir(ORG, g.vcId);
    await poda.marcarExpirada(pool, { vcId: g.vcId, organizationId: OUTRA, mensagemId: g.mensagemId, conversationId: g.conversationId, caminho: g.caminho });
    expect((await linhaDa(g.vcId))?.status).toBe("ready");
  });

  it("a mensagem da ligação que sai leva a transcrição (e segue levando o arquivo para a fila de remoção)", async () => {
    const g = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, g.vcId);
    await concluir(ORG, g.vcId);
    await pool.query("delete from messages where id = $1", [g.mensagemId]);
    expect(await linhaDa(g.vcId)).toBeUndefined();
    const { rows } = await pool.query("select 1 from storage_redaction_queue where object_path = $1", [g.caminho]);
    expect(rows).toHaveLength(1);
  });

  it("apagar a ligação apaga a transcrição (FK em cascata)", async () => {
    const g = await gravada(ORG, NUMERO);
    await transcricoes.pedirTranscricao(pool, ORG, g.vcId);
    await pool.query("delete from voice_calls where id = $1", [g.vcId]);
    expect(await linhaDa(g.vcId)).toBeUndefined();
  });
});

describe("o uso do transcritor em llm_calls", () => {
  it("grava a chamada com o propósito, o custo e — na falha — o código da régua de erros", async () => {
    const { contactId } = await gravada(ORG, NUMERO);
    await transcricoes.registrarUsoDoTranscritor(pool, {
      organizationId: ORG,
      contactId,
      proposito: "transcricao_de_ligacao",
      modelo: "whisper-1",
      custoCents: 1.2,
      latenciaMs: 2800.4,
      erro: null,
    });
    await transcricoes.registrarUsoDoTranscritor(pool, {
      organizationId: ORG,
      contactId,
      proposito: "transcricao_de_ligacao",
      modelo: "whisper-1",
      custoCents: 9,
      latenciaMs: 100,
      erro: "transcription_401",
    });
    const { rows } = await pool.query(
      `select provider, model, cost_cents::float as cost_cents, latency_ms, status, error_code, http_status
         from llm_calls where organization_id = $1 and purpose = 'transcricao_de_ligacao' order by created_at, status desc`,
      [ORG],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { provider: "openai", model: "whisper-1", cost_cents: 1.2, latency_ms: 2800, status: "ok", error_code: null, http_status: null },
        // Falha não tem custo: nunca inventar valor para o que não foi cobrado.
        { provider: "openai", model: "whisper-1", cost_cents: null, latency_ms: 100, status: "erro", error_code: "credencial_recusada", http_status: 401 },
      ]),
    );
  });
});

describe("a política da transcrição (salvarPoliticaDaOrg)", () => {
  const TERCEIRA = "c0de0298-9000-4000-8000-00000000000c";
  const instante = async () =>
    (
      await pool.query<{ transcription_enabled: boolean; transcription_enabled_at: Date | null }>(
        "select transcription_enabled, transcription_enabled_at from phone_settings where organization_id = $1",
        [TERCEIRA],
      )
    ).rows[0];

  beforeAll(async () => {
    await pool.query(
      `insert into public.organizations (id, slug, legal_name, display_name)
       values ($1, 'transcricao-c', 'Transcrição C', 'Provedor Gama') on conflict (id) do nothing`,
      [TERCEIRA],
    );
  });

  it("organização sem linha: desligada, e a leitura não cria nada", async () => {
    expect(await lerPoliticaDaOrg(pool, TERCEIRA)).toMatchObject({ ativa: false, transcrever: false });
    expect(await instante()).toBeUndefined();
  });

  it("ligar marca o instante de AGORA; salvar de novo com ela ligada não move o instante", async () => {
    const r = await salvarPoliticaDaOrg(pool, TERCEIRA, { ativa: false, retencaoDias: 90, transcrever: true });
    expect(r).toMatchObject({ ok: true, mudou: true, antes: { transcrever: false }, depois: { transcrever: true } });
    const ligada = await instante();
    expect(ligada?.transcription_enabled).toBe(true);
    expect(Math.abs(Date.now() - (ligada?.transcription_enabled_at?.getTime() ?? 0))).toBeLessThan(60_000);

    await pool.query("update phone_settings set transcription_enabled_at = now() - interval '5 days' where organization_id = $1", [TERCEIRA]);
    const antiga = (await instante())?.transcription_enabled_at?.getTime();
    // Corpo antigo (sem o campo) e corpo novo com `true`: nos dois, o instante fica.
    expect(await salvarPoliticaDaOrg(pool, TERCEIRA, { ativa: false, retencaoDias: 180 })).toMatchObject({ ok: true, depois: { transcrever: true } });
    expect(await salvarPoliticaDaOrg(pool, TERCEIRA, { ativa: false, retencaoDias: 180, transcrever: true })).toMatchObject({ ok: true, mudou: false });
    expect((await instante())?.transcription_enabled_at?.getTime()).toBe(antiga);
    expect(await lerPoliticaDaOrg(pool, TERCEIRA)).toMatchObject({ transcrever: true, retencaoDias: 180 });
  });

  it("desligar e ligar de novo recomeça a contagem: o intervalo desligado não é transcrito", async () => {
    await salvarPoliticaDaOrg(pool, TERCEIRA, { ativa: false, retencaoDias: 180, transcrever: false });
    const desligada = await instante();
    expect(desligada?.transcription_enabled).toBe(false);
    await pool.query("update phone_settings set transcription_enabled_at = now() - interval '5 days' where organization_id = $1", [TERCEIRA]);
    await salvarPoliticaDaOrg(pool, TERCEIRA, { ativa: false, retencaoDias: 180, transcrever: true });
    expect(Math.abs(Date.now() - ((await instante())?.transcription_enabled_at?.getTime() ?? 0))).toBeLessThan(60_000);
  });

  it("ligar sem chave: recusado, nada gravado — e a chave só é perguntada ao LIGAR", async () => {
    await salvarPoliticaDaOrg(pool, TERCEIRA, { ativa: false, retencaoDias: 180, transcrever: false });
    let perguntas = 0;
    const semChave = async () => {
      perguntas += 1;
      return false;
    };
    expect(await salvarPoliticaDaOrg(pool, TERCEIRA, { ativa: false, retencaoDias: 30, transcrever: true }, semChave)).toEqual({
      ok: false,
      motivo: "sem_chave_de_transcricao",
    });
    expect(perguntas).toBe(1);
    expect(await lerPoliticaDaOrg(pool, TERCEIRA)).toMatchObject({ transcrever: false, retencaoDias: 180 });
    // Desligada → desligada, e ligada → ligada: a chave não é perguntada.
    await salvarPoliticaDaOrg(pool, TERCEIRA, { ativa: false, retencaoDias: 30, transcrever: false }, semChave);
    expect(perguntas).toBe(1);
  });

  it("ligar a GRAVAÇÃO sem o aviso pronto segue recusado, e a transcrição pedida junto não entra", async () => {
    expect(await salvarPoliticaDaOrg(pool, TERCEIRA, { ativa: true, retencaoDias: 90, transcrever: true })).toEqual({
      ok: false,
      motivo: "sem_aviso",
    });
    expect((await instante())?.transcription_enabled).toBe(false);
  });
});
