/**
 * DYD-15 e DYD-16 no canal oficial: o que o webhook da Meta faz com o status
 * de entrega e com a reação do cliente.
 *
 * O defeito do DYD-15 era uma linha: `e.status === "failed" ? "failed" : "sent"`.
 * `delivered` e `read` viravam `sent`, e a bolha nunca passava de um check.
 * Estes casos prendem o mapa inteiro, e a regra "só sobe, nunca desce" — a
 * Meta não garante a ordem das entregas.
 */
import { describe, expect, it } from "vitest";

import { planoDoStatus } from "@/lib/channels/meta/status-de-entrega";
import { parseMetaWebhook, type MessageStatusEvent } from "@/lib/channels/meta/webhook";
import { canalReage, CHANNEL_CAPABILITIES, PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";
import { getAdapter } from "@/lib/channels";
import { ehEmojiValido, reacoesDe } from "@/lib/messaging/reacoes";

const AGORA = new Date("2026-09-23T12:00:00.000Z");

function status(over: Partial<MessageStatusEvent>): MessageStatusEvent {
  return {
    kind: "message_status",
    wabaId: "w",
    externalId: "wamid.A",
    status: "sent",
    recipient: null,
    errorCode: null,
    errorTitle: null,
    errorDetail: null,
    at: null,
    ...over,
  };
}

describe("status de entrega do canal oficial (DYD-15)", () => {
  it("delivered vira delivered — dois checks — com o horário da Meta", () => {
    const at = new Date("2026-09-23T11:59:00.000Z");
    const p = planoDoStatus(status({ status: "delivered", at }), AGORA)!;
    expect(p.campos).toEqual({ status: "delivered", delivered_at: at.toISOString() });
    expect(p.deOnde).toEqual(["queued", "sending", "sent"]);
  });

  it("read vira read — dois checks azuis — e preenche o entregue que faltar", () => {
    const p = planoDoStatus(status({ status: "read" }), AGORA)!;
    expect(p.campos).toEqual({ status: "read", read_at: AGORA.toISOString() });
    expect(p.deOnde).toContain("delivered");
    expect(p.preencherEntregueSeVazio).toBe(AGORA.toISOString());
  });

  it("só sobe: sent atrasado não rebaixa delivered/read, delivered não rebaixa read", () => {
    expect(planoDoStatus(status({ status: "sent" }), AGORA)!.deOnde).not.toContain("delivered");
    expect(planoDoStatus(status({ status: "sent" }), AGORA)!.deOnde).not.toContain("read");
    expect(planoDoStatus(status({ status: "delivered" }), AGORA)!.deOnde).not.toContain("read");
  });

  it("failed guarda o código e o porquê — antes eram jogados fora", () => {
    const p = planoDoStatus(
      status({
        status: "failed",
        errorCode: 131047,
        errorTitle: "Re-engagement message",
        errorDetail: "Message failed to send because more than 24 hours have passed",
      }),
      AGORA,
    )!;
    expect(p.campos.status).toBe("failed");
    expect(p.campos.error_code).toBe("meta_131047");
    expect(p.campos.error_message).toContain("Re-engagement message");
    expect(p.campos.error_message).toContain("24 hours");
    // Falha não rebaixa mensagem já entregue.
    expect(p.deOnde).not.toContain("delivered");
  });

  it("status desconhecido não mexe na bolha", () => {
    expect(planoDoStatus(status({ status: "deleted" }), AGORA)).toBeNull();
  });

  it("o parser traz o horário e o detalhe do erro", () => {
    const [e] = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  {
                    id: "wamid.A",
                    status: "failed",
                    timestamp: "1790000000",
                    errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "janela" } }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(e).toMatchObject({ kind: "message_status", errorDetail: "janela" });
    expect((e as MessageStatusEvent).at?.getTime()).toBe(1790000000 * 1000);
  });
});

describe("reação do cliente no canal oficial (DYD-16)", () => {
  function envelope(reaction: Record<string, unknown>) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn1" },
                messages: [
                  { id: "wamid.R", from: "5531999999999", timestamp: "1790000000", type: "reaction", reaction },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it("vira inbound_reaction apontando a mensagem alvo — não uma mensagem nova", () => {
    const eventos = parseMetaWebhook(envelope({ message_id: "wamid.ALVO", emoji: "👍" }));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      kind: "inbound_reaction",
      targetExternalId: "wamid.ALVO",
      emoji: "👍",
      externalId: "wamid.R",
    });
  });

  it("tirar a reação chega sem emoji e vira emoji vazio", () => {
    const [e] = parseMetaWebhook(envelope({ message_id: "wamid.ALVO" }));
    expect(e).toMatchObject({ kind: "inbound_reaction", emoji: "" });
  });

  it("reação sem alvo é descartada — não vira linha meia-boca", () => {
    expect(parseMetaWebhook(envelope({ emoji: "👍" }))).toEqual([]);
  });
});

describe("reação: formato e canal", () => {
  it("reacoesDe lê os dois lados e ignora chave torta", () => {
    expect(reacoesDe({ reacoes: { contato: { emoji: "❤️" }, empresa: { emoji: "👍", user_id: "u" } } })).toEqual({
      contato: { emoji: "❤️" },
      empresa: { emoji: "👍", user_id: "u" },
    });
    expect(reacoesDe({ reacoes: { contato: { emoji: "" }, empresa: "x" } })).toEqual({});
    expect(reacoesDe(null)).toEqual({});
  });

  it.each(["👍", "❤️", "🙏🏽", "👨‍👩‍👧", "🇧🇷", "✅"])("aceita o emoji %s", (e) => {
    expect(ehEmojiValido(e)).toBe(true);
  });

  it.each(["ok", "", "👍 ok", "a", "<b>", "1"])("recusa %j (texto não é reação)", (e) => {
    expect(ehEmojiValido(e)).toBe(false);
  });

  it("capability `reacoes` e o método do adapter andam juntos", () => {
    for (const p of PROVIDERS_DE_MENSAGEM) {
      expect(
        Boolean(getAdapter(p).sendReaction),
        `${p}: reacoes=${CHANNEL_CAPABILITIES[p].reacoes} sem casar com sendReaction`,
      ).toBe(CHANNEL_CAPABILITIES[p].reacoes);
    }
  });

  it("canalReage: só o oficial; desconhecido/voz/nulo é false", () => {
    expect(canalReage("meta_cloud")).toBe(true);
    for (const p of ["waha", "zernio", "site_widget", "wacalls", "telegram", null, undefined]) {
      expect(canalReage(p as string | null)).toBe(false);
    }
  });
});
