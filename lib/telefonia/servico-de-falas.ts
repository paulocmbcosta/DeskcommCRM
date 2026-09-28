/**
 * A FIAÇÃO DA INSTALAÇÃO para as rotas do telefone — o único lugar que lê o env
 * da ElevenLabs, monta o armazém com o cliente de serviço e decide o status HTTP
 * de cada falha. Server-only. Nada do caminho da ligação importa este arquivo
 * (tests/unit/ligacao-nunca-chama-elevenlabs.test.ts).
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

import { armazemDoSupabase, type PortaDoArmazem } from "./armazem";
import { chaveDeVoz } from "./chave-elevenlabs";
import { ErroDaElevenLabs, listarVozes, sintetizar, type OpcoesDoCliente } from "./elevenlabs";
import { vozDaOrganizacao, type VozDaOrganizacao } from "./falas";
import type { Sintetizador } from "./previa";
import type { FalhaDaFala } from "./vocabulario";

/** A URL base só muda no e2e (a ElevenLabs falsa de tests/e2e/telefonia-ura-e-falas.spec.ts). */
export function opcoesDaElevenLabs(): OpcoesDoCliente {
  return env.ELEVENLABS_API_BASE_URL ? { baseUrl: env.ELEVENLABS_API_BASE_URL } : {};
}

export type ValidacaoDaChaveDeVoz = { ok: true; vozes: number } | { ok: false; motivo: FalhaDaFala };

/**
 * A chave da ElevenLabs vale? Lista as vozes da conta — a chave autentica essa
 * chamada, e ela não gasta crédito. Nunca lança.
 *
 * É a régua ÚNICA das duas portas que validam a chave: o cadastro
 * (`PUT /api/v1/telefonia/voz/chave`) e o "Testar" da credencial
 * (`POST /api/v1/ai/credentials/:id/revalidate`). Se cada uma tivesse a sua, uma
 * chave podia ser aceita numa e marcada inválida na outra.
 */
export async function validarChaveDeVoz(chave: string): Promise<ValidacaoDaChaveDeVoz> {
  try {
    const vozes = await listarVozes(chave, opcoesDaElevenLabs());
    return { ok: true, vozes: vozes.length };
  } catch (e) {
    return { ok: false, motivo: e instanceof ErroDaElevenLabs ? e.motivo : "erro_do_provedor" };
  }
}

/**
 * Falha da ElevenLabs (e do Storage) volta 422 (a pessoa pode consertar, ou
 * esperar) ou 502 (o provedor/Storage falhou) — NUNCA 429 ou 503: o `apiClient`
 * do navegador repete esses sozinho, e cada repetição de síntese gasta crédito
 * da conta do cliente. Por isso o 429 da PRÓPRIA ElevenLabs (`limite_de_uso`)
 * sai 422.
 *
 * A exceção é a cota de prévias da organização (`limite_de_previas`, 30 por
 * hora): ela é limite NOSSO, e limite nosso responde 429 com `Retry-After`, como
 * manda a doutrina da API. A rota da prévia põe o `Retry-After`, e o contrato do
 * `apiClient` (lib/api/client.ts) é não esperar nem repetir quando ele passa de
 * 10 s — lançar `rate_limited` na hora, em vez de travar a tela por até 1 h.
 */
export const STATUS_DA_FALHA: Record<FalhaDaFala, 422 | 429 | 502> = {
  sem_chave: 422,
  sem_voz: 422,
  chave_invalida: 422,
  sem_credito: 422,
  texto_recusado: 422,
  voz_inexistente: 422,
  limite_de_uso: 422,
  limite_de_previas: 429,
  previa_ausente: 422,
  previa_desatualizada: 422,
  armazenamento: 502,
  sem_resposta: 502,
  erro_do_provedor: 502,
};

/** A síntese com a URL base da instalação. Só a rota da PRÉVIA a entrega a `gerarPrevia`. */
export function sintetizadorDaInstalacao(): Sintetizador {
  const opcoes = opcoesDaElevenLabs();
  return (p) => sintetizar(p, opcoes);
}

/** O Storage das falas pelo cliente de serviço — o mesmo dos outros buckets privados. */
export function armazemDaInstalacao(): PortaDoArmazem {
  return armazemDoSupabase(createAdminClient());
}

/**
 * A chave (decifrada) e a voz da organização — o que a PRÉVIA precisa. Salvar não
 * precisa de chave. `organizationId` é o da SESSÃO: as duas leituras filtram por ele.
 */
export async function contextoDeFala(
  db: Queryable,
  organizationId: string,
): Promise<{ chave: string | null; voz: VozDaOrganizacao | null }> {
  const [chave, voz] = await Promise.all([chaveDeVoz(db, organizationId), vozDaOrganizacao(db, organizationId)]);
  return { chave, voz };
}

/** Prévias que vão à ElevenLabs, por organização e por hora (desenho §4, passo 1). Reaproveitar não conta. */
export const LIMITE_DE_PREVIAS_POR_HORA = 30;
const JANELA_DAS_PREVIAS_S = 3600;

export interface CotaDePrevia {
  permitida: boolean;
  limite: number;
  restantes: number;
  /** Segundos até a janela virar (1 a 3600) — o `Retry-After` da recusa. */
  reabreEmS: number;
}

/**
 * Gasta uma unidade da cota de prévias da organização, no limitador que o CRM já
 * usa (`checkRateLimit`: Upstash, com contador em memória quando o Redis não
 * responde). Janela FIXA de uma hora (INCR + EXPIRE, alinhada ao relógio) — é o
 * que o limitador implementa, não uma janela deslizante. A organização vem da
 * SESSÃO, pela rota: nenhum corpo escolhe de quem é a cota.
 *
 * A recusa volta 429 com `Retry-After` (`STATUS_DA_FALHA.limite_de_previas`). O
 * `Retry-After` passa de 10 s quase sempre, e é isso que faz o `apiClient` do
 * navegador lançar na hora em vez de dormir e repetir (lib/api/client.ts).
 */
export async function consumirCotaDePrevia(organizationId: string, agora: Date = new Date()): Promise<CotaDePrevia> {
  const r = await checkRateLimit(`telefonia-previa:${organizationId}`, LIMITE_DE_PREVIAS_POR_HORA, JANELA_DAS_PREVIAS_S);
  const segundos = Math.floor(agora.getTime() / 1000);
  return {
    permitida: r.allowed,
    limite: r.limit,
    restantes: Math.max(0, r.limit - r.count),
    reabreEmS: JANELA_DAS_PREVIAS_S - (segundos % JANELA_DAS_PREVIAS_S),
  };
}
