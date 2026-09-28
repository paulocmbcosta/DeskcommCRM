/**
 * A PRÉVIA DE UMA FALA — a ÚNICA hora em que a ElevenLabs é chamada (desenho da
 * fase 2, D15 e §4, passo 1). Server-only.
 *
 *  - hash = sha256(modelo, voz, texto) (`hashDaFala`). O objeto `<org>/<hash>.ulaw`
 *    já existe no Storage DA ORGANIZAÇÃO? Reaproveita: nada é pago e a cota não é
 *    tocada. O mesmo texto guardado por OUTRA organização não conta — o caminho é
 *    sempre montado com a organização da sessão.
 *  - Não existe: gasta uma unidade da cota da organização (30 por hora,
 *    `consumirCotaDePrevia` em servico-de-falas.ts), chama a ElevenLabs UMA vez e
 *    grava o objeto.
 *  - O Storage falhou na leitura: `armazenamento`, SEM ir à ElevenLabs — o áudio
 *    pode estar guardado, e pagar de novo por ele é o que o hash existe para evitar.
 *  - NENHUMA linha de `phone_prompts` muda: as ligações seguem com o áudio salvo
 *    até o "Salvar e usar" (`salvarFala`, em falas.ts). A prévia que ninguém salva
 *    sai do Storage em 24 h, na limpeza do worker.
 *
 * Auditoria (`phone.prompt_previewed`, só a que foi à ElevenLabs — `reaproveitada`
 * diz qual) é da ROTA, que tem o ator e o request id.
 *
 * Além de `servico-de-falas.ts`, é o único módulo de `lib/telefonia/` que importa o
 * cliente da ElevenLabs. Nada do caminho da ligação o importa
 * (`tests/unit/ligacao-nunca-chama-elevenlabs.test.ts`).
 *
 * Storage, síntese e cota entram como portas: o teste troca as três.
 */
import type { PortaDoArmazem } from "./armazem";
import { ErroDaElevenLabs } from "./elevenlabs";
import { caminhoDaFala, hashDaFala, type VozDaOrganizacao } from "./falas";
import { duracaoDoUlawMs } from "./ulaw";
import type { FalhaDaFala } from "./vocabulario";

export type Sintetizador = (p: { chave: string; voiceId: string; modelId: string; texto: string }) => Promise<Uint8Array>;

export interface PedidoDePrevia {
  armazem: Pick<PortaDoArmazem, "baixar" | "enviar">;
  sintetizar: Sintetizador;
  /** Gasta uma unidade da cota; `false` = estourou. Chamada SÓ quando a prévia vai à ElevenLabs. */
  consumirCota: () => Promise<boolean>;
  /** A organização da SESSÃO — é com ela que o caminho do Storage é montado. */
  organizationId: string;
  texto: string;
  chave: string | null;
  voz: VozDaOrganizacao | null;
}

export type ResultadoDaPrevia =
  | { ok: true; hash: string; audio: Uint8Array; duracaoMs: number; reaproveitada: boolean }
  | { ok: false; motivo: FalhaDaFala };

export async function gerarPrevia(p: PedidoDePrevia): Promise<ResultadoDaPrevia> {
  const texto = p.texto.trim();
  if (!p.voz) return { ok: false, motivo: "sem_voz" };
  const { voiceId, modelId } = p.voz;
  const hash = hashDaFala(texto, voiceId, modelId);
  const caminho = caminhoDaFala(p.organizationId, hash);

  let guardado: Uint8Array | null;
  try {
    guardado = await p.armazem.baixar(caminho);
  } catch {
    return { ok: false, motivo: "armazenamento" };
  }
  if (guardado && guardado.length > 0) {
    return { ok: true, hash, audio: guardado, duracaoMs: Math.max(1, duracaoDoUlawMs(guardado.length)), reaproveitada: true };
  }

  // Daqui em diante a prévia custa crédito da conta do cliente.
  if (!p.chave) return { ok: false, motivo: "sem_chave" };
  if (!(await p.consumirCota())) return { ok: false, motivo: "limite_de_previas" };
  let audio: Uint8Array;
  try {
    audio = await p.sintetizar({ chave: p.chave, voiceId, modelId, texto });
  } catch (e) {
    return { ok: false, motivo: e instanceof ErroDaElevenLabs ? e.motivo : "erro_do_provedor" };
  }
  try {
    await p.armazem.enviar(caminho, audio);
  } catch {
    return { ok: false, motivo: "armazenamento" };
  }
  return { ok: true, hash, audio, duracaoMs: Math.max(1, duracaoDoUlawMs(audio.length)), reaproveitada: false };
}
