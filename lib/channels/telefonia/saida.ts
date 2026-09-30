/**
 * O PEDIDO de ligação de saída (spec 20 §4.2 e §6) — tudo o que acontece antes
 * do Asterisk discar, do lado da API.
 *
 * O pedido é uma `voice_calls` `outbound`/`starting` com dono. O navegador disca
 * `c-<id>`; o controlador só liga para fora se o pedido existir, for deste
 * atendente e tiver menos de 60 s. Aqui mora a política: número (antifraude),
 * tronco da organização, e limite de ligações de saída simultâneas.
 */
import { randomUUID } from "node:crypto";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { numeroParaLigar, type MotivoDeRecusa } from "@/lib/telefonia/numero";

import { PROVIDER, acharOuCriarContato, acharOuCriarConversa, atribuirConversa } from "./repositorio";

/** Ligações de saída simultâneas por organização — teto contra fraude e contra clique repetido. */
export const SAIDAS_SIMULTANEAS_MAX = 5;

export interface NumeroParaDiscar {
  id: string;
  nome: string | null;
  numero: string | null;
  conectado: boolean;
}

/** Os números da organização que podem originar ligação (os conectados primeiro). */
export async function numerosParaLigar(db: Queryable, organizationId: string): Promise<NumeroParaDiscar[]> {
  const { rows } = await db.query<{ id: string; nome: string | null; numero: string | null; status: string }>(
    `select id, display_name as nome, phone_number as numero, status
       from channel_sessions
      where organization_id = $1 and provider = $2 and archived_at is null
      order by (status = 'WORKING') desc, created_at asc`,
    [organizationId, PROVIDER],
  );
  return rows.map((r) => ({ id: r.id, nome: r.nome, numero: r.numero, conectado: r.status === "WORKING" }));
}

export type FalhaDoPedido =
  | { motivo: "numero"; recusa: MotivoDeRecusa }
  | { motivo: "sem_numero_da_empresa" }
  | { motivo: "numero_da_empresa_desconectado" }
  | { motivo: "contato_sem_telefone" }
  | { motivo: "limite_simultaneo" }
  | { motivo: "ja_em_ligacao" };

export interface PedidoDeSaida {
  organizationId: string;
  userId: string;
  /** Um dos dois: o contato (usa o telefone do cadastro) ou um número digitado. */
  contactId?: string | null;
  numero?: string | null;
  /** Número da empresa escolhido; sem ele, o da conversa de telefone do contato ou o primeiro conectado. */
  troncoId?: string | null;
}

export async function criarPedidoDeSaida(
  db: Queryable,
  p: PedidoDeSaida,
): Promise<{ ok: true; id: string; contactId: string; troncoId: string } | ({ ok: false } & FalhaDoPedido)> {
  let bruto = p.numero ?? null;
  if (!bruto && p.contactId) {
    const { rows } = await db.query<{ phone_number: string | null }>(
      "select phone_number from contacts where id = $1 and organization_id = $2",
      [p.contactId, p.organizationId],
    );
    bruto = rows[0]?.phone_number ?? null;
    if (!bruto) return { ok: false, motivo: "contato_sem_telefone" };
  }
  const numero = numeroParaLigar(bruto);
  if (!numero.ok) return { ok: false, motivo: "numero", recusa: numero.motivo };

  const troncos = await numerosParaLigar(db, p.organizationId);
  if (troncos.length === 0) return { ok: false, motivo: "sem_numero_da_empresa" };
  const escolhido = p.troncoId ? troncos.find((t) => t.id === p.troncoId) : troncos.find((t) => t.conectado);
  if (!escolhido) return { ok: false, motivo: p.troncoId ? "sem_numero_da_empresa" : "numero_da_empresa_desconectado" };
  if (!escolhido.conectado) return { ok: false, motivo: "numero_da_empresa_desconectado" };

  // Pedido que o navegador nunca discou (aba fechada, rede caiu) não pode
  // prender o atendente: passado o prazo em que o controlador ainda o aceitaria,
  // ele é encerrado como expirado antes da contagem.
  await db.query(
    `update voice_calls
        set status = 'ended', ended_at = now(), end_reason = 'pedido_expirado', updated_at = now()
      where organization_id = $1 and provider = $2 and direction = 'outbound'
        and status = 'starting' and started_at < now() - interval '60 seconds'`,
    [p.organizationId, PROVIDER],
  );

  const { rows: vivas } = await db.query<{ total: string; minhas: string }>(
    `select count(*) filter (where direction = 'outbound') as total,
            count(*) filter (where owner_user_id = $3 or ringing_user_id = $3 or peer_user_id = $3) as minhas
       from voice_calls
      where organization_id = $1 and provider = $2 and status <> 'ended'
        and started_at > now() - interval '4 hours'`,
    [p.organizationId, PROVIDER, p.userId],
  );
  if (Number(vivas[0]?.minhas ?? 0) > 0) return { ok: false, motivo: "ja_em_ligacao" };
  if (Number(vivas[0]?.total ?? 0) >= SAIDAS_SIMULTANEAS_MAX) return { ok: false, motivo: "limite_simultaneo" };

  // O contato: o informado, ou o dono do número digitado (criado se não existe)
  // — toda ligação tem conversa, e a conversa precisa de contato.
  const contactId = p.contactId ?? (await acharOuCriarContato(db, p.organizationId, numero.e164, null));
  const conversationId = await acharOuCriarConversa(db, p.organizationId, contactId, escolhido.id, null);
  // Quem liga fica com a conversa — o mesmo gesto de "assumir". Sem isto a
  // conversa de uma ligação FEITA nascia na fila como "aguardando", com cara de
  // cliente esperando atendimento (medido na prova pela tela).
  await atribuirConversa(db, p.organizationId, conversationId, p.userId);

  const { rows } = await db.query<{ id: string }>(
    `insert into voice_calls
       (organization_id, channel_session_id, contact_id, provider, sip_call_ref, direction,
        peer_phone, status, conversation_id, owner_user_id, created_by)
     values ($1, $2, $3, $4, $5, 'outbound', $6, 'starting', $7, $8, $8)
     returning id`,
    [p.organizationId, escolhido.id, contactId, PROVIDER, `pedido-${randomUUID()}`, numero.e164, conversationId, p.userId],
  );
  return { ok: true, id: rows[0]!.id, contactId, troncoId: escolhido.id };
}

export const MENSAGEM_DO_PEDIDO: Record<Exclude<FalhaDoPedido["motivo"], "numero">, string> = {
  sem_numero_da_empresa: "Nenhum número de telefone conectado. Conecte um em Conexões › Telefone.",
  numero_da_empresa_desconectado: "O número de telefone da empresa não está conectado agora.",
  contato_sem_telefone: "Este contato não tem telefone cadastrado.",
  limite_simultaneo: "Muitas ligações de saída ao mesmo tempo. Aguarde uma terminar.",
  ja_em_ligacao: "Você já está em uma ligação.",
};
