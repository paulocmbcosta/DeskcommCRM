/**
 * OS RAMAIS NO WORKER (v3; desenho §12.2): a ligação INTERNA de ramal para
 * ramal e a URA que aceita o ramal digitado — com a ARI e o banco de mentira.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ControladorDeChamadas } from "./controle";
import { ANA, AriFalso, BIA, BancoFalso, FalasFalsas, ORG, TIME, TRONCO, canal, falaDe, tronco } from "./dubles-de-teste";
import type { LigacaoDoBanco, MenuDoBanco } from "./repositorio";

const log = { info: () => undefined, warn: vi.fn(), error: vi.fn() };

let ari: AriFalso;
let banco: BancoFalso;
let ctl: ControladorDeChamadas;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T13:00:00Z"));
  ari = new AriFalso();
  banco = new BancoFalso();
  ctl = new ControladorDeChamadas(ari, banco, log, () => Date.now(), new FalasFalsas());
  log.error.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  expect(log.error).not.toHaveBeenCalled();
  expect(banco.tem("org_errada")).toEqual([]);
});

const destruir = (id: string, cause = 16) => ctl.tratar({ type: "ChannelDestroyed", channel: canal(id, "x"), cause });

describe("ligação interna (D23)", () => {
  const ID = "00000000-0000-4000-8000-0000000000aa";

  async function interna(p: Partial<LigacaoDoBanco> = {}) {
    banco.ligacoes.set(ID, {
      id: ID,
      organization_id: ORG,
      channel_session_id: null as unknown as string,
      contact_id: null,
      conversation_id: null,
      direction: "internal",
      peer_phone: "202",
      status: "starting",
      owner_user_id: ANA,
      created_by: ANA,
      team_id: null,
      started_at: new Date().toISOString(),
      answered_at: null,
      provider: "sip_trunk",
      sip_call_ref: `pedido-${ID}`,
      peer_user_id: BIA,
      ...p,
    });
    banco.ramais.set("201", ANA).set("202", BIA);
    await ctl.tratar({
      type: "StasisStart",
      channel: canal("ramal-a", `PJSIP/ramal-${ANA}-0000000a`, { dialplan: { context: "de-ramal", exten: `c-${ID}`, priority: 1 } }),
      args: ["saida"],
    });
  }

  it("o colega atende: ponte entre os dois ramais, sem operadora, sem conversa", async () => {
    ari.online.add(BIA);
    await interna();
    expect(ari.chamadas.slice(0, 4)).toEqual([
      ["atender", "ramal-a"],
      ["criarPonte", `p-${ID}`],
      ["porNaPonte", `p-${ID}`, "ramal-a"],
      ["tocarTom", "ramal-a", "ring"],
    ]);
    expect(ari.chamadas).toContainEqual(["originar", `PJSIP/ramal-${BIA}`, `interna,${ID}`]);
    expect(ari.nomes()).not.toContain("criarCanal"); // nada de perna na operadora
    expect(banco.tem("tocando")).toEqual([["tocando", ID, BIA]]);

    await ctl.tratar({ type: "StasisStart", channel: canal("ramal-canal-1", "PJSIP/ramal-x-00000009"), args: ["interna", ID] });
    expect(ari.chamadas).toContainEqual(["pararReproducao", "tom-1"]);
    expect(ari.chamadas).toContainEqual(["porNaPonte", `p-${ID}`, "ramal-canal-1"]);
    expect(banco.tem("atendida")).toEqual([["atendida", ID, ANA]]);

    await destruir("ramal-canal-1");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-a", undefined]);
    expect(banco.tem("encerrada")).toEqual([["encerrada", ID, "colega_desligou"]]);
    expect(banco.tem("perdida")).toEqual([]);
    expect(ctl.ativas).toBe(0);
  });

  it("o colega não atende: ocupado para quem ligou, e o fim (sem 'Ligar de volta')", async () => {
    ari.online.add(BIA);
    await interna();
    await destruir("ramal-canal-1", 19);
    expect(ari.chamadas).toContainEqual(["tocarTom", "ramal-a", "busy"]);
    expect(ctl.ativas).toBe(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", ID, "colega_nao_atendeu"]]);
    expect(banco.tem("registro")).toEqual([["registro", ID, "sem_resposta"]]);
    expect(banco.tem("perdida")).toEqual([]);
  });

  it("o colega está em outra ligação: nem toca — ocupado e fim", async () => {
    ari.online.add(BIA);
    banco.ocupados.add(BIA);
    await interna();
    expect(ari.originados()).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", ID, "colega_ocupado"]]);
  });

  it("o colega está offline", async () => {
    await interna();
    expect(ari.originados()).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", ID, "colega_offline"]]);
  });

  it("quem ligou desiste enquanto toca: o ramal do colega cai junto", async () => {
    ari.online.add(BIA);
    await interna();
    await destruir("ramal-a");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-1", undefined]);
    expect(banco.tem("encerrada")).toEqual([["encerrada", ID, "atendente_desligou"]]);
  });

  it("pedido de mais de 60 s não liga", async () => {
    ari.online.add(BIA);
    await interna({ started_at: new Date(Date.now() - 61_000).toISOString() });
    expect(ari.originados()).toEqual([]);
    expect(banco.tem("encerrada")).toEqual([["encerrada", ID, "pedido_expirado"]]);
  });
});

describe("URA que aceita ramal", () => {
  const MENU = "33333333-3333-3333-3333-333333333333";
  const TIME2 = "44444444-4444-4444-4444-444444444444";
  const menu = (p: Partial<MenuDoBanco> = {}): MenuDoBanco => ({
    id: MENU,
    nome: "Atendimento",
    defaultTeamId: TIME,
    timePadraoAtivo: true,
    fala: falaDe("menu", 4_000),
    falaInvalida: falaDe("invalida", 2_000),
    opcoes: [
      { digito: "1", teamId: TIME },
      { digito: "2", teamId: TIME2 },
    ],
    aceitaRamal: true,
    ...p,
  });
  const cliente = canal("cli-1", `PJSIP/tronco-${TRONCO}-00000001`);
  const entrar = () => ctl.tratar({ type: "StasisStart", channel: cliente, args: ["entrada"] });
  const digita = async (...d: string[]) => {
    for (const x of d) await ctl.tratar({ type: "ChannelDtmfReceived", channel: canal("cli-1", "x"), digit: x });
  };

  beforeEach(() => {
    banco.troncoAtual = { ...tronco, teamId: null, menuId: MENU };
    banco.menus.set(MENU, menu());
    banco.ramais.set("201", BIA);
  });

  it("digitou o ramal de quem está livre: essa pessoa toca primeiro, sozinha, e atende", async () => {
    ari.online.add(BIA);
    await entrar();
    await digita("2", "0", "1");
    expect(ari.chamadas).toContainEqual(["pararFala", "fala-1"]);
    expect(ari.originados()).toEqual([]); // ainda espera a próxima tecla
    await vi.advanceTimersByTimeAsync(2_000);

    expect(banco.tem("escolha")).toEqual([["escolha", ORG, "vc-1", null, "chosen", TIME]]);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${BIA}`]);
    expect(ari.chamadas).toContainEqual(["tocarTom", "cli-1", "ring"]);
    // Direto na pessoa: a fila do time (fora do horário, aviso) não entrou.
    expect(banco.tem("entrou_na_fila")).toEqual([]);

    await ctl.tratar({ type: "StasisStart", channel: canal("ramal-canal-1", "PJSIP/ramal-x-00000009"), args: ["oferta", "vc-1"] });
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "ramal-canal-1"]);
    expect(banco.tem("atendida")).toEqual([["atendida", "vc-1", BIA]]);
  });

  it("a pessoa do ramal não atende: a fila do time padrão do menu, inteira", async () => {
    ari.online.add(BIA).add(ANA);
    await entrar();
    await digita("2", "0", "1", "#");
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    await destruir("ramal-canal-1", 19);
    expect(banco.tem("entrou_na_fila")).toEqual([["entrou_na_fila", ORG, TIME]]);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${BIA}`, `PJSIP/ramal-${ANA}`]);
  });

  it("ramal que não existe: a fala de tecla inválida e o menu de novo", async () => {
    await entrar();
    await digita("9", "9");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ari.falas()).toEqual(["sound:/falas/menu", "sound:/falas/invalida"]);
    expect(ari.originados()).toEqual([]);
    expect(banco.tem("escolha")).toEqual([]);
  });

  it("ramal de quem está ocupado conta como inválido", async () => {
    ari.online.add(BIA);
    banco.ocupados.add(BIA);
    await entrar();
    await digita("2", "0", "1", "#");
    expect(ari.falas()).toEqual(["sound:/falas/menu", "sound:/falas/invalida"]);
  });

  it("um dígito só continua sendo a opção, 2 s depois", async () => {
    await entrar();
    await digita("2");
    expect(banco.tem("escolha")).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(banco.tem("escolha")).toEqual([["escolha", ORG, "vc-1", "2", "chosen", TIME2]]);
  });
});
