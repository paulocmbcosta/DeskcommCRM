/**
 * A FILA DO TELEFONE COMO A TELA A LÊ, CONTRA POSTGRES REAL (aba Telefone; migration 0295).
 *
 * `lerFilaDoTelefone` é o que `GET /api/v1/telefonia/fila` devolve a todo
 * navegador com o Inbox aberto. A conexão é a do app, FORA da RLS: a única
 * catraca entre uma organização e a outra é o `organization_id` de cada consulta
 * — por isso aqui há sempre DUAS organizações com número, time e ligações, e uma
 * terceira sem número de telefone.
 *
 * As regras puras (fase, posição, motivo) têm teste próprio
 * (lib/telefonia/fila.test.ts); aqui se prova o SQL, no schema de verdade, e por
 * isso toda semeadura é SQL direto em `voice_calls` — sem passar pelo worker:
 *
 *  1. as ligações VIVAS recebidas pelo telefone, na ordem de chegada, com a fase
 *     de cada uma — e as três que não entram: a viva de 5 h atrás (linha
 *     esquecida), a FEITA e a do WaCalls;
 *  2. nada de uma organização aparece na outra: nem ligação, nem perdida, nem
 *     número, nem time — nem o NOME de um contato de outra organização numa
 *     linha que aponta para ele;
 *  3. a posição na fila do time (1, 2, 3 pela ordem de `queued_at`), só em quem
 *     espera por uma pessoa;
 *  4. `cai_em` só em quem espera sem ninguém tocando; para quem toca e com quem
 *     fala, pelo nome cadastrado — sem ele, o começo do e-mail, NUNCA o endereço
 *     (a fila de todos os times vai para todo `viewer`); na transferência para
 *     um time, o time de DESTINO e quem transferiu;
 *  5. as perdidas dos últimos 30 minutos, da mais recente para a mais antiga, com
 *     o motivo e quanto esperou;
 *  6. os times ativos com a espera em vigor (o padrão ou a configurada);
 *  7. sem número de telefone ATIVO não há fila (`ativa: false`), mesmo com
 *     ligação de outro provider e com um número arquivado;
 *  8. `agora` é o relógio do banco;
 *  9. a ordem ABERTA da ligação (atender ou mover; migration 0296) vem na linha
 *     dela, com quem pediu e para onde — a encerrada não vem, a linha não se
 *     duplica, e a ordem de uma organização não aparece na outra;
 * 10. a ordem aberta VENCE em 30 s (`VALIDADE_DA_ORDEM_DA_FILA_S`): a que ficou
 *     aberta há mais que isso não vem na linha — ela não está acontecendo, e a
 *     linha não pode ficar sem os botões até a ligação acabar. A de 5 s vem.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lerFilaDoTelefone } from "@/lib/channels/telefonia/fila-da-tela";
import { VALIDADE_DA_ORDEM_DA_FILA_S, type FilaDoTelefone } from "@/lib/telefonia/fila";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = "c0de0297-0000-4000-8000-00000000000a";
const OUTRA = "c0de0297-0000-4000-8000-00000000000b";
/** Sem número de telefone ativo: só um WhatsApp e um número de telefone ARQUIVADO. */
const SEM_TELEFONE = "c0de0297-0000-4000-8000-00000000000c";
const ANA = "c0de0297-1111-4000-8000-000000000001";
const BRUNO = "c0de0297-1111-4000-8000-000000000002";
/** Sem nome cadastrado: só o e-mail — na fila ele aparece pelo que vem antes do `@`. */
const CAIO = "c0de0297-1111-4000-8000-000000000003";
const DANI = "c0de0297-1111-4000-8000-000000000004";
const SUPORTE = "c0de0297-2222-4000-8000-000000000001";
const FINANCEIRO = "c0de0297-2222-4000-8000-000000000002";
const ARQUIVADO = "c0de0297-2222-4000-8000-000000000003";
const TIME_OUTRA = "c0de0297-2222-4000-8000-000000000004";
const TIME_SEM_TELEFONE = "c0de0297-2222-4000-8000-000000000005";
const MENU = "c0de0297-3333-4000-8000-000000000001";
const NUMERO = "c0de0297-5555-4000-8000-000000000001";
const NUMERO_OUTRA = "c0de0297-5555-4000-8000-000000000002";
const WHATSAPP_SEM_TELEFONE = "c0de0297-5555-4000-8000-000000000003";
const NUMERO_ARQUIVADO = "c0de0297-5555-4000-8000-000000000004";
const EMAIL_DO_CAIO = "caio-fila-tela@invariant.test";
const CAIO_NA_FILA = "caio-fila-tela";

interface Semente {
  org: string;
  numero: string;
  provider?: "sip_trunk" | "wacalls";
  direcao?: "inbound" | "outbound";
  status: "ringing" | "connected" | "ended";
  time?: string | null;
  contato?: string | null;
  conversa?: string | null;
  /** Há quantos segundos a ligação começou. */
  comecouHa: number;
  /** Há quantos segundos passou a esperar por uma pessoa (`queued_at`). */
  naFilaHa?: number;
  /** Daqui a quantos segundos a espera esgota (`queue_deadline_at`). */
  caiEm?: number;
  atendidaHa?: number;
  acabouHa?: number;
  motivo?: string;
  tocando?: string;
  dono?: string;
  menu?: string;
  desfechoDoMenu?: string;
}

let ligacoes = 0;

/** Uma linha de `voice_calls`, por SQL direto, com os instantes contados a partir do `now()` do banco. */
async function ligacao(s: Semente): Promise<string> {
  ligacoes += 1;
  const provider = s.provider ?? "sip_trunk";
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.voice_calls
       (organization_id, channel_session_id, provider, sip_call_ref, wacalls_call_id, direction, peer_phone, status,
        team_id, contact_id, conversation_id, started_at, queued_at, queue_deadline_at, answered_at, ended_at, end_reason,
        ringing_user_id, owner_user_id, menu_id, menu_outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             now() - make_interval(secs => $12::double precision),
             now() - make_interval(secs => $13::double precision),
             now() + make_interval(secs => $14::double precision),
             now() - make_interval(secs => $15::double precision),
             now() - make_interval(secs => $16::double precision),
             $17, $18, $19, $20, $21)
     returning id`,
    [
      s.org, s.numero, provider,
      provider === "sip_trunk" ? `fila-tela-${ligacoes}` : null,
      provider === "wacalls" ? `wa-fila-tela-${ligacoes}` : null,
      s.direcao ?? "inbound", `+55619888${String(ligacoes).padStart(5, "0")}`, s.status,
      s.time ?? null, s.contato ?? null, s.conversa ?? null,
      s.comecouHa, s.naFilaHa ?? null, s.caiEm ?? null, s.atendidaHa ?? null, s.acabouHa ?? null,
      s.motivo ?? null, s.tocando ?? null, s.dono ?? null, s.menu ?? null, s.desfechoDoMenu ?? null,
    ],
  );
  return rows[0]!.id;
}

async function contato(org: string, nome: string, apelido: string | null, telefone: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.contacts (organization_id, name, display_name, phone_number, source)
     values ($1, $2, $3, $4, 'phone_call') returning id`,
    [org, nome, apelido, telefone],
  );
  return rows[0]!.id;
}

/**
 * Uma ordem da fila (`voice_call_queue_orders`, 0296), por SQL direto: aberta,
 * como a rota a grava, ou já fechada (`fechada`), como o worker a deixa.
 * `pedidaHa` é há quantos segundos ela foi pedida, pelo relógio do banco (o
 * padrão é agora).
 */
async function ordem(o: {
  org: string;
  ligacao: string;
  tipo: "pull" | "move";
  por: string;
  deTime: string;
  paraTime?: string;
  fechada?: "done" | "refused" | "no_answer" | "cancelled";
  pedidaHa?: number;
}): Promise<void> {
  await pool.query(
    `insert into public.voice_call_queue_orders
       (organization_id, voice_call_id, kind, requested_by, to_user_id, to_team_id, from_team_id, status, outcome,
        created_at, ended_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             now() - make_interval(secs => $10::double precision), case when $8 = 'ended' then now() end)`,
    [
      o.org, o.ligacao, o.tipo, o.por, o.tipo === "pull" ? o.por : null, o.paraTime ?? null, o.deTime,
      o.fechada ? "ended" : "open", o.fechada ?? null, o.pedidaHa ?? 0,
    ],
  );
}

/** Os ids semeados, por nome — preenchidos no `beforeAll`. */
const L = {
  transferencia: "", comBruno: "", aguardando1: "", tocando: "", aguardando2: "", noMenu: "", nosAvisos: "",
  vivaDe5h: "", feita: "", doWacalls: "",
  esgotada: "", foraDoHorario: "", desligouNoMenu: "", perdidaDe40min: "", atendida: "",
  aguardandoDeB: "", perdidaDeB: "", doWhatsappDeC: "", naFilaDoArquivadoDeC: "",
};
const C = { daFila: "", comApelido: "", deB: "" };
let conversaDoBruno = "";
let transferidaEm = "";

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, 'ana-fila-tela@invariant.test', '{"full_name":"Ana da Tela"}'),
       ($2, 'bruno-fila-tela@invariant.test', '{"full_name":"Bruno da Tela"}'),
       ($3, $5, '{}'),
       ($4, 'dani-fila-tela@invariant.test', '{"full_name":"Dani de B"}')
     on conflict (id) do nothing`,
    [ANA, BRUNO, CAIO, DANI, EMAIL_DO_CAIO],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name) values
       ($1, 'fila-tela-0297-a', 'Fila Tela 0297 A', 'Tela A'),
       ($2, 'fila-tela-0297-b', 'Fila Tela 0297 B', 'Tela B'),
       ($3, 'fila-tela-0297-c', 'Fila Tela 0297 C', 'Tela C')
     on conflict (id) do nothing`,
    [ORG, OUTRA, SEM_TELEFONE],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $5, 'agent', now()), ($2, $5, 'agent', now()), ($3, $5, 'agent', now()), ($4, $6, 'agent', now())
     on conflict do nothing`,
    [ANA, BRUNO, CAIO, DANI, ORG, OUTRA],
  );
  await pool.query(
    `insert into public.attendance_teams (id, organization_id, name, slug, archived_at, phone_queue_max_wait_seconds) values
       ($1, $6, 'Suporte', 'suporte-0297', null, null),
       ($2, $6, 'Financeiro', 'financeiro-0297', null, 600),
       ($3, $6, 'Antigo', 'antigo-0297', now(), 900),
       ($4, $7, 'Suporte B', 'suporte-0297', null, 300),
       ($5, $8, 'Suporte C', 'suporte-0297', null, null)
     on conflict (id) do nothing`,
    [SUPORTE, FINANCEIRO, ARQUIVADO, TIME_OUTRA, TIME_SEM_TELEFONE, ORG, OUTRA, SEM_TELEFONE],
  );
  await pool.query(
    `insert into public.channel_sessions
       (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
        sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, archived_at)
     values
       ($1, $4, 'sip_trunk', '\\x00', 'STARTING', 'Tela A', '+556130000497',
        'voip.exemplo-0497.com.br', 5060, 'udp', 'u0297a', '\\x00', null),
       ($2, $5, 'sip_trunk', '\\x00', 'STARTING', 'Tela B', '+556130000498',
        'voip.exemplo-0498.com.br', 5060, 'udp', 'u0297b', '\\x00', null),
       ($3, $6, 'sip_trunk', '\\x00', 'STOPPED', 'Tela C (arquivado)', '+556130000499',
        'voip.exemplo-0499.com.br', 5060, 'udp', 'u0297c', '\\x00', now())
     on conflict (id) do nothing`,
    [NUMERO, NUMERO_OUTRA, NUMERO_ARQUIVADO, ORG, OUTRA, SEM_TELEFONE],
  );
  await pool.query(
    `insert into public.channel_sessions (id, organization_id, provider, waha_session_name, webhook_secret_encrypted, status, display_name)
     values ($1, $2, 'waha', 'fila-tela-0297-c', '\\x00', 'STARTING', 'WhatsApp C')
     on conflict (id) do nothing`,
    [WHATSAPP_SEM_TELEFONE, SEM_TELEFONE],
  );
  await pool.query(
    `insert into public.phone_menus (id, organization_id, name, default_team_id) values ($1, $2, 'Principal', $3)
     on conflict (id) do nothing`,
    [MENU, ORG, SUPORTE],
  );

  C.daFila = await contato(ORG, "Cliente da Fila", null, "+5561977700001");
  C.comApelido = await contato(ORG, "Nome de Cadastro", "Apelido na Tela", "+5561977700002");
  C.deB = await contato(OUTRA, "Cliente Só de B", null, "+5561977700003");
  const { rows: conv } = await pool.query<{ id: string }>(
    `insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, team_id)
     values ($1, $2, $3, 'phone', 'open', false, 0, $4) returning id`,
    [ORG, C.daFila, NUMERO, SUPORTE],
  );
  conversaDoBruno = conv[0]!.id;

  // ── Organização A: as vivas, da que espera há mais tempo para a que acabou de chegar ──
  L.transferencia = await ligacao({ org: ORG, numero: NUMERO, status: "connected", time: SUPORTE, comecouHa: 320, naFilaHa: 300, atendidaHa: 280, dono: ANA });
  const { rows: tr } = await pool.query<{ created_at: Date }>(
    `insert into public.voice_call_transfers (organization_id, voice_call_id, requested_by, from_user_id, to_team_id, kind, status, created_at)
     values ($1, $2, $3, $3, $4, 'blind', 'open', now() - interval '40 seconds') returning created_at`,
    [ORG, L.transferencia, CAIO, FINANCEIRO],
  );
  transferidaEm = new Date(tr[0]!.created_at).toISOString();
  L.comBruno = await ligacao({
    org: ORG, numero: NUMERO, status: "connected", time: SUPORTE, contato: C.daFila, conversa: conversaDoBruno,
    comecouHa: 170, naFilaHa: 150, atendidaHa: 120, dono: BRUNO,
  });
  L.aguardando1 = await ligacao({ org: ORG, numero: NUMERO, status: "ringing", time: SUPORTE, contato: C.daFila, comecouHa: 100, naFilaHa: 90, caiEm: 30 });
  // Toca para a Ana. O prazo que ficou na linha não é dela: `cai_em` é só de quem espera sem ninguém tocando.
  L.tocando = await ligacao({ org: ORG, numero: NUMERO, status: "ringing", time: SUPORTE, contato: C.comApelido, comecouHa: 70, naFilaHa: 60, caiEm: 60, tocando: ANA });
  // Aponta para um contato de OUTRA organização (a FK de `contact_id` é simples): o nome dele não pode vir.
  L.aguardando2 = await ligacao({ org: ORG, numero: NUMERO, status: "ringing", time: SUPORTE, contato: C.deB, comecouHa: 45, naFilaHa: 30, caiEm: 90 });
  L.noMenu = await ligacao({ org: ORG, numero: NUMERO, status: "ringing", comecouHa: 25, menu: MENU });
  L.nosAvisos = await ligacao({ org: ORG, numero: NUMERO, status: "ringing", time: SUPORTE, comecouHa: 15, menu: MENU, desfechoDoMenu: "chosen" });
  // As três que NÃO entram.
  L.vivaDe5h = await ligacao({ org: ORG, numero: NUMERO, status: "ringing", time: SUPORTE, comecouHa: 5 * 3600, naFilaHa: 5 * 3600 - 10 });
  L.feita = await ligacao({ org: ORG, numero: NUMERO, direcao: "outbound", status: "connected", comecouHa: 50, atendidaHa: 40, dono: ANA });
  L.doWacalls = await ligacao({ org: ORG, numero: NUMERO, provider: "wacalls", status: "ringing", comecouHa: 20 });

  // ── Organização A: as encerradas ──
  L.esgotada = await ligacao({ org: ORG, numero: NUMERO, status: "ended", time: SUPORTE, contato: C.daFila, comecouHa: 300 + 150, naFilaHa: 300 + 120, acabouHa: 300, motivo: "fila_esgotada" });
  L.foraDoHorario = await ligacao({ org: ORG, numero: NUMERO, status: "ended", time: FINANCEIRO, comecouHa: 600 + 8, acabouHa: 600, motivo: "after_hours" });
  L.desligouNoMenu = await ligacao({ org: ORG, numero: NUMERO, status: "ended", comecouHa: 120 + 12, acabouHa: 120, motivo: "cliente_desligou", menu: MENU });
  L.perdidaDe40min = await ligacao({ org: ORG, numero: NUMERO, status: "ended", time: SUPORTE, comecouHa: 2400 + 60, naFilaHa: 2400 + 50, acabouHa: 2400, motivo: "fila_esgotada" });
  L.atendida = await ligacao({ org: ORG, numero: NUMERO, status: "ended", time: SUPORTE, comecouHa: 180 + 90, naFilaHa: 180 + 80, atendidaHa: 180 + 60, acabouHa: 180, motivo: "cliente_desligou", dono: BRUNO });

  // ── Organização B: espera há MAIS tempo que todas as de A — se vazasse, seria a primeira da lista ──
  L.aguardandoDeB = await ligacao({ org: OUTRA, numero: NUMERO_OUTRA, status: "ringing", time: TIME_OUTRA, contato: C.deB, comecouHa: 420, naFilaHa: 400, caiEm: 20 });
  L.perdidaDeB = await ligacao({ org: OUTRA, numero: NUMERO_OUTRA, status: "ended", time: TIME_OUTRA, comecouHa: 60 + 30, naFilaHa: 60 + 20, acabouHa: 60, motivo: "fila_esgotada" });

  // ── Organização C: uma ligação do WhatsApp e uma na fila de um número ARQUIVADO ──
  L.doWhatsappDeC = await ligacao({ org: SEM_TELEFONE, numero: WHATSAPP_SEM_TELEFONE, provider: "wacalls", status: "ringing", comecouHa: 10 });
  L.naFilaDoArquivadoDeC = await ligacao({ org: SEM_TELEFONE, numero: NUMERO_ARQUIVADO, status: "ringing", time: TIME_SEM_TELEFONE, comecouHa: 40, naFilaHa: 30, caiEm: 90 });

  // ── As ordens da fila (0296) ──
  // A primeira da fila: o Bruno puxou e não atendeu (ENCERRADA); agora a Ana puxa (ABERTA).
  await ordem({ org: ORG, ligacao: L.aguardando1, tipo: "pull", por: BRUNO, deTime: SUPORTE, fechada: "no_answer" });
  await ordem({ org: ORG, ligacao: L.aguardando1, tipo: "pull", por: ANA, deTime: SUPORTE });
  // A terceira: o Caio (sem nome cadastrado) manda para o Financeiro (ABERTA, pedida há 5 s: ainda acontece).
  await ordem({ org: ORG, ligacao: L.aguardando2, tipo: "move", por: CAIO, deTime: SUPORTE, paraTime: FINANCEIRO, pedidaHa: 5 });
  // A que toca: uma ordem que já acabou, e uma ABERTA que ficou para trás — o Bruno
  // pediu para atender há 31 s e ninguém a fechou. Nenhuma das duas é de alguém agora.
  await ordem({ org: ORG, ligacao: L.tocando, tipo: "move", por: BRUNO, deTime: FINANCEIRO, paraTime: SUPORTE, fechada: "done", pedidaHa: 90 });
  await ordem({ org: ORG, ligacao: L.tocando, tipo: "pull", por: BRUNO, deTime: SUPORTE, pedidaHa: VALIDADE_DA_ORDEM_DA_FILA_S + 1 });
  // Organização B: a Dani puxa a única da fila de B.
  await ordem({ org: OUTRA, ligacao: L.aguardandoDeB, tipo: "pull", por: DANI, deTime: TIME_OUTRA });
});

afterAll(async () => {
  await pool.end();
});

/** Os instantes gravados na linha, como a rota os devolve (ISO). */
async function gravado(id: string) {
  const { rows } = await pool.query<{ started_at: Date; queued_at: Date | null; queue_deadline_at: Date | null; answered_at: Date | null; ended_at: Date | null }>(
    "select started_at, queued_at, queue_deadline_at, answered_at, ended_at from public.voice_calls where id = $1",
    [id],
  );
  const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString());
  const r = rows[0]!;
  return { comecou: iso(r.started_at)!, naFila: iso(r.queued_at), prazo: iso(r.queue_deadline_at), atendida: iso(r.answered_at), acabou: iso(r.ended_at) };
}

const de = (fila: FilaDoTelefone, id: string) => {
  const l = fila.ligacoes.find((x) => x.id === id);
  if (!l) throw new Error(`a ligação ${id} não veio na fila`);
  return l;
};

describe("a fila do telefone lida do banco", () => {
  let filaA: FilaDoTelefone;
  let filaB: FilaDoTelefone;

  beforeAll(async () => {
    filaA = await lerFilaDoTelefone(pool, ORG);
    filaB = await lerFilaDoTelefone(pool, OUTRA);
  });

  it("as vivas recebidas pelo telefone, na ordem de chegada, cada uma na sua fase — sem a de 5 h atrás, a feita e a do WaCalls", () => {
    expect(filaA.ativa).toBe(true);
    expect(filaA.ligacoes.map((l) => [l.id, l.fase])).toEqual([
      [L.transferencia, "transferencia_na_fila"],
      [L.comBruno, "em_ligacao"],
      [L.aguardando1, "aguardando"],
      [L.tocando, "tocando"],
      [L.aguardando2, "aguardando"],
      [L.noMenu, "menu"],
      [L.nosAvisos, "avisos"],
    ]);
    const ids = new Set(filaA.ligacoes.map((l) => l.id));
    for (const fora of [L.vivaDe5h, L.feita, L.doWacalls]) expect(ids.has(fora)).toBe(false);
    expect(filaA.numeros).toEqual([{ id: NUMERO, nome: "Tela A", numero: "+556130000497" }]);
  });

  it("nada de uma organização aparece na outra — nem ligação, nem perdida, nem número, nem time", () => {
    expect(filaB.ativa).toBe(true);
    expect(filaB.ligacoes.map((l) => l.id)).toEqual([L.aguardandoDeB]);
    expect(filaB.perdidas.map((l) => l.id)).toEqual([L.perdidaDeB]);
    expect(filaB.numeros).toEqual([{ id: NUMERO_OUTRA, nome: "Tela B", numero: "+556130000498" }]);
    expect(filaB.times).toEqual([{ id: TIME_OUTRA, nome: "Suporte B", espera_maxima_s: 300 }]);
    // A fila de B é só dela: a que espera há mais tempo no banco inteiro é a 1ª de B, e não entra em A.
    expect(de(filaB, L.aguardandoDeB)).toMatchObject({ posicao: 1, time_id: TIME_OUTRA, contato: { id: C.deB, nome: "Cliente Só de B" } });

    const tudoDeA = JSON.stringify(filaA);
    for (const deB of [L.aguardandoDeB, L.perdidaDeB, NUMERO_OUTRA, TIME_OUTRA, OUTRA, DANI, "Suporte B", "Tela B", "Dani de B"]) {
      expect(tudoDeA).not.toContain(deB);
    }
    const tudoDeB = JSON.stringify(filaB);
    for (const deA of [...Object.values(L).filter((id) => id !== L.aguardandoDeB && id !== L.perdidaDeB), NUMERO, SUPORTE, FINANCEIRO, ORG, ANA, CAIO, "Ana da Tela", CAIO_NA_FILA, "Cliente da Fila"]) {
      expect(tudoDeB).not.toContain(deA);
    }
  });

  it("a linha que aponta para um contato de OUTRA organização não traz o nome dele", () => {
    expect(de(filaA, L.aguardando2).contato).toEqual({ id: C.deB, nome: null });
    expect(JSON.stringify(filaA)).not.toContain("Cliente Só de B");
  });

  it("a posição na fila do time: 1, 2 e 3 pela ordem de chegada, só em quem espera por uma pessoa", () => {
    expect(de(filaA, L.aguardando1).posicao).toBe(1);
    expect(de(filaA, L.tocando).posicao).toBe(2);
    expect(de(filaA, L.aguardando2).posicao).toBe(3);
    for (const id of [L.transferencia, L.comBruno, L.noMenu, L.nosAvisos]) expect(de(filaA, id).posicao).toBeNull();
  });

  it("quem espera: o contato, o time, desde quando e quando cai — e `cai_em` só sem ninguém tocando", async () => {
    const g1 = await gravado(L.aguardando1);
    expect(de(filaA, L.aguardando1)).toEqual({
      id: L.aguardando1, fase: "aguardando", contato: { id: C.daFila, nome: "Cliente da Fila" },
      numero: expect.stringMatching(/^\+55619888\d{5}$/), time_id: SUPORTE, numero_da_empresa_id: NUMERO, conversa_id: null,
      entrou_em: g1.comecou, na_fila_desde: g1.naFila, posicao: 1, cai_em: g1.prazo,
      tocando_para: null, com: null, atendida_em: null,
      ordem: { tipo: "pull", por: { id: ANA, nome: "Ana da Tela" }, para_time_id: null },
    });
    expect(g1.prazo).not.toBeNull();
    expect(de(filaA, L.aguardando2).cai_em).toBe((await gravado(L.aguardando2)).prazo);

    const gt = await gravado(L.tocando);
    // O prazo está na linha, e a tela não o recebe: há um ramal tocando.
    expect(gt.prazo).not.toBeNull();
    expect(de(filaA, L.tocando)).toMatchObject({
      cai_em: null, na_fila_desde: gt.naFila, tocando_para: { id: ANA, nome: "Ana da Tela" }, com: null,
      contato: { id: C.comApelido, nome: "Apelido na Tela" },
    });
    for (const id of [L.transferencia, L.comBruno, L.noMenu, L.nosAvisos]) expect(de(filaA, id).cai_em).toBeNull();
    // No menu e nos avisos ainda não há fila nem time decidido pela pessoa.
    expect(de(filaA, L.noMenu)).toMatchObject({ na_fila_desde: null, time_id: null, contato: null, tocando_para: null, com: null });
    expect(de(filaA, L.nosAvisos)).toMatchObject({ na_fila_desde: null, time_id: SUPORTE });
  });

  it("em ligação: com quem fala, pelo nome cadastrado, e a conversa dela", async () => {
    const g = await gravado(L.comBruno);
    expect(de(filaA, L.comBruno)).toMatchObject({
      com: { id: BRUNO, nome: "Bruno da Tela" }, tocando_para: null, conversa_id: conversaDoBruno,
      time_id: SUPORTE, atendida_em: g.atendida, na_fila_desde: g.naFila,
    });
    expect(g.atendida).not.toBeNull();
  });

  it("na transferência para um time: o time de DESTINO, desde o pedido, e quem transferiu", () => {
    expect(de(filaA, L.transferencia)).toMatchObject({
      fase: "transferencia_na_fila", time_id: FINANCEIRO, na_fila_desde: transferidaEm,
      com: { id: CAIO, nome: CAIO_NA_FILA }, tocando_para: null,
    });
  });

  it("quem não tem nome cadastrado aparece pelo começo do e-mail — o endereço de ninguém vai na fila", () => {
    expect(de(filaA, L.transferencia).com).toEqual({ id: CAIO, nome: CAIO_NA_FILA });
    // Nem o do Caio, nem o de quem TEM nome: nenhum `@` na resposta inteira, das duas organizações.
    for (const fila of [filaA, filaB]) {
      const tudo = JSON.stringify(fila);
      expect(tudo).not.toContain(EMAIL_DO_CAIO);
      expect(tudo).not.toContain("@");
    }
  });

  it("as perdidas dos últimos 30 minutos, da mais recente para a mais antiga, com o motivo e quanto esperou", async () => {
    expect(filaA.perdidas.map((p) => [p.id, p.motivo])).toEqual([
      [L.desligouNoMenu, "desligou_no_menu"],
      [L.esgotada, "fila_esgotada"],
      [L.foraDoHorario, "fora_do_horario"],
    ]);
    const esperou = Object.fromEntries(filaA.perdidas.map((p) => [p.id, p.esperou_s]));
    for (const [id, segundos] of [[L.desligouNoMenu, 12], [L.esgotada, 120], [L.foraDoHorario, 8]] as const) {
      expect(Math.abs(esperou[id]! - segundos)).toBeLessThanOrEqual(1);
    }
    const esgotada = filaA.perdidas.find((p) => p.id === L.esgotada)!;
    expect(esgotada).toMatchObject({
      contato: { id: C.daFila, nome: "Cliente da Fila" }, time_id: SUPORTE, numero_da_empresa_id: NUMERO,
      conversa_id: null, encerrada_em: (await gravado(L.esgotada)).acabou,
    });
    expect(filaA.perdidas.find((p) => p.id === L.foraDoHorario)!.time_id).toBe(FINANCEIRO);
    // A de 40 minutos saiu da janela; a atendida não é perdida.
    const ids = new Set(filaA.perdidas.map((p) => p.id));
    expect(ids.has(L.perdidaDe40min)).toBe(false);
    expect(ids.has(L.atendida)).toBe(false);
  });

  it("os times ativos, pelo nome, com a espera em vigor: o padrão (120 s) ou a configurada", () => {
    expect(filaA.times).toEqual([
      { id: FINANCEIRO, nome: "Financeiro", espera_maxima_s: 600 },
      { id: SUPORTE, nome: "Suporte", espera_maxima_s: 120 },
    ]);
    expect(filaA.times.some((t) => t.id === ARQUIVADO)).toBe(false);
  });

  it("sem número de telefone ATIVO não há fila — mesmo com ligação de outro provider e com um número arquivado", async () => {
    const fila = await lerFilaDoTelefone(pool, SEM_TELEFONE);
    expect(fila).toEqual({ ativa: false, agora: expect.any(String), times: [], numeros: [], ligacoes: [], perdidas: [] });
    // As linhas existem: quem as deixa de fora é a consulta, não a falta delas.
    const { rows } = await pool.query("select id from public.voice_calls where organization_id = $1 and status <> 'ended'", [SEM_TELEFONE]);
    expect(rows.map((r) => r.id).sort()).toEqual([L.doWhatsappDeC, L.naFilaDoArquivadoDeC].sort());
  });

  it("a ordem ABERTA vem na linha da ligação: quem pediu para atender, ou quem move e para qual time", () => {
    // A encerrada da mesma ligação (o Bruno, que não atendeu) não é a que vem.
    expect(de(filaA, L.aguardando1).ordem).toEqual({ tipo: "pull", por: { id: ANA, nome: "Ana da Tela" }, para_time_id: null });
    // Quem não tem nome cadastrado aparece pelo começo do e-mail, como no resto da fila.
    expect(de(filaA, L.aguardando2).ordem).toEqual({ tipo: "move", por: { id: CAIO, nome: CAIO_NA_FILA }, para_time_id: FINANCEIRO });
  });

  it("ordem que já acabou não é de ninguém — e ligação sem ordem vem com `null`", async () => {
    expect(de(filaA, L.tocando).ordem).toBeNull();
    // A linha existe: quem deixa a encerrada de fora é a consulta, não a falta dela.
    const { rows } = await pool.query<{ status: string; outcome: string | null }>(
      `select status, outcome from public.voice_call_queue_orders
        where organization_id = $1 and voice_call_id = $2 and status = 'ended'`,
      [ORG, L.tocando],
    );
    expect(rows).toEqual([{ status: "ended", outcome: "done" }]);
    for (const id of [L.transferencia, L.comBruno, L.noMenu, L.nosAvisos]) expect(de(filaA, id).ordem).toBeNull();
  });

  it("a ordem aberta há mais de 30 s VENCEU: não vem na linha — a ligação não fica sem os botões até acabar", async () => {
    // Ela existe e segue `open` no banco: quem a deixa de fora é o corte da leitura.
    const { rows } = await pool.query<{ status: string; kind: string; requested_by: string; ha_s: number }>(
      `select status, kind, requested_by, extract(epoch from now() - created_at)::float8 as ha_s
         from public.voice_call_queue_orders
        where organization_id = $1 and voice_call_id = $2 and status = 'open'`,
      [ORG, L.tocando],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open", kind: "pull", requested_by: BRUNO });
    expect(rows[0]!.ha_s).toBeGreaterThan(VALIDADE_DA_ORDEM_DA_FILA_S);
    expect(de(filaA, L.tocando).ordem).toBeNull();
    // O resto da linha não muda: ela continua tocando para a Ana, na posição dela.
    expect(de(filaA, L.tocando)).toMatchObject({ fase: "tocando", posicao: 2, tocando_para: { id: ANA, nome: "Ana da Tela" } });
    // E o Bruno, que a pediu, não aparece cuidando de ligação nenhuma.
    expect(filaA.ligacoes.some((l) => l.ordem?.por?.id === BRUNO)).toBe(false);
  });

  it("CONTROLE — a ordem aberta há 5 s ainda acontece, e vem na linha", async () => {
    const { rows } = await pool.query<{ ha_s: number }>(
      `select extract(epoch from now() - created_at)::float8 as ha_s from public.voice_call_queue_orders
        where organization_id = $1 and voice_call_id = $2 and status = 'open'`,
      [ORG, L.aguardando2],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ha_s).toBeGreaterThanOrEqual(5);
    expect(rows[0]!.ha_s).toBeLessThan(VALIDADE_DA_ORDEM_DA_FILA_S);
    expect(de(filaA, L.aguardando2).ordem).toEqual({ tipo: "move", por: { id: CAIO, nome: CAIO_NA_FILA }, para_time_id: FINANCEIRO });
  });

  it("a ordem não duplica a linha da ligação, nem com uma encerrada e uma aberta na mesma", async () => {
    const { rows } = await pool.query<{ status: string; n: number }>(
      `select status, count(*)::int as n from public.voice_call_queue_orders
        where organization_id = $1 and voice_call_id = $2 group by status order by status`,
      [ORG, L.aguardando1],
    );
    expect(rows).toEqual([{ status: "ended", n: 1 }, { status: "open", n: 1 }]);
    expect(filaA.ligacoes.filter((l) => l.id === L.aguardando1)).toHaveLength(1);
    expect(filaA.ligacoes).toHaveLength(7);
  });

  it("a ordem de uma organização só aparece na fila dela", () => {
    expect(de(filaB, L.aguardandoDeB).ordem).toEqual({ tipo: "pull", por: { id: DANI, nome: "Dani de B" }, para_time_id: null });
    // Em A, ninguém de B pediu nada; em B, ninguém de A.
    expect(filaA.ligacoes.map((l) => l.ordem?.por?.id ?? null).filter(Boolean).sort()).toEqual([ANA, CAIO].sort());
    expect(filaB.ligacoes.map((l) => l.ordem?.por?.id ?? null)).toEqual([DANI]);
  });

  it("`agora` é o relógio do banco", async () => {
    const fila = await lerFilaDoTelefone(pool, ORG);
    const { rows } = await pool.query<{ agora: Date }>("select now() as agora");
    const diferenca = Math.abs(new Date(rows[0]!.agora).getTime() - new Date(fila.agora).getTime());
    expect(diferenca).toBeLessThan(2000);
    expect(fila.agora).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
