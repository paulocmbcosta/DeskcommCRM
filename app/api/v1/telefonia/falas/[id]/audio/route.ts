/**
 * GET /api/v1/telefonia/falas/[id]/audio — os bytes μ-law de uma fala SALVA, para
 * a tela ouvir o que as ligações tocam (qualquer membro da organização).
 *
 * O bucket é privado: a tela nunca recebe URL do Storage. Esta rota:
 *  - só lê a fala da organização da SESSÃO (`falaPorId` filtra id E organização);
 *  - só baixa o objeto `<org da sessão>/<hash>.ulaw`, montado aqui por
 *    `caminhoDaFala` — que recusa organização fora de UUID e hash fora de sha256
 *    hexadecimal minúsculo, então nenhum pedaço vira `..` ou `/`. O
 *    `storage_path` gravado na linha só vale se for IGUAL a esse; se não for, a
 *    rota responde 404 e não baixa nada (o CHECK do banco já exige a igualdade:
 *    isto é a segunda camada, não a única);
 *  - devolve `audio/basic` (μ-law 8 kHz, RFC 2046), com cache só privado e sem
 *    guardar (`no-store`): o mesmo id passa a tocar outro áudio quando a fala é
 *    salva de novo, e um cache velho faria a pessoa ouvir a fala anterior.
 * O navegador converte em WAV (`ulawParaWav`). Sem custo na ElevenLabs. A prévia
 * (ainda não salva) não passa por aqui: ela chega no corpo da própria resposta da
 * rota da prévia. Leitura não audita.
 *
 * "O áudio sumiu" (404 `audio_ausente`: gere a prévia de novo e salve, que
 * conserta a linha) e "o Storage falhou" (502 `audio_indisponivel`: tente de novo)
 * são respostas diferentes: a primeira pede uma ação, a segunda só paciência.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { caminhoDaFala, falaPorId } from "@/lib/telefonia/falas";
import { armazemDaInstalacao } from "@/lib/telefonia/servico-de-falas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** O caminho da fala, só se a linha bater com `<org da sessão>/<hash>.ulaw`. `null` = não serve. */
function caminhoConferido(organizationId: string, hash: string, gravado: string): string | null {
  let caminho: string;
  try {
    caminho = caminhoDaFala(organizationId, hash);
  } catch {
    return null;
  }
  return gravado === caminho ? caminho : null;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "telefonia_falas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const naoEncontrada = () => fail("not_found", t("Fala não encontrada."), 404, { requestId });

  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return naoEncontrada();
  const org = authz.org.orgId;
  const fala = await falaPorId(getRequestPool(), org, id.data);
  if (!fala || fala.status !== "ready" || !fala.storage_path) return naoEncontrada();

  const caminho = caminhoConferido(org, fala.content_hash, fala.storage_path);
  if (!caminho) {
    logger.warn("[telefonia] áudio da fala: o caminho gravado não é o da organização e do hash", {
      organization_id: org,
      fala_id: fala.id,
    });
    return naoEncontrada();
  }

  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await armazemDaInstalacao().baixar(caminho);
  } catch (e) {
    logger.error("[telefonia] áudio da fala: o Storage falhou", {
      etapa: "baixar",
      organization_id: org,
      fala_id: fala.id,
      causa: e instanceof Error ? e.message.slice(0, 300) : "desconhecida",
    });
    return fail("audio_indisponivel", t("O áudio desta fala não está disponível agora. Tente de novo em instantes."), 502, {
      requestId,
    });
  }
  if (!bytes || bytes.length === 0) {
    return fail("audio_ausente", t("O áudio desta fala não foi encontrado. Gere a prévia de novo e salve."), 404, {
      requestId,
    });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "audio/basic",
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}
