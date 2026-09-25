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
 * ═══ CUSTO — o dono pediu cuidado com a CPU do banco ═══
 *
 * Por chamada: `getUser` (serviço de Auth) + as duas leituras de
 * `loadAuthUser` (`platform_admins`, `user_organizations`, memorizadas por
 * requisição) + UMA leitura da conversa, com contato e time embutidos pelas FKs
 * num SQL só, pela chave primária. A foto é assinada só se o contato TEM foto.
 *
 * O portão é `loadAuthUser`, o mesmo da rota de avatar, e não `requireRole`:
 * este faz ainda duas RPCs e uma listagem de fatores de MFA por chamada, e
 * aqui quem decide o que a pessoa pode ler é a RLS da leitura — quem não é
 * membro não vê linha nenhuma. (Sessão `aal1` de quem tem fator não ganha nada
 * aqui que já não tenha: o mesmo JWT lê a mesma linha direto no PostgREST, sob
 * a mesma RLS.)
 *
 * O navegador guarda a resposta — e a falha — por conversa
 * (`VALIDADE_DO_CONTEXTO_MS`) e junta pedidos simultâneos num só: a rajada de
 * um cliente custa uma chamada por aba, não uma por mensagem.
 *
 * O que não é de graça, declarado: antes o aviso fazia uma consulta anônima que
 * a RLS derrubava logo no início (barata e inútil); para o atendente com "só as
 * minhas", o aviso agora custa uma chamada de verdade por conversa ativa a cada
 * 15 s. É o preço de ele funcionar. Para o gestor, a conta caiu: antes eram a
 * consulta anônima e a rota de avatar a CADA mensagem, sem cache.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Vida da URL assinada da foto — a mesma da rota de avatar. */
const FOTO_TTL_SECONDS = 300;

const idSchema = z.string().uuid();

interface LeituraDaConversa {
  status: string;
  bot_silenced_until: string | null;
  assigned_to_user_id: string | null;
  assigned_to_user_name: string | null;
  assignee_kind: string | null;
  contacts: {
    display_name: string | null;
    name: string | null;
    phone_number: string | null;
    avatar_storage_path: string | null;
    is_anonymized: boolean | null;
    force_human: boolean | null;
    is_blocked: boolean | null;
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

  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return fail("no_active_org", "No active organization.", 403, { requestId });
  const orgId = activeOrg.orgId;

  // Cliente da SESSÃO: a RLS de conversas decide se esta pessoa vê a conversa.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "status, bot_silenced_until, assigned_to_user_id, assigned_to_user_name, assignee_kind, contacts(display_name, name, phone_number, avatar_storage_path, is_anonymized, force_human, is_blocked), attendance_teams(name)",
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

  // A régua ÚNICA de "quem está no comando" — a mesma do cabeçalho do Inbox.
  const { comando } = comandoDaConversa({
    status: c.status,
    assigned_to_user_id: c.assigned_to_user_id,
    assigned_to_user_name: c.assigned_to_user_name,
    assignee_kind: c.assignee_kind,
    bot_silenced_until: c.bot_silenced_until,
    force_human: c.contacts?.force_human ?? null,
    is_blocked: c.contacts?.is_blocked ?? null,
  });

  return ok(
    {
      contato: c.contacts
        ? {
            display_name: c.contacts.display_name,
            name: c.contacts.name,
            phone_number: c.contacts.phone_number,
          }
        : null,
      time: c.attendance_teams?.name ?? null,
      comando,
      foto,
    },
    { requestId },
  );
}
