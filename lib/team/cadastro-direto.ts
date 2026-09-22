/**
 * A porta de entrada na equipe que NÃO depende de e-mail.
 *
 * Até 2026-09-22 a única forma de alguém entrar numa organização era o convite:
 * token HMAC, linha em `team_invites` e um e-mail. Numa instalação sem e-mail
 * configurado — toda VPS recém-instalada, já que a chave do provedor de e-mail
 * é opcional — o convite virava um link copiado de uma tela marcada "(DEV)" e
 * mandado por fora, e a pessoa ainda criava conta e esperava uma confirmação
 * que também não chegava. O pedido do dono do produto foi direto: "eu já
 * cadastrasse a senha dele aqui dentro e já ficasse tudo resolvido".
 *
 * Duas operações, as duas sobre o client service-role (criar e alterar conta no
 * provedor de auth só existe por ele), com `organization_id` SEMPRE vindo de
 * quem chama — resolvido da sessão, nunca do body:
 *
 * - `cadastrarMembroComSenha` — conta confirmada + vínculo. O vínculo nasce pela
 *   MESMA função do aceite de convite (`fn_accept_team_invite`): reativação de
 *   revogado, áreas permitidas e a entrega do criador provisório (migration
 *   0237) seguem valendo sem uma segunda cópia da regra.
 * - `definirSenhaDoMembro` — o laço de retorno. Sem e-mail, "esqueci a senha"
 *   não funciona; sem esta operação, quem esquece fica preso para sempre, e nem
 *   recadastrar resolve, porque a conta já existe.
 *
 * ─── A linha que não se cruza: senha de conta que não é só daqui ───────────
 *
 * Numa instalação com várias organizações (revenda), a mesma conta pode
 * responder a mais de uma. Um admin desta org que trocasse a senha dela
 * entraria no lugar da pessoa — e, com ela, nas outras organizações. Por isso:
 * o cadastro NUNCA mexe em conta que já existe, e a senha nova só se define
 * para quem não tem vínculo ativo em nenhuma outra organização nem é admin de
 * plataforma. Numa instalação de uma organização só, isso nunca bloqueia.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  INTERFACE_COMPLETA,
  interfaceSettingsSchema,
  type InterfaceSettings,
} from "@/lib/navigation/interface";
import type { Role } from "@/lib/schemas/team";

interface ErroDoProvedor {
  code?: string;
  status?: number;
  message?: string;
}

/**
 * O provedor de auth diz "já existe" de mais de um jeito conforme a versão:
 * `email_exists` nas atuais, `user_already_exists` em algumas, e só a frase nas
 * antigas. As três contam.
 */
function contaJaExiste(erro: ErroDoProvedor): boolean {
  return (
    erro.code === "email_exists" ||
    erro.code === "user_already_exists" ||
    /already (been )?registered|already exists/i.test(erro.message ?? "")
  );
}

/** Recusa da POLÍTICA de senha do provedor — que pode ser mais rígida que a nossa. */
function senhaRecusada(erro: ErroDoProvedor): boolean {
  return erro.code === "weak_password" || (erro.status === 422 && /password/i.test(erro.message ?? ""));
}

export type ResultadoCadastro =
  | {
      ok: true;
      userId: string;
      membershipId: string;
      /** true = quem cadastrou era o criador provisório e saiu na entrega. */
      entregue: boolean;
    }
  | {
      ok: false;
      motivo: "ja_membro" | "conta_existente" | "senha_recusada" | "falha";
      detalhe?: string;
    };

export async function cadastrarMembroComSenha(
  admin: SupabaseClient,
  params: {
    organizationId: string;
    actorId: string;
    fullName: string;
    email: string;
    password: string;
    role: Role;
    interfaceSettings?: InterfaceSettings;
  },
): Promise<ResultadoCadastro> {
  const email = params.email.trim().toLowerCase();
  const interfaceSettings = interfaceSettingsSchema.parse(
    params.interfaceSettings ?? INTERFACE_COMPLETA,
  );

  // Membro ATIVO já é membro: responder isso é mais útil que "conta existente".
  // O schema `auth` não é alcançável pela REST, então o e-mail de cada vínculo
  // sai do provedor por id — o mesmo padrão da rota de convite. N é pequeno.
  const { data: ativos } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", params.organizationId)
    .is("revoked_at", null);
  for (const vinculo of ativos ?? []) {
    const { data } = await admin.auth.admin.getUserById(vinculo.user_id as string);
    if (data?.user?.email?.trim().toLowerCase() === email) return { ok: false, motivo: "ja_membro" };
  }

  const { data: criado, error: erroAoCriar } = await admin.auth.admin.createUser({
    email,
    password: params.password,
    // Quem administra está atestando o e-mail; não há caixa de entrada a
    // confirmar numa instalação sem envio de e-mail.
    email_confirm: true,
    user_metadata: { full_name: params.fullName.trim() },
  });
  if (erroAoCriar || !criado?.user) {
    const erro = (erroAoCriar ?? {}) as ErroDoProvedor;
    if (contaJaExiste(erro)) return { ok: false, motivo: "conta_existente" };
    if (senhaRecusada(erro)) return { ok: false, motivo: "senha_recusada", detalhe: erro.message };
    return { ok: false, motivo: "falha", detalhe: erro.message ?? "createUser sem usuário" };
  }
  const userId = criado.user.id;

  // Mede a entrega em vez de prevê-la: quem tinha vínculo antes e não tem
  // depois saiu. Prever pelo `provisional_until_handover` erraria o suporte em
  // acesso total, que age como admin SEM ter vínculo nenhum.
  const tinhaVinculo = await temVinculoAtivo(admin, params.organizationId, params.actorId);

  const agora = new Date().toISOString();
  const { data: vinculo, error: erroNoVinculo } = await admin.rpc("fn_accept_team_invite", {
    p_user: userId,
    p_org: params.organizationId,
    p_role: params.role,
    p_invited_by: params.actorId,
    p_issued_at: agora,
    p_invited_at: agora,
    p_interface_settings: interfaceSettings,
  });
  if (erroNoVinculo || !vinculo) {
    // Compensação: sem ela sobraria uma conta sem organização, e o recadastro
    // do mesmo e-mail cairia para sempre em "conta existente".
    await admin.auth.admin.deleteUser(userId);
    return { ok: false, motivo: "falha", detalhe: erroNoVinculo?.message ?? "vínculo sem retorno" };
  }

  // Convite pendente do mesmo e-mail ficaria "Pendente" na aba Membros para
  // quem já está dentro — e alguém o reenviaria ou revogaria à toa.
  await admin
    .from("team_invites")
    .update({ accepted_at: agora, accepted_by: userId })
    .eq("organization_id", params.organizationId)
    .eq("email", email)
    .is("accepted_at", null)
    .is("revoked_at", null);

  const entregue =
    tinhaVinculo && !(await temVinculoAtivo(admin, params.organizationId, params.actorId));

  return { ok: true, userId, membershipId: String((vinculo as { id: string }).id), entregue };
}

async function temVinculoAtivo(
  admin: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("user_organizations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  return Boolean(data);
}

export type ResultadoSenha =
  | { ok: true; membershipId: string }
  | {
      ok: false;
      motivo:
        | "si_mesmo"
        | "nao_membro"
        | "revogado"
        | "outra_organizacao"
        | "admin_de_plataforma"
        | "senha_recusada"
        | "falha";
      detalhe?: string;
    };

export async function definirSenhaDoMembro(
  admin: SupabaseClient,
  params: { organizationId: string; actorId: string; targetUserId: string; password: string },
): Promise<ResultadoSenha> {
  // A própria senha não se troca por aqui: a API de admin pula a sessão forte e
  // o segundo fator de quem troca — uma sessão roubada trancaria o dono fora.
  if (params.targetUserId === params.actorId) return { ok: false, motivo: "si_mesmo" };

  const { data: vinculo } = await admin
    .from("user_organizations")
    .select("id, revoked_at")
    .eq("organization_id", params.organizationId)
    .eq("user_id", params.targetUserId)
    .maybeSingle();
  if (!vinculo) return { ok: false, motivo: "nao_membro" };
  if (vinculo.revoked_at) return { ok: false, motivo: "revogado" };

  // Filtra no código, não com `neq`, de propósito: a pergunta é "existe algum
  // vínculo ativo que NÃO seja desta org", e ela precisa ver todos.
  const { data: vinculosAtivos } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", params.targetUserId)
    .is("revoked_at", null);
  if ((vinculosAtivos ?? []).some((v) => v.organization_id !== params.organizationId))
    return { ok: false, motivo: "outra_organizacao" };

  const { data: plataforma } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", params.targetUserId)
    .is("revoked_at", null)
    .maybeSingle();
  if (plataforma) return { ok: false, motivo: "admin_de_plataforma" };

  const { error } = await admin.auth.admin.updateUserById(params.targetUserId, {
    password: params.password,
  });
  if (error) {
    const erro = error as ErroDoProvedor;
    if (senhaRecusada(erro)) return { ok: false, motivo: "senha_recusada", detalhe: erro.message };
    return { ok: false, motivo: "falha", detalhe: erro.message };
  }
  return { ok: true, membershipId: String(vinculo.id) };
}
