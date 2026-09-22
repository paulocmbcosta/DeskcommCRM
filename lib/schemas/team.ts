/**
 * EPIC-09 Team & Permissions — Zod schemas for invite, accept, role change, and api token.
 *
 * Roles are stored as `text` with a check constraint (not enum) on
 * `user_organizations.role` per project doctrine — keep this list in sync
 * with the DB constraint when adding/removing roles.
 */
import { z } from "zod";
import { interfaceSettingsSchema, interfaceTemDestino } from "@/lib/navigation/interface";

export const ROLES = ["viewer", "agent", "manager", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const inviteMemberSchema = z.object({
  invitations: z
    .array(
      z
        .object({
          email: z.string().email(),
          role: z.enum(ROLES),
          interface_settings: interfaceSettingsSchema.optional(),
        })
        .refine((v) => !v.interface_settings || interfaceTemDestino(v.interface_settings, v.role), {
          message: "Selecione ao menos uma área permitida ao papel.",
          path: ["interface_settings"],
        }),
    )
    .min(1)
    .max(20),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/**
 * A senha que QUEM ADMINISTRA define para outra pessoa — no cadastro direto e
 * no "Definir nova senha" — e a que a pessoa escolhe ao trocar a própria.
 * Mínimo 8, a mesma régua do login e do cadastro (`lib/auth/schemas.ts`);
 * máximo 72 **bytes**, não caracteres, porque é onde o bcrypt do provedor de
 * auth corta: um "ç" ocupa dois. Acima disso, a senha que a pessoa digita e a
 * que vale divergiriam em silêncio.
 */
export const senhaDefinidaPeloAdminSchema = z
  .string()
  .min(8, "A senha precisa de pelo menos 8 caracteres.")
  .refine((s) => new TextEncoder().encode(s).length <= 72, "A senha é longa demais.");

/**
 * Cadastro DIRETO: a pessoa entra na equipe com a senha que o administrador
 * escolheu, sem convite nem e-mail. Um por vez — cada pessoa tem a sua senha.
 * `organization_id` não existe aqui de propósito: a organização vem do cookie.
 */
export const cadastrarMembroSchema = z
  .object({
    full_name: z.string().trim().min(2, "Informe o nome da pessoa.").max(120),
    email: z.string().trim().toLowerCase().email("E-mail inválido."),
    password: senhaDefinidaPeloAdminSchema,
    role: z.enum(ROLES),
    interface_settings: interfaceSettingsSchema.optional(),
  })
  .refine((v) => !v.interface_settings || interfaceTemDestino(v.interface_settings, v.role), {
    message: "Selecione ao menos uma área permitida ao papel.",
    path: ["interface_settings"],
  });
export type CadastrarMembroInput = z.infer<typeof cadastrarMembroSchema>;

export const definirSenhaSchema = z.object({ password: senhaDefinidaPeloAdminSchema });
export type DefinirSenhaInput = z.infer<typeof definirSenhaSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const changeRoleSchema = z.object({
  role: z.enum(ROLES),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const createApiTokenSchema = z.object({
  name: z.string().min(2).max(100),
  scopes: z.array(z.string()).min(1),
  expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
});
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
