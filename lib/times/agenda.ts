/**
 * Lê uma agenda `{timezone, windows}` sem NUNCA lançar.
 *
 * A coluna é `jsonb` sem CHECK e a escrita não valida conteúdo, então o banco
 * aceita o que o parser recusa — `America/Asunción`, com o acento que um
 * hispanofalante escreve natural, é o caso real que já custou um bug a esta base.
 *
 * Todo leitor de agenda passa por aqui: o catálogo de times, a elegibilidade do
 * TIME, a do ATENDENTE no roteamento e no roster do painel, e a escalação do
 * motor. Cada um deles fazia `.parse()`, e UM registro ruim derrubava a leitura
 * inteira — não a linha dele: o roteamento da organização, a lista do painel, a
 * promessa que o agente faz ao cliente no meio da conversa. Para a lista em
 * vigor, sem acreditar nesta linha: `grep -rln lerAgenda lib`.
 *
 * `valida: false` é tratado como FECHADO por quem chama, nunca como 24/7:
 * fechado é visível (a conversa espera na fila e a Central avisa), "sem
 * restrição" é uma mentira sem sintoma. Mesmo formato do "Resolvedor NUNCA
 * lança" do branding.
 */
import { availabilityScheduleSchema, type AvailabilitySchedule } from "@/lib/schemas/routing";

export interface AgendaLida {
  agenda: AvailabilitySchedule;
  /** false = o banco tem algo que o parser não lê. Quem chama trata como FECHADO. */
  valida: boolean;
}

export function lerAgenda(bruto: unknown): AgendaLida {
  const r = availabilityScheduleSchema.safeParse(bruto ?? {});
  if (r.success) return { agenda: r.data, valida: true };
  return { agenda: { timezone: "America/Sao_Paulo", windows: [] }, valida: false };
}
