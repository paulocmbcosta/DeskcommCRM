/**
 * O REGISTRO DE CONECTORES — o ÚNICO arquivo do núcleo que sabe quais sistemas
 * externos existem.
 *
 * Conector novo = uma pasta em `lib/conectores/<id>/`, uma linha aqui, o id em
 * `IDS_DE_CONECTOR` e a migration que estende o CHECK. Nenhuma rota genérica,
 * nenhuma tela do núcleo e nenhum teste fora da pasta do conector importa
 * `./ixc` — a cerca é tests/unit/conectores-cerca.test.ts.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

import { conectoresLigados } from "./conexao";
import { conectorIxc } from "./ixc";
import { ehConectorId, type CapacidadeDoAgente, type ConectorId, type DefinicaoDeConector } from "./tipos";

const CONECTORES: Record<ConectorId, DefinicaoDeConector> = {
  ixc: conectorIxc,
};

export function listarConectores(): DefinicaoDeConector[] {
  return Object.values(CONECTORES);
}

/** Fail-closed, como `getAdapter` dos canais: id desconhecido não vira conector genérico. */
export function obterConector(id: string): DefinicaoDeConector | null {
  return ehConectorId(id) ? CONECTORES[id] : null;
}

/**
 * O conector desta organização que atende o AGENTE DE IA — o primeiro LIGADO que
 * declara `agente`. `null` = nenhum: as ferramentas do conector não entram no
 * turno e a tela não as oferece. É por aqui (e nunca por `./ixc`) que o motor
 * chega a um conector.
 */
export async function conectorDoAgente(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<{ id: ConectorId; agente: CapacidadeDoAgente } | null> {
  for (const id of await conectoresLigados(admin, orgId)) {
    const agente = CONECTORES[id].agente;
    if (agente) return { id, agente };
  }
  return null;
}
