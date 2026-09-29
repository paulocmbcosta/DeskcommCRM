/**
 * A FIAÇÃO DA ELEVENLABS para as rotas do telefone — o único lugar que lê o env
 * da ElevenLabs, valida a chave, monta o sintetizador da prévia e conta a cota
 * de prévias. Server-only. Nada do caminho da ligação importa este arquivo
 * (tests/unit/ligacao-nunca-chama-elevenlabs.test.ts): ele importa o cliente.
 *
 * O que NÃO depende da ElevenLabs mora fora daqui, para quem não sintetiza não
 * carregar o cliente: o armazém da instalação (`armazemDaInstalacao`, em
 * armazem.ts — o worker o usa) e o status HTTP de cada falha (`STATUS_DA_FALHA`,
 * em vocabulario.ts — as rotas de salvar, do menu e do aviso o usam).
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { env } from "@/lib/env";

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

/** A síntese com a URL base da instalação. Só a rota da PRÉVIA a entrega a `gerarPrevia`. */
export function sintetizadorDaInstalacao(): Sintetizador {
  const opcoes = opcoesDaElevenLabs();
  return (p) => sintetizar(p, opcoes);
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
 * A recusa volta 429 com `Retry-After` (`STATUS_DA_FALHA.limite_de_previas`, em
 * vocabulario.ts). O
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
