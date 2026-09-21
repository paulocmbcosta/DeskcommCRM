import { beforeEach, describe, expect, it, vi } from "vitest";

import { BancoEmMemoria } from "./helpers/banco-em-memoria";

/**
 * INGESTÃO DO CHAT DO SITE — o que um navegador ANÔNIMO consegue gravar.
 *
 * Os outros três canais recebem evento de uma plataforma que já autenticou quem
 * fala. Este recebe `fetch` do site de um terceiro: tudo o que o visitante
 * declara é afirmação sem prova, e a rota é alcançável por qualquer um que leia
 * o HTML do cliente. Por isso metade dos casos abaixo prova o que a ingestão
 * RECUSA ou NÃO FAZ — é onde mora o risco.
 *
 * O dublê aplica os filtros de verdade (`helpers/banco-em-memoria`): um caso que
 * passa aqui afirma "com estes dados no banco, isto é o que se lê e se grava".
 */

const efeitos = vi.fn(async (_admin: unknown, _entrada: unknown) => undefined);
const marcar = vi.fn(async (_admin: unknown, _args: unknown) => undefined);

vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: (admin: unknown, entrada: unknown) => efeitos(admin, entrada),
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: (admin: unknown, args: unknown) => marcar(admin, args),
}));

const { conversaDoVisitante, ingerirMensagemDoVisitante, MEIO_CHAT_DO_SITE } = await import(
  "@/lib/channels/chat-do-site/entrada"
);
const { threadDoVisitante, tokenDoVisitanteTemForma } = await import("@/lib/channels/chat-do-site/identidade");
const { CONFIG_PADRAO_DO_WIDGET } = await import("@/lib/channels/chat-do-site/config");

const ORG = "org-a";
const CANAL = { id: "canal-a", organizationId: ORG, nome: "Site", config: CONFIG_PADRAO_DO_WIDGET, ultimoSinal: null };
const UUID = "3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f";

let banco: BancoEmMemoria;
const admin = () => banco.cliente as never;

beforeEach(() => {
  banco = new BancoEmMemoria()
    .unico("contacts", "organization_id", "phone_number")
    .unico("contacts", "organization_id", "email")
    .unico("messages", "organization_id", "external_id");
  efeitos.mockClear();
  marcar.mockClear();
});

describe("visitante novo", () => {
  it("cria contato, conversa e mensagem — e devolve o token UMA vez", async () => {
    const r = await ingerirMensagemDoVisitante(admin(), {
      canal: CANAL,
      token: null,
      clientMessageId: UUID,
      texto: "Oi, quero um orçamento",
      visitante: { nome: "Marina", email: "Marina@Exemplo.com", telefone: "(11) 98888-7777" },
      pagina: { url: "https://loja.exemplo.com/planos", titulo: "Planos" },
    });

    expect(r.status).toBe("ingested");
    if (r.status === "token_desconhecido") throw new Error("inesperado");
    expect(tokenDoVisitanteTemForma(r.tokenNovo)).toBe(true);

    const [contato] = banco.linhas("contacts");
    expect(contato).toMatchObject({
      organization_id: ORG,
      name: "Marina",
      display_name: "Marina",
      email: "marina@exemplo.com",
      phone_number: "+5511988887777",
      source: "site_chat",
    });

    const [conversa] = banco.linhas("conversations");
    expect(conversa).toMatchObject({
      organization_id: ORG,
      channel_session_id: "canal-a",
      channel: MEIO_CHAT_DO_SITE,
      status: "open",
    });

    const [mensagem] = banco.linhas("messages");
    expect(mensagem).toMatchObject({
      organization_id: ORG,
      direction: "inbound",
      type: "text",
      body: "Oi, quero um orçamento",
      external_id: `site:${UUID}`,
      // O default da coluna (`crm`) mentiria: os painéis de atrito contam por este valor.
      sent_via: "external_device",
    });
  });

  it("o banco guarda o HASH do token, nunca o token", async () => {
    const r = await ingerirMensagemDoVisitante(admin(), {
      canal: CANAL,
      token: null,
      clientMessageId: UUID,
      texto: "oi",
    });
    if (r.status === "token_desconhecido" || !r.tokenNovo) throw new Error("inesperado");

    const thread = banco.linhas("conversations")[0]?.provider_conversation_id as string;
    expect(thread).toBe(threadDoVisitante(r.tokenNovo));

    // Anti-pattern 13 do CLAUDE.md, medido: nenhuma coluna de nenhuma linha
    // gravada contém o segredo em claro.
    const tudo = JSON.stringify([...banco.tabelas.values()]);
    expect(tudo).not.toContain(r.tokenNovo);
  });

  it("sem nome, ganha um apelido que distingue um visitante do outro", async () => {
    await ingerirMensagemDoVisitante(admin(), { canal: CANAL, token: null, clientMessageId: UUID, texto: "oi" });
    const apelido = banco.linhas("contacts")[0]?.display_name as string;
    // "Sem nome" em dez conversas iguais é o que isto evita.
    expect(apelido).toMatch(/^Visitante [0-9A-F]{4}$/);
  });

  it("os efeitos de negócio são os MESMOS dos outros canais, com os ids certos", async () => {
    await ingerirMensagemDoVisitante(admin(), {
      canal: CANAL,
      token: null,
      clientMessageId: UUID,
      texto: "quero sair da lista",
      visitante: { nome: "Rui" },
      requestId: "req-1",
    });
    expect(efeitos).toHaveBeenCalledTimes(1);
    expect(efeitos.mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG,
      contactId: banco.linhas("contacts")[0]?.id,
      conversationId: banco.linhas("conversations")[0]?.id,
      messageId: banco.linhas("messages")[0]?.id,
      channelSessionId: "canal-a",
      texto: "quero sair da lista",
      nomeDoContato: "Rui",
      origem: "site_chat",
    });
    // `last_inbound_at` é a fonte da fila e do SLA: sem o carimbo, a conversa
    // aparece no inbox como se ninguém tivesse escrito.
    expect(marcar.mock.calls[0]?.[1]).toMatchObject({ direction: "inbound", conversationId: banco.linhas("conversations")[0]?.id });
  });
});

describe("o que o visitante DECLARA não é identidade", () => {
  it("telefone que já é de outro contato NÃO funde: nasce contato novo, sem o telefone", async () => {
    banco.semear("contacts", {
      id: "cliente-real",
      organization_id: ORG,
      name: "Cliente de verdade",
      phone_number: "+5511988887777",
    });

    await ingerirMensagemDoVisitante(admin(), {
      canal: CANAL,
      token: null,
      clientMessageId: UUID,
      texto: "sou o cliente, me manda minha fatura",
      visitante: { nome: "Impostor", telefone: "11 98888-7777" },
    });

    const contatos = banco.linhas("contacts");
    expect(contatos).toHaveLength(2);
    const novo = contatos.find((c) => c.id !== "cliente-real");
    // Se o ingest procurasse o contato pelo telefone digitado, o atendente
    // veria a ficha (e a fatura do ERP) do cliente real ao lado de quem só
    // sabia o número dele.
    expect(novo?.phone_number ?? null).toBeNull();
    expect(novo?.source_metadata).toMatchObject({ telefone_informado_nao_verificado: "+5511988887777" });
    expect(banco.linhas("conversations")[0]?.contact_id).toBe(novo?.id);
    // E o contato real não foi tocado.
    expect(contatos.find((c) => c.id === "cliente-real")).toMatchObject({ name: "Cliente de verdade" });
  });

  it("e-mail que já é de outro contato também não funde", async () => {
    banco.semear("contacts", { id: "c0", organization_id: ORG, email: "ana@exemplo.com" });
    await ingerirMensagemDoVisitante(admin(), {
      canal: CANAL,
      token: null,
      clientMessageId: UUID,
      texto: "oi",
      visitante: { email: "ana@exemplo.com", telefone: "11 97777-6666" },
    });
    const novo = banco.linhas("contacts").find((c) => c.id !== "c0");
    expect(novo?.email ?? null).toBeNull();
    // O que ERA livre continua gravado: perder o telefone por causa do e-mail
    // tiraria do follow-up o único jeito de alcançar o visitante depois.
    expect(novo?.phone_number).toBe("+5511977776666");
    expect(novo?.source_metadata).toMatchObject({ email_informado_nao_verificado: "ana@exemplo.com" });
  });

  it("e-mail malformado é descartado em vez de derrubar a mensagem", async () => {
    const r = await ingerirMensagemDoVisitante(admin(), {
      canal: CANAL,
      token: null,
      clientMessageId: UUID,
      texto: "oi",
      visitante: { email: "não é e-mail" },
    });
    expect(r.status).toBe("ingested");
    expect(banco.linhas("contacts")[0]?.email ?? null).toBeNull();
  });
});

describe("visitante que volta (token)", () => {
  async function abrir(): Promise<string> {
    const r = await ingerirMensagemDoVisitante(admin(), { canal: CANAL, token: null, clientMessageId: UUID, texto: "1" });
    if (r.status === "token_desconhecido" || !r.tokenNovo) throw new Error("inesperado");
    return r.tokenNovo;
  }

  it("continua na MESMA conversa, sem criar contato nem conversa", async () => {
    const token = await abrir();
    const r = await ingerirMensagemDoVisitante(admin(), {
      canal: CANAL,
      token,
      clientMessageId: "11111111-2222-4333-8444-555555555555",
      texto: "2",
      // Dados declarados numa conversa que já existe são IGNORADOS: senão o
      // visitante reescreveria o cadastro a cada mensagem.
      visitante: { nome: "Outro nome" },
    });
    expect(r.status).toBe("ingested");
    if (r.status === "token_desconhecido") throw new Error("inesperado");
    expect(r.tokenNovo).toBeNull();
    expect(banco.linhas("contacts")).toHaveLength(1);
    expect(banco.linhas("conversations")).toHaveLength(1);
    expect(banco.linhas("messages")).toHaveLength(2);
  });

  it("reenvio do mesmo client_message_id é `duplicate`, e não devolve corpo de linha nenhuma", async () => {
    const token = await abrir();
    const r = await ingerirMensagemDoVisitante(admin(), { canal: CANAL, token, clientMessageId: UUID, texto: "1" });
    expect(r).toMatchObject({ status: "duplicate", mensagem: null });
    expect(banco.linhas("messages")).toHaveLength(1);
    // Reentrega não acorda o agente de novo nem soma não-lida.
    expect(efeitos).toHaveBeenCalledTimes(1);
    expect(marcar).toHaveBeenCalledTimes(1);
  });

  it("token que não abre conversa nenhuma → `token_desconhecido`, e NADA é gravado", async () => {
    const r = await ingerirMensagemDoVisitante(admin(), {
      canal: CANAL,
      token: "wv_" + "a".repeat(43),
      clientMessageId: UUID,
      texto: "oi",
    });
    expect(r.status).toBe("token_desconhecido");
    expect(banco.escritas).toHaveLength(0);
  });

  it("o token de um widget não abre conversa de OUTRO widget", async () => {
    const token = await abrir();
    const outroCanal = { ...CANAL, id: "canal-b" };
    expect(await conversaDoVisitante(admin(), outroCanal, token)).toBeNull();
    expect(await conversaDoVisitante(admin(), CANAL, token)).not.toBeNull();
  });

  it("nem de outra ORGANIZAÇÃO, mesmo com o id do canal igual", async () => {
    const token = await abrir();
    const outraOrg = { ...CANAL, organizationId: "org-b" };
    // O filtro de tenant é o que segura isto: o client é service role e bypassa RLS.
    expect(await conversaDoVisitante(admin(), outraOrg, token)).toBeNull();
  });

  it("thread apagada (anonimização LGPD) fecha a porta: o mesmo token vira desconhecido", async () => {
    const token = await abrir();
    const { revogarAcessoDoVisitante } = await import("@/lib/channels/chat-do-site/revogar");
    const contactId = banco.linhas("contacts")[0]?.id as string;

    const revogadas = await revogarAcessoDoVisitante(admin(), { organizationId: ORG, contactId });
    expect(revogadas).toBe(1);
    expect(await conversaDoVisitante(admin(), CANAL, token)).toBeNull();
    // Idempotente: a segunda passada da cascata não acha nada para revogar.
    expect(await revogarAcessoDoVisitante(admin(), { organizationId: ORG, contactId })).toBe(0);
  });

  it("revogar NÃO toca na thread de uma conversa de WhatsApp do mesmo contato", async () => {
    banco.semear("conversations", {
      id: "conv-wa",
      organization_id: ORG,
      contact_id: "c9",
      channel: "whatsapp",
      provider_conversation_id: "thread-do-provedor",
    });
    const { revogarAcessoDoVisitante } = await import("@/lib/channels/chat-do-site/revogar");
    expect(await revogarAcessoDoVisitante(admin(), { organizationId: ORG, contactId: "c9" })).toBe(0);
    // Naquele canal a thread é ENDEREÇO DE ENVIO: apagá-la calaria o canal.
    expect(banco.linhas("conversations")[0]?.provider_conversation_id).toBe("thread-do-provedor");
  });
});
