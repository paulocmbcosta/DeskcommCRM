import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * CHAMAR DE NOVO um cliente cujo atendimento já foi ENCERRADO — o contrato do
 * banco de que a tela depende.
 *
 * ## Por que este arquivo existe, se nada no banco mudou
 *
 * Relato de 2026-10-05: uma atendente chamou um cliente em 25/09, encerrou, e em
 * 01/10 quis chamá-lo de novo; o contato de 01/10 saiu com o protocolo de 25/09.
 * A primeira suspeita foi o banco, e ela estava ERRADA — este arquivo nasceu
 * para medi-la e ficou verde na primeira corrida: o servidor já fazia o certo.
 * O defeito era de tela (`lib/atendimento/conversa-do-contato.ts`): com a
 * conversa existindo, nenhuma tela oferecia "Chamar no WhatsApp", e a pessoa
 * ia parar no atendimento encerrado, onde "Reabrir" e o seletor de modelo
 * escrevem no protocolo antigo.
 *
 * O conserto foi levar a tela até aqui. Então a promessa que a tela faz agora —
 * "abre um atendimento novo, com protocolo próprio" — é cumprida por três peças
 * do banco que ninguém tocou, e que nenhum teste media JUNTAS:
 *
 *   - `fn_service_begin` tira a conversa do estado encerrado;
 *   - `fn_service_stamp_status` (BEFORE) solta o dono do atendimento anterior —
 *     sem isso, quem chama seria recusado com "já está em atendimento com
 *     Fulana", por causa de um atendimento que acabou (em produção, 502 das 735
 *     conversas encerradas guardavam o dono);
 *   - `fn_atendimento_acompanha_conversa` (AFTER) abre o atendimento novo, e
 *     `fn_conversation_iniciar_no_time` entrega time e dono a quem chamou.
 *
 * Mexer em qualquer uma delas quebra a promessa em silêncio: a tela continua
 * dizendo "atendimento novo" e o protocolo continua o antigo.
 *
 * Cada caso percorre o caminho real de `POST /conversations/iniciar`:
 * `fn_service_begin` como service role e, em outra transação,
 * `fn_conversation_iniciar_no_time` como `authenticated` com o JWT de quem
 * clicou.
 */

const ORG = "7e7edeb0-0000-4000-8000-000000000001";
const ANA = "7e7edeb0-1111-4000-8000-00000000000a";
const CARLA = "7e7edeb0-1111-4000-8000-00000000000c";
const SESSION = "7e7edeb0-2222-4000-8000-000000000001";
const SUPORTE = "7e7edeb0-3333-4000-8000-000000000001";
const VENDAS = "7e7edeb0-3333-4000-8000-000000000002";
const contato = (n: number) => `7e7edeb0-4444-4000-8000-00000000000${n}`;

const containerName = process.env.TEST_DB_CONTAINER as string;

/** A segunda metade do gesto: a função como o PostgREST a chama. */
function iniciarComo(user: string, conv: string, team: string) {
  try {
    const out = execFileSync(
      "docker",
      ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      {
        input: `set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${user}"}', false);
          select public.fn_conversation_iniciar_no_time('${ORG}', '${conv}', '${team}');`,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return { ok: true as const, data: JSON.parse(lastLine(out.trim())) as Record<string, unknown>, erro: "" };
  } catch (err) {
    return { ok: false as const, data: null, erro: String((err as { stderr?: string }).stderr ?? err) };
  }
}

/** A primeira metade do gesto: abre (ou reabre) a conversa, como a rota faz. */
function abrir(n: number): string {
  const out = sql(`select public.fn_service_begin('${ORG}', '${contato(n)}', '${SESSION}') ->> 'conversation_id';`);
  return lastLine(out.trim());
}

/** O gesto inteiro de "Chamar no WhatsApp". */
function chamar(user: string, n: number, team: string) {
  const conv = abrir(n);
  return { conv, ...iniciarComo(user, conv, team) };
}

function fechar(conv: string, por: string) {
  sql(`select public.fn_service_status_com_ator('${ORG}', '${conv}', 'closed', null, '${por}', false);`);
}

/** O botão "Reabrir": continua o MESMO atendimento. */
function reabrir(conv: string, por: string) {
  sql(`select public.fn_service_status_com_ator('${ORG}', '${conv}', 'open', null, '${por}', true);`);
}

function linha(conv: string) {
  const out = sql(`select json_build_object(
      'status', status, 'team_id', team_id, 'dono', assigned_to_user_id,
      'silenciada', coalesce(bot_silenced_until = 'infinity', false), 'protocolo', protocol)
    from public.conversations where id = '${conv}';`);
  return JSON.parse(lastLine(out.trim())) as {
    status: string;
    team_id: string | null;
    dono: string | null;
    silenciada: boolean;
    protocolo: string | null;
  };
}

function atendimentos(conv: string) {
  const out = sql(`select coalesce(json_agg(json_build_object('protocolo', protocol, 'aberto', closed_at is null)
                                            order by started_at), '[]'::json)
    from public.atendimentos where conversation_id = '${conv}';`);
  return JSON.parse(lastLine(out.trim())) as Array<{ protocolo: string; aberto: boolean }>;
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ANA}', 'ana-de-novo@invariant.test', '{"full_name":"Ana Suporte"}'),
      ('${CARLA}', 'carla-de-novo@invariant.test', '{"full_name":"Carla Vendas"}');
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'chamar-de-novo', 'Chamar De Novo Org', 'Chamar De Novo');
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ANA}', '${ORG}', 'agent', now()),
      ('${CARLA}', '${ORG}', 'agent', now());
    do $ct$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSION}', '${ORG}', 'chamar-de-novo', '\\x00'::bytea);
    exception when unique_violation then null; end $ct$;
    insert into public.attendance_teams (id, organization_id, name, slug) values
      ('${SUPORTE}', '${ORG}', 'Suporte', 'suporte'),
      ('${VENDAS}', '${ORG}', 'Vendas', 'vendas');
    insert into public.attendance_team_members (organization_id, team_id, user_id) values
      ('${ORG}', '${SUPORTE}', '${ANA}'),
      ('${ORG}', '${VENDAS}', '${CARLA}');
    insert into public.contacts (id, organization_id, display_name) values
      ${[1, 2, 3, 4].map((n) => `('${contato(n)}', '${ORG}', 'Contato ${n}')`).join(",\n      ")};
  `);
});

describe("chamar de novo um cliente com o atendimento ENCERRADO", () => {
  it("outra pessoa chama: nasce atendimento novo, com protocolo novo, e ela fica dona", () => {
    const primeira = chamar(CARLA, 1, VENDAS);
    expect(primeira.erro).toBe("");
    const protocoloAntigo = linha(primeira.conv).protocolo;
    fechar(primeira.conv, CARLA);
    // O estado que a produção tinha em 502 conversas: encerrada, com dono gravado.
    expect(linha(primeira.conv)).toMatchObject({ status: "closed", dono: CARLA });

    const segunda = chamar(ANA, 1, SUPORTE);

    expect(segunda.erro, "o dono de um atendimento ENCERRADO barrou quem chamou").toBe("");
    expect(segunda.conv).toBe(primeira.conv);
    expect(linha(segunda.conv)).toMatchObject({
      status: "claimed",
      team_id: SUPORTE,
      dono: ANA,
      silenciada: true,
    });
    const lista = atendimentos(segunda.conv);
    expect(lista.map((a) => a.aberto)).toEqual([false, true]);
    expect(lista[1]!.protocolo).not.toBe(protocoloAntigo);
    expect(linha(segunda.conv).protocolo).toBe(lista[1]!.protocolo);
    // O histórico não se perde: o atendimento encerrado guarda quem o atendeu.
    const antigo = sql(`select assigned_to_user_id from public.atendimentos
                         where conversation_id = '${segunda.conv}' and closed_at is not null;`);
    expect(lastLine(antigo.trim())).toBe(CARLA);
  });

  it("a mesma pessoa chama de novo: assume como na primeira vez — `claimed`, automático calado", () => {
    const primeira = chamar(CARLA, 2, VENDAS);
    expect(primeira.erro).toBe("");
    fechar(primeira.conv, CARLA);
    // Encerrar solta o automático (não houve passagem para pessoa).
    expect(linha(primeira.conv).silenciada).toBe(false);

    const segunda = chamar(CARLA, 2, VENDAS);

    expect(segunda.erro).toBe("");
    expect(linha(segunda.conv), "voltou `open` com o automático solto, em nome de quem chamou").toMatchObject({
      status: "claimed",
      team_id: VENDAS,
      dono: CARLA,
      silenciada: true,
    });
    expect(atendimentos(segunda.conv).map((a) => a.aberto)).toEqual([false, true]);
  });
});

describe("o que NÃO é atendimento novo", () => {
  it("cliente EM ATENDIMENTO com outra pessoa continua recusado, com o nome dela, e nada muda", () => {
    const dela = chamar(CARLA, 3, VENDAS);
    expect(dela.erro).toBe("");

    const tentativa = chamar(ANA, 3, SUPORTE);

    expect(tentativa.ok).toBe(false);
    expect(tentativa.erro).toContain("conversation_owned");
    expect(tentativa.erro).toContain("Carla Vendas");
    expect(linha(dela.conv)).toMatchObject({ status: "claimed", team_id: VENDAS, dono: CARLA });
    expect(atendimentos(dela.conv)).toHaveLength(1);
  });

  it("'Reabrir' é OUTRO gesto: continua o mesmo atendimento, com o mesmo protocolo", () => {
    // O contraste que dá sentido aos casos de cima. Foi por "Reabrir" que o
    // contato de 01/10 ficou com o protocolo de 25/09: era o que a tela oferecia.
    const dela = chamar(CARLA, 4, VENDAS);
    expect(dela.erro).toBe("");
    const protocolo = linha(dela.conv).protocolo;
    fechar(dela.conv, CARLA);

    reabrir(dela.conv, CARLA);

    expect(atendimentos(dela.conv)).toEqual([{ protocolo, aberto: true }]);
    expect(linha(dela.conv).protocolo).toBe(protocolo);
  });
});
