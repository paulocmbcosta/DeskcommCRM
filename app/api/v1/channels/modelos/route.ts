/**
 * GET /api/v1/channels/modelos?channel_session_id=<uuid>
 *
 * Os modelos que ESTA conexão pode disparar agora, com o contrato de parâmetros
 * já derivado — a pergunta que quem atende faz, na hora de falar primeiro ou de
 * reabrir uma conversa cuja janela fechou.
 *
 * ─── Por que uma rota nova, com duas já existindo ───────────────────────────
 *
 * Porque as duas de antes respondiam a MESMA pergunta com autorização, formato
 * e completude diferentes, e as duas divergências barravam justamente o caso de
 * uso desta rota. O diagnóstico está no cabeçalho de
 * `lib/channels/modelos-para-envio.ts`; o resumo é que um `agent` levava 403 no
 * canal oficial e lia "Nenhum modelo aprovado ainda" — uma frase falsa.
 *
 * As antigas continuam: elas servem a tela de ADMINISTRAÇÃO dos modelos
 * (Conexões), que precisa ver reprovado, motivo de recusa e nota de qualidade —
 * coisas que não cabem num seletor de envio e que o `agent` não deve ler.
 *
 * ─── `agent`, e não `admin` ─────────────────────────────────────────────────
 *
 * Quem atende é quem manda modelo. Exigir `admin` aqui é exigir que o dono da
 * empresa esteja logado para que um atendente responda um cliente fora das 24h.
 *
 * ─── Nenhum nome de provider aparece nesta rota ─────────────────────────────
 *
 * Toda a decisão mora em `lib/channels/`, atrás de `modelosParaEnvio`
 * (invariante 1 de `docs/doctrine/restricao-de-canal.md`). Aqui só passa o id da
 * conexão e volta `exige_modelo`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { modelosParaEnvio } from "@/lib/channels/modelos-para-envio";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const querySchema = z.object({ channel_session_id: z.string().uuid() });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "channels_modelos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = querySchema.safeParse({
    channel_session_id: req.nextUrl.searchParams.get("channel_session_id") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_error", t("Informe a conexão (channel_session_id)."), 422, {
      requestId,
    });
  }

  try {
    // Admin client com `organization_id` SEMPRE explícito (anti-pattern 10): a
    // org sai do gate de papel acima, nunca da query string. `meta_templates`
    // não tem policy de leitura para `agent`, e é por isso que a consulta não
    // pode ir pelo client de sessão — mas o filtro de tenant é manual e está
    // dentro de `modelosParaEnvio`, nos dois SELECTs.
    const resultado = await modelosParaEnvio(
      createAdminClient(),
      authz.org.orgId,
      parsed.data.channel_session_id,
    );
    return ok(
      { exige_modelo: resultado.exigeModelo, modelos: resultado.modelos },
      { requestId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    if (msg === "session_not_found") {
      return fail("not_found", t("Conexão não encontrada nesta organização."), 404, { requestId });
    }
    return fail("internal_error", msg, 500, { requestId });
  }
}
