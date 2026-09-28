/**
 * PATCH  /api/v1/telefonia/menus/[id] — edita o menu (opções, time padrão, falas) (admin; sem ElevenLabs).
 * DELETE /api/v1/telefonia/menus/[id] — arquiva o menu (admin). Recusado (409
 *        `menu_em_uso`, com os números em `details`) enquanto algum número o toca:
 *        arquivar calaria a URA daquele número. `arquivarMenu` trava a linha do menu
 *        e confere o uso num comando separado, então não corre com quem aponta um
 *        número para ele (`travarMenuAtivo`).
 *
 * O id do caminho é conferido DEPOIS do papel: quem não é admin não aprende nada
 * sobre o formato. A organização é a da SESSÃO em toda consulta.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { MENSAGEM_DA_FALHA_DO_MENU, arquivarMenu, mensagemDoMenuEmUso } from "@/lib/telefonia/menus";

import { salvarMenu } from "../_salvar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return salvarMenu(req, (await ctx.params).id);
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia_menus" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const id = idSchema.safeParse((await ctx.params).id);
  if (!id.success) return fail("not_found", t(MENSAGEM_DA_FALHA_DO_MENU.nao_encontrado), 404, { requestId });
  const menuId = id.data;
  const r = await arquivarMenu(getRequestPool(), authz.org.orgId, menuId);
  if (!r.ok) {
    if (r.motivo === "nao_encontrado") return fail("not_found", t(MENSAGEM_DA_FALHA_DO_MENU.nao_encontrado), 404, { requestId });
    if (r.motivo === "menu_em_uso") {
      return fail("menu_em_uso", mensagemDoMenuEmUso(r.numeros, t), 409, { requestId, details: { numeros: r.numeros } });
    }
    return fail(r.motivo, t(MENSAGEM_DA_FALHA_DO_MENU[r.motivo]), 409, { requestId });
  }

  void audit({
    action: "phone.menu_archived",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "phone_menu",
    resourceId: menuId,
    metadata: {},
    requestId,
  });
  return ok({ arquivado: true }, { requestId });
}
