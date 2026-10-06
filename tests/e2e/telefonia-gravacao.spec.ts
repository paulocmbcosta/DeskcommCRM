/**
 * [P0] GRAVAÇÃO DAS LIGAÇÕES PELA TELA — a F3 da telefonia (DYD-53, J37 do mapa de jornadas).
 *
 * Desenho: docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md.
 *
 * O que só a tela prova, e esta spec mede:
 *  1. o ADMIN abre Conexões › Telefone › Gravação, vê o aviso de gravação pronto
 *     (com o texto), liga a gravação, escolhe "1 ano" e salva — e o banco guarda
 *     a política, com a auditoria `phone.recording_settings_changed`;
 *  2. o ATENDENTE (papel agent, do time da conversa) abre a conversa de telefone,
 *     vê no cartão da ligação "Ouvir a gravação · 0:01", clica, e o `<audio>`
 *     carrega a URL assinada do Storage e TOCA (duração medida no elemento, não a
 *     olho); a auditoria ganha UMA `phone.recording_listened` com ele como ator;
 *  3. a rota genérica de mídia NÃO serve a gravação (404) — só a escuta auditada;
 *  4. a ligação FEITA que ninguém atendeu (migration 0294, J42) diz no selo quem
 *     ligou e, embaixo, quanto o telefone do cliente chamou e quem encerrou —
 *     "Chamou 4 s · desligada por quem ligou", "Chamou 38 s · ninguém atendeu"
 *     e, sem sinal de toque da rede, "Desligada por quem ligou após 40 s" —,
 *     cada frase numa linha só (medido no elemento); e uma mensagem comum com o
 *     metadado de ligação PLANTADO não vira cartão.
 *
 * A ligação e a gravação são SEMEADAS (voice_calls `stored` + a mensagem da
 * ligação + o arquivo no Storage local), como o worker as deixa ao fim do
 * processamento: a ligação de verdade — Asterisk, ponte, ffmpeg — não existe no
 * CI (nada escuta a porta da ARI) e é provada na VPS. As escritas da semeadura
 * vão como o SISTEMA (postgres/service role): pela REST, com o JWT de um membro,
 * a mensagem da ligação é recusada pelo trigger da 0289. O processamento está em
 * unidade (`lib/channels/telefonia/gravacoes.test.ts`) e o SQL no Postgres real
 * (`tests/invariants/telefonia-gravacao.test.ts`).
 *
 * ORGANIZAÇÃO PRÓPRIA, admin e atendente sem MFA (a política padrão não exige),
 * como em `telefonia-ura-e-falas.spec.ts`: nada daqui vaza para as vizinhas.
 *
 * ⚠️ ESTA SPEC EXIGE E2E_TELEFONIA=1: a aba Gravação só aparece onde a instalação
 * oferece telefonia (`TELEFONIA_ARI_URL`/`_PASSWORD` no .env.e2e). No CI, só a
 * parte 3 — `tests/unit/e2e-telefonia-so-na-parte-3.test.ts` prende.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import { CHANNEL_PROVIDER_SIP_TRUNK } from "../../lib/channels/capabilities";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const EVIDENCIA = ".superpowers/evidence/telefonia";

const SUFIXO = randomUUID().slice(0, 8);
const QUATRO_DIGITOS = String(1000 + Math.floor(Math.random() * 9000));
const TIME = { id: randomUUID(), nome: `Suporte Gravação ${SUFIXO}` };
const NUMERO = { id: randomUUID(), nome: `Número Gravação ${SUFIXO}`, e164: `+55613002${QUATRO_DIGITOS}` };
const AVISO = { id: randomUUID(), texto: "Esta ligação poderá ser gravada para garantir a qualidade do atendimento." };
const LIGACAO = randomUUID();
/**
 * As feitas sem resposta (0294): o toque de 4 s que o atendente desligou, a de
 * 38 s que a rede encerrou, e a que o atendente desligou depois de 40 s sem a
 * rede avisar que o telefone chamava (`toqueMs` nulo: sem instante de toque).
 */
const SEM_RESPOSTA: ReadonlyArray<{ id: string; motivo: string; toqueMs: number | null; tentativaMs: number; fim: string; frase: string }> = [
  { id: randomUUID(), motivo: "atendente_desligou", toqueMs: 4_200, tentativaMs: 6_000, fim: "atendente_desligou", frase: "Chamou 4 s · desligada por quem ligou" },
  { id: randomUUID(), motivo: "sem_resposta_19", toqueMs: 38_000, tentativaMs: 40_000, fim: "ninguem_atendeu", frase: "Chamou 38 s · ninguém atendeu" },
  { id: randomUUID(), motivo: "atendente_desligou", toqueMs: null, tentativaMs: 40_000, fim: "atendente_desligou", frase: "Desligada por quem ligou após 40 s" },
];
/** O que alguém plantaria numa mensagem comum para forjar um cartão de ligação. */
const PLANTADA = "Chamou 45 s · ninguém atendeu";

test.use({
  viewport: { width: 1440, height: 900 },
  // O "Ouvir" é um clique de verdade; a flag só tira a política de autoplay do
  // caminho para a medida "tocou" não depender de o CI contar o clique como gesto
  // (o mesmo mecanismo de `telefonia-ura-e-falas.spec.ts`).
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

let pool: Pool | undefined;
let orgId = "";
let conversaId = "";
let mensagemId = "";
const admin = { email: `grav-admin-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "" };
const atendente = { email: `grav-atendente-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "" };

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
 * Um segundo de tom (440 Hz) em MP3 mono 16 kHz 24 kbps — gerado pelo MESMO
 * ffmpeg do Alpine que o worker usa (`conversorFfmpeg`), com os mesmos parâmetros:
 * `ffmpeg -f lavfi -i sine=frequency=440:duration=1 -ac 1 -ar 16000 -c:a libmp3lame -b:a 24k`.
 */
const UM_SEGUNDO_DE_MP3 = Buffer.from(
  "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",
  "base64",
);

const contarAuditoria = async (acao: string, ator: string) =>
  (
    await sql<{ n: number }>(
      "select count(*)::int as n from api_audit_log where organization_id = $1 and action = $2 and actor_user_id = $3",
      [orgId, acao, ator],
    )
  )[0]?.n ?? 0;

test.describe("telefonia — gravação das ligações pela tela", () => {
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

    admin.id = await criarUsuario(admin.email, admin.senha, "Ana Gestora");
    atendente.id = await criarUsuario(atendente.email, atendente.senha, "Bruno Atendente");
    const org = await db
      .from("organizations")
      .insert({
        display_name: `Provedor Gravação ${SUFIXO}`,
        legal_name: `Provedor Gravação ${SUFIXO}`,
        slug: `gravacao-${SUFIXO}`,
        onboarded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id as string;
    for (const [usuario, papel] of [
      [admin.id, "admin"],
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
    await sql(`insert into public.attendance_teams (id, organization_id, name, slug) values ($1, $2, $3, $4)`, [
      TIME.id,
      orgId,
      TIME.nome,
      `suporte-gravacao-${SUFIXO}`,
    ]);
    await sql(`insert into public.attendance_team_members (organization_id, team_id, user_id) values ($1, $2, $3)`, [
      orgId,
      TIME.id,
      atendente.id,
    ]);

    // O número da operadora (nada escuta a ARI: a senha não importa).
    await sql(
      `insert into public.channel_sessions
         (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
          sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_team_id)
       values ($1, $2, $3, decode('00', 'hex'), 'WORKING', $4, $5,
               'voip.e2e-gravacao.com.br', 5060, 'udp', $6, decode('00', 'hex'), $7)`,
      [NUMERO.id, orgId, CHANNEL_PROVIDER_SIP_TRUNK, NUMERO.nome, NUMERO.e164, `grav${SUFIXO}`, TIME.id],
    );

    // O aviso de gravação PRONTO — como o "Salvar e usar" de Voz e falas o deixa.
    const hash = randomUUID().replace(/-/g, "").padEnd(64, "a").slice(0, 64);
    await sql(
      `insert into public.phone_prompts
         (id, organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status)
       values ($1, $2, 'recording_notice', $3, 'voz-e2e', 'eleven_multilingual_v2', $4, $5, 2500, 'ready')`,
      [AVISO.id, orgId, AVISO.texto, hash, `${orgId}/${hash}.ulaw`],
    );
    await sql(`insert into public.phone_settings (organization_id, recording_notice_prompt_id) values ($1, $2)`, [orgId, AVISO.id]);

    // A conversa de telefone do cliente, no time e com o atendente — e uma ligação
    // atendida, GRAVADA e já guardada, como o worker a deixa.
    const [contato] = await sql<{ id: string }>(
      `insert into public.contacts (organization_id, display_name, phone_number, source) values ($1, 'Cliente da Gravação', $2, 'phone_call') returning id`,
      [orgId, `+55619901${QUATRO_DIGITOS}`],
    );
    const [conversa] = await sql<{ id: string }>(
      `insert into public.conversations
         (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee,
          team_id, assignee_kind, assigned_to_user_id, assigned_to_user_name)
       values ($1, $2, $3, 'phone', 'open', false, 0, $4, 'user', $5, 'Bruno Atendente') returning id`,
      [orgId, contato!.id, NUMERO.id, TIME.id, atendente.id],
    );
    conversaId = conversa!.id;
    await sql(
      `insert into public.voice_calls
         (id, organization_id, channel_session_id, contact_id, provider, sip_call_ref, direction, peer_phone, status,
          started_at, answered_at, ended_at, duration_ms, conversation_id, team_id, owner_user_id,
          recording_status, recording_notice_at, end_reason)
       values ($1, $2, $3, $4, 'sip_trunk', $5, 'inbound', $6, 'ended',
               now() - interval '2 minutes', now() - interval '90 seconds', now() - interval '89 seconds', 1000, $7, $8, $9,
               'stored', now() - interval '2 minutes', 'cliente_desligou')`,
      [LIGACAO, orgId, NUMERO.id, contato!.id, `canal-grav-${SUFIXO}`, `+55619901${QUATRO_DIGITOS}`, conversaId, TIME.id, atendente.id],
    );
    const [mensagem] = await sql<{ id: string }>(
      `insert into public.messages
         (organization_id, conversation_id, contact_id, channel_session_id, external_id, direction, type, body,
          sent_via, status, metadata)
       values ($1, $2, $3, $4, $5, 'outbound', 'system', 'Ligação recebida, atendida por Bruno Atendente · 1 s', 'system', 'sent', $6)
       returning id`,
      [
        orgId,
        conversaId,
        contato!.id,
        NUMERO.id,
        `ligacao:${LIGACAO}`,
        JSON.stringify({
          voice_call: {
            id: LIGACAO,
            direcao: "inbound",
            desfecho: "atendida",
            duracao_ms: 1000,
            atendente_id: atendente.id,
            atendente_nome: "Bruno Atendente",
            motivo: "cliente_desligou",
            menu: null,
            ouviu_aviso: false,
            gravacao: { situacao: "pronta", duracao_ms: 1000 },
          },
        }),
      ],
    );
    mensagemId = mensagem!.id;

    // Duas ligações FEITAS que ninguém atendeu, como `encerrarLigacao` e
    // `registrarNaConversa` as deixam (0294): o instante do primeiro toque na
    // linha, e o tempo de toque e o motivo no registro da conversa.
    for (const [i, l] of SEM_RESPOSTA.entries()) {
      await sql(
        `insert into public.voice_calls
           (id, organization_id, channel_session_id, contact_id, provider, sip_call_ref, direction, peer_phone, status,
            started_at, ended_at, peer_ringing_at, conversation_id, team_id, owner_user_id, created_by, end_reason)
         values ($1, $2, $3, $4, 'sip_trunk', $5, 'outbound', $6, 'ended',
                 now() - interval '10 seconds' - make_interval(secs => $12::double precision / 1000), now() - interval '10 seconds',
                 now() - interval '10 seconds' - make_interval(secs => $7::double precision / 1000),
                 $8, $9, $10, $10, $11)`,
        [l.id, orgId, NUMERO.id, contato!.id, `pedido-grav-${SUFIXO}-${i}`, `+55619901${QUATRO_DIGITOS}`, l.toqueMs, conversaId, TIME.id, atendente.id, l.motivo, l.tentativaMs],
      );
      await sql(
        `insert into public.messages
           (organization_id, conversation_id, contact_id, channel_session_id, external_id, direction, type, body,
            sent_via, status, metadata)
         values ($1, $2, $3, $4, $5, 'outbound', 'system', 'Ligação feita · sem resposta', 'system', 'sent', $6)`,
        [
          orgId,
          conversaId,
          contato!.id,
          NUMERO.id,
          `ligacao:${l.id}`,
          JSON.stringify({
            voice_call: {
              id: l.id,
              direcao: "outbound",
              desfecho: "sem_resposta",
              duracao_ms: null,
              atendente_id: atendente.id,
              atendente_nome: "Bruno Atendente",
              motivo: l.motivo,
              menu: null,
              ouviu_aviso: false,
              ...(l.toqueMs !== null ? { toque_ms: l.toqueMs } : {}),
              tentativa_ms: l.tentativaMs,
            },
          }),
        ],
      );
    }
    // Uma mensagem COMUM com o metadado de ligação plantado — o que um membro
    // consegue gravar pela REST (sem o `external_id` `ligacao:*`, que só o
    // sistema escreve). Não pode virar cartão.
    await sql(
      `insert into public.messages
         (organization_id, conversation_id, contact_id, channel_session_id, direction, type, body, sent_via, status, metadata)
       values ($1, $2, $3, $4, 'outbound', 'system', 'Mensagem plantada', 'system', 'sent', $5)`,
      [
        orgId,
        conversaId,
        contato!.id,
        NUMERO.id,
        JSON.stringify({
          voice_call: {
            id: randomUUID(),
            direcao: "outbound",
            desfecho: "sem_resposta",
            duracao_ms: null,
            atendente_nome: "Bruno Atendente",
            motivo: "sem_resposta_19",
            toque_ms: 45_000,
          },
        }),
      ],
    );
    // O caminho CANÔNICO da gravação (`<org>/<conversa>/<mensagem>.mp3`): a escuta
    // recusa qualquer outro.
    const caminho = `${orgId}/${conversaId}/${mensagemId}.mp3`;
    const subiu = await db.storage.from("whatsapp-media").upload(caminho, UM_SEGUNDO_DE_MP3, { contentType: "audio/mpeg", upsert: true });
    if (subiu.error) throw subiu.error;
    await sql(
      `update public.messages set media_storage_path = $2, media_mime = 'audio/mpeg', media_size_bytes = $3 where id = $1`,
      [mensagemId, caminho, UM_SEGUNDO_DE_MP3.length],
    );
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      if (orgId) await sql(`update public.channel_sessions set archived_at = now() where id = $1 and organization_id = $2`, [NUMERO.id, orgId]);
    } finally {
      await pool.end();
      pool = undefined;
    }
  });

  test("o admin liga a gravação com o aviso pronto; o atendente ouve pelo cartão, com a escuta auditada", async ({ page, browser }) => {
    test.setTimeout(240_000);

    await test.step("admin: a aba Gravação mostra o aviso, liga e guarda por 1 ano", async () => {
      await entrar(page, admin.email, admin.senha);
      await page.goto("/app/connections?aba=telefone&sub=gravacao");
      const cartao = page.locator("[data-gravacao-do-telefone]");
      await expect(cartao).toHaveAttribute("data-gravacao-do-telefone", "desligada", { timeout: 30_000 });
      await expect(page.locator('[data-aviso-de-gravacao="pronto"]')).toContainText(AVISO.texto);
      const interruptor = page.getByRole("switch", { name: "Gravar as ligações" });
      await expect(interruptor).toBeEnabled();
      await interruptor.click();
      await page.getByRole("combobox", { name: "Guardar as gravações por" }).click();
      await page.getByRole("option", { name: "1 ano" }).click();
      await page.getByRole("button", { name: "Salvar" }).click();
      await expect(cartao).toHaveAttribute("data-gravacao-do-telefone", "ligada", { timeout: 20_000 });
      await page.screenshot({ path: `${EVIDENCIA}/gravacao-aba-ligada.png`, fullPage: true });

      const [politica] = await sql<{ recording_enabled: boolean; recording_retention_days: number }>(
        "select recording_enabled, recording_retention_days from phone_settings where organization_id = $1",
        [orgId],
      );
      expect(politica).toEqual({ recording_enabled: true, recording_retention_days: 365 });
      await expect.poll(() => contarAuditoria("phone.recording_settings_changed", admin.id), { timeout: 10_000 }).toBe(1);
    });

    await test.step("atendente: o cartão da ligação mostra a gravação; Ouvir toca a URL assinada, e a escuta é auditada", async () => {
      const contexto = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await contexto.newPage();
      try {
        await entrar(p, atendente.email, atendente.senha);
        await p.goto(`/app/inbox/${conversaId}`);
        const botao = p.locator("[data-ouvir-gravacao]");
        await expect(botao).toBeVisible({ timeout: 30_000 });
        await expect(botao).toContainText("Ouvir a gravação");
        await expect(botao).toContainText("0:01");
        // Abrir a conversa não é escuta: nenhuma linha antes do clique.
        expect(await contarAuditoria("phone.recording_listened", atendente.id)).toBe(0);

        await botao.click();
        const audio = p.locator('[data-ligacao-gravacao="tocando"] audio');
        await expect(audio).toBeVisible({ timeout: 20_000 });
        const src = (await audio.getAttribute("src")) ?? "";
        expect(src, "a URL do player é a assinada do Storage, não a nossa rota").toContain("/storage/v1/object/sign/whatsapp-media/");
        // Carregou e tocou: duração ~1 s medida no elemento, e o relógio andou.
        await expect
          .poll(() => audio.evaluate((el: HTMLAudioElement) => (Number.isFinite(el.duration) ? el.duration : 0)), { timeout: 20_000 })
          .toBeGreaterThan(0.8);
        await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.played.length), { timeout: 20_000 }).toBeGreaterThan(0);
        await p.screenshot({ path: `${EVIDENCIA}/gravacao-cartao-tocando.png`, fullPage: true });

        await expect.poll(() => contarAuditoria("phone.recording_listened", atendente.id), { timeout: 10_000 }).toBe(1);

        // A rota genérica de mídia não serve a gravação: só a escuta auditada.
        const generica = await p.request.get(`/api/v1/messages/${mensagemId}/media`, { maxRedirects: 0 });
        expect(generica.status()).toBe(404);
        expect(await contarAuditoria("phone.recording_listened", atendente.id)).toBe(1);
      } finally {
        await contexto.close();
      }
    });
  });

  test("a ligação feita que ninguém atendeu diz quem ligou, quanto chamou e quem encerrou", async ({ page }) => {
    test.setTimeout(120_000);
    await entrar(page, atendente.email, atendente.senha);
    await page.goto(`/app/inbox/${conversaId}`);

    for (const l of SEM_RESPOSTA) {
      const cartao = page.locator('[data-ligacao="sem_resposta"]').filter({ hasText: l.frase });
      await expect(cartao).toBeVisible({ timeout: 30_000 });
      await expect(cartao.locator("[data-ligacao-titulo]")).toHaveText("Ligação sem resposta");
      // O selo diz QUEM ligou — antes só a ligação atendida dizia.
      await expect(cartao).toContainText("por Bruno Atendente");
      const linha = cartao.locator("[data-ligacao-fim]");
      await expect(linha).toHaveText(l.frase);
      await expect(linha).toHaveAttribute("data-ligacao-fim", l.fim);

      // Medido no elemento: a frase cabe numa linha só.
      const medida = await linha.evaluate((el) => ({
        altura: el.getBoundingClientRect().height,
        alturaDaLinha: parseFloat(getComputedStyle(el).lineHeight),
      }));
      expect(medida.altura, `"${l.frase}" quebrou em mais de uma linha`).toBeLessThan(medida.alturaDaLinha * 1.5);
    }
    // A atendida segue sem a linha: ela é só da feita sem resposta.
    await expect(page.locator('[data-ligacao="atendida"] [data-ligacao-fim]')).toHaveCount(0);
    // A mensagem plantada está na conversa, e NÃO virou cartão: os cartões são os
    // quatro registros de verdade (a atendida e as três sem resposta).
    await expect(page.getByText("Mensagem plantada")).toBeVisible();
    await expect(page.locator("[data-ligacao]")).toHaveCount(1 + SEM_RESPOSTA.length);
    await expect(page.getByText(PLANTADA)).toHaveCount(0);
    await page.screenshot({ path: `${EVIDENCIA}/ligacao-sem-resposta-quanto-chamou.png`, fullPage: true });
  });
});
