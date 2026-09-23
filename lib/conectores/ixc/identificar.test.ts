import { beforeEach, describe, expect, it, vi } from "vitest";

const listar = vi.fn();
vi.mock("./http", () => ({ listarNoIxc: (...args: unknown[]) => listar(...args) }));

import {
  cadastrosQueConferem,
  clientesPorDocumento,
  clientesPorTelefone,
  dataInformada,
  documentoParcial,
  nascimentoDoIxc,
} from "./identificar";
import { documentoNaMascara, mesmoTelefone, telefoneParaBusca } from "./mascara";

const CRED = { baseUrl: "https://erp.exemplo.com.br", token: "1:x" };

function cliente(id: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    id,
    razao: `Cliente ${id}`,
    fantasia: "",
    cnpj_cpf: "529.982.247-25",
    tipo_pessoa: "F",
    ativo: "S",
    telefone_celular: "",
    whatsapp: "",
    telefone_comercial: "",
    fone: "",
    ...extra,
  };
}

// Chaves, não expressão: `mockReset()` devolve o próprio mock (é encadeável), e o
// Vitest trata um `beforeEach` que RETORNA função como teardown implícito — ele
// chamaria `listar()` de novo depois do teste, SEM ARGUMENTO NENHUM. Inofensivo
// enquanto os testes usavam `mockResolvedValue` (ignora o que recebe); virou
// `TypeError` no primeiro teste que leu um argumento dentro do mock.
beforeEach(() => {
  listar.mockReset();
});

describe("telefoneParaBusca — do E.164 do contato ao que o IXC consegue procurar", () => {
  it("usa os 8 finais NA MÁSCARA, que é como o IXC guarda", () => {
    expect(telefoneParaBusca("+5511987654321")).toEqual({ ddd: "11", ultimos8: "87654321", ultimos8NaMascara: "8765-4321" });
  });

  it("número sem o nono dígito procura pelos MESMOS 8 finais", () => {
    expect(telefoneParaBusca("+551187654321")?.ultimos8NaMascara).toBe("8765-4321");
  });

  it.each(["+14155552671", "+5511", "", null, undefined])("%s não é procurável → null", (n) => {
    expect(telefoneParaBusca(n)).toBeNull();
  });
});

describe("mesmoTelefone — o `L` do IXC casa qualquer DDD; aqui o DDD é conferido", () => {
  const alvo = telefoneParaBusca("+5511987654321")!;
  it("casa com e sem o nono dígito", () => {
    expect(mesmoTelefone("(11) 98765-4321", alvo)).toBe(true);
    expect(mesmoTelefone("(11) 8765-4321", alvo)).toBe(true);
  });
  it("mesmo final em OUTRO DDD é outra pessoa", () => {
    expect(mesmoTelefone("(21) 98765-4321", alvo)).toBe(false);
  });
  it("campo vazio ou placeholder não casa", () => {
    expect(mesmoTelefone("", alvo)).toBe(false);
    expect(mesmoTelefone("(11) 4321", alvo)).toBe(false);
  });
});

describe("clientesPorTelefone", () => {
  it("procura nos QUATRO campos — só 64% da base real tem o campo whatsapp", async () => {
    listar.mockResolvedValue({ total: 0, registros: [] });
    await clientesPorTelefone(CRED, "+5511987654321");

    const campos = listar.mock.calls.map((c) => (c[1] as { filtro: { campo: string; operador: string; valor: string } }).filtro);
    expect(campos.map((f) => f.campo).sort()).toEqual([
      "cliente.fone",
      "cliente.telefone_celular",
      "cliente.telefone_comercial",
      "cliente.whatsapp",
    ]);
    expect(new Set(campos.map((f) => f.operador))).toEqual(new Set(["L"]));
    expect(new Set(campos.map((f) => f.valor))).toEqual(new Set(["8765-4321"]));
  });

  it("descarta quem tem o mesmo final em outro DDD, e não duplica quem aparece em dois campos", async () => {
    const maria = cliente("10", { whatsapp: "(11) 98765-4321", telefone_celular: "(11) 98765-4321" });
    const doRio = cliente("20", { telefone_celular: "(21) 98765-4321" });
    listar.mockResolvedValue({ total: 2, registros: [maria, doRio] });

    const achados = await clientesPorTelefone(CRED, "+5511987654321");
    expect(achados.map((c) => c.id)).toEqual(["10"]);
  });

  it("dois cadastros com o mesmo celular voltam OS DOIS — ativo primeiro; quem escolhe é o chamador", async () => {
    const inativo = cliente("30", { razao: "Ana", ativo: "N", telefone_celular: "(11) 98765-4321" });
    const ativo = cliente("31", { razao: "Zeca", ativo: "S", fone: "(11) 8765-4321" });
    listar.mockResolvedValue({ total: 2, registros: [inativo, ativo] });

    const achados = await clientesPorTelefone(CRED, "+5511987654321");
    expect(achados.map((c) => c.id)).toEqual(["31", "30"]);
  });

  it("telefone que não é brasileiro nem chama o IXC", async () => {
    expect(await clientesPorTelefone(CRED, "+14155552671")).toEqual([]);
    expect(listar).not.toHaveBeenCalled();
  });
});

describe("documento", () => {
  it("o IXC só casa COM a máscara", () => {
    expect(documentoNaMascara("52998224725")).toBe("529.982.247-25");
    expect(documentoNaMascara("529.982.247-25")).toBe("529.982.247-25");
    expect(documentoNaMascara("11222333000181")).toBe("11.222.333/0001-81");
  });

  it("dígito verificador errado é recusado ANTES de virar 'cliente não encontrado'", () => {
    expect(documentoNaMascara("52998224724")).toBeNull();
    expect(documentoNaMascara("11111111111")).toBeNull();
    expect(documentoNaMascara("11222333000180")).toBeNull();
    expect(documentoNaMascara("123")).toBeNull();
  });

  it("busca pelo documento mascarado, com igualdade", async () => {
    listar.mockResolvedValue({ total: 1, registros: [cliente("40")] });
    const achados = await clientesPorDocumento(CRED, "529.982.247-25");
    expect(achados[0]?.id).toBe("40");
    expect((listar.mock.calls[0]![1] as { filtro: unknown }).filtro).toEqual({
      campo: "cliente.cnpj_cpf",
      operador: "=",
      valor: "529.982.247-25",
    });
  });

  it("o candidato mostra só o MEIO do documento — ele ainda não é o cliente da conversa", () => {
    expect(documentoParcial("529.982.247-25")).toBe("***.982.247-**");
    expect(documentoParcial("11.222.333/0001-81")).toBe("**.222.333/0001-**");
    expect(documentoParcial("")).toBe("");
  });
});

describe("data de nascimento — como o IXC grava (medido em 22/09)", () => {
  it("AAAA-MM-DD vale; 0000-00-00, vazio e ano < 1900 são 'sem data'", () => {
    expect(nascimentoDoIxc("1985-03-12")).toBe("1985-03-12");
    expect(nascimentoDoIxc("0000-00-00")).toBeNull();
    expect(nascimentoDoIxc("")).toBeNull();
    expect(nascimentoDoIxc(undefined)).toBeNull();
    expect(nascimentoDoIxc("0001-01-01")).toBeNull();
  });

  it("a data que o cliente informa: AAAA-MM-DD ou DD/MM/AAAA, e tem de existir no calendário", () => {
    expect(dataInformada("1985-03-12")).toBe("1985-03-12");
    expect(dataInformada("12/03/1985")).toBe("1985-03-12");
    expect(dataInformada("1985-02-30")).toBeNull();
    expect(dataInformada("12/3/85")).toBeNull();
    expect(dataInformada("ontem")).toBeNull();
  });

  it("recusa data no FUTURO — ninguém nasce depois de hoje", () => {
    expect(dataInformada("2026-09-23", "2026-09-22")).toBeNull();
    expect(dataInformada("2026-09-22", "2026-09-22")).toBe("2026-09-22");
    expect(dataInformada("2026-09-21", "2026-09-22")).toBe("2026-09-21");
  });

  it("anos bissextos: 29/02/2000 vale (bissexto — divisível por 400); 29/02/1900 e 29/02/2001 não", () => {
    expect(dataInformada("29/02/2000")).toBe("2000-02-29");
    expect(dataInformada("29/02/1900")).toBeNull();
    expect(dataInformada("29/02/2001")).toBeNull();
  });

  it("espaços nas pontas não atrapalham", () => {
    expect(dataInformada("  1985-03-12  ")).toBe("1985-03-12");
    expect(nascimentoDoIxc("  1985-03-12  ")).toBe("1985-03-12");
  });

  it("nascimentoDoIxc aceita a data com hora grudada — só os 10 primeiros caracteres importam", () => {
    expect(nascimentoDoIxc("1985-03-12 00:00:00")).toBe("1985-03-12");
  });

  it("o piso do ano é 1900: 1899 recusa, 1900 aceita — nos dois lados (IXC e informada)", () => {
    expect(nascimentoDoIxc("1899-12-31")).toBeNull();
    expect(nascimentoDoIxc("1900-01-01")).toBe("1900-01-01");
    expect(dataInformada("1899-12-31")).toBeNull();
    expect(dataInformada("1900-01-01")).toBe("1900-01-01");
  });
});

describe("cadastrosQueConferem — CPF + nascimento, resposta única para toda recusa", () => {
  const MARIA = { id: "10", razao: "Maria da Silva", cnpj_cpf: "529.982.247-25", tipo_pessoa: "F", ativo: "S", data_nascimento: "1985-03-12", senha: "x" };
  const CRED = { baseUrl: "https://erp.exemplo.com.br", token: "1:x" };

  it("confere quando CPF e data batem, e a data NÃO sai no ClienteIxc", async () => {
    listar.mockImplementation(async (_c: unknown, p: { campos: readonly string[] }) => ({
      total: 1,
      registros: [Object.fromEntries(p.campos.map((c) => [c, (MARIA as Record<string, string>)[c] ?? ""]))],
    }));
    const { cadastros, dataIlegivel } = await cadastrosQueConferem(CRED, "529.982.247-25", "1985-03-12");
    expect(cadastros.map((c) => c.id)).toEqual(["10"]);
    expect(dataIlegivel).toBe(false);
    expect(JSON.stringify(cadastros)).not.toContain("1985");
    // pediu a data, e só pela lista da conferência
    expect(listar.mock.calls.at(-1)?.[1].campos).toContain("data_nascimento");
  });

  it("data diferente e cadastro sem data dão a MESMA lista vazia, sem acusar ilegibilidade", async () => {
    listar.mockResolvedValueOnce({ total: 1, registros: [{ ...MARIA, data_nascimento: "1990-01-01" }] });
    expect(await cadastrosQueConferem(CRED, "529.982.247-25", "1985-03-12")).toEqual({ cadastros: [], dataIlegivel: false });
    listar.mockResolvedValueOnce({ total: 1, registros: [{ ...MARIA, data_nascimento: "0000-00-00" }] });
    expect(await cadastrosQueConferem(CRED, "529.982.247-25", "1985-03-12")).toEqual({ cadastros: [], dataIlegivel: false });
    listar.mockResolvedValueOnce({ total: 0, registros: [] });
    expect(await cadastrosQueConferem(CRED, "529.982.247-25", "1985-03-12")).toEqual({ cadastros: [], dataIlegivel: false });
  });

  it("ano de cadastro antigo (< 1900) é ausência conhecida, como 0000-00-00 — não é ilegível", async () => {
    listar.mockResolvedValueOnce({ total: 1, registros: [{ ...MARIA, data_nascimento: "0001-01-01" }] });
    expect(await cadastrosQueConferem(CRED, "529.982.247-25", "1985-03-12")).toEqual({ cadastros: [], dataIlegivel: false });
  });

  it("data num formato que esta imagem não reconhece sinaliza dataIlegivel — o CLIENTE recebe a MESMA recusa (lista vazia)", async () => {
    listar.mockResolvedValueOnce({ total: 1, registros: [{ ...MARIA, data_nascimento: "12/03/1985" }] });
    expect(await cadastrosQueConferem(CRED, "529.982.247-25", "1985-03-12")).toEqual({ cadastros: [], dataIlegivel: true });
  });
});
