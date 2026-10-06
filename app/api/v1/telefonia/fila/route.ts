/**
 * GET /api/v1/telefonia/fila — a fila do telefone ao vivo (aba Telefone do
 * Inbox; migration 0295): quem espera por ordem de chegada, quem está no menu,
 * em ligação, e as perdidas dos últimos 30 minutos.
 *
 * `viewer`+: todo mundo que entra no Inbox vê a fila de TODOS os times, só com
 * nome, número, time e espera (D4 do desenho) — sem ver a fila do outro setor,
 * ninguém consegue ajudar no pico. Abrir a conversa segue a RLS de sempre.
 *
 * A organização sai da sessão. A leitura é compartilhada por 1,5 s por
 * organização nesta instância: no pico, todo navegador com o Inbox aberto pede
 * ao mesmo tempo (o Realtime avisa todos juntos), e uma leitura serve a todos.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { lerFilaDoTelefone } from "@/lib/channels/telefonia/fila-da-tela";
import { traduzir } from "@/lib/i18n/dicionario";
import { FILA_DESLIGADA, type FilaDoTelefone } from "@/lib/telefonia/fila";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COMPARTILHADA_POR_MS = 1_500;
/** A chave é a organização DA SESSÃO: a leitura de uma nunca é servida a outra. */
const leituras = new Map<string, { em: number; promessa: Promise<FilaDoTelefone> }>();

/** A leitura desta organização — a que está em curso (ou acabou de acabar), ou uma nova. */
function lerCompartilhada(org: string, agora: number): Promise<FilaDoTelefone> {
  const atual = leituras.get(org);
  if (atual && agora - atual.em < COMPARTILHADA_POR_MS) return atual.promessa;
  const promessa = lerFilaDoTelefone(getRequestPool(), org);
  leituras.set(org, { em: agora, promessa });
  // A leitura que falhou não fica guardada: o próximo pedido tenta de novo.
  promessa.catch(() => {
    if (leituras.get(org)?.promessa === promessa) leituras.delete(org);
  });
  return promessa;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "telefonia_fila" });
  if (!authz.ok) return authz.response;

  if (configAriDoAmbiente() === null) {
    return ok({ ...FILA_DESLIGADA, agora: new Date().toISOString() } satisfies FilaDoTelefone, { requestId });
  }
  try {
    return ok(await lerCompartilhada(authz.org.orgId, Date.now()), { requestId });
  } catch {
    return fail("internal_error", traduzir("Não foi possível ler a fila do telefone.", authz.user.idioma), 500, { requestId });
  }
}
