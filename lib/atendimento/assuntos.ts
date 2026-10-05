/**
 * O CADASTRO DE ASSUNTOS POR TIME (migration 0293) — o que as rotas de
 * `settings/teams/[id]/assuntos` compartilham.
 *
 * A escrita é só por RPC `security definer` (`fn_save_atendimento_assunto`,
 * `fn_archive_atendimento_assunto`): a tabela tem GRANT apenas de SELECT. As
 * recusas dessas funções são RECUSAS COM SIGNIFICADO, e cada uma vira uma frase
 * que diz a quem administra o que consertar.
 */
import { z } from "zod";

import { NOME_DO_ASSUNTO_MAXIMO } from "@/lib/atendimento/encerramento";

const nomeDoAssunto = z.string().trim().min(1).max(NOME_DO_ASSUNTO_MAXIMO);

/** POST — cria. Estrito: `organization_id` ou `team_id` no corpo é 422, não silêncio. */
export const criarAssuntoSchema = z.strictObject({ name: nomeDoAssunto });

/** PATCH — renomeia e/ou arquiva. Ao menos um dos dois. */
export const alterarAssuntoSchema = z
  .strictObject({ name: nomeDoAssunto.optional(), archived: z.boolean().optional() })
  .refine((d) => d.name !== undefined || d.archived !== undefined, {
    message: "Informe o nome ou o arquivamento.",
  });

/** O assunto como a tela de configuração o lê (com os arquivados). */
export interface AssuntoCadastrado {
  id: string;
  team_id: string;
  name: string;
  archived: boolean;
}

export type CodigoDaRecusa = "forbidden" | "mfa_required" | "validation_failed" | "not_found" | "conflict";

export interface RecusaDoCadastro {
  status: number;
  code: CodigoDaRecusa;
}

/** Mensagem da exceção do banco → resposta da API. */
export const RECUSAS_DO_BANCO: Readonly<Record<string, RecusaDoCadastro | undefined>> = Object.freeze({
  assunto_forbidden: { status: 403, code: "forbidden" },
  assunto_mfa_required: { status: 403, code: "mfa_required" },
  assunto_invalid_name: { status: 422, code: "validation_failed" },
  assunto_team_not_found: { status: 404, code: "not_found" },
  assunto_not_found: { status: 404, code: "not_found" },
  assunto_duplicado: { status: 409, code: "conflict" },
});

export const MENSAGEM_DA_TELA: Readonly<Record<CodigoDaRecusa, string>> = Object.freeze({
  forbidden: "Esta sessão não pode alterar os assuntos.",
  mfa_required: "Confirme a verificação em duas etapas.",
  validation_failed: "Use um nome de 1 a 60 letras.",
  not_found: "Assunto ou time não encontrado.",
  conflict: "Esse time já tem um assunto com esse nome.",
});

/**
 * Erro do supabase-js → recusa conhecida, ou `null` (erro de sistema).
 *
 * O 23505 chega por DOIS caminhos: o `raise` da função (nome que já existe
 * ativo) e o índice único (renomear para um nome que já existe) — o segundo
 * traz a mensagem do Postgres, não a nossa, e por isso o código decide antes.
 */
export function recusaDoCadastro(erro: { code?: string | null; message?: string | null }): RecusaDoCadastro | null {
  if (erro.code === "23505") return { status: 409, code: "conflict" };
  const mensagem = (erro.message ?? "").trim();
  return Object.prototype.hasOwnProperty.call(RECUSAS_DO_BANCO, mensagem) ? (RECUSAS_DO_BANCO[mensagem] ?? null) : null;
}
