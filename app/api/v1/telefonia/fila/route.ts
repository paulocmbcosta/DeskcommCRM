/**
 * GET /api/v1/telefonia/fila — a fila do telefone ao vivo (aba Telefone do
 * Inbox; migration 0295): quem espera por ordem de chegada, quem está no menu,
 * em ligação, e as perdidas dos últimos 30 minutos.
 *
 * `viewer`+: todo mundo que entra no Inbox vê a fila de TODOS os times, só com
 * nome, número, time e espera (D4 do desenho) — sem ver a fila do outro setor,
 * ninguém consegue ajudar no pico. Abrir a conversa segue a RLS de sempre.
 *
 * A organização sai da sessão. No pico, todo navegador com o Inbox aberto pede
 * ao mesmo tempo (o Realtime avisa todos juntos), e a leitura é dividida — mas
 * com UMA garantia: NENHUM pedido recebe uma leitura que começou antes de ele
 * chegar. É um voo único com fila de um, por organização, nesta instância
 * (`lerSemAtraso`).
 *
 * Por quê: a primeira versão guardava a leitura por 1,5 s. A lê em t=0; o banco
 * muda em t=300 ms e o Realtime avisa; B relê em t=700 ms e recebia a promessa de
 * t=0 — "aguardando" quando já era "em ligação" — e ninguém relia até o próximo
 * evento. O aviso do Realtime é justamente o pedido que não pode ler o passado.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configAriDoAmbiente } from "@/lib/channels/telefonia/ari";
import { lerFilaDoTelefone } from "@/lib/channels/telefonia/fila-da-tela";
import { traduzir } from "@/lib/i18n/dicionario";
import { FILA_DESLIGADA, type FilaDoTelefone } from "@/lib/telefonia/fila";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * O mínimo entre os INÍCIOS de duas leituras da mesma organização: no pico o
 * banco faz no máximo 2 por segundo por organização, ao custo de até meio
 * segundo de espera para quem chega logo depois de uma leitura começar.
 */
const INTERVALO_MINIMO_ENTRE_LEITURAS_MS = 500;

/**
 * A vaga de leitura de uma organização: ocupada desde que uma leitura COMEÇA
 * até ela terminar — e nunca por menos que o intervalo mínimo. Quem chega com a
 * vaga ocupada entra na `proxima`, uma só, dividida por todos os que chegarem
 * até ela começar.
 */
interface Vaga {
  proxima: { promessa: Promise<FilaDoTelefone>; largar: (leitura: Promise<FilaDoTelefone>) => void } | null;
}

/** A chave é a organização DA SESSÃO: a leitura de uma nunca é servida a outra. */
const vagas = new Map<string, Vaga>();

/** Só para teste: quantas organizações têm vaga ocupada. Depois de tudo, zero — o mapa não cresce. */
export function organizacoesComLeitura(): number {
  return vagas.size;
}

/** Começa AGORA uma leitura desta organização e ocupa a vaga dela. */
function comecar(org: string): Promise<FilaDoTelefone> {
  const vaga: Vaga = { proxima: null };
  vagas.set(org, vaga);
  // `async`: o pool que lança na hora (sem SUPABASE_DB_URL) vira leitura rejeitada, e a vaga libera do mesmo jeito.
  const leitura = (async () => lerFilaDoTelefone(getRequestPool(), org))();
  const terminou = leitura.then(
    () => undefined,
    () => undefined,
  );
  const intervalo = new Promise<void>((resolve) => setTimeout(resolve, INTERVALO_MINIMO_ENTRE_LEITURAS_MS));
  void Promise.all([terminou, intervalo]).then(() => {
    // Numa passada só, sem ceder a vez a outro pedido: ou a próxima começa agora
    // (e ocupa a vaga), ou a entrada some. A leitura que falhou não deixa nada
    // para trás — quem estava nela já recebeu o erro, e a próxima lê o banco de novo.
    if (vaga.proxima) vaga.proxima.largar(comecar(org));
    else vagas.delete(org);
  });
  return leitura;
}

/**
 * A fila desta organização, lida do banco DEPOIS de este pedido chegar. Com a
 * vaga livre, lê agora. Com ela ocupada, espera a próxima leitura — que começa
 * quando a atual termina e o intervalo mínimo desde o início dela passou — em
 * vez de pegar carona na que já estava em curso.
 */
function lerSemAtraso(org: string): Promise<FilaDoTelefone> {
  const vaga = vagas.get(org);
  if (!vaga) return comecar(org);
  if (!vaga.proxima) {
    let largar: (leitura: Promise<FilaDoTelefone>) => void = () => undefined;
    const promessa = new Promise<FilaDoTelefone>((resolve) => {
      largar = resolve;
    });
    vaga.proxima = { promessa, largar };
  }
  return vaga.proxima.promessa;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "telefonia_fila" });
  if (!authz.ok) return authz.response;

  if (configAriDoAmbiente() === null) {
    return ok({ ...FILA_DESLIGADA, agora: new Date().toISOString() } satisfies FilaDoTelefone, { requestId });
  }
  try {
    return ok(await lerSemAtraso(authz.org.orgId), { requestId });
  } catch {
    return fail("internal_error", traduzir("Não foi possível ler a fila do telefone.", authz.user.idioma), 500, { requestId });
  }
}
