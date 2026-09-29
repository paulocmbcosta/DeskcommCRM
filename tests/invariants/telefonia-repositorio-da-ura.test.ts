/**
 * O SQL DO WORKER DA URA CONTRA POSTGRES REAL (migration 0288).
 *
 * O controlador (`controle.ts`) é provado com um banco de mentira; aqui se prova o
 * outro lado — que cada consulta do repositório (lib/channels/telefonia/repositorio.ts)
 * devolve, no schema de verdade, o que o controlador espera. Sempre com DUAS
 * organizações: o worker usa `pg.Pool` FORA da RLS, e a única catraca é o
 * `organization_id` que cada consulta filtra à mão.
 *
 *  1. "fora do horário" separado de "ninguém disponível" (`situacaoDoTime`), sem
 *     mudar o que `disponiveisNoTime` devolve aos chamadores da fase 1;
 *  2. menu, falas gerais e aviso só voltam PRONTOS e da organização pedida; o
 *     aviso só toca com o time ATIVO e o aviso VIGENTE (`avisoVigente`), sem
 *     depender da passada;
 *  3. a passada desliga só o vencido — também o do time ARQUIVADO —, audita e
 *     avisa na Central uma vez, em cada organização; pula a linha que um gerente
 *     segura (skip locked) e, travando em `for no key update`, não faz a LIGAÇÃO
 *     esperar (o CONTROLE com `for update` mostra a ligação caindo no lock_timeout);
 *  4. a ligação guarda o que a URA fez (menu, tecla, desfecho, time, aviso ouvido),
 *     com toda escrita presa à organização, e o cartão da conversa o mostra;
 *  5. o aviso de fala intocável não se repete enquanto o anterior está aberto.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import * as repo from "@/lib/channels/telefonia/repositorio";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de0289-0000-4000-8000-00000000000a";
const OUTRA = "c0de0289-0000-4000-8000-00000000000b";
const ANA = "c0de0289-1111-4000-8000-000000000001";
const BRUNO = "c0de0289-1111-4000-8000-000000000002";
const ABERTO = "c0de0289-2222-4000-8000-000000000001";
const FECHADO = "c0de0289-2222-4000-8000-000000000002";
const ARQUIVADO = "c0de0289-2222-4000-8000-000000000003";
const TIME_OUTRA = "c0de0289-2222-4000-8000-000000000004";
const AGENDA_RUIM = "c0de0289-2222-4000-8000-000000000005";
const PRONTA = "c0de0289-3333-4000-8000-000000000001";
const FALHOU = "c0de0289-3333-4000-8000-000000000002";
const AVISO = "c0de0289-3333-4000-8000-000000000003";
const NINGUEM = "c0de0289-3333-4000-8000-000000000004";
const INVALIDA_FALHOU = "c0de0289-3333-4000-8000-000000000005";
const AVISO_OUTRA = "c0de0289-3333-4000-8000-000000000006";
const PRONTA_OUTRA = "c0de0289-3333-4000-8000-000000000007";
const MENU = "c0de0289-4444-4000-8000-000000000001";
const MENU_ARQUIVADO = "c0de0289-4444-4000-8000-000000000002";
const MENU_OUTRA = "c0de0289-4444-4000-8000-000000000003";
const NUMERO = "c0de0289-5555-4000-8000-000000000001";
const NUMERO_OUTRA = "c0de0289-5555-4000-8000-000000000002";
/** Segunda-feira, 10h em Brasília. */
const AGORA = new Date("2026-09-28T13:00:00Z");
const HORA = 3_600_000;
const hash = (c: string) => c.repeat(64);
const caminho = (org: string, c: string) => `${org}/${hash(c)}.ulaw`;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  // A chave de cifra do banco efêmero (a senha do tronco precisa decifrar para
  // `troncoPorId` devolver o tronco). Valor de teste, não é segredo; o banco é
  // uma cópia só deste arquivo (tests/db/banco-limpo-por-arquivo.ts).
  await pool.query(
    `insert into private.app_secrets (name, value)
     values ('nuvemshop_oauth_key', 'chave-de-teste-do-harness-0289-nao-e-segredo')
     on conflict (name) do nothing`,
  );
  await pool.query(
    `insert into auth.users (id, email) values
       ($1, 'ana-ura@invariant.test'), ($2, 'bruno-ura@invariant.test')
     on conflict (id) do nothing`,
    [ANA, BRUNO],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'ura-repo-a', 'URA repo A', 'URA repo A'), ($2, 'ura-repo-b', 'URA repo B', 'URA repo B')
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
    `insert into public.attendance_teams (id, organization_id, name, slug, schedule, archived_at) values
       ($1, $6, 'Suporte', 'suporte', '{}'::jsonb, null),
       ($2, $6, 'Financeiro', 'financeiro',
        '{"timezone":"America/Sao_Paulo","windows":[{"dow":0,"start":"08:00","end":"09:00"}]}'::jsonb, null),
       ($3, $6, 'Antigo', 'antigo', '{}'::jsonb, now()),
       ($4, $7, 'Suporte B', 'suporte', '{}'::jsonb, null),
       ($5, $6, 'Agenda ruim', 'agenda-ruim',
        '{"timezone":"America/Asunción","windows":[{"dow":1,"start":"00:00","end":"23:59"}]}'::jsonb, null)
     on conflict (id) do nothing`,
    [ABERTO, FECHADO, ARQUIVADO, TIME_OUTRA, AGENDA_RUIM, ORG, OUTRA],
  );
  // Ana está no Suporte e no Financeiro de A, disponível; Bruno no Suporte de B.
  await pool.query(
    `insert into public.attendance_team_members (organization_id, team_id, user_id) values
       ($1, $3, $5), ($1, $4, $5), ($2, $6, $7)
     on conflict do nothing`,
    [ORG, OUTRA, ABERTO, FECHADO, ANA, TIME_OUTRA, BRUNO],
  );
  await pool.query(
    `insert into public.attendant_availability (organization_id, user_id, is_available, capacity, schedule) values
       ($1, $3, true, 5, '{}'), ($2, $4, true, 5, '{}')
     on conflict (organization_id, user_id) do update set is_available = true, schedule = '{}'`,
    [ORG, OUTRA, ANA, BRUNO],
  );
  await pool.query(
    `insert into public.phone_prompts
       (id, organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status, error)
     values
       ($1, $8, 'menu', 'Para Suporte, digite 1.', 'v', 'm', $10, $15, 1500, 'ready', null),
       ($2, $8, 'waiting', 'Aguarde.', 'v', 'm', $11, null, null, 'failed', 'sem_credito'),
       ($3, $8, 'emergency', 'Instabilidade.', 'v', 'm', $12, $16, 2000, 'ready', null),
       ($4, $8, 'nobody', 'Ninguém pôde atender.', 'v', 'm', $13, $17, 1800, 'ready', null),
       ($5, $8, 'invalid', 'Opção inválida.', 'v', 'm', $14, null, null, 'failed', 'sem_credito'),
       ($6, $9, 'emergency', 'Instabilidade B.', 'v', 'm', $12, $18, 2000, 'ready', null),
       ($7, $9, 'menu', 'Menu B.', 'v', 'm', $10, $19, 1500, 'ready', null)
     on conflict (id) do nothing`,
    [
      PRONTA, FALHOU, AVISO, NINGUEM, INVALIDA_FALHOU, AVISO_OUTRA, PRONTA_OUTRA, ORG, OUTRA,
      hash("a"), hash("b"), hash("c"), hash("d"), hash("e"),
      caminho(ORG, "a"), caminho(ORG, "c"), caminho(ORG, "d"), caminho(OUTRA, "c"), caminho(OUTRA, "a"),
    ],
  );
  await pool.query(
    `insert into public.phone_settings (organization_id, voice_id, waiting_prompt_id, nobody_prompt_id)
     values ($1, 'v', $2, $3) on conflict (organization_id) do nothing`,
    [ORG, FALHOU, NINGUEM],
  );
  await pool.query(
    `insert into public.phone_menus (id, organization_id, name, prompt_id, invalid_prompt_id, default_team_id, archived_at) values
       ($1, $4, 'Principal', $6, $7, $8, null),
       ($2, $4, 'Velho', $6, null, $8, now()),
       ($3, $5, 'Menu B', $9, null, $10, null)
     on conflict (id) do nothing`,
    [MENU, MENU_ARQUIVADO, MENU_OUTRA, ORG, OUTRA, PRONTA, INVALIDA_FALHOU, ABERTO, PRONTA_OUTRA, TIME_OUTRA],
  );
  await pool.query(
    `insert into public.phone_menu_options (organization_id, menu_id, digit, team_id) values
       ($1, $2, '1', $3), ($1, $2, '2', $4), ($1, $2, '3', $5)
     on conflict do nothing`,
    [ORG, MENU, ABERTO, FECHADO, ARQUIVADO],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_menu_id, sip_team_id)
     values
       ($1, $3, 'sip_trunk', '\\x00', 'STARTING', 'URA repo', '+556130000289',
        'voip.exemplo-0289.com.br', 5060, 'udp', 'u0289', public.fn_encrypt_oauth('senha-de-teste-0289'), $5, null),
       ($2, $4, 'sip_trunk', '\\x00', 'STARTING', 'URA repo B', '+556130000290',
        'voip.exemplo-0290.com.br', 5060, 'udp', 'u0290', public.fn_encrypt_oauth('senha-de-teste-0290'), null, $6)
     on conflict (id) do nothing`,
    [NUMERO, NUMERO_OUTRA, ORG, OUTRA, MENU, TIME_OUTRA],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("situação do time — 'fora do horário' separado de 'ninguém disponível'", () => {
  it("aberto, fora do horário, arquivado, agenda ilegível e de outra organização", async () => {
    expect(await repo.situacaoDoTime(pool, ORG, ABERTO, AGORA)).toBe("aberto");
    expect(await repo.situacaoDoTime(pool, ORG, FECHADO, AGORA)).toBe("fora_do_horario");
    expect(await repo.situacaoDoTime(pool, ORG, ARQUIVADO, AGORA)).toBe("indisponivel");
    // Agenda que o parser não lê NÃO é "fora do horário": a ligação segue a fila e vira "Ligar de volta".
    expect(await repo.situacaoDoTime(pool, ORG, AGENDA_RUIM, AGORA)).toBe("indisponivel");
    // O time de B visto de A não existe; visto de B, está aberto.
    expect(await repo.situacaoDoTime(pool, ORG, TIME_OUTRA, AGORA)).toBe("indisponivel");
    expect(await repo.situacaoDoTime(pool, OUTRA, TIME_OUTRA, AGORA)).toBe("aberto");
  });

  it("as duas perguntas agora se distinguem; disponiveisNoTime segue igual para os chamadores da fase 1", async () => {
    // Ana está nos dois times e disponível: o Suporte (aberto) a devolve...
    expect((await repo.disponiveisNoTime(pool, ORG, ABERTO, AGORA)).map((c) => c.userId)).toEqual([ANA]);
    // ...o Financeiro, fora do horário, devolve a MESMA lista vazia de antes — e a situação diz por quê.
    expect(await repo.disponiveisNoTime(pool, ORG, FECHADO, AGORA)).toEqual([]);
    expect(await repo.situacaoDoTime(pool, ORG, FECHADO, AGORA)).toBe("fora_do_horario");

    // "Ninguém disponível": time aberto, Ana em pausa.
    await pool.query("update attendant_availability set is_available = false where organization_id = $1 and user_id = $2", [ORG, ANA]);
    try {
      expect(await repo.disponiveisNoTime(pool, ORG, ABERTO, AGORA)).toEqual([]);
      expect(await repo.situacaoDoTime(pool, ORG, ABERTO, AGORA)).toBe("aberto");
    } finally {
      await pool.query("update attendant_availability set is_available = true where organization_id = $1 and user_id = $2", [ORG, ANA]);
    }

    // Duas organizações: o Bruno só aparece em B; A não enxerga o time de B.
    expect((await repo.disponiveisNoTime(pool, OUTRA, TIME_OUTRA, AGORA)).map((c) => c.userId)).toEqual([BRUNO]);
    expect(await repo.disponiveisNoTime(pool, ORG, TIME_OUTRA, AGORA)).toEqual([]);
  });
});

describe("menuPorId e o menu do número", () => {
  it("só a fala pronta (a de tecla inválida 'failed' volta nula), e só as opções de times não arquivados", async () => {
    const menu = await repo.menuPorId(pool, ORG, MENU);
    expect(menu).toEqual({
      id: MENU,
      nome: "Principal",
      defaultTeamId: ABERTO,
      fala: { id: PRONTA, storagePath: caminho(ORG, "a") },
      falaInvalida: null,
      opcoes: [
        { digito: "1", teamId: ABERTO },
        { digito: "2", teamId: FECHADO },
      ],
    });
  });

  it("menu de outra organização ou arquivado → null", async () => {
    expect(await repo.menuPorId(pool, OUTRA, MENU)).toBeNull();
    expect(await repo.menuPorId(pool, ORG, MENU_OUTRA)).toBeNull();
    expect(await repo.menuPorId(pool, ORG, MENU_ARQUIVADO)).toBeNull();
    expect((await repo.menuPorId(pool, OUTRA, MENU_OUTRA))?.fala).toEqual({ id: PRONTA_OUTRA, storagePath: caminho(OUTRA, "a") });
  });

  it("o tronco carrega o menu do número (e o de time, nenhum)", async () => {
    expect((await repo.troncoPorId(pool, NUMERO))?.menuId).toBe(MENU);
    const b = await repo.troncoPorId(pool, NUMERO_OUTRA);
    expect(b).toMatchObject({ organizationId: OUTRA, teamId: TIME_OUTRA, menuId: null });
  });
});

describe("falas gerais e aviso do time", () => {
  beforeEach(async () => {
    await pool.query(
      `update public.attendance_teams
          set phone_emergency_prompt_id = null, phone_emergency_active_since = null,
              phone_emergency_expires_at = null, phone_emergency_activated_by = null
        where organization_id in ($1, $2)`,
      [ORG, OUTRA],
    );
  });

  const ligarAviso = (teamId: string, prompt: string, desde: Date, expira: Date | null) =>
    pool.query(
      `update public.attendance_teams
          set phone_emergency_prompt_id = $2, phone_emergency_active_since = $3, phone_emergency_expires_at = $4
        where id = $1`,
      [teamId, prompt, desde, expira],
    );

  it("fala 'failed' não toca: só a pronta volta; e cada organização só vê as suas", async () => {
    expect(await repo.falasGerais(pool, ORG)).toEqual({
      aguarde: null,
      ninguem: { id: NINGUEM, storagePath: caminho(ORG, "d") },
      foraDoHorario: null,
    });
    expect(await repo.falasGerais(pool, OUTRA)).toEqual({ aguarde: null, ninguem: null, foraDoHorario: null });
  });

  it("o aviso toca enquanto vigente e para no instante em que vence — sem depender da passada", async () => {
    await ligarAviso(ABERTO, AVISO, new Date(AGORA.getTime() - HORA), new Date(AGORA.getTime() + HORA));
    expect(await repo.emergenciaDoTime(pool, ORG, ABERTO, AGORA)).toEqual({ id: AVISO, storagePath: caminho(ORG, "c") });
    // Vence exatamente em AGORA + 1 h: nesse instante já não toca (`avisoVigente`: expires_at > agora).
    expect(await repo.emergenciaDoTime(pool, ORG, ABERTO, new Date(AGORA.getTime() + HORA))).toBeNull();
    expect(await repo.emergenciaDoTime(pool, ORG, ABERTO, new Date(AGORA.getTime() + 2 * HORA))).toBeNull();
    // A organização de fora não ouve o aviso do time de A.
    expect(await repo.emergenciaDoTime(pool, OUTRA, ABERTO, AGORA)).toBeNull();
  });

  it("'até alguém desligar' toca sempre; o do time ARQUIVADO nunca toca, mesmo vigente", async () => {
    await ligarAviso(FECHADO, AVISO, new Date(AGORA.getTime() - HORA), null);
    expect(await repo.emergenciaDoTime(pool, ORG, FECHADO, new Date(AGORA.getTime() + 48 * HORA))).toEqual({
      id: AVISO,
      storagePath: caminho(ORG, "c"),
    });
    await ligarAviso(ARQUIVADO, AVISO, new Date(AGORA.getTime() - HORA), null);
    expect(await repo.emergenciaDoTime(pool, ORG, ARQUIVADO, AGORA)).toBeNull();
  });
});

describe("a passada dos avisos vencidos", () => {
  const depois = new Date(AGORA.getTime() + 2 * HORA);

  beforeEach(async () => {
    await pool.query(
      `update public.attendance_teams
          set phone_emergency_prompt_id = null, phone_emergency_active_since = null,
              phone_emergency_expires_at = null, phone_emergency_activated_by = null
        where organization_id in ($1, $2)`,
      [ORG, OUTRA],
    );
    // Vencem em AGORA + 1 h: o Suporte de A, o ARQUIVADO de A e o Suporte de B.
    // Ficam: o Financeiro de A ("até alguém desligar") e o "Agenda ruim" (vence em AGORA + 3 h).
    for (const [teamId, prompt, expira] of [
      [ABERTO, AVISO, AGORA.getTime() + HORA],
      [ARQUIVADO, AVISO, AGORA.getTime() + HORA],
      [TIME_OUTRA, AVISO_OUTRA, AGORA.getTime() + HORA],
      [FECHADO, AVISO, null],
      [AGENDA_RUIM, AVISO, AGORA.getTime() + 3 * HORA],
    ] as const) {
      await pool.query(
        `update public.attendance_teams
            set phone_emergency_prompt_id = $2, phone_emergency_active_since = $3,
                phone_emergency_expires_at = $4, phone_emergency_activated_by = $5
          where id = $1`,
        [teamId, prompt, new Date(AGORA.getTime() - HORA), expira === null ? null : new Date(expira), teamId === TIME_OUTRA ? BRUNO : ANA],
      );
    }
  });

  const ligados = async () =>
    (
      await pool.query<{ id: string }>(
        `select id from public.attendance_teams
          where organization_id in ($1, $2) and phone_emergency_active_since is not null order by id`,
        [ORG, OUTRA],
      )
    ).rows.map((r) => r.id);
  /** As auditorias de vencimento do time, da mais velha para a mais nova (o estado vale para o arquivo inteiro: conte deltas). */
  const auditorias = async (teamId: string) =>
    (
      await pool.query<{ organization_id: string; metadata: Record<string, unknown>; actor_user_id: string | null }>(
        `select organization_id, metadata, actor_user_id from public.api_audit_log
          where action = 'phone.emergency_expired' and resource_type = 'attendance_team' and resource_id = $1
          order by created_at, id`,
        [teamId],
      )
    ).rows;
  const avisos = async (org: string) =>
    (
      await pool.query<{ title: string; ref_kind: string | null; ref_id: string | null; severity: string }>(
        "select title, ref_kind, ref_id, severity from public.agent_inbox_items where organization_id = $1 and kind = 'phone_emergency_expired'",
        [org],
      )
    ).rows;

  it("desliga só o vencido — nas duas organizações, também o do time arquivado —, audita e avisa na Central, uma vez", async () => {
    const antesA = (await avisos(ORG)).length;
    const antesB = (await avisos(OUTRA)).length;
    const auditadosAntes = new Map<string, number>();
    for (const t of [ABERTO, ARQUIVADO, TIME_OUTRA, FECHADO]) auditadosAntes.set(t, (await auditorias(t)).length);

    const desligados = await repo.desligarAvisosVencidos(pool, depois);
    expect(desligados.map((d) => d.id).sort()).toEqual([ABERTO, ARQUIVADO, TIME_OUTRA].sort());
    expect(desligados.find((d) => d.id === TIME_OUTRA)).toEqual({ id: TIME_OUTRA, organizationId: OUTRA, nome: "Suporte B" });

    expect(await ligados()).toEqual([FECHADO, AGENDA_RUIM].sort());
    // O texto do aviso fica no time: religar começa dele.
    const { rows: texto } = await pool.query<{ fala: string | null; por: string | null }>(
      "select phone_emergency_prompt_id as fala, phone_emergency_activated_by as por from public.attendance_teams where id = $1",
      [ABERTO],
    );
    expect(texto[0]).toEqual({ fala: AVISO, por: null });

    // Auditoria na organização CERTA de cada time, sem ator, com o período que venceu.
    for (const [teamId, org, quem] of [
      [ABERTO, ORG, ANA],
      [ARQUIVADO, ORG, ANA],
      [TIME_OUTRA, OUTRA, BRUNO],
    ] as const) {
      const a = await auditorias(teamId);
      expect(a).toHaveLength(auditadosAntes.get(teamId)! + 1);
      const nova = a.at(-1)!;
      expect(nova.organization_id).toBe(org);
      expect(nova.actor_user_id).toBeNull();
      expect(nova.metadata).toMatchObject({ ligado_por: quem });
      expect(new Date(nova.metadata.expirou_em as string).getTime()).toBe(AGORA.getTime() + HORA);
    }
    expect(await auditorias(FECHADO)).toHaveLength(auditadosAntes.get(FECHADO)!);

    // Um item na Central por aviso desligado, na organização dele, sem referência (o destino é geral).
    expect((await avisos(ORG)).length - antesA).toBe(2);
    expect((await avisos(OUTRA)).length - antesB).toBe(1);
    expect((await avisos(OUTRA)).at(-1)).toMatchObject({ ref_kind: null, ref_id: null, severity: "info" });

    // A segunda passada não acha mais nada: nada duplica.
    expect(await repo.desligarAvisosVencidos(pool, depois)).toEqual([]);
    expect(await auditorias(ABERTO)).toHaveLength(auditadosAntes.get(ABERTO)! + 1);
    expect((await avisos(ORG)).length - antesA).toBe(2);
  });

  it("a linha que um gerente segura é PULADA (skip locked), sem esperar; a passada seguinte a desliga", async () => {
    const auditadoAntes = (await auditorias(ABERTO)).length;
    const gerente = await pool.connect();
    try {
      await gerente.query("begin");
      await gerente.query("select 1 from public.attendance_teams where id = $1 for no key update", [ABERTO]);
      const inicio = Date.now();
      const desligados = await repo.desligarAvisosVencidos(pool, depois);
      expect(Date.now() - inicio).toBeLessThan(1_500);
      expect(desligados.map((d) => d.id)).not.toContain(ABERTO);
      expect(desligados.map((d) => d.id)).toContain(TIME_OUTRA);
      expect(await ligados()).toContain(ABERTO);
    } finally {
      await gerente.query("rollback");
      gerente.release();
    }
    expect((await repo.desligarAvisosVencidos(pool, depois)).map((d) => d.id)).toEqual([ABERTO]);
    expect(await auditorias(ABERTO)).toHaveLength(auditadoAntes + 1);
  });

  /**
   * A ligação que entra na fila do time: INSERT em voice_calls com `team_id` (a FK
   * confere o time em `key share`), com 1 s de prazo de trava — como o worker.
   */
  const inserirLigacao = async (teamId: string): Promise<string> => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local lock_timeout = '1s'");
      await c.query(
        `insert into voice_calls (organization_id, channel_session_id, provider, sip_call_ref, direction, peer_phone, status, team_id)
         values ($1, $2, 'sip_trunk', 'passada-' || gen_random_uuid(), 'inbound', '+5561999990001', 'ringing', $3)`,
        [ORG, NUMERO, teamId],
      );
      await c.query("rollback");
      return "entrou";
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      return (e as { code?: string }).code ?? "erro";
    } finally {
      c.release();
    }
  };

  for (const [nome, trocar, esperado] of [
    ["for no key update: a ligação entra na hora, com a passada ainda aberta", (t: string) => t, "entrou"],
    [
      "CONTROLE — com for update, a mesma ligação cai no lock_timeout (o teste enxerga o defeito que diz prender)",
      (t: string) => t.replace(/for no key update/gi, "for update"),
      "55P03",
    ],
  ] as const) {
    it(nome, async () => {
      const passada = await pool.connect();
      try {
        await passada.query("begin");
        const db: Queryable = { query: ((t: string, v?: unknown[]) => passada.query(trocar(t), v)) as Queryable["query"] };
        const desligados = await repo.desligarAvisosVencidos(db, depois);
        expect(desligados.map((d) => d.id)).toContain(ABERTO);
        const inicio = Date.now();
        expect(await inserirLigacao(ABERTO)).toBe(esperado);
        if (esperado === "entrou") expect(Date.now() - inicio).toBeLessThan(900);
      } finally {
        await passada.query("rollback");
        passada.release();
      }
    });
  }

  it("o SQL da passada trava em 'for no key update skip locked' — nunca 'for update'", async () => {
    const textos: string[] = [];
    const espiao: Queryable = {
      query: ((t: string, v?: unknown[]) => {
        textos.push(t);
        return pool.query(t, v);
      }) as Queryable["query"],
    };
    await repo.desligarAvisosVencidos(espiao, AGORA);
    const sqlDaPassada = textos.join("\n").replace(/\s+/g, " ");
    expect(sqlDaPassada).toMatch(/for no key update skip locked/i);
    expect(sqlDaPassada).not.toMatch(/for update/i);
  });
});

describe("aviso de fala intocável na Central", () => {
  const abertos = async (org: string) =>
    (
      await pool.query<{ n: number }>(
        "select count(*)::int as n from public.agent_inbox_items where organization_id = $1 and kind = 'phone_prompt_unplayable' and status = 'open'",
        [org],
      )
    ).rows[0]!.n;

  it("não se repete enquanto o anterior está aberto; em cada organização, o seu; resolvido, abre de novo", async () => {
    await repo.avisarFalaIntocavel(pool, ORG, "menu Principal");
    await repo.avisarFalaIntocavel(pool, ORG, "menu Principal");
    expect(await abertos(ORG)).toBe(1);

    // A outra organização tem o seu, mesmo com o mesmo rótulo.
    await repo.avisarFalaIntocavel(pool, OUTRA, "menu Principal");
    expect(await abertos(OUTRA)).toBe(1);
    expect(await abertos(ORG)).toBe(1);

    // Outra fala, outro aviso.
    await repo.avisarFalaIntocavel(pool, ORG, "aguarde");
    expect(await abertos(ORG)).toBe(2);

    // Resolvido o primeiro, a próxima falha da mesma fala abre de novo.
    await pool.query(
      "update public.agent_inbox_items set status = 'resolved' where organization_id = $1 and kind = 'phone_prompt_unplayable' and title like '%menu Principal'",
      [ORG],
    );
    await repo.avisarFalaIntocavel(pool, ORG, "menu Principal");
    expect(await abertos(ORG)).toBe(2);

    const { rows } = await pool.query<{ ref_kind: string | null; severity: string }>(
      "select ref_kind, severity from public.agent_inbox_items where organization_id = $1 and kind = 'phone_prompt_unplayable' limit 1",
      [ORG],
    );
    expect(rows[0]).toEqual({ ref_kind: null, severity: "warn" });
  });
});

describe("a ligação guarda o que a URA fez, e o cartão da conversa o mostra", () => {
  const ligacao = async (org: string, tronco: string, ref: string, teamId: string, menuId: string | null) => {
    const contato = await repo.acharOuCriarContato(pool, org, `+55619999${ref.replace(/\D/g, "").padStart(5, "0").slice(-5)}`, "Cliente URA");
    const conversa = await repo.acharOuCriarConversa(pool, org, contato, tronco, teamId);
    return repo.criarLigacao(pool, {
      organizationId: org,
      troncoId: tronco,
      sipCallRef: ref,
      direcao: "inbound",
      numeroDoOutroLado: "+5561999990289",
      contactId: contato,
      conversationId: conversa,
      teamId,
      status: "ringing",
      menuId,
    });
  };
  const naLinha = async (id: string) =>
    (
      await pool.query<{
        menu_id: string | null;
        menu_digit: string | null;
        menu_outcome: string | null;
        team_id: string | null;
        emergency_heard_at: Date | null;
      }>("select menu_id, menu_digit, menu_outcome, team_id, emergency_heard_at from voice_calls where id = $1", [id])
    ).rows[0]!;

  it("menu, tecla, desfecho, time escolhido e o aviso ouvido chegam ao metadado da mensagem", async () => {
    const id = await ligacao(ORG, NUMERO, "ura-repo-1", ABERTO, MENU);
    expect(await repo.registrarMenu(pool, ORG, id, { digito: "2", desfecho: "chosen" })).toBe(true);
    expect(await repo.definirTimeDaLigacao(pool, ORG, id, FECHADO)).toBe(true);
    expect(await repo.registrarAvisoOuvido(pool, ORG, id)).toBe(true);
    const primeiraVez = (await naLinha(id)).emergency_heard_at;
    // Ouvir de novo não move o instante da primeira vez.
    await esperar(20);
    await repo.registrarAvisoOuvido(pool, ORG, id);
    expect((await naLinha(id)).emergency_heard_at?.getTime()).toBe(primeiraVez?.getTime());

    const l = await repo.encerrarLigacao(pool, id, "cliente_desligou");
    expect(l).toMatchObject({ menu_id: MENU, menu_digit: "2", menu_outcome: "chosen", team_id: FECHADO, end_reason: "cliente_desligou" });
    await repo.registrarNaConversa(pool, l!, "perdida", null);

    const { rows } = await pool.query(
      "select metadata->'voice_call' as vc from public.messages where organization_id = $1 and external_id = $2",
      [ORG, `ligacao:${id}`],
    );
    expect(rows[0].vc).toMatchObject({
      menu: { desfecho: "chosen", tecla: "2", time_nome: "Financeiro" },
      ouviu_aviso: true,
      motivo: "cliente_desligou",
    });
    // As colunas novas também voltam em ligacaoPorId.
    expect(await repo.ligacaoPorId(pool, id)).toMatchObject({ menu_id: MENU, menu_outcome: "chosen", end_reason: "cliente_desligou" });
  });

  it("as escritas da URA ficam presas à organização: a de fora não mexe, o time de fora não entra", async () => {
    const id = await ligacao(ORG, NUMERO, "ura-repo-3", ABERTO, MENU);
    expect(await repo.registrarMenu(pool, OUTRA, id, { digito: "1", desfecho: "chosen" })).toBe(false);
    expect(await repo.definirTimeDaLigacao(pool, OUTRA, id, ABERTO)).toBe(false);
    expect(await repo.registrarAvisoOuvido(pool, OUTRA, id)).toBe(false);
    // O id da ligação é de A, o time é de B: o ponteiro não cruza.
    expect(await repo.definirTimeDaLigacao(pool, ORG, id, TIME_OUTRA)).toBe(false);
    expect(await naLinha(id)).toEqual({ menu_id: MENU, menu_digit: null, menu_outcome: null, team_id: ABERTO, emergency_heard_at: null });
    // A recuperação do worker (ligações vivas) enxerga o menu da ligação.
    expect((await repo.ligacoesVivas(pool)).find((v) => v.id === id)).toMatchObject({ menu_id: MENU, menu_outcome: null });

    // Sem tecla: o desfecho vai, a tecla fica nula.
    expect(await repo.registrarMenu(pool, ORG, id, { digito: null, desfecho: "default_no_input" })).toBe(true);
    expect(await naLinha(id)).toMatchObject({ menu_digit: null, menu_outcome: "default_no_input" });
  });

  it("o banco recusa a ligação de A com o menu de B (FK composta), e a de B com o menu de B entra", async () => {
    await expect(ligacao(ORG, NUMERO, "ura-repo-4", ABERTO, MENU_OUTRA)).rejects.toMatchObject({ code: "23503" });
    const id = await ligacao(OUTRA, NUMERO_OUTRA, "ura-repo-5", TIME_OUTRA, MENU_OUTRA);
    expect((await naLinha(id)).menu_id).toBe(MENU_OUTRA);
  });

  it("sem menu (número que aponta para time): a ligação nasce com menu_id nulo e o cartão sem 'menu'", async () => {
    const id = await ligacao(OUTRA, NUMERO_OUTRA, "ura-repo-6", TIME_OUTRA, null);
    const l = await repo.encerrarLigacao(pool, id, "ninguem_atendeu");
    await repo.registrarNaConversa(pool, l!, "perdida", null);
    const { rows } = await pool.query(
      "select body, metadata->'voice_call' as vc from public.messages where organization_id = $1 and external_id = $2",
      [OUTRA, `ligacao:${id}`],
    );
    expect(rows[0].body).toBe("Ligação recebida não atendida");
    expect(rows[0].vc).toMatchObject({ menu: null, ouviu_aviso: false, motivo: "ninguem_atendeu" });
  });

  it("fora do horário: o registro na conversa diz isso", async () => {
    const id = await ligacao(ORG, NUMERO, "ura-repo-2", FECHADO, null);
    const l = await repo.encerrarLigacao(pool, id, "after_hours");
    expect(l?.end_reason).toBe("after_hours");
    await repo.registrarNaConversa(pool, l!, "perdida", null);
    const { rows } = await pool.query(
      "select body from public.messages where organization_id = $1 and external_id = $2",
      [ORG, `ligacao:${id}`],
    );
    expect(rows[0].body).toBe("Ligação recebida fora do horário");
  });
});
