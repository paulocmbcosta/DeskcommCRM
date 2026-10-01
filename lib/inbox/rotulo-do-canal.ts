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

/**
 * O que cabe no SELO do card: os quatro últimos dígitos do número da empresa.
 *
 * O card tem ~270px de texto, e "Totus · 3025" ao lado de um time de nome
 * comprido quebrava o rodapé em duas linhas. O apelido saiu do card (segue no
 * `title`, no painel e no filtro, onde há espaço): com dois números da mesma
 * empresa ele é a MESMA palavra nos dois, e quem desempata são os dígitos.
 *
 * Sem número (canal recém-criado), o apelido — cortado, porque o selo não
 * encolhe e um apelido longo empurraria o time para fora da linha.
 */
const LIMITE_DO_APELIDO_NO_SELO = 10;

export function finalDoCanal(canal: CanalRotulavel | null | undefined): string | null {
  if (!canal) return null;
  const final = (preenchido(canal.phone_number) ?? "").replace(/\D/g, "").slice(-4);
  if (final) return final;
  const apelido = preenchido(canal.display_name);
  if (!apelido) return null;
  return apelido.length > LIMITE_DO_APELIDO_NO_SELO
    ? `${apelido.slice(0, LIMITE_DO_APELIDO_NO_SELO).trimEnd()}…`
    : apelido;
}

/** Por extenso, para `title` e leitor de tela: o número inteiro quando existe. */
export function canalPorExtenso(canal: CanalRotulavel | null | undefined): string | null {
  if (!canal) return null;
  return preenchido(canal.phone_number) ?? preenchido(canal.display_name);
}

/**
 * Para ESCOLHER um canal numa lista (o filtro de número do Inbox): apelido E
 * número inteiro. Dois números oficiais da Meta com o mesmo nome verificado
 * ("Totus" e "Totus") eram indistinguíveis no seletor — e ali, diferente do
 * card, há espaço para o número inteiro, e é ele que a pessoa reconhece.
 */
export function canalComNumero(canal: CanalRotulavel | null | undefined): string | null {
  if (!canal) return null;
  const apelido = preenchido(canal.display_name);
  const numero = preenchido(canal.phone_number);
  if (apelido && numero) return `${apelido} · ${numero}`;
  return apelido ?? numero;
}
