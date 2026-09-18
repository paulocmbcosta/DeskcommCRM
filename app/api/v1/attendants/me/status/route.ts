/**
 * /api/v1/attendants/me/status — o status de ATENDIMENTO de quem está logado
 * (migration 0267): online, em pausa (com motivo) ou offline.
 *
 * GET  → o estado de agora + a carga (conversas abertas atribuídas).
 * POST → muda o status. Quem escreve é `fn_attendant_set_status`, com o client
 *        do USUÁRIO: a função confere `auth.uid()`, papel e suporte-somente-
 *        leitura DENTRO do banco — os portões daqui são a primeira barreira, não
 *        a única. O histórico de pausas é escrito por trigger, na mesma transação.
 *
 * A organização sai do cookie validado, NUNCA do corpo (`.strict()` no schema:
 * um `organization_id` no corpo é 422, não campo ignorado).
 *
 * Voltar a ficar online acorda a fila sozinho: `trg_routing_availability_changed`
 * (0228) já reage à mudança de `is_available`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { statusDoAtendente, statusDoAtendenteSchema } from "@/lib/atendimento/pausa";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { OPEN_LOAD_STATUSES } from "@/lib/routing/eligibility";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = "is_available, capacity, paused_at, pause_reason, pause_note, last_heartbeat_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "attendant_availability" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const db = await createClient();
  const [linha, carga] = await Promise.all([
    db
      .from("attendant_availability")
      .select(COLUNAS)
      .eq("organization_id", authz.org.orgId)
      .eq("user_id", authz.user.id)
      .maybeSingle(),
    db
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", authz.org.orgId)
      .eq("assigned_to_user_id", authz.user.id)
      .in("status", OPEN_LOAD_STATUSES as unknown as string[]),
  ]);
  if (linha.error) return fail("internal_error", t("Não foi possível ler o seu status."), 500, { requestId });

  const atual = linha.data as {
    is_available: boolean;
    capacity: number;
    paused_at: string | null;
    pause_reason: string | null;
    pause_note: string | null;
    last_heartbeat_at: string | null;
  } | null;
  return ok(
    {
      status: statusDoAtendente(atual, new Date()),
      paused_at: atual?.paused_at ?? null,
      pause_reason: atual?.pause_reason ?? null,
      pause_note: atual?.pause_note ?? null,
      capacity: atual?.capacity ?? null,
      // Contagem que falhou vira `null`, não zero: "0 conversas" é uma afirmação.
      current_load: carga.error ? null : (carga.count ?? 0),
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "attendant_availability" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = statusDoAtendenteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Informe o status e, na pausa, o motivo."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const db = await createClient();
  const { data, error } = await db.rpc("fn_attendant_set_status", {
    p_org: authz.org.orgId,
    p_status: parsed.data.status,
    p_reason: parsed.data.reason ?? null,
    p_note: parsed.data.note ?? null,
    p_user: null,
  });
  if (error) {
    if (error.code === "42501") return fail("forbidden", t("Esta sessão não pode mudar o status de atendimento."), 403, { requestId });
    if (error.code === "22023") return fail("validation_failed", t("Informe o status e, na pausa, o motivo."), 422, { requestId });
    if (error.code === "P0002") return fail("not_found", t("Atendente não encontrado na organização."), 404, { requestId });
    return fail("internal_error", t("Não foi possível mudar o seu status. Tente novamente."), 500, { requestId });
  }

  void audit({
    action: "attendant.status_changed",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "attendant_availability",
    resourceId: authz.user.id,
    requestId,
    // O motivo entra no rastro; a observação livre NÃO — é texto de pessoa sobre
    // si mesma, e o audit log é append-only por anos.
    metadata: { status: parsed.data.status, pause_reason: parsed.data.reason ?? null },
  });

  return ok(data, { requestId });
}
