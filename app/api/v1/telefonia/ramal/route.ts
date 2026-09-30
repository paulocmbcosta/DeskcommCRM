/**
 * POST /api/v1/telefonia/ramal — o ramal do navegador do atendente (agent+).
 *
 * Spec 20 §4.1. Devolve a credencial temporária do ramal (`ramal-<user_id>`),
 * o endereço WSS onde o navegador se registra e os números da organização que
 * podem fazer ligação. Sem telefonia nesta instalação ou sem número conectado,
 * devolve `{ ativo: false }` e o navegador simplesmente não registra ramal —
 * não é erro, é o estado normal de quem não usa telefone.
 *
 * A senha é do ramal DESTE usuário e só dele; com ela não se disca para número
 * nenhum (o controlador exige um pedido criado por POST /telefonia/chamadas).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ClienteAri, configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { meuRamal } from "@/lib/channels/telefonia/interna";
import { credencialDoRamal } from "@/lib/channels/telefonia/ramal";
import { numerosParaLigar } from "@/lib/channels/telefonia/saida";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function wsDoNavegador(req: NextRequest): string {
  if (env.TELEFONIA_WS_URL_PUBLICA) return env.TELEFONIA_WS_URL_PUBLICA;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost";
  const proto = (req.headers.get("x-forwarded-proto") ?? "https").split(",")[0]!.trim();
  return `${proto === "http" ? "ws" : "wss"}://${host}/telefonia/ws`;
}

export async function POST(req: NextRequest): Promise<Response> {
  // Acompanhamento de suporte não ganha ramal: registrar um telefone é poder
  // receber a ligação de um cliente, e o suporte só observa.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "telefonia_ramal" });
  if (!authz.ok) return authz.response;

  const cfg = configAriDoAmbiente();
  if (!cfg) return ok({ ativo: false, motivo: "instalacao_sem_telefonia" }, { requestId });

  const numeros = await numerosParaLigar(getRequestPool(), authz.org.orgId);
  if (numeros.length === 0) return ok({ ativo: false, motivo: "sem_numero" }, { requestId });

  try {
    const cred = await credencialDoRamal(
      new ClienteAri(cfg),
      authz.user.id,
      authz.user.full_name ?? authz.user.email,
    );
    // É mutação (grava auth/AOR/endpoint na memória do Asterisk quando o ramal
    // não existia) e entrega uma credencial: audita mesmo quando reaproveita,
    // porque a senha saiu para um navegador. Sem a senha, nunca.
    void audit({
      action: "phone_extension.credential_issued",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "phone_extension",
      resourceId: authz.user.id,
      metadata: { ramal: cred.usuario, nova: cred.nova },
      requestId,
    });
    return ok(
      {
        ativo: true,
        usuario: cred.usuario,
        senha: cred.senha,
        ws_url: wsDoNavegador(req),
        numeros,
        // O número do ramal (v3) — "Seu ramal: 201" no telefone do cabeçalho.
        numero: await meuRamal(getRequestPool(), authz.org.orgId, authz.user.id).catch(() => null),
      },
      { requestId },
    );
  } catch (e) {
    logger.warn("[telefonia] ramal não emitido", {
      request_id: requestId,
      erro: e instanceof Error ? e.message.slice(0, 160) : String(e),
    });
    return fail("telefonia_indisponivel", "A telefonia não respondeu. Tente de novo em instantes.", 503, { requestId });
  }
}
