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
 *
 * E a senha que o admin escolhe não atravessa para outra organização DEPOIS:
 * a conta sai daqui com a marca de `lib/auth/senha-do-admin.ts`, e o aceite de
 * convite de outra org a recusa até a pessoa trocar a própria senha.
 *
 * ─── Toda leitura com erro FECHA a porta ───────────────────────────────────
 *
 * As guardas acima são consultas. Se uma delas falha (timeout num banco
 * apertado não é hipotético — ver a lentidão medida em produção em
 * 2026-09-21), `data` volta nulo, e "nulo" lido como "nenhum vínculo em outra
 * org" abriria exatamente a porta que a guarda existe para fechar. Então
 * erro de leitura é `falha`, nunca "passou".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  INTERFACE_COMPLETA,
  interfaceSettingsSchema,
  type InterfaceSettings,
} from "@/lib/navigation/interface";
import { marcaDeSenhaDoAdmin } from "@/lib/auth/senha-do-admin";
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

function senhaIgual(erro: ErroDoProvedor): boolean {
  return erro.code === "same_password";
}

function emailInvalido(erro: ErroDoProvedor): boolean {
  return erro.code === "email_address_invalid" || /email address.*invalid/i.test(erro.message ?? "");
}

export type ResultadoCadastro =
  | { ok: true; userId: string; membershipId: string }
  | {
      ok: false;
      motivo:
        | "ja_membro"
        | "conta_existente"
        | "entrega_por_convite"
        | "senha_recusada"
        | "email_invalido"
        | "falha";
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
  // sai do provedor por id — o mesmo padrão da rota de convite. Em paralelo:
  // em sequência, uma equipe grande num banco apertado passava do tempo de
  // espera do browser, que desistia sem mostrar a senha de um cadastro feito.
  const { data: ativos, error: erroAtivos } = await admin
    .from("user_organizations")
    .select("user_id, provisional_until_handover")
    .eq("organization_id", params.organizationId)
    .is("revoked_at", null);
  if (erroAtivos) return { ok: false, motivo: "falha", detalhe: erroAtivos.message };

  // O CRIADOR PROVISÓRIO não escolhe a senha do dono. Quem abriu a org para
  // outra pessoa sai dela quando um admin entra (migration 0237); se tivesse
  // escolhido a senha desse admin, sairia sabendo como entrar como ele — a
  // entrega seria de fachada. Admin, neste caso, entra por convite: aí só ele
  // escolhe a própria senha.
  const quemCadastra = (ativos ?? []).find((v) => v.user_id === params.actorId);
  if (params.role === "admin" && quemCadastra?.provisional_until_handover)
    return { ok: false, motivo: "entrega_por_convite" };

  const contas = await Promise.all(
    (ativos ?? []).map((v) => admin.auth.admin.getUserById(v.user_id as string)),
  );
  if (contas.some((c) => c.data?.user?.email?.trim().toLowerCase() === email))
    return { ok: false, motivo: "ja_membro" };

  const { data: criado, error: erroAoCriar } = await admin.auth.admin.createUser({
    email,
    password: params.password,
    // Quem administra está atestando o e-mail; não há caixa de entrada a
    // confirmar numa instalação sem envio de e-mail.
    email_confirm: true,
    user_metadata: { full_name: params.fullName.trim() },
    app_metadata: marcaDeSenhaDoAdmin(params.organizationId),
  });
  if (erroAoCriar || !criado?.user) {
    const erro = (erroAoCriar ?? {}) as ErroDoProvedor;
    if (contaJaExiste(erro)) return { ok: false, motivo: "conta_existente" };
    if (emailInvalido(erro)) return { ok: false, motivo: "email_invalido", detalhe: erro.message };
    if (senhaRecusada(erro)) return { ok: false, motivo: "senha_recusada", detalhe: erro.message };
    return { ok: false, motivo: "falha", detalhe: erro.message ?? "createUser sem usuário" };
  }
  const userId = criado.user.id;

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
    // do mesmo e-mail cairia para sempre em "conta existente". Se a própria
    // compensação falhar, o detalhe diz — é a conta órfã que alguém vai caçar.
    const { error: erroAoApagar } = await admin.auth.admin.deleteUser(userId);
    const detalhe = erroNoVinculo?.message ?? "vínculo sem retorno";
    return {
      ok: false,
      motivo: "falha",
      detalhe: erroAoApagar
        ? `${detalhe}; e a conta ${userId} ficou órfã: ${erroAoApagar.message}`
        : detalhe,
    };
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

  return { ok: true, userId, membershipId: String((vinculo as { id: string }).id) };
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
        | "senha_igual"
        | "falha";
      detalhe?: string;
    };

export async function definirSenhaDoMembro(
  admin: SupabaseClient,
  params: { organizationId: string; actorId: string; targetUserId: string; password: string },
): Promise<ResultadoSenha> {
  // A própria senha não se troca por aqui: a API de admin pula a sessão forte e
  // o segundo fator de quem troca — uma sessão roubada trancaria o dono fora.
  // Comparação em forma canônica: o banco converte texto em uuid sem ligar para
  // caixa, e o provedor aceita maiúsculas. Comparar o texto cru deixava o
  // próprio id em maiúsculas passar.
  const alvo = params.targetUserId.toLowerCase();
  if (alvo === params.actorId.toLowerCase()) return { ok: false, motivo: "si_mesmo" };

  const { data: vinculo, error: erroVinculo } = await admin
    .from("user_organizations")
    .select("id, user_id, revoked_at")
    .eq("organization_id", params.organizationId)
    .eq("user_id", alvo)
    .maybeSingle();
  if (erroVinculo) return { ok: false, motivo: "falha", detalhe: erroVinculo.message };
  if (!vinculo) return { ok: false, motivo: "nao_membro" };
  if (vinculo.revoked_at) return { ok: false, motivo: "revogado" };
  // Daqui em diante, o id que vale é o que o BANCO devolveu.
  const userId = String(vinculo.user_id);
  if (userId === params.actorId.toLowerCase()) return { ok: false, motivo: "si_mesmo" };

  // Filtra no código, não com `neq`, de propósito: a pergunta é "existe algum
  // vínculo ativo que NÃO seja desta org", e ela precisa ver todos.
  const { data: vinculosAtivos, error: erroOutros } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (erroOutros) return { ok: false, motivo: "falha", detalhe: erroOutros.message };
  if ((vinculosAtivos ?? []).some((v) => v.organization_id !== params.organizationId))
    return { ok: false, motivo: "outra_organizacao" };

  const { data: plataforma, error: erroPlataforma } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (erroPlataforma) return { ok: false, motivo: "falha", detalhe: erroPlataforma.message };
  if (plataforma) return { ok: false, motivo: "admin_de_plataforma" };

  const { error } = await admin.auth.admin.updateUserById(userId, {
    password: params.password,
    // A marca volta: esta senha, de novo, quem conhece é o admin daqui.
    app_metadata: marcaDeSenhaDoAdmin(params.organizationId),
  });
  if (error) {
    const erro = error as ErroDoProvedor;
    if (senhaIgual(erro)) return { ok: false, motivo: "senha_igual" };
    if (senhaRecusada(erro)) return { ok: false, motivo: "senha_recusada", detalhe: erro.message };
    return { ok: false, motivo: "falha", detalhe: erro.message };
  }
  return { ok: true, membershipId: String(vinculo.id) };
}
