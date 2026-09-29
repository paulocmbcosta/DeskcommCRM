/**
 * O CARTÃO DA LIGAÇÃO NA CONVERSA (desenho da fase 2, §6.6), medido pelo texto que
 * a pessoa lê.
 *
 * O dado é o registro que o worker grava no fim da ligação
 * (`messages.metadata.voice_call`, `registrarNaConversa`), que chega à conversa
 * pela rota das mensagens — aqui ele entra pelo MESMO leitor que o `ChatThread`
 * usa (`ligacaoDaMensagem`), com o jsonb na forma em que o worker o escreve. O
 * `useT` é o de verdade: sem provider é português; com `<IdiomaProvider
 * locale="es">`, o espanhol do dicionário.
 *
 * O que se prova:
 *  - cada desfecho do menu (`DESFECHOS_DO_MENU`, o vocabulário inteiro), o
 *    "desligou no menu" e o menu que parou por outro motivo viram uma frase de
 *    leigo, com o nome do menu e do time daquela hora;
 *  - o aviso de instabilidade ouvido e o "fora do horário" (título próprio);
 *  - a ligação sem URA — a da fase 1, já em produção, e a do número que toca
 *    direto no time — continua exatamente igual;
 *  - o metadado estranho (desfecho fora do vocabulário, nomes vazios, `$&` e
 *    marcador no nome) nunca derruba o cartão nem conta uma história errada.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { format } from "date-fns";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { DESFECHOS_DO_MENU, type DesfechoDoMenu } from "@/lib/telefonia/vocabulario";

import { CartaoDaLigacao, ligacaoDaMensagem } from "./CartaoDaLigacao";

afterEach(() => cleanup());

const EM = "2026-09-28T13:00:00.000Z";
/** A hora como o cartão a escreve (24 h, fuso da máquina) — a régua do balão. */
const HORA = format(new Date(EM), "HH:mm");

/** O `voice_call` como o worker o grava; `extra` acrescenta (ou tira) campos da fase 2. */
function registro(extra: Record<string, unknown> = {}) {
  return { voice_call: { id: "vc-1", direcao: "inbound", desfecho: "perdida", duracao_ms: null, ...extra } };
}

function cartao(metadata: unknown, embrulho: (el: ReactElement) => ReactElement = (el) => el) {
  const ligacao = ligacaoDaMensagem(metadata);
  if (!ligacao) throw new Error("o leitor recusou um registro de ligação válido");
  const { container } = render(embrulho(<CartaoDaLigacao ligacao={ligacao} em={EM} />));
  const raiz = container.querySelector("[data-ligacao]")!;
  return {
    raiz,
    /** A linha do que a URA fez (menu e aviso), ou `null` quando o cartão não a tem. */
    ura: container.querySelector("[data-ligacao-ura]"),
    menu: container.querySelector("[data-ligacao-menu]"),
    aviso: container.querySelector("[data-ligacao-ouviu-aviso]"),
  };
}

const menu = (m: Record<string, unknown>) => ({
  nome: "Principal",
  desfecho: "chosen",
  tecla: "2",
  time_nome: "Financeiro",
  desligou: false,
  ...m,
});

describe("o cartão conta o que a URA fez", () => {
  it("escolheu uma opção: o menu, a tecla e o time para onde a ligação foi", () => {
    const c = cartao(registro({ menu: menu({}) }));
    expect(c.menu?.textContent).toBe("No menu Principal, digitou 2 e foi para o time Financeiro");
    expect(c.menu?.getAttribute("data-ligacao-menu")).toBe("chosen");
    expect(c.aviso).toBeNull();
  });

  it("não digitou nada: foi para o time padrão, com o nome dele", () => {
    const c = cartao(registro({ menu: menu({ desfecho: "default_no_input", tecla: null, time_nome: "Suporte" }) }));
    expect(c.menu?.textContent).toBe("No menu Principal, não digitou nada e foi para o time padrão, Suporte");
    expect(c.menu?.getAttribute("data-ligacao-menu")).toBe("default_no_input");
  });

  it("digitou tecla que não está no menu: também foi para o time padrão", () => {
    const c = cartao(registro({ menu: menu({ desfecho: "default_invalid", tecla: null, time_nome: "Suporte" }) }));
    expect(c.menu?.textContent).toBe(
      "No menu Principal, digitou uma tecla que não existe e foi para o time padrão, Suporte",
    );
    expect(c.menu?.getAttribute("data-ligacao-menu")).toBe("default_invalid");
  });

  it("desligou no menu, antes de escolher: sem time, porque ninguém chegou a tocar", () => {
    const c = cartao(
      registro({ motivo: "cliente_desligou", menu: menu({ desfecho: null, tecla: null, time_nome: null, desligou: true }) }),
    );
    expect(c.raiz.textContent).toContain("Ligação perdida");
    expect(c.menu?.textContent).toBe("Desligou no menu Principal, antes de escolher");
    expect(c.menu?.getAttribute("data-ligacao-menu")).toBe("desligou");
  });

  it("o menu parou sem ser o cliente (o sistema reiniciou): não diz que ele desligou", () => {
    const c = cartao(
      registro({
        motivo: "interrompida_no_reinicio",
        menu: menu({ desfecho: null, tecla: null, time_nome: null, desligou: false }),
      }),
    );
    expect(c.menu?.textContent).toBe("A ligação terminou no menu Principal, antes de escolher");
    expect(c.menu?.getAttribute("data-ligacao-menu")).toBe("interrompida");
  });

  // O vocabulário INTEIRO, não os três de hoje: um desfecho novo no CHECK (e em
  // DESFECHOS_DO_MENU) que o cartão não souber contar reprova aqui — e no `never`
  // do switch, no typecheck.
  it.each(DESFECHOS_DO_MENU)("todo desfecho do vocabulário vira frase com o menu e o time: %s", (desfecho) => {
    const c = cartao(registro({ menu: menu({ desfecho: desfecho as DesfechoDoMenu }) }));
    expect(c.menu?.getAttribute("data-ligacao-menu")).toBe(desfecho);
    expect(c.menu?.textContent).toMatch(/^No menu Principal, .+ Financeiro$/);
  });

  it("ouviu o aviso de instabilidade: na mesma linha do menu, ou sozinho no número que toca direto no time", () => {
    const comMenu = cartao(registro({ desfecho: "atendida", ouviu_aviso: true, menu: menu({}) }));
    expect(comMenu.ura?.textContent).toBe(
      "No menu Principal, digitou 2 e foi para o time Financeiro · Ouviu o aviso de instabilidade",
    );
    cleanup();
    const semMenu = cartao(registro({ ouviu_aviso: true, menu: null }));
    expect(semMenu.menu).toBeNull();
    expect(semMenu.ura?.textContent).toBe("Ouviu o aviso de instabilidade");
  });

  it("fora do horário tem título próprio — e conta o menu que levou ao time fechado", () => {
    const c = cartao(registro({ motivo: "after_hours", menu: menu({}) }));
    expect(c.raiz.querySelector("[data-ligacao-titulo]")?.textContent).toBe("Ligação fora do horário");
    expect(c.menu?.textContent).toBe("No menu Principal, digitou 2 e foi para o time Financeiro");
    cleanup();
    // O `after_hours` só muda o título da recebida NÃO atendida.
    const feita = cartao({ voice_call: { id: "vc-2", direcao: "outbound", desfecho: "sem_resposta", duracao_ms: null, motivo: "after_hours" } });
    expect(feita.raiz.querySelector("[data-ligacao-titulo]")?.textContent).toBe("Ligação sem resposta");
  });

  it("em espanhol, a frase inteira — e os nomes vêm como foram cadastrados", () => {
    const es = (el: ReactElement) => <IdiomaProvider locale="es">{el}</IdiomaProvider>;
    const c = cartao(registro({ motivo: "after_hours", ouviu_aviso: true, menu: menu({}) }), es);
    expect(c.raiz.querySelector("[data-ligacao-titulo]")?.textContent).toBe("Llamada fuera de horario");
    expect(c.ura?.textContent).toBe(
      "En el menú Principal, marcó 2 y pasó al equipo Financeiro · Escuchó el aviso de inestabilidad",
    );
    const frase = (m: Record<string, unknown>) => {
      cleanup();
      return cartao(registro({ menu: menu(m) }), es).menu?.textContent;
    };
    expect(frase({ desfecho: "default_no_input", tecla: null, time_nome: "Soporte" })).toBe(
      "En el menú Principal, no marcó nada y pasó al equipo predeterminado, Soporte",
    );
    expect(frase({ desfecho: "default_invalid", tecla: null, time_nome: "Soporte" })).toBe(
      "En el menú Principal, marcó una tecla que no existe y pasó al equipo predeterminado, Soporte",
    );
    expect(frase({ desfecho: null, tecla: null, time_nome: null, desligou: true })).toBe(
      "Colgó en el menú Principal, antes de elegir",
    );
    expect(frase({ desfecho: null, tecla: null, time_nome: null })).toBe(
      "La llamada terminó en el menú Principal, antes de elegir",
    );
    expect(frase({ nome: null })).toBe("En el menú del teléfono, marcó 2 y pasó al equipo Financeiro");
    expect(frase({ tecla: null })).toBe("En el menú Principal, eligió una opción y pasó al equipo Financeiro");
  });
});

describe("a ligação sem URA continua exatamente igual", () => {
  it("fase 1, já em produção (sem menu, sem motivo, sem aviso): o mesmo texto, e nada embaixo", () => {
    const perdida = cartao(registro());
    expect(perdida.raiz.textContent).toBe(`Ligação perdida· ${HORA}`);
    expect(perdida.ura).toBeNull();
    expect(perdida.raiz.children).toHaveLength(1);
    cleanup();
    const atendida = cartao(registro({ desfecho: "atendida", duracao_ms: 65_000, atendente_nome: "Ana" }));
    expect(atendida.raiz.textContent).toBe(`Ligação recebida· atendida por Ana· 1:05· ${HORA}`);
    expect(atendida.ura).toBeNull();
  });

  it("fase 2, número que toca direto no time (menu nulo, aviso não ouvido): igual à fase 1", () => {
    const c = cartao(registro({ motivo: "ninguem_atendeu", menu: null, ouviu_aviso: false }));
    expect(c.raiz.textContent).toBe(`Ligação perdida· ${HORA}`);
    expect(c.ura).toBeNull();
    expect(c.raiz.children).toHaveLength(1);
  });
});

describe("o metadado estranho não derruba o cartão nem conta história errada", () => {
  it("desfecho fora do vocabulário (worker mais novo): o cartão cala sobre o menu", () => {
    const c = cartao(registro({ menu: menu({ desfecho: "transferred" }) }));
    expect(c.raiz.textContent).toBe(`Ligação perdida· ${HORA}`);
    expect(c.ura).toBeNull();
  });

  it("menu que não é objeto, e 'desligou' junto de um desfecho: lidos com cuidado", () => {
    expect(cartao(registro({ menu: "Principal" })).ura).toBeNull();
    cleanup();
    expect(cartao(registro({ menu: ["chosen"] })).ura).toBeNull();
    cleanup();
    // Quem decidiu já saiu do menu: um `desligou` verdadeiro ao lado do desfecho não vale —
    // nem no cartão, nem no que o leitor entrega a quem mais o usar.
    expect(cartao(registro({ menu: menu({ desligou: true }) })).menu?.getAttribute("data-ligacao-menu")).toBe("chosen");
    expect(ligacaoDaMensagem(registro({ menu: menu({ desligou: true }) }))?.menu?.desligou).toBe(false);
  });

  // Só a forma nova grava `desfecho: null`, e sempre com `desligou`. Um objeto sem a
  // chave `desfecho`, ou com o nulo sem o `desligou`, não sustenta "terminou no menu":
  // o leitor devolve nulo, e o cartão cala.
  it.each([
    ["objeto vazio", {}],
    ["desfecho nulo sem 'desligou'", { desfecho: null }],
    ["só o nome", { nome: "X" }],
    ["'desligou' que não é booleano", { desfecho: null, desligou: "sim" }],
  ])("registro que não diz o que a URA fez (%s): o cartão cala sobre o menu", (_, bruto) => {
    expect(ligacaoDaMensagem(registro({ menu: bruto }))?.menu).toBeNull();
    const c = cartao(registro({ menu: bruto }));
    expect(c.raiz.textContent).toBe(`Ligação perdida· ${HORA}`);
    expect(c.ura).toBeNull();
  });

  it("sem o nome do menu ou do time (registro da 1ª versão da fase 2): a frase segue legível", () => {
    // A 1ª versão gravava só { desfecho, tecla, time_nome }.
    const antiga = cartao(registro({ menu: { desfecho: "chosen", tecla: "2", time_nome: "Financeiro" } }));
    expect(antiga.menu?.textContent).toBe("No menu do telefone, digitou 2 e foi para o time Financeiro");
    cleanup();
    const semTime = cartao(registro({ menu: menu({ time_nome: "  " }) }));
    expect(semTime.menu?.textContent).toBe("No menu Principal, digitou 2");
  });

  it("o nome vem do cadastro e sai como está: `$&` e marcador no nome não viram outra coisa", () => {
    const c = cartao(registro({ menu: menu({ nome: "Menu {time} $&", time_nome: "A$'B {menu}" }) }));
    expect(c.menu?.textContent).toBe("No menu Menu {time} $&, digitou 2 e foi para o time A$'B {menu}");
  });
});

/**
 * A GRAVAÇÃO NO CARTÃO (F3). A projeção vem do worker (`metadata.voice_call.gravacao`,
 * sempre mesclada no banco) e é lida por `gravacaoDaLigacao`. Ouvir pede a URL à
 * rota da escuta auditada SÓ no clique — abrir a conversa não é escuta.
 */
describe("a gravação no cartão", () => {
  const gravada = (gravacao: Record<string, unknown>) =>
    registro({ desfecho: "atendida", duracao_ms: 61_000, atendente_nome: "Ana", gravacao });

  function comGravacao(metadata: unknown, podeOuvirGravacao = true) {
    const ligacao = ligacaoDaMensagem(metadata)!;
    const { container } = render(<CartaoDaLigacao ligacao={ligacao} em={EM} podeOuvirGravacao={podeOuvirGravacao} />);
    return {
      linha: () => container.querySelector("[data-ligacao-gravacao]"),
      container,
    };
  }

  it("ligação não gravada: nenhuma linha de gravação (o cartão de antes)", () => {
    const { linha } = comGravacao(registro({ desfecho: "atendida" }));
    expect(linha()).toBeNull();
  });

  it.each([
    ["processando", "Preparando a gravação…"],
    ["falhou", "A gravação desta ligação não foi salva."],
    ["expirada", "Gravação apagada pelo prazo de guarda."],
  ])("%s: diz o que houve, sem botão", (situacao, texto) => {
    const { linha } = comGravacao(gravada({ situacao, duracao_ms: null }));
    expect(linha()?.getAttribute("data-ligacao-gravacao")).toBe(situacao);
    expect(linha()?.textContent).toBe(texto);
    expect(document.querySelector("[data-ouvir-gravacao]")).toBeNull();
  });

  it("pronta, sem o papel de ouvir: 'Ligação gravada', sem botão e sem pedir nada", () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { linha } = comGravacao(gravada({ situacao: "pronta", duracao_ms: 61_000 }), false);
    expect(linha()?.textContent).toBe("Ligação gravada");
    expect(document.querySelector("[data-ouvir-gravacao]")).toBeNull();
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("pronta: 'Ouvir a gravação · 1:01'; só o clique pede a URL à escuta auditada, e o player toca", async () => {
    const f = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ data: { url: "https://storage.exemplo/g.mp3?token=x", expira_em: "x" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", f);
    try {
      const { container } = comGravacao(gravada({ situacao: "pronta", duracao_ms: 61_000 }));
      const botao = container.querySelector("[data-ouvir-gravacao]") as HTMLButtonElement;
      expect(botao.textContent).toBe("Ouvir a gravação· 1:01");
      expect(f).not.toHaveBeenCalled();

      fireEvent.click(botao);
      await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
      expect(f.mock.calls[0]![0]).toBe("/api/v1/telefonia/chamadas/vc-1/gravacao");
      expect(container.querySelector("audio")?.getAttribute("src")).toBe("https://storage.exemplo/g.mp3?token=x");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a escuta recusada (403/404): avisa e deixa tentar de novo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 })),
    );
    try {
      const { container } = comGravacao(gravada({ situacao: "pronta", duracao_ms: 61_000 }));
      fireEvent.click(container.querySelector("[data-ouvir-gravacao]")!);
      await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Não foi possível abrir a gravação. Tente de novo.",
      ));
      expect(container.querySelector("[data-ouvir-gravacao]")).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("em espanhol", () => {
    const ligacao = ligacaoDaMensagem(gravada({ situacao: "processando" }))!;
    const { container } = render(
      <IdiomaProvider locale="es">
        <CartaoDaLigacao ligacao={ligacao} em={EM} />
      </IdiomaProvider>,
    );
    expect(container.querySelector("[data-ligacao-gravacao]")?.textContent).toBe("Preparando la grabación…");
  });
});
