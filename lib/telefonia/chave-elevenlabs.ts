/**
 * A CHAVE DA ELEVENLABS DA ORGANIZAÇÃO (desenho da fase 2, D4 e §7).
 *
 * Uma por organização, em `ai_provider_credentials` com `provider = 'elevenlabs'`
 * e rótulo fixo — o UNIQUE `(organization_id, provider, label)` é o que faz
 * "trocar a chave" substituir em vez de somar. Leitura e escrita filtram pelo
 * MESMO trio, para apontarem sempre à mesma linha: por esse UNIQUE, há no
 * máximo uma. Cifrada com AI_CRED_AES_KEY como toda chave de IA; a tela só vê
 * os 4 últimos dígitos.
 *
 * NÃO entra em `PROVEDORES` (lib/ai/pontos/provedores.ts): aquela lista é de
 * quem executa modelo de linguagem e casa com o registry do motor. A ElevenLabs
 * só dá voz ao telefone; quem a usa é este módulo.
 *
 * Server-only. O banco entra como `Queryable` (a rota passa o pool do request),
 * que ignora a RLS: por isso TODA consulta aqui filtra `organization_id`, e quem
 * chama passa o da sessão — nunca um valor vindo do corpo do pedido.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { PROVEDOR_DE_VOZ } from "@/lib/ai/pontos/provedores";
import { byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";

// O texto do provider mora no vocabulário de provedores (é de lá que as listas
// de modelo sabem excluí-lo); aqui ele só é reexportado.
export { PROVEDOR_DE_VOZ };
export const ROTULO_DA_CHAVE_DE_VOZ = "ElevenLabs";

export interface EstadoDaChaveDeVoz {
  cadastrada: boolean;
  last4: string | null;
  validada_em: string | null;
}

export async function estadoDaChaveDeVoz(db: Queryable, organizationId: string): Promise<EstadoDaChaveDeVoz> {
  const { rows } = await db.query<{ last4: string; validada_em: Date | string | null }>(
    `select api_key_last4 as last4, validated_at as validada_em
       from ai_provider_credentials
      where organization_id = $1 and provider = $2 and label = $3 and is_active = true
      limit 1`,
    [organizationId, PROVEDOR_DE_VOZ, ROTULO_DA_CHAVE_DE_VOZ],
  );
  const r = rows[0];
  if (!r) return { cadastrada: false, last4: null, validada_em: null };
  return { cadastrada: true, last4: r.last4, validada_em: r.validada_em ? new Date(r.validada_em).toISOString() : null };
}

/** Grava (ou substitui) a chave JÁ VALIDADA pela rota. O texto puro vive só nesta chamada. */
export async function guardarChaveDeVoz(
  db: Queryable,
  p: { organizationId: string; userId: string; chave: string },
): Promise<{ id: string; last4: string; substituiu: boolean }> {
  const cifra = encryptKey(p.chave);
  const { rows } = await db.query<{ id: string; substituiu: boolean }>(
    `insert into ai_provider_credentials
       (organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4,
        is_active, created_by, validated_at, validation_error)
     values ($1, $2, $3, $4, $5, $6, $7, true, $8, now(), null)
     on conflict (organization_id, provider, label) do update
       set api_key_encrypted = excluded.api_key_encrypted,
           api_key_iv = excluded.api_key_iv,
           api_key_tag = excluded.api_key_tag,
           api_key_last4 = excluded.api_key_last4,
           is_active = true, validated_at = now(), validation_error = null, updated_at = now()
     returning id, (xmax::text <> '0') as substituiu`,
    [
      p.organizationId,
      PROVEDOR_DE_VOZ,
      ROTULO_DA_CHAVE_DE_VOZ,
      cifra.ciphertext,
      cifra.iv,
      cifra.tag,
      cifra.last4,
      p.userId,
    ],
  );
  return { id: rows[0]!.id, last4: cifra.last4, substituiu: Boolean(rows[0]!.substituiu) };
}

/**
 * A chave em claro, para chamar a ElevenLabs agora. Nunca lança: falha de leitura
 * ou de decifragem vira `null` (a tela diz "cadastre a chave"), e o log leva só a
 * classe do erro — nunca a mensagem, que pode carregar material da credencial.
 */
export async function chaveDeVoz(db: Queryable, organizationId: string): Promise<string | null> {
  try {
    const { rows } = await db.query<{ c: unknown; iv: unknown; tag: unknown }>(
      `select api_key_encrypted as c, api_key_iv as iv, api_key_tag as tag
         from ai_provider_credentials
        where organization_id = $1 and provider = $2 and label = $3 and is_active = true
        limit 1`,
      [organizationId, PROVEDOR_DE_VOZ, ROTULO_DA_CHAVE_DE_VOZ],
    );
    const r = rows[0];
    if (!r) return null;
    const chave = decryptKey({ ciphertext: byteaToBuffer(r.c), iv: byteaToBuffer(r.iv), tag: byteaToBuffer(r.tag) }).trim();
    return chave || null;
  } catch (e) {
    logger.warn("[telefonia] chave da ElevenLabs ilegível", {
      organization_id: organizationId,
      classe: e instanceof Error ? e.name : "desconhecida",
    });
    return null;
  }
}
