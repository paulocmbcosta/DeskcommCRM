/**
 * A MARCA de "esta senha foi escolhida por quem administra a organização X".
 *
 * Desde 2026-09-22 um admin pode cadastrar um membro já com senha, ou definir
 * uma senha nova para ele (`lib/team/cadastro-direto.ts`). Quem escolheu a
 * senha a conhece — e isso é aceitável DENTRO da organização dele, que ele já
 * administra. Não é aceitável fora: se a mesma conta entrasse depois em OUTRA
 * organização da instalação (uma revenda tem várias), o admin da primeira
 * entraria na segunda como aquela pessoa.
 *
 * A marca mora em `app_metadata`, e não em `user_metadata`, porque só a chave
 * de serviço escreve ali: a pessoa não consegue apagá-la por conta própria
 * pelo cliente do browser. Ela é:
 *
 * - **gravada** pelo cadastro direto e pelo "Definir nova senha";
 * - **lida** por `aplicarConvite`, que recusa o convite de outra organização
 *   enquanto ela existir (os dois caminhos de aceite passam por lá);
 * - **apagada** quando a própria pessoa troca a senha — em Configurações ›
 *   Perfil ou pela recuperação por e-mail. A partir daí só ela sabe a senha.
 */
export const MARCA_SENHA_DO_ADMIN = "senha_definida_por_admin" as const;

/** O `app_metadata` a gravar junto com a senha que o admin escolheu. */
export function marcaDeSenhaDoAdmin(organizationId: string) {
  return {
    [MARCA_SENHA_DO_ADMIN]: { organization_id: organizationId, em: new Date().toISOString() },
  };
}

/** O `app_metadata` que apaga a marca (o provedor de auth remove a chave nula). */
export const SEM_MARCA_DE_SENHA_DO_ADMIN = { [MARCA_SENHA_DO_ADMIN]: null };

/** A organização cujo admin conhece a senha desta conta, ou `null`. */
export function orgQueConheceASenha(appMetadata: unknown): string | null {
  if (!appMetadata || typeof appMetadata !== "object") return null;
  const marca = (appMetadata as Record<string, unknown>)[MARCA_SENHA_DO_ADMIN];
  if (!marca || typeof marca !== "object") return null;
  const org = (marca as Record<string, unknown>).organization_id;
  return typeof org === "string" && org.length > 0 ? org : null;
}
