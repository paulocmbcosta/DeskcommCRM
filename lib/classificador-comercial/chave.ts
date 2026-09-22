import type { SupabaseClient } from "@supabase/supabase-js";

import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";

export type OrigemDaChave = "organizacao" | "instalacao";

/**
 * A chave da OpenRouter que paga o Jev: a da organização (IA › Provedores),
 * senão a da instalação (`OPENROUTER_API_KEY`).
 *
 * Independe do provedor PADRÃO da organização: quem conversa pode ser Anthropic,
 * e o Jev só existe na OpenRouter. É por isso que isto não reusa
 * `credencialDaOrganizacao` (lib/ai/gateway-binding.ts), que filtra pelo
 * provedor de `settings.llm`.
 *
 * Nunca lança. Plaintext só existe no retorno. O log leva só a CLASSE do erro:
 * a mensagem pode carregar material da credencial.
 */
export async function chaveDaOpenRouter(
  admin: SupabaseClient,
  organizationId: string,
  // `Record<string, string | undefined>`, não `{ OPENROUTER_API_KEY?: string }`:
  // é o mesmo tipo que `lib/instalacao/ambiente.ts` (`FonteDeAmbiente`) e
  // `lib/channels/meta/webhook.ts` usam para o default `= process.env` — sem
  // ele, `NodeJS.ProcessEnv` (que TEM índice, mas é "weak type" na visão do
  // TS) não bate por assinatura com um tipo de propriedade nomeada, e o build
  // reprova com TS2559 antes de qualquer teste rodar.
  env: Record<string, string | undefined> = process.env,
): Promise<{ apiKey: string; origem: OrigemDaChave } | null> {
  try {
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", "openrouter")
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      // Mesmo aprendizado da chave da instalação (abaixo): a rota que salva
      // já apara, mas o resolvedor não deve DEPENDER disso — um `.env` CRLF
      // fonte da migração original da credencial, ou um valor colado com
      // espaço, não pode travar o Jev pra sempre em "chave malformada".
      const decifrada = decryptKey({
        ciphertext: byteaToBuffer(data.api_key_encrypted),
        iv: byteaToBuffer(data.api_key_iv),
        tag: byteaToBuffer(data.api_key_tag),
      }).trim();
      if (decifrada) return { origem: "organizacao", apiKey: decifrada };
      // Decifrou para vazio: trata como ausente e cai para a da instalação,
      // não como resultado válido de uma credencial cadastrada.
    }
  } catch (erro) {
    logger.warn("classificador-comercial: credencial da OpenRouter da organização ilegível; tentando a da instalação", {
      organization_id: organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
  }
  const daInstalacao = env.OPENROUTER_API_KEY?.trim();
  return daInstalacao ? { origem: "instalacao", apiKey: daInstalacao } : null;
}
