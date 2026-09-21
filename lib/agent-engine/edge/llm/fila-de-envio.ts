/**
 * A fila de envio do turno — as mensagens de UMA resposta saem na ordem em que o
 * modelo as escreveu.
 *
 * ═══ O DEFEITO (medido em 21/09/2026) ═══
 *
 * O `generateText` do AI SDK executa as tool calls de um MESMO step em paralelo
 * (`executeTools` faz `Promise.all` sobre elas). Quando o modelo emite quatro
 * `send_message` num step só, os quatro `execute` correm juntos, e cada um
 * atravessa uma cadeia de latência variável antes de chegar ao canal: a cadeia
 * `before_send` (com I/O no banco e, com a camada semântica ligada, uma chamada
 * de modelo por envio), a pausa humana antes da primeira bolha, o próprio canal.
 * O que chega primeiro ao canal sai primeiro — a ordem física no WhatsApp era a
 * ordem de CONCLUSÃO, não a da resposta.
 *
 * Medido no botão Testar (que junta `result.candidates` na ordem de conclusão):
 * o cliente receberia "Pra te ajudar a escolher: quantas pessoas usam…?" ANTES
 * de "Oi, Carla! Eu sou a Bia…". Ali a única espera de cada envio é a camada
 * semântica, e a ordem era a ordem em que o classificador respondia.
 *
 * No turno real a cadeia `before_send` segura um advisory lock por número, então
 * os envios já saíam um de cada vez — mas na ordem em que cada um GANHAVA o
 * lock, não na da resposta. Antes do lock, cada chamada ainda passa pela guarda
 * de fronteira (`guardServiceTools`, uma consulta ao banco) e pelo `connect` do
 * pool: duas idas ao banco em corrida. Lido no código, não medido em produção —
 * o que foi medido é o resultado.
 *
 * ═══ O CONSERTO ═══
 *
 * Uma corrente de promessas por chamada de modelo. Cada chamada de envio pega a
 * sua vez ATRÁS da anterior no instante em que o SDK a invoca — que é a ordem
 * das tool calls na resposta do modelo, porque todas percorrem o mesmo caminho
 * do SDK até o `execute`. A vez é tomada de forma SÍNCRONA, antes de qualquer
 * `await`: tomá-la depois de um `await` devolveria a ordem ao agendador, que é o
 * defeito.
 *
 * Por isso a fila é a camada MAIS EXTERNA, aplicada no seam (`runModelCall`) por
 * cima de `guardServiceTools`: a guarda espera uma consulta ao banco antes de
 * chamar o `execute` que ela envolve, e uma fila posta por dentro dela tomaria a
 * vez na ordem em que essas consultas voltam. Pior: o invariante de turno roda
 * sem `withServiceJob`, onde a guarda é no-op — uma fila mal posta ficaria verde
 * no teste e embaralhada em produção.
 *
 * `send_message` e `send_template` dividem a MESMA fila: as duas falam com o
 * mesmo cliente, e uma não pode ultrapassar a outra.
 *
 * Ferramentas de leitura NÃO entram: elas não têm ordem visível ao cliente, e
 * serializá-las só somaria latência ao turno.
 *
 * ═══ O QUE A FILA NÃO MUDA ═══
 *
 * Nada dentro do envio: guarda de fronteira, breaker, teto por turno, cadeia de
 * guardrails, bolhas e prévia rodam como antes — só que um de cada vez, como
 * rodariam se o modelo tivesse chamado uma ferramenta por step. Uma consequência
 * é deliberada e vale dizer: o teto de envios por turno (`maxSendsPerTurn`) é
 * checado no começo do `execute`, e com os envios paralelos todos o checavam com
 * o contador ainda em zero. Serializado, o quarto envio de um step vê os três
 * anteriores — que é o que o teto sempre disse fazer.
 *
 * Erro de um envio não trava os seguintes: a corrente segue, e o erro volta a
 * quem chamou (o SDK o entrega ao modelo como resultado da tool, como antes).
 */
import type { ToolSet } from 'ai';

/** As ferramentas que produzem mensagem física ao cliente — e só elas. */
export const FERRAMENTAS_DE_ENVIO = ['send_message', 'send_template'] as const;

/** Põe um trabalho na fila e devolve o resultado DELE (ou o erro dele). */
export type FilaDeEnvio = <T>(trabalho: () => Promise<T>) => Promise<T>;

export function criarFilaDeEnvio(): FilaDeEnvio {
  let cauda: Promise<unknown> = Promise.resolve();
  return <T>(trabalho: () => Promise<T>): Promise<T> => {
    // As duas linhas rodam sem ceder a vez: a posição na fila é decidida aqui,
    // no instante da chamada, e não quando alguma promessa resolver.
    const vez = cauda.then(trabalho);
    // A corrente engole o erro; quem chamou, não — `vez` ainda rejeita para ele.
    cauda = vez.catch(() => undefined);
    return vez;
  };
}

type Execute = (input: unknown, options: unknown) => unknown;

/**
 * Envolve as ferramentas de envio numa fila única. Chamar UMA vez por chamada de
 * modelo: cada chamada cria a sua fila, e duas filas no mesmo loop não se veem.
 * Nas chamadas sem ferramenta de envio (classificadores, compaction) é no-op.
 */
export function serializarEnvios(tools: ToolSet, fila: FilaDeEnvio = criarFilaDeEnvio()): ToolSet {
  const saida: ToolSet = { ...tools };
  for (const nome of FERRAMENTAS_DE_ENVIO) {
    const definicao = tools[nome];
    const original = definicao?.execute as Execute | undefined;
    if (definicao === undefined || original === undefined) continue;
    const execute = original.bind(definicao);
    saida[nome] = {
      ...definicao,
      // Sem `async` de propósito: a vez precisa ser tomada ANTES de qualquer
      // `await`, e uma função async que começasse esperando algo cederia a vez.
      execute: ((input: unknown, options: unknown) =>
        fila(async () => execute(input, options))) as typeof definicao.execute,
    };
  }
  return saida;
}
