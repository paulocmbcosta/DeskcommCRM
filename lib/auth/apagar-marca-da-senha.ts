import { isServiceRoleConfigured } from "@/lib/audit";
import { orgQueConheceASenha, SEM_MARCA_DE_SENHA_DO_ADMIN } from "@/lib/auth/senha-do-admin";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A pessoa trocou a PRÓPRIA senha: a marca "senha definida por admin" cai
 * (ver `lib/auth/senha-do-admin.ts`). Chamado pelos dois lugares onde a pessoa
 * escolhe a senha sozinha — Configurações › Perfil e a recuperação por e-mail.
 *
 * Não lança. A senha já foi trocada quando isto roda; se apagar a marca falhar,
 * o pior efeito é continuar recusando convite de outra organização — o lado
 * seguro. O erro vai para o log para alguém poder ver.
 */
export async function apagarMarcaDaSenhaDoAdmin(user: {
  id: string;
  app_metadata?: unknown;
}): Promise<boolean> {
  if (!orgQueConheceASenha(user.app_metadata)) return false;
  if (!isServiceRoleConfigured()) return false;
  try {
    const { error } = await createAdminClient().auth.admin.updateUserById(user.id, {
      app_metadata: SEM_MARCA_DE_SENHA_DO_ADMIN,
    });
    if (error) throw error;
    return true;
  } catch (err) {
    logger.error("auth: não foi possível apagar a marca de senha definida por admin", {
      user_id: user.id,
      erro: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
