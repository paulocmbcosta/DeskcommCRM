/**
 * DE QUAIS CONVERSAS CHEGA AVISO DE MENSAGEM — a escolha de cada pessoa.
 *
 * `user_organizations.message_alert_scope` (migration 0281):
 *   - `mine`         só as conversas atribuídas a mim;
 *   - `all_visible`  toda conversa que eu enxergo (a RLS decide qual);
 *   - nulo           o padrão do papel — `mine` para atendente, `all_visible`
 *                    para os demais (o comportamento de antes para gestor).
 *
 * A MESMA regra mora em SQL, em `fn_destinatarios_do_aviso_de_mensagem`, que é
 * quem decide o push do servidor. Esta cópia serve ao aviso que o navegador
 * dispara com a aba aberta (`useInboundMessageAlerts`), que já recebe só o que
 * a RLS deixa ver. As duas são medidas com as mesmas frases em
 * `escopo-de-aviso.test.ts` e em `tests/invariants/visibilidade-por-time.test.ts`.
 */
import type { Role } from "@/lib/auth/types";

export const ESCOPOS_DE_AVISO = ["mine", "all_visible"] as const;
export type EscopoDeAviso = (typeof ESCOPOS_DE_AVISO)[number];

/**
 * A escolha feita NESTA aba depois que o layout carregou. A tela de
 * Notificações grava aqui ao salvar, e o aviso do navegador lê daqui primeiro —
 * sem isso a escolha só valeria no próximo carregamento da página.
 */
let escolhaDaSessao: EscopoDeAviso | null = null;
export function lembrarEscolhaDaSessao(escopo: EscopoDeAviso): void {
  escolhaDaSessao = escopo;
}
export function escolhaDaSessaoAtual(): EscopoDeAviso | null {
  return escolhaDaSessao;
}

export function escopoEfetivo(role: Role, gravado: string | null | undefined): EscopoDeAviso {
  if (gravado === "mine" || gravado === "all_visible") return gravado;
  return role === "agent" ? "mine" : "all_visible";
}

export function mensagemMereceAviso(
  escopo: EscopoDeAviso,
  conversa: { assignedTo: string | null | undefined; userId: string },
): boolean {
  if (escopo === "all_visible") return true;
  return !!conversa.assignedTo && conversa.assignedTo === conversa.userId;
}
