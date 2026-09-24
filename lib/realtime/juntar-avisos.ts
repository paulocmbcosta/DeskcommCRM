/**
 * Junta avisos de tempo real numa ação só — no máximo uma a cada intervalo.
 *
 * ─── Por que existe (incidente de 2026-09-24) ────────────────────────────────
 *
 * Cada mudança numa conversa chega como aviso a TODAS as telas abertas do
 * Inbox, e cada tela respondia a CADA aviso refazendo a lista e as contagens
 * das abas (~10 consultas com RLS). Uma única mensagem nova gera vários avisos
 * em sequência — conversa criada, rodízio, mensagem, mídia —, e com 11
 * atendentes logados isso virou ~100 consultas pesadas de uma vez: o banco
 * (Supabase Micro) saturou, o pool da API esgotou, as consultas falharam, as
 * telas tentaram de novo, o tempo real reconectou e pediu tudo outra vez. A
 * produção ficou 16 minutos fora do ar com o 4063 recebendo uma mensagem a
 * cada poucos minutos.
 *
 * A regra: o primeiro aviso agenda a ação para daqui a `esperaMs`; os que
 * chegam enquanto ela está agendada pegam carona; e entre duas ações há no
 * mínimo `intervaloMinimoMs`. A informação continua chegando — só não chega
 * uma vez por aviso.
 *
 * Puro e sem React: o relógio é injetável para o teste não depender de tempo.
 */

export interface Relogio {
  agora(): number;
  agendar(fn: () => void, ms: number): unknown;
  cancelar(handle: unknown): void;
}

const RELOGIO_REAL: Relogio = {
  agora: () => Date.now(),
  agendar: (fn, ms) => setTimeout(fn, ms),
  cancelar: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Juntador {
  /** Um aviso chegou. Agenda a ação, ou pega carona na que já está agendada. */
  avisar(): void;
  /** Descarta a ação agendada (desmontagem). */
  cancelar(): void;
}

export function criarJuntador(opts: {
  esperaMs: number;
  intervaloMinimoMs: number;
  agir: () => void;
  relogio?: Relogio;
}): Juntador {
  const relogio = opts.relogio ?? RELOGIO_REAL;
  let pendente: unknown = null;
  let ultima = Number.NEGATIVE_INFINITY;

  return {
    avisar() {
      if (pendente !== null) return;
      const desdeUltima = relogio.agora() - ultima;
      const atraso = Math.max(opts.esperaMs, opts.intervaloMinimoMs - desdeUltima);
      pendente = relogio.agendar(() => {
        pendente = null;
        ultima = relogio.agora();
        opts.agir();
      }, atraso);
    },
    cancelar() {
      if (pendente !== null) relogio.cancelar(pendente);
      pendente = null;
    },
  };
}
