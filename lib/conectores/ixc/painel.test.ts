import { beforeEach, describe, expect, it, vi } from "vitest";

import { FalhaDoConector } from "../tipos";

const listar = vi.fn();
vi.mock("./http", () => ({ listarNoIxc: (...args: unknown[]) => listar(...args) }));

const listarVinculos = vi.fn();
const vincular = vi.fn();
vi.mock("../vinculos", () => ({
  listarVinculos: (...a: unknown[]) => listarVinculos(...a),
  vincular: (...a: unknown[]) => vincular(...a),
}));

import { estadoDoPainelIxc } from "./painel";
import { situacaoDoCliente, type ContratoIxc } from "./resumo";

const CRED = { baseUrl: "https://erp.exemplo.com.br", token: "1:x" };
const BASE = {
  admin: {} as never,
  credencial: CRED,
  orgId: "org-1",
  contactId: "contato-1",
  telefone: "+5511987654321",
  identidadeDoTelefone: "sim" as const,
  agora: new Date("2026-09-19T15:00:00Z"),
};

type Pedido = { tabela: string; filtro: { campo: string; valor: string } };

/** Um IXC de mentira: responde por tabela, e devolve a linha INTEIRA — com senha. */
function ixcFalso(tabelas: Record<string, Record<string, string>[] | Error>) {
  listar.mockImplementation(async (_cred: unknown, pedido: Pedido & { campos: readonly string[] }) => {
    const dados = tabelas[pedido.tabela] ?? [];
    if (dados instanceof Error) throw dados;
    // A projeção de verdade mora em http.ts; aqui ela é reproduzida para o teste
    // medir o que a TELA receberia.
    const registros = dados.map((r) => Object.fromEntries(pedido.campos.map((c) => [c, r[c] ?? ""])));
    return { total: registros.length, registros };
  });
}

const MARIA = {
  id: "10",
  razao: "Maria da Silva",
  cnpj_cpf: "529.982.247-25",
  tipo_pessoa: "F",
  ativo: "S",
  telefone_celular: "(11) 98765-4321",
  senha: "senha-da-central",
};

beforeEach(() => {
  listar.mockReset();
  listarVinculos.mockReset();
  vincular.mockReset();
  vincular.mockResolvedValue({ vinculou: true, promovido: false });
});

describe("estadoDoPainelIxc — sem vínculo ainda", () => {
  it("telefone que não está no IXC → nao_encontrado (e a tela oferece o CPF)", async () => {
    listarVinculos.mockResolvedValue([]);
    ixcFalso({ cliente: [] });
    expect(await estadoDoPainelIxc(BASE)).toEqual({ estado: "nao_encontrado", procurou_por_telefone: true });
    expect(vincular).not.toHaveBeenCalled();
  });

  it("UM candidato → vincula sozinho, por telefone, sem usuário (foi o sistema)", async () => {
    listarVinculos.mockResolvedValue([]);
    ixcFalso({ cliente: [MARIA] });

    const estado = await estadoDoPainelIxc(BASE);
    expect(estado.estado).toBe("vinculado");
    expect(vincular).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", contactId: "contato-1", externalId: "10", verificadoPor: "telefone", userId: null }),
    );
    if (estado.estado === "vinculado") expect(estado.vinculou_agora).toBe(true);
  });

  it("DOIS candidatos → escolher; NINGUÉM é vinculado e o documento vem parcial", async () => {
    listarVinculos.mockResolvedValue([]);
    ixcFalso({ cliente: [MARIA, { ...MARIA, id: "11", razao: "José da Silva", cnpj_cpf: "111.444.777-35" }] });

    const estado = await estadoDoPainelIxc(BASE);
    expect(estado.estado).toBe("escolher");
    expect(vincular).not.toHaveBeenCalled();
    if (estado.estado === "escolher") {
      expect(estado.motivo).toBe("varios_cadastros");
      expect(estado.candidatos.map((c) => c.id).sort()).toEqual(["10", "11"]);
      expect(JSON.stringify(estado)).not.toContain("529.982.247-25");
      expect(estado.candidatos[0]?.documento_parcial).toMatch(/^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
    }
  });
});

describe("estadoDoPainelIxc — já vinculado", () => {
  beforeEach(() => listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "telefone", created_at: "2026-09-01T00:00:00Z" }]));

  it("não procura por telefone de novo: vai direto pelo id", async () => {
    ixcFalso({ cliente: [MARIA] });
    await estadoDoPainelIxc(BASE);
    const buscasPorTelefone = listar.mock.calls.filter((c) => /telefone|whatsapp|fone/.test((c[1] as Pedido).filtro.campo));
    expect(buscasPorTelefone).toHaveLength(0);
  });

  it("a SENHA que o IXC devolve não aparece em lugar nenhum do que vai para a tela", async () => {
    ixcFalso({
      cliente: [MARIA],
      radusuarios: [{ id: "5", id_cliente: "10", login: "maria", online: "S", ativo: "S", senha: "pppoe-123", senha_rede_sem_fio: "wifi-da-maria" }],
      radpop_radio_cliente_fibra: [{ id: "9", id_login: "5", sinal_rx: "-21.50", sinal_tx: "2.10", data_sinal: "2026-09-19 10:00:00", senha_onu_cliente: "onu-456" }],
    });
    const tela = JSON.stringify(await estadoDoPainelIxc(BASE));
    for (const segredo of ["senha-da-central", "pppoe-123", "wifi-da-maria", "onu-456"]) expect(tela).not.toContain(segredo);
    expect(tela).toContain("-21.5");
  });

  it("uma seção que falha NÃO apaga as outras: OS fora do escopo do token, financeiro de pé", async () => {
    ixcFalso({
      cliente: [MARIA],
      fn_areceber: [{ id: "900", id_cliente: "10", status: "A", data_vencimento: "2026-09-01", valor: "99.90", valor_aberto: "99.90" }],
      su_oss_chamado: new FalhaDoConector("recurso_indisponivel", "ixc_su_oss_chamado_indisponivel"),
    });
    const estado = await estadoDoPainelIxc(BASE);
    expect(estado.estado).toBe("vinculado");
    if (estado.estado !== "vinculado") return;
    expect(estado.resumo.ordensDeServico).toEqual({ ok: false, motivo: "recurso_indisponivel" });
    expect(estado.resumo.financeiro.ok && estado.resumo.financeiro.dados.vencidas).toHaveLength(1);
  });

  it("cadastro que falha SOBE — sem ele não há de quem falar", async () => {
    ixcFalso({ cliente: new FalhaDoConector("credencial_recusada", "ixc_http_401") });
    await expect(estadoDoPainelIxc(BASE)).rejects.toMatchObject({ motivo: "credencial_recusada" });
  });

  it("vínculo para um id que o IXC não devolve mais → vinculo_sem_cadastro", async () => {
    ixcFalso({ cliente: [] });
    expect((await estadoDoPainelIxc(BASE)).estado).toBe("vinculo_sem_cadastro");
  });

  it("`cadastro` pedido que NÃO é um dos vinculados é ignorado — a URL não abre o financeiro de outro", async () => {
    ixcFalso({ cliente: [MARIA, { ...MARIA, id: "999", razao: "Estranho" }] });
    const estado = await estadoDoPainelIxc({ ...BASE, cadastroPedido: "999" });
    expect(estado.estado === "vinculado" && estado.cadastro_em_tela).toBe("10");
  });
});

describe('identidadeDoTelefone: "nao" (chat do site: número digitado)', () => {
  it("1 candidato pelo telefone NÃO vincula sozinho: cai em escolher, com o motivo certo", async () => {
    listarVinculos.mockResolvedValue([]);
    ixcFalso({ cliente: [MARIA] });
    const estado = await estadoDoPainelIxc({ ...BASE, identidadeDoTelefone: "nao" });
    expect(estado.estado).toBe("escolher");
    if (estado.estado !== "escolher") throw new Error("inalcançável");
    expect(estado.motivo).toBe("telefone_digitado");
    expect(estado.candidatos.map((c) => c.id)).toEqual(["10"]);
    expect(vincular).not.toHaveBeenCalled();
  });

  it("controle: com identidadeDoTelefone='sim', o mesmo candidato vincula (o caso de antes)", async () => {
    listarVinculos.mockResolvedValue([]);
    ixcFalso({ cliente: [MARIA] });
    const estado = await estadoDoPainelIxc({ ...BASE, identidadeDoTelefone: "sim" });
    expect(vincular).toHaveBeenCalledWith(expect.objectContaining({ externalId: "10", verificadoPor: "telefone" }));
    expect(estado.estado).toBe("vinculado");
    if (estado.estado === "vinculado") expect(estado.vinculou_agora).toBe(true);
  });
});

describe('identidadeDoTelefone: "desconhecido" (aba antiga sem ?conversa=, provider fora da matriz)', () => {
  it("1 candidato pelo telefone NÃO vincula sozinho, mas o motivo é NEUTRO — não afirma que foi digitado", async () => {
    listarVinculos.mockResolvedValue([]);
    ixcFalso({ cliente: [MARIA] });
    const estado = await estadoDoPainelIxc({ ...BASE, identidadeDoTelefone: "desconhecido" });
    expect(estado.estado).toBe("escolher");
    if (estado.estado !== "escolher") throw new Error("inalcançável");
    expect(estado.motivo).toBe("canal_nao_identificado");
    expect(vincular).not.toHaveBeenCalled();
  });

  it("NÃO esconde um vínculo por telefone já gravado — só 'nao' descarta, 'desconhecido' não", async () => {
    // Esta é a razão de existir do tri-estado: uma aba antiga aberta sem
    // ?conversa= (ou um provider que esta imagem ainda não conhece) não pode
    // fazer um WhatsApp vinculado por telefone sumir e cair no beco do
    // "escolher" — o contato segue vinculado, exatamente como estava.
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "telefone", created_at: "2026-09-01T00:00:00Z" }]);
    ixcFalso({ cliente: [MARIA] });
    const estado = await estadoDoPainelIxc({ ...BASE, identidadeDoTelefone: "desconhecido" });
    expect(estado.estado).toBe("vinculado");
  });
});

describe("vínculo por telefone perde validade SÓ quando identidadeDoTelefone === 'nao'", () => {
  it("vínculo antigo verificado_por=telefone, com identidadeDoTelefone='nao', é descartado — volta a escolher", async () => {
    // O furo antigo: um visitante do chat do site digitou um número, o painel
    // vinculou sozinho, e esse vínculo continuava valendo para sempre. Agora ele
    // é descartado a cada leitura, e o contato volta ao fluxo de identificação.
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "telefone", created_at: "2026-09-01T00:00:00Z" }]);
    ixcFalso({ cliente: [MARIA] });
    const estado = await estadoDoPainelIxc({ ...BASE, identidadeDoTelefone: "nao" });
    expect(estado.estado).toBe("escolher");
    if (estado.estado !== "escolher") throw new Error("inalcançável");
    expect(estado.motivo).toBe("telefone_digitado");
  });

  it("controle: vínculo por documento continua valendo mesmo com identidadeDoTelefone='nao'", async () => {
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "documento", created_at: "2026-09-01T00:00:00Z" }]);
    ixcFalso({ cliente: [MARIA] });
    const estado = await estadoDoPainelIxc({ ...BASE, identidadeDoTelefone: "nao" });
    expect(estado.estado).toBe("vinculado");
  });
});

describe("situacaoDoCliente", () => {
  const contrato = (extra: Partial<ContratoIxc>): ContratoIxc => ({
    id: "1",
    plano: "500 Mega",
    status: { rotulo: "Ativo", tom: "bom" },
    acesso: { rotulo: "Liberado", tom: "bom" },
    vigente: true,
    bloqueado: false,
    ativadoEm: "",
    endereco: "",
    parcelasEmAtraso: 0,
    desbloqueioDeConfiancaAtivo: false,
    ...extra,
  });

  it("bloqueio em contrato VIGENTE é bloqueio", () => {
    const s = situacaoDoCliente([contrato({ bloqueado: true, acesso: { rotulo: "Bloqueado", tom: "ruim", detalhe: "financeiro em atraso" } })]);
    expect(s).toEqual({ rotulo: "Bloqueado", tom: "ruim", detalhe: "financeiro em atraso" });
  });

  it("bloqueio em contrato CANCELADO é história, não 'cliente bloqueado'", () => {
    const s = situacaoDoCliente([contrato({ vigente: false, bloqueado: true }), contrato({})]);
    expect(s.rotulo).toBe("Liberado");
  });

  it("sem contrato vigente não é liberado nem bloqueado", () => {
    expect(situacaoDoCliente([contrato({ vigente: false })]).rotulo).toBe("Sem contrato ativo");
  });
});
