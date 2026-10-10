/**
 * A CHAVE QUE TRANSCREVE AS LIGAÇÕES (F4, migration 0298).
 *
 * A transcrição usa o serviço de transcrição da OpenAI, então a chave é a da
 * OpenAI — a que a organização cadastrou no painel de provedores ou, sem ela, a
 * da instalação (`OPENAI_API_KEY`). É a MESMA resolução do áudio do WhatsApp
 * (`workers/media-derive-worker.ts`): quem já transcreve áudio de cliente não
 * cadastra nada a mais.
 *
 * Dois consumidores, que não podem discordar sobre "há chave?":
 *  - o worker do telefone, antes de mandar a gravação ao provedor;
 *  - a rota da política, que recusa LIGAR a transcrição sem chave — melhor a
 *    tela dizer isso na hora do que toda ligação falhar depois.
 *
 * Server-only. O pool ignora a RLS: a organização é sempre a de quem chama (a
 * da sessão na rota, a da ligação no worker), nunca um valor do corpo do pedido.
 */
import type pg from "pg";

import {
  LlmNotConfiguredError,
  llmEdgeConfigFromEnv,
  resolveOrgLlmConfig,
  type LlmEdgeConfig,
} from "@/lib/agent-engine/edge/llm/credentials";

/**
 * A configuração de IA da instalação — as chaves que servem de piso a quem não
 * cadastrou a sua no painel, E a chave geral do teto de gasto
 * (`AI_BUDGET_ENFORCEMENT`). Pelo MESMO leitor do resto do worker: montada à
 * mão, a transcrição ignoraria a instalação que desligou (ou só avisa) o teto.
 */
export function configDeIaDoAmbiente(): LlmEdgeConfig {
  return llmEdgeConfigFromEnv({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    // Vazia é "não definida": o leitor só aceita '5m' ou '1h', e uma linha
    // `LLM_CACHE_TTL=` no `.env` faria a tela da política responder erro por causa
    // de um ajuste que a transcrição nem usa.
    LLM_CACHE_TTL: process.env.LLM_CACHE_TTL || undefined,
    AI_BUDGET_ENFORCEMENT: process.env.AI_BUDGET_ENFORCEMENT,
  });
}

/**
 * A chave da OpenAI desta organização para TRANSCREVER. `null` = não há chave
 * (nem da organização, nem da instalação). Qualquer outra falha — o banco fora,
 * a chave que não decifra — sobe: "não consegui saber" não é "não tem".
 */
export async function chaveDoTranscritor(pool: pg.Pool, organizationId: string): Promise<string | null> {
  try {
    const cfg = await resolveOrgLlmConfig(pool, configDeIaDoAmbiente(), organizationId, { provider: "openai" });
    return cfg.apiKey ? cfg.apiKey : null;
  } catch (e) {
    if (e instanceof LlmNotConfiguredError) return null;
    throw e;
  }
}
