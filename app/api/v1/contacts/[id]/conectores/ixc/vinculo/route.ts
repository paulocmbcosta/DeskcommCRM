/**
 * POST   /api/v1/contacts/[id]/conectores/ixc/vinculo — liga o contato a um cadastro do IXC.
 * DELETE /api/v1/contacts/[id]/conectores/ixc/vinculo?cadastro=<id> — desfaz.
 *
 * Dois jeitos de vincular, e o servidor CONFERE os dois no IXC antes de gravar —
 * o navegador nunca é a fonte de "este id é deste contato":
 *
 *   { cadastro_id } — o atendente escolheu entre os candidatos do telefone. O id
 *       só vale se ESTIVER entre os candidatos que o telefone deste contato
 *       devolve agora. Sem isso, qualquer `agent` vincularia qualquer contato a
 *       qualquer cadastro e abriria o financeiro de quem quisesse.
 *   { documento }   — CPF/CNPJ informado pelo cliente. Vale o que o IXC achar; se
 *       achar mais de um cadastro com o mesmo documento, vincula todos (é a mesma
 *       pessoa com dois cadastros — recadastro).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { clientesPorDocumento, clientesPorTelefone } from "@/lib/conectores/ixc/identificar";
import { documentoNaMascara } from "@/lib/conectores/ixc/mascara";
import type { FormaDeVerificacao } from "@/lib/conectores/tipos";
import { desvincular, vincular } from "@/lib/conectores/vinculos";
import { requireSupportWrite } from "@/lib/impersonate/support";

import { contextoIxc, limparErroSeHavia, respostaDaFalha } from "../_contexto";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const vincularSchema = z.union([
  z.object({ cadastro_id: z.string().trim().regex(/^\d{1,12}$/) }).strict(),
  z.object({ documento: z.string().trim().min(11).max(20) }).strict(),
]);

export async function POST(req: NextRequest, rota: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const ctx = await contextoIxc((await rota.params).id, requestId);
  if (!ctx.ok) return ctx.response;

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("invalid_request", ctx.t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = vincularSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", ctx.t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }

  try {
    let ids: string[];
    let verificadoPor: FormaDeVerificacao;

    if ("documento" in parsed.data) {
      const mascarado = documentoNaMascara(parsed.data.documento);
      if (!mascarado) {
        return fail("validation_failed", ctx.t("CPF ou CNPJ inválido. Confira os números."), 422, { requestId });
      }
      ids = (await clientesPorDocumento(ctx.credencial, mascarado)).map((c) => c.id);
      verificadoPor = "documento";
      if (ids.length === 0) {
        return fail("not_found", ctx.t("Não há cadastro no IXC com este documento."), 404, { requestId });
      }
    } else {
      const pedido = parsed.data.cadastro_id;
      const candidatos = await clientesPorTelefone(ctx.credencial, ctx.contato.phone_number);
      if (!candidatos.some((c) => c.id === pedido)) {
        return fail("forbidden", ctx.t("Este cadastro não corresponde ao telefone do contato."), 403, { requestId });
      }
      ids = [pedido];
      verificadoPor = "manual";
    }
    await limparErroSeHavia(ctx);

    for (const externalId of ids) {
      const criou = await vincular({
        admin: ctx.admin,
        orgId: ctx.orgId,
        contactId: ctx.contato.id,
        conector: "ixc",
        externalId,
        verificadoPor,
        userId: ctx.userId,
      });
      if (criou) {
        void audit({
          action: "conector.vinculo_criado",
          actorUserId: ctx.userId,
          organizationId: ctx.orgId,
          resourceType: "contact",
          resourceId: ctx.contato.id,
          metadata: { conector: "ixc", cadastro: externalId, verificado_por: verificadoPor },
          requestId,
        });
      }
    }
    return ok({ cadastros: ids }, { status: 201, requestId });
  } catch (err) {
    return respostaDaFalha(err, ctx, requestId);
  }
}

export async function DELETE(req: NextRequest, rota: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const ctx = await contextoIxc((await rota.params).id, requestId);
  if (!ctx.ok) return ctx.response;

  const cadastro = req.nextUrl.searchParams.get("cadastro") ?? "";
  if (!/^\d{1,12}$/.test(cadastro)) {
    return fail("validation_failed", ctx.t("Campos inválidos."), 422, { requestId });
  }

  try {
    const removeu = await desvincular(ctx.admin, ctx.orgId, ctx.contato.id, "ixc", cadastro);
    if (!removeu) return fail("not_found", ctx.t("Este vínculo não existe."), 404, { requestId });
    void audit({
      action: "conector.vinculo_removido",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
      resourceType: "contact",
      resourceId: ctx.contato.id,
      metadata: { conector: "ixc", cadastro },
      requestId,
    });
    return ok({ removido: true }, { requestId });
  } catch {
    return fail("internal_error", "Erro ao desfazer o vínculo.", 500, { requestId });
  }
}
