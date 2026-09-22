/**
 * Seed E2E do card pelo classificador (`tests/e2e/card-pelo-classificador.spec.ts`).
 *
 * Duas ações, e as duas deixam a organização de e2e num estado CONHECIDO:
 *
 *  - (padrão) `semear`: garante uma credencial `openrouter` FALSA, cifrada como o
 *    produto cifra, ativa e validada, na organização de e2e — e devolve a regra
 *    "quando o card nasce" para `toda_conversa`, que é o ponto de partida da spec
 *    (ela liga "Só conversas comerciais" PELA TELA, e o botão de salvar só
 *    habilita quando há mudança).
 *  - `restaurar`: devolve a regra para `toda_conversa` e desativa a credencial
 *    falsa. A organização é COMPARTILHADA pelas specs da mesma parte do CI (o
 *    Playwright roda com 1 worker, então esta spec roda sozinha), e as que vêm
 *    depois — `conversa-vira-lead` à frente — esperam o modo de sempre.
 *
 * ═══ POR QUE UMA CREDENCIAL DA ORGANIZAÇÃO, E NÃO `OPENROUTER_API_KEY` ═══
 *
 * `chaveDaOpenRouter` (lib/classificador-comercial/chave.ts) aceita as duas. A da
 * instalação entraria no `.env.e2e` — e o `.env.e2e` é o ambiente de TODAS as
 * specs: uma chave OpenRouter ali mudaria o roteamento de IA das outras. A da
 * organização fica restrita a esta, e é também o caminho que o operador usa
 * (IA › Credenciais).
 *
 * ═══ POR QUE `bufToBytea(encryptKey(...))` ═══
 *
 * É exatamente o que `guardarCredencial` (lib/ai/credenciais/guardar.ts) grava —
 * o miolo de `POST /api/v1/ai/credentials` e do wizard. O resolvedor lê com
 * `byteaToBuffer` + `decryptKey`; se o seed gravasse outro formato, o teste
 * mediria um defeito de fixture, não do produto. A cifra usa `AI_CRED_AES_KEY` do
 * AMBIENTE (o `.env.e2e`, publicado no processo do Playwright), a mesma que o
 * `next start` sob teste usa para decifrar.
 *
 * ═══ POR QUE REGRAVAR A CIFRA E O `created_at` A CADA RODADA ═══
 *
 * `chaveDaOpenRouter` escolhe a credencial ativa e validada MAIS RECENTE. Uma
 * outra `openrouter` validada deixada por outra spec, mais nova que a nossa,
 * seria a escolhida — e a action recusaria ligar a regra (`sem_chave_openrouter`)
 * ou o worker mandaria a chave errada ao Jev falso. E regenerar o `.env.e2e` com
 * outra `AI_CRED_AES_KEY` tornaria a cifra antiga ilegível. Recifrar e carimbar
 * `created_at = agora` torna a nossa a vigente, sempre.
 *
 * Idempotente. Depende de `.e2e-creds.json` (rode `scripts/seed-e2e-credentials.ts`
 * antes).
 *
 * Run: npx tsx scripts/seed-e2e-classificador-comercial.ts [restaurar]
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

import { anunciarDestino, carregarEnvLocal, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

/**
 * O MESMO literal que a spec confere no `Authorization` que chega ao Jev falso.
 * Duplicado lá de propósito: importar este arquivo executaria o seed.
 */
const CHAVE_FALSA_DA_OPENROUTER = "sk-or-e2e-falsa-0000";
const ROTULO_DA_CREDENCIAL = "e2e-classificador";

const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-classificador-comercial", credenciais);
const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

function orgDoE2E(): string {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(".e2e-creds.json ausente — rode scripts/seed-e2e-credentials.ts primeiro");
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as { org_id?: string };
  if (!creds.org_id) throw new Error(".e2e-creds.json sem org_id — rode scripts/seed-e2e-credentials.ts");
  return creds.org_id;
}

/**
 * Regra de volta ao padrão, MESCLANDO: `settings` é jsonb compartilhado (provedor
 * de IA, `crm.cliente_pela_agenda`), e regravá-lo inteiro apagaria o que outras
 * specs puseram lá.
 */
async function regraNoPadrao(orgId: string): Promise<void> {
  const { data, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .single();
  if (erroLeitura) throw new Error(`select organizations: ${erroLeitura.message}`);
  const settings = ((data as { settings?: unknown } | null)?.settings ?? {}) as Record<string, unknown>;
  const crm =
    settings.crm && typeof settings.crm === "object" && !Array.isArray(settings.crm)
      ? (settings.crm as Record<string, unknown>)
      : {};
  const { error } = await admin
    .from("organizations")
    .update({ settings: { ...settings, crm: { ...crm, nascimento_do_card: { modo: "toda_conversa", limiar: 0.7 } } } })
    .eq("id", orgId);
  if (error) throw new Error(`update organizations.settings: ${error.message}`);
}

async function garantirCredencial(orgId: string): Promise<void> {
  // Import DEPOIS de completar o ambiente: `lib/crypto/aes_gcm` importa `lib/env`,
  // que lê `AI_CRED_AES_KEY` de `process.env` NA CARGA do módulo. Rodado pelo
  // Playwright, o ambiente já vem do `.env.e2e`; rodado à mão, vem do `.env.local`.
  carregarEnvLocal();
  const { bufToBytea, encryptKey } = await import("@/lib/crypto/aes_gcm");
  const cifrada = encryptKey(CHAVE_FALSA_DA_OPENROUTER);
  const agora = new Date().toISOString();
  const campos = {
    api_key_encrypted: bufToBytea(cifrada.ciphertext),
    api_key_iv: bufToBytea(cifrada.iv),
    api_key_tag: bufToBytea(cifrada.tag),
    api_key_last4: cifrada.last4,
    validated_at: agora,
    validation_error: null,
    is_active: true,
    created_at: agora,
  };

  const { data: existente, error: erroBusca } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", orgId)
    .eq("provider", "openrouter")
    .eq("label", ROTULO_DA_CREDENCIAL)
    .maybeSingle();
  if (erroBusca) throw new Error(`select ai_provider_credentials: ${erroBusca.message}`);

  if (existente) {
    const { error } = await admin
      .from("ai_provider_credentials")
      .update(campos)
      .eq("id", (existente as { id: string }).id)
      .eq("organization_id", orgId);
    if (error) throw new Error(`update ai_provider_credentials: ${error.message}`);
    return;
  }

  const { error } = await admin.from("ai_provider_credentials").insert({
    organization_id: orgId,
    provider: "openrouter",
    label: ROTULO_DA_CREDENCIAL,
    ...campos,
  });
  if (error) throw new Error(`insert ai_provider_credentials: ${error.message}`);
}

async function desativarCredencial(orgId: string): Promise<void> {
  const { error } = await admin
    .from("ai_provider_credentials")
    .update({ is_active: false })
    .eq("organization_id", orgId)
    .eq("provider", "openrouter")
    .eq("label", ROTULO_DA_CREDENCIAL);
  if (error) throw new Error(`desativar ai_provider_credentials: ${error.message}`);
}

async function main(): Promise<void> {
  const orgId = orgDoE2E();
  if (process.argv[2] === "restaurar") {
    await regraNoPadrao(orgId);
    await desativarCredencial(orgId);
    console.info("seed-e2e-classificador-comercial: restaurado (regra toda_conversa, credencial falsa desativada)");
    return;
  }
  await garantirCredencial(orgId);
  await regraNoPadrao(orgId);
  console.info("seed-e2e-classificador-comercial: ok (credencial openrouter falsa ativa e validada, regra toda_conversa)");
}

main().catch((erro: unknown) => {
  console.error(`seed-e2e-classificador-comercial: FALHOU — ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exit(1);
});
