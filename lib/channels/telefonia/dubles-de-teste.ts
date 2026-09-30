/**
 * OS DUBLÊS DO CONTROLADOR DE CHAMADAS — a ARI, o banco e o disco das falas de
 * mentira, que `controle.test.ts` e `transferencia.test.ts` usam para exercitar
 * a máquina de estados inteira sem Asterisk nem Postgres. Só teste importa
 * daqui; o produto nunca.
 */
import { ErroAri, type CanalAri } from "./ari";
import type { PortaAri, PortaBanco, PortaFalas } from "./controle";
import type {
  DesfechoDaTransferencia,
  EscolhaDoMenu,
  FalaDoBanco,
  FalasGerais,
  LigacaoDoBanco,
  MenuDoBanco,
  NovaLigacao,
  SituacaoDoTime,
  TransferenciaDoBanco,
  TroncoDoBanco,
} from "./repositorio";

export const ORG = "00000000-0000-0000-0000-00000000000a";
export const TRONCO = "11111111-1111-1111-1111-111111111111";
export const TIME = "22222222-2222-2222-2222-222222222222";
export const ANA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const BIA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

export const tronco: TroncoDoBanco = {
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
export const falaDe = (id: string, duracaoMs = 3_000): FalaDoBanco => ({ id, storagePath: `${ORG}/${id}.ulaw`, duracaoMs });

export function canal(id: string, name: string, extra: Partial<CanalAri> = {}): CanalAri {
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

export class AriFalso implements PortaAri {
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
  private seqTom = 0;
  /** O status do erro com que a ARI recusa o tom (404/409 = o canal já foi embora); `null` = toca. */
  recusaTom: number | null = null;
  tocarTom = async (c: string, t: string) => {
    await this.reg("tocarTom", c, t);
    if (this.recusaTom !== null) throw new ErroAri(this.recusaTom, "erro", `/channels/${c}/play`);
    return { id: `tom-${++this.seqTom}` };
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
  musicaNaPonte = (p: string) => this.reg("musicaNaPonte", p);
  pararMusicaNaPonte = (p: string) => this.reg("pararMusicaNaPonte", p);
  tirarDaPonte = (p: string, c: string) => this.reg("tirarDaPonte", p, c);

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
  /** Quantas vezes o chamar (o tom) foi pedido. */
  tons() {
    return this.chamadas.filter((c) => c[0] === "tocarTom");
  }
  /** Onde está, na ordem das chamadas, a primeira que começa por `alvo` (-1 se nenhuma). */
  indice(...alvo: unknown[]) {
    return this.chamadas.findIndex((c) => alvo.every((a, i) => c[i] === a));
  }
}

export class BancoFalso implements PortaBanco {
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
  atribuirConversa = async (_o: string, c: string, u: string, motivo: "claim" | "transfer" = "claim") => {
    this.eventos.push(motivo === "claim" ? ["atribuida", c, u] : ["atribuida", c, u, motivo]);
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
  // ── transferência (v2) ──
  /** As transferências do banco, pelo id. `abrirTransferencia` põe uma aberta, como a API faria. */
  transferencias = new Map<
    string,
    TransferenciaDoBanco & { vcId: string; org: string; status: "open" | "ended"; desfecho?: DesfechoDaTransferencia; motivo?: string | null; atendidaPor?: string | null }
  >();
  abrirTransferencia(t: TransferenciaDoBanco & { vcId: string; org?: string }) {
    this.transferencias.set(t.id, { ...t, org: t.org ?? ORG, status: "open" });
  }
  transferenciaAberta = async (org: string, vcId: string, id: string) => {
    const t = this.transferencias.get(id);
    if (!t || t.org !== org || t.vcId !== vcId || t.status !== "open") return null;
    return { id: t.id, kind: t.kind, fromUserId: t.fromUserId, toUserId: t.toUserId, toTeamId: t.toTeamId };
  };
  encerrarTransferencia = async (
    org: string,
    id: string,
    fim: { desfecho: DesfechoDaTransferencia; motivo: string | null; atendidaPor: string | null },
  ) => {
    const t = this.transferencias.get(id);
    if (!t || t.org !== org) {
      this.eventos.push(["org_errada", "encerrarTransferencia", id, org]);
      return;
    }
    if (t.status !== "open") return;
    t.status = "ended";
    t.desfecho = fim.desfecho;
    t.motivo = fim.motivo;
    t.atendidaPor = fim.atendidaPor;
    this.eventos.push(["transferencia", id, fim.desfecho, fim.motivo, fim.atendidaPor]);
  };
  recusarTransferenciaOrfa = async (id: string, vcId: string, motivo: string) => {
    const t = this.transferencias.get(id);
    if (t && t.vcId === vcId && t.status === "open") {
      t.status = "ended";
      t.desfecho = "refused";
      t.motivo = motivo;
    }
    this.eventos.push(["transferencia_orfa", id, motivo]);
  };
  cancelarTransferenciasAbertas = async (motivo: string) => {
    let n = 0;
    for (const t of this.transferencias.values()) {
      if (t.status !== "open") continue;
      t.status = "ended";
      t.desfecho = "cancelled";
      t.motivo = motivo;
      n++;
    }
    return n;
  };
  marcarTocandoNaTransferencia = async (org: string, id: string, u: string | null) => {
    if (!this.daOrg(org, id, "marcarTocandoNaTransferencia")) return;
    this.eventos.push(["tocando_na_transferencia", id, u]);
  };
  passarLigacao = async (org: string, id: string, u: string) => {
    if (!this.daOrg(org, id, "passarLigacao")) return;
    this.ligacoes.get(id)!.owner_user_id = u;
    this.eventos.push(["passou", id, u]);
  };
  moverParaOTime = async (org: string, id: string, c: string | null, teamId: string) => {
    if (!this.daOrg(org, id, "moverParaOTime")) return;
    this.ligacoes.get(id)!.team_id = teamId;
    this.eventos.push(["movida_para_o_time", id, c, teamId]);
  };
  /** O time que `timeDaLigacao` devolve quando o da ligação é nulo (o da conversa, na feita). */
  timeDaConversa: string | null = null;
  timeDaLigacao = async (org: string, id: string) => {
    if (!this.daOrg(org, id, "timeDaLigacao")) return null;
    return this.ligacoes.get(id)!.team_id ?? this.timeDaConversa;
  };
  /** Quem o banco diz estar em outra ligação. */
  ocupados = new Set<string>();
  pessoaEmLigacao = async (_org: string, u: string) => this.ocupados.has(u);

  tem(nome: string) {
    return this.eventos.filter((e) => e[0] === nome);
  }
}

/** O disco das falas: tudo está lá, menos o que o teste tirar. */
export class FalasFalsas implements PortaFalas {
  semArquivo = new Set<string>();
  pedidas: string[] = [];
  garantir = async (f: FalaDoBanco) => {
    this.pedidas.push(f.id);
    return this.semArquivo.has(f.id) ? null : `sound:/falas/${f.id}`;
  };
}

