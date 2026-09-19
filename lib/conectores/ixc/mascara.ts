/**
 * MÁSCARAS — o IXC guarda telefone e documento COM a pontuação, e só casa busca
 * com a pontuação. Medido em 2026-09-19: `cnpj_cpf = "12345678900"` devolve
 * zero; `"123.456.789-00"` devolve o cadastro. O mesmo para telefone.
 */

export function soDigitos(valor: string | null | undefined): string {
  return (valor ?? "").replace(/\D/g, "");
}

/**
 * CPF (11) ou CNPJ (14) na máscara do IXC; `null` se não for nenhum dos dois.
 * Confere os dígitos verificadores: o atendente digita isto com o cliente no
 * telefone, e um dígito trocado viraria "cliente não encontrado" — uma afirmação
 * sobre o ERP feita em cima de um erro de digitação.
 */
export function documentoNaMascara(bruto: string): string | null {
  const d = soDigitos(bruto);
  if (d.length === 11 && cpfValido(d)) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  if (d.length === 14 && cnpjValido(d)) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return null;
}

function cpfValido(d: string): boolean {
  if (/^(\d)\1{10}$/.test(d)) return false;
  const dv = (ate: number) => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

function cnpjValido(d: string): boolean {
  if (/^(\d)\1{13}$/.test(d)) return false;
  const dv = (ate: number) => {
    const pesos = ate === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (pesos[i] ?? 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}

export interface TelefoneParaBusca {
  ddd: string;
  /** Os 8 últimos dígitos, sem o nono. */
  ultimos8: string;
  /** Os 8 últimos na máscara do IXC — `9999-9999` — que é o que o `L` procura. */
  ultimos8NaMascara: string;
}

/**
 * Do E.164 do contato (`+5511987654321`) ao que dá para procurar no IXC.
 *
 * Por que os ÚLTIMOS 8: a base tem o mesmo celular gravado com e sem o nono
 * dígito (`(11) 98765-4321` e `(11) 8765-4321`), e `LIKE '%8765-4321'` casa os
 * dois com uma busca só. O preço é casar também o mesmo final em OUTRO DDD —
 * por isso o DDD volta junto, e quem chama confere (`mesmoTelefone`).
 *
 * `null` para número que não é brasileiro ou não tem forma de telefone: o
 * chamador cai no caminho do documento em vez de procurar lixo.
 */
export function telefoneParaBusca(e164: string | null | undefined): TelefoneParaBusca | null {
  const d = soDigitos(e164);
  if (!d.startsWith("55")) return null;
  const nacional = d.slice(2);
  if (nacional.length !== 10 && nacional.length !== 11) return null;
  const ddd = nacional.slice(0, 2);
  if (!/^[1-9][0-9]$/.test(ddd)) return null;
  const ultimos8 = nacional.slice(-8);
  return { ddd, ultimos8, ultimos8NaMascara: `${ultimos8.slice(0, 4)}-${ultimos8.slice(4)}` };
}

/** O telefone gravado no IXC é o mesmo da conversa? DDD igual e 8 finais iguais. */
export function mesmoTelefone(gravadoNoIxc: string, alvo: TelefoneParaBusca): boolean {
  const d = soDigitos(gravadoNoIxc);
  if (d.length !== 10 && d.length !== 11) return false;
  return d.slice(0, 2) === alvo.ddd && d.slice(-8) === alvo.ultimos8;
}
