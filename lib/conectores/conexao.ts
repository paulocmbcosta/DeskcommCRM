/**
 * A CONEXÃO DA ORGANIZAÇÃO COM O SISTEMA EXTERNO — ler, salvar, remover.
 *
 * `conector_conexoes` é server-side only (migration 0271): `anon` e
 * `authenticated` não têm privilégio nenhum, então TUDO aqui roda com o admin
 * client — que ignora RLS. Por isso toda função recebe `orgId` e filtra por ele,
 * e o `orgId` vem SEMPRE de `requireRole()` (a sessão), nunca do corpo do pedido.
 *
 * O token entra em claro por uma porta só (`salvarConexao`), é cifrado
 * AES-256-GCM com a `AI_CRED_AES_KEY` da instalação e nunca volta: a tela recebe
 * `ConexaoPublica`, que não tem o campo.
 */
import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import type { createAdminClient } from "@/lib/supabase/admin";

import { ehConectorId, type ConectorId, type CredencialDeConector, type EstadoDaConexao } from "./tipos";

type Admin = ReturnType<typeof createAdminClient>;

const COLUNAS_PUBLICAS = "conector, base_url, token_last4, status, status_detalhe, verificada_em, updated_at";
const COLUNAS_DA_CREDENCIAL = "base_url, token_encrypted, token_iv, token_tag, status";

export interface ConexaoPublica {
  conector: ConectorId;
  base_url: string;
  token_last4: string;
  status: EstadoDaConexao;
  status_detalhe: string | null;
  verificada_em: string | null;
  updated_at: string;
}

export async function lerConexaoPublica(admin: Admin, orgId: string, conector: ConectorId): Promise<ConexaoPublica | null> {
  const { data, error } = await admin
    .from("conector_conexoes")
    .select(COLUNAS_PUBLICAS)
    .eq("organization_id", orgId)
    .eq("conector", conector)
    .maybeSingle();
  if (error) throw new Error(`conector_conexoes: ${error.message}`);
  return (data as ConexaoPublica | null) ?? null;
}

/** Os conectores que ESTA organização ligou. É o que decide se o painel da conversa ganha aba. */
export async function conectoresLigados(admin: Admin, orgId: string): Promise<ConectorId[]> {
  const { data, error } = await admin.from("conector_conexoes").select("conector").eq("organization_id", orgId);
  if (error) throw new Error(`conector_conexoes: ${error.message}`);
  return (data ?? []).map((l) => l.conector).filter(ehConectorId);
}

export interface CredencialGuardada extends CredencialDeConector {
  status: EstadoDaConexao;
}

export async function lerCredencial(admin: Admin, orgId: string, conector: ConectorId): Promise<CredencialGuardada | null> {
  const { data, error } = await admin
    .from("conector_conexoes")
    .select(COLUNAS_DA_CREDENCIAL)
    .eq("organization_id", orgId)
    .eq("conector", conector)
    .maybeSingle();
  if (error) throw new Error(`conector_conexoes: ${error.message}`);
  if (!data) return null;
  return {
    baseUrl: data.base_url,
    token: decryptKey({
      ciphertext: byteaToBuffer(data.token_encrypted),
      iv: byteaToBuffer(data.token_iv),
      tag: byteaToBuffer(data.token_tag),
    }),
    status: data.status as EstadoDaConexao,
  };
}

export interface PedidoDeSalvar {
  admin: Admin;
  orgId: string;
  userId: string;
  conector: ConectorId;
  baseUrl: string;
  /** Plaintext. Vive só no escopo desta chamada — nunca persistido em claro nem logado. */
  token: string;
}

export async function salvarConexao(p: PedidoDeSalvar): Promise<void> {
  const cifrado = encryptKey(p.token);
  const { error } = await p.admin.from("conector_conexoes").upsert(
    {
      organization_id: p.orgId,
      conector: p.conector,
      base_url: p.baseUrl,
      token_encrypted: bufToBytea(cifrado.ciphertext),
      token_iv: bufToBytea(cifrado.iv),
      token_tag: bufToBytea(cifrado.tag),
      token_last4: cifrado.last4,
      // Só se salva o que acabou de passar no teste (a rota testa antes).
      status: "ativa",
      status_detalhe: null,
      verificada_em: new Date().toISOString(),
      created_by: p.userId,
    },
    { onConflict: "organization_id,conector" },
  );
  if (error) throw new Error(`conector_conexoes: ${error.message}`);
}

export async function removerConexao(admin: Admin, orgId: string, conector: ConectorId): Promise<boolean> {
  const { data, error } = await admin
    .from("conector_conexoes")
    .delete()
    .eq("organization_id", orgId)
    .eq("conector", conector)
    .select("id");
  if (error) throw new Error(`conector_conexoes: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * O LAÇO DE RETORNO da peça (invariante 7): a leitura que falha por credencial
 * ou host grava `erro`, e a tela de Conectores passa a dizer o que houve; a que
 * volta a funcionar devolve a `ativa`. Nunca lança — é efeito colateral de uma
 * leitura, e derrubar o painel porque o carimbo não gravou seria inverter a
 * importância das duas coisas.
 */
export async function carimbarEstado(
  admin: Admin,
  orgId: string,
  conector: ConectorId,
  estado: EstadoDaConexao,
  detalhe: string | null,
): Promise<void> {
  try {
    await admin
      .from("conector_conexoes")
      .update({
        status: estado,
        status_detalhe: detalhe,
        ...(estado === "ativa" ? { verificada_em: new Date().toISOString() } : {}),
      })
      .eq("organization_id", orgId)
      .eq("conector", conector);
  } catch {
    // de propósito: ver o cabeçalho da função
  }
}
