/**
 * [P1] A FILA DO TELEFONE PELA TELA — a aba "Telefone" do Inbox e a espera máxima
 * por time (fila visível, entrega 2; migration 0295; J44 do mapa de jornadas).
 *
 * Desenho: docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md (§4.2).
 *
 * O que só a tela prova, e esta spec mede:
 *  1. o ATENDENTE (papel agent) abre o Inbox e o trilho ganha a aba "Telefone",
 *     com o selo de quem ESPERA (3 — quem está em ligação ou ainda nos avisos não
 *     conta); a aba lista as ligações por seção — na fila POR ORDEM DE CHEGADA
 *     (a mais antiga é a 1ª, com o "cai em"), nos avisos, em ligação e as
 *     perdidas de há pouco —, no lugar da lista de conversas e da busca; clicar
 *     numa linha abre a conversa dela à direita; e, quando a fila anda (a 1ª
 *     desliga), a linha sai, a 2ª vira a 1ª e o selo cai para 2 — SEM recarregar
 *     a página. Nenhuma linha vaza da coluna (medido no elemento);
 *  2. o GERENTE (papel manager) troca a espera máxima do time em Configurações ›
 *     Times: o seletor mostra o que o banco tem, grava na hora (coluna
 *     `attendance_teams.phone_queue_max_wait_seconds` e auditoria
 *     `phone.queue_wait_changed`), e o valor VOLTA DO BANCO depois do reload;
 *  3. numa organização SEM número de telefone, na MESMA instalação, a aba não
 *     existe — e o link guardado (`?filter=phone`) diz o porquê em vez de
 *     mostrar uma fila vazia.
 *
 * As ligações são SEMEADAS em `voice_calls`, como o worker as deixa
 * (`marcarNaFila`, `marcarPrazoDaFila`, `marcarTocando`, `marcarAtendida` e
 * `encerrarLigacao`, em lib/channels/telefonia/repositorio.ts): a ligação de
 * verdade — Asterisk, ponte, toque — não existe no CI (nada escuta a porta da
 * ARI) e é provada na VPS. Esta spec prova a TELA e a rota que ela lê
 * (`GET /api/v1/telefonia/fila`), não que o worker escreva a fila: isso está em
 * unidade (`lib/channels/telefonia/controle.test.ts`) e no Postgres real
 * (`tests/invariants/telefonia-fila-visivel-repositorio.test.ts` e
 * `telefonia-fila-da-tela.test.ts`). As escritas da semeadura vão como o SISTEMA
 * (postgres): pela REST a linha do telefone é só-leitura (policy da 0288).
 *
 * Os instantes da semeadura são do relógio do BANCO (`now()` ± um intervalo, no
 * próprio INSERT): a tela mede a espera pelo relógio de lá, e semear pelo relógio
 * do runner poria a diferença entre os dois dentro da medida.
 *
 * ORGANIZAÇÃO PRÓPRIA, gerente e atendente sem MFA (a política padrão não exige),
 * como em `telefonia-gravacao.spec.ts`: nada daqui vaza para as vizinhas.
 *
 * ⚠️ ESTA SPEC EXIGE E2E_TELEFONIA=1: a rota da fila responde `ativa: false`
 * (e a aba não aparece) onde a instalação não oferece telefonia
 * (`TELEFONIA_ARI_URL`/`_PASSWORD` no .env.e2e). No CI, só a parte 3 —
 * `tests/unit/e2e-telefonia-so-na-parte-3.test.ts` prende.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { Pool } from "pg";

import { CHANNEL_PROVIDER_SIP_TRUNK } from "../../lib/channels/capabilities";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const EVIDENCIA = ".superpowers/evidence/telefonia-fila";

const SUFIXO = randomUUID().slice(0, 8);
const QUATRO_DIGITOS = String(1000 + Math.floor(Math.random() * 9000));
/** O time nasce com 10 minutos de espera máxima: o caso 2 lê esse valor na tela antes de trocá-lo. */
const TIME = { id: randomUUID(), nome: `Suporte Fila ${SUFIXO}`, esperaMaximaS: 600 };
const NUMERO = { id: randomUUID(), nome: `Número Fila ${SUFIXO}`, e164: `+55613003${QUATRO_DIGITOS}` };

test.use({ viewport: { width: 1440, height: 900 } });

let pool: Pool | undefined;
let orgId = "";
const gerente = { email: `fila-gerente-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "", nome: "Carla Gerente" };
const atendente = { email: `fila-atendente-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "", nome: "Bruno Atendente" };

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(texto: string, valores: unknown[] = []): Promise<T[]> {
  if (!pool) throw new Error("o pool do banco não subiu — o beforeAll falhou antes");
  return (await pool.query<T>(texto, valores)).rows;
}

async function criarUsuario(email: string, senha: string, nome: string): Promise<string> {
  const criado = await db.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { full_name: nome } });
  if (criado.error || !criado.data.user) throw criado.error ?? new Error(`usuário ${email} não foi criado`);
  return criado.data.user.id;
}

async function entrar(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//, { timeout: 30_000 });
}

/**
 * A EVIDÊNCIA VAI PARA O DISCO E PARA O RELATÓRIO, pelo CAMINHO do arquivo.
 *
 * `testInfo.attach(nome, { body })` guarda os bytes só na memória do resultado:
 * quem os grava é o reporter, e o CI roda com `--reporter=list`, que não grava
 * nada — o anexo sumiria. Com `path`, o Playwright COPIA o arquivo para
 * `test-results/<caso>/attachments/` com qualquer reporter (medido na 1.63:
 * `normalizeAndSaveAttachment`), que é a pasta que o job do e2e publica. A cópia
 * em `.superpowers/evidence/` é a de quem roda local, como nas specs vizinhas.
 */
async function anexarCaptura(page: Page, testInfo: TestInfo, nome: string): Promise<void> {
  const caminho = `${EVIDENCIA}/${nome}.png`;
  await page.screenshot({ path: caminho, fullPage: false });
  await testInfo.attach(nome, { path: caminho, contentType: "image/png" });
}

async function anexarJson(testInfo: TestInfo, nome: string, dados: unknown): Promise<void> {
  const caminho = `${EVIDENCIA}/${nome}.json`;
  writeFileSync(caminho, `${JSON.stringify(dados, null, 2)}\n`);
  await testInfo.attach(nome, { path: caminho, contentType: "application/json" });
}

/** "3:07" → 187. O relógio da aba é "m:ss" (`relogio`, em lib/telefonia/fila.ts). */
function segundos(relogio: string): number {
  const [m, s] = relogio.split(":").map(Number);
  return (m ?? 0) * 60 + (s ?? 0);
}

/**
 * Uma recebida do TELEFONE em `voice_calls`, como o worker a deixa. Os tempos
 * são segundos em relação ao `now()` do banco, no mesmo INSERT: `null` deixa a
 * coluna nula (`make_interval` é estrita — segundos nulos, instante nulo).
 */
async function semearLigacao(l: {
  id: string;
  ref: string;
  telefone: string;
  status: "ringing" | "connected" | "ended";
  comecouHaS: number;
  /** `queued_at`: há quanto passou a esperar por uma pessoa. `null` = ainda nos avisos. */
  naFilaHaS?: number | null;
  /** `queue_deadline_at`: em quanto a espera sem ninguém livre esgota (no FUTURO). */
  caiEmS?: number | null;
  atendidaHaS?: number | null;
  encerradaHaS?: number | null;
  motivo?: string | null;
  contatoId?: string | null;
  conversaId?: string | null;
  tocandoPara?: string | null;
  dono?: string | null;
}): Promise<void> {
  await sql(
    `insert into public.voice_calls
       (id, organization_id, channel_session_id, contact_id, provider, sip_call_ref, direction, peer_phone, status,
        started_at, queued_at, queue_deadline_at, answered_at, ended_at, end_reason,
        conversation_id, team_id, ringing_user_id, owner_user_id)
     values ($1, $2, $3, $4, 'sip_trunk', $5, 'inbound', $6, $7,
             now() - make_interval(secs => $8::double precision),
             now() - make_interval(secs => $9::double precision),
             now() + make_interval(secs => $10::double precision),
             now() - make_interval(secs => $11::double precision),
             now() - make_interval(secs => $12::double precision),
             $13, $14, $15, $16, $17)`,
    [
      l.id,
      orgId,
      NUMERO.id,
      l.contatoId ?? null,
      l.ref,
      l.telefone,
      l.status,
      l.comecouHaS,
      l.naFilaHaS ?? null,
      l.caiEmS ?? null,
      l.atendidaHaS ?? null,
      l.encerradaHaS ?? null,
      l.motivo ?? null,
      l.conversaId ?? null,
      TIME.id,
      l.tocandoPara ?? null,
      l.dono ?? null,
    ],
  );
}

async function criarContato(nome: string, telefone: string): Promise<string> {
  const [contato] = await sql<{ id: string }>(
    `insert into public.contacts (organization_id, display_name, phone_number, source) values ($1, $2, $3, 'phone_call') returning id`,
    [orgId, nome, telefone],
  );
  return contato!.id;
}

const contarAuditoria = async (acao: string, ator: string) =>
  (
    await sql<{ n: number }>(
      "select count(*)::int as n from api_audit_log where organization_id = $1 and action = $2 and actor_user_id = $3",
      [orgId, acao, ator],
    )
  )[0]?.n ?? 0;

test.describe("telefonia — a fila do telefone pela tela", () => {
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    mkdirSync(EVIDENCIA, { recursive: true });
    if (!(process.env.TELEFONIA_ARI_URL ?? "").trim() || !(process.env.TELEFONIA_ARI_PASSWORD ?? "").trim()) {
      throw new Error(
        "Esta spec precisa da telefonia oferecida: rode com E2E_TELEFONIA=1 (`E2E_TELEFONIA=1 pnpm e2e:env`). " +
          "O .env.e2e atual não tem TELEFONIA_ARI_URL/TELEFONIA_ARI_PASSWORD — no CI, só a parte 3 os recebe.",
      );
    }
    if (!credenciais.dbUrl) throw new Error("SUPABASE_DB_URL ausente — rode `pnpm e2e:env` de novo.");
    pool = new Pool({ connectionString: credenciais.dbUrl, max: 2 });

    gerente.id = await criarUsuario(gerente.email, gerente.senha, gerente.nome);
    atendente.id = await criarUsuario(atendente.email, atendente.senha, atendente.nome);
    const org = await db
      .from("organizations")
      .insert({
        display_name: `Provedor Fila ${SUFIXO}`,
        legal_name: `Provedor Fila ${SUFIXO}`,
        slug: `fila-${SUFIXO}`,
        onboarded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id as string;
    for (const [usuario, papel] of [
      [gerente.id, "manager"],
      [atendente.id, "agent"],
    ] as const) {
      const vinculo = await db.from("user_organizations").insert({
        organization_id: orgId,
        user_id: usuario,
        role: papel,
        accepted_at: new Date().toISOString(),
      });
      if (vinculo.error) throw vinculo.error;
    }
    // Times por SQL, como na spec da URA: `attendance_teams` só aceita escrita pela RPC de gestor com MFA.
    // A espera máxima já nasce gravada (10 min): é o que a rota da fila devolve como teto do time.
    await sql(
      `insert into public.attendance_teams (id, organization_id, name, slug, phone_queue_max_wait_seconds)
       values ($1, $2, $3, $4, $5)`,
      [TIME.id, orgId, TIME.nome, `suporte-fila-${SUFIXO}`, TIME.esperaMaximaS],
    );
    for (const usuario of [gerente.id, atendente.id]) {
      await sql(`insert into public.attendance_team_members (organization_id, team_id, user_id) values ($1, $2, $3)`, [
        orgId,
        TIME.id,
        usuario,
      ]);
    }

    // O número da operadora (nada escuta a ARI: a senha não importa). É ele que
    // faz a rota da fila dizer `ativa: true` para esta organização.
    await sql(
      `insert into public.channel_sessions
         (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
          sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_team_id)
       values ($1, $2, $3, decode('00', 'hex'), 'WORKING', $4, $5,
               'voip.e2e-fila.com.br', 5060, 'udp', $6, decode('00', 'hex'), $7)`,
      [NUMERO.id, orgId, CHANNEL_PROVIDER_SIP_TRUNK, NUMERO.nome, NUMERO.e164, `fila${SUFIXO}`, TIME.id],
    );
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      if (orgId) {
        // Nenhuma ligação "viva" fica para trás (o caso 1 deixa quatro), e o número sai de cena.
        await sql(
          `update public.voice_calls set status = 'ended', ended_at = now(), end_reason = 'cliente_desligou', ringing_user_id = null
            where organization_id = $1 and status <> 'ended'`,
          [orgId],
        );
        await sql(`update public.channel_sessions set archived_at = now() where id = $1 and organization_id = $2`, [NUMERO.id, orgId]);
      }
    } finally {
      await pool.end();
      pool = undefined;
    }
  });

  test("a aba Telefone mostra quem espera, por ordem de chegada, e atualiza sozinha quando a fila anda", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    // Contatos, conversas e ligações PRÓPRIOS do caso, gerados aqui dentro.
    const marcaDoCaso = randomUUID().slice(0, 6);
    const A = { id: randomUUID(), nome: `Cliente da Fila ${marcaDoCaso}`, telefone: `+55619903${QUATRO_DIGITOS}` };
    const B = { id: randomUUID(), telefone: `+55619904${QUATRO_DIGITOS}` };
    const C = { id: randomUUID(), telefone: `+55619905${QUATRO_DIGITOS}` };
    const D = { id: randomUUID(), nome: `Cliente em Ligação ${marcaDoCaso}`, telefone: `+55619906${QUATRO_DIGITOS}` };
    const E = { id: randomUUID(), nome: `Cliente Perdido ${marcaDoCaso}`, telefone: `+55619907${QUATRO_DIGITOS}` };
    const F = { id: randomUUID(), telefone: `+55619908${QUATRO_DIGITOS}` };

    // A — aguardando há 3 min, a mais antiga; a espera esgota em 7 (3 + 7 = os
    // 10 min do time). Com contato e conversa: a conversa como
    // `acharOuCriarConversa` a deixa (aberta, no time, sem dono).
    const contatoA = await criarContato(A.nome, A.telefone);
    const [conversaA] = await sql<{ id: string }>(
      `insert into public.conversations
         (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, team_id)
       values ($1, $2, $3, 'phone', 'open', false, 0, $4) returning id`,
      [orgId, contatoA, NUMERO.id, TIME.id],
    );
    await semearLigacao({
      id: A.id,
      ref: `canal-fila-${SUFIXO}-a`,
      telefone: A.telefone,
      status: "ringing",
      comecouHaS: 200,
      naFilaHaS: 180,
      caiEmS: 420,
      contatoId: contatoA,
      conversaId: conversaA!.id,
    });
    // B — aguardando há 1 min (a segunda), sem contato: a linha mostra o número.
    await semearLigacao({ id: B.id, ref: `canal-fila-${SUFIXO}-b`, telefone: B.telefone, status: "ringing", comecouHaS: 75, naFilaHaS: 60, caiEmS: 540 });
    // C — na fila há 30 s e TOCANDO para a gerente (com alguém tocando não há prazo).
    await semearLigacao({
      id: C.id,
      ref: `canal-fila-${SUFIXO}-c`,
      telefone: C.telefone,
      status: "ringing",
      comecouHaS: 40,
      naFilaHaS: 30,
      tocandoPara: gerente.id,
    });
    // D — em ligação com o atendente, como `ramalAtendeu` deixa: a conversa
    // atribuída a quem atendeu (`claimed`). É também a conversa das "Minhas" dele.
    const contatoD = await criarContato(D.nome, D.telefone);
    const [conversaD] = await sql<{ id: string }>(
      `insert into public.conversations
         (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee,
          team_id, assignee_kind, assigned_to_user_id, assigned_to_user_name, last_message_at, last_message_preview)
       values ($1, $2, $3, 'phone', 'claimed', false, 0, $4, 'user', $5, $6, now(), $7) returning id`,
      [orgId, contatoD, NUMERO.id, TIME.id, atendente.id, atendente.nome, `Ligação em andamento com ${atendente.nome}`],
    );
    await semearLigacao({
      id: D.id,
      ref: `canal-fila-${SUFIXO}-d`,
      telefone: D.telefone,
      status: "connected",
      comecouHaS: 150,
      naFilaHaS: 140,
      atendidaHaS: 120,
      contatoId: contatoD,
      conversaId: conversaD!.id,
      dono: atendente.id,
    });
    // E — perdida há 5 min: esperou 2 min na fila e a espera esgotou.
    const contatoE = await criarContato(E.nome, E.telefone);
    await semearLigacao({
      id: E.id,
      ref: `canal-fila-${SUFIXO}-e`,
      telefone: E.telefone,
      status: "ended",
      comecouHaS: 450,
      naFilaHaS: 420,
      encerradaHaS: 300,
      motivo: "fila_esgotada",
      contatoId: contatoE,
    });
    // F — acabou de chegar e ainda ouve os avisos (`queued_at` nulo): aparece em
    // "No menu" e NÃO conta no selo, que é só de quem espera por uma pessoa.
    await semearLigacao({ id: F.id, ref: `canal-fila-${SUFIXO}-f`, telefone: F.telefone, status: "ringing", comecouHaS: 8 });

    await entrar(page, atendente.email, atendente.senha);
    await page.goto("/app/inbox");

    const trilho = page.getByTestId("inbox-abas");
    const abaTelefone = trilho.getByRole("tab", { name: "Telefone", exact: true });
    const busca = page.getByRole("textbox", { name: "Buscar conversas" });
    const coluna = page.getByTestId("fila-do-telefone");
    const naFila = coluna.locator('[data-secao="na-fila"]');
    const linhasNaFila = naFila.locator("[data-ligacao-id]");
    const linha = (id: string) => coluna.locator(`[data-ligacao-id="${id}"]`);
    /** O selo da posição na linha: "1º", com o nome acessível "Posição 1 na fila". */
    const posicaoNaLinha = (daLinha: Locator, posicao: number) => daLinha.locator(`[aria-label="Posição ${posicao} na fila"]`);
    const chipDoTime = (esperando: number) =>
      page
        .getByTestId("chips-da-fila")
        .getByRole("button", { name: `Filtrar por time: ${TIME.nome} (${esperando} na fila)`, exact: true });

    await test.step("o trilho ganha a aba Telefone, com o selo de quem espera", async () => {
      await expect(trilho).toBeVisible({ timeout: 30_000 });
      await expect(abaTelefone).toBeVisible({ timeout: 30_000 });
      // A, B e C esperam por alguém; D (em ligação) e F (nos avisos) não entram na conta.
      await expect(abaTelefone).toHaveText("3");
      // Controle do "a busca some" de logo abaixo: fora da aba Telefone ela existe.
      await expect(busca).toBeVisible();
    });

    await test.step("a aba lista as ligações por seção, a fila por ordem de chegada, no lugar das conversas", async () => {
      await abaTelefone.click();
      await expect(page).toHaveURL(/[?&]filter=phone\b/);
      await expect(abaTelefone).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("inbox-aba-atual")).toHaveText("Telefone");
      await expect(coluna).toBeVisible({ timeout: 20_000 });

      // NA FILA: a ordem é a de chegada (`queued_at`) — A (3 min), B (1 min), C (30 s).
      await expect(naFila.getByRole("heading", { name: "Na fila, por ordem de chegada" })).toBeVisible();
      await expect(linhasNaFila).toHaveCount(3);
      const ordemDeChegada = [
        { id: A.id, fase: "aguardando" },
        { id: B.id, fase: "aguardando" },
        { id: C.id, fase: "tocando" },
      ];
      for (const [i, esperado] of ordemDeChegada.entries()) {
        await expect(linhasNaFila.nth(i)).toHaveAttribute("data-ligacao-id", esperado.id);
        await expect(linhasNaFila.nth(i)).toHaveAttribute("data-fase", esperado.fase);
        await expect(posicaoNaLinha(linhasNaFila.nth(i), i + 1)).toHaveText(`${i + 1}º`);
      }

      // A primeira: o nome do contato, há quanto espera e em quanto a espera esgota.
      await expect(linha(A.id)).toContainText(A.nome);
      const estadoDeA = linha(A.id).getByTestId("estado-da-ligacao");
      await expect(estadoDeA).toHaveText(/^Aguardando há \d+:\d{2} · cai em \d+:\d{2}$/);
      // 7 min de 10 ainda pela frente: a espera não pesa (vira "atenção" quando resta metade do teto do time ou menos).
      await expect(estadoDeA).toHaveAttribute("data-urgencia", "normal");
      const lido = /^Aguardando há (\d+:\d{2}) · cai em (\d+:\d{2})$/.exec((await estadoDeA.textContent()) ?? "");
      expect(lido, "o estado da 1ª da fila não veio no formato esperado").not.toBeNull();
      const esperou = segundos(lido![1]!);
      const falta = segundos(lido![2]!);
      // Semeada com 3 min de espera e 7 de prazo. A folga de 5 s para baixo cobre
      // o atraso entre a hora lida do banco e o relógio da tela; a de 2 min para
      // cima, o tempo do login e da carga.
      expect(esperou, "a espera da 1ª da fila sai do relógio do banco (semeada com 3 min)").toBeGreaterThanOrEqual(175);
      expect(esperou).toBeLessThan(300);
      expect(falta, "o 'cai em' da 1ª da fila sai do prazo gravado (semeado em 7 min)").toBeLessThanOrEqual(425);
      expect(falta).toBeGreaterThan(300);
      // Os dois números saem do MESMO relógio, no mesmo desenho: somados dão o
      // teto do time (600 s), a menos do segundo que os dois arredondamentos comem.
      expect(esperou + falta, "o que esperou mais o que falta é a espera máxima do time").toBeGreaterThanOrEqual(TIME.esperaMaximaS - 1);
      expect(esperou + falta).toBeLessThanOrEqual(TIME.esperaMaximaS);

      // A terceira toca para alguém: diz para quem, e não tem prazo.
      const estadoDeC = linha(C.id).getByTestId("estado-da-ligacao");
      await expect(estadoDeC).toHaveText(new RegExp(`^Tocando para ${gerente.nome} · na fila há \\d+:\\d{2}$`));
      await expect(estadoDeC).not.toContainText("cai em");

      // NO MENU: quem ainda ouve os avisos.
      const noMenu = coluna.locator('[data-secao="no-menu"] [data-ligacao-id]');
      await expect(noMenu).toHaveCount(1);
      await expect(noMenu).toHaveAttribute("data-ligacao-id", F.id);
      await expect(noMenu).toHaveAttribute("data-fase", "avisos");
      await expect(noMenu.getByTestId("estado-da-ligacao")).toHaveText(/^Ouvindo os avisos · \d+:\d{2}$/);

      // EM LIGAÇÃO: com quem.
      const emLigacao = coluna.locator('[data-secao="em-ligacao"] [data-ligacao-id]');
      await expect(emLigacao).toHaveCount(1);
      await expect(emLigacao).toHaveAttribute("data-ligacao-id", D.id);
      await expect(emLigacao).toHaveAttribute("data-fase", "em_ligacao");
      await expect(emLigacao).toContainText(D.nome);
      await expect(emLigacao.getByTestId("estado-da-ligacao")).toHaveText(new RegExp(`^Com ${atendente.nome} há \\d+:\\d{2}$`));

      // PERDIDAS: o motivo por extenso e quanto esperou (7 min − 5 min = 2:00, os dois instantes do mesmo INSERT).
      const perdidas = coluna.locator('[data-secao="perdidas"] [data-perdida-id]');
      await expect(perdidas).toHaveCount(1);
      await expect(perdidas).toHaveAttribute("data-perdida-id", E.id);
      await expect(perdidas).toHaveAttribute("data-motivo", "fila_esgotada");
      await expect(perdidas).toContainText(E.nome);
      await expect(perdidas).toContainText(/A fila esgotou · esperou 2:00 · há \d+ min/);

      // Os chips contam o mesmo que o selo, e o do time traz o relógio da mais antiga.
      await expect(chipDoTime(3)).toBeVisible();
      await expect(chipDoTime(3).getByTestId("chip-espera")).toHaveText(/^\d+:\d{2}$/);
      // Um número só na organização: não há seletor de número.
      await expect(page.getByTestId("fila-numero")).toHaveCount(0);

      // E a coluna é das LIGAÇÕES: nem a busca, nem os filtros, nem a lista de
      // conversas (a de D está nas "Minhas" dele — o último passo confere).
      await expect(busca).toHaveCount(0);
      await expect(page.getByTestId("inbox-abrir-filtros")).toHaveCount(0);
      await expect(page.locator("[data-conversation-id]")).toHaveCount(0);
    });

    await test.step("nenhuma linha vaza da coluna (medido no elemento)", async () => {
      // O mouse sai de cima do trilho: sem dica de aba nem realce de linha na captura.
      await page.getByTestId("inbox-aba-atual").hover();
      const medidas = await page.evaluate(() => {
        const col = document.querySelector<HTMLElement>('[data-testid="fila-do-telefone"]');
        if (!col) return null;
        const caixa = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { esquerda: r.left, direita: r.right, topo: r.top, largura: r.width, altura: r.height };
        };
        return {
          viewport: { largura: window.innerWidth, altura: window.innerHeight },
          coluna: {
            ...caixa(col),
            scrollWidth: col.scrollWidth,
            clientWidth: col.clientWidth,
            scrollHeight: col.scrollHeight,
            clientHeight: col.clientHeight,
          },
          linhas: Array.from(col.querySelectorAll<HTMLElement>("[data-ligacao-id], [data-perdida-id]")).map((el) => ({
            secao: el.closest<HTMLElement>("[data-secao]")?.dataset.secao ?? null,
            id: el.dataset.ligacaoId ?? el.dataset.perdidaId ?? null,
            fase: el.dataset.fase ?? el.dataset.motivo ?? null,
            ...caixa(el),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            // Informativo, não afirmado: o que a reticência cortou nesta largura (o nome e a linha de detalhes truncam de propósito).
            cortados: Array.from(el.querySelectorAll<HTMLElement>(".truncate"))
              .filter((s) => s.scrollWidth > s.clientWidth)
              .map((s) => s.textContent ?? ""),
            estado: el.querySelector('[data-testid="estado-da-ligacao"]')?.textContent ?? null,
          })),
        };
      });
      expect(medidas, "a coluna da fila não foi achada para medir").not.toBeNull();
      await anexarJson(testInfo, "medidas", medidas);

      // A coluna não rola para o lado.
      expect(medidas!.coluna.scrollWidth, "a coluna da fila ganhou rolagem horizontal").toBeLessThanOrEqual(medidas!.coluna.clientWidth);
      const daFila = medidas!.linhas.filter((l) => l.secao === "na-fila");
      expect(daFila, "as três linhas da fila entram na medida").toHaveLength(3);
      for (const l of daFila) {
        expect(l.scrollWidth, `o texto da linha ${l.id} (${l.fase}) vaza da linha`).toBeLessThanOrEqual(l.clientWidth);
        expect(l.direita, `a linha ${l.id} (${l.fase}) passa da borda direita da coluna`).toBeLessThanOrEqual(medidas!.coluna.direita + 1);
        expect(l.altura, `a linha ${l.id} (${l.fase}) não tem altura`).toBeGreaterThan(0);
      }
      await anexarCaptura(page, testInfo, "fila-aba-telefone");
    });

    await test.step("clicar na linha abre a conversa dela à direita", async () => {
      await linha(A.id).click();
      // O cabeçalho da conversa é o `h2` com o nome do contato (o título da aba é o outro `h2`, "Telefone").
      await expect(page.getByRole("heading", { level: 2, name: A.nome, exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("chat-thread")).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByText("Conversa de telefone: as ligações ficam registradas aqui. Para falar com o cliente, ligue."),
      ).toBeVisible();
      // A linha fica marcada, e a aba continua sendo a do telefone — a fila não saiu da tela.
      await expect(linha(A.id)).toHaveAttribute("aria-current", "true");
      await expect(page.getByTestId("inbox-aba-atual")).toHaveText("Telefone");
      await expect(linhasNaFila).toHaveCount(3);
      await page.getByTestId("inbox-aba-atual").hover();
      await anexarCaptura(page, testInfo, "fila-conversa-aberta");
    });

    await test.step("a fila anda: a 1ª sai, a 2ª vira a 1ª e o selo cai para 2 — sem recarregar", async () => {
      // Uma marca na janela: um recarregamento a apagaria. É o que sustenta o "sem recarregar".
      const marca = randomUUID();
      await page.evaluate((m) => {
        (window as unknown as { __paginaDaFila?: string }).__paginaDaFila = m;
      }, marca);

      // O cliente desliga na fila — o UPDATE de `encerrarLigacao`.
      const desde = Date.now();
      const encerradas = await sql<{ id: string }>(
        `update public.voice_calls
            set status = 'ended', ended_at = now(), end_reason = 'cliente_desligou', ringing_user_id = null
          where id = $1 and organization_id = $2 and status <> 'ended'
          returning id`,
        [A.id, orgId],
      );
      expect(encerradas, "o fim encerra UMA ligação: a 1ª da fila").toHaveLength(1);

      // Chega pelo tempo real de `voice_calls` (juntado em até ~2 s) ou, de
      // segurança, pela releitura de 15 s do hook: o teto cobre os dois.
      await expect(naFila.locator(`[data-ligacao-id="${A.id}"]`)).toHaveCount(0, { timeout: 25_000 });
      await anexarJson(testInfo, "tempo-ate-a-fila-andar", {
        demorou_ms: Date.now() - desde,
        como_ler: "até ~5 s: chegou pelo tempo real; perto de 15 s: foi a releitura de segurança do hook",
      });
      await expect(linhasNaFila).toHaveCount(2);
      await expect(linhasNaFila.nth(0)).toHaveAttribute("data-ligacao-id", B.id);
      await expect(posicaoNaLinha(linhasNaFila.nth(0), 1)).toHaveText("1º");
      await expect(linhasNaFila.nth(1)).toHaveAttribute("data-ligacao-id", C.id);
      await expect(posicaoNaLinha(linhasNaFila.nth(1), 2)).toHaveText("2º");
      await expect(abaTelefone).toHaveText("2");
      await expect(chipDoTime(2)).toBeVisible();
      // Quem desligou esperando não some: vira a perdida mais recente, com o motivo.
      const perdidas = coluna.locator('[data-secao="perdidas"] [data-perdida-id]');
      await expect(perdidas).toHaveCount(2);
      await expect(perdidas.nth(0)).toHaveAttribute("data-perdida-id", A.id);
      await expect(perdidas.nth(0)).toHaveAttribute("data-motivo", "desistiu_na_fila");
      await expect(perdidas.nth(0)).toContainText("Desistiu na fila");

      expect(
        await page.evaluate(() => (window as unknown as { __paginaDaFila?: string }).__paginaDaFila),
        "a página foi recarregada no meio do caso — a fila tinha de andar sozinha",
      ).toBe(marca);
      await page.getByTestId("inbox-aba-atual").hover();
      await anexarCaptura(page, testInfo, "fila-depois-de-andar");
    });

    await test.step("controle: fora da aba Telefone a lista de conversas e a busca voltam", async () => {
      // A consulta de fundo da aba Telefone é a das "Minhas": a conversa de D
      // estava carregada o tempo todo, e a aba não a desenhou.
      await trilho.getByRole("tab", { name: "Minhas", exact: true }).click();
      await expect(page.getByTestId("inbox-aba-atual")).toHaveText("Minhas");
      await expect(busca).toBeVisible();
      await expect(page.locator(`[data-conversation-id="${conversaD!.id}"]`)).toBeVisible({ timeout: 20_000 });
      await expect(coluna).toHaveCount(0);
    });
  });

  test("o gerente escolhe a espera máxima do time em Configurações › Times", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await entrar(page, gerente.email, gerente.senha);

    // Pela porta, como em `times-de-atendimento.spec.ts`.
    await page.goto("/app/settings");
    await page.getByRole("link", { name: /Times de atendimento/i }).click();
    await page.waitForURL(/\/app\/settings\/teams/);
    await expect(page.getByTestId("painel-de-times")).toBeVisible({ timeout: 30_000 });

    const cartao = page.locator(`[data-espera-da-fila="${TIME.id}"]`);
    await expect(cartao).toBeVisible({ timeout: 20_000 });
    await expect(cartao.getByRole("heading", { name: "Fila do telefone" })).toBeVisible();
    const seletor = cartao.getByRole("combobox", { name: "Espera máxima" });
    // O que o banco tem (600 s), e não o padrão do produto.
    await expect(seletor).toHaveText("10 minutos");
    expect(await contarAuditoria("phone.queue_wait_changed", gerente.id)).toBe(0);

    await seletor.click();
    // `exact`: "15 minutos" contém "5 minutos".
    await page.getByRole("option", { name: "5 minutos", exact: true }).click();
    await expect(page.getByText("Espera máxima do telefone salva.")).toBeVisible({ timeout: 20_000 });
    await expect(seletor).toHaveText("5 minutos");

    const [time] = await sql<{ espera: number | null }>(
      "select phone_queue_max_wait_seconds as espera from attendance_teams where id = $1 and organization_id = $2",
      [TIME.id, orgId],
    );
    expect(time?.espera).toBe(300);
    await expect.poll(() => contarAuditoria("phone.queue_wait_changed", gerente.id), { timeout: 10_000 }).toBe(1);

    await cartao.scrollIntoViewIfNeeded();
    await anexarCaptura(page, testInfo, "espera-maxima-do-time");

    // VOLTA DO BANCO: recarrega e o seletor continua em 5 minutos — não era só o estado do React.
    await page.reload();
    await expect(page.getByTestId("painel-de-times")).toBeVisible({ timeout: 30_000 });
    await expect(cartao.getByRole("combobox", { name: "Espera máxima" })).toHaveText("5 minutos", { timeout: 20_000 });
  });

  test("sem número de telefone na organização a aba não existe", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    // Uma SEGUNDA organização, na mesma instalação (com a telefonia oferecida),
    // sem número nenhum: a diferença para o caso 1 é só essa. O mesmo papel de lá.
    const marcaDoCaso = randomUUID().slice(0, 8);
    const semNumero = { email: `fila-sem-numero-${marcaDoCaso}@invariant.test`, senha: `Local-${randomUUID()}!` };
    const usuario = await criarUsuario(semNumero.email, semNumero.senha, "Dora Atendente");
    const outra = await db
      .from("organizations")
      .insert({
        display_name: `Provedor Sem Telefone ${marcaDoCaso}`,
        legal_name: `Provedor Sem Telefone ${marcaDoCaso}`,
        slug: `sem-telefone-${marcaDoCaso}`,
        onboarded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (outra.error) throw outra.error;
    const vinculo = await db.from("user_organizations").insert({
      organization_id: outra.data.id as string,
      user_id: usuario,
      role: "agent",
      accepted_at: new Date().toISOString(),
    });
    if (vinculo.error) throw vinculo.error;

    await entrar(page, semNumero.email, semNumero.senha);
    // O controle da ausência: a aba só nasce DEPOIS de a rota responder. Sem
    // esperar a resposta, "não há aba" passaria também com a leitura ainda no ar.
    const [resposta] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/telefonia/fila" && r.request().method() === "GET", {
        timeout: 30_000,
      }),
      page.goto("/app/inbox"),
    ]);
    expect(resposta.status()).toBe(200);
    const corpo = (await resposta.json()) as { data: { ativa: boolean } };
    expect(corpo.data.ativa, "organização sem número: a rota da fila tem de dizer `ativa: false`").toBe(false);

    const trilho = page.getByTestId("inbox-abas");
    await expect(trilho.getByRole("tab", { name: "Fila", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(trilho.getByRole("tab", { name: "Telefone", exact: true })).toHaveCount(0);
    await anexarCaptura(page, testInfo, "trilho-sem-telefone");

    // O link guardado: a coluna diz o porquê, e a aba segue fora do trilho.
    await page.goto("/app/inbox?filter=phone");
    await expect(page.getByText("O telefone não está ligado nesta organização.")).toBeVisible({ timeout: 30_000 });
    await expect(trilho.getByRole("tab", { name: "Fila", exact: true })).toBeVisible();
    await expect(trilho.getByRole("tab", { name: "Telefone", exact: true })).toHaveCount(0);
  });
});
