/**
 * O CLIENTE ESTÁ MUITO INSATISFEITO? — a leitura que o turno faz antes de responder.
 *
 * Substitui a transferência automática por sentimento (decisão do dono,
 * 2026-09-25): em vez de um atalho que calava a IA e jogava a conversa na fila
 * SEM TIME, o próprio agente recebe o aviso no turno e passa para o setor que
 * cuida do assunto — escolhendo o time, com uma frase coerente com a conversa.
 *
 * A nota é a do ATENDIMENTO, não a da mensagem: `conversations.sentimento_atual`,
 * gravada pelo worker de sentimento, que a cada mensagem do cliente faz o Jev
 * ler o atendimento em aberto inteiro (`workers/ai-sentiment-worker.ts`). Até a
 * 1.45 o turno lia a pior nota POR MENSAGEM desde a última resposta — e um
 * cliente que passou dez mensagens reclamando e mandou um "ok" deixava de
 * contar como insatisfeito. O limite vem de `ai_agents.config.sentiment_threshold`
 * (o campo da tela "Operação do agente"; padrão 0,3 — o mesmo do worker).
 *
 * Nota ainda não calculada (atendimento novo; o worker corre em paralelo) = sem
 * aviso — o turno segue normal. Conversa encerrada não tem nota (o banco zera).
 */
import type pg from 'pg';

/** O mesmo padrão de `workers/ai-sentiment-worker.ts`. */
export const LIMITE_PADRAO_DE_SENTIMENTO = 0.3;

type Queryable = Pick<pg.Pool, 'query'>;

export async function notaCriticaDoTurno(
  db: Queryable,
  input: { tenantId: string; conversationId: string; agentId: string },
): Promise<number | null> {
  const { rows } = await db.query<{ nota: number | null; limite: number | null }>(
    `select
       (select c.sentimento_atual::float8
          from conversations c
         where c.organization_id = $1 and c.id = $2) as nota,
       (select case when jsonb_typeof(a.config->'sentiment_threshold') = 'number'
                    then (a.config->>'sentiment_threshold')::float8 end
          from ai_agents a where a.id = $3 and a.organization_id = $1) as limite`,
    [input.tenantId, input.conversationId, input.agentId],
  );
  const nota = rows[0]?.nota ?? null;
  const limite = rows[0]?.limite ?? LIMITE_PADRAO_DE_SENTIMENTO;
  return nota !== null && nota < limite ? nota : null;
}

/**
 * O que o modelo lê. Na voz de atendimento, sem jargão (sem "sentimento",
 * "score", "handoff"): o que está no prompt o modelo pode repetir ao cliente.
 */
export const AVISO_CLIENTE_INSATISFEITO =
  '## Cliente muito insatisfeito\n' +
  'O atendimento mostra que o cliente está muito insatisfeito. Acolha em uma frase curta e sincera, ' +
  'sem desculpa pronta, e passe agora para uma pessoa do setor que cuida do assunto dele — escolha o setor ' +
  'antes de passar. Não insista em resolver sozinha.';
