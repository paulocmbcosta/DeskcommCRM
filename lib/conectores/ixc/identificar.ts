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
import { CAMPOS_DO_CLIENTE } from "./campos";
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
