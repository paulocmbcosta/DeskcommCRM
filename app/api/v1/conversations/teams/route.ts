/**
 * `GET /api/v1/conversations/teams` — os times que podem RECEBER conversa, para
 * quem está no inbox.
 *
 * ─── Por que uma rota nova, e não `/api/v1/settings/teams` ─────────────────
 *
 * Aquela é a tela de configuração: exige `manager`, exige MFA em dia e devolve
 * até os times arquivados, com a lista de quem pode ser alocado. Um `agent` —
 * que é exatamente quem transfere conversa — leva 403 nela.
 *
 * É a MESMA exceção que `/api/v1/team/assignable` já declara para o diálogo de
 * transferência para pessoa: "um agent precisa escolher o destino pra
 * transferir". Aqui o destino é o setor, e o mínimo exposto é o mínimo: nome,
 * apelido, para que serve, se está aberto agora e se foi arquivado. Sem
 * membros e sem a agenda crua.
 *
 * ─── Por que `viewer`, e não `agent` como em `assignable` ──────────────────
 *
 * Porque esta lista tem um segundo consumidor que `assignable` não tem: o SELO
 * do cabeçalho, que NOMEIA o time da conversa aberta. Sem a lista, o selo teria
 * um uuid e nenhum nome — e o caminho mais curto dali é imprimir "Sem time"
 * numa conversa que TEM time, que é mentira de tela. Quem só olha o inbox
 * precisa poder ler o nome do setor; escrever continua sendo agent+, e quem
 * cobra isso é a RPC.
 *
 * ─── E por que os ARQUIVADOS vêm junto ────────────────────────────────────
 *
 * Arquivar um time não limpa `conversations.team_id` (de propósito: o histórico
 * continua nomeando por onde a conversa passou). Se a lista os omitisse, essas
 * conversas ficariam com um time que a tela não sabe nomear. Eles vêm marcados,
 * e quem escolhe destino os filtra fora.
 *
 * ⚠️ O caminho fica ao lado de `[id]`, e um `GET /api/v1/conversations/teams`
 * nunca vira "a conversa de id `teams`": segmento estático ganha do dinâmico no
 * App Router, e id de conversa é uuid. Está aqui, e não num recurso de primeiro
 * nível, porque é a lista que O INBOX usa — o mesmo motivo de `assignable`
 * morar dentro de `team`.
 *
 * `aberto_agora` sai de `carregarTimes`, que é o carregador ÚNICO: a mesma
 * régua que o roteador usa para decidir entrega. Se esta tela dissesse "aberto"
 * com o roteador achando "fechado", ninguém teria como saber qual das duas
 * mente.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { carregarTimes } from "@/lib/times/catalogo";
import { timesParaIniciarConversa } from "@/lib/times/iniciar-conversa";

export const dynamic = "force-dynamic";

/** O que o inbox precisa saber de um time — e nada além disso. */
export interface TimeDoInbox {
  id: string;
  name: string;
  slug: string;
  description: string;
  aberto_agora: boolean;
  horario_invalido: boolean;
  /** Arquivado: continua nomeando o passado, não recebe conversa nova. */
  archived: boolean;
  /**
   * Quem pergunta pode abrir neste time a conversa que ELE inicia ("Chamar no
   * WhatsApp", migration 0284). Calculado aqui, pela mesma função que a rota
   * `iniciar` usa, para a tela não reescrever a regra.
   */
  pode_iniciar: boolean;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  try {
    // Client do USUÁRIO: a RLS de `attendance_teams` é de verdade aqui
    // (`tenant_isolation_attendance_teams_all`), e o GRANT das duas tabelas é só
    // de SELECT — não existe caminho de escrita por este client.
    const db = await createClient();
    const times = await carregarTimes(db, authz.org.orgId, new Date(), {
      incluirArquivados: true,
    });
    const iniciaveis = new Set(
      timesParaIniciarConversa(times, authz.user.id, authz.org.role).map((time) => time.id),
    );
    const enxuto: TimeDoInbox[] = times.map((time) => ({
      id: time.id,
      name: time.name,
      slug: time.slug,
      description: time.description,
      aberto_agora: time.aberto_agora,
      horario_invalido: time.horario_invalido,
      archived: time.archived_at !== null,
      pode_iniciar: iniciaveis.has(time.id),
    }));
    return ok(enxuto, { requestId });
  } catch {
    // A lista de times não derruba o inbox: quem chama trata a falha mostrando o
    // seletor vazio, e o resto da tela segue funcionando.
    return fail("internal_error", t("Não foi possível carregar os times."), 500, { requestId });
  }
}
