/**
 * FALAR PRIMEIRO — abrir a conversa com quem nunca escreveu, e mandar a primeira
 * mensagem.
 *
 * ─── Por que existe, tendo as duas peças prontas ────────────────────────────
 *
 * A composição "abre a conversa + envia" já existia, escrita à mão dentro da
 * tool MCP `crm_start_conversation_and_send`. Quando a TELA passou a precisar do
 * mesmo ato, havia duas saídas: repetir a composição do lado do cliente (duas
 * chamadas HTTP, e a tela decidindo o que fazer quando a segunda falha) ou
 * extrair a que já existe. A doutrina DIRC manda **Referenciar**, e a razão é
 * concreta: a segunda cópia divergiria no primeiro estado novo que alguém
 * tratasse — e o estado novo já está aqui, é o template.
 *
 * Nada de envio é reimplementado. `sendMessageHandler` continua sendo o único
 * caminho de saída do sistema, com as mesmas guardas (bloqueio, opt-out, janela,
 * pré-voo do modelo, boundary de atendimento).
 *
 * ─── A conversa SOBREVIVE ao envio que falhou ───────────────────────────────
 *
 * Este é o ponto de desenho que o resultado discriminado existe para expressar,
 * e ele não é cosmético.
 *
 * `openSharedContactConversation` → `ensureConversation` → `fn_service_begin`
 * **abre um atendimento** e escreve na linha do tempo do contato. Quando o envio
 * falha depois disso — modelo com parâmetro faltando, definição obsoleta, canal
 * sem credencial —, apagar a conversa apagaria esse rastro e faria o operador
 * recomeçar do zero sem saber que já tinha tentado.
 *
 * Mantê-la é também o comportamento certo de produto: a conversa aparece no
 * inbox, o operador lê o motivo real da recusa e tenta de novo dali, que é onde
 * o seletor de modelos mora. Por isso `envio` é um resultado, não uma exceção:
 * quem chama recebe **as duas notícias** e decide o que contar.
 *
 * Quem prefere a exceção (a tool MCP, cujo contrato sempre foi "deu certo ou
 * lançou") relança olhando `envio.ok` — uma linha, e o comportamento de lá fica
 * idêntico ao de antes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import { sendMessageSchema, type SendMessageInput } from "@/lib/schemas/messaging";
import type { Message } from "@/lib/types/messaging";

/** A mensagem de abertura, sem `conversation_id` — ela ainda não existe. */
export type MensagemDeAbertura = Omit<SendMessageInput, "conversation_id">;

export interface IniciarConversaInput {
  /**
   * A conexão de onde a mensagem sai.
   *
   * Opcional: quando ausente, `openSharedContactConversation` escolhe a primeira
   * viva (`sessaoProntaParaEnvio`). A tela SEMPRE manda — o operador escolheu na
   * hora, e deixar o sistema escolher por ele faria a mensagem sair por um
   * número que o cliente não conhece.
   */
  channel_session_id?: string;
  contact_id?: string;
  phone_number?: string;
  /** Só usado se um cadastro novo precisar ser criado. */
  name?: string;
  mensagem: MensagemDeAbertura;
}

export interface IniciarConversaResultado {
  contact_id: string;
  conversation_id: string;
  envio:
    | { ok: true; message: Message }
    /** `motivo` é a frase acionável do handler — é ela que o operador lê. */
    | { ok: false; motivo: string };
}

/**
 * @throws só quando a CONVERSA não pôde ser aberta (`contact_not_found`,
 *   `session_not_found`, `invalid_phone`). Falha de ENVIO volta em
 *   `envio.ok === false` — ver o cabeçalho.
 */
export async function iniciarConversaEEnviar(
  db: SupabaseClient,
  ctx: HandlerCtx,
  input: IniciarConversaInput,
): Promise<IniciarConversaResultado> {
  const aberta = await openSharedContactConversation(db, ctx.organization_id, {
    channel_session_id: input.channel_session_id,
    contact_id: input.contact_id,
    phone_number: input.phone_number,
    name: input.name,
  });

  // Reparseia com o `conversation_id` já resolvido: é o mesmo schema que a rota
  // de envio usa, então um corpo inválido é recusado aqui pelas MESMAS regras —
  // e não adiante, com metade do payload montado.
  const parsed = sendMessageSchema.parse({
    ...input.mensagem,
    conversation_id: aberta.conversation_id,
  });

  try {
    const message = await sendMessageHandler(db, ctx, parsed);
    return { ...aberta, envio: { ok: true, message } };
  } catch (err) {
    return {
      ...aberta,
      envio: { ok: false, motivo: err instanceof Error ? err.message : "envio_falhou" },
    };
  }
}
