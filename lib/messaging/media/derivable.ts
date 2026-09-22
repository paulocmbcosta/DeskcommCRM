/**
 * Tipos de mensagem cujo conteúdo vira TEXTO antes de o agente responder
 * (áudio → transcrição, imagem → descrição, documento → extração).
 *
 * Vive fora do worker porque duas peças precisam da MESMA resposta e não podem
 * discordar: o worker que deriva e o drain que decide se vale esperar a
 * derivação antes de despachar o turno. Duas listas separadas divergiriam no
 * primeiro tipo novo, e o sintoma seria o agente respondendo "não consigo
 * ouvir" só para um formato.
 */
export const TIPOS_DERIVAVEIS: ReadonlySet<string> = new Set([
  "audio",
  "image",
  "document",
  "video",
]);

/** Estados finais de `messages.media_derived_status` — não há o que esperar. */
export const DERIVACAO_TERMINADA: ReadonlySet<string> = new Set(["ready", "failed"]);

/**
 * O texto que substitui a string vazia quando a mídia não pôde ser lida
 * (`workers/media-derive-worker.ts` o grava como derivado, com status `ready`).
 *
 * Não é cosmético: o agente recebe este texto como derivado da mensagem, então
 * ele passa a SABER que chegou algo que não conseguiu interpretar, em vez de
 * concluir que a mensagem veio vazia. A diferença aparece na resposta ao
 * cliente — "não consegui abrir sua foto, pode me dizer o que é?" no lugar de
 * um silêncio que parece descaso.
 *
 * Mora aqui, e não no worker, pelo mesmo motivo das duas listas acima: há mais
 * de um leitor. O classificador comercial (`lib/classificador-comercial/dados.ts`)
 * precisa reconhecê-lo para NÃO o tratar como fala do cliente.
 */
export const MARCADOR_NAO_LIDA = "[o cliente enviou uma mídia que não consegui interpretar]";
