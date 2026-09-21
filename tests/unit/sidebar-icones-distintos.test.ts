/**
 * NENHUM ÍCONE SE REPETE NA BARRA LATERAL.
 *
 * ─── O defeito, visto por quem usa ──────────────────────────────────────────
 *
 * Os três links "Ver tudo em CRM / IA / Análise" desenhavam a MESMA seta. Com a
 * barra aberta eram três linhas idênticas, só distinguíveis lendo o texto; com ela
 * recolhida (agora o estado inicial) o texto some e sobram três setas iguais,
 * separadas apenas por um `title` que só aparece com o mouse parado em cima.
 *
 * ─── O que este teste prende ────────────────────────────────────────────────
 *
 * A propriedade, não a escolha: quais ícones foram sorteados é livre, que dois
 * itens do MESMO menu não compartilhem um é a regra. Ela vale para a visão que
 * todo mundo recebe (sem interface personalizada) em cada papel, contando os
 * destinos, o "Ver tudo em …" de cada grupo e a engrenagem do rodapé.
 *
 * Grupo novo com hub que ninguém lembrou de dar ícone cai na seta padrão — e é
 * aqui que isso vira vermelho, com o nome de quem colidiu.
 *
 * ─── O que NÃO prende ───────────────────────────────────────────────────────
 *
 * Interface personalizada por vínculo (`settings.destinos`): ali o dono do
 * cadastro escolhe quais destinos sobem para o menu, e destinos que moram em
 * grupos diferentes de propósito podem dividir um ícone (Agenda e Tipos de
 * agendamento, ambos calendário). Isso é escolha dele, não defeito do produto.
 */
import { describe, expect, it } from "vitest";

import type { Role } from "@/lib/auth/types";
import { GRUPO_NO_RODAPE, sidebarGroups } from "@/lib/navigation/registry";
import { Gear } from "@/lib/ui/icons";

type Rotulo = string;

/** Todo ícone que a barra desenha para esta visão, com o rótulo de quem o usa. */
function iconesDaBarra(platformAdmin: boolean, role: Role | null): Map<unknown, Rotulo[]> {
  const usos = new Map<unknown, Rotulo[]>();
  const anota = (icone: unknown, rotulo: Rotulo) => {
    usos.set(icone, [...(usos.get(icone) ?? []), rotulo]);
  };

  for (const { group, items, hubIcon } of sidebarGroups(platformAdmin, role)) {
    // O hub do grupo do rodapé (Configurações) não é desenhado na lista: ele tem
    // a engrenagem, anotada abaixo.
    if (group.id === GRUPO_NO_RODAPE) continue;
    for (const item of items) anota(item.icon, item.label);
    if (group.hub) anota(hubIcon, group.hub.label);
  }
  anota(Gear, "Configurações");
  return usos;
}

const VISOES: Array<[string, boolean, Role | null]> = [
  ["administrador da plataforma", true, null],
  ["admin", false, "admin"],
  ["manager", false, "manager"],
  ["agent", false, "agent"],
  ["viewer", false, "viewer"],
];

describe("a barra lateral não repete ícone", () => {
  for (const [nome, platformAdmin, role] of VISOES) {
    it(`para ${nome}, cada ícone aparece uma vez só`, () => {
      const repetidos = [...iconesDaBarra(platformAdmin, role).values()].filter(
        (rotulos) => rotulos.length > 1,
      );
      expect(
        repetidos,
        `estes itens da barra dividem o mesmo ícone: ${repetidos.map((r) => r.join(" = ")).join("; ")}`,
      ).toEqual([]);
    });
  }

  it("os três 'Ver tudo em …' são distinguíveis sem ler o texto", () => {
    const hubs = sidebarGroups(false, "admin")
      .filter(({ group }) => group.hub && group.id !== GRUPO_NO_RODAPE)
      .map(({ group, hubIcon }) => [group.hub!.label, hubIcon] as const);

    // Guarda contra o teste passar vazio: se os hubs sumissem do menu, a
    // propriedade abaixo seria verdadeira por não haver nada a comparar.
    expect(hubs.map(([rotulo]) => rotulo)).toEqual([
      "Ver tudo em CRM",
      "Ver tudo em IA",
      "Ver tudo em Análise",
    ]);
    expect(new Set(hubs.map(([, icone]) => icone)).size).toBe(hubs.length);
  });
});
