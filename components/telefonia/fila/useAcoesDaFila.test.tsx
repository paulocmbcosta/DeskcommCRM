/**
 * AGIR NA FILA — o pedido de atender e o de mover, e o ACOMPANHAMENTO da ordem.
 *
 * A rota só aceita o pedido (202); quem age é o worker, e o desfecho volta por
 * `GET /api/v1/telefonia/fila/ordens/{id}`. O que se mede aqui é o que a pessoa
 * fica sabendo depois do clique:
 *
 *  - a ordem é lida a cada 1 s, por até 15 s, até constar como encerrada;
 *  - o que não deu certo vira um aviso com a frase do motivo — e o que deu certo
 *    no mover, a confirmação com o nome do time;
 *  - enquanto o pedido DESTE navegador corre, a ligação fica marcada (é o que
 *    deixa o botão ocupado), e um segundo clique não vira um segundo pedido;
 *  - a fila é relida quando o pedido é aceito e quando a ordem acaba.
 *
 * O relógio é simulado inteiro (`setTimeout` e `Date`): a espera entre as
 * leituras anda por `advanceTimersByTimeAsync`, sem esperar de verdade.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
const avisos = vi.hoisted(() => ({ erro: vi.fn(), sucesso: vi.fn(), showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: avisos.erro, success: avisos.sucesso } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: avisos.showApiError }));
const telefone = vi.hoisted(() => ({ atenderDaFila: vi.fn() }));
vi.mock("@/components/telefonia/TelefoniaContext", () => ({
  useTelefonia: () => ({ atenderDaFila: telefone.atenderDaFila }),
}));
const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: api.post, get: api.get } }));

import { useAcoesDaFila } from "./useAcoesDaFila";

const LIGACAO = "0a0a0a0a-0000-4000-8000-00000000000a";
const OUTRA_LIGACAO = "0a0a0a0a-0000-4000-8000-00000000000f";
const ORDEM = "0b0b0b0b-0000-4000-8000-00000000000b";
const SUPORTE = { id: "0d0d0d0d-0000-4000-8000-00000000000d", nome: "Suporte" };
const URL_DA_ORDEM = `/api/v1/telefonia/fila/ordens/${ORDEM}`;

type Ordem = { id: string; tipo: "pull" | "move"; situacao: "open" | "ended"; desfecho: string | null; motivo: string | null };
const aberta = (tipo: Ordem["tipo"] = "pull"): Ordem => ({ id: ORDEM, tipo, situacao: "open", desfecho: null, motivo: null });
const encerrada = (desfecho: string | null, motivo: string | null = null, tipo: Ordem["tipo"] = "pull"): Ordem => ({
  id: ORDEM,
  tipo,
  situacao: "ended",
  desfecho,
  motivo,
});

/** O que a leitura da ordem devolve, em sequência; a última resposta se repete. */
function ordemResponde(...respostas: Array<Ordem | Error>) {
  let i = 0;
  api.get.mockImplementation(async (url: string) => {
    if (url !== URL_DA_ORDEM) throw new Error(`GET inesperado ${url}`);
    const r = respostas[Math.min(i, respostas.length - 1)]!;
    i += 1;
    if (r instanceof Error) throw r;
    return { data: r };
  });
}

function montar() {
  const reler = vi.fn();
  const hook = renderHook(() => useAcoesDaFila({ reler }));
  return { reler, hook, atual: () => hook.result.current };
}

/** Deixa as promessas pendentes andarem, sem andar o relógio. */
const assentar = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const passar = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  telefone.atenderDaFila.mockResolvedValue(ORDEM);
  api.post.mockImplementation(async (url: string) => {
    if (url === `/api/v1/telefonia/chamadas/${LIGACAO}/mover`) return { data: { ordem_id: ORDEM } };
    throw new Error(`POST inesperado ${url}`);
  });
  ordemResponde(aberta());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("atender", () => {
  it("pede pelo telefone deste navegador, marca a ligação enquanto corre e solta quando a ordem acaba", async () => {
    ordemResponde(aberta(), encerrada("done"));
    const { atual, reler } = montar();
    expect(atual().emCurso).toEqual({});
    expect(atual().puxando).toBe(false);

    act(() => void atual().atender(LIGACAO));
    // Marcada NA HORA do clique, antes de a rota responder.
    expect(atual().emCurso).toEqual({ [LIGACAO]: "atender" });
    expect(atual().puxando).toBe(true);
    await assentar();
    expect(telefone.atenderDaFila).toHaveBeenCalledWith(LIGACAO);
    // Aceito: a fila é relida (a linha passa a dizer quem está atendendo).
    expect(reler).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();

    await passar(1_000);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(URL_DA_ORDEM);
    expect(atual().emCurso).toEqual({ [LIGACAO]: "atender" });

    await passar(1_000);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(atual().emCurso).toEqual({});
    expect(atual().puxando).toBe(false);
    expect(reler).toHaveBeenCalledTimes(2);
    // Deu certo: a ligação conectou, e o painel do telefone é quem mostra. Sem aviso.
    expect(avisos.erro).not.toHaveBeenCalled();
    expect(avisos.sucesso).not.toHaveBeenCalled();

    // Acabou: nenhuma leitura a mais.
    await passar(5_000);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("a rota recusou (o aviso já saiu pelo telefone): nada a acompanhar, e a ligação é solta", async () => {
    telefone.atenderDaFila.mockResolvedValue(null);
    const { atual, reler } = montar();
    act(() => void atual().atender(LIGACAO));
    await assentar();
    expect(atual().emCurso).toEqual({});
    expect(atual().puxando).toBe(false);
    await passar(3_000);
    expect(api.get).not.toHaveBeenCalled();
    expect(avisos.erro).not.toHaveBeenCalled();
    // A recusa costuma ser porque a fila mudou (alguém atendeu antes): a tela relê.
    expect(reler).toHaveBeenCalledTimes(1);
  });

  it("o telefone não atendeu: avisa que a ligação voltou para a fila", async () => {
    ordemResponde(encerrada("no_answer"));
    const { atual } = montar();
    act(() => void atual().atender(LIGACAO));
    await passar(1_000);
    expect(avisos.erro).toHaveBeenCalledTimes(1);
    expect(avisos.erro).toHaveBeenCalledWith("Seu telefone não atendeu. A ligação voltou para a fila.");
    expect(atual().emCurso).toEqual({});
  });

  it.each([
    ["refused", "destino_offline", "Seu telefone não está conectado."],
    ["refused", "destino_em_ligacao", "Você está em outra ligação."],
    ["cancelled", "ligacao_encerrada", "A ligação acabou antes."],
    ["refused", "ligacao_ja_atendida", "Outra pessoa atendeu antes."],
    ["refused", "ja_ha_ordem", "Outra pessoa já está cuidando desta ligação."],
    ["refused", "time_fora_do_horario", "O time está fora do horário de atendimento."],
    ["refused", "motivo_que_a_tela_nao_conhece", "Não foi possível concluir. Tente de novo."],
    ["refused", null, "Não foi possível concluir. Tente de novo."],
    ["cancelled", "worker_reiniciou", "Não foi possível concluir. Tente de novo."],
    // Um desfecho que a tela não conhece (worker mais novo) não é sucesso.
    ["outro_desfecho", null, "Não foi possível concluir. Tente de novo."],
    [null, null, "Não foi possível concluir. Tente de novo."],
    // O motivo é texto do banco: nome de propriedade herdada não vira frase.
    ["refused", "toString", "Não foi possível concluir. Tente de novo."],
  ] as Array<[string | null, string | null, string]>)("a ordem acabou em %s/%s: '%s'", async (desfecho, motivo, frase) => {
    ordemResponde(encerrada(desfecho, motivo));
    const { atual } = montar();
    act(() => void atual().atender(LIGACAO));
    await passar(1_000);
    expect(avisos.erro).toHaveBeenCalledTimes(1);
    expect(avisos.erro).toHaveBeenCalledWith(frase);
    expect(avisos.sucesso).not.toHaveBeenCalled();
  });
});

describe("o acompanhamento da ordem", () => {
  it("lê a cada 1 s, por até 15 s — e desiste em silêncio, soltando a ligação e relendo a fila", async () => {
    ordemResponde(aberta());
    const { atual, reler } = montar();
    act(() => void atual().atender(LIGACAO));
    await assentar();

    await passar(999);
    expect(api.get).toHaveBeenCalledTimes(0);
    await passar(1);
    expect(api.get).toHaveBeenCalledTimes(1);
    await passar(13_000);
    expect(api.get).toHaveBeenCalledTimes(14);
    expect(atual().emCurso).toEqual({ [LIGACAO]: "atender" });

    await passar(1_000);
    expect(api.get).toHaveBeenCalledTimes(15);
    expect(atual().emCurso).toEqual({});
    // Não se sabe o que houve: a tela não afirma nada — a fila relida é quem diz.
    expect(avisos.erro).not.toHaveBeenCalled();
    expect(reler).toHaveBeenCalledTimes(2);

    await passar(10_000);
    expect(api.get).toHaveBeenCalledTimes(15);
  });

  it("a leitura que falha não encerra o acompanhamento: a seguinte tenta de novo", async () => {
    ordemResponde(new Error("502"), new Error("rede"), encerrada("no_answer"));
    const { atual } = montar();
    act(() => void atual().atender(LIGACAO));
    await passar(2_000);
    expect(avisos.erro).not.toHaveBeenCalled();
    expect(atual().emCurso).toEqual({ [LIGACAO]: "atender" });
    await passar(1_000);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(avisos.erro).toHaveBeenCalledWith("Seu telefone não atendeu. A ligação voltou para a fila.");
  });

  it("a tela que saiu no meio (outra aba do Inbox) ainda avisa o que houve", async () => {
    ordemResponde(aberta(), encerrada("no_answer"));
    const { atual, hook } = montar();
    act(() => void atual().atender(LIGACAO));
    await passar(1_000);
    hook.unmount();
    await passar(1_000);
    expect(avisos.erro).toHaveBeenCalledWith("Seu telefone não atendeu. A ligação voltou para a fila.");
  });
});

describe("mover", () => {
  it("pede à rota de mover DA LIGAÇÃO, com o time; deu certo → confirma com o nome do time", async () => {
    ordemResponde(aberta("move"), encerrada("done", null, "move"));
    const { atual, reler } = montar();
    act(() => void atual().mover(LIGACAO, SUPORTE));
    expect(atual().emCurso).toEqual({ [LIGACAO]: "mover" });
    // Mover não ocupa o telefone de quem pediu.
    expect(atual().puxando).toBe(false);
    await assentar();
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith(`/api/v1/telefonia/chamadas/${LIGACAO}/mover`, { team_id: SUPORTE.id });
    expect(telefone.atenderDaFila).not.toHaveBeenCalled();
    expect(reler).toHaveBeenCalledTimes(1);

    await passar(2_000);
    expect(avisos.sucesso).toHaveBeenCalledTimes(1);
    expect(avisos.sucesso).toHaveBeenCalledWith("Ligação movida para Suporte.");
    expect(avisos.erro).not.toHaveBeenCalled();
    expect(atual().emCurso).toEqual({});
    expect(reler).toHaveBeenCalledTimes(2);
  });

  it("o nome do time sai como está cadastrado: `$&` e marcador no nome não viram outra coisa", async () => {
    ordemResponde(encerrada("done", null, "move"));
    const { atual } = montar();
    act(() => void atual().mover(LIGACAO, { id: SUPORTE.id, nome: "N2 $& {time}" }));
    await passar(1_000);
    expect(avisos.sucesso).toHaveBeenCalledWith("Ligação movida para N2 $& {time}.");
  });

  it("a rota recusou: o aviso é o da rota, e nada é acompanhado", async () => {
    const recusa = new Error("O time está fora do horário de atendimento.");
    api.post.mockRejectedValue(recusa);
    const { atual, reler } = montar();
    act(() => void atual().mover(LIGACAO, SUPORTE));
    await assentar();
    expect(avisos.showApiError).toHaveBeenCalledWith(recusa);
    expect(atual().emCurso).toEqual({});
    await passar(3_000);
    expect(api.get).not.toHaveBeenCalled();
    expect(avisos.sucesso).not.toHaveBeenCalled();
    expect(reler).toHaveBeenCalledTimes(1);
  });

  it("o worker recusou depois (o time fechou no meio): avisa o motivo, sem confirmar", async () => {
    ordemResponde(encerrada("refused", "time_fora_do_horario", "move"));
    const { atual } = montar();
    act(() => void atual().mover(LIGACAO, SUPORTE));
    await passar(1_000);
    expect(avisos.erro).toHaveBeenCalledWith("O time está fora do horário de atendimento.");
    expect(avisos.sucesso).not.toHaveBeenCalled();
  });

  it("sem resposta em 15 s: não confirma o que não sabe", async () => {
    ordemResponde(aberta("move"));
    const { atual } = montar();
    act(() => void atual().mover(LIGACAO, SUPORTE));
    await passar(16_000);
    expect(avisos.sucesso).not.toHaveBeenCalled();
    expect(avisos.erro).not.toHaveBeenCalled();
    expect(atual().emCurso).toEqual({});
  });
});

describe("um clique, um pedido", () => {
  it("o segundo Atender na MESMA ligação, com o primeiro em curso, não vira outro pedido", async () => {
    const { atual } = montar();
    act(() => void atual().atender(LIGACAO));
    act(() => void atual().atender(LIGACAO));
    await assentar();
    act(() => void atual().atender(LIGACAO));
    await assentar();
    expect(telefone.atenderDaFila).toHaveBeenCalledTimes(1);
  });

  it("só se puxa UMA ligação por vez: Atender em outra, com um em curso, não pede nada", async () => {
    const { atual } = montar();
    act(() => void atual().atender(LIGACAO));
    await assentar();
    act(() => void atual().atender(OUTRA_LIGACAO));
    await assentar();
    expect(telefone.atenderDaFila).toHaveBeenCalledTimes(1);
    expect(atual().emCurso).toEqual({ [LIGACAO]: "atender" });
  });

  it("depois que o primeiro acaba, dá para atender outra", async () => {
    ordemResponde(encerrada("no_answer"));
    const { atual } = montar();
    act(() => void atual().atender(LIGACAO));
    await passar(1_000);
    expect(atual().puxando).toBe(false);
    act(() => void atual().atender(OUTRA_LIGACAO));
    await assentar();
    expect(telefone.atenderDaFila).toHaveBeenCalledTimes(2);
    expect(telefone.atenderDaFila).toHaveBeenLastCalledWith(OUTRA_LIGACAO);
  });

  it("Mover numa ligação que eu estou atendendo (ou movendo) não pede nada", async () => {
    const { atual } = montar();
    act(() => void atual().atender(LIGACAO));
    await assentar();
    act(() => void atual().mover(LIGACAO, SUPORTE));
    await assentar();
    expect(api.post).not.toHaveBeenCalled();
    expect(atual().emCurso).toEqual({ [LIGACAO]: "atender" });
  });

  it("Mover OUTRA ligação com um Atender em curso é outro pedido, e sai", async () => {
    api.post.mockResolvedValue({ data: { ordem_id: ORDEM } });
    const { atual } = montar();
    act(() => void atual().atender(LIGACAO));
    await assentar();
    act(() => void atual().mover(OUTRA_LIGACAO, SUPORTE));
    await assentar();
    expect(api.post).toHaveBeenCalledWith(`/api/v1/telefonia/chamadas/${OUTRA_LIGACAO}/mover`, { team_id: SUPORTE.id });
    expect(atual().emCurso).toEqual({ [LIGACAO]: "atender", [OUTRA_LIGACAO]: "mover" });
    expect(atual().puxando).toBe(true);
  });
});
