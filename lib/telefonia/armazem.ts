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
 * "não existe" pagaria uma síntese por um áudio que já estava guardado.
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
  enviar(caminho: string, bytes: Uint8Array): Promise<void>;
  /** `null` = o objeto não existe. LANÇA se o Storage falhou: falha não é ausência. */
  baixar(caminho: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Lança se o Storage recusar: quem limpa precisa saber que não limpou. */
  apagar(caminhos: string[]): Promise<void>;
  /** As pastas do topo do bucket — uma por organização. */
  listarPastas(): Promise<string[]>;
  /** Os arquivos de uma pasta, com a data de criação. Pastas dentro dela ficam de fora. */
  listarObjetos(pasta: string): Promise<ObjetoDoArmazem[]>;
}

/** Tamanho da página do `list` do Storage (o padrão dele é 100). */
const PAGINA = 1000;

/**
 * O erro do `download` quer dizer "não existe"? A mesma régua do `exists()` do
 * storage-js: HTTP 400 ou 404 (o Storage responde 400 com `statusCode: "404"` para
 * objeto ausente em versões antigas, e 404 nas novas). Erro sem `status` é de rede.
 */
function objetoAusente(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 400 || status === 404;
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
      const { error } = await bucket().upload(caminho, bytes, { contentType: "audio/basic", upsert: true });
      if (error) throw new Error(`armazem_envio: ${descrever(error)}`);
    },
    async baixar(caminho) {
      const { data, error } = await bucket().download(caminho);
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
      const { data, error } = await bucket().list("", { limit: PAGINA });
      if (error || !data) throw new Error(`armazem_lista: ${error ? descrever(error) : "sem resposta"}`);
      // No `list` do Storage, pasta é a entrada sem `id`.
      return data.filter((o) => o.id === null).map((o) => o.name);
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
