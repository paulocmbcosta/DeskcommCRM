import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErroAri, type CanalAri } from "./ari";
import {
  ControladorDeChamadas,
  FOLGA_DO_FIM_DA_FALA_MS,
  REPETIR_AGUARDE_MS,
  type PortaAri,
  type PortaBanco,
  type PortaFalas,
} from "./controle";
import type {
  EscolhaDoMenu,
  FalaDoBanco,
  FalasGerais,
  LigacaoDoBanco,
  MenuDoBanco,
  NovaLigacao,
  SituacaoDoTime,
  TroncoDoBanco,
} from "./repositorio";

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
  prefixo: null,
};

/** Uma fala pronta (3 s, se o teste não disser); o dublê do disco a entrega como `sound:/falas/<id>`. */
const falaDe = (id: string, duracaoMs = 3_000): FalaDoBanco => ({ id, storagePath: `${ORG}/${id}.ulaw`, duracaoMs });

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
  /** Falas que o "Asterisk" recusa tocar (a ARI responde erro), pela mídia. */
  recusaFala = new Set<string>();
  private seq = 0;
  private seqFala = 0;
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
  tocarFala = async (c: string, m: string) => {
    await this.reg("tocarFala", c, m);
    if (this.recusaFala.has(m)) throw new ErroAri(500, "Internal Server Error", `/channels/${c}/play`);
    return `fala-${++this.seqFala}`;
  };
  pararFala = (id: string) => this.reg("pararFala", id);
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
  /** As mídias pedidas ao Asterisk, em ordem (inclusive as recusadas). */
  falas() {
    return this.chamadas.filter((c) => c[0] === "tocarFala").map((c) => c[2]);
  }
  /** O id do último playback que o "Asterisk" aceitou. */
  ultimaFala() {
    return `fala-${this.seqFala}`;
  }
}

class BancoFalso implements PortaBanco {
  ligacoes = new Map<string, LigacaoDoBanco>();
  disponiveis: Array<{ userId: string; atendidasHoje: number; ultimaAtendidaEm: Date | null }> = [];
  eventos: Array<[string, ...unknown[]]> = [];
  /** O que `timeParaAFila` devolve; `falharFila` simula o banco fora do ar. */
  situacao: SituacaoDoTime = "aberto";
  aviso: FalaDoBanco | null = null;
  falharFila = false;
  gerais: FalasGerais = { aguarde: null, ninguem: null, foraDoHorario: null };
  menus = new Map<string, MenuDoBanco>();
  /** Com que (organização, time) a fila foi consultada. */
  consultas: Array<[string, ...unknown[]]> = [];
  private seq = 0;

  troncoAtual: TroncoDoBanco = tronco;
  troncoPorId = async (id: string) => (id === TRONCO ? this.troncoAtual : null);
  /** Quantas leituras de `disponiveisNoTime` ainda falham (banco fora do ar). */
  falharDisponiveis = 0;
  disponiveisNoTime = async () => {
    if (this.falharDisponiveis > 0) {
      this.falharDisponiveis--;
      throw new Error("banco fora do ar");
    }
    return this.disponiveis;
  };
  timeParaAFila = async (org: string, teamId: string) => {
    this.consultas.push(["timeParaAFila", org, teamId]);
    if (this.falharFila) throw new Error("banco fora do ar");
    return { situacao: this.situacao, aviso: this.aviso };
  };
  falasGerais = async (org: string) => {
    this.consultas.push(["falasGerais", org]);
    return this.gerais;
  };
  menuPorId = async (_o: string, id: string) => this.menus.get(id) ?? null;
  registrarEscolhaDoMenu = async (org: string, id: string, e: EscolhaDoMenu) => {
    this.eventos.push(["escolha", org, id, e.digito, e.desfecho, e.teamId]);
    return true;
  };
  registrarAvisoOuvido = async (org: string, id: string) => {
    this.eventos.push(["ouviu_aviso", org, id]);
    return true;
  };
  avisarFalaIntocavel = async (org: string, rotulo: string) => {
    this.eventos.push(["fala_intocavel", org, rotulo]);
  };
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
    l.end_reason = motivo;
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

/** O disco das falas: tudo está lá, menos o que o teste tirar. */
class FalasFalsas implements PortaFalas {
  semArquivo = new Set<string>();
  pedidas: string[] = [];
  garantir = async (f: FalaDoBanco) => {
    this.pedidas.push(f.id);
    return this.semArquivo.has(f.id) ? null : `sound:/falas/${f.id}`;
  };
}

const log = { info: () => undefined, warn: () => undefined, error: vi.fn() };

let ari: AriFalso;
let banco: BancoFalso;
let falas: FalasFalsas;
let ctl: ControladorDeChamadas;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T13:00:00Z"));
  ari = new AriFalso();
  banco = new BancoFalso();
  falas = new FalasFalsas();
  ctl = new ControladorDeChamadas(ari, banco, log, () => Date.now(), falas);
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
/** O fim de uma fala, como a ARI entrega: `done` (tocou até o fim ou foi parada) ou `failed`. */
const terminou = (id: string, state: "done" | "failed" = "done") =>
  ctl.tratar({
    type: "PlaybackFinished",
    playback: { id, media_uri: "sound:/falas/x", target_uri: "channel:cli-1", language: "en", state },
  });
/**
 * O cliente desliga NO MEIO de uma fala, na ordem em que o Asterisk publica:
 * o pedido de desligar, a fala que morre como `failed` (res_stasis_playback
 * chama de "Playback failed" a fala cortada pela queda do canal), e o fim do canal.
 */
const clienteDesligaDuranteAFala = async (playbackId: string) => {
  await ctl.tratar({ type: "ChannelHangupRequest", channel: cliente, cause: 16 });
  await terminou(playbackId, "failed");
  await ctl.tratar({ type: "StasisEnd", channel: cliente });
  await destruir("cli-1");
};

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
    await ctl.tratar({ type: "Dial", peer: canal(perna, "PJSIP/tronco-x-00000002"), dialstatus: "RINGING" });
    await destruir(perna, 19);
    expect(banco.tem("registro")).toEqual([["registro", id, "sem_resposta"]]);
    expect(banco.tem("encerrada")).toEqual([["encerrada", id, "sem_resposta_19"]]);
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

describe("feita — prefixo de discagem do tronco", () => {
  const ID = "00000000-0000-4000-8000-000000000002";
  async function discarPara(peerPhone: string) {
    banco.ligacoes.set(ID, {
      id: ID,
      organization_id: ORG,
      channel_session_id: TRONCO,
      contact_id: "contato-1",
      conversation_id: "conversa-1",
      direction: "outbound",
      peer_phone: peerPhone,
      status: "starting",
      owner_user_id: ANA,
      created_by: ANA,
      team_id: null,
      started_at: new Date().toISOString(),
      answered_at: null,
      provider: "sip_trunk",
      sip_call_ref: `pedido-${ID}`,
    });
    await ctl.tratar({
      type: "StasisStart",
      channel: canal("ramal-p", `PJSIP/ramal-${ANA}-0000000c`, {
        dialplan: { context: "de-ramal", exten: `c-${ID}`, priority: 1 },
      }),
      args: ["saida"],
    });
  }
  const criados = () => ari.chamadas.filter((c) => c[0] === "criarCanal").map((c) => c[1]);

  it("sem prefixo: DDD + número, como antes", async () => {
    await discarPara("+5561995140098");
    expect(criados()).toEqual([`PJSIP/61995140098@tronco-${TRONCO}`]);
  });

  it("prefixo 0 (o da Totus): o 0 vai na frente do DDD", async () => {
    banco.troncoAtual = { ...tronco, prefixo: "0" };
    await discarPara("+5561995140098");
    expect(criados()).toEqual([`PJSIP/061995140098@tronco-${TRONCO}`]);
  });

  it("prefixo de operadora (015) também", async () => {
    banco.troncoAtual = { ...tronco, prefixo: "015" };
    await discarPara("+5561995140098");
    expect(criados()).toEqual([`PJSIP/01561995140098@tronco-${TRONCO}`]);
  });

  it("o 0 que o atendente digitou não soma com o do tronco: a política julga o número SEM prefixo", async () => {
    banco.troncoAtual = { ...tronco, prefixo: "0" };
    await discarPara("0 61 99514-0098");
    expect(criados()).toEqual([`PJSIP/061995140098@tronco-${TRONCO}`]);
  });

  it.each(["0@10.0.0.5", "0/x", "0,1", "01234", "0a", " 0"])(
    "prefixo %j gravado direto no banco não vira destino: não disca e encerra a ligação",
    async (prefixo) => {
      banco.troncoAtual = { ...tronco, prefixo };
      await discarPara("+5561995140098");
      expect(criados()).toEqual([]);
      expect(ari.chamadas).toEqual([["desligar", "ramal-p", "congestion"]]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", ID, "tronco_configuracao_invalida"]]);
    },
  );
});

describe("feita — a operadora recusa antes de tocar (sequência medida no Asterisk 20.11.1)", () => {
  async function pedirEDiscar() {
    const id = "00000000-0000-4000-8000-000000000003";
    banco.ligacoes.set(id, {
      id,
      organization_id: ORG,
      channel_session_id: TRONCO,
      contact_id: "contato-1",
      conversation_id: "conversa-1",
      direction: "outbound",
      peer_phone: "+5561995140098",
      status: "starting",
      owner_user_id: ANA,
      created_by: ANA,
      team_id: null,
      started_at: new Date().toISOString(),
      answered_at: null,
      provider: "sip_trunk",
      sip_call_ref: `pedido-${id}`,
    });
    await ctl.tratar({
      type: "StasisStart",
      channel: canal("ramal-r", `PJSIP/ramal-${ANA}-0000000d`, {
        dialplan: { context: "de-ramal", exten: `c-${id}`, priority: 1 },
      }),
      args: ["saida"],
    });
    const perna = ari.chamadas.find((c) => c[0] === "discar")![1] as string;
    return { id, perna, canalDaPerna: canal(perna, `PJSIP/tronco-${TRONCO}-00000000`, { state: "Down" }) };
  }

  it("404 + Reason Q.850 cause=16 em 0,2 s: não completada, com a causa no motivo — não 'sem resposta' nem 'rede_undefined'", async () => {
    const { id, canalDaPerna } = await pedirEDiscar();
    // Exatamente o que a ARI entregou (operadora falsa respondendo 100 + 404).
    await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "" });
    await ctl.tratar({ type: "ChannelHangupRequest", channel: canalDaPerna });
    await ctl.tratar({ type: "StasisEnd", channel: canalDaPerna });
    await ctl.tratar({ type: "ChannelDestroyed", channel: canalDaPerna, cause: 16, cause_txt: "Normal Clearing" });

    expect(banco.tem("encerrada")).toEqual([["encerrada", id, "nao_completada_16"]]);
    expect(banco.tem("registro")).toEqual([["registro", id, "recusada_pela_rede"]]);
    expect(banco.tem("fim")).toEqual([["fim", id, "recusada_pela_rede", "nao_completada_16"]]);
    expect(banco.tem("perdida")).toEqual([]);
  });

  it("o chamar para ANTES de o ramal cair — senão o Asterisk registra 'Playback failed'", async () => {
    const { canalDaPerna } = await pedirEDiscar();
    await ctl.tratar({ type: "StasisEnd", channel: canalDaPerna });
    const nomes = ari.chamadas.map((c) => `${c[0]}:${String(c[1])}`);
    expect(nomes).toContain("pararReproducao:tom-1");
    expect(nomes.indexOf("pararReproducao:tom-1")).toBeLessThan(nomes.indexOf("desligar:ramal-r"));
  });

  it("tocou (RINGING) e a rede desistiu com 480 → cause 19: sem resposta", async () => {
    const { id, canalDaPerna } = await pedirEDiscar();
    await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "RINGING" });
    await ctl.tratar({ type: "ChannelHangupRequest", channel: canalDaPerna, cause: 19 });
    await ctl.tratar({ type: "StasisEnd", channel: canalDaPerna });
    expect(banco.tem("encerrada")).toEqual([["encerrada", id, "sem_resposta_19"]]);
    expect(banco.tem("registro")).toEqual([["registro", id, "sem_resposta"]]);
  });

  it("486 sem tocar → cause 17: ocupado (desfecho sem resposta)", async () => {
    const { id, canalDaPerna } = await pedirEDiscar();
    await ctl.tratar({ type: "ChannelHangupRequest", channel: canalDaPerna, cause: 17 });
    await ctl.tratar({ type: "StasisEnd", channel: canalDaPerna });
    expect(banco.tem("encerrada")).toEqual([["encerrada", id, "ocupado_17"]]);
    expect(banco.tem("registro")).toEqual([["registro", id, "sem_resposta"]]);
  });

  it("o atendente desiste antes de a rede responder: nada de causa da rede no motivo", async () => {
    const { id } = await pedirEDiscar();
    await ctl.tratar({ type: "StasisEnd", channel: canal("ramal-r", `PJSIP/ramal-${ANA}-0000000d`) });
    expect(banco.tem("encerrada")).toEqual([["encerrada", id, "atendente_desligou"]]);
    expect(banco.tem("registro")).toEqual([["registro", id, "sem_resposta"]]);
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

describe("fila do time — as falas da fase 2 (§5.2)", () => {
  const FORA = falaDe("fora");
  const AVISO = falaDe("aviso", 60_000); // um aviso de um minuto
  const AGUARDE = falaDe("aguarde");
  const NINGUEM = falaDe("ninguem");
  const anaDisponivel = () => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
  };

  describe("a fase 1 continua igual quando não há fala nenhuma", () => {
    it("time sem falas: a fila é consultada com a organização e o time, e nada toca além da música", async () => {
      await entrar();
      expect(banco.consultas).toEqual([
        ["timeParaAFila", ORG, TIME],
        ["falasGerais", ORG],
      ]);
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "musicaDeEspera"]);

      await vi.advanceTimersByTimeAsync(125_000);
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "musicaDeEspera", "desligar"]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
      expect(falas.pedidas).toEqual([]);
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("número sem time: as falas gerais valem, mas não há time para consultar", async () => {
      banco.troncoAtual = { ...tronco, teamId: null };
      await entrar();
      expect(banco.consultas).toEqual([["falasGerais", ORG]]);
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "musicaDeEspera"]);
    });

    it("o banco falha ao ler a situação do time: a ligação segue a fila da fase 1, sem travar", async () => {
      banco.falharFila = true;
      anaDisponivel();
      await entrar();
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
      expect(ari.falas()).toEqual([]);
    });
  });

  describe("fora do horário", () => {
    it("COM fala: atende, toca e só desliga no fim dela — after_hours, sem aviso de perdida na Central", async () => {
      banco.situacao = "fora_do_horario";
      banco.gerais = { ...banco.gerais, foraDoHorario: FORA };
      await entrar();
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "tocarFala"]);
      expect(ari.falas()).toEqual(["sound:/falas/fora"]);
      expect(banco.tem("encerrada")).toEqual([]);

      await terminou("fala-1");
      expect(ari.chamadas.at(-1)).toEqual(["desligar", "cli-1", undefined]);
      expect(ari.originados()).toEqual([]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "after_hours"]]);
      expect(banco.tem("registro")).toEqual([["registro", "vc-1", "perdida"]]);
      expect(banco.tem("fim")).toEqual([["fim", "vc-1", "perdida", "after_hours"]]);
      expect(banco.tem("perdida")).toEqual([]);
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(ctl.ativas).toBe(0);
    });

    it("vem ANTES do aviso de instabilidade: o aviso não toca", async () => {
      banco.situacao = "fora_do_horario";
      banco.gerais = { ...banco.gerais, foraDoHorario: FORA };
      banco.aviso = AVISO;
      await entrar();
      await terminou("fala-1");
      expect(ari.falas()).toEqual(["sound:/falas/fora"]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "after_hours"]]);
      expect(banco.tem("ouviu_aviso")).toEqual([]);
    });

    it("o cliente desliga no meio da fala: after_hours, sem aviso de perdida e sem 'fala não tocou'", async () => {
      banco.situacao = "fora_do_horario";
      banco.gerais = { ...banco.gerais, foraDoHorario: FORA };
      await entrar();
      await clienteDesligaDuranteAFala("fala-1");
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "after_hours"]]);
      expect(banco.tem("perdida")).toEqual([]);
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("SEM fala salva: segue a fase 1 — fila, e perdida com aviso", async () => {
      banco.situacao = "fora_do_horario";
      await entrar();
      expect(ari.falas()).toEqual([]);
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "musicaDeEspera"]);
      await vi.advanceTimersByTimeAsync(125_000);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    });

    it("fala sem arquivo no disco: pulada, avisada na Central, e a ligação segue a fase 1 (perdida com aviso)", async () => {
      banco.situacao = "fora_do_horario";
      banco.gerais = { ...banco.gerais, foraDoHorario: FORA };
      falas.semArquivo.add(FORA.id);
      await entrar();
      expect(ari.falas()).toEqual([]);
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "fora do horário"]]);
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "musicaDeEspera"]);
      await vi.advanceTimersByTimeAsync(125_000);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    });

    it("o Asterisk recusa tocar (a ARI responde erro): pulada, avisada, e a ligação segue a fase 1", async () => {
      banco.situacao = "fora_do_horario";
      banco.gerais = { ...banco.gerais, foraDoHorario: FORA };
      ari.recusaFala.add("sound:/falas/fora");
      await entrar();
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "tocarFala", "musicaDeEspera"]);
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "fora do horário"]]);
      await vi.advanceTimersByTimeAsync(125_000);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    });

    it("a fala termina 'failed' sem o cliente sair: avisada, e a ligação segue a fase 1 em vez de desligar calada", async () => {
      banco.situacao = "fora_do_horario";
      banco.gerais = { ...banco.gerais, foraDoHorario: FORA };
      await entrar();
      await terminou("fala-1", "failed");
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "fora do horário"]]);
      expect(banco.tem("encerrada")).toEqual([]);
      expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);
      await vi.advanceTimersByTimeAsync(125_000);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    });
  });

  describe("aviso de instabilidade", () => {
    it("toca INTEIRO antes dos ramais — tecla não interrompe —, grava o 'ouviu' e só então toca o ramal", async () => {
      banco.aviso = AVISO;
      anaDisponivel();
      await entrar();
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "tocarFala"]);
      expect(ari.falas()).toEqual(["sound:/falas/aviso"]);

      await ctl.tratar({ type: "ChannelDtmfReceived", channel: cliente, digit: "1" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "tocarFala"]);
      expect(banco.tem("ouviu_aviso")).toEqual([]);

      await terminou("fala-1");
      expect(banco.tem("ouviu_aviso")).toEqual([["ouviu_aviso", ORG, "vc-1"]]);
      // Já atendida pelo aviso: o cliente espera o ramal com música, não em silêncio.
      expect(ari.nomes().slice(3)).toEqual(["musicaDeEspera", "originar"]);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    });

    it("os 2 minutos da fila contam do FIM do aviso, não do início da ligação", async () => {
      banco.aviso = AVISO;
      await entrar();
      await vi.advanceTimersByTimeAsync(60_000); // um aviso de um minuto
      await terminou("fala-1");
      await vi.advanceTimersByTimeAsync(115_000);
      expect(banco.tem("encerrada")).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    });

    it("depois do aviso, quem espera o ramal ouve o 'aguarde'", async () => {
      banco.aviso = AVISO;
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      anaDisponivel();
      await entrar();
      await terminou("fala-1");
      expect(ari.falas()).toEqual(["sound:/falas/aviso", "sound:/falas/aguarde"]);
      expect(ari.nomes().slice(3)).toEqual(["tocarFala", "originar"]);
    });

    it("sem arquivo no disco: pulado e avisado, sem 'ouviu', e a fila da fase 1 segue (o cliente ouve o chamar)", async () => {
      banco.aviso = AVISO;
      falas.semArquivo.add(AVISO.id);
      anaDisponivel();
      await entrar();
      expect(ari.falas()).toEqual([]);
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "aviso de instabilidade"]]);
      expect(ari.nomes()).toEqual(["indicarChamando", "originar"]);
      expect(banco.tem("ouviu_aviso")).toEqual([]);
    });

    it("o Asterisk não tocou (PlaybackFinished failed): avisado, sem 'ouviu', e segue para os ramais", async () => {
      banco.aviso = AVISO;
      anaDisponivel();
      await entrar();
      await terminou("fala-1", "failed");
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "aviso de instabilidade"]]);
      expect(banco.tem("ouviu_aviso")).toEqual([]);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    });

    it("o cliente desliga no meio do aviso: nenhum ramal toca, sem 'ouviu', sem 'fala não tocou', perdida com aviso", async () => {
      banco.aviso = AVISO;
      anaDisponivel();
      await entrar();
      await clienteDesligaDuranteAFala("fala-1");
      expect(ari.originados()).toEqual([]);
      expect(banco.tem("ouviu_aviso")).toEqual([]);
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
      expect(vi.getTimerCount()).toBe(0);
      expect(ctl.ativas).toBe(0);
    });
  });

  describe("quem espera: 'aguarde' e música", () => {
    it("ouve 'aguarde', depois a música, e o 'aguarde' volta a cada 40 s (para a música, fala, volta a música)", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      await entrar();
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "tocarFala"]);
      expect(ari.falas()).toEqual(["sound:/falas/aguarde"]);

      await terminou("fala-1");
      expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);

      let n = ari.chamadas.length;
      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS - 1);
      expect(ari.chamadas.slice(n)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(ari.chamadas.slice(n)).toEqual([
        ["pararMusica", "cli-1"],
        ["tocarFala", "cli-1", "sound:/falas/aguarde"],
      ]);
      await terminou("fala-2");
      expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);

      n = ari.chamadas.length;
      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS);
      expect(ari.chamadas.slice(n)).toEqual([
        ["pararMusica", "cli-1"],
        ["tocarFala", "cli-1", "sound:/falas/aguarde"],
      ]);
      await terminou("fala-3");
      expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);
    });

    it("'aguarde' sem arquivo: música direto, avisado UMA vez, e o relógio da repetição não é armado", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      falas.semArquivo.add(AGUARDE.id);
      await entrar();
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "musicaDeEspera"]);
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "aguarde"]]);
      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS * 2);
      expect(falas.pedidas).toEqual([AGUARDE.id]);
      expect(ari.falas()).toEqual([]);
    });

    it("'aguarde' que termina 'failed': avisado, a música entra, e não se repete", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      await entrar();
      await terminou("fala-1", "failed");
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "aguarde"]]);
      expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);
      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS * 2);
      expect(ari.falas()).toEqual(["sound:/falas/aguarde"]);
    });

    it("o arquivo some antes da repetição: a música segue SEM parar, avisado, e o 'aguarde' não se repete mais", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      await entrar();
      await terminou("fala-1");
      falas.semArquivo.add(AGUARDE.id);
      const n = ari.chamadas.length;
      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS);
      expect(ari.chamadas.slice(n)).toEqual([]);
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "aguarde"]]);
      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS);
      expect(falas.pedidas).toEqual([AGUARDE.id, AGUARDE.id]);
    });

    it("o Asterisk recusa a repetição: a música, que tinha parado, volta, e a Central fica sabendo", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      await entrar();
      await terminou("fala-1");
      ari.recusaFala.add("sound:/falas/aguarde");
      const n = ari.chamadas.length;
      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS);
      expect(ari.chamadas.slice(n)).toEqual([
        ["pararMusica", "cli-1"],
        ["tocarFala", "cli-1", "sound:/falas/aguarde"],
        ["musicaDeEspera", "cli-1"],
      ]);
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "aguarde"]]);
    });

    it("atendente atende NO MEIO do 'aguarde': a fala para antes da ponte, e o fim atrasado dela não religa nada", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      await entrar();
      anaDisponivel();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);

      await ramalAtende(ari.ultimoOriginado());
      const nomes = ari.nomes();
      expect(ari.chamadas).toContainEqual(["pararFala", "fala-1"]);
      expect(nomes.indexOf("pararFala")).toBeLessThan(nomes.indexOf("criarPonte"));
      expect(banco.tem("atendida")).toEqual([["atendida", "vc-1", ANA]]);
      expect(vi.getTimerCount()).toBe(0);

      const antes = ari.chamadas.length;
      await terminou("fala-1");
      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS * 2);
      expect(ari.chamadas.slice(antes)).toEqual([]);
    });

    it("atendente atende durante a MÚSICA: o relógio do 'aguarde' é cancelado e ele não volta na conversa", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      await entrar();
      await terminou("fala-1");
      anaDisponivel();
      await vi.advanceTimersByTimeAsync(5_000);
      await ramalAtende(ari.ultimoOriginado());
      expect(ari.chamadas).toContainEqual(["pararMusica", "cli-1"]);
      expect(ari.nomes()).not.toContain("pararFala");
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS * 2);
      expect(ari.falas()).toEqual(["sound:/falas/aguarde"]);
    });

    it("o cliente desliga no meio do 'aguarde': sem 'fala não tocou', a música não volta, e nenhum relógio sobra", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      await entrar();
      await clienteDesligaDuranteAFala("fala-1");
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(ari.nomes()).not.toContain("musicaDeEspera");
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("o cliente desliga durante a música: os dois relógios caem, e evento que chega depois do fim é ignorado", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      await entrar();
      await terminou("fala-1");
      expect(vi.getTimerCount()).toBe(2); // reavaliar a fila + repetir o "aguarde"

      await destruir("cli-1");
      expect(vi.getTimerCount()).toBe(0);
      expect(ctl.ativas).toBe(0);

      const antes = ari.chamadas.length;
      await terminou("fala-1");
      await ctl.tratar({ type: "ChannelDtmfReceived", channel: cliente, digit: "5" });
      await vi.advanceTimersByTimeAsync(200_000);
      expect(ari.chamadas.slice(antes)).toEqual([]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
    });
  });

  describe("esgotou: 'ninguém atendeu'", () => {
    it("fila esgotada: para a música, toca a fala e só desliga no fim dela (perdida com aviso)", async () => {
      banco.gerais = { ...banco.gerais, ninguem: NINGUEM };
      await entrar();
      await vi.advanceTimersByTimeAsync(125_000);
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "musicaDeEspera", "pararMusica", "tocarFala"]);
      expect(ari.falas()).toEqual(["sound:/falas/ninguem"]);
      expect(banco.tem("encerrada")).toEqual([]);
      expect(vi.getTimerCount()).toBe(1); // só o relógio da fala: a fila já parou

      await terminou(ari.ultimaFala());
      expect(ari.chamadas.at(-1)).toEqual(["desligar", "cli-1", undefined]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    });

    it("voltas esgotadas (todos recusaram): a mesma fala, com o motivo 'ninguem_atendeu'", async () => {
      banco.gerais = { ...banco.gerais, ninguem: NINGUEM };
      banco.disponiveis = [
        { userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null },
        { userId: BIA, atendidasHoje: 1, ultimaAtendidaEm: null },
      ];
      ari.online.add(ANA).add(BIA);
      await entrar();
      for (const c of ["ramal-canal-1", "ramal-canal-2", "ramal-canal-3", "ramal-canal-4"]) await destruir(c, 19);
      expect(ari.falas()).toEqual(["sound:/falas/ninguem"]);
      expect(banco.tem("encerrada")).toEqual([]);

      await terminou(ari.ultimaFala());
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "ninguem_atendeu"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    });

    it("o cliente desliga durante o 'ninguém atendeu': vale o motivo original, sem 'fala não tocou'", async () => {
      banco.gerais = { ...banco.gerais, ninguem: NINGUEM };
      await entrar();
      await vi.advanceTimersByTimeAsync(125_000);
      await clienteDesligaDuranteAFala(ari.ultimaFala());
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    });

    it("sem arquivo no disco: desliga na hora, avisado na Central", async () => {
      banco.gerais = { ...banco.gerais, ninguem: NINGUEM };
      falas.semArquivo.add(NINGUEM.id);
      await entrar();
      await vi.advanceTimersByTimeAsync(125_000);
      expect(ari.falas()).toEqual([]);
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "ninguém atendeu"]]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    });

    it("o Asterisk não tocou (failed, sem o cliente sair): avisado, e desliga com o motivo original", async () => {
      banco.gerais = { ...banco.gerais, ninguem: NINGUEM };
      await entrar();
      await vi.advanceTimersByTimeAsync(125_000);
      await terminou(ari.ultimaFala(), "failed");
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "ninguém atendeu"]]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
    });

    it("'aguarde' no ar quando a fila esgota: ele para, e o 'ninguém atendeu' toca no lugar", async () => {
      banco.gerais = { ...banco.gerais, aguarde: falaDe("aguarde", 90_000), ninguem: NINGUEM };
      await entrar();
      await terminou("fala-1");
      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS); // 40 s: o 2º "aguarde" (fala-2) entra no ar…
      expect(ari.falas()).toEqual(["sound:/falas/aguarde", "sound:/falas/aguarde"]);
      await vi.advanceTimersByTimeAsync(120_000 - REPETIR_AGUARDE_MS); // …e, com 90 s, ainda está no ar aos 120 s
      const nomes = ari.chamadas.map((c) => `${c[0]}:${String(c[2] ?? c[1])}`);
      expect(nomes.indexOf("pararFala:fala-2")).toBeGreaterThan(-1);
      expect(nomes.indexOf("pararFala:fala-2")).toBeLessThan(nomes.indexOf("tocarFala:sound:/falas/ninguem"));
      expect(banco.tem("encerrada")).toEqual([]);
      await terminou(ari.ultimaFala());
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(vi.getTimerCount()).toBe(0);
      expect(ctl.falasNoAr).toBe(0);
    });
  });

  it("time arquivado (indisponível): não quebra — fila com 'aguarde', 'ninguém atendeu' e perdida com aviso", async () => {
    banco.situacao = "indisponivel";
    banco.gerais = { aguarde: AGUARDE, ninguem: NINGUEM, foraDoHorario: FORA };
    await entrar();
    expect(ari.falas()).toEqual(["sound:/falas/aguarde"]);
    await terminou("fala-1");
    await vi.advanceTimersByTimeAsync(125_000);
    expect(ari.falas().at(-1)).toBe("sound:/falas/ninguem");
    await terminou(ari.ultimaFala());
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
    expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
  });

  describe("o fim da fala que não chega (WebSocket da ARI caiu, evento perdido)", () => {
    it("aviso: depois da duração + 5 s, a fala para e a ligação segue para os ramais, como se tivesse terminado", async () => {
      banco.aviso = AVISO;
      anaDisponivel();
      await entrar();
      expect(vi.getTimerCount()).toBe(1); // só o relógio da fala
      await vi.advanceTimersByTimeAsync(AVISO.duracaoMs + FOLGA_DO_FIM_DA_FALA_MS - 1);
      expect(ari.originados()).toEqual([]);
      expect(ari.nomes()).not.toContain("pararFala");

      await vi.advanceTimersByTimeAsync(1);
      expect(ari.chamadas).toContainEqual(["pararFala", "fala-1"]);
      expect(banco.tem("ouviu_aviso")).toEqual([["ouviu_aviso", ORG, "vc-1"]]);
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
      expect(ctl.falasNoAr).toBe(0);

      // O PlaybackFinished que chega DEPOIS do relógio não faz nada.
      const n = ari.chamadas.length;
      await terminou("fala-1");
      expect(ari.chamadas.slice(n)).toEqual([]);
      expect(banco.tem("ouviu_aviso")).toHaveLength(1);
    });

    it("'aguarde': depois da duração + 5 s, a fala para, a música entra e a repetição de 40 s é armada", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      await entrar();
      expect(vi.getTimerCount()).toBe(2); // reavaliar a fila + o relógio da fala
      await vi.advanceTimersByTimeAsync(AGUARDE.duracaoMs + FOLGA_DO_FIM_DA_FALA_MS);
      const nomes = ari.nomes();
      expect(nomes.slice(-2)).toEqual(["pararFala", "musicaDeEspera"]);
      expect(banco.tem("fala_intocavel")).toEqual([]);

      await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS);
      expect(ari.falas()).toEqual(["sound:/falas/aguarde", "sound:/falas/aguarde"]);
    });

    it("'ninguém atendeu': depois da duração + 5 s, desliga com o motivo original (perdida com aviso)", async () => {
      banco.gerais = { ...banco.gerais, ninguem: NINGUEM };
      await entrar();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(ari.falas()).toEqual(["sound:/falas/ninguem"]);
      await vi.advanceTimersByTimeAsync(NINGUEM.duracaoMs + FOLGA_DO_FIM_DA_FALA_MS - 1);
      expect(banco.tem("encerrada")).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(ari.chamadas.at(-1)).toEqual(["desligar", "cli-1", undefined]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("'fora do horário': depois da duração + 5 s, desliga com after_hours, sem aviso de perdida", async () => {
      banco.situacao = "fora_do_horario";
      banco.gerais = { ...banco.gerais, foraDoHorario: FORA };
      await entrar();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(FORA.duracaoMs + FOLGA_DO_FIM_DA_FALA_MS);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "after_hours"]]);
      expect(banco.tem("perdida")).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a fala que termina normalmente derruba o próprio relógio, que não dispara depois", async () => {
      banco.aviso = AVISO;
      anaDisponivel();
      await entrar();
      expect(vi.getTimerCount()).toBe(1);
      expect(ctl.falasNoAr).toBe(1);

      await terminou("fala-1");
      expect(ctl.falasNoAr).toBe(0);
      expect(vi.getTimerCount()).toBe(1); // sobra só a rede de segurança do toque do ramal
      await vi.advanceTimersByTimeAsync(AVISO.duracaoMs + FOLGA_DO_FIM_DA_FALA_MS);
      expect(ari.nomes()).not.toContain("pararFala");
      expect(banco.tem("ouviu_aviso")).toHaveLength(1);
      expect(ari.originados()).toHaveLength(1);
    });

    it("relógio que disparou e ficou na fila serial ATRÁS do fim de verdade não mexe na fala seguinte", async () => {
      // A fila do laço: o que entra espera a vez, e o teste decide quando roda.
      const pendentes: Array<() => Promise<void>> = [];
      ctl.usarFila(async (fn) => {
        pendentes.push(fn);
      });
      banco.aviso = AVISO;
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      anaDisponivel();
      await entrar();
      await vi.advanceTimersByTimeAsync(AVISO.duracaoMs + FOLGA_DO_FIM_DA_FALA_MS);
      expect(pendentes).toHaveLength(1); // o relógio do aviso disparou e espera a vez

      // O PlaybackFinished do aviso estava na frente: a ligação segue, e o "aguarde" entra no ar.
      await terminou("fala-1");
      expect(ari.falas()).toEqual(["sound:/falas/aviso", "sound:/falas/aguarde"]);

      const n = ari.chamadas.length;
      await pendentes.shift()!();
      expect(ari.chamadas.slice(n)).toEqual([]);
      expect(banco.tem("ouviu_aviso")).toHaveLength(1);
      expect(ctl.falasNoAr).toBe(1);
    });

    it("o banco falha ao ler os disponíveis logo depois do aviso: a ligação vai para a fila, com o relógio armado, e toca quando o banco volta", async () => {
      banco.aviso = AVISO;
      anaDisponivel();
      banco.falharDisponiveis = 1;
      await entrar();
      await terminou("fala-1");
      expect(ari.originados()).toEqual([]);
      expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);
      expect(vi.getTimerCount()).toBe(1); // reavaliar a fila

      await vi.advanceTimersByTimeAsync(5_000);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    });

    it("a ligação que acaba com uma fala no ar tira a fala do mapa e derruba o relógio dela", async () => {
      banco.aviso = AVISO;
      await entrar();
      expect(ctl.falasNoAr).toBe(1);
      await destruir("cli-1");
      expect(ctl.falasNoAr).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(ctl.ativas).toBe(0);
    });
  });
});
