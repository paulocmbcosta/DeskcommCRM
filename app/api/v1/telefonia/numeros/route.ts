/**
 * GET  /api/v1/telefonia/numeros — os números de telefone da organização (admin).
 * POST /api/v1/telefonia/numeros — conecta um número novo (admin).
 *
 * Telefonia SIP, spec 20 §7. Cada número é a conta SIP que a organização
 * contratou de uma operadora: servidor, usuário e senha. A senha entra em claro
 * só no corpo deste POST, é cifrada no mesmo comando que grava e nunca volta
 * num GET — a tela mostra que existe, não qual é.
 *
 * Salvar não espera a operadora: o número nasce `STARTING`, o Asterisk recebe o
 * tronco na hora (quando alcançável) e o estado do registro (Conectado / senha
 * recusada / sem resposta) aparece na linha em segundos, pelo worker.
 *
 * Fase 2: o número pode nascer apontando para um time OU um menu de voz
 * (`menu_id`); `criarNumero` trava o menu na mesma transação do INSERT.
 *
 * O POST aceita `Idempotency-Key: <uuid>` (CLAUDE.md, spec 01 §7.3), pelo helper
 * do repo (`comIdempotencia`), no padrão do POST de menus: a mesma chave com o
 * mesmo corpo devolve o número da primeira vez sem conectar outro; com outro
 * corpo, 409 `idempotency_conflict`; recusa não vira recibo.
 *
 * A SENHA SIP FICA FORA DO RECIBO. O helper guarda `sha256(JSON do corpo)` SEM
 * sal em `idempotency_keys.request_hash`, legível pela organização, e os outros
 * campos do corpo (servidor, usuário, número) a própria tela mostra: com a senha
 * dentro, o hash a entregaria por força bruta offline. A identidade da operação
 * é o corpo SEM a senha (`identidadeDaCriacao`); a resposta guardada é o
 * `NumeroPublico`, que não tem a senha. O preço: a mesma chave com a mesma conta
 * e OUTRA senha é replay, não 409 — a chave identifica "conectar este número", e
 * quem corrige a senha manda uma chave nova (ou edita o número).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import {
  MENSAGEM_DA_FALHA,
  criarNumero,
  numeroSchema,
  numerosDaOrg,
  statusDaFalhaDoCadastro,
  type EntradaDoNumero,
  type NumeroPublico,
} from "@/lib/channels/telefonia/numeros";
import { empurrarTroncoAgora } from "@/lib/channels/telefonia/empurrar";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Tag do endpoint no recibo de idempotência. Muda de rota, muda de recibo. */
const ENDPOINT_DA_CRIACAO = "/api/v1/telefonia/numeros";

const chaveSchema = z.string().uuid();

/** A recusa da criação, carregada para FORA do `executar` da idempotência sem virar recibo. */
class Recusa extends Error {
  constructor(readonly resposta: Response) {
    super("recusa da criação do número");
  }
}

/** O que identifica a operação no recibo: o corpo SEM a senha (o porquê no cabeçalho). */
function identidadeDaCriacao(e: EntradaDoNumero): Omit<EntradaDoNumero, "senha"> {
  const { senha: _senha, ...resto } = e;
  return resto;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia" });
  if (!authz.ok) return authz.response;
  const numeros = await numerosDaOrg(getRequestPool(), authz.org.orgId);
  return ok({ oferecida: configAriDoAmbiente() !== null, numeros }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "telefonia" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = numeroSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }

  // Chave malformada é recusada antes de qualquer efeito, sem recibo.
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !chaveSchema.safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  const pool = getRequestPool();
  const org = authz.org.orgId;

  /** O efeito: conecta, audita, empurra e descreve o número. Recusa LANÇA `Recusa` — assim não vira recibo. */
  const efetivar = async (): Promise<{ resposta: NumeroPublico | null; status: 201 }> => {
    const r = await criarNumero(pool, org, parsed.data);
    if (!r.ok) {
      throw new Recusa(fail(r.motivo, t(MENSAGEM_DA_FALHA[r.motivo]), statusDaFalhaDoCadastro(r.motivo), { requestId }));
    }

    void audit({
      action: "channel.phone_trunk_created",
      actorUserId: authz.user.id,
      organizationId: org,
      resourceType: "channel_session",
      resourceId: r.id,
      metadata: {
        servidor: parsed.data.servidor,
        usuario: parsed.data.usuario,
        time_id: parsed.data.time_id,
        menu_id: parsed.data.menu_id ?? null,
        prefixo: parsed.data.prefixo ?? null,
      },
      requestId,
    });

    await empurrarTroncoAgora(pool, r.id);
    const numeros = await numerosDaOrg(pool, org);
    return { resposta: numeros.find((n) => n.id === r.id) ?? null, status: 201 };
  };

  try {
    if (chave === null) {
      const { resposta, status } = await efetivar();
      return ok(resposta, { requestId, status });
    }
    const desfecho = await comIdempotencia<NumeroPublico | null>({
      db: await createClient(),
      organizationId: org,
      endpoint: ENDPOINT_DA_CRIACAO,
      chave,
      corpo: identidadeDaCriacao(parsed.data),
      executar: efetivar,
    });
    if (desfecho.tipo === "conflito") {
      return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, { requestId });
    }
    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch (erro) {
    if (erro instanceof Recusa) return erro.resposta;
    throw erro;
  }
}
