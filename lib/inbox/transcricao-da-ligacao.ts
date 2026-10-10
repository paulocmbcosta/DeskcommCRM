/**
 * A TRANSCRIÇÃO DA LIGAÇÃO NA LISTAGEM DE MENSAGENS (F4, migration 0298).
 *
 * A linha de `messages` carrega só a PROJEÇÃO da transcrição — a situação
 * (`metadata.voice_call.transcricao.situacao`), nunca o texto: ela vai inteira,
 * pela REST e pelo Realtime, a qualquer membro que veja a conversa. O texto, os
 * trechos e o resumo moram em `voice_call_transcripts`, que o navegador não lê.
 *
 * É aqui que o cartão recebe o que pode mostrar. Para cada mensagem de ligação
 * da página que tenha a projeção:
 *
 *  - quem PODE ouvir a gravação (usuário com papel atendente ou acima, e com o
 *    segundo fator provado na sessão, se tem um cadastrado — a mesma exigência
 *    da rota da escuta) recebe a situação VERDADEIRA — relida da tabela, que é a
 *    fonte — e, na transcrição pronta, o resumo;
 *  - quem não pode (papel só de leitura, token de integração, agente de IA) não
 *    recebe nada: a projeção sai da resposta, e o cartão cala;
 *  - projeção sem linha na tabela (a transcrição foi apagada pela retenção, pela
 *    anonimização) sai também — o cartão não promete um texto que não existe;
 *  - ligação de contato ANONIMIZADO sai também, mesmo que a linha exista — pelo
 *    FATO (`contacts.is_anonymized`), como a transcrição do áudio do WhatsApp
 *    (`./transcricao-do-audio.ts`). A anonimização apaga a transcrição, mas há um
 *    caso em que não chega a apagar: o contato já marcado como anonimizado por
 *    uma escrita direta de um membro (a RLS de `contacts` hoje deixa) faz os dois
 *    caminhos de anonimização responderem "já estava" e saírem sem redigir nada.
 *    A leitura não depende de o apagamento ter acontecido;
 *  - se a consulta falha, sai de todas: na dúvida, o resumo não é entregue.
 *
 * ⚠️ Isto decide o que ESTA ROTA responde. A projeção (só a situação) continua na
 * linha de `messages`; o que NUNCA está lá é o conteúdo.
 *
 * A leitura usa o cliente de serviço — a tabela não tem grant para o membro — e
 * por isso filtra `organization_id` à mão, e só consulta ligações cujas
 * mensagens a listagem JÁ devolveu sob a RLS de quem pediu: a visibilidade da
 * conversa (por time, 0281) é a da própria listagem. O id da ligação sai do
 * `external_id` `ligacao:<uuid>`, que só o sistema escreve (trigger da 0289).
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ESTADOS_DA_TRANSCRICAO,
  SITUACAO_DO_ESTADO,
  ligacaoDoExternalId,
  type EstadoDaTranscricao,
  type TranscricaoNoCartao,
} from "@/lib/telefonia/transcricao";

interface MensagemComMetadado {
  external_id?: string | null;
  metadata?: unknown;
}

/** O que a tabela diz de cada ligação: o estado e, se houver, o resumo. */
export type LeitorDeTranscricoes = (
  organizationId: string,
  ligacoes: string[],
) => Promise<Map<string, { estado: EstadoDaTranscricao; resumo: string | null }>>;

/**
 * Destas ligações, as de contato que NÃO foi anonimizado — as únicas cuja
 * transcrição pode ser entregue. Usada pela listagem e pela rota da leitura,
 * para que não possam discordar.
 *
 * Pergunta pelos LIBERADOS, e não pelos anonimizados, para falhar fechado (a
 * mesma escolha de `contatosNaoAnonimizados`, na listagem): ligação que a
 * consulta não devolve, ligação sem contato e contato que não volta como "não
 * anonimizado" ficam de fora. Lança se uma consulta falhar — quem chama não
 * entrega nada.
 *
 * Cliente de serviço, preso à organização de quem pede: quem pode ler a
 * transcrição é decidido ANTES (papel, e a RLS da conversa); aqui só se confere
 * um fato do contato, que não depende de quem pergunta.
 */
export async function ligacoesDeContatoLiberado(organizationId: string, ligacoes: string[]): Promise<Set<string>> {
  if (ligacoes.length === 0) return new Set();
  const admin = createAdminClient();
  const { data: chamadas, error } = await admin
    .from("voice_calls")
    .select("id, contact_id")
    .eq("organization_id", organizationId)
    .in("id", ligacoes);
  if (error) throw new Error(error.message);
  const linhas = (chamadas ?? []) as Array<{ id: string; contact_id: string | null }>;
  const contatos = [...new Set(linhas.map((v) => v.contact_id).filter((c): c is string => typeof c === "string"))];
  if (contatos.length === 0) return new Set();
  const { data: livres, error: erroDosContatos } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_anonymized", false)
    .in("id", contatos);
  if (erroDosContatos) throw new Error(erroDosContatos.message);
  const liberados = new Set(((livres ?? []) as Array<{ id: string }>).map((c) => c.id));
  return new Set(linhas.filter((v) => v.contact_id !== null && liberados.has(v.contact_id)).map((v) => v.id));
}

/**
 * O leitor de verdade: cliente de serviço, sempre preso à organização. Só
 * devolve ligação de contato não anonimizado. Lança se uma consulta falhar.
 */
export const lerTranscricoesDasLigacoes: LeitorDeTranscricoes = async (organizationId, ligacoes) => {
  const { data, error } = await createAdminClient()
    .from("voice_call_transcripts")
    .select("voice_call_id, status, summary")
    .eq("organization_id", organizationId)
    .in("voice_call_id", ligacoes);
  if (error) throw new Error(error.message);
  const mapa = new Map<string, { estado: EstadoDaTranscricao; resumo: string | null }>();
  for (const r of (data ?? []) as Array<{ voice_call_id: string; status: string; summary: string | null }>) {
    if (!(ESTADOS_DA_TRANSCRICAO as readonly string[]).includes(r.status)) continue;
    mapa.set(r.voice_call_id, { estado: r.status as EstadoDaTranscricao, resumo: r.summary });
  }
  if (mapa.size === 0) return mapa;
  const liberadas = await ligacoesDeContatoLiberado(organizationId, [...mapa.keys()]);
  for (const id of [...mapa.keys()]) if (!liberadas.has(id)) mapa.delete(id);
  return mapa;
};

/** A ligação desta mensagem, se ela é o registro de uma ligação E carrega a projeção da transcrição. */
function ligacaoComProjecao(m: MensagemComMetadado): string | null {
  const id = ligacaoDoExternalId(m.external_id);
  if (!id) return null;
  const vc = (m.metadata as { voice_call?: unknown } | null | undefined)?.voice_call;
  if (!vc || typeof vc !== "object" || Array.isArray(vc)) return null;
  return "transcricao" in (vc as Record<string, unknown>) ? id : null;
}

/** A mesma mensagem com a transcrição do cartão trocada — ou retirada, com `null`. */
function comTranscricao<T extends MensagemComMetadado>(m: T, transcricao: TranscricaoNoCartao | null): T {
  const metadata = m.metadata as Record<string, unknown>;
  const { transcricao: _fora, ...resto } = metadata.voice_call as Record<string, unknown>;
  return { ...m, metadata: { ...metadata, voice_call: transcricao ? { ...resto, transcricao } : resto } };
}

export async function comTranscricaoDasLigacoes<T extends MensagemComMetadado>(
  mensagens: T[],
  /**
   * `podeLer` pode ser uma PERGUNTA em vez de uma resposta: quem chama só paga
   * por ela (conferir o segundo fator da sessão custa idas ao serviço de
   * autenticação) quando a página tem ligação transcrita. Pergunta que lança
   * conta como "não pode".
   */
  p: { organizationId: string; podeLer: boolean | (() => Promise<boolean>) },
  ler: LeitorDeTranscricoes = lerTranscricoesDasLigacoes,
): Promise<T[]> {
  const ligacoes = new Map<number, string>();
  mensagens.forEach((m, i) => {
    const id = ligacaoComProjecao(m);
    if (id) ligacoes.set(i, id);
  });
  // Conversa sem ligação transcrita: nenhuma ida a mais ao banco.
  if (ligacoes.size === 0) return mensagens;

  let podeLer = false;
  try {
    podeLer = typeof p.podeLer === "function" ? await p.podeLer() : p.podeLer;
  } catch (e) {
    logger.warn("[messages.list] não consegui saber se quem pede pode ler a transcrição; o cartão segue sem ela", {
      organization_id: p.organizationId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  let lidas: Awaited<ReturnType<LeitorDeTranscricoes>> = new Map();
  if (podeLer) {
    try {
      lidas = await ler(p.organizationId, [...new Set(ligacoes.values())]);
    } catch (e) {
      logger.warn("[messages.list] não consegui ler as transcrições das ligações; o cartão segue sem elas", {
        organization_id: p.organizationId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return mensagens.map((m, i) => {
    const id = ligacoes.get(i);
    if (!id) return m;
    const lida = lidas.get(id);
    if (!lida) return comTranscricao(m, null);
    const situacao = SITUACAO_DO_ESTADO[lida.estado];
    const resumo = situacao === "pronta" ? (lida.resumo ?? "").trim() || null : null;
    return comTranscricao(m, { situacao, resumo });
  });
}
