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
import { DESFECHOS_DO_MENU, acoesNaFilaDaLigacao, type DesfechoDoMenu } from "@/lib/telefonia/vocabulario";

import { CartaoDaLigacao, ligacaoDaMensagem, ligacaoDoRegistro } from "./CartaoDaLigacao";

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

/**
 * A FEITA QUE NINGUÉM ATENDEU (0294). O selo vermelho era o mesmo para quem
 * deixou o telefone do cliente chamar até a rede desistir e para quem deu um
 * toque e desligou — e servia de "tentei ligar" nos dois casos. Agora o selo diz
 * quem ligou, e a linha de baixo, por quanto tempo chamou e quem encerrou.
 */
describe("a feita que ninguém atendeu: quem ligou, quanto chamou e quem encerrou", () => {
  const feita = (extra: Record<string, unknown> = {}) => ({
    voice_call: { id: "vc-9", direcao: "outbound", desfecho: "sem_resposta", duracao_ms: null, atendente_nome: "Onetiana", ...extra },
  });
  const fimDe = (c: { raiz: Element }) => c.raiz.querySelector("[data-ligacao-fim]");
  const selo = (c: { raiz: Element }) => c.raiz.firstElementChild?.textContent;

  it("deu um toque e desligou: o selo diz quem ligou, e a linha, que chamou 4 s e quem ligou desligou", () => {
    const c = cartao(feita({ motivo: "atendente_desligou", toque_ms: 4_200 }));
    expect(selo(c)).toBe(`Ligação sem resposta· por Onetiana· ${HORA}`);
    expect(fimDe(c)?.textContent).toBe("Chamou 4 s · desligada por quem ligou");
    expect(fimDe(c)?.getAttribute("data-ligacao-fim")).toBe("atendente_desligou");
  });

  it("deixou chamar até a rede desistir: chamou 38 s e ninguém atendeu", () => {
    const c = cartao(feita({ motivo: "sem_resposta_19", toque_ms: 38_000 }));
    expect(fimDe(c)?.textContent).toBe("Chamou 38 s · ninguém atendeu");
    expect(fimDe(c)?.getAttribute("data-ligacao-fim")).toBe("ninguem_atendeu");
  });

  // A rede não avisou que o telefone chamava (nenhum 180/183). O cartão não afirma
  // que chamou, mas conta quanto a tentativa durou: quem esperou 40 s não fica
  // igual a quem desligou em 1 s.
  it("desligou sem sinal de toque: 'após 40 s' contra 'após 1 s' — e o tempo de toque, quando existe, vem primeiro", () => {
    const esperou = cartao(feita({ motivo: "atendente_desligou", tentativa_ms: 40_300 }));
    expect(fimDe(esperou)?.textContent).toBe("Desligada por quem ligou após 40 s");
    cleanup();
    const desistiuLogo = cartao(feita({ motivo: "atendente_desligou", tentativa_ms: 1_200 }));
    expect(fimDe(desistiuLogo)?.textContent).toBe("Desligada por quem ligou após 1 s");
    cleanup();
    const chamou = cartao(feita({ motivo: "atendente_desligou", toque_ms: 4_200, tentativa_ms: 6_000 }));
    expect(fimDe(chamou)?.textContent).toBe("Chamou 4 s · desligada por quem ligou");
    cleanup();
    // A tentativa é de quem DESLIGOU: quando a rede desistiu sem tempo de toque, nada a acrescentar.
    expect(fimDe(cartao(feita({ motivo: "sem_resposta_19", tentativa_ms: 40_000 })))).toBeNull();
  });

  it("número ocupado: diz isso, sem tempo", () => {
    const c = cartao(feita({ motivo: "ocupado_17", toque_ms: 2_000 }));
    expect(fimDe(c)?.textContent).toBe("O número estava ocupado");
  });

  // O registro de antes da 0294 tem o motivo e o nome, mas não o tempo: o cartão
  // diz quem encerrou e não inventa quanto chamou.
  it("registro antigo, sem o tempo: quem ligou desligou — e 'ninguém atendeu' não repete o título", () => {
    const desistiu = cartao(feita({ motivo: "atendente_desligou" }));
    expect(selo(desistiu)).toBe(`Ligação sem resposta· por Onetiana· ${HORA}`);
    expect(fimDe(desistiu)?.textContent).toBe("Desligada por quem ligou");
    cleanup();
    const aRedeDesistiu = cartao(feita({ motivo: "sem_resposta_19" }));
    expect(fimDe(aRedeDesistiu)).toBeNull();
    expect(aRedeDesistiu.raiz.children).toHaveLength(1);
  });

  it.each([
    ["tempo que não é número", { motivo: "atendente_desligou", toque_ms: "4000", tentativa_ms: "9000" }, "Desligada por quem ligou"],
    ["tempo negativo", { motivo: "atendente_desligou", toque_ms: -3, tentativa_ms: -9 }, "Desligada por quem ligou"],
    ["tempo zero", { motivo: "sem_resposta_19", toque_ms: 0 }, null],
  ])("metadado estranho (%s): nunca um tempo que ninguém mediu", (_, extra, esperado) => {
    const c = cartao(feita(extra));
    expect(fimDe(c)?.textContent ?? null).toBe(esperado);
  });

  it.each([
    ["sem motivo", {}],
    ["o serviço reiniciou no meio", { motivo: "encerrada_apos_reinicio", toque_ms: 9_000, tentativa_ms: 9_000 }],
    ["motivo de um worker mais novo", { motivo: "caixa_postal", toque_ms: 9_000 }],
  ])("motivo que não diz como acabou (%s): o cartão cala", (_, extra) => {
    const c = cartao(feita(extra));
    expect(fimDe(c)).toBeNull();
    expect(selo(c)).toBe(`Ligação sem resposta· por Onetiana· ${HORA}`);
  });

  it("só a feita SEM RESPOSTA ganha a linha: a não completada, a atendida e a recebida ficam como eram", () => {
    const naoCompletada = cartao(feita({ desfecho: "recusada_pela_rede", motivo: "nao_completada_16", toque_ms: 5_000 }));
    expect(fimDe(naoCompletada)).toBeNull();
    expect(selo(naoCompletada)).toBe(`Ligação não completada· por Onetiana· ${HORA}`);
    cleanup();
    const atendida = cartao(feita({ desfecho: "atendida", duracao_ms: 5_000, motivo: "atendente_desligou", toque_ms: 5_000 }));
    expect(fimDe(atendida)).toBeNull();
    expect(selo(atendida)).toBe(`Ligação feita· por Onetiana· 0:05· ${HORA}`);
    cleanup();
    // Na recebida perdida, o nome não aparece (ninguém atendeu) e o motivo não vira frase.
    const perdida = cartao(registro({ motivo: "atendente_desligou", atendente_nome: "Onetiana", toque_ms: 5_000 }));
    expect(fimDe(perdida)).toBeNull();
    expect(perdida.raiz.textContent).toBe(`Ligação perdida· ${HORA}`);
  });

  it("em espanhol", () => {
    const es = (el: ReactElement) => <IdiomaProvider locale="es">{el}</IdiomaProvider>;
    expect(fimDe(cartao(feita({ motivo: "atendente_desligou", toque_ms: 65_000 }), es))?.textContent).toBe(
      "Sonó 1 min 05 s · colgó quien llamó",
    );
    cleanup();
    expect(fimDe(cartao(feita({ motivo: "sem_resposta_19", toque_ms: 38_000 }), es))?.textContent).toBe("Sonó 38 s · nadie contestó");
    cleanup();
    expect(fimDe(cartao(feita({ motivo: "atendente_desligou" }), es))?.textContent).toBe("Colgó quien llamó");
    cleanup();
    expect(fimDe(cartao(feita({ motivo: "atendente_desligou", tentativa_ms: 40_000 }), es))?.textContent).toBe(
      "Colgó quien llamó tras 40 s",
    );
    cleanup();
    expect(fimDe(cartao(feita({ motivo: "ocupado_17" }), es))?.textContent).toBe("El número estaba ocupado");
  });
});

/**
 * SÓ O REGISTRO DA LIGAÇÃO VIRA CARTÃO. Qualquer membro escreve em `messages`
 * pela REST: uma mensagem comum com `metadata.voice_call` plantado desenhava um
 * cartão dizendo o que o autor quisesse. O `external_id` `ligacao:<id>` só o
 * sistema escreve (trigger da 0289), e é ele que a conversa confere.
 */
describe("só o registro da ligação vira cartão (ligacaoDoRegistro)", () => {
  const vc = { id: "3f1c2b8e-9a4d-4c6e-8f00-1234567890ab", direcao: "outbound", desfecho: "sem_resposta", duracao_ms: null, toque_ms: 45_000, motivo: "sem_resposta_19" };

  it("o registro que o worker grava (`ligacao:<id da ligação>`) é lido", () => {
    expect(ligacaoDoRegistro({ external_id: `ligacao:${vc.id}`, metadata: { voice_call: vc } })).toMatchObject({ id: vc.id, toque_ms: 45_000 });
  });

  it.each([
    ["sem external_id", null],
    ["external_id ausente", undefined],
    ["external_id de mensagem comum", "wamid.HBgM123"],
    ["`ligacao:` de OUTRA ligação", "ligacao:00000000-0000-4000-8000-000000000000"],
    ["só o prefixo", "ligacao:"],
    ["o id sem o prefixo", vc.id],
  ])("mensagem com o metadado de ligação plantado (%s): não é registro, e não vira cartão", (_, external_id) => {
    expect(ligacaoDoRegistro({ external_id, metadata: { voice_call: vc } })).toBeNull();
  });

  it("registro sem metadado de ligação: nulo", () => {
    expect(ligacaoDoRegistro({ external_id: `ligacao:${vc.id}`, metadata: {} })).toBeNull();
    expect(ligacaoDoRegistro({ external_id: `ligacao:${vc.id}`, metadata: null })).toBeNull();
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
  const VC = "3f1c2b8e-9a4d-4c6e-8f00-1234567890ab";
  const gravada = (gravacao: Record<string, unknown>) =>
    registro({ id: VC, desfecho: "atendida", duracao_ms: 61_000, atendente_nome: "Ana", gravacao });

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
      expect(f.mock.calls[0]![0]).toBe(`/api/v1/telefonia/chamadas/${VC}/gravacao`);
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

  it("id de ligação que não é uuid (metadado forjado): 'Ligação gravada', sem botão", () => {
    const { linha } = comGravacao(registro({ id: "../../admin", desfecho: "atendida", gravacao: { situacao: "pronta", duracao_ms: 1_000 } }));
    expect(linha()?.textContent).toBe("Ligação gravada");
    expect(document.querySelector("[data-ouvir-gravacao]")).toBeNull();
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

describe("a corrente de transferências (v2)", () => {
  it("cada elo vira uma frase, com os nomes daquela hora; registro sem corrente não mostra nada", () => {
    const base = {
      voice_call: { id: "vc-1", direcao: "inbound", desfecho: "atendida", duracao_ms: 60_000, atendente_nome: "Bia" },
    };
    const semCorrente = ligacaoDaMensagem(base)!;
    const { container, rerender } = render(<CartaoDaLigacao ligacao={semCorrente} em="2026-09-30T13:00:00Z" />);
    expect(container.querySelector("[data-ligacao-transferencias]")).toBeNull();

    const comCorrente = ligacaoDaMensagem({
      voice_call: {
        ...base.voice_call,
        transferencias: [
          { tipo: "blind", desfecho: "returned", de_nome: "Ana", para_nome: "Bruno", para_time: null, atendida_por_nome: "Ana" },
          { tipo: "blind", desfecho: "queue_answered", de_nome: "Ana", para_nome: null, para_time: "Suporte", atendida_por_nome: "Bia" },
          { tipo: "desconhecido", desfecho: "answered" },
        ],
      },
    })!;
    rerender(<CartaoDaLigacao ligacao={comCorrente} em="2026-09-30T13:00:00Z" />);
    const elos = [...container.querySelectorAll("[data-ligacao-transferencia]")].map((e) => e.textContent);
    expect(elos).toEqual([
      "Ana transferiu para Bruno · não atendeu, voltou para Ana",
      "Ana transferiu para Suporte · Bia atendeu",
    ]);
  });
});

/**
 * O QUE SE FEZ COM A LIGAÇÃO NA FILA (entrega 3; migration 0296). O worker grava
 * em `metadata.voice_call.fila` as ordens que DERAM CERTO — quem puxou a ligação
 * para si, quem a moveu de time —, e o cartão as lê por `acoesNaFilaDaLigacao`.
 */
describe("o que se fez com a ligação na fila (entrega 3)", () => {
  const base = { id: "vc-1", direcao: "inbound", desfecho: "atendida", duracao_ms: 60_000, atendente_nome: "Bia" };
  const linhas = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-ligacao-acao-na-fila]")].map((e) => [e.getAttribute("data-ligacao-acao-na-fila"), e.textContent]);
  const desenhar = (fila: unknown, embrulho: (el: ReactElement) => ReactElement = (el) => el) => {
    const ligacao = ligacaoDaMensagem({ voice_call: { ...base, fila } })!;
    return render(embrulho(<CartaoDaLigacao ligacao={ligacao} em={EM} />)).container;
  };

  it("puxada e movida viram uma linha cada, com os nomes daquela hora; registro sem ações não mostra nada", () => {
    const sem = render(<CartaoDaLigacao ligacao={ligacaoDaMensagem({ voice_call: base })!} em={EM} />).container;
    expect(sem.querySelector("[data-ligacao-fila]")).toBeNull();
    cleanup();

    const container = desenhar([
      { tipo: "move", por_nome: "Carla", de_time: "Vendas", para_time: "Suporte" },
      { tipo: "pull", por_nome: "Bia", de_time: "Suporte", para_time: null },
    ]);
    expect(linhas(container)).toEqual([
      ["move", "Movida de Vendas para Suporte por Carla"],
      ["pull", "Puxada da fila por Bia"],
    ]);
  });

  it("sem o nome de quem fez, ou do time: 'alguém' e 'outro time' — nunca um buraco na frase", () => {
    const container = desenhar([
      { tipo: "pull", por_nome: null },
      { tipo: "move", por_nome: "  ", de_time: null, para_time: "Suporte" },
      { tipo: "move", por_nome: "Carla", de_time: "Vendas" },
    ]);
    expect(linhas(container)).toEqual([
      ["pull", "Puxada da fila por alguém"],
      ["move", "Movida de outro time para Suporte por alguém"],
      ["move", "Movida de Vendas para outro time por Carla"],
    ]);
  });

  it("o que o registro não sustenta é descartado: tipo fora do vocabulário, lixo, e o que não é lista", () => {
    const container = desenhar([
      { tipo: "atender", por_nome: "Ana" }, // o vocabulário do EVENTO, não o do registro
      { por_nome: "Ana" },
      null,
      "pull",
      42,
      { tipo: "pull", por_nome: "Bia" },
    ]);
    expect(linhas(container)).toEqual([["pull", "Puxada da fila por Bia"]]);
    cleanup();
    for (const naoLista of [null, undefined, "pull", { tipo: "pull" }, 7, true]) {
      expect(acoesNaFilaDaLigacao(naoLista)).toEqual([]);
      expect(desenhar(naoLista).querySelector("[data-ligacao-fila]")).toBeNull();
      cleanup();
    }
    // Lista só de lixo: nenhuma linha — e nem a lista vazia na tela.
    expect(desenhar([{ tipo: "outra" }, null]).querySelector("[data-ligacao-fila]")).toBeNull();
  });

  it("o leitor devolve só os quatro campos, com o texto vazio como ausente", () => {
    expect(
      acoesNaFilaDaLigacao([{ tipo: "move", por_nome: "", de_time: "  ", para_time: "Suporte", segredo: "x", por_id: "u-1" }]),
    ).toEqual([{ tipo: "move", por_nome: null, de_time: null, para_time: "Suporte" }]);
    expect(acoesNaFilaDaLigacao([{ tipo: "pull", por_nome: 7, de_time: {}, para_time: [] }])).toEqual([
      { tipo: "pull", por_nome: null, de_time: null, para_time: null },
    ]);
  });

  it("o nome vem do cadastro e sai como está: `$&` e marcador no nome não viram outra coisa", () => {
    const container = desenhar([
      { tipo: "move", por_nome: "Ana $& {de}", de_time: "A {para}", para_time: "B$'{quem}" },
      { tipo: "pull", por_nome: "{quem} $`" },
    ]);
    expect(linhas(container)).toEqual([
      ["move", "Movida de A {para} para B$'{quem} por Ana $& {de}"],
      ["pull", "Puxada da fila por {quem} $`"],
    ]);
  });

  it("vem antes da corrente de transferências: primeiro a fila, depois o que houve com a ligação atendida", () => {
    const ligacao = ligacaoDaMensagem({
      voice_call: {
        ...base,
        fila: [{ tipo: "pull", por_nome: "Ana" }],
        transferencias: [{ tipo: "blind", desfecho: "answered", de_nome: "Ana", para_nome: "Bia", para_time: null, atendida_por_nome: "Bia" }],
      },
    })!;
    const { container } = render(<CartaoDaLigacao ligacao={ligacao} em={EM} />);
    const fila = container.querySelector("[data-ligacao-fila]")!;
    const transferencias = container.querySelector("[data-ligacao-transferencias]")!;
    expect(fila.compareDocumentPosition(transferencias) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // E uma não entra na conta da outra.
    expect(container.querySelectorAll("[data-ligacao-acao-na-fila]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-ligacao-transferencia]")).toHaveLength(1);
  });

  it("em espanhol", () => {
    const es = (el: ReactElement) => <IdiomaProvider locale="es">{el}</IdiomaProvider>;
    const container = desenhar(
      [
        { tipo: "pull", por_nome: "Bia" },
        { tipo: "move", por_nome: null, de_time: "Vendas", para_time: null },
      ],
      es,
    );
    expect(linhas(container)).toEqual([
      ["pull", "Tomada de la cola por Bia"],
      ["move", "Movida de Vendas a otro equipo por alguien"],
    ]);
  });
});

describe("a ligação em andamento (fila visível, entrega 1)", () => {
  const vivo = { id: "0a0a0a0a-0000-4000-8000-000000000001", direcao: "inbound", desfecho: "atendida", em_andamento: true, duracao_ms: null, atendente_nome: "Ana" };

  it("diz que está em andamento, com quem e desde quando — sem duração e sem cor de perdida", () => {
    const ligacao = ligacaoDaMensagem({ voice_call: vivo })!;
    const { container } = render(<CartaoDaLigacao ligacao={ligacao} em="2026-10-06T17:32:00Z" />);
    const raiz = container.querySelector("[data-ligacao]")!;
    expect(raiz.getAttribute("data-ligacao")).toBe("em_andamento");
    expect(raiz.querySelector("[data-ligacao-titulo]")!.textContent).toBe("Ligação em andamento");
    expect(raiz.textContent).toContain("com Ana");
    expect(raiz.textContent).toContain("desde");
    expect(raiz.textContent).not.toContain("atendida por");
    expect(raiz.innerHTML).not.toContain("text-destructive");
  });

  it("só `true` de verdade conta: a marca como texto não é andamento", () => {
    expect(ligacaoDaMensagem({ voice_call: { ...vivo, em_andamento: "true" } })!.em_andamento).toBe(false);
    expect(ligacaoDaMensagem({ voice_call: { ...vivo, em_andamento: undefined } })!.em_andamento).toBe(false);
  });

  it("depois do fim o MESMO registro é a ligação recebida de sempre, com a duração", () => {
    const { em_andamento: _fora, ...fechado } = { ...vivo, duracao_ms: 65_000 };
    const ligacao = ligacaoDaMensagem({ voice_call: fechado })!;
    const { container } = render(<CartaoDaLigacao ligacao={ligacao} em="2026-10-06T17:32:00Z" />);
    const raiz = container.querySelector("[data-ligacao]")!;
    expect(raiz.getAttribute("data-ligacao")).toBe("atendida");
    expect(raiz.querySelector("[data-ligacao-titulo]")!.textContent).toBe("Ligação recebida");
    expect(raiz.textContent).toContain("atendida por Ana");
    expect(raiz.textContent).toContain("1:05");
  });
});

/**
 * A TRANSCRIÇÃO NO CARTÃO (F4). O que chega é o que a LISTAGEM entrega em
 * `metadata.voice_call.transcricao` — a situação e, para quem pode ouvir a
 * gravação, o resumo. O texto inteiro é pedido à rota da leitura auditada SÓ no
 * clique em "Ver transcrição": abrir a conversa não é ler a transcrição.
 */
describe("a transcrição no cartão", () => {
  const VC = "3f1c2b8e-9a4d-4c6e-8f00-1234567890ab";
  const transcrita = (transcricao: unknown, extra: Record<string, unknown> = {}) =>
    registro({
      id: VC,
      desfecho: "atendida",
      duracao_ms: 61_000,
      atendente_nome: "Ana",
      gravacao: { situacao: "pronta", duracao_ms: 61_000 },
      transcricao,
      ...extra,
    });
  const RESUMO = "A cliente cobrou a visita técnica, que foi remarcada para o começo da tarde.";
  const LIDA = {
    situacao: "pronta",
    resumo: RESUMO,
    falas: [
      { quem: "atendente", inicio_ms: 0, texto: "Totus, boa tarde." },
      { quem: "cliente", inicio_ms: 2_400, texto: "Estou esperando o técnico desde cedo." },
      { quem: "sistema", inicio_ms: 65_000, texto: "Sua ligação é muito importante." },
      { quem: null, inicio_ms: 3_795_000, texto: "Tá bom." },
    ],
    duracao_ms: 61_000,
    estimativa: true,
  };

  function comTranscricao(metadata: unknown, podeOuvirGravacao = true) {
    const ligacao = ligacaoDaMensagem(metadata)!;
    const { container } = render(<CartaoDaLigacao ligacao={ligacao} em={EM} podeOuvirGravacao={podeOuvirGravacao} />);
    return { linha: () => container.querySelector("[data-ligacao-transcricao]"), container };
  }
  const respostaDaRota = (corpo: unknown, status = 200) =>
    vi.fn(async (_url: string) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } }));

  it("ligação sem transcrição: nenhuma linha (o cartão de antes)", () => {
    const { linha } = comTranscricao(registro({ id: VC, desfecho: "atendida", gravacao: { situacao: "pronta", duracao_ms: 1_000 } }));
    expect(linha()).toBeNull();
  });

  it.each([
    ["processando", "Transcrevendo a ligação…"],
    ["sem_fala", "A gravação não tem fala para transcrever."],
    ["falhou", "Não foi possível transcrever esta ligação."],
  ])("%s: diz o que houve, sem botão", (situacao, texto) => {
    const { linha } = comTranscricao(transcrita({ situacao }));
    expect(linha()?.getAttribute("data-ligacao-transcricao")).toBe(situacao);
    expect(linha()?.textContent).toBe(texto);
    expect(document.querySelector("[data-ver-transcricao]")).toBeNull();
  });

  it("situação fora do vocabulário (worker mais novo): o cartão cala, em vez de prometer um texto", () => {
    const { linha } = comTranscricao(transcrita({ situacao: "em_revisao", resumo: "x" }));
    expect(linha()).toBeNull();
  });

  it("pronta: mostra o resumo, dito como feito por IA, e o botão — sem pedir nada ao abrir a conversa", () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    try {
      const { container } = comTranscricao(transcrita({ situacao: "pronta", resumo: RESUMO }));
      const resumo = container.querySelector("[data-ligacao-resumo]");
      expect(resumo?.textContent).toContain(RESUMO);
      expect(resumo?.textContent).toContain("feito por IA");
      expect(container.querySelector("[data-ver-transcricao]")?.textContent).toBe("Ver transcrição");
      expect(f).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pronta sem resumo (o passo do resumo falhou): só o botão", () => {
    const { container } = comTranscricao(transcrita({ situacao: "pronta" }));
    expect(container.querySelector("[data-ligacao-resumo]")).toBeNull();
    expect(container.querySelector("[data-ver-transcricao]")).not.toBeNull();
  });

  it("quem não pode ouvir a gravação não vê NADA da transcrição — nem que ela existe", () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    try {
      const { linha, container } = comTranscricao(transcrita({ situacao: "pronta", resumo: RESUMO }), false);
      expect(linha()).toBeNull();
      expect(container.textContent).not.toContain("visita técnica");
      expect(document.querySelector("[data-ver-transcricao]")).toBeNull();
      expect(f).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("'Ver transcrição': UM clique, UM pedido à leitura auditada; a janela lista quem falou, quando e o quê, e avisa que é estimativa", async () => {
    const f = respostaDaRota({ data: LIDA });
    vi.stubGlobal("fetch", f);
    try {
      const { container } = comTranscricao(transcrita({ situacao: "pronta", resumo: RESUMO }));
      fireEvent.click(container.querySelector("[data-ver-transcricao]")!);
      await waitFor(() => expect(document.querySelector('[data-transcricao-corpo="lida"]')).not.toBeNull());
      expect(f).toHaveBeenCalledTimes(1);
      expect(f.mock.calls[0]![0]).toBe(`/api/v1/telefonia/chamadas/${VC}/transcricao`);

      const janela = document.querySelector("[data-janela-da-transcricao]")!;
      expect(janela.textContent).toContain("Quem falou é uma estimativa");
      expect(janela.textContent).toContain("pode errar nomes, números e endereços");
      expect(janela.querySelector("[data-transcricao-resumo]")?.textContent).toContain(RESUMO);
      const falas = [...janela.querySelectorAll("[data-fala-de]")];
      expect(falas.map((el) => el.getAttribute("data-fala-de"))).toEqual(["atendente", "cliente", "sistema", "desconhecido"]);
      expect(falas[0]?.textContent).toBe("Atendente0:00Totus, boa tarde.");
      expect(falas[1]?.textContent).toBe("Cliente0:02Estou esperando o técnico desde cedo.");
      expect(falas[2]?.textContent).toBe("Gravação automática ou ruído1:05Sua ligação é muito importante.");
      expect(falas[3]?.textContent).toBe("Não identificado1:03:15Tá bom.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("o texto da ligação é mostrado como TEXTO: marcação dentro da fala não vira elemento", async () => {
    const f = respostaDaRota({ data: { ...LIDA, resumo: "<b>resumo</b>", falas: [{ quem: "cliente", inicio_ms: 0, texto: "<img src=x onerror=alert(1)>" }] } });
    vi.stubGlobal("fetch", f);
    try {
      const { container } = comTranscricao(transcrita({ situacao: "pronta" }));
      fireEvent.click(container.querySelector("[data-ver-transcricao]")!);
      await waitFor(() => expect(document.querySelector('[data-transcricao-corpo="lida"]')).not.toBeNull());
      const janela = document.querySelector("[data-janela-da-transcricao]")!;
      expect(janela.querySelector("img")).toBeNull();
      expect(janela.querySelector("b")).toBeNull();
      expect(janela.textContent).toContain("<img src=x onerror=alert(1)>");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a leitura recusada (403/404): a janela avisa, sem texto nenhum", async () => {
    vi.stubGlobal("fetch", respostaDaRota({ error: { code: "not_found" } }, 404));
    try {
      const { container } = comTranscricao(transcrita({ situacao: "pronta", resumo: RESUMO }));
      fireEvent.click(container.querySelector("[data-ver-transcricao]")!);
      await waitFor(() => expect(document.querySelector('[data-transcricao-corpo="erro"]')).not.toBeNull());
      expect(document.querySelector('[data-janela-da-transcricao] [role="alert"]')?.textContent).toBe(
        "Não foi possível abrir a transcrição. Feche e tente de novo.",
      );
      expect(document.querySelector("[data-transcricao-falas]")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a rota respondeu que não há texto (apagada no meio): a janela diz isso, em vez de ficar vazia", async () => {
    vi.stubGlobal("fetch", respostaDaRota({ data: { situacao: "sem_fala", resumo: null, falas: [], duracao_ms: null, estimativa: true } }));
    try {
      const { container } = comTranscricao(transcrita({ situacao: "pronta" }));
      fireEvent.click(container.querySelector("[data-ver-transcricao]")!);
      await waitFor(() => expect(document.querySelector('[data-transcricao-corpo="lida"]')).not.toBeNull());
      expect(document.querySelector("[data-janela-da-transcricao]")?.textContent).toContain("Esta ligação não tem transcrição para mostrar.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("id de ligação que não é uuid (metadado forjado): nada da transcrição, e nenhum pedido", () => {
    const { linha } = comTranscricao(transcrita({ situacao: "pronta", resumo: RESUMO }, { id: "../../admin" }));
    expect(linha()).toBeNull();
  });

  it("em espanhol", () => {
    const ligacao = ligacaoDaMensagem(transcrita({ situacao: "pronta", resumo: RESUMO }))!;
    const { container } = render(
      <IdiomaProvider locale="es">
        <CartaoDaLigacao ligacao={ligacao} em={EM} podeOuvirGravacao />
      </IdiomaProvider>,
    );
    expect(container.querySelector("[data-ver-transcricao]")?.textContent).toBe("Ver transcripción");
    expect(container.querySelector("[data-ligacao-resumo]")?.textContent).toContain("Resumen de la llamada · hecho por IA");
  });
});
