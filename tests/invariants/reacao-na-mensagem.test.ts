/**
 * A REAÇÃO É ESTADO DA MENSAGEM ALVO — MEDIDO (migration 0276, DYD-16).
 *
 * `fn_registrar_reacao` grava `metadata.reacoes.{contato|empresa}` num UPDATE
 * só. O que se prova aqui, contra o `baseline.sql` que o self-host aplica:
 *
 *   - grava, SUBSTITUI (uma reação por lado, como no WhatsApp) e REMOVE (emoji
 *     vazio), sem tocar em outras chaves de `metadata`;
 *   - acha o alvo pelo id interno e pelo `external_id` do provider;
 *   - NÃO cruza organização: o alvo de outra org devolve NULL e fica intocado
 *     (o client é service role, que bypassa RLS — a org é o único filtro);
 *   - lado fora do vocabulário é recusado;
 *   - fechada a anon/authenticated (item 9 da doutrina de migrations).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG_A = "c0de0276-0000-4000-8000-00000000000a";
const ORG_B = "c0de0276-0000-4000-8000-00000000000b";
const SESSAO_A = "c0de0276-0000-4000-8000-0000000000a1";
const SESSAO_B = "c0de0276-0000-4000-8000-0000000000b1";
const CONTATO_A = "c0de0276-0000-4000-8000-0000000000a2";
const CONTATO_B = "c0de0276-0000-4000-8000-0000000000b2";
const MSG_A = "c0de0276-0000-4000-8000-0000000000a3";
const MSG_B = "c0de0276-0000-4000-8000-0000000000b3";
const USER_COM_NOME = "c0de0276-0000-4000-8000-0000000000c1";
const USER_SEM_NOME = "c0de0276-0000-4000-8000-0000000000c2";
const FN = "public.fn_registrar_reacao(uuid, uuid, text, text, text, uuid, text, timestamptz)";

const ultima = (saida: string) => saida.trim().split("\n").pop()?.trim() ?? "";
const metadataDe = (id: string) =>
  JSON.parse(ultima(sql(`select metadata::text from public.messages where id='${id}';`))) as Record<
    string,
    unknown
  >;
const reagir = (
  org: string,
  alvo: string | null,
  ext: string | null,
  lado: string,
  emoji: string,
  em = "clock_timestamp()",
) =>
  ultima(
    sql(
      `select coalesce(public.fn_registrar_reacao('${org}', ${alvo ? `'${alvo}'` : "null"}, ${
        ext ? `'${ext}'` : "null"
      }, '${lado}', '${emoji}', null, null, ${em})::text, 'NULO');`,
    ),
  );

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-0276-a', 'Org A 0276', 'Org A 0276'),
      ('${ORG_B}', 'inv-0276-b', 'Org B 0276', 'Org B 0276')
      on conflict (id) do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status) values
      ('${SESSAO_A}', '${ORG_A}', 'inv-0276-a', '\\x00'::bytea, 'WORKING'),
      ('${SESSAO_B}', '${ORG_B}', 'inv-0276-b', '\\x00'::bytea, 'WORKING')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name, phone_number) values
      ('${CONTATO_A}', '${ORG_A}', 'Cliente A', '+5561900002761'),
      ('${CONTATO_B}', '${ORG_B}', 'Cliente B', '+5561900002762')
      on conflict (id) do nothing;
    select public.fn_upsert_wa_conversation('${ORG_A}', '${CONTATO_A}', '${SESSAO_A}');
    select public.fn_upsert_wa_conversation('${ORG_B}', '${CONTATO_B}', '${SESSAO_B}');
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, sent_via, body, metadata)
      select '${MSG_A}', '${ORG_A}', c.id, '${SESSAO_A}', '${CONTATO_A}', 'wamid.inv0276.A', 'text', 'inbound', 'delivered', 'ai', 'oi', '{"outra":"chave"}'::jsonb
        from public.conversations c where c.organization_id='${ORG_A}' and c.contact_id='${CONTATO_A}'
      on conflict (id) do nothing;
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, sent_via, body)
      select '${MSG_B}', '${ORG_B}', c.id, '${SESSAO_B}', '${CONTATO_B}', 'wamid.inv0276.B', 'text', 'inbound', 'delivered', 'ai', 'oi'
        from public.conversations c where c.organization_id='${ORG_B}' and c.contact_id='${CONTATO_B}'
      on conflict (id) do nothing;
  `);
});

describe("fn_registrar_reacao (migration 0276)", () => {
  it("grava pelo external_id, substitui e remove — sem tocar nas outras chaves", () => {
    expect(reagir(ORG_A, null, "wamid.inv0276.A", "contato", "👍")).toBe(MSG_A);
    expect((metadataDe(MSG_A).reacoes as Record<string, { emoji: string }>).contato?.emoji).toBe(
      "👍",
    );

    expect(reagir(ORG_A, MSG_A, null, "contato", "❤️")).toBe(MSG_A);
    expect(reagir(ORG_A, MSG_A, null, "empresa", "🙏")).toBe(MSG_A);
    const m = metadataDe(MSG_A);
    const r = m.reacoes as Record<string, { emoji: string }>;
    expect(r.contato?.emoji).toBe("❤️");
    expect(r.empresa?.emoji).toBe("🙏");
    expect(m.outra).toBe("chave");

    // Remover grava a MARCA (emoji vazio + horário), não apaga a chave: é o
    // horário que impede uma reação atrasada de ressuscitar a removida.
    expect(reagir(ORG_A, MSG_A, null, "contato", "")).toBe(MSG_A);
    const depois = metadataDe(MSG_A).reacoes as Record<string, { emoji: string }>;
    expect(depois.contato?.emoji).toBe("");
    expect(depois.empresa?.emoji).toBe("🙏");
  });

  it("reação mais VELHA que a gravada não vale (reentrega, ordem invertida)", () => {
    expect(reagir(ORG_A, MSG_A, null, "empresa", "🔥", "now() + interval '1 hour'")).toBe(MSG_A);
    expect(reagir(ORG_A, MSG_A, null, "empresa", "😢", "now() - interval '1 day'")).toBe("NULO");
    const r = metadataDe(MSG_A).reacoes as Record<string, { emoji: string }>;
    expect(r.empresa?.emoji).toBe("🔥");
  });

  it("fn_mesclar_metadata_da_mensagem acrescenta sem apagar a reação; não cruza org", () => {
    expect(
      ultima(
        sql(
          `select public.fn_mesclar_metadata_da_mensagem('${ORG_A}', '${MSG_A}', '{"media_status":"stored"}')::text;`,
        ),
      ),
    ).toBe("true");
    const m = metadataDe(MSG_A);
    expect(m.media_status).toBe("stored");
    expect((m.reacoes as Record<string, { emoji: string }>).empresa?.emoji).toBe("🔥");
    expect(
      ultima(
        sql(
          `select public.fn_mesclar_metadata_da_mensagem('${ORG_A}', '${MSG_B}', '{"x":1}')::text;`,
        ),
      ),
    ).toBe("false");
    expect(metadataDe(MSG_B).x).toBeUndefined();
  });

  it("fn_nomes_dos_usuarios: nome cadastrado, senão o início do e-mail", () => {
    sql(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${USER_COM_NOME}', 'daniel-0276@invariant.test', '{"full_name":"Daniel Souza"}'),
        ('${USER_SEM_NOME}', 'luana.0276@invariant.test', '{}')
        on conflict (id) do nothing;`);
    const saida = sql(
      `select user_id || '=' || coalesce(nome, 'NULO') from public.fn_nomes_dos_usuarios(array['${USER_COM_NOME}', '${USER_SEM_NOME}']::uuid[]) order by nome;`,
    );
    expect(saida.split("\n").map((l) => l.trim())).toEqual([
      `${USER_COM_NOME}=Daniel Souza`,
      `${USER_SEM_NOME}=luana.0276`,
    ]);
  });

  it("não cruza organização: alvo de outra org devolve NULO e fica intocado", () => {
    expect(reagir(ORG_A, MSG_B, null, "empresa", "👍")).toBe("NULO");
    expect(reagir(ORG_A, null, "wamid.inv0276.B", "contato", "👍")).toBe("NULO");
    expect(metadataDe(MSG_B).reacoes).toBeUndefined();
  });

  it("lado fora do vocabulário é recusado", () => {
    let erro = "";
    try {
      reagir(ORG_A, MSG_A, null, "atendente", "👍");
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro).toMatch(/lado_invalido/);
  });

  it.each([
    FN,
    "public.fn_mesclar_metadata_da_mensagem(uuid, uuid, jsonb)",
    "public.fn_nomes_dos_usuarios(uuid[])",
  ])("%s: fechada a anon e authenticated; aberta ao service_role", (fn) => {
    const priv = (papel: string) =>
      ultima(sql(`select has_function_privilege('${papel}', '${fn}', 'execute')::text;`));
    expect(priv("anon")).toBe("false");
    expect(priv("authenticated")).toBe("false");
    expect(priv("service_role")).toBe("true");
  });
});
