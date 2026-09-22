/**
 * O QUE O CLASSIFICADOR LÊ DO BANCO — atrás de uma interface, para o worker
 * ser testado sem Postgres e para a leitura real ter UM lugar.
 *
 * Service role: TODA consulta filtra `organization_id` explicitamente, com o
 * valor vindo da linha do `event_log` (fonte confiável), nunca do payload de
 * fora (CLAUDE.md, anti-pattern 10).
 *
 * Erro de banco LANÇA de propósito: o handler devolve `error` e o drain do
 * `event_log` tenta de novo com backoff. Decidir "sem card" em cima de uma
 * leitura que falhou chamaria o Jev à toa ou, pior, pularia a decisão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerNascimentoDoCard } from "@/lib/leads/modo-de-nascimento";
import type { NascimentoDoCard } from "@/lib/schemas/settings";

import type { MensagemParaEstado } from "./perguntas";

export interface MensagemDisparadora {
  type: string;
  media_derived_status: string | null;
}

export interface DadosDoClassificador {
  regra(organizationId: string): Promise<NascimentoDoCard>;
  temCardAberto(organizationId: string, contactId: string): Promise<boolean>;
  contatoBloqueado(organizationId: string, contactId: string): Promise<boolean>;
  mensagem(organizationId: string, messageId: string): Promise<MensagemDisparadora | null>;
  /** Do mais velho para o mais novo, já sem o que não é fala. */
  ultimasMensagens(organizationId: string, conversationId: string, limite: number): Promise<MensagemParaEstado[]>;
}

const TIPOS_QUE_NAO_SAO_FALA = new Set(["system", "reaction"]);

/** Formato cru da linha de `messages` que interessa aqui — antes de saber se `direction` é confiável. */
interface LinhaDeMensagem {
  direction: string;
  type: string;
  body: string | null;
  media_derived_text: string | null;
  revoked_at: string | null;
}

/**
 * O CHECK do banco (`messages_direction_check`) só permite `inbound` ou
 * `outbound` — mas a leitura não confia cegamente nisso, porque um cast
 * cego mentiria o tipo se o banco um dia discordasse. Uma linha com
 * `direction` fora das duas opções conhecidas é descartada, não forçada a
 * caber no tipo `MensagemParaEstado`.
 */
function comDirecaoConhecida(
  m: LinhaDeMensagem,
): m is LinhaDeMensagem & { direction: "inbound" | "outbound" } {
  return m.direction === "inbound" || m.direction === "outbound";
}

/** Não é uma fala: mensagem de sistema, reação, ou apagada (`revoked_at` preenchido). */
function ehFala(m: LinhaDeMensagem): boolean {
  return !TIPOS_QUE_NAO_SAO_FALA.has(m.type) && m.revoked_at === null;
}

export function dadosViaSupabase(db: SupabaseClient): DadosDoClassificador {
  return {
    regra: (organizationId) => lerNascimentoDoCard(db, organizationId),

    async temCardAberto(organizationId, contactId) {
      // Mesma régua de `garantirLeadDaConversa` (passo 2): um card aberto do
      // contato, em QUALQUER funil, encerra a decisão.
      const { data, error } = await db
        .from("crm_leads")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data !== null;
    },

    async contatoBloqueado(organizationId, contactId) {
      const { data, error } = await db
        .from("contacts")
        .select("is_blocked")
        .eq("organization_id", organizationId)
        .eq("id", contactId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { is_blocked?: boolean } | null)?.is_blocked === true;
    },

    async mensagem(organizationId, messageId) {
      const { data, error } = await db
        .from("messages")
        .select("type, media_derived_status")
        .eq("organization_id", organizationId)
        .eq("id", messageId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as MensagemDisparadora | null) ?? null;
    },

    async ultimasMensagens(organizationId, conversationId, limite) {
      // Filtro de tipo e de apagada em CÓDIGO: a consulta usa só eq/order/limit,
      // e por isso o `limite` pedido é o dobro do que o Jev lê (quem chama
      // passa LIMITE_DE_MENSAGENS * 2) — sobra para o que for descartado.
      const { data, error } = await db
        .from("messages")
        .select("direction, type, body, media_derived_text, revoked_at")
        .eq("organization_id", organizationId)
        .eq("conversation_id", conversationId)
        .order("sent_at", { ascending: false })
        .limit(limite);
      if (error) throw new Error(error.message);
      const linhas = (data ?? []) as LinhaDeMensagem[];
      return linhas
        .filter(ehFala)
        .filter(comDirecaoConhecida)
        .reverse()
        .map((m) => ({
          direcao: m.direction,
          texto: [m.body, m.media_derived_text].filter((t): t is string => !!t && t.trim() !== "").join(" — ") || null,
        }));
    },
  };
}
