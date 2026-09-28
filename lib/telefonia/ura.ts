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

export interface EstadoDaUra {
  /** Quantas vezes o menu já foi (ou está sendo) oferecido, a partir de 1. */
  vez: number;
  tocando: FalaDaUra | null;
  esperando: boolean;
  houveInvalida: boolean;
}

export const ESTADO_INICIAL_DA_URA: EstadoDaUra = { vez: 1, tocando: "menu", esperando: false, houveInvalida: false };

export type EventoDaUra = { tipo: "tecla"; digito: string } | { tipo: "fim_da_fala" } | { tipo: "prazo" };

export type AcaoDaUra =
  | { tipo: "tocar"; fala: FalaDaUra; pararAtual: boolean }
  | { tipo: "esperar"; ms: number }
  | { tipo: "encaminhar"; teamId: string; desfecho: DesfechoDoMenu; digito: string | null; pararAtual: boolean }
  | { tipo: "ignorar" };

export function passoDaUra(
  menu: MenuDaUra,
  estado: EstadoDaUra,
  evento: EventoDaUra,
): { estado: EstadoDaUra; acao: AcaoDaUra } {
  switch (evento.tipo) {
    case "tecla": {
      const pararAtual = estado.tocando !== null;
      const opcao = menu.opcoes.find((o) => o.digito === evento.digito);
      if (opcao) {
        return {
          estado: { ...estado, tocando: null, esperando: false },
          acao: { tipo: "encaminhar", teamId: opcao.teamId, desfecho: "chosen", digito: opcao.digito, pararAtual },
        };
      }
      const vez = estado.vez + 1;
      if (vez > VEZES_DO_MENU) {
        return {
          estado: { ...estado, tocando: null, esperando: false, houveInvalida: true },
          acao: { tipo: "encaminhar", teamId: menu.defaultTeamId, desfecho: "default_invalid", digito: null, pararAtual },
        };
      }
      const fala: FalaDaUra = menu.temFalaInvalida ? "invalida" : "menu";
      return { estado: { vez, tocando: fala, esperando: false, houveInvalida: true }, acao: { tipo: "tocar", fala, pararAtual } };
    }
    case "fim_da_fala": {
      if (estado.tocando === "menu") {
        return { estado: { ...estado, tocando: null, esperando: true }, acao: { tipo: "esperar", ms: ESPERA_APOS_O_MENU_MS } };
      }
      if (estado.tocando === "invalida") {
        return { estado: { ...estado, tocando: "menu", esperando: false }, acao: { tipo: "tocar", fala: "menu", pararAtual: false } };
      }
      return { estado, acao: { tipo: "ignorar" } };
    }
    case "prazo": {
      if (!estado.esperando) return { estado, acao: { tipo: "ignorar" } };
      const vez = estado.vez + 1;
      if (vez > VEZES_DO_MENU) {
        return {
          estado: { ...estado, esperando: false },
          acao: {
            tipo: "encaminhar",
            teamId: menu.defaultTeamId,
            desfecho: estado.houveInvalida ? "default_invalid" : "default_no_input",
            digito: null,
            pararAtual: false,
          },
        };
      }
      return { estado: { ...estado, vez, tocando: "menu", esperando: false }, acao: { tipo: "tocar", fala: "menu", pararAtual: false } };
    }
  }
}
