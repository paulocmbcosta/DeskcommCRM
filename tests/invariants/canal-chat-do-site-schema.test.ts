import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * O que a migration 0272 promete, cobrado no banco que o CLONE recebe.
 *
 * Lê o Postgres descartável que nasce de `supabase/baseline.sql` — o artefato
 * que o `install.sh` e o `update.sh` de fato aplicam —, nunca o banco de dev.
 * Mudança que existe só em `migrations/` não chega ao self-hoster, e nada
 * reclama até o primeiro INSERT recusado na VPS dele.
 *
 * As asserções são de COMPORTAMENTO: a linha errada tem de ser RECUSADA, com o
 * nome da trava no erro. "Existe uma constraint chamada X" prova que alguém
 * escreveu o nome; o produto precisa que o banco diga não.
 *
 * O caso que este arquivo tem e os unitários não conseguem ter é o último: a
 * ingestão do chat do site faz INSERT direto em `conversations` e `messages`
 * (não passa pela RPC de upsert dos canais de WhatsApp), então os TRIGGERS de
 * atendimento — protocolo, episódio, linha do tempo — precisam aceitar uma
 * conversa cujo meio não é WhatsApp e cujo contato não tem telefone. Só um
 * Postgres de verdade responde isso.
 */

function novaOrg(slug: string): string {
  sql(`
    insert into public.organizations (slug, legal_name, display_name)
    values ('${slug}', 'inv 0272', 'inv 0272');
  `);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o INSERT passou — a trava não existe neste banco");
}

function novoCanalDoSite(org: string, chave: string, extra = ""): string {
  sql(`
    insert into public.channel_sessions
      (organization_id, provider, site_widget_key, site_widget_config, display_name, status, webhook_secret_encrypted ${extra ? ", archived_at" : ""})
    values
      ('${org}', 'site_widget', '${chave}', '{"titulo":"x"}'::jsonb, 'Site', 'WORKING', '\\x00'::bytea ${extra});
  `);
  return sql(`select id from public.channel_sessions where site_widget_key = '${chave}'`).trim();
}

describe("0272 · o chat do site chega ao clone", () => {
  it("as quatro colunas existem no baseline, todas nullable (canal de WhatsApp não as usa)", () => {
    const cols = sql(`select column_name || ':' || is_nullable from information_schema.columns
                       where table_schema = 'public' and table_name = 'channel_sessions'
                         and column_name like 'site\\_widget\\_%' order by 1`).split("\n");
    expect(cols).toEqual([
      "site_widget_config:YES",
      "site_widget_key:YES",
      "site_widget_seen_at:YES",
      "site_widget_seen_host:YES",
    ]);
  });

  it("aceita o provider novo COM a chave", () => {
    const org = novaOrg("inv-0272-aceita");
    expect(novoCanalDoSite(org, "wc_inv0272aceita00000000000")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("recusa o provider novo SEM a chave — pelo CHECK de ref, não por outra trava", () => {
    const org = novaOrg("inv-0272-sem-chave");
    const msg = erroDe(() =>
      sql(`insert into public.channel_sessions (organization_id, provider, status, webhook_secret_encrypted)
           values ('${org}', 'site_widget', 'WORKING', '\\x00'::bytea);`),
    );
    expect(msg).toMatch(/channel_sessions_provider_ref_check/);
  });

  it("os canais que já existiam continuam válidos sob os CHECKs recriados", () => {
    const org = novaOrg("inv-0272-legado");
    // Se o ramo do provider legado tivesse sumido na recriação, o `update.sh` de
    // todo clone com número conectado falharia ao re-aplicar a constraint.
    sql(`insert into public.channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted)
         values ('${org}', 'inv_0272_legado', '\\x00'::bytea);`);
    expect(
      sql(`select provider from public.channel_sessions where waha_session_name = 'inv_0272_legado'`).trim(),
    ).toBe("waha");
  });

  it("a chave é única entre TODAS as linhas — inclusive contra uma ARQUIVADA, e entre organizações", () => {
    const orgA = novaOrg("inv-0272-unica-a");
    const orgB = novaOrg("inv-0272-unica-b");
    novoCanalDoSite(orgA, "wc_inv0272unica000000000000", ", now()");
    // Chave arquivada que renascesse noutra organização faria o snippet esquecido
    // no site de um cliente abrir conversa no inbox de OUTRO.
    const msg = erroDe(() => novoCanalDoSite(orgB, "wc_inv0272unica000000000000"));
    expect(msg).toMatch(/channel_sessions_site_widget_key_unique/);
  });

  it("`conversations.channel` aceita 'site_chat' e segue recusando o que não conhece", () => {
    const org = novaOrg("inv-0272-meio");
    const canal = novoCanalDoSite(org, "wc_inv0272meio0000000000000");
    sql(`insert into public.contacts (id, organization_id, display_name, source)
         values ('d0272000-0000-4000-8000-000000000001', '${org}', 'Visitante', 'site_chat');`);

    const msg = erroDe(() =>
      sql(`insert into public.conversations (organization_id, contact_id, channel_session_id, channel)
           values ('${org}', 'd0272000-0000-4000-8000-000000000001', '${canal}', 'telegram');`),
    );
    expect(msg).toMatch(/conversations_channel_check/);

    sql(`insert into public.conversations (organization_id, contact_id, channel_session_id, channel, provider_conversation_id)
         values ('${org}', 'd0272000-0000-4000-8000-000000000001', '${canal}', 'site_chat', 'wv:inv0272');`);
    expect(
      sql(`select channel from public.conversations where provider_conversation_id = 'wv:inv0272'`).trim(),
    ).toBe("site_chat");
  });

  it("a ENTRADA de um visitante sem telefone atravessa os triggers de atendimento e abre protocolo", () => {
    const org = novaOrg("inv-0272-gatilhos");
    const canal = novoCanalDoSite(org, "wc_inv0272gatilhos000000000");
    sql(`
      insert into public.contacts (id, organization_id, display_name, source)
      values ('d0272000-0000-4000-8000-000000000002', '${org}', 'Visitante 7F3A', 'site_chat');
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, channel, status, provider_conversation_id)
      values ('d0272000-0000-4000-8000-0000000000c2', '${org}', 'd0272000-0000-4000-8000-000000000002', '${canal}', 'site_chat', 'open', 'wv:inv0272gat');
      insert into public.messages (organization_id, conversation_id, contact_id, channel_session_id, external_id, direction, type, body, sent_via, status)
      values ('${org}', 'd0272000-0000-4000-8000-0000000000c2', 'd0272000-0000-4000-8000-000000000002', '${canal}', 'site:inv-0272-1', 'inbound', 'text', 'oi', 'external_device', 'delivered');
    `);

    // A mensagem entrou (nenhum trigger a recusou por faltar telefone ou por o
    // meio não ser WhatsApp)…
    expect(
      sql(`select count(*) from public.messages where external_id = 'site:inv-0272-1'`).trim(),
    ).toBe("1");
    // …e a conversa ganhou o episódio de atendimento, como em qualquer canal: é
    // dele que saem protocolo, fila e SLA.
    expect(
      sql(`select count(*) from public.atendimentos
            where conversation_id = 'd0272000-0000-4000-8000-0000000000c2'`).trim(),
    ).toBe("1");
  });

  it("reenvio do mesmo id de mensagem é recusado pelo índice único — é o que a rota lê como `duplicate`", () => {
    const org = novaOrg("inv-0272-idempotencia");
    const canal = novoCanalDoSite(org, "wc_inv0272idempotencia00000");
    sql(`
      insert into public.contacts (id, organization_id, display_name, source)
      values ('d0272000-0000-4000-8000-000000000003', '${org}', 'V', 'site_chat');
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, channel)
      values ('d0272000-0000-4000-8000-0000000000c3', '${org}', 'd0272000-0000-4000-8000-000000000003', '${canal}', 'site_chat');
      insert into public.messages (organization_id, conversation_id, contact_id, channel_session_id, external_id, direction, type, body)
      values ('${org}', 'd0272000-0000-4000-8000-0000000000c3', 'd0272000-0000-4000-8000-000000000003', '${canal}', 'site:dup', 'inbound', 'text', '1');
    `);
    const msg = erroDe(() =>
      sql(`insert into public.messages (organization_id, conversation_id, contact_id, channel_session_id, external_id, direction, type, body)
           values ('${org}', 'd0272000-0000-4000-8000-0000000000c3', 'd0272000-0000-4000-8000-000000000003', '${canal}', 'site:dup', 'inbound', 'text', '1');`),
    );
    expect(msg).toMatch(/duplicate key|23505/);
  });
});
