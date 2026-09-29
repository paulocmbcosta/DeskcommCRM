/**
 * A TRANSAÇÃO DAS GRAVAÇÕES DO TELEFONE — uma conexão só, com prazo de trava.
 * Server-only.
 *
 * Toda gravação do telefone que trava uma linha e decide sob a trava passa por
 * aqui: a fala geral (`salvarFalaGeral`, trava `phone_settings`), salvar e
 * arquivar o menu (`salvarMenuDaOrg`, `arquivarMenu`) e apontar um número para um
 * menu (`lib/channels/telefonia/numeros.ts`) — as três últimas travando o menu com
 * `travarMenuAtivo`. Uma implementação só, porque cada cópia era um lugar a mais
 * para esquecer o rollback ou devolver ao pool uma conexão quebrada.
 *
 * `emTransacao(pool, lockTimeout, fn, traduzirErro?)`:
 *  1. pega UMA conexão, `begin` e `set local lock_timeout = '<lockTimeout>'` — quem
 *     espera a trava mais que isso desiste em vez de ficar preso (o papel da
 *     conexão direta não tem `lock_timeout` de papel);
 *  2. `fn(cliente)` faz as consultas NESSA conexão e devolve `confirmar(valor)`
 *     (`commit`) ou `desfazer(valor)` (`rollback`, a recusa que não é erro);
 *  3. erro em qualquer passo (inclusive no `commit`) desfaz; o 55P03
 *     (`lock_not_available`: o prazo venceu) vira `{ ok: false, motivo:
 *     "gravacao_em_andamento" }`; `traduzirErro` transforma em valor a recusa
 *     conhecida do banco (ex.: a FK composta do time); o resto sobe;
 *  4. se até o `rollback` falhar, a conexão é DESCARTADA (`release(erro)`), e não
 *     devolvida ao pool para a próxima rota herdar uma transação quebrada.
 *
 * Nada de rede dentro de `fn`: o Storage (ou qualquer HTTP) vai ANTES, sem
 * conexão na mão — com a trava segura, um serviço lento prenderia a linha e uma
 * conexão que as rotas da IA e do MCP também usam.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";

/** Uma conexão SÓ desta gravação: a transação e a trava vivem nela. O `pg.PoolClient` serve. */
export interface ConexaoDaTransacao extends Queryable {
  /** Com um erro, a conexão é DESCARTADA em vez de voltar ao pool (a semântica do `pg`). */
  release(erro?: Error): void;
}

/** De onde sai a conexão da transação. O `pg.Pool` da rota serve. */
export interface PoolDeTransacao {
  connect(): Promise<ConexaoDaTransacao>;
}

/** O que `fn` decidiu: confirmar (`commit`) ou desfazer (`rollback`), e o que devolver. */
export interface DesfechoDaTransacao<T> {
  readonly confirmar: boolean;
  readonly valor: T;
}

export const confirmar = <T>(valor: T): DesfechoDaTransacao<T> => ({ confirmar: true, valor });
export const desfazer = <T>(valor: T): DesfechoDaTransacao<T> => ({ confirmar: false, valor });

/** O prazo da trava venceu: outra gravação da mesma linha está em andamento. */
export interface TravaOcupada {
  ok: false;
  motivo: "gravacao_em_andamento";
}

/** O prazo entra no texto do SQL (`set local` não aceita parâmetro): só o formato do Postgres, sem aspas. */
const FORMATO_DO_PRAZO = /^[1-9]\d{0,5}(ms|s)$/;

/** 55P03 (`lock_not_available`): o `lock_timeout` venceu esperando a trava. */
function ehPrazoDaTrava(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "55P03";
}

export async function emTransacao<T>(
  pool: PoolDeTransacao,
  lockTimeout: string,
  fn: (cliente: ConexaoDaTransacao) => Promise<DesfechoDaTransacao<T>>,
  traduzirErro: (e: unknown) => T | null = () => null,
): Promise<T | TravaOcupada> {
  if (!FORMATO_DO_PRAZO.test(lockTimeout)) throw new Error(`emTransacao: prazo da trava fora do formato (${lockTimeout.slice(0, 20)})`);
  const cliente = await pool.connect();
  let descartar: Error | undefined;
  try {
    await cliente.query("begin");
    await cliente.query(`set local lock_timeout = '${lockTimeout}'`);
    const d = await fn(cliente);
    await cliente.query(d.confirmar ? "commit" : "rollback");
    return d.valor;
  } catch (erro) {
    try {
      await cliente.query("rollback");
    } catch (falha) {
      // A conexão morreu: devolvê-la ao pool entregaria a próxima rota a um socket quebrado.
      descartar = falha instanceof Error ? falha : new Error("rollback falhou");
    }
    if (ehPrazoDaTrava(erro)) return { ok: false, motivo: "gravacao_em_andamento" };
    const traduzido = traduzirErro(erro);
    if (traduzido !== null) return traduzido;
    throw erro;
  } finally {
    cliente.release(descartar);
  }
}
