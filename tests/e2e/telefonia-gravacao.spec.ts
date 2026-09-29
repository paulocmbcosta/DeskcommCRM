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
 *  3. a rota genérica de mídia NÃO serve a gravação (404) — só a escuta auditada.
 *
 * A ligação e a gravação são SEMEADAS (voice_calls `stored` + a mensagem da
 * ligação + o arquivo no Storage local), como o worker as deixa ao fim do
 * processamento: a ligação de verdade — Asterisk, ponte, ffmpeg — não existe no
 * CI (nada escuta a porta da ARI) e é provada na VPS. O processamento está em
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

/** Um segundo de tom em WAV PCM 8 kHz, 16 bits, mono — o que o navegador toca sem codec extra. */
function umSegundoDeWav(): Buffer {
  const amostras = 8_000;
  const dados = Buffer.alloc(amostras * 2);
  for (let i = 0; i < amostras; i++) dados.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 8_000)), i * 2);
  const cab = Buffer.alloc(44);
  cab.write("RIFF", 0);
  cab.writeUInt32LE(36 + dados.length, 4);
  cab.write("WAVE", 8);
  cab.write("fmt ", 12);
  cab.writeUInt32LE(16, 16);
  cab.writeUInt16LE(1, 20);
  cab.writeUInt16LE(1, 22);
  cab.writeUInt32LE(8_000, 24);
  cab.writeUInt32LE(16_000, 28);
  cab.writeUInt16LE(2, 32);
  cab.writeUInt16LE(16, 34);
  cab.write("data", 36);
  cab.writeUInt32LE(dados.length, 40);
  return Buffer.concat([cab, dados]);
}

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
    const caminho = `${orgId}/${conversaId}/${mensagemId}.wav`;
    const subiu = await db.storage.from("whatsapp-media").upload(caminho, umSegundoDeWav(), { contentType: "audio/wav", upsert: true });
    if (subiu.error) throw subiu.error;
    await sql(
      `update public.messages set media_storage_path = $2, media_mime = 'audio/wav', media_size_bytes = $3 where id = $1`,
      [mensagemId, caminho, umSegundoDeWav().length],
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
});
