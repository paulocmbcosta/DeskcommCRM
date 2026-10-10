/**
 * GET /api/v1/telefonia/chamadas/[id]/transcricao — LER a transcrição de uma
 * ligação gravada: devolve a conversa em falas (quem falou, quando, o texto) e
 * o resumo, e deixa uma linha na auditoria (`phone.transcript_read`). F4 da spec
 * 20; desenho docs/superpowers/specs/2026-10-09-telefonia-transcricao-das-ligacoes-design.md.
 *
 * A transcrição é a gravação por escrito, e por isso a regra é a da ESCUTA
 * (`../gravacao/route.ts`):
 *
 * Quem lê: papel atendente ou acima (`viewer` não) E quem ENXERGA a conversa. A
 * segunda parte é da RLS, não daqui: a mensagem da ligação é lida pelo cliente
 * de SESSÃO, e a visibilidade por time (0281) decide se ela volta. Não voltou →
 * 404, sem dizer se a ligação existe. A ligação (lida também pela sessão) tem de
 * morar na MESMA conversa da mensagem.
 *
 * Só DEPOIS disso a transcrição é lida, pelo cliente de serviço — a tabela
 * `voice_call_transcripts` não tem grant para o membro — e presa à organização
 * da sessão. O id vem do caminho e só vira consulta se for uuid.
 *
 * Contato ANONIMIZADO → 404, mesmo que a linha da transcrição ainda exista. A
 * anonimização a apaga, mas a leitura não depende disso: confere o fato
 * (`contacts.is_anonymized`), como a listagem (`ligacoesDeContatoLiberado`).
 *
 * Só a transcrição PRONTA audita: é a única resposta que entrega o conteúdo. As
 * outras situações (transcrevendo, sem fala, falhou) respondem o que o cartão já
 * sabe, sem texto.
 *
 * Quem falou cada fala é ESTIMATIVA (`estimativa: true`): a gravação mistura as
 * duas vozes num canal, e a indicação vem de um modelo que leu o conteúdo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { ligacoesDeContatoLiberado } from "@/lib/inbox/transcricao-da-ligacao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  ESTADOS_DA_TRANSCRICAO,
  SITUACAO_DO_ESTADO,
  falasDaTranscricao,
  trechosDaTranscricao,
  type EstadoDaTranscricao,
} from "@/lib/telefonia/transcricao";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "telefonia_transcricao_leitura" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const naoHa = () => fail("not_found", t("Transcrição não encontrada."), 404, { requestId });
  const falhou = () => fail("internal_error", t("Erro ao buscar a transcrição."), 500, { requestId });

  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return naoHa();
  const vcId = id.data;
  const org = authz.org.orgId;

  const supabase = await createClient();
  const { data: msg, error } = await supabase
    .from("messages")
    .select("id, conversation_id")
    .eq("organization_id", org)
    .eq("external_id", `ligacao:${vcId}`)
    .maybeSingle();
  if (error) return falhou();
  if (!msg || !msg.conversation_id) return naoHa();

  const { data: ligacao, error: erroDaLigacao } = await supabase
    .from("voice_calls")
    .select("id, conversation_id")
    .eq("organization_id", org)
    .eq("id", vcId)
    .maybeSingle();
  if (erroDaLigacao) return falhou();
  if (!ligacao || ligacao.conversation_id !== msg.conversation_id) return naoHa();

  // O contato foi anonimizado? Então não há transcrição a entregar — nem a
  // situação. Na dúvida (a consulta falhou), não entrega.
  try {
    if (!(await ligacoesDeContatoLiberado(org, [vcId])).has(vcId)) return naoHa();
  } catch (e) {
    logger.warn("telefonia: não consegui conferir a anonimização antes de ler a transcrição", {
      voice_call: vcId,
      erro: e instanceof Error ? e.message : String(e),
    });
    return falhou();
  }

  const { data: linha, error: erroDaTranscricao } = await createAdminClient()
    .from("voice_call_transcripts")
    .select("status, segments, summary, audio_duration_ms")
    .eq("organization_id", org)
    .eq("voice_call_id", vcId)
    .maybeSingle();
  if (erroDaTranscricao) {
    logger.warn("telefonia: transcrição não lida", { voice_call: vcId, erro: erroDaTranscricao.message });
    return falhou();
  }
  const estado = linha?.status as EstadoDaTranscricao | undefined;
  if (!linha || !estado || !(ESTADOS_DA_TRANSCRICAO as readonly string[]).includes(estado)) return naoHa();

  const situacao = SITUACAO_DO_ESTADO[estado];
  if (situacao !== "pronta") {
    return ok({ situacao, resumo: null, falas: [], duracao_ms: null, estimativa: true }, { requestId });
  }

  void audit({
    action: "phone.transcript_read",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "voice_call",
    resourceId: vcId,
    metadata: { conversation_id: msg.conversation_id },
    requestId,
  });
  const duracao = linha.audio_duration_ms;
  return ok(
    {
      situacao,
      resumo: typeof linha.summary === "string" && linha.summary.trim() ? linha.summary.trim() : null,
      falas: falasDaTranscricao(trechosDaTranscricao(linha.segments)),
      duracao_ms: typeof duracao === "number" && duracao > 0 ? duracao : null,
      estimativa: true,
    },
    { requestId },
  );
}
