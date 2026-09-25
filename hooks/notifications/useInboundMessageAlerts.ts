"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";

import {
  DURACAO_DO_TOAST_DE_MENSAGEM_MS,
  mostrarToastDeMensagem,
} from "@/components/notifications/ToastDeMensagem";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { getOpenConversationId } from "@/hooks/notifications/OpenConversationContext";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import {
  criarCacheComValidade,
  linhaDeContexto,
  nomeDoRemetente,
  previaDaMensagem,
  rotuloDaRajada,
  tituloParaBandeja,
  VALIDADE_DO_CONTEXTO_MS,
  type ContextoDaConversa,
} from "@/lib/notifications/aviso-de-mensagem";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";
import { entregarAviso } from "@/lib/notifications/deliver";
import {
  escolhaDaSessaoAtual,
  escopoEfetivo,
  mensagemMereceAviso,
} from "@/lib/notifications/escopo-de-aviso";
import { shouldNotifyInbound } from "@/lib/notifications/policy";
import { syncPushSubscription } from "@/lib/notifications/push_client";

function tabFocused(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** postgres_changes entrega `{ new }`; alguns mocks aninham em `payload`. */
function rowFromRealtime(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    tipo?: unknown;
    new?: unknown;
    record?: unknown;
    payload?: { new?: unknown };
  };
  if (p.tipo === "reassinado") return null;
  const raw = p.new ?? p.record ?? p.payload?.new;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

interface ContextoComFoto extends ContextoDaConversa {
  foto: string | null;
}

// Por aba, em memória. Guarda a PROMESSA, não o resultado: "oi" e "tudo bem?"
// com 50 ms de diferença esperam a mesma chamada, em vez de fazerem duas. E
// guarda a falha (`null`) pelo mesmo prazo — com o banco lento, repetir a
// chamada a cada mensagem, em cada aba aberta, é piorar a lentidão.
const contextoPorConversa = criarCacheComValidade<Promise<ContextoComFoto | null>>(
  VALIDADE_DO_CONTEXTO_MS,
);
const rajadaPorConversa = new Map<string, { contagem: number; ultima: number }>();
/** Igual à vida do cartão: contar mensagem de um cartão que já sumiu confunde. */
const JANELA_DA_RAJADA_MS = DURACAO_DO_TOAST_DE_MENSAGEM_MS;

/**
 * Tudo que o aviso precisa, numa chamada: o contato, o time, quem está no
 * comando e a foto já assinada.
 *
 * Pela ROTA, e não pelo supabase-js do navegador: o cookie de sessão é
 * httpOnly, e a consulta direta saía anônima — a RLS devolvia vazio, o título
 * caía para "Nova mensagem" e, com "só as minhas", o aviso nem aparecia. O
 * porquê inteiro está no cabeçalho de `app/api/v1/conversations/[id]/aviso`.
 */
function contextoDaConversa(conversationId: string): Promise<ContextoComFoto | null> {
  const guardado = contextoPorConversa.ler(conversationId);
  if (guardado) return guardado;
  const pedido = buscarContexto(conversationId);
  contextoPorConversa.gravar(conversationId, pedido);
  return pedido;
}

async function buscarContexto(conversationId: string): Promise<ContextoComFoto | null> {
  try {
    const r = await fetch(`/api/v1/conversations/${conversationId}/aviso`, { credentials: "include" });
    if (!r.ok) return null;
    const corpo = (await r.json()) as {
      data?: {
        contato?: ContextoDaConversa["contato"];
        time?: string | null;
        comando?: ContextoDaConversa["comando"];
        foto?: string | null;
      };
    };
    const d = corpo?.data;
    if (!d) return null;
    return {
      contato: d.contato ?? null,
      time: d.time ?? null,
      comando: d.comando ?? null,
      foto: d.foto ?? null,
    };
  } catch {
    return null;
  }
}

function contarRajada(conversationId: string, agora = Date.now()): number {
  const r = rajadaPorConversa.get(conversationId);
  if (!r && rajadaPorConversa.size >= 200) rajadaPorConversa.clear();
  const contagem = r && agora - r.ultima < JANELA_DA_RAJADA_MS ? r.contagem + 1 : 1;
  rajadaPorConversa.set(conversationId, { contagem, ultima: agora });
  return contagem;
}

export function useInboundMessageAlerts(): void {
  const activeOrg = useActiveOrg();
  const orgId = activeOrg?.orgId ?? null;
  const userId = useUser().id;
  const router = useRouter();
  const abrir = useCallback((href: string) => router.push(href), [router]);
  // O que a RLS deixa chegar aqui é tudo que a pessoa ENXERGA; o escopo decide
  // de quais delas ela quer ser avisada (0281 — atendente: só as suas).
  const escopo = activeOrg
    ? (activeOrg.aviso_de_mensagem ?? escopoEfetivo(activeOrg.role, null))
    : "mine";

  useEffect(() => {
    if (!orgId) return;
    void syncPushSubscription();
  }, [orgId]);

  const onChange = useCallback((payload: unknown) => {
    const row = rowFromRealtime(payload);
    if (!row) return;
    const conversationId = typeof row.conversation_id === "string" ? row.conversation_id : null;
    const direction = typeof row.direction === "string" ? row.direction : null;
    if (
      !shouldNotifyInbound({
        direction,
        conversationId,
        openConversationId: getOpenConversationId(),
        tabFocused: tabFocused(),
        tipo: (payload as { tipo?: unknown }).tipo,
      })
    ) {
      return;
    }
    void (async () => {
      const escopoAgora = escolhaDaSessaoAtual() ?? escopo;
      const ctx = await contextoDaConversa(conversationId as string);
      if (!ctx) return;
      const assignedTo = ctx.comando?.quem === "humano" ? ctx.comando.userId : null;
      if (!mensagemMereceAviso(escopoAgora, { assignedTo, userId })) return;
      const icon = ctx.foto ?? undefined;
      const idioma = idiomaAtual();
      const t = (texto: string) => traduzir(texto, idioma);
      const nome = nomeDoRemetente(ctx.contato, t);
      const previa = previaDaMensagem(row.type, row.body, t);
      const contexto = linhaDeContexto(ctx, userId, t);
      const rajada = rotuloDaRajada(contarRajada(conversationId as string), t);
      const href = `/app/inbox?id=${conversationId}`;
      entregarAviso({
        category: "message",
        kind: "message_inbound",
        title: tituloParaBandeja(nome, ctx.time),
        body: previa,
        tag: conversationId ?? undefined,
        href,
        icon,
        mostrarNaTela: () =>
          mostrarToastDeMensagem({
            id: `msg:${conversationId}`,
            nome,
            contexto,
            previa,
            rajada,
            foto: icon,
            aoAbrir: () => abrir(href),
          }),
      });
    })();
  }, [escopo, userId, abrir]);

  useRealtimeChannel({
    name: orgId ? `alerts-messages-${orgId}` : "alerts-messages-disabled",
    postgresChanges: orgId
      ? {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange,
    enabled: !!orgId,
  });
}
