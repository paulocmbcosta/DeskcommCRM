/**
 * QUAIS FATURAS O PAINEL MOSTRA — a regra do dono do produto, por escrito:
 *
 *   TODAS as vencidas + a PRÓXIMA a vencer + MAIS UMA. O resto vira contagem.
 *
 * No IXC, fatura "em aberto" (`status = A`) não quer dizer vencida: o carnê é
 * gerado com meses de antecedência, e a maioria das abertas é parcela FUTURA
 * (medido: das 1000 faturas mais novas, 778 abertas, e só 251 com boleto
 * registrado). Doze parcelas a vencer na tela confundem o atendente e fariam a IA
 * dizer "você tem 12 faturas em aberto" a quem está em dia. Quem quer o carnê
 * inteiro abre o IXC.
 *
 * "Hoje" é a data em São Paulo, não em UTC: às 22h de um dia 10, em UTC já é dia
 * 11, e a fatura que vence dia 10 apareceria como vencida para quem ainda tem
 * duas horas para pagar.
 */
export const PROXIMAS_A_MOSTRAR = 2;

export type SituacaoDaFatura = "vencida" | "a_vencer";

export interface Fatura {
  id: string;
  idContrato: string;
  /** `YYYY-MM-DD`, como o IXC devolve. */
  vencimento: string;
  valorCents: number;
  situacao: SituacaoDaFatura;
  diasDeAtraso: number;
  /** Vazio quando o boleto ainda não foi registrado no gateway. */
  linhaDigitavel: string;
  /**
   * As FORMAS que o IXC já tem prontas para esta fatura. Parcela futura costuma
   * não ter nenhuma: o carnê é gerado com meses de antecedência e o registro no
   * gateway só acontece perto do vencimento. Pedir `get_boleto`/`get_pix` de uma
   * fatura sem registro faria o IXC registrar a cobrança — efeito que ninguém
   * pediu —, então a tela só oferece o que já existe.
   */
  temBoleto: boolean;
  temPix: boolean;
  /** Tem o que enviar? Sem boleto E sem Pix registrados, a fatura é só uma linha. */
  enviavel: boolean;
}

export const FORMAS_DE_COBRANCA = ["boleto", "pix"] as const;
export type FormaDeCobranca = (typeof FORMAS_DE_COBRANCA)[number];

export interface RecorteDeFaturas {
  vencidas: Fatura[];
  proximas: Fatura[];
  /** Parcelas futuras além das mostradas — a tela diz quantas, não quais. */
  outrasAVencer: number;
  totalVencidoCents: number;
}

export function hojeEmSaoPaulo(agora: Date = new Date()): string {
  // `en-CA` formata como YYYY-MM-DD, que é a forma do IXC e ordena como texto.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
}

/** `"129.90"` → 12990. Sem float na soma: dinheiro é inteiro em centavos. */
export function reaisParaCents(bruto: string): number {
  const limpo = (bruto ?? "").trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(limpo)) return 0;
  const [inteiro = "0", fracao = ""] = limpo.replace("-", "").split(".");
  const cents = Number(inteiro) * 100 + Number((fracao + "00").slice(0, 2));
  return limpo.startsWith("-") ? -cents : cents;
}

function diasEntre(deYmd: string, ateYmd: string): number {
  const de = Date.parse(`${deYmd}T00:00:00Z`);
  const ate = Date.parse(`${ateYmd}T00:00:00Z`);
  if (Number.isNaN(de) || Number.isNaN(ate)) return 0;
  return Math.round((ate - de) / 86_400_000);
}

export function lerFatura(registro: Record<string, string>, hoje: string): Fatura | null {
  const vencimento = (registro.data_vencimento ?? "").slice(0, 10);
  // `0000-00-00` é o "nunca" do IXC: tem forma de data, ordena antes de qualquer
  // hoje, e viraria "vencida há 0 dias" na tela.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento) || vencimento.startsWith("0000") || !registro.id) return null;
  // `valor_aberto` é o que FALTA pagar (fatura com pagamento parcial); `valor` é
  // a fatura cheia. Cobrar o cheio de quem já pagou metade é o erro caro.
  const aberto = reaisParaCents(registro.valor_aberto ?? "");
  const valorCents = aberto > 0 ? aberto : reaisParaCents(registro.valor ?? "");
  const vencida = vencimento < hoje;
  const linhaDigitavel = (registro.linha_digitavel ?? "").trim();
  const temBoleto = linhaDigitavel !== "";
  const temPix = (registro.pix_txid ?? "").trim() !== "";
  return {
    id: registro.id,
    idContrato: registro.id_contrato ?? "",
    vencimento,
    valorCents,
    situacao: vencida ? "vencida" : "a_vencer",
    diasDeAtraso: vencida ? diasEntre(vencimento, hoje) : 0,
    linhaDigitavel,
    temBoleto,
    temPix,
    enviavel: temBoleto || temPix,
  };
}

/** Recebe as faturas ABERTAS do cliente (qualquer ordem) e aplica a regra. */
export function recortarFaturas(registros: Record<string, string>[], hoje: string): RecorteDeFaturas {
  const lidas = registros
    .map((r) => lerFatura(r, hoje))
    .filter((f): f is Fatura => f !== null)
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  const vencidas = lidas.filter((f) => f.situacao === "vencida");
  const aVencer = lidas.filter((f) => f.situacao === "a_vencer");
  return {
    vencidas,
    proximas: aVencer.slice(0, PROXIMAS_A_MOSTRAR),
    outrasAVencer: Math.max(0, aVencer.length - PROXIMAS_A_MOSTRAR),
    totalVencidoCents: vencidas.reduce((soma, f) => soma + f.valorCents, 0),
  };
}
