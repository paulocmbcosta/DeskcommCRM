import { describe, expect, it } from "vitest";

import { montarPayloadDeInbound, pushDeveMostrarBandeja, truncar } from "./push_payload";

describe("push_payload", () => {
  it("trunca corpo longo", () => {
    expect(truncar("a".repeat(141)).endsWith("…")).toBe(true);
    expect(truncar("oi").length).toBe(2);
  });

  it("monta título com marca e href da conversa", () => {
    const p = montarPayloadDeInbound({
      brand: "Clínica",
      conversationId: "c1",
      preview: "olá",
    });
    expect(p.title).toBe("Nova mensagem");
    expect(p.href).toBe("/app/inbox?id=c1");
    expect(p.tag).toBe("msg:c1");
    expect(p.body).toBe("olá");
  });

  it("usa o nome do contato no título quando informado", () => {
    const p = montarPayloadDeInbound({
      brand: "Clínica",
      conversationId: "c1",
      preview: "olá",
      contactName: "Maria",
    });
    expect(p.title).toBe("Maria");
  });

  it("põe o time no título, colado ao nome — é o que o olho lê primeiro", () => {
    const base = { brand: "Clínica", conversationId: "c1", preview: "olá" };
    expect(montarPayloadDeInbound({ ...base, contactName: "Maria", teamName: "Suporte" }).title).toBe(
      "Maria · Suporte",
    );
    expect(montarPayloadDeInbound({ ...base, teamName: "Suporte" }).title).toBe("Nova mensagem · Suporte");
    expect(montarPayloadDeInbound({ ...base, contactName: "Maria", teamName: "  " }).title).toBe("Maria");
  });

  it("só mostra bandeja via push quando nenhum cliente está visível", () => {
    expect(pushDeveMostrarBandeja(0)).toBe(true);
    expect(pushDeveMostrarBandeja(1)).toBe(false);
  });
});
