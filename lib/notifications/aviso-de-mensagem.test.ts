import { describe, expect, it } from "vitest";

import {
  criarCacheComValidade,
  linhaDeContexto,
  nomeDoRemetente,
  previaDaMensagem,
  rotuloDaRajada,
  tituloParaBandeja,
} from "./aviso-de-mensagem";

describe("aviso de mensagem — quem, de onde, o quê", () => {
  it("QUEM: nome escolhido, depois o telefone; identificador técnico nunca", () => {
    expect(nomeDoRemetente({ display_name: "Maria Souza", name: "Maria" })).toBe("Maria Souza");
    expect(nomeDoRemetente({ display_name: "", name: null, phone_number: "+5532984793302" })).not.toBe(
      "Nova mensagem",
    );
    expect(nomeDoRemetente({ display_name: "543134@lid" })).toBe("Nova mensagem");
    expect(nomeDoRemetente(null)).toBe("Nova mensagem");
  });

  it("DE ONDE: o time e com quem a conversa está", () => {
    const eu = "u1";
    expect(linhaDeContexto({ time: "Suporte", atendente: "Ana Lima", assignedTo: "u2" }, eu)).toBe(
      "Suporte · com Ana",
    );
    expect(linhaDeContexto({ time: "Suporte", atendente: "Eu Mesmo", assignedTo: eu }, eu)).toBe(
      "Suporte · com você",
    );
    expect(linhaDeContexto({ time: null, atendente: null, assignedTo: null }, eu)).toBe("na fila");
    expect(linhaDeContexto({ time: "Financeiro", atendente: null, assignedTo: null }, eu)).toBe(
      "Financeiro · na fila",
    );
    // Sem dono humano, mas com a IA: não é fila — dizer "na fila" mandaria o
    // gestor assumir uma conversa que a IA está conduzindo.
    expect(linhaDeContexto({ time: "Suporte", atendente: null, assignedTo: null, comIa: true }, eu)).toBe(
      "Suporte · com a IA",
    );
    // Dono sem nome gravado: diz o time e não inventa "com undefined".
    expect(linhaDeContexto({ time: "Vendas", atendente: null, assignedTo: "u2" }, eu)).toBe("Vendas");
    expect(linhaDeContexto({ time: null, atendente: "  ", assignedTo: "u2" }, eu)).toBeNull();
  });

  it("traduz só os rótulos fixos, nunca o nome do time", () => {
    const t = (s: string) => ({ "na fila": "en la cola", "com você": "contigo" })[s] ?? s;
    expect(linhaDeContexto({ time: "Suporte", atendente: null, assignedTo: null }, "u1", t)).toBe(
      "Suporte · en la cola",
    );
  });

  it("O QUÊ: o texto; mídia por extenso, com a legenda quando houver", () => {
    expect(previaDaMensagem("text", "  quero o boleto ")).toBe("quero o boleto");
    expect(previaDaMensagem("text", "")).toBe("Nova mensagem");
    expect(previaDaMensagem("audio", null)).toBe("🎤 Áudio");
    expect(previaDaMensagem("image", "comprovante")).toBe("📷 Imagem · comprovante");
    expect(previaDaMensagem("tipo_novo", null)).toBe("Mídia");
  });

  it("bandeja: o time colado ao nome; sem time, só o nome", () => {
    expect(tituloParaBandeja("Maria", "Suporte")).toBe("Maria · Suporte");
    expect(tituloParaBandeja("Maria", null)).toBe("Maria");
  });

  it("rajada: contador só a partir da segunda", () => {
    expect(rotuloDaRajada(1)).toBeNull();
    expect(rotuloDaRajada(3)).toBe("3 mensagens");
  });
});

describe("cache com validade — o que impede o aviso de virar carga no banco", () => {
  it("devolve o guardado dentro da validade e esquece depois", () => {
    const c = criarCacheComValidade<number>(1000);
    c.gravar("a", 1, 0);
    expect(c.ler("a", 999)).toBe(1);
    expect(c.ler("a", 1000)).toBeUndefined();
  });

  it("não cresce sem limite: a entrada mais velha sai primeiro", () => {
    const c = criarCacheComValidade<number>(10_000, 2);
    c.gravar("a", 1, 0);
    c.gravar("b", 2, 0);
    c.gravar("c", 3, 0);
    expect(c.ler("a", 1)).toBeUndefined();
    expect(c.ler("c", 1)).toBe(3);
  });
});
