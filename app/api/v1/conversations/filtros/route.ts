/**
 * GET /api/v1/conversations/filtros — as opções dos seletores do funil do Inbox
 * (atendentes, caixas de entrada e assuntos). A régua está em `./_handler.ts`.
 *
 * `viewer`+: o observador não atende, mas é quem cobra — e é quem mais filtra.
 * Leitura pura: não audita.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

import { carregarOpcoesDosFiltros } from "./_handler";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  try {
    const opcoes = await carregarOpcoesDosFiltros({
      db: await createClient(),
      admin: isServiceRoleConfigured() ? createAdminClient() : null,
      // Fonte confiável: a organização do cookie validado, nunca da query.
      orgId: authz.org.orgId,
      role: authz.org.role,
      nomes: nomesDosAtendentes,
    });
    return ok(opcoes, { requestId });
  } catch {
    // As opções não derrubam o Inbox: quem chama trata a falha deixando os
    // seletores sem lista, e a tela segue funcionando.
    return fail("internal_error", t("Não foi possível carregar as opções dos filtros."), 500, { requestId });
  }
}
