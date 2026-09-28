/**
 * A URA DA LIGAÇÃO RECEBIDA — regra pura (desenho da fase 2, §5.1 e D5).
 *
 * Estado + evento → estado novo + UMA ação. Quem executa a ação (tocar, parar a
 * fala, armar o prazo, levar ao time) é o controlador de chamadas
 * (`lib/channels/telefonia/controle.ts`); aqui só se decide. Assim cada caminho
 * do menu se prova sem Asterisk nem relógio.
 *
 * As regras, na ordem em que o cliente as vive:
 *  - toca a fala do menu; QUALQUER tecla a interrompe;
 *  - terminada a fala, espera 5 s;
 *  - tecla de uma opção → o time da opção (`chosen`);
 *  - tecla que não é opção (inclusive `*` e `#`, reservadas) → a fala de tecla
 *    inválida, se houver, e o menu de novo;
 *  - sem tecla em 5 s → o menu de novo;
 *  - o menu toca no máximo 3 vezes (a primeira + 2 repetições); falhou a terceira
 *    → o time padrão, com `default_invalid` se ALGUMA tecla errada foi apertada,
 *    ou `default_no_input` se nenhuma.
 *
 * O estado é uma união discriminada por `fase`, o que elimina combinações
 * impossíveis (não dá para estar "tocando" E "esperando" ao mesmo tempo):
 *  - `"tocando"` — uma fala está no ar (`fala`: qual);
 *  - `"esperando"` — nada tocando, contando os 5 s depois do menu;
 *  - `"decidida"` — a ligação já foi encaminhada. É estado FINAL: todo evento
 *    que chegar depois (um DTMF atrasado, um prazo que ainda ia disparar) é
 *    ignorado e o estado não muda. Sem isso, uma tecla depois de já ter
 *    decidido gerava um SEGUNDO `encaminhar` — o bug que esta versão corrige.
 *
 * O prazo tem identidade: a ação `esperar` carrega a `vez` que abriu aquela
 * espera, e o evento `prazo` tem que trazer a MESMA `vez` de volta. Um `prazo`
 * com `vez` diferente da espera atual é de um timer velho (do controlador) e é
 * ignorado — sem isso, um timer perdido consumiria uma repetição que não era
 * dele.
 */
import type { DesfechoDoMenu } from "./vocabulario";

export const ESPERA_APOS_O_MENU_MS = 5_000;
export const VEZES_DO_MENU = 3;

export interface OpcaoDaUra {
  digito: string;
  teamId: string;
}

export interface MenuDaUra {
  opcoes: readonly OpcaoDaUra[];
  defaultTeamId: string;
  temFalaInvalida: boolean;
}

export type FalaDaUra = "menu" | "invalida";

export type EstadoDaUra =
  | {
      readonly fase: "tocando";
      /** Quantas vezes o menu já foi (ou está sendo) oferecido, a partir de 1. */
      readonly vez: number;
      readonly fala: FalaDaUra;
      readonly houveInvalida: boolean;
    }
  | {
      readonly fase: "esperando";
      /** A vez do menu cujo fim abriu esta espera — é o que o `prazo` de volta tem que bater. */
      readonly vez: number;
      readonly houveInvalida: boolean;
    }
  | { readonly fase: "decidida" };

export const ESTADO_INICIAL_DA_URA: Readonly<EstadoDaUra> = Object.freeze({
  fase: "tocando",
  vez: 1,
  fala: "menu",
  houveInvalida: false,
});

export type EventoDaUra = { tipo: "tecla"; digito: string } | { tipo: "fim_da_fala" } | { tipo: "prazo"; vez: number };

export type AcaoDaUra =
  | { tipo: "tocar"; fala: FalaDaUra; pararAtual: boolean }
  | { tipo: "esperar"; ms: number; vez: number }
  | { tipo: "encaminhar"; teamId: string; desfecho: DesfechoDoMenu; digito: string | null; pararAtual: boolean }
  | { tipo: "ignorar" };

export function passoDaUra(
  menu: MenuDaUra,
  estado: EstadoDaUra,
  evento: EventoDaUra,
): { estado: EstadoDaUra; acao: AcaoDaUra } {
  if (estado.fase === "decidida") return { estado, acao: { tipo: "ignorar" } };

  switch (evento.tipo) {
    case "tecla": {
      const pararAtual = estado.fase === "tocando";
      const opcao = menu.opcoes.find((o) => o.digito === evento.digito);
      if (opcao) {
        return {
          estado: { fase: "decidida" },
          acao: { tipo: "encaminhar", teamId: opcao.teamId, desfecho: "chosen", digito: opcao.digito, pararAtual },
        };
      }
      const vez = estado.vez + 1;
      if (vez > VEZES_DO_MENU) {
        return {
          estado: { fase: "decidida" },
          acao: { tipo: "encaminhar", teamId: menu.defaultTeamId, desfecho: "default_invalid", digito: null, pararAtual },
        };
      }
      const fala: FalaDaUra = menu.temFalaInvalida ? "invalida" : "menu";
      return { estado: { fase: "tocando", vez, fala, houveInvalida: true }, acao: { tipo: "tocar", fala, pararAtual } };
    }
    case "fim_da_fala": {
      if (estado.fase !== "tocando") return { estado, acao: { tipo: "ignorar" } };
      if (estado.fala === "menu") {
        return {
          estado: { fase: "esperando", vez: estado.vez, houveInvalida: estado.houveInvalida },
          acao: { tipo: "esperar", ms: ESPERA_APOS_O_MENU_MS, vez: estado.vez },
        };
      }
      return {
        estado: { fase: "tocando", vez: estado.vez, fala: "menu", houveInvalida: estado.houveInvalida },
        acao: { tipo: "tocar", fala: "menu", pararAtual: false },
      };
    }
    case "prazo": {
      if (estado.fase !== "esperando") return { estado, acao: { tipo: "ignorar" } };
      if (evento.vez !== estado.vez) return { estado, acao: { tipo: "ignorar" } };
      const vez = estado.vez + 1;
      if (vez > VEZES_DO_MENU) {
        return {
          estado: { fase: "decidida" },
          acao: {
            tipo: "encaminhar",
            teamId: menu.defaultTeamId,
            desfecho: estado.houveInvalida ? "default_invalid" : "default_no_input",
            digito: null,
            pararAtual: false,
          },
        };
      }
      return {
        estado: { fase: "tocando", vez, fala: "menu", houveInvalida: estado.houveInvalida },
        acao: { tipo: "tocar", fala: "menu", pararAtual: false },
      };
    }
  }
}
