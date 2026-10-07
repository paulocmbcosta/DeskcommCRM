/**
 * AS REGRAS PURAS DA FILA DO TELEFONE (aba Telefone; migration 0295): a fase de
 * uma ligação viva, por que a recebida se perdeu, a posição na fila do time, o
 * resumo do chip, o relógio e o peso da espera. O servidor e a tela leem a
 * MESMA régua — é este arquivo que impede as duas de divergirem.
 */
import { describe, expect, it } from "vitest";

import { TOQUE_DE_QUEM_PUXOU_MS } from "@/lib/channels/telefonia/ordens-da-fila";

import { ESPERA_NA_FILA_MS } from "./distribuicao";
import {
  FASES_DA_LIGACAO,
  FASES_EM_QUE_SE_AGE,
  FASES_QUE_ESPERAM,
  FILA_DESLIGADA,
  MOTIVOS_DA_PERDIDA,
  VALIDADE_DA_ORDEM_DA_FILA_S,
  faseDaLigacao,
  motivoDaPerdida,
  posicoesNaFila,
  quantasEsperam,
  relogio,
  resumoDoTime,
  urgenciaDaEspera,
  type FaseDaLigacao,
  type LigacaoNaFila,
} from "./fila";
import { MOTIVO_FORA_DO_HORARIO } from "./vocabulario";

const viva = {
  status: "ringing",
  queued_at: null as unknown,
  ringing_user_id: null as string | null,
  menu_id: null as string | null,
  menu_outcome: null as string | null,
  transferencia_time_id: null as string | null,
};

describe("faseDaLigacao", () => {
  it.each([
    // [o que muda na linha, a fase]
    [{ menu_id: "m1" }, "menu"], // tocando o menu, ainda sem desfecho
    [{ menu_id: "m1", menu_outcome: "opcao" }, "avisos"], // o menu já decidiu; ainda não entrou na fila
    [{}, "avisos"], // sem menu: o que toca antes da fila é aviso (gravação, espera)
    [{ queued_at: "2026-10-06T12:00:00Z" }, "aguardando"],
    [{ queued_at: "2026-10-06T12:00:00Z", ringing_user_id: "u1" }, "tocando"],
    [{ status: "connected", queued_at: "2026-10-06T12:00:00Z" }, "em_ligacao"],
    [{ status: "connected", transferencia_time_id: "t2" }, "transferencia_na_fila"],
  ] as const)("%j → %s", (mudanca, fase) => {
    expect(faseDaLigacao({ ...viva, ...mudanca })).toBe(fase);
  });

  it("cobre as seis fases do vocabulário, e só elas", () => {
    const vistas = new Set<FaseDaLigacao>([
      faseDaLigacao({ ...viva, menu_id: "m1" }),
      faseDaLigacao(viva),
      faseDaLigacao({ ...viva, queued_at: new Date() }),
      faseDaLigacao({ ...viva, queued_at: new Date(), ringing_user_id: "u1" }),
      faseDaLigacao({ ...viva, status: "connected" }),
      faseDaLigacao({ ...viva, status: "connected", transferencia_time_id: "t2" }),
    ]);
    expect([...vistas].sort()).toEqual([...FASES_DA_LIGACAO].sort());
  });

  it("atendida ganha de tudo: o `queued_at` e o ramal que tocou ficam na linha depois do atendimento", () => {
    expect(
      faseDaLigacao({ ...viva, status: "connected", queued_at: "2026-10-06T12:00:00Z", ringing_user_id: "u1", menu_id: "m1" }),
    ).toBe("em_ligacao");
  });

  it("na fila ganha do menu: quem escolheu a opção e já espera não está mais 'no menu'", () => {
    expect(faseDaLigacao({ ...viva, queued_at: "2026-10-06T12:00:00Z", menu_id: "m1" })).toBe("aguardando");
  });
});

describe("motivoDaPerdida", () => {
  const perdida = {
    end_reason: null as string | null,
    queued_at: null as unknown,
    menu_id: null as string | null,
    menu_outcome: null as string | null,
  };

  it.each([
    // [a linha, o motivo]
    [{ end_reason: MOTIVO_FORA_DO_HORARIO }, "fora_do_horario"],
    [{ end_reason: "fila_esgotada", queued_at: "2026-10-06T12:00:00Z" }, "fila_esgotada"],
    [{ end_reason: "ninguem_atendeu", queued_at: "2026-10-06T12:00:00Z" }, "ninguem_atendeu"],
    // desligou ouvindo as opções, sem escolher nenhuma
    [{ end_reason: "cliente_desligou", menu_id: "m1" }, "desligou_no_menu"],
    // desligou já esperando por uma pessoa (com e sem menu antes)
    [{ end_reason: "cliente_desligou", queued_at: "2026-10-06T12:00:00Z" }, "desistiu_na_fila"],
    [{ end_reason: "cliente_desligou", queued_at: "2026-10-06T12:00:00Z", menu_id: "m1", menu_outcome: "opcao" }, "desistiu_na_fila"],
    // o menu já tinha decidido: quem desliga nos avisos não "desligou no menu"
    [{ end_reason: "cliente_desligou", menu_id: "m1", menu_outcome: "opcao" }, "desistiu_na_fila"],
    // sem menu e sem fila (desligou no aviso): não há menu para culpar
    [{ end_reason: "cliente_desligou" }, "desistiu_na_fila"],
    [{ end_reason: "interrompida_no_reinicio" }, "interrompida"],
    [{ end_reason: "encerrada_apos_reinicio" }, "interrompida"],
    [{ end_reason: "qualquer_outra_coisa" }, "outro"],
    [{ end_reason: null }, "outro"],
  ] as const)("%j → %s", (mudanca, motivo) => {
    expect(motivoDaPerdida({ ...perdida, ...mudanca })).toBe(motivo);
  });

  it("todo motivo devolvido está no vocabulário", () => {
    const devolvidos = [
      motivoDaPerdida({ ...perdida, end_reason: MOTIVO_FORA_DO_HORARIO }),
      motivoDaPerdida({ ...perdida, end_reason: "fila_esgotada" }),
      motivoDaPerdida({ ...perdida, end_reason: "ninguem_atendeu" }),
      motivoDaPerdida({ ...perdida, end_reason: "cliente_desligou", menu_id: "m1" }),
      motivoDaPerdida({ ...perdida, end_reason: "cliente_desligou", queued_at: new Date() }),
      motivoDaPerdida({ ...perdida, end_reason: "interrompida_no_reinicio" }),
      motivoDaPerdida(perdida),
    ];
    expect([...new Set(devolvidos)].sort()).toEqual([...MOTIVOS_DA_PERDIDA].sort());
  });
});

type Esperando = Pick<LigacaoNaFila, "id" | "fase" | "time_id" | "na_fila_desde">;
const naFila = (id: string, fase: FaseDaLigacao, time_id: string | null, na_fila_desde: string | null): Esperando => ({
  id,
  fase,
  time_id,
  na_fila_desde,
});

describe("posicoesNaFila", () => {
  it("numera por ordem de chegada dentro de CADA time", () => {
    const posicoes = posicoesNaFila([
      naFila("c", "aguardando", "vendas", "2026-10-06T12:00:30Z"),
      naFila("a", "tocando", "vendas", "2026-10-06T12:00:10Z"),
      naFila("b", "aguardando", "suporte", "2026-10-06T12:00:20Z"),
      naFila("d", "aguardando", "suporte", "2026-10-06T12:00:05Z"),
    ]);
    expect(Object.fromEntries(posicoes)).toEqual({ a: 1, c: 2, d: 1, b: 2 });
  });

  it("empate de instante se resolve pelo id — a ordem não troca entre duas leituras", () => {
    const mesmoInstante = "2026-10-06T12:00:00Z";
    const ida = posicoesNaFila([naFila("b", "aguardando", "t", mesmoInstante), naFila("a", "aguardando", "t", mesmoInstante)]);
    const volta = posicoesNaFila([naFila("a", "aguardando", "t", mesmoInstante), naFila("b", "aguardando", "t", mesmoInstante)]);
    expect(Object.fromEntries(ida)).toEqual({ a: 1, b: 2 });
    expect(Object.fromEntries(volta)).toEqual({ a: 1, b: 2 });
  });

  it("quem está em ligação, no menu, nos avisos ou numa transferência não ocupa lugar", () => {
    const posicoes = posicoesNaFila([
      naFila("ligacao", "em_ligacao", "t", "2026-10-06T12:00:00Z"),
      naFila("menu", "menu", "t", null),
      naFila("avisos", "avisos", "t", null),
      naFila("transferida", "transferencia_na_fila", "t", "2026-10-06T12:00:01Z"),
      naFila("espera", "aguardando", "t", "2026-10-06T12:00:40Z"),
    ]);
    expect(Object.fromEntries(posicoes)).toEqual({ espera: 1 });
  });

  it("ligação sem time forma a sua própria fila; sem instante, fica de fora", () => {
    const posicoes = posicoesNaFila([
      naFila("sem-time-2", "aguardando", null, "2026-10-06T12:00:20Z"),
      naFila("sem-time-1", "aguardando", null, "2026-10-06T12:00:10Z"),
      naFila("com-time", "aguardando", "t", "2026-10-06T12:00:15Z"),
      naFila("sem-instante", "aguardando", "t", null),
    ]);
    expect(Object.fromEntries(posicoes)).toEqual({ "sem-time-1": 1, "sem-time-2": 2, "com-time": 1 });
  });

  it("fila vazia devolve mapa vazio", () => {
    expect(posicoesNaFila([]).size).toBe(0);
  });
});

describe("resumoDoTime", () => {
  const agora = new Date("2026-10-06T12:02:00Z").getTime();
  const ligacoes = [
    naFila("a", "aguardando", "vendas", "2026-10-06T12:01:00Z"), // 60 s
    naFila("b", "tocando", "vendas", "2026-10-06T12:00:15Z"), // 105 s — a mais antiga
    naFila("c", "transferencia_na_fila", "vendas", "2026-10-06T12:01:30Z"), // 30 s
    naFila("d", "em_ligacao", "vendas", "2026-10-06T11:50:00Z"), // não espera
    naFila("e", "aguardando", "suporte", "2026-10-06T11:59:00Z"), // outro time
  ];

  it("conta as que esperam por alguém do time e mede a mais antiga", () => {
    expect(resumoDoTime(ligacoes, "vendas", agora)).toEqual({ esperando: 3, maisAntigaMs: 105_000 });
    expect(resumoDoTime(ligacoes, "suporte", agora)).toEqual({ esperando: 1, maisAntigaMs: 180_000 });
  });

  it("time sem ninguém esperando: zero e sem relógio", () => {
    expect(resumoDoTime(ligacoes, "financeiro", agora)).toEqual({ esperando: 0, maisAntigaMs: null });
  });

  it("relógio do navegador atrasado não vira espera negativa", () => {
    const antes = new Date("2026-10-06T12:00:00Z").getTime();
    expect(resumoDoTime([naFila("a", "aguardando", "t", "2026-10-06T12:00:05Z")], "t", antes)).toEqual({
      esperando: 1,
      maisAntigaMs: 0,
    });
  });

  it("conta quem espera mesmo sem o instante da fila, e não inventa relógio", () => {
    expect(resumoDoTime([naFila("a", "aguardando", "t", null)], "t", agora)).toEqual({ esperando: 1, maisAntigaMs: null });
  });
});

describe("quantasEsperam", () => {
  it("o selo do trilho conta aguardando, tocando e transferência na fila — e só", () => {
    const fases: FaseDaLigacao[] = ["menu", "avisos", "aguardando", "tocando", "em_ligacao", "transferencia_na_fila"];
    expect(quantasEsperam(fases.map((fase) => ({ fase })))).toBe(3);
    expect(quantasEsperam([])).toBe(0);
    expect([...FASES_QUE_ESPERAM].sort()).toEqual(["aguardando", "tocando", "transferencia_na_fila"]);
  });
});

describe("FASES_EM_QUE_SE_AGE — em que fases a tela oferece Atender e Mover (entrega 3)", () => {
  it("só quem espera por uma PESSOA: aguardando e tocando", () => {
    expect([...FASES_EM_QUE_SE_AGE].sort()).toEqual(["aguardando", "tocando"]);
  });

  it("no menu e nos avisos não se age: quem não ouviu o aviso de gravação até o fim não é gravado", () => {
    expect(FASES_EM_QUE_SE_AGE.has("menu")).toBe(false);
    expect(FASES_EM_QUE_SE_AGE.has("avisos")).toBe(false);
  });

  it("a atendida não se puxa nem se move — nem a que foi transferida para a fila de um time, que ESPERA mas já tem dono", () => {
    expect(FASES_EM_QUE_SE_AGE.has("em_ligacao")).toBe(false);
    expect(FASES_QUE_ESPERAM.has("transferencia_na_fila")).toBe(true);
    expect(FASES_EM_QUE_SE_AGE.has("transferencia_na_fila")).toBe(false);
  });

  it("toda fase em que se age é uma fase que espera — o botão nunca aparece numa linha que o selo não conta", () => {
    for (const fase of FASES_EM_QUE_SE_AGE) expect(FASES_QUE_ESPERAM.has(fase)).toBe(true);
  });
});

describe("VALIDADE_DA_ORDEM_DA_FILA_S — a ordem aberta vence", () => {
  it("vence em 30 s: uma ordem esquecida não trava a ligação até o fim dela", () => {
    expect(VALIDADE_DA_ORDEM_DA_FILA_S).toBe(30);
  });

  it("e sobra folga sobre a ordem que AINDA acontece: pelo menos o dobro do toque de quem puxou", () => {
    // Se o toque de quem puxou crescer até perto da validade, o pedido seguinte
    // fecharia como "vencida" uma puxada que ainda toca — e gravaria outra por cima.
    expect(VALIDADE_DA_ORDEM_DA_FILA_S * 1000).toBeGreaterThanOrEqual(2 * TOQUE_DE_QUEM_PUXOU_MS);
  });
});

describe("relogio", () => {
  it.each([
    [0, "0:00"],
    [59_000, "0:59"],
    [59_999, "0:59"], // não arredonda para cima: o segundo só vira quando completa
    [61_000, "1:01"],
    [600_000, "10:00"],
    [3_601_000, "1:00:01"],
    [-5_000, "0:00"],
  ])("%i ms → %s", (ms, texto) => {
    expect(relogio(ms)).toBe(texto);
  });
});

describe("urgenciaDaEspera", () => {
  const agora = 1_000_000;
  const faltam = (s: number) => agora + s * 1000;

  it("sem prazo (há gente livre tocando) é normal, por mais que a espera dure", () => {
    expect(urgenciaDaEspera(null, agora, 600)).toBe("normal");
  });

  it.each([
    // teto de 600 s: metade = 300 s, 20% = 120 s
    [301, "normal"],
    [300, "atencao"],
    [121, "atencao"],
    [120, "critico"],
    [1, "critico"],
    [0, "critico"],
    [-10, "critico"], // o prazo já passou e o worker ainda não derrubou
  ] as const)("teto de 600 s, faltam %i s → %s", (s, urgencia) => {
    expect(urgenciaDaEspera(faltam(s), agora, 600)).toBe(urgencia);
  });

  it("teto nulo é o padrão de sempre (120 s): metade = 60 s, 20% = 24 s", () => {
    expect(ESPERA_NA_FILA_MS).toBe(120_000);
    expect(urgenciaDaEspera(faltam(61), agora, null)).toBe("normal");
    expect(urgenciaDaEspera(faltam(60), agora, null)).toBe("atencao");
    expect(urgenciaDaEspera(faltam(25), agora, null)).toBe("atencao");
    expect(urgenciaDaEspera(faltam(24), agora, null)).toBe("critico");
  });
});

describe("FILA_DESLIGADA", () => {
  it("é a resposta de quem não tem telefonia: inativa e vazia", () => {
    expect(FILA_DESLIGADA).toEqual({ ativa: false, times: [], numeros: [], ligacoes: [], perdidas: [] });
  });
});
