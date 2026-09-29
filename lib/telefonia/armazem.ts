/**
 * O STORAGE DAS FALAS — a porta e a implementação com o cliente de serviço.
 *
 * O bucket `phone-prompts` é PRIVADO: só o cliente de serviço (API e worker) lê e
 * escreve. A tela nunca recebe URL do Storage: ouve a fala salva pela rota
 * `/api/v1/telefonia/falas/[id]/audio` (que confere a organização antes) e a
 * PRÉVIA pelo próprio corpo da resposta da rota da prévia.
 *
 * Todo caminho é `<org>/<hash>.ulaw`, montado no servidor com a organização da
 * SESSÃO (`caminhoDaFala`, em falas.ts) — nunca recebido do navegador.
 *
 * `baixar` separa "o objeto não existe" (`null`) de "o Storage falhou" (lança).
 * A diferença custa dinheiro: a prévia reaproveita o objeto que existe e só vai à
 * ElevenLabs quando ele NÃO existe — uma falha passageira do Storage lida como
 * "não existe" pagaria uma síntese por um áudio que já estava guardado. Bucket
 * ausente também é falha (lança), não objeto ausente: sem bucket, a síntese paga
 * não teria onde ficar.
 *
 * `baixar` aceita um `AbortSignal` (opcional): quem não pode esperar o Storage —
 * ligar o aviso de instabilidade num incidente — o passa por `comPrazoDeLeitura`,
 * que desiste no prazo e aborta o pedido. Sem o sinal, a chamada ao storage-js é
 * a de sempre.
 *
 * `enviar` NÃO sobrescreve: o primeiro a gravar um caminho vence, e o segundo
 * recebe `"ja_existia"`. Duas prévias do mesmo texto ao mesmo tempo gravam o MESMO
 * caminho; com sobrescrita, a pessoa podia ouvir um áudio e ficar guardado outro.
 *
 * `listarPastas`/`listarObjetos` existem para a limpeza do worker (Task 12 do
 * plano da fase 2): a pasta do topo é a organização, e a data de criação decide a
 * janela de 24 h. Pela API do Storage, e não por SQL em `storage.objects`: num
 * Supabase próprio a conexão do app (`SUPABASE_DB_URL`) pode ser uma role com
 * grants só em `public` (ver `url_do_schema` em hostgator-setup-kit/_common.sh),
 * e a service role alcança o Storage em toda instalação.
 *
 * Sem import do cliente da ElevenLabs: o worker usa este arquivo
 * (tests/unit/ligacao-nunca-chama-elevenlabs.test.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { BUCKET_DAS_FALAS } from "./vocabulario";

export interface ObjetoDoArmazem {
  /** `<org>/<arquivo>` — o mesmo formato de `phone_prompts.storage_path`. */
  caminho: string;
  criadoEm: Date;
}

export interface PortaDoArmazem {
  /**
   * Grava sem sobrescrever. `"ja_existia"` = outro envio gravou este caminho
   * antes, e o objeto guardado é o DELE. Lança se o Storage falhou.
   */
  enviar(caminho: string, bytes: Uint8Array): Promise<"gravado" | "ja_existia">;
  /**
   * `null` = o objeto não existe. LANÇA se o Storage falhou: falha não é ausência.
   * Com `signal`, o pedido é abortado quando ele disparar (e isso também LANÇA).
   */
  baixar(caminho: string, opcoes?: { signal?: AbortSignal }): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Lança se o Storage recusar: quem limpa precisa saber que não limpou. */
  apagar(caminhos: string[]): Promise<void>;
  /** As pastas do topo do bucket — uma por organização. */
  listarPastas(): Promise<string[]>;
  /** Os arquivos de uma pasta, com a data de criação. Pastas dentro dela ficam de fora. */
  listarObjetos(pasta: string): Promise<ObjetoDoArmazem[]>;
}

/** Tamanho da página do `list` do Storage (o padrão dele é 100). */
const PAGINA = 1000;

/** Os campos que o `StorageApiError` do storage-js carrega: HTTP, e o corpo do Storage. */
function campos(error: unknown): { status: unknown; statusCode: unknown; code: unknown; mensagem: string } {
  const e = (error ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown };
  return { status: e.status, statusCode: e.statusCode, code: e.code, mensagem: error instanceof Error ? error.message : "" };
}

/**
 * O BUCKET não existe (instalação sem o apêndice da 0288, ou bucket apagado)? O
 * Storage responde com o MESMO `statusCode: "404"` de objeto ausente; o que
 * separa é o `code` (`NoSuchBucket`, versões novas) ou a mensagem (`Bucket not
 * found`, todas as versões).
 */
function bucketAusente(error: unknown): boolean {
  const { code, mensagem } = campos(error);
  return code === "NoSuchBucket" || /bucket not found/i.test(mensagem);
}

/**
 * O erro do `download` quer dizer "este objeto não existe"? A régua do `exists()`
 * do storage-js — HTTP 400 ou 404 (o Storage responde 400 com `statusCode: "404"`
 * em versões antigas, e 404 nas novas) —, menos o bucket ausente. Erro sem
 * `status` é de rede.
 */
function objetoAusente(error: unknown): boolean {
  const { status } = campos(error);
  return (status === 400 || status === 404) && !bucketAusente(error);
}

/**
 * O `upload` sem `upsert` achou o objeto já gravado? O Storage responde 409 —
 * como HTTP nas versões novas, e como `statusCode: "409"` num HTTP 400 nas
 * antigas —, com `code: "Duplicate"` e "The resource already exists".
 */
function jaExiste(error: unknown): boolean {
  const { status, statusCode, code, mensagem } = campos(error);
  return status === 409 || statusCode === "409" || code === "Duplicate" || /already exists/i.test(mensagem);
}

/**
 * Classe, status e mensagem (com teto) do erro do Storage — o que diz ao operador
 * "Bucket not found" ou "fetch failed". Não carrega segredo: a service key vai no
 * header, nunca na URL nem no corpo do erro.
 */
function descrever(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const nome = error instanceof Error ? error.name : "desconhecido";
  const mensagem = error instanceof Error ? error.message.slice(0, 200) : "";
  return `${nome}${typeof status === "number" ? ` ${status}` : ""}${mensagem ? `: ${mensagem}` : ""}`;
}

export function armazemDoSupabase(admin: SupabaseClient): PortaDoArmazem {
  const bucket = () => admin.storage.from(BUCKET_DAS_FALAS);
  return {
    async enviar(caminho, bytes) {
      const { error } = await bucket().upload(caminho, bytes, { contentType: "audio/basic", upsert: false });
      if (!error) return "gravado";
      if (jaExiste(error) && !bucketAusente(error)) return "ja_existia";
      throw new Error(`armazem_envio: ${descrever(error)}`);
    },
    async baixar(caminho, opcoes) {
      // Sem sinal, a chamada de sempre (só o caminho); com ele, o `FetchParameters` do storage-js.
      const { data, error } = opcoes?.signal
        ? await bucket().download(caminho, {}, { signal: opcoes.signal })
        : await bucket().download(caminho);
      if (error) {
        if (objetoAusente(error)) return null;
        throw new Error(`armazem_download: ${descrever(error)}`);
      }
      if (!data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async apagar(caminhos) {
      if (caminhos.length === 0) return;
      const { error } = await bucket().remove(caminhos);
      if (error) throw new Error(`armazem_remocao: ${descrever(error)}`);
    },
    async listarPastas() {
      const pastas: string[] = [];
      for (let offset = 0; ; offset += PAGINA) {
        const { data, error } = await bucket().list("", { limit: PAGINA, offset });
        if (error || !data) throw new Error(`armazem_lista: ${error ? descrever(error) : "sem resposta"}`);
        // No `list` do Storage, pasta é a entrada sem `id`.
        for (const o of data) if (o.id === null) pastas.push(o.name);
        if (data.length < PAGINA) return pastas;
      }
    },
    async listarObjetos(pasta) {
      const objetos: ObjetoDoArmazem[] = [];
      for (let offset = 0; ; offset += PAGINA) {
        const { data, error } = await bucket().list(pasta, {
          limit: PAGINA,
          offset,
          sortBy: { column: "created_at", order: "asc" },
        });
        if (error || !data) throw new Error(`armazem_lista: ${error ? descrever(error) : "sem resposta"}`);
        for (const o of data) {
          if (o.id !== null && o.created_at) objetos.push({ caminho: `${pasta}/${o.name}`, criadoEm: new Date(o.created_at) });
        }
        if (data.length < PAGINA) return objetos;
      }
    },
  };
}

/**
 * O armazém com PRAZO na leitura: `baixar` desiste em `ms` — LANÇA
 * (`armazem_download: prazo de N ms estourado`, que é falha e não ausência) e
 * ABORTA o pedido em curso pelo `AbortSignal`. A corrida com o relógio vale mesmo
 * quando o armazém ignora o sinal: o supabase-js não tem prazo próprio, e quem
 * chama não fica preso a ele.
 *
 * Quem usa: ligar o aviso de instabilidade com texto novo
 * (lib/telefonia/emergencias.ts). Num incidente o Storage pode estar lento junto
 * com o resto, e o gerente precisa de uma resposta em segundos.
 */
export function comPrazoDeLeitura(armazem: Pick<PortaDoArmazem, "baixar">, ms: number): Pick<PortaDoArmazem, "baixar"> {
  return {
    async baixar(caminho) {
      const controle = new AbortController();
      let relogio: ReturnType<typeof setTimeout> | undefined;
      const estouro = new Promise<never>((_, rejeitar) => {
        relogio = setTimeout(() => {
          controle.abort();
          rejeitar(new Error(`armazem_download: prazo de ${ms} ms estourado`));
        }, ms);
      });
      try {
        return await Promise.race([armazem.baixar(caminho, { signal: controle.signal }), estouro]);
      } finally {
        clearTimeout(relogio);
      }
    },
  };
}
