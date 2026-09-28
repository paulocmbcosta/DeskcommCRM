/**
 * PARA ONDE O CRM ACEITA LIGAR — a política antifraude da ligação de saída.
 *
 * Fraude de ligação é o risco nº 1 de qualquer PABX ligado à rede pública
 * (spec 20 §6): quem consegue discar pelo tronco do cliente disca para número
 * internacional ou tarifado e a conta chega para ele. O ramal do navegador não
 * disca nada sozinho — toda ligação de saída passa por aqui ANTES de existir.
 *
 * O que passa: número geográfico brasileiro, fixo ou celular, com DDD. O que
 * não passa, por padrão:
 *   - internacional (`+` que não é `+55`, ou `00…`);
 *   - não geográfico: 0300/0303 (custo dividido), 0500 (doação), 0900
 *     (tarifado), e também 0800 e 400x — não são fraude, mas não têm DDD nem
 *     dono identificável, e ligar para eles do CRM não é o caso de uso;
 *   - serviço curto (190, 192, 100…) e qualquer coisa sem DDD.
 *
 * A grafia que a operadora recebe é DDD + número, sem 55 e sem 0: foi o que a
 * operadora da Totus completou na prova de conceito (spec 20 §1).
 */

/** DDDs brasileiros em uso (Anatel). Fora desta lista não é número geográfico. */
const DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export type MotivoDeRecusa =
  | "vazio"
  | "internacional"
  | "nao_geografico"
  | "sem_ddd"
  | "ddd_invalido"
  | "invalido";

export type NumeroParaLigar =
  | {
      ok: true;
      /** `+55` + DDD + número — como `contacts.phone_number` guarda. */
      e164: string;
      /** DDD + número, só dígitos — o que vai para a operadora. */
      discar: string;
    }
  | { ok: false; motivo: MotivoDeRecusa };

/** Texto de tela de cada recusa, na voz de quem opera o CRM. */
export const MENSAGEM_DA_RECUSA: Record<MotivoDeRecusa, string> = {
  vazio: "Digite um número.",
  internacional: "Ligação internacional está bloqueada.",
  nao_geografico: "Números 0300, 0500, 0800, 0900 e 400x não podem ser discados daqui.",
  sem_ddd: "Inclua o DDD.",
  ddd_invalido: "Esse DDD não existe.",
  invalido: "Esse número não parece um telefone brasileiro.",
};

export function numeroParaLigar(bruto: string | null | undefined): NumeroParaLigar {
  const texto = (bruto ?? "").trim();
  if (texto === "") return { ok: false, motivo: "vazio" };

  let d = texto.replace(/\D/g, "");
  if (d === "") return { ok: false, motivo: "vazio" };

  if (texto.startsWith("+")) {
    if (!d.startsWith("55")) return { ok: false, motivo: "internacional" };
    d = d.slice(2);
  } else if (d.startsWith("00")) {
    return { ok: false, motivo: "internacional" };
  } else if (/^0[3-9]00/.test(d) || /^0303/.test(d)) {
    return { ok: false, motivo: "nao_geografico" };
  } else if (d.startsWith("0")) {
    // 0 + DDD + número, ou 0 + código da operadora (2 dígitos) + DDD + número.
    d = d.slice(1);
    if (d.length === 12 || d.length === 13) d = d.slice(2);
  } else if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    d = d.slice(2);
  }

  if (/^[34]00[0-9]/.test(d) && d.length === 8) return { ok: false, motivo: "nao_geografico" };
  if (d.length < 10) return { ok: false, motivo: "sem_ddd" };
  if (d.length > 11) return { ok: false, motivo: "invalido" };

  const ddd = Number(d.slice(0, 2));
  if (!DDDS.has(ddd)) return { ok: false, motivo: "ddd_invalido" };

  const local = d.slice(2);
  const fixo = local.length === 8 && /^[2-5]/.test(local);
  const celular = local.length === 9 && local.startsWith("9");
  if (!fixo && !celular) return { ok: false, motivo: "invalido" };

  return { ok: true, e164: `+55${d}`, discar: d };
}

/**
 * O número de quem LIGOU, como a operadora entrega na bina, em E.164.
 *
 * Diferente de `numeroParaLigar`: aqui não há política — quem liga é quem liga,
 * e recusar a bina não impede a ligação de chegar. Só normaliza as grafias
 * nacionais para o contato ser achado pelas mesmas chaves do WhatsApp. Bina
 * vazia, anônima ou irreconhecível devolve `null` (a ligação segue, sem contato).
 */
export function binaParaE164(bruto: string | null | undefined): string | null {
  const texto = (bruto ?? "").trim();
  if (texto === "" || /anonymous|restricted|unknown|privado/i.test(texto)) return null;
  let d = texto.replace(/\D/g, "");
  if (d.length < 8) return null;
  if (texto.startsWith("+")) return `+${d}`;
  if (d.startsWith("00")) return `+${d.slice(2)}`;
  if (d.startsWith("0")) {
    d = d.slice(1);
    if (d.length === 12 || d.length === 13) d = d.slice(2);
  }
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return `+${d}`;
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  return `+${d}`;
}
