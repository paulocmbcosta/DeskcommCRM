/**
 * O juntador de avisos — a peça que impede N atendentes × M avisos de virar
 * N × M recargas do Inbox (incidente de 2026-09-24: produção fora do ar por 16
 * minutos). Para ver morder: faça `avisar()` chamar `opts.agir()` direto — o
 * primeiro caso reprova com 10 ações em vez de 1.
 */
import { describe, expect, it } from "vitest";

import { criarJuntador, type Relogio } from "./juntar-avisos";

function relogioDeTeste() {
  let agora = 0;
  let fila: Array<{ em: number; fn: () => void; id: number }> = [];
  let proximo = 1;
  const relogio: Relogio = {
    agora: () => agora,
    agendar: (fn, ms) => {
      const id = proximo++;
      fila.push({ em: agora + ms, fn, id });
      return id;
    },
    cancelar: (h) => {
      fila = fila.filter((t) => t.id !== h);
    },
  };
  const avancar = (ms: number) => {
    const alvo = agora + ms;
    for (;;) {
      fila.sort((a, b) => a.em - b.em);
      const t = fila[0];
      if (!t || t.em > alvo) break;
      fila.shift();
      agora = t.em;
      t.fn();
    }
    agora = alvo;
  };
  return { relogio, avancar };
}

describe("criarJuntador", () => {
  it("⭐ uma rajada de 10 avisos vira UMA ação, depois da espera", () => {
    const { relogio, avancar } = relogioDeTeste();
    let acoes = 0;
    const j = criarJuntador({ esperaMs: 1500, intervaloMinimoMs: 5000, agir: () => acoes++, relogio });

    for (let i = 0; i < 10; i++) j.avisar();
    avancar(1499);
    expect(acoes).toBe(0);
    avancar(1);
    expect(acoes).toBe(1);
  });

  it("entre duas ações há no mínimo o intervalo, por mais que os avisos insistam", () => {
    const { relogio, avancar } = relogioDeTeste();
    const momentos: number[] = [];
    let t = 0;
    const j = criarJuntador({
      esperaMs: 1500,
      intervaloMinimoMs: 5000,
      agir: () => momentos.push(t),
      relogio: { ...relogio, agora: () => (t = relogio.agora()) },
    });

    // Um aviso a cada 200 ms durante 20 s.
    for (let i = 0; i < 100; i++) {
      j.avisar();
      avancar(200);
    }
    avancar(10_000);
    expect(momentos.length).toBeGreaterThanOrEqual(3);
    expect(momentos.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < momentos.length; i++) {
      expect(momentos[i]! - momentos[i - 1]!).toBeGreaterThanOrEqual(5000);
    }
  });

  it("aviso isolado depois de muito tempo espera só a espera curta", () => {
    const { relogio, avancar } = relogioDeTeste();
    let acoes = 0;
    const j = criarJuntador({ esperaMs: 1500, intervaloMinimoMs: 5000, agir: () => acoes++, relogio });

    j.avisar();
    avancar(1500);
    avancar(60_000);
    j.avisar();
    avancar(1500);
    expect(acoes).toBe(2);
  });

  it("nenhum aviso se perde: o que chega logo depois de uma ação gera outra", () => {
    const { relogio, avancar } = relogioDeTeste();
    let acoes = 0;
    const j = criarJuntador({ esperaMs: 1500, intervaloMinimoMs: 5000, agir: () => acoes++, relogio });

    j.avisar();
    avancar(1500);
    j.avisar();
    // O intervalo mínimo conta da ação anterior: 5 s depois dela.
    avancar(4999);
    expect(acoes).toBe(1);
    avancar(1);
    expect(acoes).toBe(2);
  });

  it("cancelar descarta a ação agendada", () => {
    const { relogio, avancar } = relogioDeTeste();
    let acoes = 0;
    const j = criarJuntador({ esperaMs: 1500, intervaloMinimoMs: 5000, agir: () => acoes++, relogio });

    j.avisar();
    j.cancelar();
    avancar(10_000);
    expect(acoes).toBe(0);
  });
});
