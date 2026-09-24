"use client";
import type { QueryClient } from "@tanstack/react-query";

import { criarJuntador, type Juntador } from "@/lib/realtime/juntar-avisos";

/**
 * A recarga da lista e das contagens do Inbox, JUNTADA — uma por tela a cada
 * poucos segundos, por mais avisos que cheguem. Racional e incidente em
 * `lib/realtime/juntar-avisos.ts`.
 *
 * Um juntador por `QueryClient` (= por aba do navegador), compartilhado por
 * quem pede a recarga: o aviso de "conversa mudou" e o de "mensagem nova"
 * caem na MESMA janela, em vez de cada um disparar a sua.
 */
export const ESPERA_DA_RECARGA_MS = 1_500;
export const INTERVALO_MINIMO_DA_RECARGA_MS = 5_000;

const porCliente = new WeakMap<QueryClient, Juntador>();

export function pedirRecargaDoInbox(qc: QueryClient): void {
  let juntador = porCliente.get(qc);
  if (!juntador) {
    juntador = criarJuntador({
      esperaMs: ESPERA_DA_RECARGA_MS,
      intervaloMinimoMs: INTERVALO_MINIMO_DA_RECARGA_MS,
      agir: () => {
        void qc.invalidateQueries({ queryKey: ["conversations"] });
        void qc.invalidateQueries({ queryKey: ["conversation-counts"] });
      },
    });
    porCliente.set(qc, juntador);
  }
  juntador.avisar();
}
