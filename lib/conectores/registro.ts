/**
 * O REGISTRO DE CONECTORES — o ÚNICO arquivo do núcleo que sabe quais sistemas
 * externos existem.
 *
 * Conector novo = uma pasta em `lib/conectores/<id>/`, uma linha aqui, o id em
 * `IDS_DE_CONECTOR` e a migration que estende o CHECK. Nenhuma rota genérica,
 * nenhuma tela do núcleo e nenhum teste fora da pasta do conector importa
 * `./ixc` — a cerca é tests/unit/conectores-cerca.test.ts.
 */
import { conectorIxc } from "./ixc";
import { ehConectorId, type ConectorId, type DefinicaoDeConector } from "./tipos";

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
