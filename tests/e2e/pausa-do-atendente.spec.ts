/**
 * [P1] O atendente entra em pausa com MOTIVO, o gestor vê, e o time ganha teto.
 *
 * Numa operação com equipe, "indisponível" não basta: banheiro, almoço e "fui
 * embora" precisam ser coisas diferentes, e quem está em pausa não pode receber
 * conversa nova — a do time dele vai para o colega, ou espera na fila.
 *
 * Esta spec dirige o FRONTEND, logada, clicando. Três coisas que ela mede e
 * teste de unidade não alcança:
 *   1. o controle de status existe na barra de cima de QUALQUER tela (o rodízio
 *      distribui esteja a pessoa onde estiver) — aqui ele é usado no Funil;
 *   2. a pausa que a tela mostra é a que o BANCO gravou: o histórico nasce com o
 *      motivo e fecha quando a pessoa volta, e o gestor lê o motivo no painel de
 *      Equipe sem recarregar o mundo;
 *   3. o teto do time, salvo pela tela, VOLTA DO BANCO depois do reload — não do
 *      estado do React, que é o falso positivo clássico de tela de configuração.
 *
 * A distribuição em si (quem recebe, quem espera) é provada no banco, em
 * `tests/invariants/pausa-do-atendente-e-limite-por-time.test.ts`: o claim é uma
 * transação, e é lá que pausa e teto são revalidados.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const evidence = ".superpowers/evidence/pausa-do-atendente";

async function consulta<T extends Record<string, unknown>>(texto: string, valores: unknown[] = []): Promise<T[]> {
  const cliente = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await cliente.connect();
  try {
    return (await cliente.query(texto, valores)).rows as T[];
  } finally {
    await cliente.end();
  }
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test("pausa com motivo pela barra superior, visível ao gestor, e teto do time salvo pela tela", async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(evidence, { recursive: true });

  const password = `Local-${randomUUID()}!`;
  const emailAna = `pausa-ana-${randomUUID()}@invariant.test`;
  const emailBia = `pausa-bia-${randomUUID()}@invariant.test`;
  let org = "";
  const usuarios: string[] = [];

  const ctxAna = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxBia = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ana = await ctxAna.newPage();
  const bia = await ctxBia.newPage();

  try {
    const criar = async (email: string, nome: string) => {
      const r = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: nome } });
      if (r.error || !r.data.user) throw r.error;
      usuarios.push(r.data.user.id);
      return r.data.user.id;
    };
    const idAna = await criar(emailAna, "Ana Pausa");
    const idBia = await criar(emailBia, "Bia Gestora");
    const orgRow = await db
      .from("organizations")
      .insert({
        display_name: "Pausa local",
        legal_name: "Pausa local",
        slug: `pausa-${randomUUID()}`,
        onboarded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (orgRow.error) throw orgRow.error;
    org = orgRow.data.id as string;
    const membros = await db.from("user_organizations").insert([
      { organization_id: org, user_id: idAna, role: "agent", accepted_at: new Date().toISOString() },
      { organization_id: org, user_id: idBia, role: "manager", accepted_at: new Date().toISOString() },
    ]);
    if (membros.error) throw membros.error;
    const time = randomUUID();
    await consulta(`insert into public.attendance_teams (id, organization_id, name, slug) values ($1, $2, 'Suporte', 'suporte')`, [time, org]);

    // ─── 1. O controle está na barra de cima, fora do inbox ─────────────────
    await login(ana, emailAna, password);
    await ana.goto("/app/kanban");
    const controle = ana.getByTestId("status-do-atendente");
    await expect(controle).toBeVisible();
    await expect(controle).toHaveAttribute("data-status", "offline");

    await controle.click();
    await ana.getByTestId("status-ficar-online").click();
    await expect(controle).toHaveAttribute("data-status", "online");
    await expect
      .poll(async () => (await consulta<{ is_available: boolean }>(`select is_available from public.attendant_availability where user_id = $1`, [idAna]))[0]?.is_available)
      .toBe(true);
    // O SINAL DE VIDA saiu: é ele que impede o cron de derrubar quem está online.
    await expect
      .poll(async () => (await consulta<{ ok: boolean }>(`select last_heartbeat_at > now() - interval '2 minutes' as ok from public.attendant_availability where user_id = $1`, [idAna]))[0]?.ok)
      .toBe(true);

    // ─── 2. Entrar em pausa exige motivo ────────────────────────────────────
    await controle.click();
    await ana.getByTestId("status-pausar").click();
    const dialogo = ana.getByTestId("dialogo-de-pausa");
    await expect(dialogo).toBeVisible();
    await expect(ana.getByTestId("confirmar-pausa")).toBeDisabled();
    await ana.getByTestId("motivo-almoco").click();
    // O escolhido tem de PARECER escolhido — medido, não olhado: com seis caixas
    // iguais na tela, a pessoa confirmaria sem saber o que marcou.
    await expect(ana.getByTestId("motivo-almoco")).toHaveAttribute("aria-checked", "true");
    const fundo = (id: string) =>
      ana.getByTestId(id).evaluate((el) => getComputedStyle(el).backgroundColor + "|" + getComputedStyle(el).borderColor);
    // `poll`: a caixa tem `transition-colors`, e medida no instante do clique a
    // cor ainda é a de antes — a primeira versão desta asserção reprovou a tela
    // certa por medir cedo demais.
    const semEscolha = await fundo("motivo-banheiro");
    await expect
      .poll(() => fundo("motivo-almoco"), { message: "o motivo escolhido não se distingue dos outros", timeout: 3_000 })
      .not.toBe(semEscolha);
    await ana.locator("#observacao-da-pausa").fill("volto às 13h");
    await ana.screenshot({ path: `${evidence}/01-dialogo-de-pausa.png` });
    await ana.getByTestId("confirmar-pausa").click();

    await expect(controle).toHaveAttribute("data-status", "paused");
    await expect(controle).toContainText("Em pausa · Almoço");
    await ana.screenshot({ path: `${evidence}/02-em-pausa.png` });

    const pausa = await consulta<{ reason: string; note: string | null; aberta: boolean }>(
      `select reason, note, ended_at is null as aberta from public.attendant_pause_log where user_id = $1`,
      [idAna],
    );
    expect(pausa).toEqual([{ reason: "almoco", note: "volto às 13h", aberta: true }]);
    const disponibilidade = await consulta<{ is_available: boolean }>(
      `select is_available from public.attendant_availability where user_id = $1`,
      [idAna],
    );
    expect(disponibilidade[0]?.is_available, "em pausa, o rodízio não pode escolher esta pessoa").toBe(false);

    // ─── 3. O gestor vê QUEM está em pausa e POR QUÊ ────────────────────────
    await login(bia, emailBia, password);
    await bia.goto("/app/team");
    // O painel dos atendentes mora na aba "Atendimento" da tela de Equipe.
    await bia.getByRole("tab", { name: "Atendimento" }).click();
    const selo = bia.getByTestId("atendente-em-pausa");
    await expect(selo).toBeVisible({ timeout: 30_000 });
    await expect(selo).toContainText("Em pausa · Almoço");
    await bia.screenshot({ path: `${evidence}/03-gestor-ve-a-pausa.png` });

    // ─── 4. Voltar encerra a pausa no histórico ─────────────────────────────
    await controle.click();
    await ana.getByTestId("status-ficar-online").click();
    await expect(controle).toHaveAttribute("data-status", "online");
    await expect
      .poll(async () => (await consulta<{ fechada: boolean; ended_by: string | null }>(`select ended_at is not null as fechada, ended_by from public.attendant_pause_log where user_id = $1`, [idAna]))[0])
      .toEqual({ fechada: true, ended_by: "self" });

    // ─── 5. O teto do time, pela tela, e de volta do banco ──────────────────
    await bia.goto("/app/settings/teams");
    await expect(bia.getByTestId("painel-de-times")).toBeVisible({ timeout: 30_000 });
    await bia.getByRole("button", { name: "Editar" }).first().click();
    const teto = bia.getByTestId("teto-do-time");
    await expect(teto).toBeVisible();
    await teto.fill("5");
    await bia.screenshot({ path: `${evidence}/04-teto-do-time.png` });
    await bia.getByRole("button", { name: /^Salvar$/ }).click();
    await expect
      .poll(async () => (await consulta<{ max_concurrent: number | null }>(`select max_concurrent from public.attendance_teams where id = $1`, [time]))[0]?.max_concurrent)
      .toBe(5);
    await bia.reload();
    // À vista no cartão, sem abrir o time…
    await expect(bia.getByTestId("resumo-do-teto")).toContainText("5");
    // …e dentro do formulário, vindo do banco.
    await bia.getByRole("button", { name: "Editar" }).first().click();
    await expect(bia.getByTestId("teto-do-time")).toHaveValue("5");
  } finally {
    await ctxAna.close();
    await ctxBia.close();
    if (org) await db.from("organizations").delete().eq("id", org);
    for (const id of usuarios) await db.auth.admin.deleteUser(id);
  }
});
