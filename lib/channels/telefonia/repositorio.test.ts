// @vitest-environment node
/**
 * A parte PURA do banco do worker da telefonia: a decisão da situação do time
 * (fora do horário × ninguém disponível) e o texto do registro na conversa. O SQL
 * é provado contra Postgres real em tests/invariants/telefonia-repositorio-da-ura.test.ts.
 */
import { describe, expect, it } from "vitest";

import { MOTIVO_FORA_DO_HORARIO } from "@/lib/telefonia/vocabulario";

import { desligouNoMenu, situacaoDaLinhaDoTime, textoDoAvisoDePerdida, textoDoRegistro } from "./repositorio";

/** Segunda-feira, 10h em Brasília. */
const AGORA = new Date("2026-09-28T13:00:00Z");
const segunda8as12 = { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "12:00" }] };
const domingo = { timezone: "America/Sao_Paulo", windows: [{ dow: 0, start: "08:00", end: "12:00" }] };

describe("situacaoDaLinhaDoTime", () => {
  it("time que não existe (ou é de outra organização) e time arquivado: indisponível", () => {
    expect(situacaoDaLinhaDoTime(undefined, AGORA)).toBe("indisponivel");
    expect(situacaoDaLinhaDoTime({ schedule: {}, archived_at: "2026-09-01T00:00:00Z" }, AGORA)).toBe("indisponivel");
  });

  it("sem janelas é 24/7; dentro da janela, aberto; fora dela, fora do horário", () => {
    expect(situacaoDaLinhaDoTime({ schedule: {}, archived_at: null }, AGORA)).toBe("aberto");
    expect(situacaoDaLinhaDoTime({ schedule: null, archived_at: null }, AGORA)).toBe("aberto");
    expect(situacaoDaLinhaDoTime({ schedule: segunda8as12, archived_at: null }, AGORA)).toBe("aberto");
    expect(situacaoDaLinhaDoTime({ schedule: domingo, archived_at: null }, AGORA)).toBe("fora_do_horario");
  });

  it("agenda que o parser não lê é indisponível, NUNCA fora do horário (segue a fila e vira 'Ligar de volta')", () => {
    const ruim = { timezone: "America/Asunción", windows: [{ dow: 1, start: "00:00", end: "23:59" }] };
    expect(situacaoDaLinhaDoTime({ schedule: ruim, archived_at: null }, AGORA)).toBe("indisponivel");
  });
});

describe("textoDoRegistro", () => {
  const base = { direcao: "inbound" as const, desfecho: "perdida" as const, duracaoMs: null, quem: null };

  it("recebida encerrada fora do horário diz isso; sem motivo, segue 'não atendida'", () => {
    expect(textoDoRegistro({ ...base, motivo: MOTIVO_FORA_DO_HORARIO })).toBe("Ligação recebida fora do horário");
    expect(textoDoRegistro({ ...base, motivo: "ninguem_atendeu" })).toBe("Ligação recebida não atendida");
    expect(textoDoRegistro(base)).toBe("Ligação recebida não atendida");
  });

  it("o motivo não muda a atendida nem a feita", () => {
    expect(
      textoDoRegistro({ direcao: "inbound", desfecho: "atendida", duracaoMs: 65_000, quem: "Ana", motivo: MOTIVO_FORA_DO_HORARIO }),
    ).toBe("Ligação recebida, atendida por Ana · 1 min 05 s");
    expect(textoDoRegistro({ direcao: "outbound", desfecho: "sem_resposta", duracaoMs: null, quem: null, motivo: MOTIVO_FORA_DO_HORARIO })).toBe(
      "Ligação feita · sem resposta",
    );
  });
});

describe("o 'Ligar de volta' (textoDoAvisoDePerdida)", () => {
  const base = { numero: "+5561988887777", nomeDoTime: null, desligouNoMenu: false, idioma: "pt-BR" as const };

  it("sem time: o texto de sempre; com time: diz qual time não atendeu", () => {
    expect(textoDoAvisoDePerdida(base)).toEqual({
      titulo: "Ligação perdida de +5561988887777",
      corpo: "Ninguém atendeu. Ligue de volta pela conversa.",
    });
    expect(textoDoAvisoDePerdida({ ...base, nomeDoTime: "Financeiro" }).corpo).toBe(
      "Ninguém do time Financeiro atendeu. Ligue de volta pela conversa.",
    );
  });

  it("desligou no menu: não diz que o time não atendeu — ninguém chegou a tocar", () => {
    expect(textoDoAvisoDePerdida({ ...base, nomeDoTime: "Suporte", desligouNoMenu: true }).corpo).toBe(
      "O cliente desligou no menu do telefone. Ligue de volta pela conversa.",
    );
  });

  it("em espanhol, na organização que fala espanhol", () => {
    const es = { ...base, idioma: "es" as const };
    expect(textoDoAvisoDePerdida(es)).toEqual({
      titulo: "Llamada perdida de +5561988887777",
      corpo: "Nadie atendió. Devuelve la llamada desde la conversación.",
    });
    expect(textoDoAvisoDePerdida({ ...es, nomeDoTime: "Finanzas" }).corpo).toBe(
      "Nadie del equipo Finanzas atendió. Devuelve la llamada desde la conversación.",
    );
    expect(textoDoAvisoDePerdida({ ...es, desligouNoMenu: true }).corpo).toBe(
      "El cliente colgó en el menú del teléfono. Devuelve la llamada desde la conversación.",
    );
  });
});

describe("desligouNoMenu", () => {
  it("só a ligação com menu, sem desfecho, que acabou porque o cliente desligou", () => {
    expect(desligouNoMenu({ menu_id: "m", menu_outcome: null, end_reason: "cliente_desligou" })).toBe(true);
    // Escolheu (ou foi ao padrão) e desligou na fila: o time não atendeu.
    expect(desligouNoMenu({ menu_id: "m", menu_outcome: "chosen", end_reason: "cliente_desligou" })).toBe(false);
    // Número de time: não há menu.
    expect(desligouNoMenu({ menu_id: null, menu_outcome: null, end_reason: "cliente_desligou" })).toBe(false);
    // O worker reiniciou no meio do menu: o cliente não desligou.
    expect(desligouNoMenu({ menu_id: "m", menu_outcome: null, end_reason: "interrompida_no_reinicio" })).toBe(false);
  });
});
