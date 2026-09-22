/**
 * Tira da mensagem do provedor o que não pode aparecer numa tela: segredo e
 * dado do titular. Trunca DEPOIS de redigir — cortar antes deixaria meia chave
 * passar, e meia chave ainda identifica de quem ela é.
 *
 * Os padrões de chave (`sk-…`, `Bearer …`) vêm daqui e não do
 * `lib/sentry/scrub.ts` porque lá o alvo é PII de titular; os dois se somam.
 *
 * Extraído de `lib/agent-engine/edge/llm/run-model-call.ts` (revisão da
 * Tarefa 2 do classificador comercial): aquele arquivo importa `ai` e `pg`, e
 * o cliente do Jev (`lib/classificador-comercial/jev.ts`) roda no worker só
 * por HTTP — importar `redigirMensagemDoProvedor` de lá puxaria as duas
 * dependências pesadas para dentro de um módulo que não precisa de nenhuma.
 * Comportamento idêntico ao de antes da extração; `run-model-call.ts` agora
 * importa daqui.
 */
import { scrubMessage } from "@/lib/sentry/scrub";

export function redigirMensagemDoProvedor(bruto: string): string {
  const semSegredo = bruto
    // Chaves de API dos provedores que este produto fala: `sk-ant-…`,
    // `sk-or-v1-…`, `sk-proj-…`, `sk-…`, e as do Google (`AIza…`).
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[CHAVE]")
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, "[CHAVE]")
    // O header inteiro, em qualquer caixa, com ou sem `Authorization:` na
    // frente — é assim que ele costuma aparecer ecoado num corpo de erro.
    .replace(/[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, "Bearer [CHAVE]")
    .replace(/(x-api-key|api[-_]?key|authorization)\s*[:=]\s*\S+/gi, "$1: [CHAVE]");
  return scrubMessage(semSegredo).slice(0, 500);
}
