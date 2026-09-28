import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanalAri } from "./ari";
import { ControladorDeChamadas, type PortaAri, type PortaBanco } from "./controle";
import type { LigacaoDoBanco, NovaLigacao, TroncoDoBanco } from "./repositorio";

const ORG = "00000000-0000-0000-0000-00000000000a";
const TRONCO = "11111111-1111-1111-1111-111111111111";
const TIME = "22222222-2222-2222-2222-222222222222";
const ANA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BIA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const tronco: TroncoDoBanco = {
  id: TRONCO,
  organizationId: ORG,
  numero: "+556136861503",
  nome: "Totus",
  servidor: "voip.exemplo.com.br",
  porta: 5060,
  transporte: "udp",
  usuario: "6136861503",
  senha: "x",
  teamId: TIME,
};

function canal(id: string, name: string, extra: Partial<CanalAri> = {}): CanalAri {
  return {
    id,
    name,
    state: "Ring",
    caller: { name: "", number: "61988887777" },
    connected: { name: "", number: "" },
    dialplan: { context: "de-tronco", exten: "6136861503", priority: 1 },
    creationtime: new Date().toISOString(),
    ...extra,
  };
}

class AriFalso implements PortaAri {
  chamadas: Array<[string, ...unknown[]]> = [];
  online = new Set<string>();
  private seq = 0;
  pontesVivas: Array<{ id: string; channels: string[] }> = [];
  canaisVivos: Array<{ id: string }> = [];
  private reg(nome: string, ...args: unknown[]) {
    this.chamadas.push([nome, ...args]);
    return Promise.resolve(undefined);
  }
  atender = (c: string) => this.reg("atender", c);
  indicarChamando = (c: string) => this.reg("indicarChamando", c);
  desligar = (c: string, m?: string) => this.reg("desligar", c, m);
  originar = async (p: { endpoint: string; appArgs: string }) => {
    await this.reg("originar", p.endpoint, p.appArgs);
    return { id: `ramal-canal-${++this.seq}` };
  };
  criarCanal = async (p: { endpoint: string; appArgs: string; callerId?: string }) => {
    await this.reg("criarCanal", p.endpoint, p.appArgs, p.callerId);
    return { id: `perna-${++this.seq}` };
  };
  discar = (c: string, s: number) => this.reg("discar", c, s);
  criarPonte = async (id: string) => {
    await this.reg("criarPonte", id);
    return { id };
  };
  porNaPonte = (p: string, c: string) => this.reg("porNaPonte", p, c);
  destruirPonte = (p: string) => this.reg("destruirPonte", p);
  musicaDeEspera = (c: string) => this.reg("musicaDeEspera", c);
  pararMusica = (c: string) => this.reg("pararMusica", c);
  tocarTom = async (c: string, t: string) => {
    await this.reg("tocarTom", c, t);
    return { id: "tom-1" };
  };
  pararReproducao = (id: string) => this.reg("pararReproducao", id);
  ramalOnline = async (u: string) => this.online.has(u);
  pontes = async () => this.pontesVivas;
  canais = async () => this.canaisVivos;

  nomes() {
    return this.chamadas.map((c) => c[0]);
  }
  originados() {
    return this.chamadas.filter((c) => c[0] === "originar").map((c) => c[1]);
  }
  ultimoOriginado() {
    const n = this.chamadas.filter((c) => c[0] === "originar").length;
    return `ramal-canal-${n}`;
  }
}

class BancoFalso implements PortaBanco {
  ligacoes = new Map<string, LigacaoDoBanco>();
  disponiveis: Array<{ userId: string; atendidasHoje: number; ultimaAtendidaEm: Date | null }> = [];
  eventos: Array<[string, ...unknown[]]> = [];
  private seq = 0;

  troncoPorId = async (id: string) => (id === TRONCO ? tronco : null);
  disponiveisNoTime = async () => this.disponiveis;
  acharOuCriarContato = async () => "contato-1";
  acharOuCriarConversa = async () => "conversa-1";
  criarLigacao = async (l: NovaLigacao) => {
    const id = `vc-${++this.seq}`;
    this.ligacoes.set(id, {
      id,
      organization_id: l.organizationId,
      channel_session_id: l.troncoId,
      contact_id: l.contactId,
      conversation_id: l.conversationId,
      direction: l.direcao,
      peer_phone: l.numeroDoOutroLado,
      status: l.status,
      owner_user_id: null,
      created_by: null,
      team_id: l.teamId,
      started_at: new Date().toISOString(),
      answered_at: null,
      provider: "sip_trunk",
      sip_call_ref: l.sipCallRef,
    });
    return id;
  };
  ligacaoPorId = async (id: string) => this.ligacoes.get(id) ?? null;
  ligacoesVivas = async () => [...this.ligacoes.values()].filter((l) => l.status !== "ended");
  marcarTocando = async (id: string, u: string | null) => {
    this.eventos.push(["tocando", id, u]);
  };
  marcarAtendida = async (id: string, u: string) => {
    const l = this.ligacoes.get(id)!;
    l.status = "connected";
    l.answered_at = new Date().toISOString();
    l.owner_user_id = l.owner_user_id ?? u;
    this.eventos.push(["atendida", id, u]);
  };
  encerrarLigacao = async (id: string, motivo: string) => {
    const l = this.ligacoes.get(id);
    if (!l || l.status === "ended") return null;
    l.status = "ended";
    this.eventos.push(["encerrada", id, motivo]);
    return { ...l };
  };
  atribuirConversa = async (_o: string, c: string, u: string) => {
    this.eventos.push(["atribuida", c, u]);
  };
  registrarNaConversa = async (l: LigacaoDoBanco, d: string) => {
    this.eventos.push(["registro", l.id, d]);
  };
  avisarPerdida = async (l: LigacaoDoBanco) => {
    this.eventos.push(["perdida", l.id]);
  };
  registrarFim = async (l: LigacaoDoBanco, d: string, m: string) => {
    this.eventos.push(["fim", l.id, d, m]);
  };
  tem(nome: string) {
    return this.eventos.filter((e) => e[0] === nome);
  }
}

const log = { info: () => undefined, warn: () => undefined, error: vi.fn() };

let ari: AriFalso;
let banco: BancoFalso;
let ctl: ControladorDeChamadas;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T13:00:00Z"));
  ari = new AriFalso();
  banco = new BancoFalso();
  ctl = new ControladorDeChamadas(ari, banco, log);
  log.error.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  expect(log.error).not.toHaveBeenCalled();
});

const cliente = canal("cli-1", `PJSIP/tronco-${TRONCO}-00000001`);
const entrar = () => ctl.tratar({ type: "StasisStart", channel: cliente, args: ["entrada"] });
const destruir = (id: string, cause = 16) =>
  ctl.tratar({ type: "ChannelDestroyed", channel: canal(id, "x"), cause });
const ramalAtende = (canalId: string, vcId = "vc-1") =>
  ctl.tratar({ type: "StasisStart", channel: canal(canalId, "PJSIP/ramal-x-00000009"), args: ["oferta", vcId] });

describe("recebida", () => {
  it("toca primeiro quem atendeu menos hoje e faz a ponte quando atende", async () => {
    banco.disponiveis = [
      { userId: ANA, atendidasHoje: 3, ultimaAtendidaEm: null },
      { userId: BIA, atendidasHoje: 1, ultimaAtendidaEm: null },
    ];
    ari.online.add(ANA).add(BIA);
    await entrar();

    expect(ari.nomes().slice(0, 1)).toEqual(["indicarChamando"]);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${BIA}`]);
    expect(banco.tem("tocando")).toEqual([["tocando", "vc-1", BIA]]);

    await ramalAtende(ari.ultimoOriginado());
    expect(ari.chamadas).toContainEqual(["atender", "cli-1"]);
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "cli-1"]);
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "ramal-canal-1"]);
    expect(banco.tem("atendida")).toEqual([["atendida", "vc-1", BIA]]);
    expect(banco.tem("atribuida")).toEqual([["atribuida", "conversa-1", BIA]]);

    await destruir("cli-1");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-1", undefined]);
    expect(banco.tem("registro")).toEqual([["registro", "vc-1", "atendida"]]);
    expect(banco.tem("perdida")).toEqual([]);
    expect(ctl.ativas).toBe(0);
  });

  it("ramal sem navegador não toca", async () => {
    banco.disponiveis = [
      { userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null },
      { userId: BIA, atendidasHoje: 5, ultimaAtendidaEm: null },
    ];
    ari.online.add(BIA);
    await entrar();
    expect(ari.originados()).toEqual([`PJSIP/ramal-${BIA}`]);
  });

  it("ninguém atende: duas voltas, segura na linha na segunda, e vira perdida com aviso", async () => {
    banco.disponiveis = [
      { userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null },
      { userId: BIA, atendidasHoje: 1, ultimaAtendidaEm: null },
    ];
    ari.online.add(ANA).add(BIA);
    await entrar();
    await destruir("ramal-canal-1", 19);
    await destruir("ramal-canal-2", 21);
    expect(ari.chamadas).toContainEqual(["atender", "cli-1"]);
    expect(ari.chamadas).toContainEqual(["musicaDeEspera", "cli-1"]);
    await destruir("ramal-canal-3", 19);
    await destruir("ramal-canal-4", 19);

    expect(ari.originados()).toEqual([
      `PJSIP/ramal-${ANA}`,
      `PJSIP/ramal-${BIA}`,
      `PJSIP/ramal-${ANA}`,
      `PJSIP/ramal-${BIA}`,
    ]);
    expect(ari.chamadas).toContainEqual(["desligar", "cli-1", undefined]);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "ninguem_atendeu"]]);
    expect(banco.tem("registro")).toEqual([["registro", "vc-1", "perdida"]]);
    expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
  });

  it("ninguém disponível: atende, música, reavalia e toca quem chega", async () => {
    await entrar();
    expect(ari.chamadas).toContainEqual(["musicaDeEspera", "cli-1"]);
    expect(ari.originados()).toEqual([]);

    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);

    await ramalAtende(ari.ultimoOriginado());
    expect(ari.chamadas).toContainEqual(["pararMusica", "cli-1"]);
    expect(banco.tem("atendida")).toHaveLength(1);
  });

  it("fila esgota em 2 min: perdida", async () => {
    await entrar();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
    expect(banco.tem("perdida")).toHaveLength(1);
  });

  it("cliente desiste enquanto toca: derruba o ramal, perdida", async () => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await entrar();
    await destruir("cli-1");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-1", undefined]);
    expect(banco.tem("perdida")).toHaveLength(1);
    // O ramal que cai depois não reabre nada.
    await destruir("ramal-canal-1");
    expect(ari.originados()).toHaveLength(1);
  });

  it("atendimento tardio de um toque já vencido é largado", async () => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await entrar();
    await ramalAtende("ramal-canal-99");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-99", undefined]);
    expect(banco.tem("atendida")).toEqual([]);
  });

  it("canal que não veio de tronco é desligado sem criar nada", async () => {
    await ctl.tratar({ type: "StasisStart", channel: canal("z", "PJSIP/estranho-00000001"), args: ["entrada"] });
    expect(ari.chamadas).toEqual([["desligar", "z", "congestion"]]);
    expect(banco.ligacoes.size).toBe(0);
  });
});

describe("feita", () => {
  async function pedido(p: Partial<LigacaoDoBanco> = {}) {
    const id = "00000000-0000-4000-8000-000000000001";
    banco.ligacoes.set(id, {
      id,
      organization_id: ORG,
      channel_session_id: TRONCO,
      contact_id: "contato-1",
      conversation_id: "conversa-1",
      direction: "outbound",
      peer_phone: "+5561988887777",
      status: "starting",
      owner_user_id: ANA,
      created_by: ANA,
      team_id: null,
      started_at: new Date().toISOString(),
      answered_at: null,
      provider: "sip_trunk",
      sip_call_ref: `pedido-${id}`,
      ...p,
    });
    await ctl.tratar({
      type: "StasisStart",
      channel: canal("ramal-a", `PJSIP/ramal-${ANA}-0000000a`, {
        dialplan: { context: "de-ramal", exten: `c-${id}`, priority: 1 },
      }),
      args: ["saida"],
    });
    return id;
  }

  it("pedido válido: ponte antes de discar, pelo tronco, com a grafia nacional", async () => {
    const id = await pedido();
    expect(ari.chamadas).toContainEqual(["atender", "ramal-a"]);
    expect(ari.chamadas).toContainEqual(["criarPonte", `p-${id}`]);
    expect(ari.chamadas).toContainEqual(["criarCanal", `PJSIP/61988887777@tronco-${TRONCO}`, `perna,${id}`, "6136861503"]);
    const nomes = ari.nomes();
    expect(nomes.indexOf("porNaPonte")).toBeLessThan(nomes.indexOf("discar"));

    const perna = ari.chamadas.find((c) => c[0] === "discar")![1] as string;
    await ctl.tratar({ type: "Dial", peer: canal(perna, "PJSIP/tronco-x-00000002"), dialstatus: "ANSWER" });
    expect(ari.chamadas).toContainEqual(["pararReproducao", "tom-1"]);
    expect(banco.tem("atendida")).toEqual([["atendida", id, ANA]]);

    await destruir(perna);
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-a", undefined]);
    expect(banco.tem("registro")).toEqual([["registro", id, "atendida"]]);
    expect(banco.tem("perdida")).toEqual([]);
  });

  it("ninguém atendeu do outro lado: sem resposta, sem aviso de perdida", async () => {
    const id = await pedido();
    const perna = ari.chamadas.find((c) => c[0] === "discar")![1] as string;
    await destruir(perna, 19);
    expect(banco.tem("registro")).toEqual([["registro", id, "sem_resposta"]]);
    expect(banco.tem("perdida")).toEqual([]);
  });

  it("número inexistente: a rede recusou", async () => {
    const id = await pedido();
    const perna = ari.chamadas.find((c) => c[0] === "discar")![1] as string;
    await destruir(perna, 1);
    expect(banco.tem("registro")).toEqual([["registro", id, "recusada_pela_rede"]]);
  });

  it("fim que chega só pelo StasisEnd (sem ChannelDestroyed) fecha a ligação — medido na prova", async () => {
    const id = await pedido();
    const perna = ari.chamadas.find((c) => c[0] === "discar")![1] as string;
    await ctl.tratar({ type: "Dial", peer: canal(perna, "PJSIP/tronco-x-00000002"), dialstatus: "ANSWER" });
    await ctl.tratar({ type: "StasisEnd", channel: canal("ramal-a", "PJSIP/ramal-x-0000000a") });
    expect(ari.chamadas).toContainEqual(["desligar", perna, undefined]);
    expect(banco.tem("encerrada")).toEqual([["encerrada", id, "atendente_desligou"]]);
    // O ChannelDestroyed que chega depois não fecha de novo.
    await destruir("ramal-a");
    expect(banco.tem("encerrada")).toHaveLength(1);
  });

  it.each([
    ["CHANUNAVAIL", "recusada_pela_rede"],
    ["BUSY", "sem_resposta"],
  ])("Dial %s + StasisEnd sem causa → %s", async (status, desfecho) => {
    const id = await pedido();
    const perna = ari.chamadas.find((c) => c[0] === "discar")![1] as string;
    await ctl.tratar({ type: "Dial", peer: canal(perna, "PJSIP/tronco-x-00000002"), dialstatus: status });
    await ctl.tratar({ type: "StasisEnd", channel: canal(perna, "PJSIP/tronco-x-00000002") });
    expect(banco.tem("registro")).toEqual([["registro", id, desfecho]]);
  });

  it.each([
    ["de outro atendente", { owner_user_id: BIA }],
    ["já usado", { status: "ringing" }],
    ["recebida", { direction: "inbound" as const }],
  ])("pedido %s: desliga o ramal e não disca", async (_n, p) => {
    await pedido(p);
    expect(ari.chamadas).toEqual([["desligar", "ramal-a", "congestion"]]);
  });

  it("pedido expirado é encerrado e não disca", async () => {
    const id = await pedido({ started_at: new Date(Date.now() - 61_000).toISOString() });
    expect(ari.nomes()).toEqual(["desligar"]);
    expect(banco.tem("encerrada")).toEqual([["encerrada", id, "pedido_expirado"]]);
  });

  it("número internacional gravado no pedido não sai (defesa em profundidade)", async () => {
    const id = await pedido({ peer_phone: "+12125550100" });
    expect(ari.nomes()).toEqual(["desligar"]);
    expect(banco.tem("encerrada")).toEqual([["encerrada", id, "numero_internacional"]]);
  });

  it("destino que não é pedido (discagem direta pelo ramal) é recusado", async () => {
    await ctl.tratar({
      type: "StasisStart",
      channel: canal("ramal-b", `PJSIP/ramal-${ANA}-0000000b`, {
        dialplan: { context: "de-ramal", exten: "0011234567890", priority: 1 },
      }),
      args: ["saida"],
    });
    expect(ari.chamadas).toEqual([["desligar", "ramal-b", "congestion"]]);
  });
});

describe("recuperar após reinício", () => {
  it("ponte viva volta a ser vigiada; o que só tocava vira perdida", async () => {
    await banco.criarLigacao({
      organizationId: ORG, troncoId: TRONCO, sipCallRef: "cli-a", direcao: "inbound",
      numeroDoOutroLado: "+5561988887777", contactId: "contato-1", conversationId: "conversa-1",
      teamId: TIME, status: "ringing",
    });
    banco.ligacoes.get("vc-1")!.answered_at = new Date().toISOString();
    await banco.criarLigacao({
      organizationId: ORG, troncoId: TRONCO, sipCallRef: "cli-b", direcao: "inbound",
      numeroDoOutroLado: "+5561977776666", contactId: "contato-1", conversationId: "conversa-1",
      teamId: TIME, status: "ringing",
    });
    ari.pontesVivas = [{ id: "p-vc-1", channels: ["cli-a", "ramal-a"] }];
    ari.canaisVivos = [{ id: "cli-a" }, { id: "ramal-a" }, { id: "cli-b" }];

    await ctl.recuperar();
    expect(ari.chamadas).toContainEqual(["desligar", "cli-b", undefined]);
    expect(banco.tem("perdida")).toEqual([["perdida", "vc-2"]]);
    expect(ctl.ativas).toBe(1);

    await destruir("cli-a");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-a", undefined]);
    expect(banco.tem("registro")).toContainEqual(["registro", "vc-1", "atendida"]);
    expect(ctl.ativas).toBe(0);
  });
});
