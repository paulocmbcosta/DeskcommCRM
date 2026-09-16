/**
 * Lê uma agenda `{timezone, windows}` sem NUNCA lançar.
 *
 * A coluna é `jsonb` sem CHECK e a escrita não valida conteúdo, então o banco
 * aceita o que o parser recusa — `America/Asunción`, com o acento que um
 * hispanofalante escreve natural, é o caso real que já custou um bug a esta base.
 *
 * Três pontos liam isso com `.parse()`: o catálogo de times, a elegibilidade do
 * TIME e a elegibilidade do ATENDENTE. Um registro ruim derrubava os três — e o
 * terceiro leva junto o roteamento da organização inteira.
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
