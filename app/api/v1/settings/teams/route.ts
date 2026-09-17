/**
 * `/api/v1/settings/teams` — o catálogo de times e o salvamento de um time.
 *
 * Molde: `app/api/v1/settings/routing/channels/route.ts`. As duas rotas fazem a
 * mesma coisa pelo mesmo caminho — LEITURA pelo client do usuário (RLS de
 * verdade, `tenant_isolation_attendance_teams_all`) e ESCRITA só por RPC
 * `security definer`, com a org resolvida de `auth.org.orgId`.
 *
 * A org NUNCA vem do corpo. `timeDeAtendimentoSchema` é `.strict()`, então um
 * `organization_id` no body é RECUSADO com 422 em vez de ignorado em silêncio —
 * é a diferença entre "não te obedeci" e "não te ouvi", e a primeira é a que o
 * cliente consegue depurar. Vigiado em `route.test.ts`.
 *
 * Por que a escrita não é um `.from(...).insert(...)`: o GRANT das duas tabelas
 * é SÓ de `select` (migration 0263). Não existe caminho de escrita pela REST —
 * nem para quem tem o papel. O upsert do time e a troca de membros são um ato
 * atômico dentro de `fn_save_attendance_team`, que também prova papel, suporte e
 * MFA no BANCO; os portões daqui são a primeira barreira, não a única.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { timeDeAtendimentoSchema } from "@/lib/schemas/routing";
import { createClient } from "@/lib/supabase/server";
import { carregarTimes } from "@/lib/times/catalogo";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

/**
 * GET — os times (INCLUSIVE os arquivados; é uma tela de configuração, e quem
 * arquivou precisa poder desarquivar) e a lista de quem pode ser alocado.
 *
 * Os membros saem de `user_organizations` com a MESMA cláusula que
 * `fn_save_attendance_team` exige (`revoked_at is null` e papel em
 * agent/manager/admin). Se a tela oferecesse alguém que a RPC recusa, o gestor
 * levaria um 422 sem entender qual nome estava errado.
 */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_teams", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  try {
    const db = await createClient();
    const times = await carregarTimes(db, auth.org.orgId, new Date(), { incluirArquivados: true });
    const { data: membros, error: erroMembros } = await db.from("user_organizations")
      .select("user_id").eq("organization_id", auth.org.orgId).is("revoked_at", null)
      .in("role", ["agent", "manager", "admin"]);
    // O supabase-js NÃO lança aqui — devolve `{ data: null, error }` —, então o
    // `catch` abaixo não pega este caso. Sem esta linha, uma falha de leitura
    // vira `membros: []` e a tela diz "esta organização não tem ninguém para
    // alocar", que é uma frase FALSA indistinguível da verdadeira. Falhar alto
    // é a única forma de o gestor descobrir que a lista está incompleta.
    if (erroMembros) throw new Error(erroMembros.message);
    const ids = (membros ?? []).map((m: { user_id: string }) => String(m.user_id));
    // `nomesDosAtendentes` devolve mapa VAZIO num self-host sem service role —
    // por decisão, com log. O rótulo genérico mantém a tela utilizável (o id é a
    // verdade; o nome é cortesia), em vez de uma lista de UUIDs crus.
    const nomes = await nomesDosAtendentes(ids);
    return ok({ times, membros: ids.map((id) => ({ id, name: nomes.get(id) ?? "Atendente sem nome" })) }, { requestId });
  } catch {
    return fail("internal_error", "Não foi possível carregar os times. Tente novamente.", 500, { requestId });
  }
}

/** POST — cria (`id: null`) ou atualiza um time, e troca os membros dele. */
export async function POST(req: Request): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_teams", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const parsed = timeDeAtendimentoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Confira o nome, o identificador e os atendentes selecionados.", 422, { requestId });

  const db = await createClient();
  const { data, error } = await db.rpc("fn_save_attendance_team", {
    p_org: auth.org.orgId,          // fonte confiável — NUNCA o body
    p_team: parsed.data.id,
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
    p_description: parsed.data.description,
    p_schedule: parsed.data.schedule,
    p_users: parsed.data.user_ids,
  });
  if (error) {
    // Os quatro códigos são RECUSAS COM SIGNIFICADO, não erro de sistema: cada
    // um vira uma frase que diz ao gestor o que consertar. O 23505 vem do
    // Postgres (unique (organization_id, slug)), os outros três a RPC levanta.
    if (error.code === "23505") return fail("conflict", "Já existe um time com esse identificador.", 409, { requestId });
    if (error.code === "P0002") return fail("not_found", "Time não encontrado.", 404, { requestId });
    if (error.code === "22023") return fail("validation_failed", "Confira o nome, o identificador e os atendentes selecionados.", 422, { requestId });
    if (error.code === "42501") return fail("forbidden", "Esta sessão não pode alterar os times.", 403, { requestId });
    return fail("internal_error", "Não foi possível salvar. Tente novamente.", 500, { requestId });
  }
  const salvo = data as { id: string } | null;
  void audit({ action: "routing.team_saved", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "attendance_team", resourceId: salvo?.id ?? null, requestId,
    metadata: { slug: parsed.data.slug, user_ids: parsed.data.user_ids } });
  return ok(data, { requestId });
}
