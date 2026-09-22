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
 *
 * CORREÇÃO DE SEGURANÇA (re-revisão da Tarefa 2, 22/09/2026): as 4 regexes
 * abaixo, na `origin/main` desde o commit `2889421d` (08/08/2026), tinham um
 * BYTE LITERAL 0x08 (backspace) onde deveria haver o ESCAPE `\b` (fronteira
 * de palavra) — provavelmente um caractere de controle colado sem querer ao
 * editar. Um byte 0x08 cru num texto de erro real é praticamente impossível
 * de ocorrer, então NENHUMA das 4 regexes jamais casou nada em produção: a
 * redação de chave estava morta desde aquele commit, e uma chave ecoada pelo
 * provedor ia inteira para `llm_calls.error_message` — visível em IA ›
 * Execuções para qualquer `manager` da organização (ver
 * `.changes/redacao-de-chave-nas-execucoes.md`). A extração para este módulo
 * copiou o texto visível (sem o byte invisível) mas não repôs o `\b`, o que
 * trocou "nunca casa" por "casa até no meio da palavra" (`"task-abcdefgh12"`
 * virava `"ta[CHAVE]"`) — também errado, só que na direção oposta. As duas
 * pontas ficaram cobertas por `tests/unit/redigir-mensagem-do-provedor.test.ts`.
 */
import { scrubMessage } from "@/lib/sentry/scrub";

export function redigirMensagemDoProvedor(bruto: string): string {
  const semSegredo = bruto
    // Chaves de API dos provedores que este produto fala: `sk-ant-…`,
    // `sk-or-v1-…`, `sk-proj-…`, `sk-…`, e as do Google (`AIza…`).
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[CHAVE]")
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, "[CHAVE]")
    // O header inteiro, em qualquer caixa, com ou sem `Authorization:` na
    // frente — é assim que ele costuma aparecer ecoado num corpo de erro.
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, "Bearer [CHAVE]")
    .replace(/\b(x-api-key|api[-_]?key|authorization)\b\s*[:=]\s*\S+/gi, "$1: [CHAVE]");
  return scrubMessage(semSegredo).slice(0, 500);
}
