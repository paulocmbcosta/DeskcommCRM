/**
 * GET /api/v1/conversations/{id}/aviso — o que o aviso de mensagem precisa
 * dizer: QUEM (o contato), DE ONDE (o time, com quem está) e a foto.
 *
 * ═══ POR QUE UMA ROTA, E NÃO UMA CONSULTA DO NAVEGADOR ═══
 *
 * O aviso lia contato e conversa pelo supabase-js do navegador. Só que o cookie
 * de sessão é httpOnly (CLAUDE.md): o cliente do navegador não enxerga a sessão
 * e toda consulta REST dele sai como ANÔNIMA (`lib/supabase/browser.ts` conta a
 * mesma história para o Realtime). A RLS devolvia vazio, sem erro nenhum:
 *
 *   - o título caía para "Nova mensagem" — o aviso chegava só com o texto, e o
 *     atendente não sabia de quem era (o pedido que originou esta rota);
 *   - com "só as minhas" (o padrão do atendente, 0281) a conversa voltava nula
 *     e o aviso nem aparecia.
 *
 * Aqui a leitura roda com a sessão do usuário, sob a RLS dele — quem não vê a
 * conversa não descobre de quem ela é.
 *
 * ═══ CUSTO ═══
 *
 * UMA leitura de conversa, com contato e time embutidos pelas FKs, além das
 * duas leituras leves que toda rota autenticada já faz. A foto é assinada só se
 * o contato tem foto (antes era uma ida à rota de avatar por mensagem). O
 * navegador guarda a resposta por conversa (`VALIDADE_DO_CONTEXTO_MS`), então a
 * rajada de um cliente custa uma chamada, não uma por mensagem.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Vida da URL assinada da foto — a mesma da rota de avatar. */
const FOTO_TTL_SECONDS = 300;

const idSchema = z.string().uuid();

interface LeituraDaConversa {
  contact_id: string | null;
  assigned_to_user_id: string | null;
  assigned_to_user_name: string | null;
  assignee_kind: string | null;
  contacts: {
    display_name: string | null;
    name: string | null;
    phone_number: string | null;
    avatar_storage_path: string | null;
    is_anonymized: boolean | null;
  } | null;
  attendance_teams: { name: string | null } | null;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) {
    return fail("validation_failed", "Invalid conversation id.", 400, { requestId });
  }

  // `viewer`: quem só olha o inbox também recebe aviso — o mesmo portão da
  // lista de times (`../teams`), de onde sai o nome do setor.
  const auth = await requireRole("viewer", { requestId });
  if (!auth.ok) return auth.response;
  const orgId = auth.org.orgId;

  // Cliente da SESSÃO: a RLS de conversas decide se esta pessoa vê a conversa.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "contact_id, assigned_to_user_id, assigned_to_user_name, assignee_kind, contacts(display_name, name, phone_number, avatar_storage_path, is_anonymized), attendance_teams(name)",
    )
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return fail("internal_error", "Could not read conversation.", 500, { requestId });
  const c = data as unknown as LeituraDaConversa | null;
  if (!c) return fail("not_found", "Conversation not found.", 404, { requestId });

  let foto: string | null = null;
  const caminho = c.contacts?.avatar_storage_path;
  // Contato anonimizado nunca devolve foto (mesma regra da rota de avatar).
  if (caminho && !c.contacts?.is_anonymized) {
    // A visibilidade já foi decidida pela RLS acima; o admin só ASSINA o
    // arquivo do bucket privado, que a sessão não alcança.
    const { data: assinada } = await createAdminClient()
      .storage.from("whatsapp-media")
      .createSignedUrl(caminho, FOTO_TTL_SECONDS);
    foto = assinada?.signedUrl ?? null;
  }

  return ok(
    {
      contact_id: c.contact_id,
      contato: c.contacts
        ? {
            display_name: c.contacts.display_name,
            name: c.contacts.name,
            phone_number: c.contacts.phone_number,
          }
        : null,
      time: c.attendance_teams?.name ?? null,
      atendente: c.assigned_to_user_name,
      assigned_to: c.assigned_to_user_id,
      com_ia: c.assignee_kind === "ai",
      foto,
    },
    { requestId },
  );
}
