"use server";
/**
 * Trocar a PRÓPRIA senha, logado — Configurações › Perfil › Trocar senha.
 *
 * Até 2026-09-22 não existia: a única troca era a recuperação por e-mail, e
 * numa instalação sem e-mail ela não chega a lugar nenhum. Passou a ser
 * necessária quando o admin ganhou o cadastro de membro JÁ COM SENHA: quem
 * escolheu a senha a conhece, e a pessoa precisa conseguir tomar posse dela.
 * Trocar aqui apaga a marca "senha definida por admin"
 * (`lib/auth/senha-do-admin.ts`), que é o que libera aceitar convite de outra
 * organização.
 *
 * A SENHA ATUAL É EXIGIDA, e verificada de verdade: uma sessão esquecida aberta
 * não pode trocar a senha de ninguém com um clique. A verificação usa um
 * cliente avulso, sem cookie e sem persistência, e desfaz a sessão que ela
 * mesma abriu (`signOut` LOCAL — o global derrubaria a sessão de quem está
 * trocando).
 */
import { headers } from "next/headers";
import { createClient as criarClienteAvulso } from "@supabase/supabase-js";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { apagarMarcaDaSenhaDoAdmin } from "@/lib/auth/apagar-marca-da-senha";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { env } from "@/lib/env";
import { senhaDefinidaPeloAdminSchema } from "@/lib/schemas/team";
import { createClient } from "@/lib/supabase/server";

const trocarMinhaSenhaSchema = z
  .object({
    senha_atual: z.string().min(1).max(200),
    // A mesma régua de tamanho da senha que o admin define (8 a 72).
    nova: senhaDefinidaPeloAdminSchema,
    confirmacao: z.string(),
  })
  .refine((v) => v.nova === v.confirmacao, { path: ["confirmacao"], message: "nao_confere" })
  .refine((v) => v.nova !== v.senha_atual, { path: ["nova"], message: "igual_a_atual" });

export type TrocarMinhaSenhaInput = z.input<typeof trocarMinhaSenhaSchema>;

export type TrocarMinhaSenhaResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_error"
        | "nao_confere"
        | "igual_a_atual"
        | "unauthenticated"
        | "rate_limited"
        | "senha_atual_incorreta"
        | "mfa_required"
        | "senha_recusada"
        | "update_failed";
    };

export async function trocarMinhaSenha(input: TrocarMinhaSenhaInput): Promise<TrocarMinhaSenhaResult> {
  const parsed = trocarMinhaSenhaSchema.safeParse(input);
  if (!parsed.success) {
    const motivo = parsed.error.issues.map((i) => i.message);
    if (motivo.includes("nao_confere")) return { ok: false, error: "nao_confere" };
    if (motivo.includes("igual_a_atual")) return { ok: false, error: "igual_a_atual" };
    return { ok: false, error: "validation_error" };
  }
  const { senha_atual, nova } = parsed.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { ok: false, error: "unauthenticated" };

  // O mesmo teto do login: testar a senha atual aqui é, na prática, uma
  // tentativa de login — e sem teto viraria um lugar para adivinhá-la.
  if (await authRateLimited("password_change", user.id, AUTH_LIMITS.login)) {
    return { ok: false, error: "rate_limited" };
  }

  const avulso = criarClienteAvulso(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: prova, error: erroDaProva } = await avulso.auth.signInWithPassword({
    email: user.email,
    password: senha_atual,
  });
  if (erroDaProva || !prova?.session) return { ok: false, error: "senha_atual_incorreta" };
  await avulso.auth.signOut({ scope: "local" });

  // Conta com segundo fator: o provedor exige a sessão com o código para trocar
  // a senha. Na tela, isso já é regra (quem tem fator prova na sessão); aqui
  // fica a resposta clara caso não seja.
  const { data: nivel } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (nivel?.currentLevel === "aal1" && nivel?.nextLevel === "aal2") {
    return { ok: false, error: "mfa_required" };
  }

  const { error } = await supabase.auth.updateUser({ password: nova });
  if (error) {
    const erro = error as { code?: string; message?: string };
    if (erro.code === "weak_password" || /password/i.test(erro.message ?? ""))
      return { ok: false, error: "senha_recusada" };
    return { ok: false, error: "update_failed" };
  }

  const marcaApagada = await apagarMarcaDaSenhaDoAdmin(user);

  // Sem organização, como a recuperação de senha (`updatePassword.ts`): a
  // senha é da PESSOA, não de nenhuma das organizações a que ela pertence.
  const hdrs = await headers();
  await audit({
    action: "profile.password_changed",
    actorUserId: user.id,
    resourceType: "user",
    resourceId: user.id,
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent") ?? null,
    metadata: { marca_do_admin_apagada: marcaApagada },
  });

  return { ok: true };
}
