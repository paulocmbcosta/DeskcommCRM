/**
 * COMO SE CHAMA O CANAL POR ONDE A CONVERSA ENTROU — uma regra, um lugar.
 *
 * "MP wp · 1037": o apelido diz QUAL linha é; os quatro dígitos desempatam dois
 * canais com o mesmo apelido (dois "Suporte" existem). Sem apelido, o número
 * inteiro; sem número (canal recém-criado, ou canal que não é telefone — o
 * Instagram de amanhã), o apelido. Sem nenhum dos dois, `null`: rótulo vazio é
 * pior que rótulo ausente.
 *
 * Três lugares mostram isto — o card da lista, a ficha do painel e o histórico
 * de atendimentos —, e foi por cada tela remontar a própria cadeia que o nome do
 * CONTATO já teve quatro finais diferentes (`lib/contacts/rotulo-do-contato.ts`).
 *
 * É o apelido do CANAL (`channel_sessions`), não o nome de uma pessoa.
 */
export interface CanalRotulavel {
  phone_number?: string | null;
  display_name?: string | null;
}

function preenchido(valor: string | null | undefined): string | null {
  const limpo = valor?.trim() ?? "";
  return limpo === "" ? null : limpo;
}

export function rotuloDoCanal(canal: CanalRotulavel | null | undefined): string | null {
  if (!canal) return null;
  const apelido = preenchido(canal.display_name);
  const numero = preenchido(canal.phone_number);
  if (apelido && numero) {
    const final = numero.replace(/\D/g, "").slice(-4);
    return final ? `${apelido} · ${final}` : apelido;
  }
  return apelido ?? numero;
}

/** Por extenso, para `title` e leitor de tela: o número inteiro quando existe. */
export function canalPorExtenso(canal: CanalRotulavel | null | undefined): string | null {
  if (!canal) return null;
  return preenchido(canal.phone_number) ?? preenchido(canal.display_name);
}
