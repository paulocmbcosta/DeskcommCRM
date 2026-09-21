import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * `fn_ia_automatica_no_canal` — A PERGUNTA QUE O RODÍZIO FAZ ANTES DE DISTRIBUIR.
 *
 * Medido em produção em 2026-09-21 (v1.34.1): numa organização em `round_robin`,
 * o cron de roteamento entregava a conversa ao atendente online dois segundos
 * depois de ela nascer, e o motor pulava o turno por `conversa_de_humano`. Com
 * alguém online, a IA não respondia ninguém. O conserto: o rodízio pergunta,
 * antes de distribuir, se há IA AUTOMÁTICA no ar no canal da conversa (esta
 * função) e se a conversa passa na trava de elegibilidade (`gate.ts`, a mesma
 * do motor). As duas sim ⇒ a IA atende e ninguém recebe a conversa.
 *
 * Por isso a função é vigiada nas DUAS direções. Só a metade do "sim" seria
 * satisfeita por uma função que sempre diz sim — e aí o rodízio nunca mais
 * distribui nada: o agente pausado deixaria o cliente sem IA e sem fila. Só a
 * metade do "não" seria satisfeita por uma que sempre diz não — o defeito de
 * produção de volta.
 *
 * "No ar" é a régua da tela (`lib/ai/agents/no-ar.ts`): não arquivado, não
 * pausado, com versão publicada — e, como no portão do drain, a versão ligada
 * ao canal (ou um roteador ativo nele). Agente ASSISTIDO no canal ⇒ quem envia
 * é uma pessoa, então o rodízio TEM de distribuir.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "a1a00000-0000-4000-8000-000000000001";
const OUTRA_ORG = "a1a00000-0000-4000-8000-000000000002";

let seq = 100;
function proximoId(): string {
  seq += 1;
  return `a1a00000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

async function novoCanal(nome: string): Promise<string> {
  const id = proximoId();
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [id, ORG, `ria-${nome}`],
  );
  return id;
}

/**
 * Agente com versão para o canal. `publicado: false` reproduz o que a pausa deixa
 * no banco (versão `superseded`, `published_version_id` nulo) — o mesmo desenho
 * do invariante do portão de capacidade.
 */
async function novoAgente(
  canal: string,
  opts: { nome: string; publicado?: boolean; modo?: "automatic" | "assisted"; pausadoComVersao?: boolean },
): Promise<string> {
  const agent = proximoId();
  const version = proximoId();
  const publicado = opts.publicado ?? true;
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind, operation_mode)
     values ($1, $2, $3, 'você é um atendente', 'mcp_agent', $4)`,
    [agent, ORG, `Agente Rodízio ${opts.nome}`, opts.modo ?? "automatic"],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, $5, now())`,
    [version, ORG, agent, canal, publicado ? "published" : "superseded"],
  );
  if (publicado) {
    await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [version, agent]);
  }
  if (opts.pausadoComVersao) {
    await pool.query(`update ai_agents set paused_at = now() where id = $1`, [agent]);
  }
  return agent;
}

async function novoRoteador(canal: string, membro: string): Promise<void> {
  const router = proximoId();
  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, is_active, fallback_agent_id)
     values ($1, $2, $3, $4, true, null)`,
    [router, ORG, `Roteador Rodízio ${router.slice(-4)}`, canal],
  );
  await pool.query(
    `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description)
     values ($1, $2, $3, 'suporte', 'dúvidas de suporte')`,
    [ORG, router, membro],
  );
}

async function iaNoCanal(org: string, canal: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    "select public.fn_ia_automatica_no_canal($1, $2) as ok",
    [org, canal],
  );
  return rows[0]!.ok;
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "rodizio-respeita-ia"],
    [OUTRA_ORG, "rodizio-respeita-ia-outra"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, $3, $4) on conflict (id) do nothing`,
      [id, slug, slug, slug],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

describe("fn_ia_automatica_no_canal — diz SIM quando a IA atende", () => {
  it("agente automático publicado para o canal ⇒ sim", async () => {
    const canal = await novoCanal("automatico");
    await novoAgente(canal, { nome: "automatico" });
    expect(await iaNoCanal(ORG, canal)).toBe(true);
  });

  it("roteador ativo no canal com membro automático no ar ⇒ sim", async () => {
    const canal = await novoCanal("roteador");
    const outroCanal = await novoCanal("roteador-versao-alhures");
    // A versão do membro aponta para OUTRO canal: quem liga o agente a ESTE é o roteador.
    const membro = await novoAgente(outroCanal, { nome: "membro-no-ar" });
    await novoRoteador(canal, membro);
    expect(await iaNoCanal(ORG, canal)).toBe(true);
  });
});

describe("fn_ia_automatica_no_canal — diz NÃO quando ninguém automático atende", () => {
  it("canal sem agente nenhum ⇒ não", async () => {
    const canal = await novoCanal("vazio");
    expect(await iaNoCanal(ORG, canal)).toBe(false);
  });

  it("agente pausado (versão superseded, sem published_version_id) ⇒ não", async () => {
    const canal = await novoCanal("pausado");
    await novoAgente(canal, { nome: "pausado", publicado: false });
    expect(await iaNoCanal(ORG, canal)).toBe(false);
  });

  it("agente com paused_at mesmo guardando a versão ⇒ não (régua de no-ar.ts)", async () => {
    const canal = await novoCanal("pausado-com-versao");
    await novoAgente(canal, { nome: "pausado-com-versao", pausadoComVersao: true });
    expect(await iaNoCanal(ORG, canal)).toBe(false);
  });

  it("agente ASSISTIDO no canal ⇒ não — quem envia é uma pessoa, o rodízio distribui", async () => {
    const canal = await novoCanal("assistido");
    await novoAgente(canal, { nome: "assistido", modo: "assisted" });
    expect(await iaNoCanal(ORG, canal)).toBe(false);
  });

  it("automático E assistido no mesmo canal ⇒ não — o motor segue o assistido (drain.ts)", async () => {
    const canal = await novoCanal("misto");
    await novoAgente(canal, { nome: "misto-auto" });
    await novoAgente(canal, { nome: "misto-assistido", modo: "assisted" });
    expect(await iaNoCanal(ORG, canal)).toBe(false);
  });

  it("agente publicado para OUTRO canal ⇒ não", async () => {
    const canal = await novoCanal("sem-o-seu");
    const outro = await novoCanal("com-o-agente");
    await novoAgente(outro, { nome: "de-outro-canal" });
    expect(await iaNoCanal(ORG, canal)).toBe(false);
  });

  it("roteador cujo único membro está pausado ⇒ não", async () => {
    const canal = await novoCanal("roteador-pausado");
    const membro = await novoAgente(canal, { nome: "membro-pausado", publicado: false });
    await novoRoteador(canal, membro);
    expect(await iaNoCanal(ORG, canal)).toBe(false);
  });

  it("a pergunta é por organização: o canal de uma org não responde pela outra", async () => {
    const canal = await novoCanal("isolado");
    await novoAgente(canal, { nome: "isolado" });
    expect(await iaNoCanal(ORG, canal)).toBe(true);
    expect(await iaNoCanal(OUTRA_ORG, canal)).toBe(false);
  });
});

describe("fn_ia_automatica_no_canal — quem pode perguntar", () => {
  it("nem anon nem authenticated executam; service_role executa (o cron do rodízio)", async () => {
    const assinatura = "public.fn_ia_automatica_no_canal(uuid, uuid)";
    const { rows } = await pool.query<{ anon: boolean; autenticado: boolean; servico: boolean }>(
      `select has_function_privilege('anon', $1, 'execute') as anon,
              has_function_privilege('authenticated', $1, 'execute') as autenticado,
              has_function_privilege('service_role', $1, 'execute') as servico`,
      [assinatura],
    );
    expect(rows[0]).toEqual({ anon: false, autenticado: false, servico: true });
  });
});
