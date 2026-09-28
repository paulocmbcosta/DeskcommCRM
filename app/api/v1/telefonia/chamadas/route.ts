/**
 * POST /api/v1/telefonia/chamadas — pede uma ligação de saída (agent+).
 *
 * Spec 20 §4.2 e §6. Não disca: cria o PEDIDO (uma `voice_calls` de saída com
 * dono) e devolve o destino que o ramal do navegador disca, `c-<id>`. É o
 * controlador, do lado do Asterisk, que confere o pedido e liga para fora.
 *
 * A política antifraude mora aqui e se repete no controlador: só número
 * brasileiro geográfico com DDD, só por número da própria organização,
 * no máximo 5 saídas simultâneas por organização e uma por atendente.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { MENSAGEM_DO_PEDIDO, criarPedidoDeSaida } from "@/lib/channels/telefonia/saida";
import { MENSAGEM_DA_RECUSA } from "@/lib/telefonia/numero";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pedidoSchema = z
  .object({
    contact_id: z.string().uuid().nullish(),
    numero: z.string().trim().min(1).max(40).nullish(),
    numero_da_empresa_id: z.string().uuid().nullish(),
  })
  .strict()
  .refine((p) => Boolean(p.contact_id) !== Boolean(p.numero), "informe contact_id OU numero");

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "telefonia_chamadas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!configAriDoAmbiente()) {
    return fail("telefonia_indisponivel", t("Esta instalação não tem telefonia ligada."), 409, { requestId });
  }
  const parsed = pedidoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Informe o contato ou o número."), 422, { requestId });
  }

  const r = await criarPedidoDeSaida(getRequestPool(), {
    organizationId: authz.org.orgId,
    userId: authz.user.id,
    contactId: parsed.data.contact_id ?? null,
    numero: parsed.data.numero ?? null,
    troncoId: parsed.data.numero_da_empresa_id ?? null,
  });
  if (!r.ok) {
    const mensagem = r.motivo === "numero" ? MENSAGEM_DA_RECUSA[r.recusa] : MENSAGEM_DO_PEDIDO[r.motivo];
    const codigo = r.motivo === "numero" ? `numero_${r.recusa}` : r.motivo;
    return fail(codigo, t(mensagem), r.motivo === "limite_simultaneo" || r.motivo === "ja_em_ligacao" ? 409 : 422, {
      requestId,
    });
  }

  void audit({
    action: "phone_call.started",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "voice_call",
    resourceId: r.id,
    metadata: { numero_da_empresa_id: r.troncoId, contact_id: r.contactId },
    requestId,
  });

  return ok({ id: r.id, destino: `c-${r.id}`, contact_id: r.contactId }, { requestId, status: 201 });
}
