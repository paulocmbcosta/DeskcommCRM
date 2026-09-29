// @vitest-environment node
/**
 * A parte PURA do banco do worker da telefonia: a decisão da situação do time
 * (fora do horário × ninguém disponível) e o texto do registro na conversa. O SQL
 * é provado contra Postgres real em tests/invariants/telefonia-repositorio-da-ura.test.ts.
 */
import { describe, expect, it } from "vitest";

import { MOTIVO_FORA_DO_HORARIO } from "@/lib/telefonia/vocabulario";

import { situacaoDaLinhaDoTime, textoDoRegistro } from "./repositorio";

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
