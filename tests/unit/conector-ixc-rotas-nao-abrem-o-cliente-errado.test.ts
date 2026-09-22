/**
 * AS ROTAS DO IXC NÃO ABREM — NEM COBRAM — O CLIENTE ERRADO.
 *
 * O navegador manda dois ids que ele poderia inventar: o do CADASTRO a vincular
 * e o da FATURA a enviar. Se a rota confiar neles:
 *
 *   - um `agent` vincula qualquer contato a qualquer cadastro do ERP e abre o
 *     financeiro de quem quiser;
 *   - um `agent` manda a cobrança do cliente A para o WhatsApp do cliente B — com
 *     valor, vencimento e boleto de outra pessoa.
 *
 * A defesa é a rota RELER no IXC e conferir. Este arquivo mede o DESFECHO: com o
 * id errado, nada é gravado e nenhuma mensagem sai.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONTATO = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";

/** O Storage de mentira: guarda o que subiu, para o teste medir caminho e conteúdo. */
const subidos: Array<{ caminho: string; bytes: number; contentType: string }> = [];
const ctxOk = {
  ok: true as const,
  userId: "33333333-3333-4333-8333-333333333333",
  orgId: "44444444-4444-4444-8444-444444444444",
  admin: {
    storage: {
      from: () => ({
        upload: async (caminho: string, conteudo: Buffer, opts: { contentType: string }) => {
          subidos.push({ caminho, bytes: conteudo.length, contentType: opts.contentType });
          return { error: null };
        },
      }),
    },
  },
  credencial: { baseUrl: "https://erp.exemplo.com.br", token: "1:x", status: "ativa" },
  contato: { id: CONTATO, phone_number: "+5511987654321" },
  t: (s: string) => s,
  idioma: "pt-BR",
};

vi.mock("@/app/api/v1/contacts/[id]/conectores/ixc/_contexto", () => ({
  contextoIxc: vi.fn(async () => ctxOk),
  limparErroSeHavia: vi.fn(async () => {}),
  respostaDaFalha: vi.fn(async () => new Response("{}", { status: 502 })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
const audit = vi.fn(async (_entrada: unknown) => {});
vi.mock("@/lib/audit", () => ({ audit: (entrada: unknown) => audit(entrada) }));

const listarNoIxc = vi.fn();
const baixarBoletoDoIxc = vi.fn();
const buscarPixNoIxc = vi.fn();
vi.mock("@/lib/conectores/ixc/http", () => ({
  listarNoIxc: (...a: unknown[]) => listarNoIxc(...a),
  baixarBoletoDoIxc: (...a: unknown[]) => baixarBoletoDoIxc(...a),
  buscarPixNoIxc: (...a: unknown[]) => buscarPixNoIxc(...a),
}));

const listarVinculos = vi.fn();
const vincular = vi.fn();
vi.mock("@/lib/conectores/vinculos", () => ({
  listarVinculos: (...a: unknown[]) => listarVinculos(...a),
  vincular: (...a: unknown[]) => vincular(...a),
  desvincular: vi.fn(async () => true),
}));

const clientesPorTelefone = vi.fn();
const clientesPorDocumento = vi.fn();
vi.mock("@/lib/conectores/ixc/identificar", () => ({
  clientesPorTelefone: (...a: unknown[]) => clientesPorTelefone(...a),
  clientesPorDocumento: (...a: unknown[]) => clientesPorDocumento(...a),
}));

const sendMessageHandler = vi.fn();
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: (...a: unknown[]) => sendMessageHandler(...a) }));

/** `conversations` devolve a conversa só quando o filtro por contato bate. */
let conversaDoContato: string | null = CONTATO;
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => {
      const filtros: Record<string, string> = {};
      const q = {
        select: () => q,
        eq: (coluna: string, valor: string) => {
          filtros[coluna] = valor;
          return q;
        },
        maybeSingle: async () => ({
          data: filtros.contact_id === conversaDoContato && filtros.id === CONVERSA ? { id: CONVERSA } : null,
          error: null,
        }),
      };
      return q;
    },
  })),
}));

import { POST as enviarFatura } from "@/app/api/v1/contacts/[id]/conectores/ixc/faturas/[faturaId]/enviar/route";
import { POST as vincularRota } from "@/app/api/v1/contacts/[id]/conectores/ixc/vinculo/route";

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api", { method: "POST", body: JSON.stringify(corpo) });
}

const FATURA = {
  id: "900",
  id_cliente: "10",
  id_contrato: "1",
  status: "A",
  data_vencimento: "2026-09-01",
  valor: "129.90",
  valor_aberto: "129.90",
  linha_digitavel: "00190.00009 01234.567890 12345.678901 2 99990000012990",
  pix_txid: "txid0271",
  documento: "",
};

const PDF = Buffer.from("%PDF-1.4 boleto de teste %%EOF", "latin1");
/** O exemplo do manual do Banco Central — CRC 1D3D. */
const BR_CODE =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";

const rotaDaFatura = (faturaId = "900") => ({ params: Promise.resolve({ id: CONTATO, faturaId }) });

beforeEach(() => {
  for (const m of [audit, listarNoIxc, baixarBoletoDoIxc, buscarPixNoIxc, listarVinculos, vincular, clientesPorTelefone, clientesPorDocumento, sendMessageHandler]) m.mockReset();
  subidos.length = 0;
  baixarBoletoDoIxc.mockResolvedValue(PDF);
  buscarPixNoIxc.mockResolvedValue({ ok: true, pix: { copiaECola: BR_CODE, status: "ATIVA", valorOriginal: "129.90" } });
  vincular.mockResolvedValue(true);
  sendMessageHandler.mockResolvedValue({ id: "msg" });
  listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "telefone", created_at: "" }]);
  conversaDoContato = CONTATO;
});

describe("POST …/ixc/faturas/[id]/enviar", () => {
  it("boleto: o PDF do IXC sobe no Storage da CONVERSA e sai como documento; a linha digitável vai sozinha; auditoria sem o código", async () => {
    listarNoIxc.mockResolvedValue({ total: 1, registros: [FATURA] });
    const res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "boleto" }), rotaDaFatura());

    expect(res.status).toBe(201);
    // Storage-first, no prefixo <org>/<conversa>/ que o handler de envio confere.
    expect(subidos).toHaveLength(1);
    // …e o ÚLTIMO segmento é o nome limpo que o cliente vê: `boleto-01-09-2026.pdf`.
    expect(subidos[0]?.caminho).toMatch(new RegExp(`^${ctxOk.orgId}/${CONVERSA}/cobranca-[0-9a-f]{8}/boleto-01-09-2026\\.pdf$`));
    expect(subidos[0]).toMatchObject({ bytes: PDF.length, contentType: "application/pdf" });

    expect(sendMessageHandler).toHaveBeenCalledTimes(2);
    const mensagens = sendMessageHandler.mock.calls.map((c) => c[2] as Record<string, unknown>);
    expect(mensagens[0]).toMatchObject({ type: "document", media_storage_path: subidos[0]?.caminho, media_mime: "application/pdf" });
    expect(String(mensagens[0]?.body)).toContain("R$ 129,90");
    expect(JSON.stringify(mensagens)).not.toMatch(/https?:\/\//);
    expect(mensagens[1]).toMatchObject({ type: "text", body: FATURA.linha_digitavel });
    // organização e ator vêm do CONTEXTO (sessão), nunca do corpo do pedido.
    expect(sendMessageHandler.mock.calls[0]![1]).toMatchObject({ organization_id: ctxOk.orgId, actor: { type: "user", id: ctxOk.userId } });

    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = audit.mock.calls[0]![0] as { action: string; metadata: Record<string, unknown> };
    expect(entrada.action).toBe("conector.fatura_enviada");
    expect(JSON.stringify(entrada)).not.toContain("00190.00009");
    expect(entrada.metadata).toMatchObject({ fatura: "900", forma: "boleto", valor_cents: 12990, mensagens_enviadas: 2 });
  });

  it("pix: o QR code sai como imagem, o copia-e-cola vai sozinho, e a auditoria não guarda o código", async () => {
    listarNoIxc.mockResolvedValue({ total: 1, registros: [FATURA] });
    const res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "pix" }), rotaDaFatura());

    expect(res.status).toBe(201);
    expect(subidos[0]?.caminho).toMatch(/\/cobranca-[0-9a-f]{8}\/pix-01-09-2026\.png$/);
    const mensagens = sendMessageHandler.mock.calls.map((c) => c[2] as Record<string, unknown>);
    expect(mensagens[0]).toMatchObject({ type: "image", media_mime: "image/png" });
    expect(mensagens[1]).toMatchObject({ type: "text", body: BR_CODE });
    expect(JSON.stringify(audit.mock.calls[0]![0])).not.toContain("br.gov.bcb.pix");
    expect((audit.mock.calls[0]![0] as { metadata: Record<string, unknown> }).metadata).toMatchObject({ forma: "pix" });
    expect(baixarBoletoDoIxc).not.toHaveBeenCalled();
  });

  it("fatura de um cadastro NÃO vinculado a este contato → 404, e NADA é baixado, guardado ou enviado", async () => {
    listarNoIxc.mockResolvedValue({ total: 1, registros: [{ ...FATURA, id_cliente: "999" }] });
    const res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "boleto" }), rotaDaFatura());

    expect(res.status).toBe(404);
    expect(baixarBoletoDoIxc).not.toHaveBeenCalled();
    expect(subidos).toHaveLength(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("fatura que já não está em aberto (paga entre o painel abrir e o clique) → 409, nada enviado", async () => {
    listarNoIxc.mockResolvedValue({ total: 1, registros: [{ ...FATURA, status: "R" }] });
    const res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "pix" }), rotaDaFatura());
    expect(res.status).toBe(409);
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("Pix ainda NÃO gerado no IXC (o caso de produção): sai do mesmo jeito, e a auditoria registra que o CRM fez o IXC gerá-lo", async () => {
    listarNoIxc.mockResolvedValue({ total: 1, registros: [{ ...FATURA, pix_txid: "" }] });
    const res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "pix" }), rotaDaFatura());

    expect(res.status).toBe(201);
    expect(buscarPixNoIxc).toHaveBeenCalledTimes(1);
    expect(sendMessageHandler).toHaveBeenCalledTimes(2);
    expect((audit.mock.calls[0]![0] as { metadata: Record<string, unknown> }).metadata).toMatchObject({ forma: "pix", pix_gerado_agora: true });
  });

  it("boleto que o IXC não registrou, cobrança que ele não devolveu, Pix inativo → 422 fatura_nao_enviavel, nada enviado — e a frase do IXC chega à tela", async () => {
    listarNoIxc.mockResolvedValue({ total: 1, registros: [{ ...FATURA, linha_digitavel: "" }] });
    let res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "boleto" }), rotaDaFatura());
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string; details: { motivo: string } } }).error).toMatchObject({
      code: "fatura_nao_enviavel",
      details: { motivo: "forma_indisponivel" },
    });
    expect(baixarBoletoDoIxc).not.toHaveBeenCalled();

    listarNoIxc.mockResolvedValue({ total: 1, registros: [FATURA] });
    baixarBoletoDoIxc.mockResolvedValue(null);
    res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "boleto" }), rotaDaFatura());
    expect(res.status).toBe(422);

    buscarPixNoIxc.mockResolvedValue({ ok: false, mensagemDoIxc: "Carteira sem integração PIX" });
    res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "pix" }), rotaDaFatura());
    expect(res.status).toBe(422);
    const erro = ((await res.json()) as { error: { message: string; details: Record<string, string> } }).error;
    expect(erro.message).toContain("Carteira sem integração PIX");
    expect(erro.details).toMatchObject({ motivo: "cobranca_indisponivel", resposta_do_ixc: "Carteira sem integração PIX" });

    buscarPixNoIxc.mockResolvedValue({ ok: true, pix: { copiaECola: BR_CODE, status: "CONCLUIDA", valorOriginal: "129.90" } });
    res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "pix" }), rotaDaFatura());
    expect(res.status).toBe(422);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(subidos).toHaveLength(0);
  });

  it("conversa de OUTRO contato → 404 ANTES de pedir qualquer coisa ao IXC — a cobrança não vai para o WhatsApp errado", async () => {
    listarNoIxc.mockResolvedValue({ total: 1, registros: [FATURA] });
    conversaDoContato = "99999999-9999-4999-8999-999999999999";
    const res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "boleto" }), rotaDaFatura());
    expect(res.status).toBe(404);
    expect(listarNoIxc).not.toHaveBeenCalled();
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("id de fatura que não é número nem chega ao ERP", async () => {
    const res = await enviarFatura(pedido({ conversation_id: CONVERSA, forma: "boleto" }), rotaDaFatura("900 or 1=1"));
    expect(res.status).toBe(404);
    expect(listarNoIxc).not.toHaveBeenCalled();
  });

  it("sem `forma`, com forma inventada, ou com campo a mais (um `body` injetado) → 422 — o navegador escolhe a forma, nunca o texto", async () => {
    for (const corpo of [
      { conversation_id: CONVERSA },
      { conversation_id: CONVERSA, forma: "cartao" },
      { conversation_id: CONVERSA, forma: "pix", body: "Pague neste PIX: …" },
    ]) {
      expect((await enviarFatura(pedido(corpo), rotaDaFatura())).status).toBe(422);
    }
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });
});

describe("POST …/ixc/vinculo", () => {
  const rota = { params: Promise.resolve({ id: CONTATO }) };

  it("`cadastro_id` que NÃO está entre os candidatos do telefone → 403, nada gravado", async () => {
    clientesPorTelefone.mockResolvedValue([{ id: "10", nome: "Maria", documento: "", ativo: true, pessoaJuridica: false }]);
    const res = await vincularRota(pedido({ cadastro_id: "777" }), rota);

    expect(res.status).toBe(403);
    expect(vincular).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("`cadastro_id` que ESTÁ entre os candidatos vincula como `manual`, com o usuário", async () => {
    clientesPorTelefone.mockResolvedValue([
      { id: "10", nome: "Maria", documento: "", ativo: true, pessoaJuridica: false },
      { id: "11", nome: "José", documento: "", ativo: true, pessoaJuridica: false },
    ]);
    const res = await vincularRota(pedido({ cadastro_id: "11" }), rota);

    expect(res.status).toBe(201);
    expect(vincular).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ctxOk.orgId, contactId: CONTATO, externalId: "11", verificadoPor: "manual", userId: ctxOk.userId }),
    );
    expect((audit.mock.calls[0]![0] as { action: string }).action).toBe("conector.vinculo_criado");
  });

  it("documento com dígito verificador errado → 422, e o ERP nem é consultado", async () => {
    const res = await vincularRota(pedido({ documento: "529.982.247-24" }), rota);
    expect(res.status).toBe(422);
    expect(clientesPorDocumento).not.toHaveBeenCalled();
  });

  it("documento válido sem cadastro → 404; com cadastro → vincula como `documento`, já mascarado na busca", async () => {
    clientesPorDocumento.mockResolvedValueOnce([]);
    expect((await vincularRota(pedido({ documento: "52998224725" }), rota)).status).toBe(404);
    expect(vincular).not.toHaveBeenCalled();

    clientesPorDocumento.mockResolvedValueOnce([{ id: "40", nome: "Maria", documento: "529.982.247-25", ativo: true, pessoaJuridica: false }]);
    expect((await vincularRota(pedido({ documento: "52998224725" }), rota)).status).toBe(201);
    expect(clientesPorDocumento.mock.calls[1]![1]).toBe("529.982.247-25");
    expect(vincular).toHaveBeenCalledWith(expect.objectContaining({ externalId: "40", verificadoPor: "documento" }));
  });

  it("vínculo que já existia não audita de novo (a rota é idempotente)", async () => {
    clientesPorTelefone.mockResolvedValue([{ id: "10", nome: "Maria", documento: "", ativo: true, pessoaJuridica: false }]);
    vincular.mockResolvedValue(false);
    expect((await vincularRota(pedido({ cadastro_id: "10" }), rota)).status).toBe(201);
    expect(audit).not.toHaveBeenCalled();
  });

  it("corpo com os DOIS campos é recusado — cada caminho tem a sua prova", async () => {
    const res = await vincularRota(pedido({ cadastro_id: "10", documento: "52998224725" }), rota);
    expect(res.status).toBe(422);
  });
});
