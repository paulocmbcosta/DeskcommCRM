/**
 * A PRÉVIA DE UMA FALA — a ÚNICA hora em que a ElevenLabs é chamada (desenho da
 * fase 2, D15 e §4, passo 1). Server-only.
 *
 *  - Voz fora do formato da ElevenLabs (`ID_DE_VOZ`) ou texto inválido (vazio, mais
 *    de 1000 caracteres, NUL — `textoDaFalaValido`) param AQUI, antes de ler o
 *    Storage, de gastar cota e de chamar a ElevenLabs.
 *  - hash = sha256(modelo, voz, texto) (`hashDaFala`). O objeto `<org>/<hash>.ulaw`
 *    já existe no Storage DA ORGANIZAÇÃO? Reaproveita: nada é pago e a cota não é
 *    tocada. O mesmo texto guardado por OUTRA organização não conta — o caminho é
 *    sempre montado com a organização da sessão.
 *  - Não existe: gasta uma unidade da cota da organização (30 por hora,
 *    `consumirCotaDePrevia` em servico-de-falas.ts), chama a ElevenLabs UMA vez e
 *    grava o objeto SEM sobrescrever. Se outra prévia do mesmo texto gravou antes
 *    (`"ja_existia"`), a resposta leva o áudio GUARDADO, e não o desta síntese: o
 *    que a pessoa ouve é sempre o que as ligações vão tocar.
 *  - A síntese foi paga e o áudio não ficou guardado: `armazenamento` com
 *    `paga: true`, para a rota auditar o gasto e dizer "a fala foi gerada, mas não
 *    foi guardada; tente de novo".
 *  - O Storage falhou na leitura: `armazenamento`, SEM ir à ElevenLabs — o áudio
 *    pode estar guardado, e pagar de novo por ele é o que o hash existe para evitar.
 *  - NENHUMA linha de `phone_prompts` muda: as ligações seguem com o áudio salvo
 *    até o "Salvar e usar" (`salvarFala`, em falas.ts). A prévia que ninguém salva
 *    sai do Storage em 24 h, na limpeza do worker.
 *
 * Auditoria (`phone.prompt_previewed`, só a que foi à ElevenLabs — `reaproveitada`
 * e `paga` dizem qual) é da ROTA, que tem o ator e o request id. Toda falha do
 * Storage vai para o log com a etapa e a causa; nunca o áudio, o texto nem a chave.
 *
 * Além de `servico-de-falas.ts`, é o único módulo de `lib/telefonia/` que importa o
 * cliente da ElevenLabs. Nada do caminho da ligação o importa
 * (`tests/unit/ligacao-nunca-chama-elevenlabs.test.ts`).
 *
 * Storage, síntese e cota entram como portas: o teste troca as três.
 */
import { logger } from "@/lib/logger";

import type { PortaDoArmazem } from "./armazem";
import { ErroDaElevenLabs } from "./elevenlabs";
import { caminhoDaFala, hashDaFala, textoDaFalaValido, type VozDaOrganizacao } from "./falas";
import { duracaoDoUlawMs } from "./ulaw";
import { ID_DE_VOZ, type FalhaDaFala } from "./vocabulario";

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
  /** `paga: true` = a ElevenLabs cobrou esta síntese, mas o áudio não ficou guardado. */
  | { ok: false; motivo: FalhaDaFala; paga?: true };

type EtapaDoStorage = "ler_storage" | "gravar_storage" | "reler_storage";

/** A falha do Storage no log: a etapa e a causa (o texto da porta), nunca bytes, texto ou chave. */
function registrarFalhaDoStorage(etapa: EtapaDoStorage, organizationId: string, e: unknown): void {
  logger.error("[telefonia] prévia da fala: o Storage falhou", {
    etapa,
    organization_id: organizationId,
    causa: e instanceof Error ? e.message.slice(0, 300) : "desconhecida",
  });
}

const comDuracao = (audio: Uint8Array) => Math.max(1, duracaoDoUlawMs(audio.length));

export async function gerarPrevia(p: PedidoDePrevia): Promise<ResultadoDaPrevia> {
  const texto = p.texto.trim();
  if (!p.voz) return { ok: false, motivo: "sem_voz" };
  const { voiceId, modelId } = p.voz;
  // As réguas que a ElevenLabs aplicaria DEPOIS de cobrar a cota: aqui, antes.
  if (!ID_DE_VOZ.test(voiceId)) return { ok: false, motivo: "voz_inexistente" };
  if (!textoDaFalaValido(texto)) return { ok: false, motivo: "texto_recusado" };
  const hash = hashDaFala(texto, voiceId, modelId);
  const caminho = caminhoDaFala(p.organizationId, hash);

  let guardado: Uint8Array | null;
  try {
    guardado = await p.armazem.baixar(caminho);
  } catch (e) {
    registrarFalhaDoStorage("ler_storage", p.organizationId, e);
    return { ok: false, motivo: "armazenamento" };
  }
  if (guardado && guardado.length > 0) {
    return { ok: true, hash, audio: guardado, duracaoMs: comDuracao(guardado), reaproveitada: true };
  }

  // Daqui em diante a prévia custa crédito da conta do cliente.
  if (!p.chave) return { ok: false, motivo: "sem_chave" };
  if (!(await p.consumirCota())) return { ok: false, motivo: "limite_de_previas" };
  let audio: Uint8Array;
  try {
    audio = await p.sintetizar({ chave: p.chave, voiceId, modelId, texto });
  } catch (e) {
    if (e instanceof ErroDaElevenLabs) return { ok: false, motivo: e.motivo };
    // Só a classe: a mensagem de um erro inesperado pode carregar a requisição.
    logger.error("[telefonia] prévia da fala: a síntese falhou fora do cliente", {
      etapa: "sintetizar",
      organization_id: p.organizationId,
      classe: e instanceof Error ? e.name : "desconhecida",
    });
    return { ok: false, motivo: "erro_do_provedor" };
  }

  // A partir daqui a síntese está PAGA: toda falha diz isso à rota.
  let envio: "gravado" | "ja_existia";
  try {
    envio = await p.armazem.enviar(caminho, audio);
  } catch (e) {
    registrarFalhaDoStorage("gravar_storage", p.organizationId, e);
    return { ok: false, motivo: "armazenamento", paga: true };
  }
  if (envio === "ja_existia") {
    // Outra prévia do mesmo texto gravou antes: o áudio que vale é o guardado.
    try {
      guardado = await p.armazem.baixar(caminho);
    } catch (e) {
      registrarFalhaDoStorage("reler_storage", p.organizationId, e);
      return { ok: false, motivo: "armazenamento", paga: true };
    }
    if (!guardado || guardado.length === 0) {
      registrarFalhaDoStorage("reler_storage", p.organizationId, new Error("objeto ausente ou vazio depois do conflito"));
      return { ok: false, motivo: "armazenamento", paga: true };
    }
    audio = guardado;
  }
  return { ok: true, hash, audio, duracaoMs: comDuracao(audio), reaproveitada: false };
}
