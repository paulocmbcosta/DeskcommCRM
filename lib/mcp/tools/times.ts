/**
 * crm_list_teams — o catálogo de destinos humanos, lido em RUNTIME.
 *
 * É esta tool que mantém o prompt do agente PORTÁVEL: ele nunca nomeia um time
 * nem carrega um uuid. Pergunta quais existem, lê o "quando usar" que a empresa
 * escreveu na tela, e escolhe pelo assunto. Renomear um time não mexe em prompt.
 *
 * `organization_id` SEMPRE do ctx — service role bypassa RLS.
 */
import { z } from "zod";

import { loadEligibleAttendants } from "@/lib/routing/eligibles";
import { carregarTimes } from "@/lib/times/catalogo";

import type { McpToolDefinition } from "../types";

const inputShape = {
  /** true = só os que podem receber agora; false = todos, com o motivo visível. */
  only_open: z.boolean().default(false),
};

export const crmListTeams: McpToolDefinition<typeof inputShape> = {
  name: "crm_list_teams",
  description:
    "Times (setores) de atendimento da organização, com slug, nome, quando usar cada um, se está " +
    "aberto agora e quantas pessoas podem assumir. Use ANTES de transferir para humano: passe o " +
    "slug escolhido em crm_request_human_handoff. Time fechado ou sem ninguém elegível significa " +
    "que a conversa vai esperar na fila daquele time — avise o cliente do prazo real.",
  inputSchema: inputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const agora = new Date();
    const times = await carregarTimes(ctx.supabase, ctx.organizationId, agora);
    const linhas = await Promise.all(
      times.map(async (t) => ({
        slug: t.slug,
        name: t.name,
        when_to_use: t.description,
        open_now: t.aberto_agora,
        // Time fechado NÃO consulta elegíveis: além da economia, a pergunta não
        // tem resposta útil — ninguém "pode assumir" num setor fora do horário,
        // e um número >0 aqui viraria promessa de atendimento que não acontece.
        eligible_count: t.aberto_agora
          ? (
              await loadEligibleAttendants(ctx.supabase, ctx.organizationId, agora, {
                kind: "organization_summary",
                teamId: t.id,
              })
            ).length
          : 0,
      })),
    );
    const visiveis = input.only_open ? linhas.filter((l) => l.open_now) : linhas;
    const prontos = linhas.filter((l) => l.eligible_count > 0);
    return {
      teams: visiveis,
      // Os totais saem SEMPRE da lista inteira, nunca da filtrada: é o número que
      // decide se transferir agora faz sentido, e derivá-lo do array visível faria
      // o modelo concluir "não existe time" quando só não havia nenhum aberto.
      open_count: prontos.length,
      total_count: linhas.length,
      next_action:
        linhas.length === 0
          ? "Esta organização não tem times cadastrados. Use crm_request_human_handoff sem o parâmetro team."
          : prontos.length === 0
            ? "Nenhum time pode assumir agora. Transfira mesmo assim se o assunto exigir, mas avise o cliente do prazo real em vez de prometer atendimento imediato."
            : "Escolha o time pelo assunto e passe o slug dele em crm_request_human_handoff.",
    };
  },
};
