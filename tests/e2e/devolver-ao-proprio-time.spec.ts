/**
 * DEVOLVER A CONVERSA À FILA DO PRÓPRIO TIME — a troca de turno, pela tela.
 *
 * Pedido do dono (2026-09-25): o atendente que vai embora com um atendimento
 * aberto precisa devolver a conversa ao time dele, sair de responsável, e a IA
 * NÃO pode voltar a responder — quem assume é o próximo atendente do turno, pelo
 * rodízio. Antes não havia como: o encaminhamento escondia o time atual, e
 * "Liberar" devolvia a conversa ao atendimento automático.
 *
 * O que se mede aqui é o que a pessoa faz e vê: "Transferir" → "Fila do time",
 * e a conversa volta sem dono, no mesmo time, com o automático parado. Que o
 * rodízio não a devolva a quem a soltou é medido em
 * `lib/routing/worker-nao-devolve-a-quem-devolveu.test.ts` (o rodízio roda no
 * cron, fora do alcance desta tela).
 */
import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test.describe.configure({ timeout: 90_000 });

const SUFIXO = Date.now().toString().slice(-6);
const NOME_DO_TIME = `Turno ${SUFIXO}`;
let timeId: string | null = null;

test.beforeEach(async ({ page }) => {
  await loginComoAdmin(page, lerCreds());
  if (timeId) return;
  const r = await page.request.post("/api/v1/settings/teams", {
    data: { name: NOME_DO_TIME, slug: `turno-${SUFIXO}` },
  });
  expect(r.ok(), await r.text()).toBe(true);
  timeId = (await r.json()).data.id as string;
});

test.afterAll(async ({ browser }) => {
  if (!timeId) return;
  const page = await browser.newPage();
  await loginComoAdmin(page, lerCreds());
  await page.request.post(`/api/v1/settings/teams/${timeId}/archive`, { data: { arquivar: true } });
  await page.close();
});

test("quem vai embora devolve a conversa à fila do time: sai de responsável e a IA não volta", async ({
  page,
}) => {
  // 1. Uma conversa DO TIME, com o admin como responsável — o estado de quem
  //    está atendendo quando o turno acaba. Preparada pela API: o que se mede é
  //    o gesto de devolver, não o de montar a conversa.
  const nome = `Cliente Turno ${Date.now()}`;
  const criado = await page.request.post("/api/v1/contacts", { data: { name: nome, source: "manual" } });
  expect(criado.ok(), await criado.text()).toBe(true);
  const contatoId = (await criado.json()).data.contact.id as string;
  const telefone = `+5511${Date.now().toString().slice(-9)}`;
  const patch = await page.request.patch(`/api/v1/contacts/${contatoId}`, { data: { phone_number: telefone } });
  expect(patch.ok(), await patch.text()).toBe(true);

  const { data: canais } = await (await page.request.get("/api/v1/channel-sessions")).json();
  test.skip(!canais?.length, "instalação sem canal conectado — não há conversa a devolver");

  const aberta = await page.request.post("/api/v1/conversations/iniciar", {
    data: {
      channel_session_id: canais[0].id,
      contact_id: contatoId,
      phone_number: telefone,
      name: nome,
      team_id: timeId,
      mensagem: { type: "text", body: "Olá!" },
    },
  });
  expect(aberta.ok(), await aberta.text()).toBe(true);
  const conversaId = (await aberta.json()).data.conversation_id as string;

  const noTime = await page.request.post(`/api/v1/conversations/${conversaId}/team`, { data: { team_id: timeId } });
  expect(noTime.ok(), await noTime.text()).toBe(true);
  const assumiu = await page.request.post(`/api/v1/conversations/${conversaId}/claim`, { data: {} });
  expect(assumiu.ok(), await assumiu.text()).toBe(true);

  // 2. Pela TELA: Transferir → Fila do time.
  await page.goto(`/app/inbox?id=${conversaId}`);
  await page.getByTestId("acoes-da-conversa").getByRole("button", { name: /^Transferir$/ }).click();

  const dialogo = page.getByRole("dialog");
  await expect(dialogo.getByText("Transferir conversa")).toBeVisible();
  await dialogo.getByLabel("Transferir para").click();
  await page.getByRole("option", { name: new RegExp(`Fila do time ${NOME_DO_TIME}`) }).click();

  // A consequência é dita ANTES do clique: sai de responsável, o automático
  // continua parado, e não volta para quem devolveu.
  await expect(dialogo.getByText(/volta para a fila do time/i)).toBeVisible();
  await expect(dialogo.getByText(/não volta para você/i)).toBeVisible();
  await page.screenshot({ path: ".superpowers/evidence/devolver-ao-proprio-time.png" });

  await dialogo.getByRole("button", { name: /^Transferir$/ }).click();
  await expect(dialogo).toBeHidden();

  // 3. O efeito, relido do servidor.
  const depois = await page.request.get(`/api/v1/conversations/${conversaId}`);
  expect(depois.ok(), await depois.text()).toBe(true);
  const { data } = await depois.json();
  expect(data.team_id, "a conversa saiu do time").toBe(timeId);
  expect(data.assigned_to_user_id, "quem devolveu continua responsável").toBeNull();
  expect(String(data.bot_silenced_until), "o atendimento automático voltou").toBe("infinity");
});
