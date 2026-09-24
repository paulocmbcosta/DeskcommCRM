/**
 * `GET /api/v1/conversations/teams/fila` — POR QUE ninguém pega a fila de cada
 * time. É a dica do chip "Suporte · 3 na fila" na aba Todas: o número diz que
 * há gente esperando; isto diz o que fazer a respeito.
 *
 * Um motivo por time, e não por conversa (decisão do dono, 2026-09-24): a causa
 * é do SETOR — ninguém do time está disponível, ou todos estão no limite — e
 * repeti-la em cada card mudaria a cada minuto sem dizer nada novo.
 *
 * A régua é `loadEligibleAttendants`, a MESMA do roteador (`lib/routing/`). Se
 * esta dica dissesse "tem gente livre" com o roteador achando que não, ninguém
 * saberia qual dos dois mente.
 *
 * Admin client porque a disponibilidade e a carga de OUTROS atendentes não são
 * legíveis pela sessão de um `agent`; a organização sai do cookie validado
 * (`requireRole`) e toda consulta abaixo filtra `organization_id` — o
 * carregador faz o mesmo em cada leitura. Devolve só códigos, nunca quem está
 * disponível: o atendente não precisa saber quem o colega é para entender que
 * o setor está cheio.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import type { FilaDoTime, MotivoDaFila } from "@/lib/inbox/fila-do-time";
import { loadEligibleAttendants } from "@/lib/routing/eligibles";
import { createAdminClient } from "@/lib/supabase/admin";
import { carregarTimes } from "@/lib/times/catalogo";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId; // fonte confiável (cookie validado), NUNCA a query

  try {
    const admin = createAdminClient();
    const agora = new Date();
    const times = await carregarTimes(admin, orgId, agora, { incluirArquivados: false });

    const { data: membros, error: erroMembros } = await admin
      .from("attendance_team_members")
      .select("team_id, user_id")
      .eq("organization_id", orgId);
    if (erroMembros) throw new Error(erroMembros.message);
    const { data: disponiveis, error: erroDisp } = await admin
      .from("attendant_availability")
      .select("user_id")
      .eq("organization_id", orgId)
      .eq("is_available", true);
    if (erroDisp) throw new Error(erroDisp.message);
    const disponivel = new Set((disponiveis ?? []).map((d) => d.user_id as string));

    const resultado: FilaDoTime[] = [];
    for (const time of times) {
      const doTime = (membros ?? []).filter((m) => m.team_id === time.id).map((m) => m.user_id as string);
      let motivo: MotivoDaFila;
      if (!time.aberto_agora) motivo = "fechado";
      else if (doTime.length === 0) motivo = "sem_membros";
      else if (!doTime.some((u) => disponivel.has(u))) motivo = "ninguem_disponivel";
      else {
        const elegiveis = await loadEligibleAttendants(admin, orgId, agora, {
          kind: "organization_summary",
          teamId: time.id,
        });
        motivo = elegiveis.length > 0 ? "livre" : "todos_ocupados";
      }
      resultado.push({ team_id: time.id, motivo });
    }
    return ok(resultado, { requestId });
  } catch {
    // A dica não derruba o inbox: sem ela, o chip mostra o número sem o motivo.
    return fail("internal_error", t("Não foi possível ler a fila dos times."), 500, { requestId });
  }
}
