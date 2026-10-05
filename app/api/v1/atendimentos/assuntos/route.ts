/**
 * GET /api/v1/atendimentos/assuntos — o que a JANELA DE ENCERRAMENTO precisa
 * para abrir (migration 0293): os dois interruptores da organização e os
 * assuntos que dá para escolher, agrupados por time.
 *
 * agent+, porque é quem encerra. Client do USUÁRIO: a RLS de
 * `atendimento_assuntos` e de `attendance_teams` é a de tenant, e a organização
 * vem da sessão — nenhum filtro vem da query.
 *
 * Só entram times ATIVOS com ao menos um assunto ATIVO: time sem assunto não
 * tem o que oferecer na janela, e listá-lo seria um seletor que leva a uma
 * lista vazia.
 *
 * Os interruptores aqui são CORTESIA para a tela marcar o campo obrigatório
 * antes de mandar. Quem aplica a regra é `fn_atendimento_encerrar`: se esta
 * leitura falhar, a janela abre sem as marcas e o banco recusa do mesmo jeito.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import type { OpcoesDeEncerramento } from "@/lib/atendimento/encerramento";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { encerramentoDoAtendimento } from "@/lib/schemas/settings";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const db = await createClient();
  const [org, times, assuntos] = await Promise.all([
    db.from("organizations").select("settings").eq("id", orgId).maybeSingle(),
    db.from("attendance_teams").select("id, name").eq("organization_id", orgId).is("archived_at", null),
    db
      .from("atendimento_assuntos")
      .select("id, name, team_id")
      .eq("organization_id", orgId)
      .is("archived_at", null)
      .order("name", { ascending: true }),
  ]);
  // Falha na lista NÃO vira "não há assuntos": a janela esconderia o campo e o
  // banco recusaria o encerramento por falta dele, sem a pessoa ter onde escolher.
  if (times.error || assuntos.error) {
    return fail("internal_error", t("Não foi possível ler os assuntos de encerramento."), 500, { requestId });
  }

  const porTime = new Map<string, { id: string; name: string }[]>();
  for (const a of assuntos.data ?? []) {
    const lista = porTime.get(a.team_id) ?? [];
    lista.push({ id: a.id, name: a.name });
    porTime.set(a.team_id, lista);
  }
  const regra = encerramentoDoAtendimento(org.data?.settings);
  const resposta: OpcoesDeEncerramento = {
    ...regra,
    times: (times.data ?? [])
      .filter((time) => (porTime.get(time.id)?.length ?? 0) > 0)
      .map((time) => ({ id: time.id, name: time.name, assuntos: porTime.get(time.id) ?? [] }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
  };
  return ok(resposta, { requestId });
}
