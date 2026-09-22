import type { SupabaseClient } from "@supabase/supabase-js";

import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import type { FonteDeAmbiente } from "@/lib/instalacao/ambiente";
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
 * Desempate pela MAIS RECENTE (`order(created_at, {ascending:false}).limit(1)`)
 * — escolha consciente, igual à de `credencialDaOrganizacao`
 * (lib/ai/gateway-binding.ts): cadastrar uma segunda chave OpenRouter troca,
 * sozinho, a conta que o Jev passa a debitar. `credencialOpenAiDaOrganizacao`
 * (lib/ai/embeddings/chave.ts) escolhe a MAIS ANTIGA, por outro motivo —
 * desempate determinístico sem tela de escolha para aquele ponto; os dois
 * módulos discordam de propósito, não por descuido, e isto só registra o
 * porquê, não muda o de lá.
 *
 * Nunca lança. Plaintext só existe no retorno. O log leva só a CLASSE do erro
 * (falha de transporte/decifragem, pega no `catch`) ou o CÓDIGO Postgres (erro
 * ESTRUTURADO do PostgREST — o postgrest-js instalado não lança em erro
 * HTTP/rede, devolve `{ data: null, error }`) — nunca a mensagem: os dois
 * campos podem carregar material da credencial ou do schema.
 */
export async function chaveDaOpenRouter(
  admin: SupabaseClient,
  organizationId: string,
  env: FonteDeAmbiente = process.env,
): Promise<{ apiKey: string; origem: OrigemDaChave } | null> {
  try {
    const { data, error } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", "openrouter")
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      // Sem este ramo, um erro ESTRUTURADO (baseline sem a tabela — `PGRST205`
      // — ou qualquer outro código) virava "organização sem credencial" em
      // silêncio, indistinguível do caso normal em que ela nunca cadastrou
      // nada. `error.code` é o dado estável pra operar; `error.message` fica
      // de fora do log de propósito.
      logger.warn(
        "classificador-comercial: não consegui ler a credencial da OpenRouter da organização; tentando a da instalação",
        { organization_id: organizationId, codigo: error.code },
      );
    } else if (data) {
      // Mesmo aprendizado da chave da instalação (abaixo): a rota que salva
      // já apara a chave antes de cifrar, mas o resolvedor não deve DEPENDER
      // disso — uma credencial cifrada antes desse apara existir, ou colada
      // com `\r\n`/espaço, não pode travar o Jev pra sempre em "chave
      // malformada".
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
    // Falha de TRANSPORTE (ou de decifragem) — diferente do `error`
    // estruturado acima, isto é uma exceção de verdade. Mesma régua: nunca a
    // mensagem, só a classe.
    logger.warn("classificador-comercial: credencial da OpenRouter da organização ilegível; tentando a da instalação", {
      organization_id: organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
  }
  const daInstalacao = env.OPENROUTER_API_KEY?.trim();
  return daInstalacao ? { origem: "instalacao", apiKey: daInstalacao } : null;
}
