/**
 * QUEM É ESTE CONTATO NO IXC — por telefone, e por documento quando o telefone
 * não resolve.
 *
 * Medido na base real (2026-09-19): 99% dos cadastros têm algum celular válido,
 * mas só 64% têm o campo `whatsapp` preenchido — por isso a busca olha os QUATRO
 * campos. E 10% dos celulares pertencem a 2+ cadastros (família, recadastro): o
 * resultado é uma LISTA, e quem decide o que fazer com dois candidatos é o
 * chamador. Esta peça não escolhe por ninguém.
 */
import type { CredencialDeConector } from "../tipos";
import { CAMPOS_DA_CONFERENCIA, CAMPOS_DO_CLIENTE } from "./campos";
import { hojeEmSaoPaulo } from "./faturas";
import { listarNoIxc } from "./http";
import { mesmoTelefone, soDigitos, telefoneParaBusca } from "./mascara";

const CAMPOS_DE_TELEFONE = ["whatsapp", "telefone_celular", "telefone_comercial", "fone"] as const;

/** Teto de candidatos: acima disto o número não identifica ninguém (telefone de recepção, placeholder). */
export const TETO_DE_CANDIDATOS = 8;

export interface ClienteIxc {
  id: string;
  nome: string;
  /** CPF/CNPJ na máscara do IXC. */
  documento: string;
  ativo: boolean;
  pessoaJuridica: boolean;
}

export function lerCliente(registro: Record<string, string>): ClienteIxc {
  return {
    id: registro.id ?? "",
    nome: (registro.razao || registro.fantasia || "").trim(),
    documento: (registro.cnpj_cpf ?? "").trim(),
    ativo: registro.ativo === "S",
    pessoaJuridica: registro.tipo_pessoa === "J",
  };
}

/**
 * `123.456.789-00` → `***.456.789-**`. O candidato ainda NÃO é o cliente da
 * conversa: o atendente precisa de o bastante para confirmar com a pessoa ("o
 * CPF termina com...?"), não do documento inteiro de um estranho.
 */
export function documentoParcial(documento: string): string {
  const d = soDigitos(documento);
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return `**.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-**`;
  return documento ? "***" : "";
}

function ativosPrimeiro(a: ClienteIxc, b: ClienteIxc): number {
  if (a.ativo !== b.ativo) return a.ativo ? -1 : 1;
  return a.nome.localeCompare(b.nome, "pt-BR");
}

export async function clientesPorTelefone(
  credencial: CredencialDeConector,
  e164: string | null | undefined,
): Promise<ClienteIxc[]> {
  const alvo = telefoneParaBusca(e164);
  if (!alvo) return [];

  const respostas = await Promise.all(
    CAMPOS_DE_TELEFONE.map((campo) =>
      listarNoIxc(credencial, {
        tabela: "cliente",
        filtro: { campo: `cliente.${campo}`, operador: "L", valor: alvo.ultimos8NaMascara },
        campos: CAMPOS_DO_CLIENTE,
        limite: 20,
      }),
    ),
  );

  const porId = new Map<string, ClienteIxc>();
  for (const { registros } of respostas) {
    for (const r of registros) {
      // O `L` casou os 8 finais em QUALQUER DDD; aqui o DDD é conferido.
      const bate = CAMPOS_DE_TELEFONE.some((campo) => mesmoTelefone(r[campo] ?? "", alvo));
      if (bate && r.id) porId.set(r.id, lerCliente(r));
    }
  }
  return [...porId.values()].sort(ativosPrimeiro);
}

/** `documentoMascarado` já vem de `documentoNaMascara()` — a busca só casa com a máscara. */
export async function clientesPorDocumento(
  credencial: CredencialDeConector,
  documentoMascarado: string,
): Promise<ClienteIxc[]> {
  const { registros } = await listarNoIxc(credencial, {
    tabela: "cliente",
    filtro: { campo: "cliente.cnpj_cpf", operador: "=", valor: documentoMascarado },
    campos: CAMPOS_DO_CLIENTE,
    limite: 20,
  });
  return registros.filter((r) => r.id).map(lerCliente).sort(ativosPrimeiro);
}

export async function clientePorId(
  credencial: CredencialDeConector,
  id: string,
): Promise<ClienteIxc | null> {
  const { registros } = await listarNoIxc(credencial, {
    tabela: "cliente",
    filtro: { campo: "cliente.id", operador: "=", valor: id },
    campos: CAMPOS_DO_CLIENTE,
    limite: 1,
  });
  const achado = registros.find((r) => r.id === id);
  return achado ? lerCliente(achado) : null;
}

/**
 * `data_nascimento` como o IXC grava. Medido em 22/09 (3 amostras de 1000): sempre
 * `AAAA-MM-DD`, e "sem data" é `0000-00-00`. Ano antes de 1900 é lixo de cadastro
 * antigo (medido: ano 1) e vale como "sem data".
 */
export function nascimentoDoIxc(bruto: string | undefined): string | null {
  const v = (bruto ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return Number(v.slice(0, 4)) >= 1900 ? v : null;
}

/**
 * A data que o cliente informou, em `AAAA-MM-DD` (aceita `DD/MM/AAAA`). `null`
 * se não existir no calendário OU se for no FUTURO — ninguém nasce depois de
 * hoje, e aceitar abriria a conferência para qualquer chute de quem não sabe a
 * data certa. `hoje` é injetável só para teste; em produção é `hojeEmSaoPaulo()`
 * — a MESMA régua de "hoje" que `faturas.ts` usa neste conector. Duas réguas de
 * data diferentes (uma em UTC, outra em São Paulo) no mesmo conector é dívida
 * que só aparece perto da virada do dia, e ninguém a pegaria no teste.
 */
export function dataInformada(bruto: string, hoje: string = hojeEmSaoPaulo()): string | null {
  const t = bruto.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : t;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number(iso.slice(0, 4)) < 1900) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return iso > hoje ? null : iso;
}

/**
 * A data bruta do IXC tem forma que `nascimentoDoIxc` não reconhece — e isso é
 * DIFERENTE de "não tem data". Vazio, `0000-00-00` e ano < 1900 são ausência
 * CONHECIDA (o próprio `nascimentoDoIxc` os trata como "sem data" — comentário
 * acima); o que sobra — um formato que esta imagem nunca viu, por exemplo um
 * clone que grava `DD/MM/AAAA` — é ILEGÍVEL: o dado existe, mas não dá para ler.
 * `cadastrosQueConferem` usa isto só para AVISAR o log, nunca para mudar o que o
 * cliente recebe.
 */
function dataEhIlegivel(bruto: string | undefined): boolean {
  const v = (bruto ?? "").trim();
  if (v === "") return false;
  return !/^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10));
}

export interface ConferenciaDeCadastro {
  cadastros: ClienteIxc[];
  /**
   * Existe cadastro DESTE CPF cuja data de nascimento não é legível (ver
   * `dataEhIlegivel`) — sinal para o LOG do turno, não para o cliente: a recusa
   * dele continua sendo a MESMA lista vazia de sempre (nunca se diz qual dado
   * falhou). Sem isto, um ERP que grave a data de outro jeito faria 100% das
   * conferências recusarem em silêncio, sem pista nenhuma de por quê.
   */
  dataIlegivel: boolean;
}

/**
 * Os cadastros deste CPF/CNPJ cuja data de nascimento é a informada.
 *
 * `cadastros` vazio para TODA recusa — CPF inexistente, data diferente,
 * cadastro sem data —, de propósito: o CLIENTE não consegue distinguir, e por
 * isso não tem como saber qual dos dois dados não conferiu. A data é lida,
 * comparada e descartada: nunca entra em `ClienteIxc`.
 */
export async function cadastrosQueConferem(
  credencial: CredencialDeConector,
  documentoMascarado: string,
  nascimento: string,
): Promise<ConferenciaDeCadastro> {
  const { registros } = await listarNoIxc(credencial, {
    tabela: "cliente",
    filtro: { campo: "cliente.cnpj_cpf", operador: "=", valor: documentoMascarado },
    campos: CAMPOS_DA_CONFERENCIA,
    limite: 20,
  });
  const doCpf = registros.filter((r) => r.id);
  return {
    cadastros: doCpf
      .filter((r) => nascimentoDoIxc(r.data_nascimento) === nascimento)
      .map(lerCliente)
      .sort(ativosPrimeiro),
    dataIlegivel: doCpf.some((r) => dataEhIlegivel(r.data_nascimento)),
  };
}
