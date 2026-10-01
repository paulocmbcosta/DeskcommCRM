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
 *    ou `default_no_input` se nenhuma;
 *  - a fala que NÃO TOCOU (`fala_falhou`: sem arquivo no disco, recusada pelo
 *    Asterisk, ou o playback terminou `failed`) é pulada, como se não existisse
 *    (desenho §4): a de tecla inválida cede ao menu; o menu que não toca não se
 *    repete no silêncio — vai ao time padrão, com o desfecho da mesma régua.
 *    Decidir isso aqui, e não no controlador, mantém o desfecho numa regra só.
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
/**
 * Menu que aceita ramal (v3, `accepts_extension`): depois de cada tecla, quanto
 * se espera pela próxima antes de decidir. Um dígito continua sendo opção — com
 * este atraso; 2 a 4 dígitos são um ramal.
 */
export const ESPERA_ENTRE_DIGITOS_MS = 2_000;
export const DIGITOS_DO_RAMAL_MAX = 4;

export interface OpcaoDaUra {
  digito: string;
  teamId: string;
}

export interface MenuDaUra {
  opcoes: readonly OpcaoDaUra[];
  defaultTeamId: string;
  temFalaInvalida: boolean;
  /** O cliente pode digitar o ramal de alguém (v3). Ausente = não. */
  aceitaRamal?: boolean;
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
  | {
      /** Menu que aceita ramal: o cliente está digitando, e a próxima tecla ainda pode vir. */
      readonly fase: "digitando";
      readonly vez: number;
      readonly houveInvalida: boolean;
      readonly digitos: string;
      /** Identidade do prazo entre dígitos — o `prazo_dos_digitos` velho é ignorado. */
      readonly seq: number;
    }
  | {
      /** Digitou um ramal: o controlador confere se ele existe e está livre. */
      readonly fase: "ramal";
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

export type EventoDaUra =
  | { tipo: "tecla"; digito: string }
  | { tipo: "fim_da_fala" }
  | { tipo: "prazo"; vez: number }
  /** A fala no ar (ou a que ia tocar) não tocou. */
  | { tipo: "fala_falhou" }
  /** Venceu a espera pela próxima tecla (menu que aceita ramal). */
  | { tipo: "prazo_dos_digitos"; seq: number }
  /** O ramal digitado não existe, ou a pessoa não pode atender agora: é como tecla errada. */
  | { tipo: "ramal_invalido" };

export type AcaoDaUra =
  | { tipo: "tocar"; fala: FalaDaUra; pararAtual: boolean }
  | { tipo: "esperar"; ms: number; vez: number }
  | { tipo: "encaminhar"; teamId: string; desfecho: DesfechoDoMenu; digito: string | null; pararAtual: boolean }
  /** Esperar a próxima tecla (menu que aceita ramal). */
  | { tipo: "esperar_digitos"; ms: number; seq: number; pararAtual: boolean }
  /** O cliente digitou um ramal: o controlador procura a pessoa. */
  | { tipo: "ramal"; numero: string }
  | { tipo: "ignorar" };

type Passo = { estado: EstadoDaUra; acao: AcaoDaUra };

/** Uma tecla (ou um ramal que não serve) que não leva a lugar nenhum: a fala de inválida e o menu, ou o time padrão. */
function invalida(menu: MenuDaUra, vezAtual: number, pararAtual: boolean): Passo {
  const vez = vezAtual + 1;
  if (vez > VEZES_DO_MENU) {
    return {
      estado: { fase: "decidida" },
      acao: { tipo: "encaminhar", teamId: menu.defaultTeamId, desfecho: "default_invalid", digito: null, pararAtual },
    };
  }
  const fala: FalaDaUra = menu.temFalaInvalida ? "invalida" : "menu";
  return { estado: { fase: "tocando", vez, fala, houveInvalida: true }, acao: { tipo: "tocar", fala, pararAtual } };
}

/** Uma tecla só: a opção, ou inválida. */
function umaTecla(menu: MenuDaUra, digito: string, vez: number, pararAtual: boolean): Passo {
  const opcao = menu.opcoes.find((o) => o.digito === digito);
  if (opcao) {
    return {
      estado: { fase: "decidida" },
      acao: { tipo: "encaminhar", teamId: opcao.teamId, desfecho: "chosen", digito: opcao.digito, pararAtual },
    };
  }
  return invalida(menu, vez, pararAtual);
}

/** Acabou a digitação: 1 dígito é opção; 2 a 4, um ramal. */
function fimDaDigitacao(menu: MenuDaUra, e: Extract<EstadoDaUra, { fase: "digitando" }>): Passo {
  if (e.digitos.length === 1) return umaTecla(menu, e.digitos, e.vez, false);
  return {
    estado: { fase: "ramal", vez: e.vez, houveInvalida: e.houveInvalida },
    acao: { tipo: "ramal", numero: e.digitos },
  };
}

export function passoDaUra(
  menu: MenuDaUra,
  estado: EstadoDaUra,
  evento: EventoDaUra,
): { estado: EstadoDaUra; acao: AcaoDaUra } {
  if (estado.fase === "decidida") return { estado, acao: { tipo: "ignorar" } };

  // O ramal digitado está sendo conferido: só a resposta do controlador conta.
  if (estado.fase === "ramal") {
    if (evento.tipo !== "ramal_invalido") return { estado, acao: { tipo: "ignorar" } };
    return invalida(menu, estado.vez, false);
  }

  // Menu que aceita ramal, com o cliente digitando.
  if (estado.fase === "digitando") {
    if (evento.tipo === "prazo_dos_digitos") {
      if (evento.seq !== estado.seq) return { estado, acao: { tipo: "ignorar" } };
      return fimDaDigitacao(menu, estado);
    }
    if (evento.tipo !== "tecla") return { estado, acao: { tipo: "ignorar" } };
    // `#` encerra a digitação; `*` é ignorado.
    if (evento.digito === "#") return fimDaDigitacao(menu, estado);
    if (!/^[0-9]$/.test(evento.digito)) return { estado, acao: { tipo: "ignorar" } };
    const digitando = { ...estado, digitos: estado.digitos + evento.digito, seq: estado.seq + 1 };
    if (digitando.digitos.length >= DIGITOS_DO_RAMAL_MAX) return fimDaDigitacao(menu, digitando);
    return {
      estado: digitando,
      acao: { tipo: "esperar_digitos", ms: ESPERA_ENTRE_DIGITOS_MS, seq: digitando.seq, pararAtual: false },
    };
  }

  switch (evento.tipo) {
    case "tecla": {
      const pararAtual = estado.fase === "tocando";
      // Menu que aceita ramal: a primeira tecla abre a digitação (1 dígito
      // continua sendo opção, com o atraso da espera). `*` e `#` seguem inválidas.
      if (menu.aceitaRamal && /^[0-9]$/.test(evento.digito)) {
        return {
          estado: { fase: "digitando", vez: estado.vez, houveInvalida: estado.houveInvalida, digitos: evento.digito, seq: 1 },
          acao: { tipo: "esperar_digitos", ms: ESPERA_ENTRE_DIGITOS_MS, seq: 1, pararAtual },
        };
      }
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
    case "fala_falhou": {
      if (estado.fase !== "tocando") return { estado, acao: { tipo: "ignorar" } };
      // A de tecla inválida é só um aviso: sem ela, o menu segue na mesma vez.
      if (estado.fala === "invalida") {
        return {
          estado: { fase: "tocando", vez: estado.vez, fala: "menu", houveInvalida: estado.houveInvalida },
          acao: { tipo: "tocar", fala: "menu", pararAtual: false },
        };
      }
      // O menu é o mesmo áudio a cada vez: o que não tocou agora não toca na
      // repetição. Esperar o cliente escolher o que ele não ouviu seria silêncio.
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
    case "prazo_dos_digitos":
    case "ramal_invalido":
      return { estado, acao: { tipo: "ignorar" } };
    default: {
      const _nunca: never = evento;
      return _nunca;
    }
  }
}
