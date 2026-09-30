/**
 * A TRANSFERÊNCIA DE LIGAÇÃO (v2) — todos os caminhos do desenho §12.2, com a
 * ARI e o banco de mentira (`dubles-de-teste.ts`). O controlador de verdade
 * roteia os eventos; o que se mede é o que o Asterisk recebeu e o que o banco
 * gravou.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ControladorDeChamadas } from "./controle";
import { ANA, AriFalso, BIA, BancoFalso, FalasFalsas, ORG, TIME, TRONCO, canal, falaDe } from "./dubles-de-teste";
import { EVENTO_DA_TRANSFERENCIA, lerOrdemDaTransferencia } from "./transferencia";

const CAIO = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OUTRO_TIME = "33333333-3333-3333-3333-333333333333";
const T1 = "7e000000-0000-4000-8000-000000000001";
const T2 = "7e000000-0000-4000-8000-000000000002";

const log = { info: () => undefined, warn: vi.fn(), error: vi.fn() };

let ari: AriFalso;
let banco: BancoFalso;
let falas: FalasFalsas;
let ctl: ControladorDeChamadas;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T13:00:00Z"));
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
const destruir = (id: string, cause = 16) => ctl.tratar({ type: "ChannelDestroyed", channel: canal(id, "x"), cause });
const atende = (canalId: string, papel: string, vcId = "vc-1") =>
  ctl.tratar({ type: "StasisStart", channel: canal(canalId, "PJSIP/ramal-x-00000009"), args: [papel, vcId] });
const ordem = (acao: string, transferencia_id = T1, voice_call_id = "vc-1") =>
  ctl.tratar({ type: "ChannelUserevent", eventname: EVENTO_DA_TRANSFERENCIA, userevent: { acao, transferencia_id, voice_call_id } });
const transferencia = (id = T1) => banco.transferencias.get(id)!;

/** A recebida atendida por ANA — `ramal-canal-1` é o canal dela, e `p-vc-1`, a ponte. */
async function recebidaComAna() {
  banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
  ari.online.add(ANA).add(BIA).add(CAIO);
  await ctl.tratar({ type: "StasisStart", channel: cliente, args: ["entrada"] });
  await atende("ramal-canal-1", "oferta");
  banco.disponiveis = [];
  expect(banco.tem("atendida")).toEqual([["atendida", "vc-1", ANA]]);
  ari.chamadas = [];
}

function pedir(p: { kind?: "blind" | "attended"; para?: { userId: string } | { teamId: string }; id?: string } = {}) {
  const para = p.para ?? { userId: BIA };
  banco.abrirTransferencia({
    id: p.id ?? T1,
    vcId: "vc-1",
    kind: p.kind ?? "blind",
    fromUserId: ANA,
    toUserId: "userId" in para ? para.userId : null,
    toTeamId: "teamId" in para ? para.teamId : null,
  });
}

describe("a ordem da tela", () => {
  it("lê só o evento da transferência, com ação conhecida e ids limpos", () => {
    const ok = { type: "ChannelUserevent", eventname: EVENTO_DA_TRANSFERENCIA, userevent: { acao: "transferir", transferencia_id: T1, voice_call_id: "vc-1" } };
    expect(lerOrdemDaTransferencia(ok)).toEqual({ acao: "transferir", transferenciaId: T1, voiceCallId: "vc-1" });
    expect(lerOrdemDaTransferencia({ ...ok, eventname: "outra" })).toBeNull();
    expect(lerOrdemDaTransferencia({ ...ok, userevent: { ...ok.userevent, acao: "sequestrar" } })).toBeNull();
    expect(lerOrdemDaTransferencia({ ...ok, userevent: { ...ok.userevent, transferencia_id: "x'; drop" } })).toBeNull();
    expect(lerOrdemDaTransferencia({ ...ok, userevent: { ...ok.userevent, voice_call_id: "../../etc" } })).toBeNull();
    expect(lerOrdemDaTransferencia({ ...ok, userevent: undefined })).toBeNull();
    expect(lerOrdemDaTransferencia({ type: "StasisStart", channel: cliente, args: [] })).toBeNull();
  });

  it("para uma ligação que o worker não acompanha: a transferência é recusada (não trava a próxima)", async () => {
    const vc = "0e000000-0000-4000-8000-00000000000f";
    banco.abrirTransferencia({ id: T1, vcId: vc, kind: "blind", fromUserId: ANA, toUserId: BIA, toTeamId: null });
    await ordem("transferir", T1, vc);
    expect(banco.tem("transferencia_orfa")).toEqual([["transferencia_orfa", T1, "ligacao_desconhecida"]]);
    expect(transferencia().desfecho).toBe("refused");
  });

  it("sem transferência aberta no banco, a ordem é ignorada (a variável é ponteiro, não autoridade)", async () => {
    await recebidaComAna();
    await ordem("transferir");
    expect(ari.chamadas).toEqual([]);
  });
});

describe("direta para pessoa", () => {
  it("B atende: música na ponte, A sai, B entra, a ligação e a conversa passam a B", async () => {
    await recebidaComAna();
    pedir();
    await ordem("transferir");

    expect(ari.chamadas.slice(0, 2)).toEqual([
      ["musicaNaPonte", "p-vc-1"],
      ["desligar", "ramal-canal-1", undefined],
    ]);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${BIA}`]);
    expect(ari.chamadas).toContainEqual(["originar", `PJSIP/ramal-${BIA}`, "transf,vc-1"]);
    expect(banco.tem("tocando_na_transferencia")).toEqual([["tocando_na_transferencia", "vc-1", BIA]]);

    // O fim do canal de A (que nós derrubamos) NÃO é o fim da ligação.
    await destruir("ramal-canal-1");
    expect(ctl.ativas).toBe(1);

    await atende("ramal-canal-2", "transf");
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "ramal-canal-2"]);
    expect(ari.chamadas).toContainEqual(["pararMusicaNaPonte", "p-vc-1"]);
    expect(banco.tem("passou")).toEqual([["passou", "vc-1", BIA]]);
    expect(banco.tem("atribuida")).toContainEqual(["atribuida", "conversa-1", BIA, "transfer"]);
    expect(transferencia()).toMatchObject({ status: "ended", desfecho: "answered", atendidaPor: BIA });
    expect(ctl.transferenciasEmCurso).toBe(0);

    // B desliga: a ligação acaba como atendida, sem "Ligar de volta".
    await destruir("ramal-canal-2");
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "atendente_desligou"]]);
    expect(banco.tem("registro")).toEqual([["registro", "vc-1", "atendida"]]);
    expect(banco.tem("perdida")).toEqual([]);
    expect(ctl.ativas).toBe(0);
  });

  it("B não atende: A toca de volta e, atendendo, o cliente volta para A (returned)", async () => {
    await recebidaComAna();
    pedir();
    await ordem("transferir");
    await destruir("ramal-canal-2", 19);
    expect(ari.chamadas).toContainEqual(["originar", `PJSIP/ramal-${ANA}`, "volta,vc-1"]);

    await atende("ramal-canal-3", "volta");
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "ramal-canal-3"]);
    expect(transferencia()).toMatchObject({ desfecho: "returned", atendidaPor: ANA });

    // O cliente desliga depois: ANA (o canal da volta) cai junto.
    await destruir("cli-1");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-3", undefined]);
    expect(banco.tem("registro")).toEqual([["registro", "vc-1", "atendida"]]);
  });

  it("B não atende e A já pegou outra ligação: não toca em A, vai direto à fila", async () => {
    await recebidaComAna();
    pedir();
    await ordem("transferir");
    banco.ocupados.add(ANA);
    await destruir("ramal-canal-2", 19);
    expect(ari.originados().filter((e) => e === `PJSIP/ramal-${ANA}`)).toEqual([]);
    expect(banco.tem("movida_para_o_time")).toHaveLength(1);
  });

  it("nem B nem A: a fila do time, com A fora do rodízio; C atende (queue_answered)", async () => {
    await recebidaComAna();
    pedir();
    await ordem("transferir");
    await destruir("ramal-canal-2", 19); // B não atendeu
    banco.disponiveis = [
      { userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null },
      { userId: CAIO, atendidasHoje: 3, ultimaAtendidaEm: null },
    ];
    await destruir("ramal-canal-3", 19); // A não atendeu a volta

    expect(banco.tem("movida_para_o_time")).toEqual([["movida_para_o_time", "vc-1", "conversa-1", TIME]]);
    // ANA atendeu menos hoje, mas quem transferiu fica fora do rodízio.
    expect(ari.chamadas).toContainEqual(["originar", `PJSIP/ramal-${CAIO}`, "fila,vc-1"]);
    expect(ari.originados().filter((e) => e === `PJSIP/ramal-${ANA}`)).toHaveLength(1); // só a volta

    await atende("ramal-canal-4", "fila");
    expect(transferencia()).toMatchObject({ desfecho: "queue_answered", atendidaPor: CAIO });
    expect(banco.tem("passou")).toEqual([["passou", "vc-1", CAIO]]);
  });

  it("ninguém pega na fila: 'ninguém atendeu' e a ligação acaba com 'Ligar de volta' (atendida no registro)", async () => {
    banco.gerais = { aguarde: null, ninguem: falaDe("ninguem", 2_000), foraDoHorario: null };
    await recebidaComAna();
    pedir();
    await ordem("transferir");
    await destruir("ramal-canal-2", 19);
    await destruir("ramal-canal-3", 19);
    // Ninguém livre: a fila espera 2 min, reavaliando a cada 5 s — só música, sem "aguarde".
    expect(ari.falas()).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(transferencia()).toMatchObject({ desfecho: "missed" });
    expect(ari.chamadas).toContainEqual(["pararMusicaNaPonte", "p-vc-1"]);
    expect(ari.falas()).toEqual(["sound:/falas/ninguem"]);
    await ctl.tratar({
      type: "PlaybackFinished",
      playback: { id: ari.ultimaFala(), media_uri: "", target_uri: "channel:cli-1", language: "pt", state: "done" },
    });
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "transferencia_nao_atendida"]]);
    expect(banco.tem("registro")).toEqual([["registro", "vc-1", "atendida"]]);
    expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
    expect(banco.perdidas[0]!.team_id).toBe(TIME);
    expect(ctl.ativas).toBe(0);
  });

  it("sem a fala 'ninguém atendeu', desliga direto — e o PlaybackFinished perdido não trava (relógio)", async () => {
    await recebidaComAna();
    pedir({ para: { teamId: OUTRO_TIME } });
    await ordem("transferir");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "transferencia_nao_atendida"]]);
    expect(banco.tem("perdida")).toEqual([["perdida", "vc-1"]]);
  });

  it("o Asterisk não derruba o toque no prazo: derrubamos (rede de segurança)", async () => {
    await recebidaComAna();
    pedir();
    await ordem("transferir");
    await vi.advanceTimersByTimeAsync(23_000);
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-2", "no_answer"]);
  });

  it("atendimento tardio de um toque que já passou é largado", async () => {
    await recebidaComAna();
    pedir();
    await ordem("transferir");
    await destruir("ramal-canal-2", 19);
    await atende("ramal-canal-2", "transf");
    expect(ari.chamadas.filter((c) => c[0] === "desligar" && c[1] === "ramal-canal-2")).toHaveLength(1);
    expect(transferencia().status).toBe("open");
  });
});

describe("direta para time", () => {
  it("a ligação e a conversa vão para o time, e a fila toca quem está livre", async () => {
    await recebidaComAna();
    banco.disponiveis = [{ userId: CAIO, atendidasHoje: 0, ultimaAtendidaEm: null }];
    pedir({ para: { teamId: OUTRO_TIME } });
    await ordem("transferir");
    expect(banco.tem("movida_para_o_time")).toEqual([["movida_para_o_time", "vc-1", "conversa-1", OUTRO_TIME]]);
    expect(ari.chamadas).toContainEqual(["originar", `PJSIP/ramal-${CAIO}`, "fila,vc-1"]);
    await atende("ramal-canal-2", "fila");
    expect(transferencia()).toMatchObject({ desfecho: "queue_answered", atendidaPor: CAIO });
  });

  it("duas voltas pelo time sem ninguém pegar: missed", async () => {
    await recebidaComAna();
    banco.disponiveis = [{ userId: CAIO, atendidasHoje: 0, ultimaAtendidaEm: null }];
    pedir({ para: { teamId: OUTRO_TIME } });
    await ordem("transferir");
    await destruir("ramal-canal-2", 19);
    await destruir("ramal-canal-3", 19);
    expect(ari.originados()).toEqual([`PJSIP/ramal-${CAIO}`, `PJSIP/ramal-${CAIO}`]);
    expect(transferencia()).toMatchObject({ desfecho: "missed", motivo: "ninguem_atendeu" });
  });
});

describe("consultada", () => {
  async function consultaAtendida() {
    await recebidaComAna();
    pedir({ kind: "attended" });
    await ordem("transferir");
    await atende("ramal-canal-2", "consulta");
  }

  it("A vai para a ponte de consulta ouvindo o chamar; B atende e os dois conversam", async () => {
    await recebidaComAna();
    pedir({ kind: "attended" });
    await ordem("transferir");
    expect(ari.chamadas.slice(0, 5)).toEqual([
      ["musicaNaPonte", "p-vc-1"],
      ["tirarDaPonte", "p-vc-1", "ramal-canal-1"],
      ["criarPonte", "k-vc-1"],
      ["porNaPonte", "k-vc-1", "ramal-canal-1"],
      ["tocarTom", "ramal-canal-1", "ring"],
    ]);
    expect(ari.nomes()).not.toContain("desligar");
    expect(ari.chamadas).toContainEqual(["originar", `PJSIP/ramal-${BIA}`, "consulta,vc-1"]);

    await atende("ramal-canal-2", "consulta");
    expect(ari.chamadas).toContainEqual(["pararReproducao", "tom-1"]);
    expect(ari.chamadas).toContainEqual(["porNaPonte", "k-vc-1", "ramal-canal-2"]);
    expect(transferencia().status).toBe("open");
  });

  it("completar: B vai para o cliente e A é desligado", async () => {
    await consultaAtendida();
    await ordem("completar");
    expect(ari.chamadas).toContainEqual(["destruirPonte", "k-vc-1"]);
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "ramal-canal-2"]);
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-1", undefined]);
    expect(transferencia()).toMatchObject({ desfecho: "answered", atendidaPor: BIA });
    // O fim do canal de A não derruba a ligação; o de B, sim.
    await destruir("ramal-canal-1");
    expect(ctl.ativas).toBe(1);
    await destruir("ramal-canal-2");
    expect(ctl.ativas).toBe(0);
  });

  it("completar antes de B atender é ignorado", async () => {
    await recebidaComAna();
    pedir({ kind: "attended" });
    await ordem("transferir");
    await ordem("completar");
    expect(transferencia().status).toBe("open");
    expect(ari.nomes()).not.toContain("desligar");
  });

  it("voltar ao cliente: B sai, A volta à ponte do cliente e a música para (cancelled)", async () => {
    await consultaAtendida();
    await ordem("voltar");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-2", undefined]);
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "ramal-canal-1"]);
    expect(ari.chamadas).toContainEqual(["pararMusicaNaPonte", "p-vc-1"]);
    expect(transferencia()).toMatchObject({ desfecho: "cancelled", motivo: "voltou_ao_cliente", atendidaPor: ANA });
    // A segue com o cliente: o fim do canal dele é o fim da ligação.
    await destruir("ramal-canal-1");
    expect(banco.tem("encerrada")).toEqual([["encerrada", "vc-1", "atendente_desligou"]]);
  });

  it("B não atende: A volta sozinho ao cliente (returned)", async () => {
    await recebidaComAna();
    pedir({ kind: "attended" });
    await ordem("transferir");
    await destruir("ramal-canal-2", 19);
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "ramal-canal-1"]);
    expect(transferencia()).toMatchObject({ desfecho: "returned", motivo: "destino_nao_atendeu" });
  });

  it("A desliga com B na linha: completa", async () => {
    await consultaAtendida();
    await destruir("ramal-canal-1");
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "ramal-canal-2"]);
    expect(transferencia()).toMatchObject({ desfecho: "answered", atendidaPor: BIA });
    expect(ctl.ativas).toBe(1);
  });

  it("A desliga com B ainda tocando: vira direta — B atendendo vai direto ao cliente", async () => {
    await recebidaComAna();
    pedir({ kind: "attended" });
    await ordem("transferir");
    await destruir("ramal-canal-1");
    expect(ctl.ativas).toBe(1);
    await atende("ramal-canal-2", "consulta");
    expect(ari.chamadas).toContainEqual(["porNaPonte", "p-vc-1", "ramal-canal-2"]);
    expect(ari.chamadas).not.toContainEqual(["porNaPonte", "k-vc-1", "ramal-canal-2"]);
    expect(transferencia()).toMatchObject({ desfecho: "answered", atendidaPor: BIA });
  });

  it("A desliga com B tocando e B não atende: A toca de volta, como na direta", async () => {
    await recebidaComAna();
    pedir({ kind: "attended" });
    await ordem("transferir");
    await destruir("ramal-canal-1");
    await destruir("ramal-canal-2", 19);
    expect(ari.chamadas).toContainEqual(["originar", `PJSIP/ramal-${ANA}`, "volta,vc-1"]);
  });
});

describe("o cliente desliga no meio", () => {
  it("direta tocando: o ramal de B cai e a transferência fecha cancelled", async () => {
    await recebidaComAna();
    pedir();
    await ordem("transferir");
    await destruir("cli-1");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-2", undefined]);
    expect(transferencia()).toMatchObject({ desfecho: "cancelled", motivo: "cliente_desligou" });
    expect(ctl.ativas).toBe(0);
    expect(ctl.transferenciasEmCurso).toBe(0);
  });

  it("consulta falando: A e B caem, a ponte de consulta é destruída", async () => {
    await recebidaComAna();
    pedir({ kind: "attended" });
    await ordem("transferir");
    await atende("ramal-canal-2", "consulta");
    await destruir("cli-1");
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-2", undefined]);
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-canal-1", undefined]);
    expect(ari.chamadas).toContainEqual(["destruirPonte", "k-vc-1"]);
    expect(transferencia()).toMatchObject({ desfecho: "cancelled" });
  });
});

describe("revalidação no worker (refused)", () => {
  it("destino offline", async () => {
    await recebidaComAna();
    ari.online.delete(BIA);
    pedir();
    await ordem("transferir");
    expect(transferencia()).toMatchObject({ desfecho: "refused", motivo: "destino_offline" });
    expect(ari.chamadas).toEqual([]);
  });

  it("destino em outra ligação", async () => {
    await recebidaComAna();
    banco.ocupados.add(BIA);
    pedir();
    await ordem("transferir");
    expect(transferencia()).toMatchObject({ desfecho: "refused", motivo: "destino_em_ligacao" });
  });

  it("ligação ainda não atendida", async () => {
    banco.disponiveis = [{ userId: ANA, atendidasHoje: 0, ultimaAtendidaEm: null }];
    ari.online.add(ANA).add(BIA);
    await ctl.tratar({ type: "StasisStart", channel: cliente, args: ["entrada"] });
    pedir();
    await ordem("transferir");
    expect(transferencia()).toMatchObject({ desfecho: "refused", motivo: "ligacao_nao_atendida" });
  });

  it("quem pediu já não está com a ligação", async () => {
    await recebidaComAna();
    banco.abrirTransferencia({ id: T1, vcId: "vc-1", kind: "blind", fromUserId: CAIO, toUserId: BIA, toTeamId: null });
    await ordem("transferir");
    expect(transferencia()).toMatchObject({ desfecho: "refused", motivo: "dono_mudou" });
  });

  it("uma por vez: a segunda, com a primeira acontecendo, é recusada", async () => {
    await recebidaComAna();
    pedir();
    await ordem("transferir");
    pedir({ id: T2, para: { userId: CAIO } });
    await ordem("transferir", T2);
    expect(transferencia(T2)).toMatchObject({ desfecho: "refused" });
    expect(transferencia(T1).status).toBe("open");
  });
});

describe("ligação feita", () => {
  it("a feita atendida também é transferida: B fica com o cliente da operadora", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    ari.online.add(BIA);
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
      channel: canal("ramal-a", `PJSIP/ramal-${ANA}-0000000a`, { dialplan: { context: "de-ramal", exten: `c-${id}`, priority: 1 } }),
      args: ["saida"],
    });
    const perna = ari.chamadas.find((c) => c[0] === "discar")![1] as string;
    await ctl.tratar({ type: "Dial", peer: canal(perna, "PJSIP/tronco-x-00000002"), dialstatus: "ANSWER" });
    ari.chamadas = [];

    banco.abrirTransferencia({ id: T1, vcId: id, kind: "blind", fromUserId: ANA, toUserId: BIA, toTeamId: null });
    await ordem("transferir", T1, id);
    expect(ari.chamadas).toContainEqual(["musicaNaPonte", `p-${id}`]);
    expect(ari.chamadas).toContainEqual(["desligar", "ramal-a", undefined]);
    // O contador de canais do dublê é o mesmo da perna (`perna-1`): o ramal de B é o 2º canal.
    const canalDeBia = "ramal-canal-2";
    await destruir("ramal-a");
    expect(ctl.ativas).toBe(1);

    await atende(canalDeBia, "transf", id);
    expect(ari.chamadas).toContainEqual(["porNaPonte", `p-${id}`, canalDeBia]);
    expect(transferencia()).toMatchObject({ desfecho: "answered", atendidaPor: BIA });

    await destruir(perna);
    expect(ari.chamadas).toContainEqual(["desligar", canalDeBia, undefined]);
    expect(banco.tem("registro")).toEqual([["registro", id, "atendida"]]);
  });
});

describe("reinício do worker", () => {
  it("recuperar() cancela as transferências abertas", async () => {
    banco.abrirTransferencia({ id: T1, vcId: "vc-9", kind: "blind", fromUserId: ANA, toUserId: BIA, toTeamId: null });
    await ctl.recuperar();
    expect(transferencia()).toMatchObject({ status: "ended", desfecho: "cancelled", motivo: "worker_reiniciou" });
  });
});
