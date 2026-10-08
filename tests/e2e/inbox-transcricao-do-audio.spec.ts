/**
 * A TRANSCRIÇÃO DO ÁUDIO NO BALÃO — provada pela tela, como o atendente lê.
 *
 * ## Por que pela tela
 *
 * `tests/unit/inbox-transcricao-do-audio.test.tsx` monta o objeto `Message` à
 * mão e confere o balão; o invariante de `listMessagesHandler` confere a rota
 * contra o banco. Nenhum dos dois prova as duas pontas JUNTAS, e é na junção
 * que esta feature morre calada: se a rota não entregar `media_derived_text`, o
 * componente recebe `undefined`, não desenha nada, e nenhum teste fica vermelho
 * — a tela só volta a ser o que era antes.
 *
 * Também só a tela prova o que o pedido descreve:
 *
 *   1. o trecho aparece ABAIXO do player, sem estourar o balão;
 *   2. "Ler mais" abre a caixa ali mesmo, e um áudio comprido rola por DENTRO
 *      dela em vez de empurrar a conversa;
 *   3. a transcrição de um áudio que acabou de chegar entra SOZINHA, sem F5 —
 *      o worker grava segundos depois, e quem leva a mudança à tela é o
 *      Realtime (ou, com ele mudo, o refetch de segurança de 45 s);
 *   4. quem está no FIM da conversa vê a transcrição chegar inteira (o balão
 *      cresce e a conversa acompanha), e quem subiu para ler o histórico não é
 *      arrancado de onde estava;
 *   5. o áudio gravado pelo atendente continua só com o player.
 *
 * ## O que este spec NÃO afirma
 *
 * Não transcreve nada: o texto é SEMEADO, com os valores que
 * `workers/media-derive-worker.ts` grava (`media_derived_text` +
 * `media_derived_status='ready'`). A cadeia que produz o texto — baixar do
 * provedor, Whisper — tem prova própria (`tests/unit/media-derive*.test.ts`) e
 * já roda em produção.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3021 pnpm exec playwright test tests/e2e/inbox-transcricao-do-audio.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/inbox-transcricao-do-audio");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** A limpeza apaga por prefixo, não por id — ver `inbox-rotulo-de-origem.spec.ts`. */
const PREFIXO = "Transcricao do Audio E2E";
const NOME_DO_CONTATO = `${PREFIXO} ${Date.now()}`;

/**
 * Um áudio de pouco mais de um minuto, por escrito (~1.300 caracteres). Longo
 * de propósito: aberto, ele passa da altura máxima da caixa, e é isso que deixa
 * o teste medir a rolagem interna.
 */
const COMECO = "Bom dia, tudo bem? Eu estou falando porque a minha internet caiu ontem";
const FIM = "Muito obrigada, fico no aguardo do retorno de voces.";
const LONGA =
  `${COMECO} a noite, por volta das dez horas, e ate agora nao voltou. ` +
  "Eu ja tirei o aparelho da tomada, esperei uns cinco minutos e liguei de novo, mas a luz " +
  "vermelha continua piscando sem parar. Tambem testei o cabo em outra tomada da casa e deu " +
  "na mesma. O meu vizinho aqui do lado e cliente de voces tambem e a internet dele esta " +
  "funcionando normal, entao eu acho que o problema e so aqui em casa mesmo. " +
  "Eu trabalho de casa e tenho uma reuniao importante hoje as duas da tarde, entao eu " +
  "precisava muito que um tecnico viesse ainda pela manha, se for possivel. " +
  "O endereco e o mesmo do cadastro, e pode ligar neste numero quando estiver chegando " +
  "que eu desco para abrir o portao. Se nao der para vir hoje, eu queria saber se voces " +
  "conseguem pelo menos liberar um acesso provisorio pelo celular, porque eu nao posso " +
  "ficar o dia inteiro sem conexao. Outra coisa: a minha fatura deste mes veio com um valor " +
  "diferente do combinado, depois eu queria conversar sobre isso tambem, mas o mais urgente " +
  `agora e a internet voltar. ${FIM}`;
const CURTA = "Oi, pode me ligar quando puder?";
/**
 * Longo o bastante para ganhar "Ler mais" (passa da folga do trecho): é a caixa
 * ALTA — rótulo, quatro ou cinco linhas e botão — que estoura os 120 px de
 * tolerância da rolagem. Um texto de uma linha deixaria o passo 3 verde mesmo
 * com a conversa parada no lugar.
 */
const CHEGANDO =
  "Acabei de mandar o comprovante do pagamento, consegue conferir para mim? Foi feito agora " +
  "ha pouco pelo aplicativo do banco, no valor da fatura deste mes, e eu queria ter certeza " +
  "de que caiu antes de vencer, porque da ultima vez demorou tres dias para aparecer ai.";
const NAO_PUXA = "So mais um detalhe: o portao fica na rua de tras.";
/** Mensagens de texto antigas: fazem a conversa passar da altura da tela. */
const ANTIGAS = 16;

/**
 * Um segundo de tom em MP3 — o mesmo arquivo de `telefonia-gravacao.spec.ts`,
 * gerado com `ffmpeg -f lavfi -i sine=frequency=440:duration=1 -ac 1 -ar 16000
 * -c:a libmp3lame -b:a 24k`. Com ele o player carrega de verdade; sem arquivo o
 * `<audio>` falha e a tela mostraria "Mídia indisponível" no lugar do player.
 */
const UM_SEGUNDO_DE_MP3 = fs.readFileSync(path.join(__dirname, "fixtures", "um-segundo.mp3"));

let creds: Creds;
let conversaId = "";
let contatoId = "";
let sessaoId = "";
let caminhoDoAudio = "";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("display_name", `${PREFIXO}%`);
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((c) => c.id);
  if (ids.length === 0) return;
  await admin.from("messages").delete().in("contact_id", ids);
  await admin.from("conversations").delete().in("contact_id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

/** Um áudio na conversa, com o que o worker de mídia teria gravado nele. */
async function inserirAudio(linha: {
  direction: "inbound" | "outbound";
  sent_at: string;
  texto?: string | null;
  estado?: "ready" | "failed" | null;
  sent_via?: string;
  sent_by_user_id?: string;
}): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("messages").insert({
    id,
    organization_id: creds.org_id,
    conversation_id: conversaId,
    channel_session_id: sessaoId,
    contact_id: contatoId,
    type: "audio",
    direction: linha.direction,
    status: linha.direction === "inbound" ? "delivered" : "sent",
    sent_via: linha.sent_via ?? "external_device",
    ...(linha.sent_by_user_id ? { sent_by_user_id: linha.sent_by_user_id } : {}),
    sent_at: linha.sent_at,
    media_storage_path: caminhoDoAudio,
    media_mime: "audio/mpeg",
    media_size_bytes: UM_SEGUNDO_DE_MP3.length,
    media_derived_text: linha.texto ?? null,
    media_derived_status: linha.estado ?? null,
  });
  if (error) throw new Error(`messages (audio): ${error.message}`);
  return id;
}

test.describe("Inbox — a transcrição do áudio aparece junto do player", () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limpar();

    const { data: sessaoExistente } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", creds.org_id)
      .limit(1)
      .maybeSingle();
    sessaoId = (sessaoExistente as { id: string } | null)?.id ?? "";
    if (!sessaoId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: creds.org_id,
          waha_session_name: `e2e-transcricao-${Date.now()}`,
          webhook_secret_encrypted: "e2e",
        })
        .select("id")
        .single();
      if (error) throw new Error(`channel_sessions: ${error.message}`);
      sessaoId = (data as { id: string }).id;
    }

    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: creds.org_id,
        display_name: NOME_DO_CONTATO,
        phone_number: `+55119${String(Date.now()).slice(-8)}`,
      })
      .select("id")
      .single();
    if (erroContato) throw new Error(`contacts: ${erroContato.message}`);
    contatoId = (contato as { id: string }).id;

    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: contatoId,
        channel_session_id: sessaoId,
        status: "open",
        last_message_at: new Date().toISOString(),
        last_inbound_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (erroConversa) throw new Error(`conversations: ${erroConversa.message}`);
    conversaId = (conversa as { id: string }).id;

    // Um arquivo só, apontado por todos os áudios: a rota de mídia assina o
    // caminho que a mensagem guarda, e só exige que ele comece pela organização.
    caminhoDoAudio = `${creds.org_id}/${conversaId}/audio-de-teste.mp3`;
    const subiu = await admin.storage
      .from("whatsapp-media")
      .upload(caminhoDoAudio, UM_SEGUNDO_DE_MP3, { contentType: "audio/mpeg", upsert: true });
    if (subiu.error) throw new Error(`storage: ${subiu.error.message}`);

    // Datas no PASSADO: assim nenhum destes cai na janela do "Transcrevendo…",
    // que é de quem acabou de chegar — esse caso é o do áudio inserido no teste.
    const t0 = Date.now() - 60 * 60_000;
    const em = (minutos: number) => new Date(t0 + minutos * 60_000).toISOString();
    for (let i = 0; i < ANTIGAS; i++) {
      const { error } = await admin.from("messages").insert({
        organization_id: creds.org_id,
        conversation_id: conversaId,
        channel_session_id: sessaoId,
        contact_id: contatoId,
        type: "text",
        direction: i % 2 === 0 ? "inbound" : "outbound",
        status: i % 2 === 0 ? "delivered" : "sent",
        sent_via: "external_device",
        body: `Mensagem antiga ${i + 1}`,
        sent_at: em(i - ANTIGAS),
      });
      if (error) throw new Error(`messages (antiga ${i + 1}): ${error.message}`);
    }
    await inserirAudio({ direction: "inbound", sent_at: em(0), texto: LONGA, estado: "ready" });
    await inserirAudio({ direction: "inbound", sent_at: em(1), texto: CURTA, estado: "ready" });
    // O áudio do ATENDENTE, gravado no CRM: o sistema não transcreve o que sai.
    await inserirAudio({
      direction: "outbound",
      sent_at: em(2),
      sent_via: "user",
      sent_by_user_id: creds.users.agent!.id,
    });
  });

  test.afterAll(async () => {
    await limpar();
    if (caminhoDoAudio) await admin.storage.from("whatsapp-media").remove([caminhoDoAudio]);
  });

  test("o atendente lê o áudio do cliente sem ouvir: trecho, 'Ler mais' e chegada sem recarregar", async ({
    page,
  }) => {
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto(`/app/inbox/${conversaId}`);

    const conversa = page.getByTestId("chat-thread");
    // A área que rola: o filho direto do thread (`ChatThread`, `overflow-y-auto`).
    const rolagem = conversa.locator("xpath=./div[contains(@class,'overflow-y-auto')]");
    const distanciaDoFim = () =>
      rolagem.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    const caixas = conversa.getByTestId("transcricao-do-audio");
    const caixaLonga = caixas.filter({ hasText: COMECO });
    const caixaCurta = caixas.filter({ hasText: CURTA });

    // ── 1. O TRECHO, abaixo do player ──────────────────────────────────────
    await expect(caixaLonga, "a transcrição não chegou ao balão").toBeVisible({ timeout: 60_000 });
    await expect(caixaLonga).toContainText("Transcrição automática");
    await expect(
      caixaLonga,
      "fechada, a caixa mostra só o começo — o fim do áudio não pode estar na tela",
    ).not.toContainText(FIM);
    const lerMais = caixaLonga.getByRole("button", { name: "Ler mais" });
    await expect(lerMais).toHaveAttribute("aria-expanded", "false");

    // Os três áudios têm player; só os dois do cliente têm transcrição. É o
    // controle negativo: um componente que escrevesse algo em TODO áudio
    // passaria nas asserções de cima.
    await expect(conversa.locator("audio")).toHaveCount(3);
    await expect(caixas).toHaveCount(2);

    // Curta: inteira, e sem botão — não há o que abrir.
    await expect(caixaCurta).toContainText(CURTA);
    await expect(caixaCurta.getByRole("button")).toHaveCount(0);

    const medir = () =>
      caixaLonga.evaluate((caixa) => {
        const texto = caixa.querySelector("p")!;
        const balao = caixa.closest(".rounded-2xl");
        const player = balao?.querySelector("audio")?.parentElement ?? null;
        const r = (el: Element | null) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: Math.round(b.x), y: Math.round(b.y), largura: Math.round(b.width), altura: Math.round(b.height) };
        };
        const estilo = getComputedStyle(texto);
        return {
          caixa: r(caixa),
          balao: r(balao),
          player: r(player),
          texto: r(texto),
          fonte: estilo.fontSize,
          entrelinha: estilo.lineHeight,
          alturaDoConteudo: texto.scrollHeight,
          alturaVisivel: texto.clientHeight,
          transbordaParaOLado: texto.scrollWidth > texto.clientWidth,
          janela: { largura: window.innerWidth, altura: window.innerHeight },
        };
      });

    // A conversa é MAIOR que a tela: sem isto, "acompanhou a chegada" e "não foi
    // arrancado do histórico", lá embaixo, passariam sem rolagem nenhuma.
    await expect
      .poll(() => rolagem.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 20_000 })
      .toBeGreaterThan(300);

    await caixaLonga.scrollIntoViewIfNeeded();
    const fechada = await medir();
    expect(fechada.transbordaParaOLado, "o texto não pode vazar para o lado do balão").toBe(false);
    expect(fechada.caixa!.largura, "a caixa cabe dentro do balão").toBeLessThanOrEqual(fechada.balao!.largura);
    expect(fechada.caixa!.y, "a caixa fica ABAIXO do player").toBeGreaterThanOrEqual(
      fechada.player!.y + fechada.player!.altura,
    );
    // "Um trechozinho": poucas linhas, não um parágrafo.
    expect(fechada.texto!.altura).toBeLessThanOrEqual(5 * Number.parseFloat(fechada.entrelinha));
    await captura(page, "1-trecho-com-ler-mais");

    // ── 2. "LER MAIS" abre a caixa ali mesmo ───────────────────────────────
    await lerMais.click();
    await expect(caixaLonga).toContainText(FIM);
    const lerMenos = caixaLonga.getByRole("button", { name: "Ler menos" });
    await expect(lerMenos).toHaveAttribute("aria-expanded", "true");

    const aberta = await medir();
    expect(aberta.transbordaParaOLado).toBe(false);
    // O áudio comprido rola POR DENTRO: a caixa tem teto, e o conteúdo é maior
    // que ele. Sem o teto, este balão ocuparia mais que a tela inteira.
    expect(aberta.alturaVisivel, "a caixa aberta tem altura máxima").toBeLessThanOrEqual(256);
    expect(aberta.alturaDoConteudo, "o texto inteiro é maior que a caixa — ela rola por dentro").toBeGreaterThan(
      aberta.alturaVisivel,
    );
    await caixaLonga.scrollIntoViewIfNeeded();
    await captura(page, "2-aberta");

    await lerMenos.click();
    await expect(caixaLonga).not.toContainText(FIM);

    // ── 3. O ÁUDIO QUE ACABA DE CHEGAR, para quem está no FIM da conversa ──
    //
    // Inserido AGORA, sem derivado — o estado em que a ingestão deixa a linha
    // até o worker terminar. A tela diz que está transcrevendo.
    await rolagem.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect.poll(distanciaDoFim).toBeLessThanOrEqual(2);

    const chegando = await inserirAudio({ direction: "inbound", sent_at: new Date().toISOString() });
    const transcrevendo = conversa.locator('[data-testid="transcricao-do-audio"][data-estado="transcrevendo"]');
    await expect(transcrevendo, "o áudio novo devia dizer 'Transcrevendo…'").toBeVisible({ timeout: 90_000 });
    await expect(transcrevendo).toHaveText("Transcrevendo…");
    await expect(transcrevendo).toBeInViewport();
    await captura(page, "3-transcrevendo");

    // O worker termina: o MESMO update que `media-derive-worker.ts` faz. Daqui
    // em diante o teste não navega nem recarrega — o texto tem de entrar só.
    const gravarTranscricao = async (id: string, texto: string) => {
      const { error } = await admin
        .from("messages")
        .update({ media_derived_text: texto, media_derived_status: "ready" })
        .eq("id", id)
        .eq("organization_id", creds.org_id);
      if (error) throw new Error(`update da transcrição: ${error.message}`);
    };
    await gravarTranscricao(chegando, CHEGANDO);

    const caixaQueChegou = caixas.filter({ hasText: CHEGANDO.slice(0, 40) });
    await expect(caixaQueChegou, "a transcrição pronta devia entrar na tela sem recarregar").toBeVisible({
      timeout: 90_000,
    });
    await expect(transcrevendo).toHaveCount(0);
    // O balão CRESCEU — rótulo, trecho e "Ler mais" — e a conversa acompanhou:
    // a caixa inteira está à vista e a rolagem voltou ao fim. Sem acompanhar, o
    // texto nasce abaixo da dobra para quem estava olhando o áudio chegar.
    await expect(caixaQueChegou.getByRole("button", { name: "Ler mais" })).toBeVisible();
    await expect(caixaQueChegou, "a caixa que chegou devia estar inteira na tela").toBeInViewport({ ratio: 0.95 });
    // "No fim", nesta tela, é a 7–8 px do fundo: a conversa rola até a âncora
    // que fica ANTES do respiro de baixo (`py-2`). Medido na execução
    // 37789164838, em que esta linha exigia 4 e recebeu 7. O que importa aqui é
    // não ter ficado a um balão de distância.
    await expect.poll(distanciaDoFim, { timeout: 10_000 }).toBeLessThanOrEqual(16);
    await captura(page, "4-chegou-sem-recarregar");

    // ── 3b. …e para quem SUBIU para ler o histórico ────────────────────────
    //
    // O controle do passo acima: a conversa só acompanha quem estava no fim.
    await rolagem.evaluate((el) => el.scrollTo(0, 0));
    await expect.poll(() => rolagem.evaluate((el) => el.scrollTop)).toBe(0);

    const segundo = await inserirAudio({ direction: "inbound", sent_at: new Date().toISOString() });
    await expect(transcrevendo, "o segundo áudio devia entrar na conversa").toHaveCount(1, { timeout: 90_000 });
    await gravarTranscricao(segundo, NAO_PUXA);
    await expect(caixas.filter({ hasText: NAO_PUXA })).toHaveCount(1, { timeout: 90_000 });
    // Tempo para uma rolagem suave que NÃO deve acontecer terminar de acontecer.
    await page.waitForTimeout(1_500);
    expect(
      await rolagem.evaluate((el) => el.scrollTop),
      "quem lê o histórico não pode ser levado ao fim pela chegada de uma transcrição",
    ).toBeLessThanOrEqual(2);
    await expect(conversa.locator("audio")).toHaveCount(5);

    // ── 4. NO CELULAR ──────────────────────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(caixaLonga).toBeVisible();
    await caixaLonga.scrollIntoViewIfNeeded();
    const noCelular = await medir();
    expect(noCelular.transbordaParaOLado).toBe(false);
    expect(
      noCelular.caixa!.x + noCelular.caixa!.largura,
      "no celular a caixa não pode passar da borda da tela",
    ).toBeLessThanOrEqual(noCelular.janela.largura);
    await captura(page, "5-celular");

    fs.writeFileSync(
      path.join(EVIDENCIA, "medidas.json"),
      `${JSON.stringify({ fechada, aberta, noCelular }, null, 2)}\n`,
    );
  });
});
