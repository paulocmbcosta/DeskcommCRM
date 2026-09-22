/**
 * GET /api/v1/contacts/[id]/conectores/ixc — o painel do IXC para este contato.
 *
 * Devolve um ESTADO (`vinculado` | `escolher` | `nao_encontrado` |
 * `vinculo_sem_cadastro`), e não "dados ou 404": cada um pede uma tela diferente,
 * e colapsar "não achei pelo telefone" em erro tiraria do atendente o caminho do
 * CPF. A máquina está em `lib/conectores/ixc/painel.ts`.
 *
 * É GET e pode GRAVAR: um único candidato pelo telefone vincula sozinho. A
 * gravação é idempotente (unique + 23505) e auditada só quando de fato criou.
 *
 * `?cadastro=<id>` escolhe qual dos cadastros vinculados mostrar.
 * `?conversa=<id>` diz em que canal o painel está aberto — o telefone só vincula
 * sozinho onde é identidade (`"sim"`); sem o parâmetro (ou canal que esta imagem
 * não reconhece) a resposta é `"desconhecido"`, não `"nao"` — só `"nao"` descarta
 * um vínculo por telefone já gravado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { estadoDoPainelIxc } from "@/lib/conectores/ixc/painel";

import { contextoIxc, identidadeDoTelefoneNaConversa, limparErroSeHavia, respostaDaFalha } from "./_contexto";

export const dynamic = "force-dynamic";
// Duas ondas de chamadas ao ERP, cada uma com prazo próprio de 12 s.
export const maxDuration = 40;

export async function GET(req: NextRequest, rota: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const ctx = await contextoIxc((await rota.params).id, requestId);
  if (!ctx.ok) return ctx.response;

  try {
    const estado = await estadoDoPainelIxc({
      admin: ctx.admin,
      credencial: ctx.credencial,
      orgId: ctx.orgId,
      contactId: ctx.contato.id,
      telefone: ctx.contato.phone_number,
      identidadeDoTelefone: await identidadeDoTelefoneNaConversa(ctx, req.nextUrl.searchParams.get("conversa")),
      cadastroPedido: req.nextUrl.searchParams.get("cadastro"),
    });
    await limparErroSeHavia(ctx);

    if (estado.estado === "vinculado" && estado.vinculou_agora) {
      void audit({
        action: "conector.vinculo_criado",
        // Sem `actorUserId`: quem vinculou foi o sistema, porque o telefone da
        // conversa bateu com UM cadastro. O atendente só abriu a aba.
        organizationId: ctx.orgId,
        resourceType: "contact",
        resourceId: ctx.contato.id,
        metadata: { conector: "ixc", cadastro: estado.cadastro_em_tela, verificado_por: "telefone", aberto_por: ctx.userId },
        requestId,
      });
    }
    return ok(estado, { requestId });
  } catch (err) {
    return respostaDaFalha(err, ctx, requestId);
  }
}
