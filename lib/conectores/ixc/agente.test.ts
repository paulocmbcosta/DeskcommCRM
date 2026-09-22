import { beforeEach, describe, expect, it, vi } from "vitest";

const listar = vi.fn();
const baixarBoleto = vi.fn();
const buscarPix = vi.fn();
vi.mock("./http", () => ({
  listarNoIxc: (...a: unknown[]) => listar(...a),
  baixarBoletoDoIxc: (...a: unknown[]) => baixarBoleto(...a),
  buscarPixNoIxc: (...a: unknown[]) => buscarPix(...a),
}));
const listarVinculos = vi.fn();
const vincular = vi.fn();
vi.mock("../vinculos", () => ({
  listarVinculos: (...a: unknown[]) => listarVinculos(...a),
  vincular: (...a: unknown[]) => vincular(...a),
}));

import { agenteIxc } from "./agente";

const CRED = { baseUrl: "https://erp.exemplo.com.br", token: "1:x" };
const AGORA = new Date("2026-09-22T15:00:00Z"); // hoje em SP = 2026-09-22
const BASE = { admin: {} as never, credencial: CRED, orgId: "org-1", contactId: "contato-1", telefone: "+5561993040271", agora: AGORA };

type Linha = Record<string, string>;
const MARIA: Linha = { id: "10", razao: "Maria Aparecida Souza", cnpj_cpf: "529.982.247-25", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0271", data_nascimento: "1985-03-12", senha: "segredo" };
const JOSE: Linha = { id: "20", razao: "José Souza", cnpj_cpf: "111.444.777-35", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0271", data_nascimento: "1980-01-01", senha: "x" };
const CONTRATO: Linha = { id: "700", id_cliente: "10", contrato: "Fibra 500 Mega", status: "A", status_internet: "FA", data_ativacao: "2024-03-10", endereco: "Rua das Flores", numero: "120", bairro: "Centro" };
const fatura = (id: string, venc: string, extra: Linha = {}): Linha => ({ id, id_cliente: "10", id_contrato: "700", status: "A", data_vencimento: venc, valor: "129.90", valor_aberto: "129.90", linha_digitavel: "", pix_txid: "", ...extra });
const LOGIN: Linha = { id: "5", id_cliente: "10", id_contrato: "700", login: "maria", ativo: "S", online: "N", ip: "100.64.10.27", mac: "AA:BB:CC:DD:EE:FF" };

/** IXC de mentira: filtra pelo que o conector pediu e PROJETA nos campos pedidos, como `http.ts`. */
function ixc(tabelas: Record<string, Linha[]>) {
  listar.mockImplementation(async (_c: unknown, p: { tabela: string; filtro: { campo: string; valor: string; operador: string }; tambem?: Array<{ campo: string; valor: string; operador: string }>; campos: readonly string[] }) => {
    const casa = (l: Linha, f: { campo: string; valor: string; operador: string }) => {
      const v = l[f.campo.split(".").pop() ?? ""] ?? "";
      if (f.operador === "=") return v === f.valor;
      if (f.operador === "!=") return v !== f.valor;
      if (f.operador === "L") return v.includes(f.valor);
      return true;
    };
    const achadas = (tabelas[p.tabela] ?? []).filter((l) => [p.filtro, ...(p.tambem ?? [])].every((f) => casa(l, f)));
    return { total: achadas.length, registros: achadas.map((l) => Object.fromEntries(p.campos.map((c) => [c, l[c] ?? ""]))) };
  });
}

beforeEach(() => {
  for (const m of [listar, baixarBoleto, buscarPix, listarVinculos, vincular]) m.mockReset();
  // `vincular` devolve `{ vinculou, promovido }` desde o lote A (boolean → objeto) —
  // mock com o valor velho faria `vincularE` desestruturar `undefined` e nunca
  // reportar `vinculou` na resposta.
  vincular.mockResolvedValue({ vinculou: true, promovido: false });
  listarVinculos.mockResolvedValue([]);
});

describe("consultar — identidade antes de dinheiro (D1)", () => {
  it("vínculo existente identifica, e a projeção não leva id, CPF, endereço, IP, MAC nem senha", async () => {
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "documento", created_at: "" }]);
    ixc({ cliente: [MARIA], cliente_contrato: [CONTRATO], fn_areceber: [fatura("900", "2026-07-14"), fatura("950", "2026-10-12")], radusuarios: [LOGIN] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.cliente).toMatchObject({ primeiroNome: "Maria", situacao: "Bloqueado", motivoDaSituacao: "financeiro em atraso", bloqueado: true, plano: "Fibra 500 Mega", clienteDesde: "2024-03-10", conexao: "offline", temOsAberta: false });
    expect(r.financeiro?.daVez).toEqual({ vencimento: "2026-07-14", valorCents: 12990, diasDeAtraso: 70 });
    expect(r.financeiro?.proxima?.vencimento).toBe("2026-10-12");
    const json = JSON.stringify(r);
    for (const proibido of ["529.982", "Rua das Flores", "100.64", "AA:BB", "segredo", "\"900\"", "\"10\"", "\"700\""]) expect(json).not.toContain(proibido);
    expect(vincular).not.toHaveBeenCalled();
  });

  it("vínculo `telefone` num canal SEM telefone de identidade não conta", async () => {
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "telefone", created_at: "" }]);
    ixc({ cliente: [MARIA] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "nao" });
    expect(r.estado).toBe("precisa_cpf_e_nascimento");
  });

  it("WhatsApp com 1 cadastro no telefone: vincula como telefone", async () => {
    ixc({ cliente: [MARIA], cliente_contrato: [CONTRATO] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.vinculou).toEqual({ verificadoPor: "telefone", cadastros: ["10"] });
  });

  it("chat do site com o MESMO telefone: não vincula, pede CPF + nascimento", async () => {
    ixc({ cliente: [MARIA] });
    expect((await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "nao" })).estado).toBe("precisa_cpf_e_nascimento");
    expect(vincular).not.toHaveBeenCalled();
  });

  it("2 cadastros no telefone: pede CPF; o CPF de um deles escolhe e vincula como documento", async () => {
    ixc({ cliente: [MARIA, JOSE], cliente_contrato: [CONTRATO] });
    expect((await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" })).estado).toBe("precisa_cpf");
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: "52998224725" });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.vinculou).toEqual({ verificadoPor: "documento", cadastros: ["10"] });
  });

  it("sem cadastro no telefone: CPF + nascimento que batem vinculam; qualquer recusa é nao_conferiu", async () => {
    ixc({ cliente: [{ ...MARIA, telefone_celular: "(61) 98888-0000" }], cliente_contrato: [CONTRATO] });
    const ok = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: "529.982.247-25", dataNascimento: "12/03/1985" });
    expect(ok.estado).toBe("identificado");
    const errada = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: "529.982.247-25", dataNascimento: "1985-03-13" });
    const inexistente = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: "390.533.447-05", dataNascimento: "1985-03-12" });
    expect(errada).toEqual({ estado: "nao_conferiu" });
    expect(inexistente).toEqual({ estado: "nao_conferiu" });
  });

  it("CPF com dígito errado e data impossível NÃO consultam o IXC (não gastam tentativa)", async () => {
    ixc({ cliente: [] });
    expect((await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "nao", cpfCnpj: "529.982.247-26", dataNascimento: "1985-03-12" })).estado).toBe("cpf_invalido");
    expect((await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "nao", cpfCnpj: "529.982.247-25", dataNascimento: "1985-02-30" })).estado).toBe("data_invalida");
    expect(listar).not.toHaveBeenCalled();
  });
});
