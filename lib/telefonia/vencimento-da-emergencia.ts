/**
 * O PRAZO DO AVISO DE INSTABILIDADE (desenho da fase 2, D8) — puro e client-safe.
 *
 * Quem liga escolhe a duração (1 h, 2 h por padrão, 4 h ou "até eu desligar").
 * Vencido, o aviso para de tocar NA HORA — o worker lê `expires_at` a cada
 * ligação — e a passada de 60 s do worker o desliga no banco e avisa na Central.
 */
export const DURACOES_DA_EMERGENCIA = ["1h", "2h", "4h", "indefinida"] as const;
export type DuracaoDaEmergencia = (typeof DURACOES_DA_EMERGENCIA)[number];
export const DURACAO_PADRAO: DuracaoDaEmergencia = "2h";

const HORAS: Record<Exclude<DuracaoDaEmergencia, "indefinida">, number> = { "1h": 1, "2h": 2, "4h": 4 };

export function expiraEm(duracao: DuracaoDaEmergencia, desde: Date): Date | null {
  if (duracao === "indefinida") return null;
  return new Date(desde.getTime() + HORAS[duracao] * 3_600_000);
}

export function avisoVigente(
  a: { desde: Date | string | null; expiraEm: Date | string | null },
  agora: Date,
): boolean {
  if (!a.desde) return false;
  if (!a.expiraEm) return true;
  return new Date(a.expiraEm).getTime() > agora.getTime();
}
