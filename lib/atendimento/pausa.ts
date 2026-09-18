/**
 * A PAUSA DO ATENDENTE (migration 0267) — vocabulário e regra de leitura.
 *
 * `attendant_pause_log.reason` é `text` SEM check constraint, de propósito: os
 * motivos de pausa de uma operação mudam, e um CHECK prenderia o produto ao
 * vocabulário do primeiro cliente. O conjunto PADRÃO vive aqui, e a tela só
 * oferece estes — mas o banco aceita o que uma integração futura mandar, e
 * `rotuloDoMotivoDePausa` devolve o próprio valor quando não o conhece, em vez
 * de esconder uma pausa que aconteceu.
 */
import { z } from "zod";

import { isHeartbeatStale } from "@/lib/routing/eligibility";

export const MOTIVOS_DE_PAUSA = [
  { valor: "banheiro", rotulo: "Banheiro" },
  { valor: "almoco", rotulo: "Almoço" },
  { valor: "intervalo", rotulo: "Intervalo" },
  { valor: "reuniao", rotulo: "Reunião" },
  { valor: "treinamento", rotulo: "Treinamento" },
  { valor: "outro", rotulo: "Outro" },
] as const;

export type MotivoDePausa = (typeof MOTIVOS_DE_PAUSA)[number]["valor"];

export function rotuloDoMotivoDePausa(valor: string | null | undefined): string {
  if (!valor) return "Pausa";
  return MOTIVOS_DE_PAUSA.find((m) => m.valor === valor)?.rotulo ?? valor;
}

export const STATUS_DO_ATENDENTE = ["online", "paused", "offline"] as const;
export type StatusDoAtendente = (typeof STATUS_DO_ATENDENTE)[number];

/**
 * O corpo do POST. O motivo é obrigatório NA PAUSA — é o que torna a pausa
 * rastreável, e o banco recusa sem ele (`attendant_pause_reason_required`). "Outro"
 * pede a observação: "outro" sozinho é o mesmo que motivo nenhum.
 */
export const statusDoAtendenteSchema = z
  .object({
    status: z.enum(STATUS_DO_ATENDENTE),
    reason: z.string().trim().min(1).max(40).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.status === "paused" && !v.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Escolha o motivo da pausa." });
    }
    if (v.status === "paused" && v.reason === "outro" && !v.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Descreva o motivo da pausa." });
    }
  });
export type StatusDoAtendenteInput = z.infer<typeof statusDoAtendenteSchema>;

export interface LinhaDeDisponibilidade {
  is_available: boolean;
  paused_at?: string | null;
  last_heartbeat_at?: string | null;
}

/**
 * O STATUS que a tela mostra, derivado — não há coluna `status`.
 *
 * A pausa vem PRIMEIRO: quem está em pausa está indisponível por definição, e
 * "offline" diria menos do que se sabe. "Online" exige sinal de vida recente: a
 * aba fechada sem clicar em nada deixa `is_available=true` até o cron varrer, e
 * nesse intervalo afirmar "online" seria prometer alguém que não está lá — a
 * mesma régua que o painel de Equipe já usa (`isHeartbeatStale`).
 */
export function statusDoAtendente(linha: LinhaDeDisponibilidade | null | undefined, agora: Date): StatusDoAtendente {
  if (!linha) return "offline";
  if (linha.paused_at) return "paused";
  if (linha.is_available && !isHeartbeatStale(linha.last_heartbeat_at ?? null, agora)) return "online";
  return "offline";
}
