import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErroAri } from "./ari";
import {
  ControladorDeChamadas,
  FOLGA_DO_FIM_DA_FALA_MS,
  REAVALIAR_APOS_O_FIM_MS,
  REPETIR_AGUARDE_MS,
} from "./controle";
import { ANA, AriFalso, BIA, BancoFalso, FalasFalsas, ORG, TIME, TRONCO, canal, falaDe, tronco } from "./dubles-de-teste";
import { toqueDaSaidaSemResposta, type FalaDoBanco, type LigacaoDoBanco, type MenuDoBanco } from "./repositorio";

const log = { info: () => undefined, warn: vi.fn(), error: vi.fn() };

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
  log.warn.mockClear();
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

  it("ninguém atende: duas voltas, atende e toca o chamar na segunda, e vira perdida com aviso", async () => {
    banco.disponiveis = [
      { userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null },
      { userId: BIA, atendidasHoje: 1, ultimaAtendidaEm: null },
    ];
    ari.online.add(ANA).add(BIA);
    await entrar();
    await destruir("ramal-canal-1", 19);
    await destruir("ramal-canal-2", 21);
    expect(ari.chamadas).toContainEqual(["atender", "cli-1"]);
    // Há quem chamar: o som de chamando, em banda — não a música de quem espera (DYD-52).
    expect(ari.chamadas).toContainEqual(["tocarTom", "cli-1", "ring"]);
    expect(ari.nomes()).not.toContain("musicaDeEspera");
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

  /**
   * POR QUANTO TEMPO O TELEFONE DO CLIENTE CHAMOU (0294). O instante do primeiro
   * toque fica na memória do controlador e entra no banco na escrita que fecha a
   * ligação; `toqueDaSaidaSemResposta` é o que o registro da conversa lê dessa
   * linha. O relógio é o de mentira do `beforeEach`: cada medida é exata.
   */
  // A ARI (ou o banco) falha no meio do pedido: a ligação fica viva sem nunca ter
  // saído, o atendente espera em silêncio e desliga. Não é "sem resposta", e o
  // registro não pode dizer que ele desistiu.
  it.each(["criarCanal", "discar"] as const)(
    "o worker não chegou a discar (%s falhou): 'não completada', e não 'desligada por quem ligou'",
    async (ondeFalha) => {
      const id = "00000000-0000-4000-8000-000000000004";
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
      (ari as unknown as Record<string, unknown>)[ondeFalha] = async () => {
        throw new ErroAri(500, "erro", `/channels/${ondeFalha}`);
      };
      await ctl.tratar({
        type: "StasisStart",
        channel: canal("ramal-n", `PJSIP/ramal-${ANA}-0000000e`, { dialplan: { context: "de-ramal", exten: `c-${id}`, priority: 1 } }),
        args: ["saida"],
      });
      // A falha do pedido é erro de verdade, e fica no log — aqui ela é o cenário.
      expect(log.error).toHaveBeenCalledTimes(1);
      log.error.mockClear();

      await vi.advanceTimersByTimeAsync(20_000);
      await ctl.tratar({ type: "StasisEnd", channel: canal("ramal-n", `PJSIP/ramal-${ANA}-0000000e`) });
      expect(banco.tem("encerrada")).toEqual([["encerrada", id, "saida_nao_discada"]]);
      expect(banco.tem("registro")).toEqual([["registro", id, "recusada_pela_rede"]]);
    },
  );

  describe("o tempo que o telefone do cliente chamou", () => {
    const ramalDesliga = () => ctl.tratar({ type: "StasisEnd", channel: canal("ramal-r", `PJSIP/ramal-${ANA}-0000000d`) });
    const linhaFechada = () => banco.devolvidasAoEncerrar[0]!;

    it("deu um toque e desligou: 4 s chamando, e foi o atendente quem encerrou", async () => {
      const { id, canalDaPerna } = await pedirEDiscar();
      await vi.advanceTimersByTimeAsync(2_000); // a rede ainda completando: não conta
      await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "RINGING" });
      await vi.advanceTimersByTimeAsync(4_000);
      await ramalDesliga();
      expect(banco.tem("encerrada")).toEqual([["encerrada", id, "atendente_desligou"]]);
      expect(toqueDaSaidaSemResposta(linhaFechada())).toBe(4_000);
    });

    it("deixou chamar até a rede desistir: 38 s chamando, e ninguém atendeu", async () => {
      const { id, canalDaPerna } = await pedirEDiscar();
      await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "RINGING" });
      await vi.advanceTimersByTimeAsync(38_000);
      await ctl.tratar({ type: "ChannelHangupRequest", channel: canalDaPerna, cause: 19 });
      await ctl.tratar({ type: "StasisEnd", channel: canalDaPerna });
      expect(banco.tem("encerrada")).toEqual([["encerrada", id, "sem_resposta_19"]]);
      expect(toqueDaSaidaSemResposta(linhaFechada())).toBe(38_000);
    });

    it("conta do PRIMEIRO toque: o 180 repetido e o 183 que vem depois não zeram o tempo", async () => {
      const { canalDaPerna } = await pedirEDiscar();
      await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "RINGING" });
      await vi.advanceTimersByTimeAsync(10_000);
      await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "RINGING" });
      await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "PROGRESS" });
      await vi.advanceTimersByTimeAsync(5_000);
      await ramalDesliga();
      expect(toqueDaSaidaSemResposta(linhaFechada())).toBe(15_000);
    });

    it("o 183 sozinho (áudio da operadora) também é o telefone chamando", async () => {
      const { canalDaPerna } = await pedirEDiscar();
      await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "PROGRESS" });
      await vi.advanceTimersByTimeAsync(7_000);
      await ramalDesliga();
      expect(toqueDaSaidaSemResposta(linhaFechada())).toBe(7_000);
    });

    it("desligou antes de o telefone chamar: nenhum instante de toque, e o registro sai sem tempo", async () => {
      await pedirEDiscar();
      await vi.advanceTimersByTimeAsync(3_000);
      await ramalDesliga();
      expect(linhaFechada().peer_ringing_at ?? null).toBeNull();
      expect(toqueDaSaidaSemResposta(linhaFechada())).toBeNull();
    });

    // O desmonte (parar o tom, derrubar os canais, destruir a ponte) espera a ARI —
    // até 5 s por pedido. Esse tempo não é o telefone do cliente chamando.
    it("a ARI lenta no desmonte não infla o tempo: vale o instante em que a ligação acabou", async () => {
      const { canalDaPerna } = await pedirEDiscar();
      await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "RINGING" });
      await vi.advanceTimersByTimeAsync(5_000);
      const desligar = ari.desligar;
      ari.desligar = async (c: string, m?: string) => {
        vi.setSystemTime(Date.now() + 4_000);
        return desligar(c, m);
      };
      await ramalDesliga();
      expect(toqueDaSaidaSemResposta(linhaFechada())).toBe(5_000);
    });

    it("atendida: o instante do primeiro toque fica guardado, mas o registro da conversa não ganha tempo de toque", async () => {
      const { canalDaPerna } = await pedirEDiscar();
      await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "RINGING" });
      await vi.advanceTimersByTimeAsync(20_000);
      await ctl.tratar({ type: "Dial", peer: canalDaPerna, dialstatus: "ANSWER" });
      await vi.advanceTimersByTimeAsync(60_000);
      await ramalDesliga();
      const l = linhaFechada();
      // Chamou 20 s até atender — o instante do toque, não o do fim.
      expect(new Date(l.answered_at!).getTime() - new Date(l.peer_ringing_at!).getTime()).toBe(20_000);
      expect(toqueDaSaidaSemResposta(l)).toBeNull();
    });
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
      // Já atendida pelo aviso: o cliente espera o ramal ouvindo o chamar — nem silêncio, nem música.
      expect(ari.nomes().slice(3)).toEqual(["tocarTom", "originar"]);
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

    it("depois do aviso, com atendente livre, ouve o chamar — o 'aguarde' é de quem não tem ninguém livre", async () => {
      banco.aviso = AVISO;
      banco.gerais = { ...banco.gerais, aguarde: AGUARDE };
      anaDisponivel();
      await entrar();
      await terminou("fala-1");
      expect(ari.falas()).toEqual(["sound:/falas/aviso"]);
      expect(ari.nomes().slice(3)).toEqual(["tocarTom", "originar"]);
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
      // Ninguém livre: depois do aviso vem o "aguarde" (com alguém livre viria o chamar, que não é fala).
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

    it("o Asterisk recusa tocar (a ARI responde erro): avisado, e ao padrão — atendida, com o chamar enquanto o ramal toca", async () => {
      ari.recusaFala.add(SOM_MENU);
      anaDisponivel();
      await entrar();
      expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "menu Atendimento"]]);
      expect(escolhas()).toEqual([["escolha", ORG, "vc-1", null, "default_no_input", TIME]]);
      expect(ari.nomes()).toEqual(["indicarChamando", "atender", "tocarFala", "tocarTom", "originar"]);
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

  it.each([404, 409])(
    "o chamar depois da escolha acha o canal do cliente fechado (%i): a ligação acaba, e ramal nenhum toca",
    async (status) => {
      banco.gerais = { ...banco.gerais, aguarde: falaDe("aguarde") };
      anaDisponivel();
      ari.recusaTom = status;
      await entrar();
      await tecla("2"); // já atendida pela URA: a fila toca o chamar antes de tocar o ramal
      expect(ari.tons()).toHaveLength(1);
      expect(ari.originados()).toEqual([]);
      // É o cliente indo embora: nem "aguarde" no lugar do chamar, nem "fala não tocou".
      expect(ari.falas()).toEqual([SOM_MENU]);
      expect(banco.tem("fala_intocavel")).toEqual([]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
      expect(ctl.ativas).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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
      return this.tocarNaPonteFalha ? null : "aviso-pb-1";
    };
    descartar = async (org: string, vcId: string) => {
      this.chamadas.push(["descartar", org, vcId]);
      // Como `desmarcarGravacao`: a ligação volta a "não gravada".
      const l = banco.ligacoes.get(vcId);
      if (l) l.recording_status = null;
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
    it("o aviso toca na PASSAGEM para o atendente: depois de entrar na fila, antes dos toques; o ramal atende → a ponte é gravada com a hora do aviso", async () => {
      await entrar();
      expect(gravacao.chamadas).toEqual([["politica", ORG]]);
      expect(banco.tem("entrou_na_fila")).toHaveLength(1);
      expect(ari.falas()).toEqual([SOM_DO_AVISO]);
      expect(ari.originados()).toEqual([]);

      vi.setSystemTime(new Date("2026-09-28T13:00:03Z"));
      await terminou("fala-1");
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

    describe("com menu (pedido do dono em 30/09/2026: o aviso não é a primeira coisa que o cliente ouve)", () => {
      const MENU = "33333333-3333-3333-3333-333333333333";
      beforeEach(() => {
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
      });

      it("o menu toca primeiro; o aviso só depois da escolha, antes dos toques; a ponte é gravada", async () => {
        await entrar();
        expect(ari.falas()).toEqual(["sound:/falas/menu"]);
        expect(gravacao.chamadas).toEqual([]);

        await ctl.tratar({ type: "ChannelDtmfReceived", channel: canal("cli-1", "x"), digit: "1" });
        expect(banco.tem("escolha")).toEqual([["escolha", ORG, "vc-1", "1", "chosen", TIME]]);
        expect(ari.falas()).toEqual(["sound:/falas/menu", SOM_DO_AVISO]);
        expect(ari.originados()).toEqual([]);

        await terminou(ari.ultimaFala());
        expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
        await ramalAtende(ari.ultimoOriginado());
        expect(gravacao.nomes()).toEqual(["politica", "comecar"]);
      });

      it("a tecla durante o aviso não muda nada: a URA já decidiu", async () => {
        await entrar();
        await ctl.tratar({ type: "ChannelDtmfReceived", channel: canal("cli-1", "x"), digit: "1" });
        await ctl.tratar({ type: "ChannelDtmfReceived", channel: canal("cli-1", "x"), digit: "1" });
        expect(banco.tem("escolha")).toHaveLength(1);
        expect(ari.falas()).toEqual(["sound:/falas/menu", SOM_DO_AVISO]);
      });

      it("quem desliga no menu, antes de escolher, não ouve o aviso — nem a política é lida", async () => {
        await entrar();
        await clienteDesligaDuranteAFala("fala-1");
        expect(ari.falas()).toEqual(["sound:/falas/menu"]);
        expect(gravacao.chamadas).toEqual([]);
      });
    });

    it("fora do horário: toca o 'fora do horário' e desliga — sem aviso de gravação", async () => {
      banco.situacao = "fora_do_horario";
      banco.gerais = { ...banco.gerais, foraDoHorario: falaDe("fora") };
      await entrar();
      await terminou("fala-1");
      expect(ari.falas()).toEqual(["sound:/falas/fora"]);
      expect(gravacao.chamadas).toEqual([]);
      expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "after_hours"]]);
    });

    it("com aviso de instabilidade: instabilidade → aviso de gravação → toques", async () => {
      banco.aviso = falaDe("aviso", 10_000);
      await entrar();
      expect(ari.falas()).toEqual(["sound:/falas/aviso"]);
      await terminou("fala-1");
      expect(ari.falas()).toEqual(["sound:/falas/aviso", SOM_DO_AVISO]);
      expect(ari.originados()).toEqual([]);
      await terminou(ari.ultimaFala());
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
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

    it("o fim do aviso se perde (sem PlaybackFinished): o relógio segue a ligação, mas ela NÃO é gravada, e a Central não é avisada", async () => {
      await entrar();
      await vi.advanceTimersByTimeAsync(AVISO_DE_GRAVACAO.duracaoMs + FOLGA_DO_FIM_DA_FALA_MS + 10);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
      expect(banco.tem("fala_intocavel")).toEqual([]);
      await ramalAtende(ari.ultimoOriginado());
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

    it("o aviso da feita FALHA depois de começar: a gravação que começou junto é descartada", async () => {
      const { perna } = await pedido();
      await atende(perna);
      await ctl.tratar({
        type: "PlaybackFinished",
        playback: { id: "aviso-pb-1", media_uri: SOM_DO_AVISO, target_uri: "bridge:p-x", language: "en", state: "failed" },
      });
      expect(gravacao.nomes()).toEqual(["politica", "tocarAvisoNaPonte", "comecar", "descartar"]);
      // Descartada, o fim não pede processamento nem para a gravação de novo.
      await destruir(perna);
      expect(gravacao.nomes()).toEqual(["politica", "tocarAvisoNaPonte", "comecar", "descartar"]);
    });

    it("o aviso da feita tocou até o fim: a gravação segue", async () => {
      const { perna } = await pedido();
      await atende(perna);
      await ctl.tratar({
        type: "PlaybackFinished",
        playback: { id: "aviso-pb-1", media_uri: SOM_DO_AVISO, target_uri: "bridge:p-x", language: "en", state: "done" },
      });
      await destruir(perna);
      expect(gravacao.nomes()).toEqual(["politica", "tocarAvisoNaPonte", "comecar", "parar", "aoEncerrar"]);
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

describe("o som de chamando na fila (DYD-52): com atendente livre, o chamar — não 'todos ocupados'", () => {
  // Medido em produção na 1.50.1: menu → tecla 2 → o José atendeu em 16 s, mas enquanto o ramal
  // dele tocava o cliente ouviu "Todos os nossos atendentes estão ocupados…". Aqui o "aguarde" e o
  // "ninguém atendeu" estão SEMPRE prontos: se a fila os pedir fora de hora, eles tocam e o teste vê.
  const MENU = "33333333-3333-3333-3333-333333333333";
  const TIME2 = "44444444-4444-4444-4444-444444444444";
  const CAIO = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const DUDA = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const AVISO = falaDe("aviso", 10_000);
  const SOM_MENU = "sound:/falas/menu";
  const SOM_AGUARDE = "sound:/falas/aguarde";
  const SOM_NINGUEM = "sound:/falas/ninguem";
  const CHAMAR = ["tocarTom", "cli-1", "ring"];

  /** Livres e com o ramal on-line, na ordem dada (quem vem antes atendeu menos hoje). */
  const livres = (...ids: string[]) => {
    banco.disponiveis = ids.map((userId, i) => ({ userId, atendidasHoje: i, ultimaAtendidaEm: null }));
    for (const id of ids) ari.online.add(id);
  };
  /** O número aponta para um menu: 1 → time 1, 2 → time 2. */
  const comMenu = () => {
    banco.troncoAtual = { ...tronco, teamId: null, menuId: MENU };
    banco.menus.set(MENU, {
      id: MENU,
      nome: "Atendimento",
      defaultTeamId: TIME,
      timePadraoAtivo: true,
      fala: falaDe("menu", 4_000),
      falaInvalida: null,
      opcoes: [
        { digito: "1", teamId: TIME },
        { digito: "2", teamId: TIME2 },
      ],
    });
  };
  const tecla = (digit: string) => ctl.tratar({ type: "ChannelDtmfReceived", channel: cliente, digit });
  /** Menu → tecla 2 no meio da fala do menu, como na ligação medida. */
  const escolheuO2 = async () => {
    comMenu();
    await entrar();
    await tecla("2");
  };
  /** O fim do playback do CHAMAR, como a ARI entrega: `done` (parado ou acabou) ou `failed`. */
  const oChamarTerminou = (id: string, state: "done" | "failed" = "done") =>
    ctl.tratar({
      type: "PlaybackFinished",
      playback: { id, media_uri: "tone:ring;tonezone=br", target_uri: "channel:cli-1", language: "en", state },
    });

  beforeEach(() => {
    banco.gerais = { aguarde: falaDe("aguarde"), ninguem: falaDe("ninguem"), foraDoHorario: null };
  });

  it("(1) menu → tecla 2 → há atendente livre: o chamar toca; nem 'aguarde', nem música", async () => {
    livres(ANA);
    await escolheuO2();
    expect(ari.chamadas).toContainEqual(CHAMAR);
    expect(ari.falas()).toEqual([SOM_MENU]);
    expect(ari.nomes()).not.toContain("musicaDeEspera");
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
    // O menu (um playback) sai do ar ANTES do chamar: na ARI, playback pedido com outro no ar entra na fila atrás dele.
    expect(ari.indice("pararFala", "fala-1")).toBeGreaterThan(-1);
    expect(ari.indice("pararFala", "fala-1")).toBeLessThan(ari.indice("tocarTom"));
    expect(ari.indice("tocarTom")).toBeLessThan(ari.indice("originar"));
    expect(ctl.falasNoAr).toBe(0);
  });

  it("(2) menu → tecla 2 → ninguém livre: 'aguarde' e música, e o 'aguarde' volta em ~40 s — sem o chamar", async () => {
    await escolheuO2();
    expect(ari.falas()).toEqual([SOM_MENU, SOM_AGUARDE]);
    await terminou(ari.ultimaFala());
    expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);
    await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS);
    expect(ari.falas()).toEqual([SOM_MENU, SOM_AGUARDE, SOM_AGUARDE]);
    expect(ari.tons()).toEqual([]);
  });

  it("(3) chamando e a lista esvazia: o chamar PARA, e só então o 'aguarde' toca — a música entra no fim dele", async () => {
    livres(ANA);
    await escolheuO2();
    banco.disponiveis = [];
    await destruir("ramal-canal-1", 19);
    expect(ari.indice("pararReproducao", "tom-1")).toBeGreaterThan(-1);
    expect(ari.indice("pararReproducao", "tom-1")).toBeLessThan(ari.indice("tocarFala", "cli-1", SOM_AGUARDE));
    await terminou(ari.ultimaFala());
    expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);
    expect(ari.tons()).toHaveLength(1);
  });

  it("(3b) chamando, a lista esvazia e o 'aguarde' não tem arquivo: o chamar para ANTES da música", async () => {
    falas.semArquivo.add("aguarde");
    livres(ANA);
    await escolheuO2();
    banco.disponiveis = [];
    await destruir("ramal-canal-1", 19);
    expect(ari.indice("pararReproducao", "tom-1")).toBeGreaterThan(-1);
    expect(ari.indice("pararReproducao", "tom-1")).toBeLessThan(ari.indice("musicaDeEspera", "cli-1"));
    expect(banco.tem("fala_intocavel")).toEqual([["fala_intocavel", ORG, "aguarde"]]);
  });

  it("(4) o atendente atende: o chamar para ANTES da ponte, e o fim atrasado dele não religa nada", async () => {
    livres(ANA);
    await escolheuO2();
    await ramalAtende(ari.ultimoOriginado());
    expect(ari.indice("pararReproducao", "tom-1")).toBeGreaterThan(-1);
    expect(ari.indice("pararReproducao", "tom-1")).toBeLessThan(ari.indice("criarPonte", "p-vc-1"));
    expect(banco.tem("atendida")).toEqual([["atendida", "vc-1", ANA]]);

    const n = ari.chamadas.length;
    await oChamarTerminou("tom-1"); // o tom parado termina `done`, e o evento chega depois
    expect(ari.chamadas.slice(n)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(5) duas voltas sem ninguém atender: o chamar para ANTES do 'ninguém atendeu'", async () => {
    livres(ANA, BIA);
    await escolheuO2();
    for (const c of ["ramal-canal-1", "ramal-canal-2", "ramal-canal-3", "ramal-canal-4"]) await destruir(c, 19);
    expect(ari.indice("pararReproducao", "tom-1")).toBeGreaterThan(-1);
    expect(ari.indice("pararReproducao", "tom-1")).toBeLessThan(ari.indice("tocarFala", "cli-1", SOM_NINGUEM));
    expect(ari.falas()).toEqual([SOM_MENU, SOM_NINGUEM]);
    expect(ari.tons()).toHaveLength(1);

    await terminou(ari.ultimaFala());
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "ninguem_atendeu"]]);
    expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(5b) sem 'ninguém atendeu' pronto: o chamar para ANTES de o cliente ser desligado", async () => {
    banco.gerais = { ...banco.gerais, ninguem: null };
    livres(ANA);
    await escolheuO2();
    await destruir("ramal-canal-1", 19);
    await destruir("ramal-canal-2", 19); // Ana de novo, na 2ª volta; e então desiste
    expect(ari.indice("desligar", "cli-1")).toBeGreaterThan(-1);
    expect(ari.indice("pararReproducao", "tom-1")).toBeLessThan(ari.indice("desligar", "cli-1"));
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "ninguem_atendeu"]]);
  });

  it("(6) sem menu: antes dos 45 s só o chamar da operadora (180); na régua dos 45 s atende e toca o chamar — não o 'aguarde'", async () => {
    livres(ANA, BIA, CAIO, DUDA);
    await entrar();
    expect(ari.nomes()).toEqual(["indicarChamando", "originar"]);
    await vi.advanceTimersByTimeAsync(20_000);
    await destruir("ramal-canal-1", 19);
    await vi.advanceTimersByTimeAsync(20_000); // 40 s: ainda dentro da régua
    await destruir("ramal-canal-2", 19);
    expect(ari.nomes()).toEqual(["indicarChamando", "originar", "originar", "originar"]);

    await vi.advanceTimersByTimeAsync(20_000); // 60 s: passou dos 45 s, ainda na 1ª volta
    await destruir("ramal-canal-3", 19);
    expect(ari.nomes().slice(4)).toEqual(["atender", "tocarTom", "originar"]);
    expect(ari.falas()).toEqual([]);
    expect(ari.nomes()).not.toContain("musicaDeEspera");
    expect(ari.originados().at(-1)).toBe(`PJSIP/ramal-${DUDA}`);
  });

  it("(6b) sem menu, a 2ª volta começa antes dos 45 s: atende e toca o chamar — não o 'aguarde'", async () => {
    livres(ANA);
    await entrar();
    await destruir("ramal-canal-1", 19);
    expect(ari.nomes()).toEqual(["indicarChamando", "originar", "atender", "tocarTom", "originar"]);
    expect(ari.falas()).toEqual([]);
  });

  it("(7) de um atendente ao próximo e na 2ª volta, o MESMO chamar segue — sem recomeçar nem soluçar", async () => {
    banco.aviso = AVISO;
    livres(ANA, BIA);
    await entrar();
    await terminou("fala-1"); // o aviso inteiro; o chamar começa
    expect(ari.tons()).toHaveLength(1);
    await destruir("ramal-canal-1", 19); // Bia
    await destruir("ramal-canal-2", 19); // a 2ª volta: Ana de novo
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`, `PJSIP/ramal-${BIA}`, `PJSIP/ramal-${ANA}`]);
    expect(ari.tons()).toHaveLength(1);
    expect(ari.nomes()).not.toContain("pararReproducao");
    expect(ari.falas()).toEqual(["sound:/falas/aviso"]);
  });

  describe("(8) o fim do playback do chamar nunca é o fim de uma fala", () => {
    it("o do chamar já parado chega com o 'aguarde' no ar: ignorado — nem música, nem chamar de novo", async () => {
      livres(ANA);
      await escolheuO2();
      banco.disponiveis = [];
      await destruir("ramal-canal-1", 19); // o chamar (tom-1) para; o "aguarde" entra no ar
      const aguarde = ari.ultimaFala();
      expect(ctl.falasNoAr).toBe(1);

      const n = ari.chamadas.length;
      await oChamarTerminou("tom-1");
      expect(ari.chamadas.slice(n)).toEqual([]);
      expect(ctl.falasNoAr).toBe(1);

      await terminou(aguarde); // o fim de verdade do "aguarde" continua valendo
      expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);
    });

    it("o chamar que acaba sozinho enquanto ainda chama recomeça, e é o novo que para quando atendem", async () => {
      livres(ANA);
      await escolheuO2();
      const n = ari.chamadas.length;
      await oChamarTerminou("tom-1");
      expect(ari.chamadas.slice(n)).toEqual([CHAMAR]);
      expect(ctl.falasNoAr).toBe(0);

      await ramalAtende(ari.ultimoOriginado());
      expect(ari.chamadas).toContainEqual(["pararReproducao", "tom-2"]);
      expect(ari.chamadas).not.toContainEqual(["pararReproducao", "tom-1"]);
    });

    it("o chamar que acaba 'done' logo ao começar, de novo e de novo: no 3º recomeço rápido, a música no lugar — não inunda a ARI", async () => {
      livres(ANA);
      await escolheuO2();
      await oChamarTerminou("tom-1"); // 1º fim rápido → tom-2
      await oChamarTerminou("tom-2"); // 2º → tom-3
      expect(ari.tons()).toHaveLength(3);
      expect(ari.nomes()).not.toContain("musicaDeEspera");

      await oChamarTerminou("tom-3"); // 3º → teto: música
      expect(ari.tons()).toHaveLength(3);
      expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);
      expect(ari.falas()).toEqual([SOM_MENU]); // nunca o "aguarde" com ramal tocando
      expect(ctl.chamandosNoAr).toBe(0);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("som de chamando"),
        expect.objectContaining({ voice_call: "vc-1", erro: expect.stringContaining("3") }),
      );

      // O próximo ramal não volta a tentar o chamar: a música segue.
      await destruir("ramal-canal-1", 19);
      expect(ari.tons()).toHaveLength(3);
    });

    it("o chamar que acaba 'done' depois de tocar um bom tempo recomeça sempre — o teto é só para o fim rápido", async () => {
      livres(ANA);
      await escolheuO2();
      for (let i = 1; i <= 4; i++) {
        await vi.advanceTimersByTimeAsync(6_000);
        await oChamarTerminou(`tom-${i}`);
      }
      expect(ari.tons()).toHaveLength(5);
      expect(ari.nomes()).not.toContain("musicaDeEspera");
    });

    it("o Asterisk não toca o chamar (failed, sem o cliente sair): a música no lugar do silêncio — nunca o 'aguarde' com ramal tocando", async () => {
      livres(ANA, BIA);
      await escolheuO2();
      await oChamarTerminou("tom-1", "failed");
      expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);
      expect(ari.falas()).toEqual([SOM_MENU]);
      expect(ari.nomes()).not.toContain("desligar");
      expect(ctl.chamandosNoAr).toBe(0);

      // O próximo ramal não insiste no chamar que falhou: a música segue.
      await destruir("ramal-canal-1", 19);
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`, `PJSIP/ramal-${BIA}`]);
      expect(ari.tons()).toHaveLength(1);
      expect(ari.falas()).toEqual([SOM_MENU]);

      // A lista esvazia: aí sim o "aguarde" — com a música parada antes dele, e de volta no fim.
      banco.disponiveis = [];
      await destruir("ramal-canal-2", 19);
      expect(ari.falas()).toEqual([SOM_MENU, SOM_AGUARDE]);
      expect(ari.indice("pararMusica", "cli-1")).toBeGreaterThan(-1);
      expect(ari.indice("pararMusica", "cli-1")).toBeLessThan(ari.indice("tocarFala", "cli-1", SOM_AGUARDE));
      await terminou(ari.ultimaFala());
      expect(ari.chamadas.at(-1)).toEqual(["musicaDeEspera", "cli-1"]);
    });

    it("a ARI recusa o chamar (erro no pedido): a música no lugar do silêncio, e o ramal toca", async () => {
      ari.recusaTom = 500;
      livres(ANA);
      await escolheuO2();
      expect(ari.falas()).toEqual([SOM_MENU]);
      expect(ari.indice("musicaDeEspera", "cli-1")).toBeGreaterThan(-1);
      expect(ari.indice("musicaDeEspera", "cli-1")).toBeLessThan(ari.indice("originar"));
      expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);
      expect(banco.tem("encerrada")).toEqual([]);
    });
  });

  it("(9) já esperando com música e alguém fica livre: a música segue enquanto o ramal toca — sem o chamar", async () => {
    await escolheuO2();
    await terminou(ari.ultimaFala()); // o "aguarde"; a música entra
    livres(ANA);
    const n = ari.chamadas.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ari.chamadas.slice(n)).toEqual([["originar", `PJSIP/ramal-${ANA}`, "oferta,vc-1"]]);
    expect(ari.tons()).toEqual([]);
  });

  it("(9b) esperando com música, alguém fica livre e o ramal toca: o 'aguarde' dos ~40 s NÃO volta enquanto o ramal toca — volta quando a lista esvazia de novo", async () => {
    // Achado da revisão: o relógio do "aguarde" não olhava o ramal, e aos ~40 s o cliente
    // ouvia "todos ocupados" de novo com o ramal da Ana tocando.
    await escolheuO2(); //                  t = 0: ninguém livre — fala-2, o "aguarde"
    await terminou("fala-2"); //            a música; a repetição fica para t = 40 s
    livres(ANA);
    await vi.advanceTimersByTimeAsync(5_000); // t = 5 s: o ramal da Ana começa a tocar
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`]);

    await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS); // t = 45 s: o ciclo passou com o ramal tocando
    expect(ari.falas()).toEqual([SOM_MENU, SOM_AGUARDE]);
    expect(ari.nomes()).not.toContain("pararMusica"); // a música segue, sem soluço
    expect(ari.tons()).toEqual([]);

    banco.disponiveis = []; //              a Ana não atendeu, e ninguém mais está livre
    await destruir("ramal-canal-1", 19);
    expect(ari.falas()).toEqual([SOM_MENU, SOM_AGUARDE]); // nada na hora: a música segue até o ciclo

    const n = ari.chamadas.length;
    await vi.advanceTimersByTimeAsync(REPETIR_AGUARDE_MS); // t = 85 s: o ciclo rearmado (80 s) acha a lista vazia
    expect(ari.chamadas.slice(n)).toEqual([
      ["pararMusica", "cli-1"],
      ["tocarFala", "cli-1", SOM_AGUARDE],
    ]);
    expect(banco.tem("encerrada")).toEqual([]);
  });

  it("o cliente desliga enquanto chama: o fim 'failed' do chamar não vira 'aguarde' nem música; perdida, e nada sobra", async () => {
    livres(ANA);
    await escolheuO2();
    await ctl.tratar({ type: "ChannelHangupRequest", channel: cliente, cause: 16 });
    await oChamarTerminou("tom-1", "failed");
    await ctl.tratar({ type: "StasisEnd", channel: cliente });
    expect(ari.falas()).toEqual([SOM_MENU]);
    expect(ari.nomes()).not.toContain("musicaDeEspera");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-1", undefined]);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "cliente_desligou"]]);
    expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctl.ativas).toBe(0);
    expect(ctl.chamandosNoAr).toBe(0);
  });

  it("a ligação acaba com o chamar no ar (sem o fim dele chegar): o chamar para ANTES de derrubar o ramal", async () => {
    livres(ANA);
    await escolheuO2();
    await ctl.tratar({ type: "StasisEnd", channel: cliente });
    expect(ari.indice("pararReproducao", "tom-1")).toBeGreaterThan(-1);
    expect(ari.indice("pararReproducao", "tom-1")).toBeLessThan(ari.indice("desligar", "ramal-canal-1"));
    expect(ctl.ativas).toBe(0);
    expect(ctl.chamandosNoAr).toBe(0);

    const n = ari.chamadas.length;
    await oChamarTerminou("tom-1");
    expect(ari.chamadas.slice(n)).toEqual([]);
  });
});

describe("o cartão 'Ligação em andamento' (fila visível, entrega 1)", () => {
  beforeEach(() => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
  });

  it("ao atender, o cartão entra na conversa DEPOIS da atribuição — e com quem atendeu", async () => {
    await entrar();
    await ramalAtende(ari.ultimoOriginado());
    expect(banco.tem("cartao")).toEqual([["cartao", "vc-1", ANA]]);
    const nomes = banco.eventos.map((e) => e[0]);
    expect(nomes.indexOf("atribuida")).toBeGreaterThan(-1);
    expect(nomes.indexOf("cartao")).toBeGreaterThan(nomes.indexOf("atribuida"));
  });

  it("enquanto ninguém atende não há cartão, e a perdida não ganha um", async () => {
    await entrar();
    expect(banco.tem("cartao")).toEqual([]);
    await destruir("cli-1");
    expect(banco.tem("cartao")).toEqual([]);
    expect(banco.tem("registro")).toEqual([["registro", "vc-1", "perdida"]]);
  });

  it("o banco cai ao abrir o cartão: a ponte se forma, a ligação segue e o fim registra", async () => {
    banco.falharCartao = true;
    await entrar();
    await ramalAtende(ari.ultimoOriginado());
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "ramal-canal-1"]);
    expect(banco.tem("atendida")).toEqual([["atendida", "vc-1", ANA]]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("cartão da ligação em andamento não aberto"),
      expect.anything(),
    );
    await destruir("cli-1");
    expect(banco.tem("registro")).toEqual([["registro", "vc-1", "atendida"]]);
    expect(ctl.ativas).toBe(0);
  });

  it("número oculto (sem conversa): a ligação é atendida, e não há conversa onde pôr o cartão", async () => {
    // A mesma montagem do caso de número oculto da gravação: a bina não vira E.164, e a ligação nasce sem conversa.
    await ctl.tratar({
      type: "StasisStart",
      channel: canal("cli-1", `PJSIP/tronco-${TRONCO}-00000001`, { caller: { name: "", number: "anonymous" } }),
      args: ["entrada"],
    });
    await ramalAtende(ari.ultimoOriginado());
    expect(banco.tem("atendida")).toHaveLength(1);
    expect(banco.tem("cartao")).toEqual([]);
  });
});

describe("a fila visível (0295): ordem de chegada, teto por time e prazo", () => {
  const OUTRO_TIME = "55555555-5555-5555-5555-555555555555";
  const cliente2 = canal("cli-2", `PJSIP/tronco-${TRONCO}-00000002`, { caller: { name: "", number: "61977776666" } });
  const cliente3 = canal("cli-3", `PJSIP/tronco-${TRONCO}-00000003`, { caller: { name: "", number: "61966665555" } });
  const entrar2 = () => ctl.tratar({ type: "StasisStart", channel: cliente2, args: ["entrada"] });
  const entrar3 = () => ctl.tratar({ type: "StasisStart", channel: cliente3, args: ["entrada"] });
  /** Para quem cada ligação foi oferecida, na ordem: `[endpoint, appArgs]`. */
  const ofertas = () => ari.chamadas.filter((c) => c[0] === "originar").map((c) => [c[1], c[2]]);
  /** Os canais que o controlador mandou desligar, na ordem. */
  const desligados = () => ari.chamadas.filter((c) => c[0] === "desligar").map((c) => c[1]);
  const musicas = (canalId: string) => ari.chamadas.filter((c) => c[0] === "musicaDeEspera" && c[1] === canalId);
  /** A n-ésima ligação a chegar (`cli-<n>`); o banco de mentira lhe dá `vc-<ordem de chegada>`. */
  const chega = (n: number) =>
    ctl.tratar({
      type: "StasisStart",
      channel: canal(`cli-${n}`, `PJSIP/tronco-${TRONCO}-0000000${n}`, { caller: { name: "", number: `6197000000${n}` } }),
      args: ["entrada"],
    });
  const atendimentosDoCliente = () => ari.chamadas.filter((c) => c[0] === "atender");

  it("a ordem de chegada é gravada uma vez, quando os toques começam", async () => {
    await entrar();
    expect(banco.tem("na_fila")).toEqual([["na_fila", "vc-1"]]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(banco.tem("na_fila")).toHaveLength(1);
  });

  it("sem ninguém livre, o prazo da fila é gravado com o teto padrão — e a fila esgota nele", async () => {
    await entrar();
    expect(banco.tem("prazo_da_fila")).toEqual([["prazo_da_fila", "vc-1", 120_000]]);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
    // Gravado quando a espera começa, e só: reavaliar a fila não o reescreve.
    expect(banco.tem("prazo_da_fila")).toHaveLength(1);
  });

  it("o teto é o do time: com 5 minutos, a ligação não cai aos 2 e cai aos 5", async () => {
    banco.esperaMaximaS = 300;
    await entrar();
    expect(banco.tem("prazo_da_fila")).toEqual([["prazo_da_fila", "vc-1", 300_000]]);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(banco.tem("encerrada")).toEqual([]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
  });

  it("o teto é lido na entrada da fila: mudar a configuração não altera quem já está esperando", async () => {
    banco.esperaMaximaS = 300;
    await entrar();
    banco.esperaMaximaS = 30; // alguém baixou o teto do time com a ligação já na fila
    await vi.advanceTimersByTimeAsync(125_000);
    expect(banco.tem("encerrada")).toEqual([]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
  });

  it("duas esperando e UM atendente fica livre: toca para a que chegou primeiro, não para a segunda", async () => {
    await entrar();
    await vi.advanceTimersByTimeAsync(2_000); // a segunda chega 2 s depois…
    await entrar2();
    // …e o relógio de 5 s da SEGUNDA dispara antes do da primeira logo depois de o atendente ficar livre.
    await vi.advanceTimersByTimeAsync(4_500); // t=6,5 s: a 1ª reavaliou em t=5 e reavalia em t=10; a 2ª em t=7
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await vi.advanceTimersByTimeAsync(1_000); // t=7,5 s: o relógio da SEGUNDA dispara — e ela NÃO toca
    expect(ofertas()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000); // t=10,5 s: o da PRIMEIRA dispara — e ela toca
    expect(ofertas()).toEqual([[`PJSIP/ramal-${ANA}`, "oferta,vc-1"]]);
  });

  it("três esperando e dois livres: as duas mais antigas tocam, a terceira espera", async () => {
    await entrar(); // t=0: reavalia em t=5, t=10…
    await vi.advanceTimersByTimeAsync(1_000);
    await entrar2(); // t=1: reavalia em t=6, t=11…
    await vi.advanceTimersByTimeAsync(1_000);
    await entrar3(); // t=2: reavalia em t=7, t=12…
    await vi.advanceTimersByTimeAsync(3_500); // t=5,5 s: a 1ª já reavaliou (ninguém livre) e só volta em t=10
    banco.disponiveis = [
      { userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null },
      { userId: BIA, atendidasHoje: 0, ultimaAtendidaEm: null },
    ];
    ari.online.add(ANA).add(BIA);

    // t=6: o relógio da SEGUNDA dispara. Dois livres e uma só na frente: ela toca, sem esperar a primeira.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofertas()).toEqual([[`PJSIP/ramal-${ANA}`, "oferta,vc-2"]]);
    // O banco de verdade tira da lista quem está tocando; o de mentira não sabe — o teste tira.
    banco.disponiveis = [{ userId: BIA, atendidasHoje: 0, ultimaAtendidaEm: null }];

    // t=7: o relógio da TERCEIRA dispara. Sobra UM livre, e a primeira ainda espera na frente: ela NÃO toca.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofertas()).toHaveLength(1);

    // t=10: o da PRIMEIRA dispara, e o livre que sobrou é dela.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ofertas().at(-1)).toEqual([`PJSIP/ramal-${BIA}`, "oferta,vc-1"]);
    banco.disponiveis = [];

    await vi.advanceTimersByTimeAsync(3_000); // t=13,5 s: a terceira reavaliou em t=12, sem ninguém livre
    const quem = ofertas().map((o) => o[1]);
    expect(quem).toContain("oferta,vc-1");
    expect(quem).toContain("oferta,vc-2");
    expect(quem).not.toContain("oferta,vc-3");
  });

  it("a vez é por TIME: a ligação mais antiga da fila de outro time não segura esta", async () => {
    await entrar(); // a fila do TIME
    await vi.advanceTimersByTimeAsync(2_000);
    banco.troncoAtual = { ...tronco, teamId: OUTRO_TIME };
    await entrar2(); // a fila de outro time, 2 s depois
    await vi.advanceTimersByTimeAsync(4_500); // t=6,5 s
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await vi.advanceTimersByTimeAsync(1_000); // t=7,5 s: o relógio da segunda dispara — e, na fila DELA, ela é a primeira
    expect(ofertas()).toEqual([[`PJSIP/ramal-${ANA}`, "oferta,vc-2"]]);
  });

  it("o fim de uma ligação reavalia quem espera 2 s depois — antes do relógio de 5 s dela, e não no mesmo instante", async () => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await entrar();
    await ramalAtende(ari.ultimoOriginado()); // ANA atende a primeira
    banco.disponiveis = []; // ANA está em ligação
    await entrar2(); // t=0: a segunda espera, e reavalia sozinha em t=5, t=10…
    await vi.advanceTimersByTimeAsync(6_000); // t=6: o relógio dela acabou de rearmar — só volta em t=10
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 1, ultimaAtendidaEm: new Date() }];
    await destruir("cli-1"); // a primeira acaba: ANA está livre

    // No mesmo instante, NÃO: o navegador de quem acabou de desligar ainda fecha a sessão anterior.
    expect(ofertas().at(-1)).toEqual([`PJSIP/ramal-${ANA}`, "oferta,vc-1"]);
    await vi.advanceTimersByTimeAsync(REAVALIAR_APOS_O_FIM_MS - 100); // t=7,9
    expect(ofertas().at(-1)).toEqual([`PJSIP/ramal-${ANA}`, "oferta,vc-1"]);
    await vi.advanceTimersByTimeAsync(200); // t=8,1 — o relógio próprio dela só dispararia em t=10
    expect(ofertas().at(-1)).toEqual([`PJSIP/ramal-${ANA}`, "oferta,vc-2"]);
  });

  it("três ligações acabam dentro de 1 s: UMA passada de reavaliação, não três", async () => {
    for (const n of [1, 2, 3, 4]) await chega(n); // t=0: quatro esperando, ninguém livre
    await vi.advanceTimersByTimeAsync(6_000); // t=6: todas reavaliaram em t=5 e só voltam em t=10
    banco.leiturasDeDisponiveis = 0;

    await destruir("cli-1"); // t=6
    await vi.advanceTimersByTimeAsync(300);
    await destruir("cli-2"); // t=6,3
    await vi.advanceTimersByTimeAsync(300);
    await destruir("cli-3"); // t=6,6
    // Nada foi reavaliado no fim de cada uma, e há UMA passada agendada (mais o relógio da que ficou).
    expect(banco.leiturasDeDisponiveis).toBe(0);
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(2_900); // t=9,5: a passada rodou em t=8 — a 2 s do PRIMEIRO fim
    expect(banco.leiturasDeDisponiveis).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(ctl.ativas).toBe(1);
  });

  it("sem ninguém esperando, o fim de uma ligação não deixa relógio nenhum para trás", async () => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await entrar();
    await ramalAtende(ari.ultimoOriginado());
    await destruir("cli-1");
    expect(ctl.ativas).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("5 esperando no mesmo time e ninguém livre: a passada lê os disponíveis UMA vez — e os relógios das outras seguem", async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) await chega(n); // t=0
    await vi.advanceTimersByTimeAsync(6_000); // t=6
    banco.leiturasDeDisponiveis = 0;
    await destruir("cli-6"); // sobram cinco esperando; a passada roda em t=8

    await vi.advanceTimersByTimeAsync(2_500); // t=8,5
    // A mais antiga foi avaliada e continuou esperando: as outras quatro leriam a MESMA lista vazia.
    expect(banco.leiturasDeDisponiveis).toBe(1);
    expect(ctl.ativas).toBe(5);

    await vi.advanceTimersByTimeAsync(2_000); // t=10,5: as quatro puladas reavaliaram no relógio delas, em t=10
    expect(banco.leiturasDeDisponiveis).toBe(5);
  });

  it("5 esperando e UM livre: a passada toca a mais antiga, avalia a segunda (que espera) e para aí", async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) await chega(n); // t=0
    await vi.advanceTimersByTimeAsync(6_000); // t=6
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    // O banco de verdade tira da lista quem passou a tocar; o de mentira não sabe — depois da 1ª leitura, ninguém.
    const ler = banco.disponiveisNoTime;
    banco.disponiveisNoTime = async () => {
      const lista = await ler();
      banco.disponiveis = [];
      return lista;
    };
    banco.leiturasDeDisponiveis = 0;
    await destruir("cli-6"); // a passada roda em t=8

    await vi.advanceTimersByTimeAsync(2_500); // t=8,5
    expect(ofertas()).toEqual([[`PJSIP/ramal-${ANA}`, "oferta,vc-1"]]);
    expect(banco.leiturasDeDisponiveis).toBe(2);
  });

  it("a passada corta por TIME: a fila de um time sem ninguém livre não tira a vez de avaliar a de outro", async () => {
    await chega(1);
    await chega(2); // duas na fila do TIME
    banco.troncoAtual = { ...tronco, teamId: OUTRO_TIME };
    await chega(3);
    await chega(4); // duas na fila de outro time
    await chega(5); // e a que vai acabar
    await vi.advanceTimersByTimeAsync(6_000); // t=6
    banco.leiturasDeDisponiveis = 0;
    await destruir("cli-5");

    await vi.advanceTimersByTimeAsync(2_500); // t=8,5: uma leitura por time
    expect(banco.leiturasDeDisponiveis).toBe(2);
    expect(banco.consultas.filter((c) => c[0] === "timeParaAFila").map((c) => c[2])).toEqual([TIME, TIME, OUTRO_TIME, OUTRO_TIME, OUTRO_TIME]);
  });

  it("duas esperando, a primeira esgota o teto e encerra: a segunda segue esperando — música, relógio armado — e cai no teto DELA", async () => {
    await entrar(); // t=0: esgota em t=120
    await vi.advanceTimersByTimeAsync(62_000);
    await entrar2(); // t=62: esgota em t=182
    await vi.advanceTimersByTimeAsync(59_000); // t=121: a primeira esgotou em t=120, e a reavaliação está agendada para t=122

    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
    expect(ctl.ativas).toBe(1);
    // A segunda não foi tocada pelo fim da outra: a música dela segue (uma só, nunca parada) e ninguém a desligou.
    expect(musicas("cli-2")).toHaveLength(1);
    expect(ari.chamadas).not.toContainEqual(["pararMusica", "cli-2"]);
    expect(desligados()).toEqual(["cli-1"]);
    expect(ofertas()).toEqual([]);
    // O relógio de reavaliar dela e a passada agendada pelo fim da primeira.
    expect(vi.getTimerCount()).toBe(2);
    expect(banco.tem("prazo_da_fila")).toEqual([
      ["prazo_da_fila", "vc-1", 120_000],
      ["prazo_da_fila", "vc-2", 120_000],
    ]);

    await vi.advanceTimersByTimeAsync(2_000); // t=123: a passada rodou — e ela continua como estava
    expect(banco.tem("encerrada")).toHaveLength(1);
    expect(musicas("cli-2")).toHaveLength(1);
    expect(desligados()).toEqual(["cli-1"]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(58_000); // t=181: antes do teto dela
    expect(banco.tem("encerrada")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7_000); // t=188: passou do teto dela
    expect(banco.tem("encerrada")).toEqual([
      ["encerrada", "vc-1", "fila_esgotada"],
      ["encerrada", "vc-2", "fila_esgotada"],
    ]);
    expect(ctl.ativas).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a passada encerra a que já tinha esgotado — UMA vez — e a terceira segue na fila; o fim dela agenda outra passada, não reentra", async () => {
    await entrar(); // t=0, teto de 120 s: esgota no relógio dela, em t=120
    await vi.advanceTimersByTimeAsync(4_000);
    banco.esperaMaximaS = 117; // t=4: esgota em t=121 — entre o relógio dela de t=119 e o de t=124
    await entrar2();
    await vi.advanceTimersByTimeAsync(2_000);
    banco.esperaMaximaS = 300; // t=6: espera até t=306
    await entrar3();

    await vi.advanceTimersByTimeAsync(115_500); // t=121,5: a primeira caiu em t=120; a segunda já passou do teto, e ninguém a avaliou ainda
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);

    // t=122: a passada agendada pelo fim da primeira avalia a segunda, que encerra DENTRO dela,
    // e segue para a terceira, que fica. O fim da segunda agenda a passada seguinte (t=124).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(banco.tem("encerrada")).toEqual([
      ["encerrada", "vc-1", "fila_esgotada"],
      ["encerrada", "vc-2", "fila_esgotada"],
    ]);
    expect(banco.tem("registro")).toEqual([
      ["registro", "vc-1", "perdida"],
      ["registro", "vc-2", "perdida"],
    ]);
    expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"], ["perdida", "vc-2"]]);
    expect(desligados()).toEqual(["cli-1", "cli-2"]);
    // A terceira: viva, com a música de sempre (uma só) e o prazo gravado uma vez.
    expect(ctl.ativas).toBe(1);
    expect(musicas("cli-3")).toHaveLength(1);
    expect(ari.chamadas).not.toContainEqual(["pararMusica", "cli-3"]);
    expect(vi.getTimerCount()).toBe(2); // o relógio dela + a passada que o fim da segunda agendou
    expect(banco.tem("prazo_da_fila")).toEqual([
      ["prazo_da_fila", "vc-1", 120_000],
      ["prazo_da_fila", "vc-2", 117_000],
      ["prazo_da_fila", "vc-3", 300_000],
    ]);

    await vi.advanceTimersByTimeAsync(2_000); // t=124,5: a segunda passada rodou; ninguém mais acabou, nada mais agendado
    expect(banco.tem("encerrada")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);

    // E ela ainda é atendida quando alguém fica livre.
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ofertas()).toEqual([[`PJSIP/ramal-${ANA}`, "oferta,vc-3"]]);
    await ramalAtende(ari.ultimoOriginado(), "vc-3");
    expect(banco.tem("atendida")).toEqual([["atendida", "vc-3", ANA]]);
  });

  it("o Asterisk não atende o cliente na hora de segurá-lo na linha: a fila segue com relógio, toca quem fica livre e o cliente é atendido", async () => {
    ari.falharAtender = 1;
    await entrar();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("não consegui segurar o cliente na linha"), expect.anything());
    expect(ctl.ativas).toBe(1);
    expect(vi.getTimerCount()).toBe(1); // o relógio de reavaliar: a ligação não ficou parada
    expect(banco.tem("prazo_da_fila")).toHaveLength(1);

    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ofertas()).toEqual([[`PJSIP/ramal-${ANA}`, "oferta,vc-1"]]);

    await ramalAtende(ari.ultimoOriginado());
    // A tentativa que falhou não ficou valendo como atendida: agora o cliente é atendido DE VERDADE, antes da ponte.
    expect(atendimentosDoCliente()).toEqual([["atender", "cli-1"], ["atender", "cli-1"]]);
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "cli-1"]);
    expect(banco.tem("atendida")).toEqual([["atendida", "vc-1", ANA]]);
  });

  it("o Asterisk não atende na hora de segurar na linha e ninguém fica livre: a ligação esgota no teto, em vez de ficar parada para sempre", async () => {
    ari.falharAtender = 1;
    await entrar();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "fila_esgotada"]]);
    expect(ctl.ativas).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("o Asterisk não atende na hora de pôr o som de chamando: o ramal toca mesmo assim, e quem atende é atendido", async () => {
    banco.disponiveis = [
      { userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null },
      { userId: BIA, atendidasHoje: 1, ultimaAtendidaEm: null },
    ];
    ari.online.add(ANA).add(BIA);
    await entrar(); // 1ª volta: ANA toca, e o chamar é o da operadora (a ligação ainda não foi atendida)
    await destruir("ramal-canal-1", 19); // BIA toca
    ari.falharAtender = 1;
    await destruir("ramal-canal-2", 19); // 2ª volta: atende para chamar em banda — e o atender falha

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("o ramal toca mesmo assim"), expect.anything());
    expect(ari.originados()).toEqual([`PJSIP/ramal-${ANA}`, `PJSIP/ramal-${BIA}`, `PJSIP/ramal-${ANA}`]);
    expect(vi.getTimerCount()).toBe(1); // a rede de segurança do toque

    await ramalAtende(ari.ultimoOriginado());
    expect(atendimentosDoCliente()).toEqual([["atender", "cli-1"], ["atender", "cli-1"]]);
    expect(banco.tem("atendida")).toEqual([["atendida", "vc-1", ANA]]);
  });

  it("quem voltou do ramal digitado no menu e ainda ouve o aviso de instabilidade não conta como 'na frente': a mais nova toca o livre", async () => {
    const MENU = "66666666-6666-6666-6666-666666666666";
    const menu: MenuDoBanco = {
      id: MENU,
      nome: "Atendimento",
      defaultTeamId: TIME,
      timePadraoAtivo: true,
      fala: falaDe("menu", 4_000),
      falaInvalida: null,
      opcoes: [{ digito: "1", teamId: TIME }],
      aceitaRamal: true,
    };
    banco.troncoAtual = { ...tronco, teamId: null, menuId: MENU };
    banco.menus.set(MENU, menu);
    banco.ramais.set("201", ANA);
    ari.online.add(ANA).add(BIA);

    await entrar(); // o menu
    for (const digit of ["2", "0", "1", "#"]) await ctl.tratar({ type: "ChannelDtmfReceived", channel: cliente, digit });
    expect(ofertas()).toEqual([[`PJSIP/ramal-${ANA}`, "oferta,vc-1"]]); // o ramal digitado toca sozinho

    banco.aviso = falaDe("aviso", 10_000);
    await destruir("ramal-canal-1", 19); // não atendeu: a fila do time padrão — e o aviso de instabilidade toca INTEIRO
    expect(ari.falas().at(-1)).toBe("sound:/falas/aviso");

    // Enquanto a primeira ouve o aviso, chega outra (por um número do time, já sem aviso) e há UM livre.
    banco.troncoAtual = tronco;
    banco.aviso = null;
    banco.disponiveis = [{ userId: BIA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    await entrar2();
    expect(ofertas().at(-1)).toEqual([`PJSIP/ramal-${BIA}`, "oferta,vc-2"]);
    expect(ctl.ativas).toBe(2);
  });

  it("quem ouve o 'aguarde' está esperando de verdade — e segue contando como 'na frente'", async () => {
    banco.gerais = { aguarde: falaDe("aguarde", 60_000), ninguem: null, foraDoHorario: null };
    await entrar(); // t=0: ouve o "aguarde" (60 s) e reavalia em t=5, t=10
    await vi.advanceTimersByTimeAsync(2_000);
    await entrar2(); // t=2: idem, reavalia em t=7
    expect(ari.falas()).toEqual(["sound:/falas/aguarde", "sound:/falas/aguarde"]);
    await vi.advanceTimersByTimeAsync(4_500); // t=6,5
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await vi.advanceTimersByTimeAsync(1_000); // t=7,5: o relógio da SEGUNDA dispara — a primeira, ouvindo o "aguarde", está na frente
    expect(ofertas()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000); // t=10,5: o da PRIMEIRA dispara, e o livre é dela
    expect(ofertas()).toEqual([[`PJSIP/ramal-${ANA}`, "oferta,vc-1"]]);
  });

  it("o banco cai ao gravar a fila ou o prazo: a ligação segue e é atendida mesmo assim", async () => {
    banco.marcarNaFila = async () => {
      throw new Error("banco fora do ar");
    };
    banco.marcarPrazoDaFila = async () => {
      throw new Error("banco fora do ar");
    };
    await entrar();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("entrada na fila não gravada"), expect.anything());
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("prazo da fila não gravado"), expect.anything());
    // Sem o prazo gravado, a espera é a de sempre: música e o relógio de reavaliar.
    expect(musicas("cli-1")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA);
    await vi.advanceTimersByTimeAsync(5_000);
    await ramalAtende(ari.ultimoOriginado());
    expect(banco.tem("atendida")).toHaveLength(1);
  });
});
