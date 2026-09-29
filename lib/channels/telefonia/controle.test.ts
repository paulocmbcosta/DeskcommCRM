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
    // Também na linha do tempo dos efeitos: é a ENTRADA na fila, e há teste que mede o que vem antes dela.
    this.eventos.push(["entrou_na_fila", org, teamId]);
    if (this.falharFila) throw new Error("banco fora do ar");
    return { situacao: this.situacao, aviso: this.aviso };
  };
  falasGerais = async (org: string) => {
    this.consultas.push(["falasGerais", org]);
    return this.gerais;
  };
  /** `menuPorId` lança (o banco caiu logo na entrada da ligação). */
  falharMenu = false;
  menuPorId = async (org: string, id: string) => {
    this.consultas.push(["menuPorId", org, id]);
    if (this.falharMenu) throw new Error("banco fora do ar");
    return this.menus.get(id) ?? null;
  };
  avisarMenuComTimeArquivado = async (org: string, menu: Pick<MenuDoBanco, "id" | "nome">) => {
    this.eventos.push(["menu_time_arquivado", org, menu.nome]);
  };
  /**
   * A escolha do menu. O que ela faz no banco (a ligação e a conversa sem dono
   * vão ao time escolhido) é provado no Postgres real
   * (tests/invariants/telefonia-repositorio-da-ura.test.ts); aqui só se registra
   * o que o controlador pediu. `falharEscolha` simula o banco que lança ou que
   * não acha a ligação.
   */
  falharEscolha: "lanca" | "nao_acha" | null = null;
  registrarEscolhaDoMenu = async (org: string, id: string, e: EscolhaDoMenu) => {
    this.eventos.push(["escolha", org, id, e.digito, e.desfecho, e.teamId]);
    if (!this.daOrg(org, id, "registrarEscolhaDoMenu")) return false;
    if (this.falharEscolha === "lanca") throw new Error("banco fora do ar");
    return this.falharEscolha !== "nao_acha";
  };
  registrarAvisoOuvido = async (org: string, id: string) => {
    this.eventos.push(["ouviu_aviso", org, id]);
    return true;
  };
  avisarFalaIntocavel = async (org: string, rotulo: string) => {
    this.eventos.push(["fala_intocavel", org, rotulo]);
  };
  acharOuCriarContato = async () => "contato-1";
  acharOuCriarConversa = async (org: string, _c: string, _t: string, teamId: string | null) => {
    this.eventos.push(["conversa_criada", org, teamId]);
    return "conversa-1";
  };
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
      menu_id: l.menuId ?? null,
    });
    return id;
  };
  /** Como o SQL: só o pedido do próprio atendente volta. */
  ligacaoDoAtendente = async (userId: string, id: string) => {
    const l = this.ligacoes.get(id);
    return l && l.owner_user_id === userId ? l : null;
  };
  ligacoesVivas = async () => [...this.ligacoes.values()].filter((l) => l.status !== "ended");
  /** Toda escrita da ligação chega com a organização dela; a errada fica registrada (e o `afterEach` reprova). */
  private daOrg(org: string, id: string, onde: string) {
    const certa = this.ligacoes.get(id)?.organization_id === org;
    if (!certa) this.eventos.push(["org_errada", onde, id, org]);
    return certa;
  }
  marcarTocando = async (org: string, id: string, u: string | null) => {
    if (!this.daOrg(org, id, "marcarTocando")) return;
    if (this.falharTocando) throw new Error("banco fora do ar");
    this.eventos.push(["tocando", id, u]);
  };
  /** `marcarTocando` lança (o banco caiu no meio da ligação). */
  falharTocando = false;
  marcarAtendida = async (org: string, id: string, u: string) => {
    if (!this.daOrg(org, id, "marcarAtendida")) return;
    const l = this.ligacoes.get(id)!;
    l.status = "connected";
    l.answered_at = new Date().toISOString();
    l.owner_user_id = l.owner_user_id ?? u;
    this.eventos.push(["atendida", id, u]);
  };
  /** O que `encerrarLigacao` devolveu — a linha do banco, que o controlador repassa ao "Ligar de volta". */
  devolvidasAoEncerrar: LigacaoDoBanco[] = [];
  encerrarLigacao = async (org: string, id: string, motivo: string) => {
    const l = this.ligacoes.get(id);
    if (!l || !this.daOrg(org, id, "encerrarLigacao") || l.status === "ended") return null;
    l.status = "ended";
    l.end_reason = motivo;
    this.eventos.push(["encerrada", id, motivo]);
    const linha = { ...l };
    this.devolvidasAoEncerrar.push(linha);
    return linha;
  };
  atribuirConversa = async (_o: string, c: string, u: string) => {
    this.eventos.push(["atribuida", c, u]);
  };
  registrarNaConversa = async (l: LigacaoDoBanco, d: string) => {
    this.eventos.push(["registro", l.id, d]);
  };
  /** As ligações que viraram "Ligar de volta", inteiras (o time delas é o do aviso). */
  perdidas: LigacaoDoBanco[] = [];
  avisarPerdida = async (l: LigacaoDoBanco) => {
    this.eventos.push(["perdida", l.id]);
    this.perdidas.push(l);
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
  expect(banco.tem("org_errada")).toEqual([]);
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

  it("o banco cai ao gravar 'tocando': a fila segue, o ramal toca e a ligação é atendida mesmo assim", async () => {
    banco.falharTocando = true;
    await entrar();
    // Ninguém disponível: o "tocando para ninguém" falha, e a fila arma a reavaliação mesmo assim.
    expect(ari.chamadas).toContainEqual(["musicaDeEspera", "cli-1"]);
    expect(vi.getTimerCount()).toBe(1);

    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    // O "tocando para Ana" também falhou: a rede de segurança do toque está armada.
    expect(vi.getTimerCount()).toBe(1);
    expect(banco.tem("tocando")).toEqual([]);

    await ramalAtende(ari.ultimoOriginado());
    expect(banco.tem("atendida")).toEqual([["atendida", "vc-1", ANA]]);
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

    it("o canal do cliente saiu do Stasis (409) ao pedir o 'aguarde': encerra na hora — sem ramal, sem 'tocando', sem relógio", async () => {
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      ari.tocarFala = async (c: string, m: string) => {
        ari.chamadas.push(["tocarFala", c, m]);
        throw new ErroAri(409, "Conflict", `/channels/${c}/play`);
      };
      await entrar();
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "tocarFala", "desligar"]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
      expect(banco.tem("tocando")).toEqual([]);
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(ctl.ativas).toBe(0);
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

describe("URA (§5.1)", () => {
  const MENU = "33333333-3333-3333-3333-333333333333";
  const TIME2 = "44444444-4444-4444-4444-444444444444";
  const FALA_MENU = falaDe("menu", 4_000);
  const FALA_INVALIDA = falaDe("invalida", 2_000);
  const AVISO = falaDe("aviso", 10_000);
  const SOM_MENU = "sound:/falas/menu";
  const SOM_INVALIDA = "sound:/falas/invalida";
  const menu = (p: Partial<MenuDoBanco> = {}): MenuDoBanco => ({
    id: MENU,
    nome: "Atendimento",
    defaultTeamId: TIME,
    timePadraoAtivo: true,
    fala: FALA_MENU,
    falaInvalida: null,
    opcoes: [
      { digito: "1", teamId: TIME },
      { digito: "2", teamId: TIME2 },
    ],
    ...p,
  });
  const tecla = (digit: string, canalId = "cli-1") =>
    ctl.tratar({ type: "ChannelDtmfReceived", channel: canal(canalId, "x"), digit });
  const anaDisponivel = () => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
  };
  const escolhas = () => banco.tem("escolha");
  /** O menu termina e, 5 s depois, sem tecla, toca de novo (a fala seguinte, `fala-<n>`). */
  const semTecla = async (playbackId: string) => {
    await terminou(playbackId);
    await vi.advanceTimersByTimeAsync(5_000);
  };

  beforeEach(() => {
    banco.troncoAtual = { ...tronco, teamId: null, menuId: MENU };
    banco.menus.set(MENU, menu());
  });

  it("número com menu: nasce no time padrão, atende e toca o menu; a tecla válida interrompe a fala e leva ao time da opção", async () => {
    anaDisponivel();
    await entrar();
    expect(banco.consultas).toEqual([["menuPorId", ORG, MENU]]);
    expect(banco.ligacoes.get("vc-1")).toMatchObject({ team_id: TIME, menu_id: MENU });
    expect(ari.nomes()).toEqual(["indicarChamando", "atender", "tocarFala"]);
    expect(ari.falas()).toEqual([SOM_MENU]);
    expect(ari.originados()).toEqual([]);
    expect(vi.getTimerCount()).toBe(1); // o relógio da fala do menu

    await tecla("2");
    const nomes = ari.nomes();
    expect(ari.chamadas).toContainEqual(["pararFala", "fala-1"]);
    expect(nomes.indexOf("pararFala")).toBeLessThan(nomes.indexOf("originar"));
    expect(escolhas()).toEqual([["escolha", ORG, "vc-1", "2", "chosen", TIME2]]);
    expect(banco.consultas).toContainEqual(["timeParaAFila", ORG, TIME2]);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    expect(ctl.falasNoAr).toBe(0);
    expect(banco.tem("menu_time_arquivado")).toEqual([]);
  });

  it("sem tecla: 5 s depois do fim do menu ele repete; na 3ª vez sem tecla → time padrão com default_no_input", async () => {
    await entrar();
    await terminou("fala-1");
    expect(vi.getTimerCount()).toBe(1); // só o prazo de 5 s
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ari.falas()).toEqual([SOM_MENU]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ari.falas()).toEqual([SOM_MENU, SOM_MENU]);

    await semTecla("fala-2");
    expect(ari.falas()).toHaveLength(3);
    await terminou("fala-3");
    expect(escolhas()).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_no_input", TIME]]);
    expect(banco.consultas).toContainEqual(["timeParaAFila", ORG, TIME]);
    expect(ari.falas()).toHaveLength(3); // o menu não toca uma 4ª vez
  });

  it("tecla válida na espera (nada no ar): não há fala para parar, e o prazo dos 5 s é desarmado", async () => {
    await entrar();
    await terminou("fala-1");
    const n = ari.chamadas.length;
    await tecla("1");
    expect(ari.chamadas.slice(n).map((c) => c[0])).not.toContain("pararFala");
    expect(escolhas()).toEqual([["escolha", ORG, "vc-1", "1", "chosen", TIME]]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ari.falas()).toEqual([SOM_MENU]);
  });

  it("tecla errada SEM fala de inválida: interrompe e repete o menu na hora; na 3ª errada → padrão com default_invalid", async () => {
    await entrar(); //   fala-1: o menu
    await tecla("9"); // interrompe; fala-2: o menu de novo (2ª vez)
    expect(ari.chamadas).toContainEqual(["pararFala", "fala-1"]);
    expect(ari.falas()).toEqual([SOM_MENU, SOM_MENU]);
    await tecla("#"); // reservada = errada; interrompe; fala-3 (3ª vez)
    expect(ari.chamadas).toContainEqual(["pararFala", "fala-2"]);
    await terminou("fala-3");
    expect(escolhas()).toEqual([]);

    await tecla("*"); // a 3ª errada, na espera
    expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_invalid", TIME]]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ari.falas()).toHaveLength(3);
  });

  it("tecla errada COM fala de inválida: toca a inválida, depois o menu; e o silêncio que vem depois dá default_invalid", async () => {
    banco.menus.set(MENU, menu({ falaInvalida: FALA_INVALIDA }));
    await entrar(); //         fala-1: o menu
    await tecla("7"); //       interrompe; fala-2: a inválida
    expect(ari.chamadas).toContainEqual(["pararFala", "fala-1"]);
    expect(ari.falas()).toEqual([SOM_MENU, SOM_INVALIDA]);
    await terminou("fala-2"); // fala-3: o menu (2ª vez)
    expect(ari.falas()).toEqual([SOM_MENU, SOM_INVALIDA, SOM_MENU]);
    await semTecla("fala-3"); // fala-4: o menu (3ª vez)
    expect(ari.falas()).toHaveLength(4);
    await terminou("fala-4");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_invalid", TIME]]);
  });

  it("a tecla também interrompe a fala de inválida", async () => {
    banco.menus.set(MENU, menu({ falaInvalida: FALA_INVALIDA }));
    await entrar();
    await tecla("7"); // fala-2: a inválida
    await tecla("2");
    expect(ari.chamadas).toContainEqual(["pararFala", "fala-2"]);
    expect(escolhas()).toEqual([["escolha", ORG, "vc-1", "2", "chosen", TIME2]]);
  });

  it("a tecla de uma opção cujo time foi arquivado vale como errada (o banco não devolve a opção)", async () => {
    banco.menus.set(MENU, menu({ opcoes: [{ digito: "1", teamId: TIME }] })); // o 2 era de um time arquivado
    await entrar();
    await tecla("2");
    expect(escolhas()).toEqual([]);
    expect(ari.falas()).toEqual([SOM_MENU, SOM_MENU]);
  });

  describe("o cliente desliga no menu", () => {
    it("no meio da fala: perdida com 'Ligar de volta' no time padrão, sem desfecho de menu e sem 'fala não tocou'", async () => {
      await entrar();
      await clienteDesligaDuranteAFala("fala-1");
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(escolhas()).toEqual([]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
      expect(banco.ligacoes.get("vc-1")?.team_id).toBe(TIME);
      expect(ari.originados()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(ctl.ativas).toBe(0);
    });

    it("na espera dos 5 s: o prazo cai junto (pararRelogios), e tecla ou prazo depois do fim não fazem nada", async () => {
      await entrar();
      await terminou("fala-1");
      expect(vi.getTimerCount()).toBe(1); // o prazo
      await destruir("cli-1");
      expect(vi.getTimerCount()).toBe(0);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);

      const n = ari.chamadas.length;
      await tecla("1");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ari.chamadas.slice(n)).toEqual([]);
      expect(escolhas()).toEqual([]);
    });
  });

  describe("a fala do menu que não toca: direto ao time padrão, avisado na Central", () => {
    it("sem arquivo no disco: a URA nem atende — a fila da fase 1 chama o ramal", async () => {
      falas.semArquivo.add(FALA_MENU.id);
      anaDisponivel();
      await entrar();
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "menu Atendimento"]]);
      expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_no_input", TIME]]);
      expect(ari.falas()).toEqual([]);
      expect(ari.nomes()).toEqual(["indicarChamando", "originar"]);
    });

    it("menu sem fala pronta: nem pede o arquivo, avisa e vai ao padrão", async () => {
      banco.menus.set(MENU, menu({ fala: null }));
      anaDisponivel();
      await entrar();
      expect(falas.pedidas).toEqual([]);
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "menu Atendimento"]]);
      expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_no_input", TIME]]);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    });

    it("o Asterisk recusa tocar (a ARI responde erro): avisado, e ao padrão — atendida, com música enquanto o ramal toca", async () => {
      ari.recusaFala.add(SOM_MENU);
      anaDisponivel();
      await entrar();
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "menu Atendimento"]]);
      expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_no_input", TIME]]);
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "tocarFala", "musicaDeEspera", "originar"]);
    });

    it("o playback termina 'failed' sem o cliente sair: avisado, e ao padrão", async () => {
      await entrar();
      await terminou("fala-1", "failed");
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "menu Atendimento"]]);
      expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_no_input", TIME]]);
      expect(ari.falas()).toEqual([SOM_MENU]);
    });

    it("a repetição depois de uma tecla errada não toca: ao padrão com default_invalid", async () => {
      await entrar();
      ari.recusaFala.add(SOM_MENU);
      await tecla("9");
      expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_invalid", TIME]]);
    });

    it("canal do cliente que sumiu (404) no pedido da fala: encerra NA HORA pelo fim normal, mesmo se o fim do canal se perder", async () => {
      ari.tocarFala = async (c: string, m: string) => {
        ari.chamadas.push(["tocarFala", c, m]);
        throw new ErroAri(404, "Not Found", `/channels/${c}/play`);
      };
      await entrar();
      // Sem ChannelDestroyed nem StasisEnd: a ligação não fica viva esperando por eles.
      expect(ctl.ativas).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
      // É o cliente desligando: nem "fala não tocou", nem desfecho de menu.
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(escolhas()).toEqual([]);
      // O fim do canal que chega atrasado não encerra de novo.
      await destruir("cli-1");
      expect(banco.tem("encerrada")).toHaveLength(1);
    });
  });

  it("o 'aguarde' depois da escolha acha o canal do cliente fechado (404): a ligação acaba, e ramal nenhum toca", async () => {
    banco.gerais = { ...banco.gerais, aguarde: falaDe("aguarde") };
    anaDisponivel();
    const tocar = ari.tocarFala;
    ari.tocarFala = async (c: string, m: string) => {
      if (m !== "sound:/falas/aguarde") return tocar(c, m);
      ari.chamadas.push(["tocarFala", c, m]);
      throw new ErroAri(404, "Not Found", `/channels/${c}/play`);
    };
    await entrar();
    await tecla("2"); // já atendida pela URA: a fila segura com o "aguarde" antes de tocar o ramal
    expect(ari.originados()).toEqual([]);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
    expect(ctl.ativas).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fala de tecla inválida sem arquivo: pulada e avisada, e o menu repete no lugar dela", async () => {
    banco.menus.set(MENU, menu({ falaInvalida: FALA_INVALIDA }));
    falas.semArquivo.add(FALA_INVALIDA.id);
    await entrar();
    await tecla("9");
    expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "tecla inválida do menu Atendimento"]]);
    expect(ari.falas()).toEqual([SOM_MENU, SOM_MENU]);
    expect(escolhas()).toEqual([]);
  });

  it("o fim da fala do menu que não chega: depois da duração + 5 s o menu é dado por terminado e a espera começa", async () => {
    await entrar();
    await vi.advanceTimersByTimeAsync(FALA_MENU.duracaoMs + FOLGA_DO_FIM_DA_FALA_MS - 1);
    expect(ari.nomes()).not.toContain("pararFala");
    await vi.advanceTimersByTimeAsync(1);
    expect(ari.chamadas).toContainEqual(["pararFala", "fala-1"]);
    expect(banco.tem("fala_intocavel")).toEqual([]);
    expect(ctl.falasNoAr).toBe(0);
    expect(vi.getTimerCount()).toBe(1); // o prazo dos 5 s

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ari.falas()).toEqual([SOM_MENU, SOM_MENU]);
    // O PlaybackFinished que chega atrasado não faz nada.
    const n = ari.chamadas.length;
    await terminou("fala-1");
    expect(ari.chamadas.slice(n)).toEqual([]);
  });

  it("prazo antigo: o que disparou e esperou na fila serial atrás de uma tecla NÃO gasta repetição", async () => {
    // A fila do laço: o que entra espera a vez, e o teste decide quando roda.
    const pendentes: Array<() => Promise<void>> = [];
    ctl.usarFila(async (fn) => {
      pendentes.push(fn);
    });
    await entrar(); //                          fala-1: o menu (1ª vez)
    await terminou("fala-1"); //                espera da 1ª vez
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pendentes).toHaveLength(1); //       o prazo da 1ª vez disparou e espera a vez

    // Na frente dele na fila vinha uma tecla errada: o menu repete (2ª vez) e termina.
    await tecla("9"); //                        fala-2: o menu (2ª vez)
    await terminou("fala-2"); //                espera da 2ª vez
    const n = ari.chamadas.length;
    await pendentes.shift()!(); //              o prazo velho roda agora
    expect(ari.chamadas.slice(n)).toEqual([]); // ignorado: não tocou o menu

    // O prazo certo continua valendo: 5 s depois, a 3ª vez.
    await vi.advanceTimersByTimeAsync(5_000);
    await pendentes.shift()!();
    expect(ari.falas()).toEqual([SOM_MENU, SOM_MENU, SOM_MENU]);
    expect(escolhas()).toEqual([]);

    // E só depois da 3ª vez, o padrão: nenhuma repetição foi gasta pelo prazo velho.
    await terminou("fala-3");
    await vi.advanceTimersByTimeAsync(5_000);
    await pendentes.shift()!();
    expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_invalid", TIME]]);
  });

  describe("time padrão ARQUIVADO", () => {
    beforeEach(() => {
      banco.menus.set(MENU, menu({ timePadraoAtivo: false }));
      banco.situacao = "indisponivel";
    });

    it("a ligação que cai nele segue a fila e acaba perdida, mas antes a Central fica sabendo do menu", async () => {
      await entrar();
      await semTecla("fala-1");
      await semTecla("fala-2");
      await terminou("fala-3");
      expect(banco.tem("menu_time_arquivado")).toEqual([]);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_no_input", TIME]]);
      expect(banco.tem("menu_time_arquivado")).toEqual([["menu_time_arquivado", ORG, "Atendimento"]]);
      // "Antes" da fila: a escolha, o aviso e SÓ ENTÃO a entrada na fila do time — por posição.
      const posicao = (nome: string) => banco.eventos.findIndex((e) => e[0] === nome);
      expect(posicao("escolha")).toBeGreaterThanOrEqual(0);
      expect(posicao("escolha")).toBeLessThan(posicao("menu_time_arquivado"));
      expect(posicao("menu_time_arquivado")).toBeLessThan(posicao("entrou_na_fila"));
      expect(banco.tem("entrou_na_fila")).toEqual([["entrou_na_fila", ORG, TIME]]);

      await vi.advanceTimersByTimeAsync(125_000);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    });

    it("quem escolhe uma opção de time ativo não dispara aviso nenhum", async () => {
      banco.situacao = "aberto";
      await entrar();
      await tecla("2");
      expect(escolhas()).toEqual([["escolha", ORG, "vc-1", "2", "chosen", TIME2]]);
      expect(banco.tem("menu_time_arquivado")).toEqual([]);
    });

    it("o menu sem áudio também leva ao time arquivado: avisa a fala e o time", async () => {
      falas.semArquivo.add(FALA_MENU.id);
      await entrar();
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "menu Atendimento"]]);
      expect(banco.tem("menu_time_arquivado")).toEqual([["menu_time_arquivado", ORG, "Atendimento"]]);
    });
  });

  describe("a conversa acompanha o time escolhido (visibilidade por time)", () => {
    // O EFEITO no banco — a ligação e a conversa sem dono no time escolhido, a de
    // humano parada, o time arquivado recusado, o texto do aviso — é provado no
    // Postgres real (tests/invariants/telefonia-repositorio-da-ura.test.ts). Aqui,
    // o que é do controlador: o que ele pede, em que ordem, e o que faz quando o
    // banco falha.
    const posicao = (nome: string) => banco.eventos.findIndex((e) => e[0] === nome);

    it("escolheu 2: a conversa nasce no time padrão, e a escolha (que a leva ao time 2) é gravada UMA vez, ANTES de a ligação entrar na fila do time 2", async () => {
      await entrar();
      expect(banco.tem("conversa_criada")).toEqual([["conversa_criada", ORG, TIME]]);
      await tecla("2");
      expect(escolhas()).toEqual([["escolha", ORG, "vc-1", "2", "chosen", TIME2]]);
      expect(banco.tem("entrou_na_fila")).toEqual([["entrou_na_fila", ORG, TIME2]]);
      expect(posicao("escolha")).toBeLessThan(posicao("entrou_na_fila"));
      // Ninguém atendeu: o "Ligar de volta" leva a linha que o BANCO encerrou (com o time dele), não uma montada aqui.
      await vi.advanceTimersByTimeAsync(125_000);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
      expect(banco.perdidas).toHaveLength(1);
      expect(banco.perdidas[0]).toBe(banco.devolvidasAoEncerrar[0]);
    });

    it("desligou no menu: nenhuma escolha é gravada (a conversa fica no time em que nasceu), e o 'Ligar de volta' leva a linha que o banco encerrou", async () => {
      await entrar();
      await terminou("fala-1");
      await destruir("cli-1");
      expect(escolhas()).toEqual([]);
      expect(banco.tem("entrou_na_fila")).toEqual([]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
      expect(banco.perdidas).toHaveLength(1);
      expect(banco.perdidas[0]).toBe(banco.devolvidasAoEncerrar[0]);
    });

    it.each(["lanca", "nao_acha"] as const)(
      "a escolha que o banco não grava (%s) não segura a ligação: ela entra na fila do time escolhido e o ramal toca",
      async (falha) => {
        banco.falharEscolha = falha;
        anaDisponivel();
        await entrar();
        await tecla("2");
        expect(escolhas()).toHaveLength(1);
        expect(banco.tem("entrou_na_fila")).toEqual([["entrou_na_fila", ORG, TIME2]]);
        expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
      },
    );
  });

  it("fluxo completo: menu → tecla 2 → fila do time 2 → aviso INTEIRO (a tecla já não vale) → ramal → o atendente atende", async () => {
    banco.aviso = AVISO;
    anaDisponivel();
    await entrar(); //   fala-1: o menu
    await tecla("2"); // para o menu; grava a escolha; fila do time 2 → fala-2: o aviso
    expect(ari.falas()).toEqual([SOM_MENU, "sound:/falas/aviso"]);
    expect(escolhas()).toEqual([["escolha", ORG, "vc-1", "2", "chosen", TIME2]]);
    expect(banco.consultas).toContainEqual(["timeParaAFila", ORG, TIME2]);
    expect(ari.originados()).toEqual([]);

    // A URA acabou: tecla no aviso (ou vinda do ramal) não interrompe nem escolhe nada.
    const n = ari.chamadas.length;
    await tecla("1");
    await tecla("9");
    await tecla("1", "ramal-canal-9");
    expect(ari.chamadas.slice(n)).toEqual([]);
    expect(escolhas()).toHaveLength(1);

    await terminou("fala-2");
    expect(banco.tem("ouviu_aviso")).toEqual([["ouviu_aviso", ORG, "vc-1"]]);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);

    await ramalAtende(ari.ultimoOriginado());
    expect(banco.tem("atendida")).toEqual([["atendida", "vc-1", ANA]]);
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "cli-1"]);
    expect(ari.chamadas).toContainEqual(["pararMusica", "cli-1"]);

    await destruir("cli-1");
    expect(banco.tem("registro")).toEqual([["registro", "vc-1", "atendida"]]);
    expect(banco.tem("perdida")).toEqual([]);
    expect(ctl.ativas).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("os 2 min de fila contam da ENTRADA na fila, não do início da ligação", async () => {
    // O cliente ouve o menu três vezes (sem os PlaybackFinished: o relógio da fala os dá por terminados)…
    await entrar();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ari.falas()).toHaveLength(3);
    await tecla("1"); // …e escolhe aos 30 s de ligação.
    await vi.advanceTimersByTimeAsync(115_000); // 145 s de ligação, 115 s de fila
    expect(banco.tem("encerrada")).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
  });

  it("tecla vinda do canal do RAMAL não mexe na URA", async () => {
    await entrar();
    await tecla("1", "ramal-canal-9");
    expect(escolhas()).toEqual([]);
    expect(ari.nomes()).not.toContain("pararFala");
  });

  it.each([
    ["não existe mais", () => banco.menus.clear()],
    ["não pôde ser lido (banco fora do ar)", () => (banco.falharMenu = true)],
  ])("o número aponta para um menu que %s: segue sem menu e sem time — a fila da fase 1", async (_n, preparar) => {
    preparar();
    await entrar();
    expect(ari.falas()).toEqual([]);
    expect(banco.ligacoes.get("vc-1")).toMatchObject({ team_id: null, menu_id: null });
    expect(banco.consultas).toEqual([
      ["menuPorId", ORG, MENU],
      ["falasGerais", ORG],
    ]);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
    expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
  });
});

/**
 * A GRAVAÇÃO (F3, DYD-53; desenho 2026-09-29-telefonia-gravacao-das-ligacoes-design.md).
 * O controlador só chama a porta: gravar a ponte, guardar e dar como perdida é de
 * `gravacoes.ts` (provado em gravacoes.test.ts) e do banco (tests/invariants/telefonia-gravacao.test.ts).
 */
describe("gravação das ligações (F3)", () => {
  const AVISO_DE_GRAVACAO = falaDe("gravacao", 3_000);
  const SOM_DO_AVISO = "sound:/falas/gravacao";

  class GravacaoFalsa {
    politicaAtual = { gravar: true, aviso: AVISO_DE_GRAVACAO as FalaDoBanco | null };
    falharPolitica = false;
    recusarGravar = false;
    tocarNaPonteFalha = false;
    chamadas: Array<[string, ...unknown[]]> = [];
    politica = async (org: string) => {
      this.chamadas.push(["politica", org]);
      if (this.falharPolitica) throw new Error("banco fora do ar");
      return this.politicaAtual;
    };
    comecar = async (p: { org: string; vcId: string; ponte: string; avisoEm: Date }) => {
      this.chamadas.push(["comecar", p.org, p.vcId, p.ponte, p.avisoEm.getTime()]);
      if (this.recusarGravar) return false;
      // Como `marcarGravando`: a ligação passa a `recording`.
      const l = banco.ligacoes.get(p.vcId);
      if (l) l.recording_status = "recording";
      return true;
    };
    tocarAvisoNaPonte = async (ponte: string, midia: string) => {
      this.chamadas.push(["tocarAvisoNaPonte", ponte, midia]);
      return !this.tocarNaPonteFalha;
    };
    parar = async (vcId: string) => {
      this.chamadas.push(["parar", vcId]);
    };
    aoEncerrar = (org: string, vcId: string) => {
      this.chamadas.push(["aoEncerrar", org, vcId]);
    };
    nomes() {
      return this.chamadas.map((c) => c[0]);
    }
  }

  let gravacao: GravacaoFalsa;
  beforeEach(() => {
    gravacao = new GravacaoFalsa();
    ctl = new ControladorDeChamadas(ari, banco, log, () => Date.now(), falas, gravacao);
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
  });

  describe("recebida", () => {
    it("o aviso toca ANTES da fila; no fim dele a fila segue; o ramal atende → a ponte é gravada com a hora do aviso", async () => {
      await entrar();
      expect(gravacao.chamadas).toEqual([["politica", ORG]]);
      expect(ari.falas()).toEqual([SOM_DO_AVISO]);
      expect(ari.originados()).toEqual([]);
      expect(banco.tem("entrou_na_fila")).toEqual([]);

      vi.setSystemTime(new Date("2026-09-28T13:00:03Z"));
      await terminou("fala-1");
      expect(banco.tem("entrou_na_fila")).toHaveLength(1);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);

      await ramalAtende(ari.ultimoOriginado());
      const comecou = gravacao.chamadas.find((c) => c[0] === "comecar");
      expect(comecou).toEqual(["comecar", ORG, "vc-1", "p-vc-1", new Date("2026-09-28T13:00:03Z").getTime()]);
      // A gravação começa com as DUAS pernas já na ponte.
      const nomes = ari.nomes();
      expect(nomes.lastIndexOf("porNaPonte")).toBeGreaterThan(-1);

      // Fim: para a gravação ANTES de derrubar a ponte, e pede o processamento depois do registro.
      await destruir("cli-1");
      expect(gravacao.nomes()).toEqual(["politica", "comecar", "parar", "aoEncerrar"]);
      expect(gravacao.chamadas.at(-1)).toEqual(["aoEncerrar", ORG, "vc-1"]);
      expect(banco.tem("registro")).toEqual([["registro", "vc-1", "atendida"]]);
    });

    it("com menu: o aviso de gravação toca antes do menu", async () => {
      const MENU = "33333333-3333-3333-3333-333333333333";
      banco.troncoAtual = { ...tronco, teamId: null, menuId: MENU };
      banco.menus.set(MENU, {
        id: MENU,
        nome: "Atendimento",
        defaultTeamId: TIME,
        timePadraoAtivo: true,
        fala: falaDe("menu", 4_000),
        falaInvalida: null,
        opcoes: [{ digito: "1", teamId: TIME }],
      });
      await entrar();
      expect(ari.falas()).toEqual([SOM_DO_AVISO]);
      await terminou("fala-1");
      expect(ari.falas()).toEqual([SOM_DO_AVISO, "sound:/falas/menu"]);
    });

    it("tecla durante o aviso não escolhe nada (a URA ainda não começou)", async () => {
      const MENU = "33333333-3333-3333-3333-333333333333";
      banco.troncoAtual = { ...tronco, teamId: null, menuId: MENU };
      banco.menus.set(MENU, {
        id: MENU,
        nome: "Atendimento",
        defaultTeamId: TIME,
        timePadraoAtivo: true,
        fala: falaDe("menu", 4_000),
        falaInvalida: null,
        opcoes: [{ digito: "1", teamId: TIME }],
      });
      await entrar();
      await ctl.tratar({ type: "ChannelDtmfReceived", channel: canal("cli-1", "x"), digit: "1" });
      expect(banco.tem("escolha")).toEqual([]);
      expect(ari.chamadas.filter((c) => c[0] === "pararFala")).toEqual([]);
    });

    it("aviso sem arquivo no disco: pulado, a Central fica sabendo, a fila segue e a ponte NÃO é gravada", async () => {
      falas.semArquivo.add(AVISO_DE_GRAVACAO.id);
      await entrar();
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "aviso de gravação"]]);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
      await ramalAtende(ari.ultimoOriginado());
      await destruir("cli-1");
      expect(gravacao.nomes()).toEqual(["politica"]);
    });

    it("o Asterisk termina o aviso como `failed`: não gravada, e a fila segue", async () => {
      await entrar();
      await terminou("fala-1", "failed");
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
      await ramalAtende(ari.ultimoOriginado());
      expect(gravacao.nomes()).toEqual(["politica"]);
    });

    it("o cliente desliga no meio do aviso: nada de fila, nada de gravação", async () => {
      await entrar();
      await clienteDesligaDuranteAFala("fala-1");
      expect(ari.originados()).toEqual([]);
      expect(gravacao.nomes()).toEqual(["politica"]);
      expect(banco.tem("encerrada")).toHaveLength(1);
    });

    it("ninguém atende: o aviso tocou, mas sem ponte não há gravação nem processamento", async () => {
      banco.disponiveis = [];
      await entrar();
      await terminou("fala-1");
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(gravacao.nomes()).toEqual(["politica"]);
      expect(banco.tem("encerrada")).toHaveLength(1);
    });

    it("organização que não grava, ou sem aviso pronto: a fila de sempre, sem fala a mais", async () => {
      gravacao.politicaAtual = { gravar: false, aviso: AVISO_DE_GRAVACAO };
      await entrar();
      expect(ari.falas()).toEqual([]);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    });

    it("gravação ligada mas o aviso não está pronto: não toca nada e não grava", async () => {
      gravacao.politicaAtual = { gravar: true, aviso: null };
      await entrar();
      expect(ari.falas()).toEqual([]);
      await ramalAtende(ari.ultimoOriginado());
      expect(gravacao.nomes()).toEqual(["politica"]);
    });

    it("número oculto (sem conversa): nem pergunta a política", async () => {
      await ctl.tratar({
        type: "StasisStart",
        channel: canal("cli-1", `PJSIP/tronco-${TRONCO}-00000001`, { caller: { name: "", number: "anonymous" } }),
        args: ["entrada"],
      });
      expect(gravacao.chamadas).toEqual([]);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    });

    it("a política que lança não derruba a ligação: segue sem gravar", async () => {
      gravacao.falharPolitica = true;
      await entrar();
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    });

    it("a gravação que não começa não derruba a ponte nem pede processamento", async () => {
      gravacao.recusarGravar = true;
      await entrar();
      await terminou("fala-1");
      await ramalAtende(ari.ultimoOriginado());
      expect(banco.tem("atendida")).toHaveLength(1);
      await destruir("cli-1");
      expect(gravacao.nomes()).toEqual(["politica", "comecar"]);
    });
  });

  describe("feita", () => {
    async function pedido() {
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
      });
      await ctl.tratar({
        type: "StasisStart",
        channel: canal("ramal-a", `PJSIP/ramal-${ANA}-0000000a`, {
          dialplan: { context: "de-ramal", exten: `c-${id}`, priority: 1 },
        }),
        args: ["saida"],
      });
      return { id, perna: ari.chamadas.find((c) => c[0] === "discar")![1] as string };
    }
    const atende = (perna: string) =>
      ctl.tratar({ type: "Dial", peer: canal(perna, "PJSIP/tronco-x-00000002"), dialstatus: "ANSWER" });

    it("o cliente atende: o aviso toca na PONTE e a gravação começa logo depois; o fim para e pede o processamento", async () => {
      const { id, perna } = await pedido();
      expect(gravacao.nomes()).toEqual(["politica"]);
      await atende(perna);
      expect(gravacao.nomes()).toEqual(["politica", "tocarAvisoNaPonte", "comecar"]);
      expect(gravacao.chamadas[1]).toEqual(["tocarAvisoNaPonte", `p-${id}`, SOM_DO_AVISO]);
      expect(gravacao.chamadas[2]?.slice(0, 4)).toEqual(["comecar", ORG, id, `p-${id}`]);

      await destruir(perna);
      expect(gravacao.nomes()).toEqual(["politica", "tocarAvisoNaPonte", "comecar", "parar", "aoEncerrar"]);
      const nomesAri = ari.nomes();
      // Parada antes de a ponte cair.
      expect(nomesAri.indexOf("destruirPonte")).toBeGreaterThan(-1);
    });

    it("ninguém atende do outro lado: sem aviso, sem gravação", async () => {
      const { perna } = await pedido();
      await destruir(perna, 19);
      expect(gravacao.nomes()).toEqual(["politica"]);
    });

    it("aviso sem arquivo no disco: não grava, e a Central fica sabendo", async () => {
      falas.semArquivo.add(AVISO_DE_GRAVACAO.id);
      const { perna } = await pedido();
      await atende(perna);
      expect(gravacao.nomes()).toEqual(["politica"]);
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "aviso de gravação"]]);
    });

    it("o Asterisk recusa tocar o aviso na ponte: não grava", async () => {
      gravacao.tocarNaPonteFalha = true;
      const { perna } = await pedido();
      await atende(perna);
      expect(gravacao.nomes()).toEqual(["politica", "tocarAvisoNaPonte"]);
    });

    it("organização que não grava: a ligação sai como sempre", async () => {
      gravacao.politicaAtual = { gravar: false, aviso: AVISO_DE_GRAVACAO };
      const { perna } = await pedido();
      await atende(perna);
      expect(gravacao.nomes()).toEqual(["politica"]);
    });
  });

  it("recuperada após reinício: parar é pedido (o estado em memória morreu), e a gravada é processada", async () => {
    const id = "vc-9";
    banco.ligacoes.set(id, {
      id,
      organization_id: ORG,
      channel_session_id: TRONCO,
      contact_id: "contato-1",
      conversation_id: "conversa-1",
      direction: "inbound",
      peer_phone: "+5561988887777",
      status: "connected",
      owner_user_id: ANA,
      created_by: null,
      team_id: TIME,
      started_at: new Date().toISOString(),
      answered_at: new Date().toISOString(),
      provider: "sip_trunk",
      sip_call_ref: "cli-9",
      recording_status: "recording",
    });
    ari.pontesVivas = [{ id: `p-${id}`, channels: ["cli-9", "ramal-9"] }];
    ari.canaisVivos = [{ id: "cli-9" }, { id: "ramal-9" }];
    await ctl.recuperar();
    await destruir("cli-9");
    expect(gravacao.nomes()).toEqual(["parar", "aoEncerrar"]);
  });
});
