/**
 * [P0] TRANSCRIÇÃO DAS LIGAÇÕES PELA TELA — a F4 da telefonia (J48 do mapa de jornadas).
 *
 * Desenho: docs/superpowers/specs/2026-10-09-telefonia-transcricao-das-ligacoes-design.md.
 *
 * O que só a tela prova, e esta spec mede:
 *  1. o ADMIN abre Conexões › Telefone › Gravação numa instalação SEM chave da
 *     OpenAI (o estado de primeiro deploy): o interruptor "Transcrever as
 *     ligações gravadas" não liga, e a tela aponta onde cadastrar a chave. Com a
 *     chave cadastrada, ele liga e salva — o banco guarda a política com o
 *     instante de AGORA, e a auditoria registra o antes e o depois;
 *  2. "só daqui para frente": a ligação gravada ANTES de ligar não vira pedido; a
 *     gravada depois, sim — e o cartão dela diz "Transcrevendo a ligação…";
 *  3. quando a transcrição fica pronta, o MESMO cartão passa a mostrar o resumo e
 *     o "Ver transcrição" — pelo Realtime, SEM recarregar a página;
 *  4. o ATENDENTE (papel agent) clica em "Ver transcrição": a janela lista quem
 *     falou, quando e o quê, avisa que é texto de máquina e que quem falou é
 *     estimativa, cabe na tela e rola por dentro (medido no elemento); cada
 *     abertura é UMA linha `phone.transcript_read` na auditoria — e abrir a
 *     conversa, nenhuma;
 *  5. o LEITOR (papel viewer, do mesmo time) vê a ligação e NADA da transcrição:
 *     nem na tela, nem na resposta da listagem, nem pela rota (403), nem pedindo
 *     a tabela direto à REST do Supabase com o próprio login;
 *  6. sem fala e falha têm frase própria no cartão, e a falha aparece na Central
 *     com o caminho para a aba Gravação.
 *
 * A ligação e a gravação são SEMEADAS (nada escuta a ARI no CI). A transcrição
 * NÃO vai ao provedor: o que o worker faria é feito com as MESMAS funções de
 * banco que ele chama (`lib/channels/telefonia/repositorio-das-transcricoes.ts`)
 * — pedir, concluir, falhar —, então o que a tela mostra é o que essas consultas
 * deixam. O serviço em si (baixar, transcrever, resumir, cada falha) está em
 * unidade (`lib/channels/telefonia/transcricoes.test.ts`), e o SQL no Postgres
 * real (`tests/invariants/telefonia-transcricao.test.ts`).
 *
 * ORGANIZAÇÃO PRÓPRIA, sem MFA, como as outras specs de telefonia.
 *
 * ⚠️ ESTA SPEC EXIGE E2E_TELEFONIA=1 (a aba Gravação só existe onde a instalação
 * oferece telefonia). No CI, só a parte 3.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import { CHANNEL_PROVIDER_SIP_TRUNK } from "../../lib/channels/capabilities";
import {
  concluirTranscricao,
  falharTranscricao,
  pedirTranscricao,
} from "../../lib/channels/telefonia/repositorio-das-transcricoes";
import { bufToBytea, encryptKey } from "../../lib/crypto/aes_gcm";
import type { TrechoDaTranscricao } from "../../lib/telefonia/transcricao";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const EVIDENCIA = ".superpowers/evidence/telefonia-transcricao";

const SUFIXO = randomUUID().slice(0, 8);
const QUATRO_DIGITOS = String(1000 + Math.floor(Math.random() * 9000));
const TIME = { id: randomUUID(), nome: `Suporte Transcrição ${SUFIXO}` };
const NUMERO = { id: randomUUID(), nome: `Número Transcrição ${SUFIXO}`, e164: `+55613003${QUATRO_DIGITOS}` };
const AVISO = { id: randomUUID(), texto: "Esta ligação poderá ser gravada para garantir a qualidade do atendimento." };
/** A instalação já tem chave da OpenAI no ambiente? Então o passo "sem chave" não se aplica. */
const INSTALACAO_COM_CHAVE = (process.env.OPENAI_API_KEY ?? "").trim() !== "";

const RESUMO = `O cliente ligou porque estava sem internet desde a manhã. O atendente reiniciou o equipamento à distância e a conexão voltou. (${SUFIXO})`;
/** Uma ligação comprida o bastante para a janela precisar rolar. */
const TRECHOS: TrechoDaTranscricao[] = [
  { inicio_ms: 0, fim_ms: 2_000, quem: "sistema", texto: "Esta ligação poderá ser gravada para garantir a qualidade do atendimento." },
  { inicio_ms: 4_000, fim_ms: 6_000, quem: "atendente", texto: "Provedor, boa tarde, com quem eu falo?" },
  { inicio_ms: 6_500, fim_ms: 9_000, quem: "cliente", texto: `Boa tarde, aqui é o cliente do teste ${SUFIXO}.` },
  ...Array.from({ length: 60 }, (_, i): TrechoDaTranscricao => ({
    inicio_ms: 10_000 + i * 6_000,
    fim_ms: 14_000 + i * 6_000,
    // Alterna a partir do atendente: assim nenhum trecho é vizinho de outro da
    // mesma pessoa, e cada um vira UMA fala na janela (a contagem confere).
    quem: i % 2 === 0 ? "atendente" : "cliente",
    texto:
      i % 2 === 0
        ? `Entendi, vou reiniciar o equipamento daqui e conferir o sinal com o senhor na linha (${i + 1}).`
        : `Estou sem internet desde cedo, a luz do aparelho fica piscando e nada abre (${i + 1}).`,
  })),
  { inicio_ms: 372_000, fim_ms: 374_000, quem: null, texto: "Tá bom." },
];

test.use({ viewport: { width: 1440, height: 900 } });

let pool: Pool | undefined;
let orgId = "";
let conversaId = "";
let contatoId = "";
const admin = { email: `transc-admin-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "" };
const atendente = { email: `transc-atendente-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "" };
const leitor = { email: `transc-leitor-${SUFIXO}@invariant.test`, senha: `Local-${randomUUID()}!`, id: "" };
const medidas: Record<string, unknown> = {};

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

const contarAuditoria = async (acao: string, ator: string) =>
  (
    await sql<{ n: number }>(
      "select count(*)::int as n from api_audit_log where organization_id = $1 and action = $2 and actor_user_id = $3",
      [orgId, acao, ator],
    )
  )[0]?.n ?? 0;

/**
 * Uma ligação recebida, atendida, gravada e GUARDADA, como o worker a deixa ao
 * fim do processamento da gravação. `haSegundos` = há quanto tempo terminou.
 */
async function ligacaoGravada(haSegundos: number): Promise<{ id: string; mensagemId: string }> {
  if (!pool) throw new Error("sem pool");
  const id = randomUUID();
  await sql(
    `insert into public.voice_calls
       (id, organization_id, channel_session_id, contact_id, provider, sip_call_ref, direction, peer_phone, status,
        started_at, answered_at, ended_at, duration_ms, conversation_id, team_id, owner_user_id,
        recording_status, recording_notice_at, end_reason)
     values ($1, $2, $3, $4, 'sip_trunk', $5, 'inbound', $6, 'ended',
             now() - make_interval(secs => $7 + 400), now() - make_interval(secs => $7 + 380), now() - make_interval(secs => $7),
             376000, $8, $9, $10, 'stored', now() - make_interval(secs => $7 + 400), 'cliente_desligou')`,
    [id, orgId, NUMERO.id, contatoId, `canal-transc-${id.slice(0, 8)}`, `+55619902${QUATRO_DIGITOS}`, haSegundos, conversaId, TIME.id, atendente.id],
  );
  const [mensagem] = await sql<{ id: string }>(
    `insert into public.messages
       (organization_id, conversation_id, contact_id, channel_session_id, external_id, direction, type, body,
        sent_via, status, sent_at, metadata)
     values ($1, $2, $3, $4, $5, 'outbound', 'system', 'Ligação recebida, atendida por Bruno Atendente · 6 min 16 s', 'system', 'sent',
             now() - make_interval(secs => $7), $6)
     returning id`,
    [
      orgId,
      conversaId,
      contatoId,
      NUMERO.id,
      `ligacao:${id}`,
      JSON.stringify({
        voice_call: {
          id,
          direcao: "inbound",
          desfecho: "atendida",
          duracao_ms: 376_000,
          atendente_id: atendente.id,
          atendente_nome: "Bruno Atendente",
          motivo: "cliente_desligou",
          menu: null,
          ouviu_aviso: false,
          gravacao: { situacao: "pronta", duracao_ms: 376_000 },
        },
      }),
      haSegundos,
    ],
  );
  const mensagemId = mensagem!.id;
  // O ponteiro do arquivo, no caminho canônico (o arquivo em si não é tocado aqui).
  await sql(`update public.messages set media_storage_path = $2, media_mime = 'audio/mpeg', media_size_bytes = 1000 where id = $1`, [
    mensagemId,
    `${orgId}/${conversaId}/${mensagemId}.mp3`,
  ]);
  return { id, mensagemId };
}

test.describe("telefonia — transcrição das ligações pela tela", () => {
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
    leitor.id = await criarUsuario(leitor.email, leitor.senha, "Carla Leitora");
    const org = await db
      .from("organizations")
      .insert({
        display_name: `Provedor Transcrição ${SUFIXO}`,
        legal_name: `Provedor Transcrição ${SUFIXO}`,
        slug: `transcricao-${SUFIXO}`,
        onboarded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id as string;
    for (const [usuario, papel] of [
      [admin.id, "admin"],
      [atendente.id, "agent"],
      [leitor.id, "viewer"],
    ] as const) {
      const vinculo = await db.from("user_organizations").insert({
        organization_id: orgId,
        user_id: usuario,
        role: papel,
        accepted_at: new Date().toISOString(),
      });
      if (vinculo.error) throw vinculo.error;
    }
    await sql(`insert into public.attendance_teams (id, organization_id, name, slug) values ($1, $2, $3, $4)`, [
      TIME.id,
      orgId,
      TIME.nome,
      `suporte-transcricao-${SUFIXO}`,
    ]);
    // O atendente E o leitor são do time da conversa: os dois a enxergam. O que
    // separa os dois é só o papel.
    for (const usuario of [atendente.id, leitor.id]) {
      await sql(`insert into public.attendance_team_members (organization_id, team_id, user_id) values ($1, $2, $3)`, [orgId, TIME.id, usuario]);
    }
    await sql(
      `insert into public.channel_sessions
         (id, organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
          sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_team_id)
       values ($1, $2, $3, decode('00', 'hex'), 'WORKING', $4, $5,
               'voip.e2e-transcricao.com.br', 5060, 'udp', $6, decode('00', 'hex'), $7)`,
      [NUMERO.id, orgId, CHANNEL_PROVIDER_SIP_TRUNK, NUMERO.nome, NUMERO.e164, `transc${SUFIXO}`, TIME.id],
    );
    const hash = randomUUID().replace(/-/g, "").padEnd(64, "a").slice(0, 64);
    await sql(
      `insert into public.phone_prompts
         (id, organization_id, kind, "text", voice_id, model_id, content_hash, storage_path, duration_ms, status)
       values ($1, $2, 'recording_notice', $3, 'voz-e2e', 'eleven_multilingual_v2', $4, $5, 2500, 'ready')`,
      [AVISO.id, orgId, AVISO.texto, hash, `${orgId}/${hash}.ulaw`],
    );
    // A gravação JÁ ligada (a J37 prova o ligar); a transcrição, desligada — o padrão.
    await sql(`insert into public.phone_settings (organization_id, recording_notice_prompt_id, recording_enabled) values ($1, $2, true)`, [
      orgId,
      AVISO.id,
    ]);
    const [contato] = await sql<{ id: string }>(
      `insert into public.contacts (organization_id, display_name, phone_number, source) values ($1, 'Cliente da Transcrição', $2, 'phone_call') returning id`,
      [orgId, `+55619902${QUATRO_DIGITOS}`],
    );
    contatoId = contato!.id;
    const [conversa] = await sql<{ id: string }>(
      `insert into public.conversations
         (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee,
          team_id, assignee_kind, assigned_to_user_id, assigned_to_user_name)
       values ($1, $2, $3, 'phone', 'open', false, 0, $4, 'user', $5, 'Bruno Atendente') returning id`,
      [orgId, contatoId, NUMERO.id, TIME.id, atendente.id],
    );
    conversaId = conversa!.id;
  });

  test.afterAll(async () => {
    writeFileSync(`${EVIDENCIA}/medidas.json`, JSON.stringify(medidas, null, 2));
    if (!pool) return;
    try {
      if (orgId) await sql(`update public.channel_sessions set archived_at = now() where id = $1 and organization_id = $2`, [NUMERO.id, orgId]);
    } finally {
      await pool.end();
      pool = undefined;
    }
  });

  test("o admin liga a transcrição; o atendente lê o resumo e a conversa; o leitor não vê nada", async ({ page, browser }) => {
    test.setTimeout(300_000);
    if (!pool) throw new Error("sem pool");
    const banco = pool;

    // Gravada ANTES de a transcrição ser ligada: nunca vira pedido.
    const antiga = await ligacaoGravada(3_600);

    await test.step("admin, sem chave da OpenAI: o interruptor não liga e a tela aponta onde cadastrar", async () => {
      await entrar(page, admin.email, admin.senha);
      await page.goto("/app/connections?aba=telefone&sub=gravacao");
      const bloco = page.locator("[data-transcricao-do-telefone]");
      await expect(bloco).toHaveAttribute("data-transcricao-do-telefone", "desligada", { timeout: 30_000 });
      await expect(bloco).toContainText("enviado à OpenAI");
      await expect(bloco).toContainText("as antigas não são transcritas");
      if (!INSTALACAO_COM_CHAVE) {
        await expect(page.getByRole("switch", { name: "Transcrever as ligações gravadas" })).toBeDisabled();
        await expect(page.locator("[data-transcricao-sem-chave]")).toBeVisible();
        await expect(page.getByRole("link", { name: "Abrir os provedores de IA" })).toHaveAttribute("href", "/app/ai/providers");
        await page.screenshot({ path: `${EVIDENCIA}/01-aba-sem-chave.png`, fullPage: true });
        // A recusa é do servidor, e não só da tela: pedir direto à rota dá 409.
        const direto = await page.request.put("/api/v1/telefonia/gravacao", { data: { ativa: true, retencao_dias: 90, transcrever: true } });
        expect(direto.status()).toBe(409);
        expect(((await direto.json()) as { error: { code: string } }).error.code).toBe("chave_de_transcricao_ausente");
      }
      medidas.instalacao_com_chave_no_ambiente = INSTALACAO_COM_CHAVE;
    });

    await test.step("admin, com a chave cadastrada: liga, salva, e o banco guarda a política com o instante de agora", async () => {
      const cifrada = encryptKey(`sk-e2e-transcricao-${SUFIXO}`);
      const credencial = await db.from("ai_provider_credentials").insert({
        organization_id: orgId,
        provider: "openai",
        label: "OpenAI e2e (transcrição)",
        api_key_encrypted: bufToBytea(cifrada.ciphertext),
        api_key_iv: bufToBytea(cifrada.iv),
        api_key_tag: bufToBytea(cifrada.tag),
        api_key_last4: cifrada.last4,
        validated_at: new Date().toISOString(),
        is_active: true,
      });
      if (credencial.error) throw credencial.error;

      await page.reload();
      const bloco = page.locator("[data-transcricao-do-telefone]");
      const interruptor = page.getByRole("switch", { name: "Transcrever as ligações gravadas" });
      await expect(interruptor).toBeEnabled({ timeout: 30_000 });
      await expect(page.locator("[data-transcricao-sem-chave]")).toHaveCount(0);
      const antes = Date.now();
      await interruptor.click();
      await page.getByRole("button", { name: "Salvar" }).click();
      await expect(bloco).toHaveAttribute("data-transcricao-do-telefone", "ligada", { timeout: 20_000 });
      await page.screenshot({ path: `${EVIDENCIA}/02-aba-transcricao-ligada.png`, fullPage: true });

      const [politica] = await sql<{ recording_enabled: boolean; transcription_enabled: boolean; ligada_em: Date | null }>(
        "select recording_enabled, transcription_enabled, transcription_enabled_at as ligada_em from phone_settings where organization_id = $1",
        [orgId],
      );
      expect(politica?.recording_enabled).toBe(true);
      expect(politica?.transcription_enabled).toBe(true);
      expect(Math.abs((politica?.ligada_em?.getTime() ?? 0) - antes)).toBeLessThan(120_000);
      await expect.poll(() => contarAuditoria("phone.recording_settings_changed", admin.id), { timeout: 10_000 }).toBe(1);
      const [linha] = await sql<{ metadata: { antes: { transcrever: boolean }; depois: { transcrever: boolean } } }>(
        "select metadata from api_audit_log where organization_id = $1 and action = 'phone.recording_settings_changed' order by created_at desc limit 1",
        [orgId],
      );
      expect(linha?.metadata.antes.transcrever).toBe(false);
      expect(linha?.metadata.depois.transcrever).toBe(true);
    });

    // Gravada DEPOIS de ligar: é a que o worker pede.
    const nova = await ligacaoGravada(0);

    await test.step("só daqui para frente: a ligação antiga não vira pedido; a nova, sim", async () => {
      expect(await pedirTranscricao(banco, orgId, antiga.id)).toBe(false);
      expect(await pedirTranscricao(banco, orgId, nova.id)).toBe(true);
      const linhas = await sql<{ voice_call_id: string; status: string }>(
        "select voice_call_id, status from voice_call_transcripts where organization_id = $1",
        [orgId],
      );
      expect(linhas).toEqual([{ voice_call_id: nova.id, status: "pending" }]);
    });

    const contexto = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await contexto.newPage();
    try {
      await test.step("atendente: o cartão da ligação nova diz 'Transcrevendo…'; o da antiga não fala de transcrição", async () => {
        await entrar(p, atendente.email, atendente.senha);
        await p.goto(`/app/inbox/${conversaId}`);
        await expect(p.locator('[data-ligacao-transcricao="processando"]')).toHaveText("Transcrevendo a ligação…", { timeout: 30_000 });
        await expect(p.locator("[data-ligacao-transcricao]")).toHaveCount(1);
        await expect(p.locator("[data-ouvir-gravacao]")).toHaveCount(2);
        await p.screenshot({ path: `${EVIDENCIA}/03-cartao-transcrevendo.png`, fullPage: true });
      });

      await test.step("a transcrição fica pronta: o resumo e o 'Ver transcrição' aparecem SEM recarregar", async () => {
        expect(
          await concluirTranscricao(banco, {
            organizationId: orgId,
            vcId: nova.id,
            estado: "ready",
            texto: TRECHOS.map((t) => t.texto).join(" "),
            trechos: TRECHOS,
            resumo: RESUMO,
            idioma: "portuguese",
            modelo: "whisper-1",
            duracaoMs: 376_000,
          }),
        ).toBe("gravada");
        const pronta = p.locator('[data-ligacao-transcricao="pronta"]');
        await expect(pronta).toBeVisible({ timeout: 30_000 });
        await expect(pronta.locator("[data-ligacao-resumo]")).toContainText(RESUMO);
        await expect(pronta.locator("[data-ligacao-resumo]")).toContainText("feito por IA");
        await expect(pronta.locator("[data-ver-transcricao]")).toHaveText("Ver transcrição");
        // O texto NUNCA está na linha de messages — nem o resumo.
        const [msg] = await sql<{ bruto: string }>("select row_to_json(m)::text as bruto from messages m where id = $1", [nova.mensagemId]);
        expect(msg?.bruto).not.toContain("sem internet");
        expect(msg?.bruto).not.toContain(SUFIXO + ")");
        // O resumo cabe no cartão sem estourar a coluna da conversa.
        const caixa = await pronta.locator("[data-ligacao-resumo]").boundingBox();
        const coluna = await pronta.boundingBox();
        expect(caixa && coluna && caixa.width <= coluna.width + 1).toBe(true);
        medidas.resumo_no_cartao = caixa;
        await p.screenshot({ path: `${EVIDENCIA}/04-cartao-com-resumo.png`, fullPage: true });
        // Abrir a conversa não é ler a transcrição.
        expect(await contarAuditoria("phone.transcript_read", atendente.id)).toBe(0);
      });

      await test.step("'Ver transcrição': a janela lista quem falou, quando e o quê; cabe na tela, rola por dentro, e a leitura é auditada", async () => {
        await p.locator("[data-ver-transcricao]").click();
        const janela = p.locator("[data-janela-da-transcricao]");
        const corpo = janela.locator('[data-transcricao-corpo="lida"]');
        await expect(corpo).toBeVisible({ timeout: 20_000 });
        await expect(janela).toContainText("Transcrição da ligação");
        await expect(janela).toContainText("Quem falou é uma estimativa");
        await expect(janela).toContainText("pode errar nomes, números e endereços");
        await expect(janela.locator("[data-transcricao-resumo]")).toContainText(RESUMO);

        const falas = janela.locator("[data-fala-de]");
        await expect(falas.first()).toHaveAttribute("data-fala-de", "sistema");
        await expect(falas.first()).toContainText("Gravação automática ou ruído");
        await expect(falas.first()).toContainText("0:00");
        await expect(falas.nth(1)).toHaveAttribute("data-fala-de", "atendente");
        await expect(falas.nth(1)).toContainText("Atendente");
        await expect(falas.nth(1)).toContainText("0:04");
        await expect(falas.nth(1)).toContainText("Provedor, boa tarde, com quem eu falo?");
        await expect(falas.nth(2)).toHaveAttribute("data-fala-de", "cliente");
        await expect(falas.nth(2)).toContainText(`cliente do teste ${SUFIXO}`);
        await expect(falas.last()).toHaveAttribute("data-fala-de", "desconhecido");
        await expect(falas.last()).toContainText("Não identificado");
        await expect(falas.last()).toContainText("6:12");
        // Nenhuma fala some entre o banco e a tela.
        const total = await falas.count();
        expect(total).toBe(TRECHOS.length);

        // A janela cabe na tela e o texto rola POR DENTRO (medido, não a olho).
        const caixa = await janela.boundingBox();
        expect(caixa).not.toBeNull();
        expect(caixa!.y).toBeGreaterThanOrEqual(0);
        expect(caixa!.y + caixa!.height).toBeLessThanOrEqual(900);
        const rolagem = await corpo.evaluate((el) => ({ altura: el.clientHeight, conteudo: el.scrollHeight, overflowY: getComputedStyle(el).overflowY }));
        expect(rolagem.conteudo).toBeGreaterThan(rolagem.altura);
        expect(rolagem.overflowY).toBe("auto");
        await expect(falas.last()).not.toBeInViewport();
        await falas.last().scrollIntoViewIfNeeded();
        await expect(falas.last()).toBeInViewport();
        medidas.janela = { caixa, rolagem, falas: total };
        await p.screenshot({ path: `${EVIDENCIA}/05-janela-da-transcricao-fim.png` });
        await corpo.evaluate((el) => el.scrollTo(0, 0));
        await p.screenshot({ path: `${EVIDENCIA}/06-janela-da-transcricao-comeco.png` });

        await expect.poll(() => contarAuditoria("phone.transcript_read", atendente.id), { timeout: 10_000 }).toBe(1);
        // Fechar e abrir de novo é outra leitura.
        await p.keyboard.press("Escape");
        await expect(janela).toHaveCount(0);
        await p.locator("[data-ver-transcricao]").click();
        await expect(janela.locator('[data-transcricao-corpo="lida"]')).toBeVisible({ timeout: 20_000 });
        await expect.poll(() => contarAuditoria("phone.transcript_read", atendente.id), { timeout: 10_000 }).toBe(2);
        await p.keyboard.press("Escape");
        // A auditoria guarda a conversa, nunca o texto.
        const [linha] = await sql<{ bruto: string }>(
          "select row_to_json(a)::text as bruto from api_audit_log a where organization_id = $1 and action = 'phone.transcript_read' limit 1",
          [orgId],
        );
        expect(linha?.bruto).toContain(conversaId);
        expect(linha?.bruto).not.toContain("sem internet");
      });

      await test.step("celular: o cartão com o resumo e a janela cabem em 390 px, sem rolagem de lado", async () => {
        await p.setViewportSize({ width: 390, height: 844 });
        await p.goto(`/app/inbox/${conversaId}`);
        const pronta = p.locator('[data-ligacao-transcricao="pronta"]');
        await expect(pronta).toBeVisible({ timeout: 30_000 });
        const largura = await p.evaluate(() => ({ documento: document.documentElement.scrollWidth, janela: window.innerWidth }));
        expect(largura.documento).toBeLessThanOrEqual(largura.janela);
        const resumo = await pronta.locator("[data-ligacao-resumo]").boundingBox();
        expect(resumo && resumo.x >= 0 && resumo.x + resumo.width <= 390).toBe(true);
        await pronta.locator("[data-ver-transcricao]").click();
        const janela = p.locator("[data-janela-da-transcricao]");
        await expect(janela.locator('[data-transcricao-corpo="lida"]')).toBeVisible({ timeout: 20_000 });
        const caixa = await janela.boundingBox();
        expect(caixa && caixa.x >= 0 && caixa.x + caixa.width <= 390 && caixa.y >= 0 && caixa.y + caixa.height <= 844).toBe(true);
        medidas.celular = { largura, resumo, janela: caixa };
        await p.screenshot({ path: `${EVIDENCIA}/07-celular-janela.png` });
        await p.keyboard.press("Escape");
        await p.setViewportSize({ width: 1440, height: 900 });
      });
    } finally {
      await contexto.close();
    }

    await test.step("leitor (viewer, do mesmo time): vê a ligação e NADA da transcrição — tela, listagem, rota e REST", async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      try {
        await entrar(p, leitor.email, leitor.senha);
        const listagem = p.waitForResponse((r) => r.url().includes(`/api/v1/conversations/${conversaId}/messages`) && r.status() === 200);
        await p.goto(`/app/inbox/${conversaId}`);
        const resposta = await (await listagem).text();
        // O cartão da ligação está lá — o leitor enxerga a conversa.
        await expect(p.locator('[data-ligacao="atendida"]')).toHaveCount(2, { timeout: 30_000 });
        await expect(p.locator("[data-ligacao-transcricao]")).toHaveCount(0);
        await expect(p.locator("[data-ver-transcricao]")).toHaveCount(0);
        await expect(p.locator("body")).not.toContainText("sem internet desde a manhã");
        // A listagem não entrega nem a situação: a chave sai da resposta.
        expect(resposta).not.toContain(RESUMO);
        expect(resposta).not.toContain('"transcricao"');
        await p.screenshot({ path: `${EVIDENCIA}/08-leitor-sem-transcricao.png`, fullPage: true });

        // A rota da leitura recusa pelo papel.
        const rota = await p.request.get(`/api/v1/telefonia/chamadas/${nova.id}/transcricao`);
        expect(rota.status()).toBe(403);
        expect(await contarAuditoria("phone.transcript_read", leitor.id)).toBe(0);
      } finally {
        await ctx.close();
      }

      // A tabela pela REST do Supabase, com o login do próprio leitor e com o do
      // atendente: nem quem pode ler pela rota lê direto. É aqui que o default ACL
      // de TABELAS do Supabase de verdade é medido — o Postgres do `test:db` não o tem.
      for (const quem of [leitor, atendente]) {
        const cliente = createClient(credenciais.url, credenciais.anonKey, { auth: { persistSession: false } });
        const login = await cliente.auth.signInWithPassword({ email: quem.email, password: quem.senha });
        expect(login.error, `login de ${quem.email}`).toBeNull();
        const direto = await cliente.from("voice_call_transcripts").select("voice_call_id, text, summary");
        expect(direto.data ?? [], `${quem.email} não lê a tabela pela REST`).toEqual([]);
        expect(direto.error, `${quem.email}: a REST recusa em vez de devolver lista vazia`).not.toBeNull();
      }
      const anonimo = await createClient(credenciais.url, credenciais.anonKey, { auth: { persistSession: false } })
        .from("voice_call_transcripts")
        .select("voice_call_id");
      expect(anonimo.data ?? []).toEqual([]);
      expect(anonimo.error).not.toBeNull();
    });

    await test.step("sem fala e falha: cada uma com a sua frase no cartão; a falha chega à Central com o caminho da aba", async () => {
      const semFala = await ligacaoGravada(0);
      const falhou = await ligacaoGravada(0);
      expect(await pedirTranscricao(banco, orgId, semFala.id)).toBe(true);
      expect(await pedirTranscricao(banco, orgId, falhou.id)).toBe(true);
      expect(
        await concluirTranscricao(banco, {
          organizationId: orgId,
          vcId: semFala.id,
          estado: "empty",
          texto: null,
          trechos: [],
          resumo: null,
          idioma: null,
          modelo: "whisper-1",
          duracaoMs: 3_000,
        }),
      ).toBe("gravada");
      expect(
        await falharTranscricao(banco, orgId, falhou.id, "transcription_401", {
          titulo: "A transcrição de uma ligação não saiu",
          corpo:
            "A ligação foi gravada normalmente, mas o serviço de transcrição falhou em todas as tentativas. Confira a chave e o saldo da OpenAI em Agente de IA → Provedores. As próximas ligações seguem sendo transcritas.",
        }),
      ).toBe(true);

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      try {
        await entrar(p, atendente.email, atendente.senha);
        await p.goto(`/app/inbox/${conversaId}`);
        await expect(p.locator('[data-ligacao-transcricao="sem_fala"]')).toHaveText("A gravação não tem fala para transcrever.", { timeout: 30_000 });
        await expect(p.locator('[data-ligacao-transcricao="falhou"]')).toHaveText("Não foi possível transcrever esta ligação.");
        await expect(p.locator("[data-ver-transcricao]")).toHaveCount(1);
        await p.screenshot({ path: `${EVIDENCIA}/09-cartoes-sem-fala-e-falha.png`, fullPage: true });
      } finally {
        await ctx.close();
      }

      // A Central, pelo admin: o aviso está lá e o botão leva à aba Gravação.
      await page.goto("/app/ai/inbox");
      const aviso = page.getByText("A transcrição de uma ligação não saiu").first();
      await expect(aviso).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${EVIDENCIA}/10-central-aviso-da-transcricao.png`, fullPage: true });
      const porta = page.getByRole("link", { name: "Abrir a gravação do telefone" }).first();
      await expect(porta).toBeVisible();
      await expect(porta).toHaveAttribute("href", /aba=telefone&sub=gravacao/);
    });
  });
});
