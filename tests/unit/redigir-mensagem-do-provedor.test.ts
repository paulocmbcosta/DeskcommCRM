import { describe, expect, it } from "vitest";

import { redigirMensagemDoProvedor } from "@/lib/ai/redigir-mensagem-do-provedor";

describe("redigirMensagemDoProvedor", () => {
  it("redige chave sk-... ecoada pelo provedor", () => {
    const chave = "sk-or-v1-abcdef0123456789";
    const bruto = `Incorrect API key provided: ${chave}`;
    const saida = redigirMensagemDoProvedor(bruto);
    expect(saida).toContain("[CHAVE]");
    expect(saida).not.toContain(chave);
  });

  it("redige chave sk-ant-... ecoada pelo provedor", () => {
    const chave = "sk-ant-api03-abcdef0123456789";
    const bruto = `authentication_error: ${chave} is invalid`;
    const saida = redigirMensagemDoProvedor(bruto);
    expect(saida).toContain("[CHAVE]");
    expect(saida).not.toContain(chave);
  });

  it("redige chave AIza... (Google) ecoada pelo provedor", () => {
    const chave = "AIzaSyAbcdefGhijklmnopqrstuvwxyz01234";
    const bruto = `API key not valid: ${chave}`;
    const saida = redigirMensagemDoProvedor(bruto);
    expect(saida).toContain("[CHAVE]");
    expect(saida).not.toContain(chave);
  });

  it("redige o header 'Bearer <token>' inteiro, em qualquer caixa, mesmo com um token que não bate nenhum padrão de chave", () => {
    const token = "abcdefgh12345678"; // não começa com sk-/AIza
    const bruto = `bearer ${token}`;
    const saida = redigirMensagemDoProvedor(bruto);
    // A substituição normaliza a caixa (sempre "Bearer [CHAVE]"), por desenho —
    // não é o que esta revisão mudou; só o `\b` antes é o que importa aqui.
    expect(saida).toBe("Bearer [CHAVE]");
  });

  it("redige o header api_key=... (query/header ecoado no corpo)", () => {
    const bruto = "falha: api_key=abcdef0123456789xyz na requisição";
    const saida = redigirMensagemDoProvedor(bruto);
    expect(saida).toContain("[CHAVE]");
    expect(saida).not.toContain("abcdef0123456789xyz");
  });

  // A revisão de qualidade achou: a extração perdeu o `\b` (word boundary) das
  // 4 regexes — na origin/main (desde 2889421d) elas tinham um BYTE 0x08
  // literal onde deveria haver o ESCAPE `\b`, então NUNCA casavam nada (a
  // redação de chave estava morta em produção). A extração corrigiu o byte
  // mas não repôs o `\b`, e a regex passou a casar NO MEIO da palavra — as
  // duas próximas provam que isso está corrigido, não só que "algo" é redigido.
  it("NÃO redige 'task-abcdefgh12' — 'sk-' no meio de uma palavra não é uma chave solta", () => {
    expect(redigirMensagemDoProvedor("id do job: task-abcdefgh12")).toBe("id do job: task-abcdefgh12");
  });

  it("NÃO redige 'risk-assessment0' — mesma razão, outra palavra que contém 'sk-'", () => {
    expect(redigirMensagemDoProvedor("relatório risk-assessment0 pendente")).toBe("relatório risk-assessment0 pendente");
  });

  it("redige CPF (dado do titular, via scrubMessage)", () => {
    const saida = redigirMensagemDoProvedor("cliente com CPF 123.456.789-09 recusado");
    expect(saida).toContain("[CPF]");
    expect(saida).not.toContain("123.456.789-09");
  });

  it("redige e-mail (dado do titular, via scrubMessage)", () => {
    const saida = redigirMensagemDoProvedor("contato: maria@example.com não autorizado");
    expect(saida).toContain("[EMAIL]");
    expect(saida).not.toContain("maria@example.com");
  });

  it("não deixa nenhum byte 0x08 literal no próprio arquivo-fonte — a origem do defeito original", () => {
    // Prova em runtime que o módulo não regrediu para o bug antigo: o ARQUIVO
    // não pode conter o byte de backspace onde deveria haver `\b` de verdade.
    // (Também conferido fora do teste: `LC_ALL=C grep -c $'\x08' lib/ai/redigir-mensagem-do-provedor.ts`.)
    expect(redigirMensagemDoProvedor.toString()).not.toMatch(/[\x08]/);
  });
});
