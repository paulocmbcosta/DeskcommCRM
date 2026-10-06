import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpcoesDeEncerramento } from "@/lib/atendimento/encerramento";

import { EncerrarAtendimentoDialog, setorInicial, type AtendimentoAEncerrar } from "./EncerrarAtendimentoDialog";

/**
 * A JANELA DE ENCERRAMENTO (migration 0293).
 *
 * O que se mede aqui é o que a janela DECIDE sozinha: em que setor abre, o que
 * cobra antes de mandar, o que manda, e onde mostra a recusa do servidor. A
 * regra de verdade é do banco (`tests/invariants/encerramento-com-assunto-e-resumo`).
 *
 * A troca de setor pelo seletor fica com o e2e: o `Select` do Radix não abre de
 * forma confiável no jsdom, e um teste que finge o clique mediria o mock.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const mutate = vi.fn();
let enviando = false;
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate, isPending: enviando }),
  recusaDoServidor: (err: unknown) => (err as { recusa?: unknown } | null)?.recusa ?? null,
}));

let opcoes: OpcoesDeEncerramento | undefined;
/** O estado da consulta de assuntos, como o react-query o entrega. */
let consulta = { isLoading: false, isError: false, errorUpdateCount: 0 };
const pediuOpcoes = vi.fn();
const recarregar = vi.fn();
vi.mock("@/hooks/inbox/useOpcoesDeEncerramento", () => ({
  useOpcoesDeEncerramento: (enabled: boolean) => {
    pediuOpcoes(enabled);
    return { data: opcoes, ...consulta, refetch: recarregar };
  },
}));

const TIMES: OpcoesDeEncerramento["times"] = [
  { id: "t-cob", name: "Cobrança", assuntos: [{ id: "a-bol", name: "Boleto" }] },
  {
    id: "t-sup",
    name: "Suporte",
    assuntos: [
      { id: "a-wifi", name: "Wi-Fi" },
      { id: "a-len", name: "Lentidão" },
    ],
  },
];

const PROTOCOLO = "20261005000061";

function abrir(
  atendimento: AtendimentoAEncerrar | null,
  regra: Partial<OpcoesDeEncerramento> = {},
  extra: { grupo?: boolean; anonimizado?: boolean; protocoloAtual?: string | null; jaEncerrada?: boolean } = {},
) {
  opcoes = { exigir_assunto: false, exigir_resumo: false, times: TIMES, ...regra };
  const onOpenChange = vi.fn();
  render(
    <EncerrarAtendimentoDialog
      conversationId="conv-1"
      expectedRevision={7}
      contato="Maria Souza"
      protocolo={PROTOCOLO}
      protocoloAtual={extra.protocoloAtual === undefined ? PROTOCOLO : extra.protocoloAtual}
      jaEncerrada={extra.jaEncerrada ?? false}
      atendimento={atendimento}
      grupo={extra.grupo ?? false}
      anonimizado={extra.anonimizado ?? false}
      open
      onOpenChange={onOpenChange}
    />,
  );
  return { onOpenChange };
}

const semRegistro = (team_id: string | null): AtendimentoAEncerrar => ({ team_id, assunto: null, closure_summary: null });
const confirmar = () => userEvent.click(screen.getByTestId("encerramento-confirmar"));

afterEach(() => {
  cleanup();
  mutate.mockReset();
  pediuOpcoes.mockReset();
  recarregar.mockReset();
  enviando = false;
  consulta = { isLoading: false, isError: false, errorUpdateCount: 0 };
});

describe("setorInicial", () => {
  it("abre no setor do assunto já registrado, mesmo que o atendimento seja de outro time", () => {
    expect(
      setorInicial(TIMES, { team_id: "t-cob", assunto: { id: "a-wifi", nome: "Wi-Fi", time: "Suporte" }, closure_summary: null }),
    ).toBe("t-sup");
  });

  it("sem registro, abre no time do atendimento quando ele tem assuntos", () => {
    expect(setorInicial(TIMES, semRegistro("t-cob"))).toBe("t-cob");
  });

  it("atendimento sem time, ou de time sem assunto cadastrado, abre sem setor — a pessoa escolhe", () => {
    expect(setorInicial(TIMES, semRegistro(null))).toBe("");
    expect(setorInicial(TIMES, semRegistro("t-sem-assunto"))).toBe("");
    expect(setorInicial(TIMES, null)).toBe("");
  });

  it("um setor só: já vem escolhido", () => {
    expect(setorInicial([TIMES[0]!], semRegistro(null))).toBe("t-cob");
  });
});

describe("a janela de encerramento", () => {
  it("diz de quem é e qual é o protocolo", () => {
    abrir(semRegistro("t-sup"));
    expect(screen.getByText(/Maria Souza/)).toBeTruthy();
    expect(screen.getByText("20261005000061")).toBeTruthy();
  });

  it("mostra os assuntos do setor do atendimento, e não os dos outros", () => {
    abrir(semRegistro("t-sup"));
    expect(screen.getAllByTestId("encerramento-assunto").map((b) => b.textContent)).toEqual(["Wi-Fi", "Lentidão"]);
  });

  it("interruptores desligados: fecha em branco, mandando nulo nos dois campos", async () => {
    abrir(semRegistro("t-sup"));
    await confirmar();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toEqual({
      conversation_id: "conv-1",
      expected_revision: 7,
      assunto_id: null,
      resumo: null,
    });
  });

  it("os dois exigidos e em branco: marca os dois campos e NÃO manda nada", async () => {
    abrir(semRegistro("t-sup"), { exigir_assunto: true, exigir_resumo: true });
    await confirmar();
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("encerramento-erro-assunto").textContent).toBe("Escolha o assunto do atendimento.");
    expect(screen.getByTestId("encerramento-erro-resumo").textContent).toBe(
      "Escreva o que foi tratado (mínimo de 10 letras).",
    );
  });

  it("escolher o assunto e escrever o resumo apaga os avisos e manda o registro, sem espaço nas pontas", async () => {
    abrir(semRegistro("t-sup"), { exigir_assunto: true, exigir_resumo: true });
    await confirmar();
    await userEvent.click(screen.getByRole("radio", { name: "Wi-Fi" }));
    expect(screen.queryByTestId("encerramento-erro-assunto")).toBeNull();
    await userEvent.type(screen.getByTestId("encerramento-resumo"), "  Trocou a senha do Wi-Fi.  ");
    expect(screen.queryByTestId("encerramento-erro-resumo")).toBeNull();
    await confirmar();
    expect(mutate.mock.calls[0]![0]).toMatchObject({ assunto_id: "a-wifi", resumo: "Trocou a senha do Wi-Fi." });
  });

  it("nove letras não contam como resumo quando ele é exigido", async () => {
    abrir(semRegistro("t-sup"), { exigir_resumo: true });
    await userEvent.type(screen.getByTestId("encerramento-resumo"), "123456789");
    await confirmar();
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("encerramento-erro-resumo")).toBeTruthy();
  });

  it("fechou: a janela se fecha", async () => {
    const { onOpenChange } = abrir(semRegistro("t-sup"));
    mutate.mockImplementation((_args, callbacks: { onSuccess?: () => void }) => callbacks.onSuccess?.());
    await confirmar();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("recusa do SERVIDOR aparece no campo, e a janela continua aberta", async () => {
    const { onOpenChange } = abrir(semRegistro("t-sup"));
    mutate.mockImplementation((_args, callbacks: { onError?: (err: unknown) => void }) =>
      callbacks.onError?.({ recusa: { campo: "assunto", motivo: "invalido" } }),
    );
    await userEvent.click(screen.getByRole("radio", { name: "Wi-Fi" }));
    await confirmar();
    expect(screen.getByTestId("encerramento-erro-assunto").textContent).toBe(
      "Esse assunto não está mais disponível. Escolha outro.",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("organização sem nenhum assunto cadastrado: não há setor nem assunto, só o resumo", async () => {
    abrir(semRegistro(null), { times: [], exigir_assunto: true });
    expect(screen.queryByTestId("encerramento-setor")).toBeNull();
    expect(screen.queryByTestId("encerramento-assunto")).toBeNull();
    expect(screen.getByTestId("encerramento-resumo")).toBeTruthy();
    // "Exigir assunto" sem cadastro não trava o encerramento.
    await confirmar();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("reabrir e fechar de novo", () => {
  const registrado: AtendimentoAEncerrar = {
    team_id: "t-cob",
    assunto: { id: "a-wifi", nome: "Wi-Fi", time: "Suporte" },
    closure_summary: "Trocou a senha do Wi-Fi.",
  };

  it("a janela abre com o assunto marcado e o resumo escrito", () => {
    abrir(registrado, { exigir_assunto: true, exigir_resumo: true });
    expect(screen.getByRole("radio", { name: "Wi-Fi" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("encerramento-resumo") as HTMLTextAreaElement).value).toBe("Trocou a senha do Wi-Fi.");
  });

  it("fechar sem mexer manda o mesmo registro", async () => {
    abrir(registrado, { exigir_assunto: true, exigir_resumo: true });
    await confirmar();
    expect(mutate.mock.calls[0]![0]).toMatchObject({ assunto_id: "a-wifi", resumo: "Trocou a senha do Wi-Fi." });
  });

  it("clicar de novo no assunto marcado NÃO o desmarca: o banco o preservaria de qualquer forma", async () => {
    abrir(registrado);
    await userEvent.click(screen.getByRole("radio", { name: "Wi-Fi" }));
    expect(screen.getByRole("radio", { name: "Wi-Fi" }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("radio", { name: "Lentidão" }));
    expect(screen.getByRole("radio", { name: "Lentidão" }).getAttribute("aria-checked")).toBe("true");
  });

  it("assunto registrado que foi arquivado: a janela diz qual era e não o cobra de novo", async () => {
    abrir(
      { team_id: "t-sup", assunto: { id: "a-velho", nome: "Antigo", time: "Suporte" }, closure_summary: null },
      { exigir_assunto: true },
    );
    expect(screen.getByTestId("encerramento-assunto-anterior").textContent).toBe("Registrado antes: Suporte › Antigo");
    await confirmar();
    expect(mutate).toHaveBeenCalledTimes(1);
    // Nulo: o banco preserva o assunto que o atendimento já tem.
    expect(mutate.mock.calls[0]![0]).toMatchObject({ assunto_id: null });
  });
});

describe("o atendimento chega DEPOIS de a janela abrir (Reabrir e logo Fechar)", () => {
  const registrado: AtendimentoAEncerrar = {
    team_id: "t-sup",
    assunto: { id: "a-wifi", nome: "Wi-Fi", time: "Suporte" },
    closure_summary: "Trocou a senha do Wi-Fi.",
  };
  const janela = (atendimento: AtendimentoAEncerrar | null) => (
    <EncerrarAtendimentoDialog
      conversationId="conv-1"
      expectedRevision={7}
      contato="Maria Souza"
      protocolo={PROTOCOLO}
      protocoloAtual={PROTOCOLO}
      jaEncerrada={false}
      atendimento={atendimento}
      grupo={false}
      anonimizado={false}
      open
      onOpenChange={() => {}}
    />
  );

  it("a janela se preenche quando o registro chega, se a pessoa ainda não mexeu", () => {
    opcoes = { exigir_assunto: true, exigir_resumo: true, times: TIMES };
    const { rerender } = render(janela(null));
    expect((screen.getByTestId("encerramento-resumo") as HTMLTextAreaElement).value).toBe("");
    rerender(janela(registrado));
    expect((screen.getByTestId("encerramento-resumo") as HTMLTextAreaElement).value).toBe("Trocou a senha do Wi-Fi.");
    expect(screen.getByRole("radio", { name: "Wi-Fi" }).getAttribute("aria-checked")).toBe("true");
  });

  it("o que a pessoa já digitou NÃO é trocado pelo que estava guardado", async () => {
    opcoes = { exigir_assunto: false, exigir_resumo: false, times: TIMES };
    const { rerender } = render(janela(null));
    await userEvent.type(screen.getByTestId("encerramento-resumo"), "Texto novo");
    rerender(janela(registrado));
    expect((screen.getByTestId("encerramento-resumo") as HTMLTextAreaElement).value).toBe("Texto novo");
  });
});

describe("a janela fecha o atendimento em que foi aberta, ou nenhum", () => {
  it("outra pessoa encerrou e o cliente voltou (protocolo novo): nada é enviado, e o texto fica na tela", async () => {
    abrir(semRegistro("t-sup"), {}, { protocoloAtual: "20261005000099" });
    expect(screen.getByTestId("encerramento-mudou").textContent).toContain("há um atendimento novo em andamento");
    expect(screen.getByTestId("encerramento-confirmar").hasAttribute("disabled")).toBe(true);
    // O resumo continua lá, para a pessoa copiar se precisar.
    expect(screen.getByTestId("encerramento-resumo")).toBeTruthy();
    await confirmar();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("outra pessoa encerrou com a janela aberta: a janela diz, e não envia", async () => {
    abrir(semRegistro("t-sup"), {}, { jaEncerrada: true });
    expect(screen.getByTestId("encerramento-mudou").textContent).toContain("já foi encerrado por outra pessoa");
    await confirmar();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("CONTROLE: com o mesmo protocolo e a conversa aberta, não há aviso", () => {
    abrir(semRegistro("t-sup"));
    expect(screen.queryByTestId("encerramento-mudou")).toBeNull();
    expect(screen.getByTestId("encerramento-confirmar").hasAttribute("disabled")).toBe(false);
  });
});

describe("o texto digitado não se perde por acidente", () => {
  it("'Tentar de novo' na lista de assuntos não troca o formulário pelo esqueleto", () => {
    // Depois de um erro, o refetch devolve a consulta a "carregando" — sem dados.
    consulta = { isLoading: true, isError: false, errorUpdateCount: 1 };
    opcoes = undefined;
    render(
      <EncerrarAtendimentoDialog
        conversationId="conv-1"
        contato="Maria Souza"
        protocolo={PROTOCOLO}
        protocoloAtual={PROTOCOLO}
        jaEncerrada={false}
        atendimento={null}
        grupo={false}
        anonimizado={false}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("encerramento-carregando")).toBeNull();
    expect(screen.getByTestId("encerramento-resumo")).toBeTruthy();
  });

  it("CONTROLE: na PRIMEIRA carga, sem erro anterior, aparece o esqueleto", () => {
    consulta = { isLoading: true, isError: false, errorUpdateCount: 0 };
    opcoes = undefined;
    render(
      <EncerrarAtendimentoDialog
        conversationId="conv-1"
        contato="Maria Souza"
        protocolo={PROTOCOLO}
        protocoloAtual={PROTOCOLO}
        jaEncerrada={false}
        atendimento={null}
        grupo={false}
        anonimizado={false}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByTestId("encerramento-carregando")).toBeTruthy();
  });

  it("durante o envio, Cancelar fica travado: a recusa que ainda vem precisa de onde aparecer", () => {
    enviando = true;
    abrir(semRegistro("t-sup"));
    expect(screen.getByRole("button", { name: "Cancelar" }).hasAttribute("disabled")).toBe(true);
  });

  it("recusa de ASSUNTO do servidor aparece mesmo sem lista de assuntos, e a lista é recarregada", async () => {
    abrir(semRegistro(null), { times: [] });
    mutate.mockImplementation((_args, callbacks: { onError?: (err: unknown) => void }) =>
      callbacks.onError?.({ recusa: { campo: "assunto", motivo: "obrigatorio" } }),
    );
    await confirmar();
    expect(screen.getByTestId("encerramento-erro-assunto").textContent).toBe("Escolha o assunto do atendimento.");
    expect(recarregar).toHaveBeenCalledTimes(1);
  });
});

describe("apagar o resumo", () => {
  const comResumo: AtendimentoAEncerrar = { team_id: "t-sup", assunto: null, closure_summary: "Texto antigo." };

  it("limpar um resumo que existia manda texto VAZIO — o gesto de apagar", async () => {
    abrir(comResumo);
    await userEvent.clear(screen.getByTestId("encerramento-resumo"));
    await confirmar();
    expect(mutate.mock.calls[0]![0]).toMatchObject({ resumo: "" });
  });

  it("campo vazio em que ninguém mexeu manda NULO: nunca apaga nada", async () => {
    abrir(semRegistro("t-sup"));
    await confirmar();
    expect(mutate.mock.calls[0]![0]).toMatchObject({ resumo: null });
  });
});

describe("contato anonimizado", () => {
  it("não há campo de resumo, a exigência não trava, e o resumo vai nulo", async () => {
    abrir(
      { team_id: "t-sup", assunto: null, closure_summary: null },
      { exigir_resumo: true },
      { anonimizado: true },
    );
    expect(screen.queryByTestId("encerramento-resumo")).toBeNull();
    expect(screen.getByTestId("encerramento-sem-resumo")).toBeTruthy();
    await confirmar();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toMatchObject({ resumo: null });
  });
});

describe("conversa de grupo", () => {
  it("não busca assuntos, não mostra campos e fecha sem registro", async () => {
    abrir(null, { exigir_assunto: true, exigir_resumo: true }, { grupo: true });
    expect(pediuOpcoes).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("encerramento-resumo")).toBeNull();
    await confirmar();
    expect(mutate.mock.calls[0]![0]).toEqual({
      conversation_id: "conv-1",
      expected_revision: 7,
      assunto_id: null,
      resumo: null,
    });
  });
});
