/**
 * GET /api/v1/metrics/assuntos — do que os atendimentos encerrados trataram
 * (migration 0293): por setor e por assunto, no período.
 *
 * manager+. É número de gestão, e gerente e administrador enxergam todas as
 * conversas da organização — por isso a agregação roda pelo ADMIN client numa
 * função sem seletor de linha (`fn_metricas_de_assuntos`), com a organização
 * vinda da SESSÃO, nunca da query. A RLS por linha aqui só custaria (0283).
 *
 * Período padrão: últimos 30 dias. Teto de 92 dias (um trimestre): acima disso
 * a pergunta já é de exportação, não de painel. Read-only ⇒ sem audit.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { agruparAssuntos, type LinhaDeAssunto } from "@/lib/metrics/assuntos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DIA_MS = 24 * 60 * 60 * 1000;
const PADRAO_MS = 30 * DIA_MS;
const TETO_MS = 92 * DIA_MS;

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) return fail("validation_failed", t("Período inválido."), 422, { requestId });

  const ate = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const desde = parsed.data.from ? new Date(parsed.data.from) : new Date(ate.getTime() - PADRAO_MS);
  if (desde.getTime() >= ate.getTime()) {
    return fail("validation_failed", t("O início do período precisa ser antes do fim."), 422, { requestId });
  }
  if (ate.getTime() - desde.getTime() > TETO_MS) {
    return fail("validation_failed", t("Escolha um período de até 92 dias."), 422, { requestId });
  }

  // Sem service role a função não é alcançável (só `service_role` tem EXECUTE).
  // Dizer isso é melhor que um painel zerado que parece "ninguém atendeu".
  if (!isServiceRoleConfigured()) {
    return fail("internal_error", t("Os números por assunto precisam da chave de serviço configurada."), 503, { requestId });
  }

  const { data, error } = await createAdminClient().rpc("fn_metricas_de_assuntos", {
    p_org: authz.org.orgId,        // fonte confiável — a sessão
    p_from: desde.toISOString(),
    p_to: ate.toISOString(),
  });
  if (error) return fail("internal_error", t("Não foi possível calcular os números por assunto."), 500, { requestId });

  return ok(
    { from: desde.toISOString(), to: ate.toISOString(), ...agruparAssuntos((data ?? []) as LinhaDeAssunto[]) },
    { requestId },
  );
}
