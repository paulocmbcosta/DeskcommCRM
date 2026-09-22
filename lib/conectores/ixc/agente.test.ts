import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ArquivoDaCobranca, MensagemDaCobranca } from "../tipos";

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
    // `auditoria` é o que o motor tem de tirar de propósito antes de montar o
    // contexto da IA — não pode estar dentro do que já é a projeção do cliente.
    expect(r.cliente).not.toHaveProperty("auditoria");
    expect(r.financeiro).not.toHaveProperty("auditoria");
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
    expect(r.auditoria.vinculou).toEqual({ verificadoPor: "telefone", cadastros: ["10"] });
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
    expect(r.auditoria.vinculou).toEqual({ verificadoPor: "documento", cadastros: ["10"] });
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

describe("consultar — CPF contraditório NÃO vincula pelo telefone (crítico 1)", () => {
  it("controle: CPF que BATE com o único candidato do telefone vincula por telefone normalmente", async () => {
    ixc({ cliente: [MARIA], cliente_contrato: [CONTRATO] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: "529.982.247-25" });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.auditoria.vinculou).toEqual({ verificadoPor: "telefone", cadastros: ["10"] });
  });

  it("controle: sem CPF informado, vincula por telefone normalmente (comportamento de sempre)", async () => {
    ixc({ cliente: [MARIA], cliente_contrato: [CONTRATO] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.auditoria.vinculou).toEqual({ verificadoPor: "telefone", cadastros: ["10"] });
  });

  it("CPF de OUTRA pessoa (telefone reciclado): não vincula a Maria — pede CPF + nascimento", async () => {
    ixc({ cliente: [MARIA] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: JOSE.cnpj_cpf });
    expect(r.estado).toBe("precisa_cpf_e_nascimento");
    expect(vincular).not.toHaveBeenCalled();
  });

  it("CPF de outra pessoa + nascimento CERTO dela identifica ELA — nunca quem só tem o telefone", async () => {
    // José tem OUTRO telefone: se ele aparecesse na busca por telefone, o teste
    // não provaria nada (viraria o caminho de "2 candidatos", não o de 1).
    const joseOutroTelefone = { ...JOSE, telefone_celular: "(11) 90000-0000" };
    ixc({ cliente: [MARIA, joseOutroTelefone] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: JOSE.cnpj_cpf, dataNascimento: JOSE.data_nascimento });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.auditoria.vinculou).toEqual({ verificadoPor: "documento", cadastros: ["20"] });
  });
});

describe("clienteDe — status_internet desconhecido não é 'Liberado' com confiança (crítico 2)", () => {
  beforeEach(() => listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "documento", created_at: "" }]));

  it("controle: status_internet 'A' (conhecido como liberado) → bloqueado false", async () => {
    ixc({ cliente: [MARIA], cliente_contrato: [{ ...CONTRATO, status_internet: "A" }] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.cliente.bloqueado).toBe(false);
    expect(r.cliente.situacao).toBe("Liberado");
  });

  it("controle: status_internet 'FA' (bloqueio conhecido) → bloqueado true", async () => {
    ixc({ cliente: [MARIA], cliente_contrato: [{ ...CONTRATO, status_internet: "FA" }] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.cliente.bloqueado).toBe(true);
  });

  it("status_internet 'ZZ' (que este vocabulário nunca viu) → bloqueado null, rótulo é o código cru", async () => {
    ixc({ cliente: [MARIA], cliente_contrato: [{ ...CONTRATO, status_internet: "ZZ" }] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.cliente.bloqueado).toBeNull();
    expect(r.cliente.situacao).toBe("ZZ");
  });
});

describe("clienteDe — primeiroNome de PJ nunca vaza o CPF embutido na razão (importante 6)", () => {
  const MEI: Linha = { id: "30", razao: "JOSE DA SILVA 52998224725", fantasia: "", cnpj_cpf: "11.222.333/0001-81", tipo_pessoa: "J", ativo: "S", telefone_celular: "" };

  beforeEach(() => listarVinculos.mockResolvedValue([{ external_id: "30", verificado_por: "documento", created_at: "" }]));

  it("MEI sem fantasia: corta o sufixo numérico da razão — nenhum dígito do CPF sai na projeção", async () => {
    ixc({ cliente: [MEI] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.cliente.primeiroNome).toBe("JOSE DA SILVA");
    expect(JSON.stringify(r)).not.toContain("52998224725");
  });

  it("PJ com fantasia: usa o fantasia, nunca a razão", async () => {
    ixc({ cliente: [{ ...MEI, fantasia: "Mercado do Zé" }] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.cliente.primeiroNome).toBe("Mercado do Zé");
  });
});

describe("consultar — sem a onda de sinal e sem su_ticket (importante 7, latência)", () => {
  it("a consulta da IA não paga a 2ª onda (sinal da ONU) nem lê su_ticket", async () => {
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "documento", created_at: "" }]);
    ixc({
      cliente: [MARIA],
      cliente_contrato: [CONTRATO],
      radusuarios: [LOGIN],
      radpop_radio_cliente_fibra: [{ id: "9", id_login: "5", sinal_rx: "-20" }],
      su_ticket: [{ id: "1", id_cliente: "10", su_status: "N" }],
    });
    await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    const tabelasConsultadas = listar.mock.calls.map((c) => (c[1] as { tabela: string }).tabela);
    expect(tabelasConsultadas).not.toContain("radpop_radio_cliente_fibra");
    expect(tabelasConsultadas).not.toContain("su_ticket");
    // Controle: `os` (su_oss_chamado) continua pedida — é dela que `temOsAberta` vem.
    expect(tabelasConsultadas).toContain("su_oss_chamado");
  });
  // Controle do lado do painel (que precisa das duas ondas) mora em
  // `painel.test.ts` ("a SENHA que o IXC devolve não aparece..."): ele chama
  // `montarResumo` sem o 4º argumento e continua lendo o sinal — a suíte
  // inteira prova que o default não mudou.
});

describe("consultar — 9 cadastros do MESMO CPF não são cortados pelo teto do telefone (importante 9)", () => {
  const DOCUMENTO = "529.982.247-25";
  const NASCIMENTO = "1985-03-12";
  const cadastroDoDocumento = (sufixo: string, id: string): Linha => ({
    id,
    razao: `Cliente ${sufixo}`,
    cnpj_cpf: DOCUMENTO,
    tipo_pessoa: "F",
    ativo: "S",
    telefone_celular: "",
    data_nascimento: NASCIMENTO,
  });
  // "Z09" ordena DEPOIS de "A01".."A08" (`ativosPrimeiro` desempata por nome) —
  // é o TETO_DE_CANDIDATOS (8) antigo que cortaria exatamente este.
  const oitoCadastros = Array.from({ length: 8 }, (_, i) => cadastroDoDocumento(`A0${i + 1}`, `${101 + i}`));
  const nonoCadastro = cadastroDoDocumento("Z09", "109");

  it("a fatura mais atrasada é do 9º cadastro — sumiria se a lista fosse cortada em 8", async () => {
    ixc({
      cliente: [...oitoCadastros, nonoCadastro],
      fn_areceber: [
        ...oitoCadastros.map((c) => fatura(`f${c.id ?? ""}`, "2026-09-01", { id_cliente: c.id ?? "" })),
        fatura(`f${nonoCadastro.id ?? ""}`, "2026-06-01", { id_cliente: nonoCadastro.id ?? "" }),
      ],
    });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "nao", cpfCnpj: DOCUMENTO, dataNascimento: NASCIMENTO });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.auditoria.vinculou?.cadastros).toHaveLength(9);
    expect(r.financeiro?.daVez?.vencimento).toBe("2026-06-01");
  });
});

const PDF = Buffer.from("%PDF-1.4 boleto %%EOF", "latin1");
const BR_CODE =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";

function portas() {
  const enviadas: MensagemDaCobranca[] = [];
  return {
    enviadas,
    portas: {
      guardarArquivo: vi.fn(async (a: ArquivoDaCobranca) => `org-1/conv/cobranca-x/${a.nome}.${a.extensao}`),
      enviar: vi.fn(async (m: MensagemDaCobranca) => void enviadas.push(m)),
    },
  };
}
const COBRAR = { ...BASE, identidadeDoTelefone: "sim" as const, forma: "pix" as const, limiteDeDias: 60 };

describe("enviarCobranca — UMA fatura por vez (D2), limite (D5), Pix padrão (D3), sem como cobrar (D6)", () => {
  beforeEach(() => {
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "telefone", created_at: "" }]);
    baixarBoleto.mockResolvedValue(PDF);
    buscarPix.mockResolvedValue({ ok: true, pix: { copiaECola: BR_CODE, status: "ATIVA", valorOriginal: "129.90" } });
  });

  it("envia a vencida mais antiga, por Pix, em duas mensagens — e nunca pede a outra fatura", async () => {
    ixc({ fn_areceber: [fatura("902", "2026-09-10", { linha_digitavel: "0019 x" }), fatura("901", "2026-08-20"), fatura("950", "2026-10-12")] });
    const { portas: p, enviadas } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, portas: p });
    expect(r).toMatchObject({ resultado: "enviada", forma: "pix", enviadas: 2, previstas: 2, pixIndisponivel: false, auditoria: { faturaId: "901" } });
    expect(enviadas.map((m) => m.type)).toEqual(["image", "text"]);
    expect(buscarPix.mock.calls.map((c) => c[1])).toEqual(["901"]);
  });

  it("acima do limite: NADA sai e o resultado é encaminhar_para_cobranca", async () => {
    ixc({ fn_areceber: [fatura("900", "2026-07-14"), fatura("950", "2026-10-12")] }); // 70 dias
    const { portas: p } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, portas: p });
    expect(r).toMatchObject({ resultado: "encaminhar_para_cobranca", fatura: { diasDeAtraso: 70 }, auditoria: { faturaId: "900" } });
    expect(p.enviar).not.toHaveBeenCalled();
    expect(buscarPix).not.toHaveBeenCalled();
  });

  it("controle do limite: 60 dias exatos ainda saem (a regra é MAIS de N)", async () => {
    ixc({ fn_areceber: [fatura("900", "2026-07-24")] }); // 60 dias
    const { portas: p } = portas();
    expect((await agenteIxc.enviarCobranca({ ...COBRAR, portas: p })).resultado).toBe("enviada");
  });

  it("boleto pedido sem registro: boleto_indisponivel, e o Pix NÃO é trocado sem perguntar", async () => {
    ixc({ fn_areceber: [fatura("901", "2026-08-20")] });
    const { portas: p } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, forma: "boleto", portas: p });
    expect(r.resultado).toBe("boleto_indisponivel");
    expect(buscarPix).not.toHaveBeenCalled();
  });

  it("Pix recusado e boleto registrado: sai o BOLETO da mesma fatura", async () => {
    ixc({ fn_areceber: [fatura("901", "2026-08-20", { linha_digitavel: "00190.00009 01234.567890 12345.678901 2 99990000012990" })] });
    buscarPix.mockResolvedValue({ ok: false, mensagemDoIxc: "carteira sem Pix" });
    const { portas: p, enviadas } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, portas: p });
    expect(r).toMatchObject({ resultado: "enviada", forma: "boleto", pixIndisponivel: true, auditoria: { faturaId: "901" } });
    expect(enviadas[0]?.type).toBe("document");
  });

  it("Pix recusado e sem boleto: sem_como_cobrar com a frase do IXC", async () => {
    ixc({ fn_areceber: [fatura("901", "2026-08-20")] });
    buscarPix.mockResolvedValue({ ok: false, mensagemDoIxc: "carteira sem Pix" });
    const { portas: p } = portas();
    expect(await agenteIxc.enviarCobranca({ ...COBRAR, portas: p })).toMatchObject({ resultado: "sem_como_cobrar", detalheDoErp: "carteira sem Pix" });
  });

  it("sem fatura aberta e sem vínculo válido", async () => {
    ixc({ fn_areceber: [] });
    const { portas: p } = portas();
    expect((await agenteIxc.enviarCobranca({ ...COBRAR, portas: p })).resultado).toBe("sem_fatura_em_aberto");
    expect((await agenteIxc.enviarCobranca({ ...COBRAR, identidadeDoTelefone: "nao", portas: p })).resultado).toBe("cliente_nao_identificado");
  });

  it("a mais atrasada entre DOIS cadastros vinculados", async () => {
    listarVinculos.mockResolvedValue([
      { external_id: "10", verificado_por: "documento", created_at: "" },
      { external_id: "20", verificado_por: "documento", created_at: "" },
    ]);
    ixc({ fn_areceber: [fatura("901", "2026-08-20"), { ...fatura("801", "2026-08-01"), id_cliente: "20" }] });
    const { portas: p } = portas();
    expect(await agenteIxc.enviarCobranca({ ...COBRAR, portas: p })).toMatchObject({ resultado: "enviada", auditoria: { faturaId: "801" } });
  });

  it("valor zero não é escolhida mesmo sendo a mais antiga (importante 4, mesma régua da consulta)", async () => {
    ixc({ fn_areceber: [fatura("900", "2026-07-01", { valor: "0", valor_aberto: "0" }), fatura("901", "2026-08-20")] });
    const { portas: p } = portas();
    expect(await agenteIxc.enviarCobranca({ ...COBRAR, portas: p })).toMatchObject({ resultado: "enviada", auditoria: { faturaId: "901" } });
  });
});

describe("consultar × enviarCobranca — a MESMA fatura de valor zero não aparece em nenhum dos dois (importante 4)", () => {
  it("a consulta não anuncia a mais antiga se ela tem valor zero", async () => {
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "documento", created_at: "" }]);
    ixc({ cliente: [MARIA], fn_areceber: [fatura("900", "2026-07-01", { valor: "0", valor_aberto: "0" }), fatura("901", "2026-08-20")] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.financeiro?.daVez?.vencimento).toBe("2026-08-20");
    expect(r.financeiro?.vencidas.map((f) => f.vencimento)).toEqual(["2026-08-20"]);
    expect(r.financeiro?.totalVencidoCents).toBe(12990);
  });
});

describe("enviarCobranca — fatura fecha ENTRE listar e reler (importante 5)", () => {
  beforeEach(() => listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "telefone", created_at: "" }]));

  it("status 'R' na releitura: fatura_ja_paga — não vira 'sem_como_cobrar' nem some pra Cobrança", async () => {
    // A LISTAGEM (`recorteDe`, com filtro de status=A) ainda vê a fatura aberta;
    // a RELEITURA por id (dentro de `enviarCobrancaIxc`, sem esse filtro) já vê
    // que foi paga — a corrida que o importante 5 mede.
    listar.mockImplementation(async (_c: unknown, p: { tabela: string; tambem?: Array<{ campo: string }> }) => {
      if (p.tabela !== "fn_areceber") return { total: 0, registros: [] };
      const eAListagemAberta = (p.tambem ?? []).some((f) => f.campo === "fn_areceber.status");
      return { total: 1, registros: [fatura("901", "2026-08-20", { status: eAListagemAberta ? "A" : "R" })] };
    });
    const { portas: p } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, portas: p });
    expect(r).toMatchObject({ resultado: "fatura_ja_paga", auditoria: { faturaId: "901" } });
    expect(p.enviar).not.toHaveBeenCalled();
  });

  it("fatura sumiu na releitura: continua sem_como_cobrar, mas o motivo interno vai só pra auditoria", async () => {
    listar.mockImplementation(async (_c: unknown, p: { tabela: string; tambem?: Array<{ campo: string }> }) => {
      if (p.tabela !== "fn_areceber") return { total: 0, registros: [] };
      const eAListagemAberta = (p.tambem ?? []).some((f) => f.campo === "fn_areceber.status");
      return eAListagemAberta ? { total: 1, registros: [fatura("901", "2026-08-20")] } : { total: 0, registros: [] };
    });
    const { portas: p } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, portas: p });
    expect(r).toMatchObject({ resultado: "sem_como_cobrar" });
    if (r.resultado !== "sem_como_cobrar") throw new Error("inalcançável");
    expect(r.auditoria.motivoInterno).toBe("fatura_nao_encontrada");
    // O motivo interno é NOSSO, não do IXC — nunca em `detalheDoErp`.
    expect(r.detalheDoErp).toBeUndefined();
  });
});

describe("enviarCobranca — Pix recusado por motivo FORA do Set não tenta o boleto (importante 10)", () => {
  // `fatura_fechada` NÃO serve pra este teste: o conserto do importante 5 já a
  // intercepta ANTES de chegar perto de `MOTIVOS_DE_PIX_QUE_O_BOLETO_SUPRE` — um
  // teste com ela passaria mesmo se alguém apagasse o `.has(pix.motivo)` do
  // `if`. `fatura_nao_encontrada` é o motivo que de fato exercita o Set, com
  // `temBoleto: true` pra a condição só não cair no curto-circuito de
  // `daVez.temBoleto`.
  //
  // A régua NÃO pode ser "baixarBoleto não foi chamado": pra este motivo
  // específico, a fatura genuinamente não é achada na releitura — uma segunda
  // tentativa (boleto) bateria na MESMA ausência e nunca chegaria a chamar
  // `baixarBoletoDoIxc` de qualquer jeito, gate ou não. A régua sensível é
  // CONTAR as releituras por id: com o gate, só a do Pix acontece; sem o gate,
  // o boleto tentaria ler de novo (e falharia de novo, mas teria tentado).
  it("fatura_nao_encontrada com temBoleto=true: só UMA releitura por id (hoje, apagar o `.has()` deixaria a suíte verde)", async () => {
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "telefone", created_at: "" }]);
    let releiturasPorId = 0;
    listar.mockImplementation(async (_c: unknown, p: { tabela: string; tambem?: Array<{ campo: string }> }) => {
      if (p.tabela !== "fn_areceber") return { total: 0, registros: [] };
      const eAListagemAberta = (p.tambem ?? []).some((f) => f.campo === "fn_areceber.status");
      if (eAListagemAberta) return { total: 1, registros: [fatura("901", "2026-08-20", { linha_digitavel: "0019 x" })] };
      releiturasPorId += 1;
      return { total: 0, registros: [] }; // releitura por id: não acha mais — fatura_nao_encontrada
    });
    const { portas: p } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, portas: p });
    expect(r).toMatchObject({ resultado: "sem_como_cobrar" });
    if (r.resultado !== "sem_como_cobrar") throw new Error("inalcançável");
    expect(r.auditoria.motivoInterno).toBe("fatura_nao_encontrada");
    expect(releiturasPorId).toBe(1);
    expect(baixarBoleto).not.toHaveBeenCalled();
  });
});
