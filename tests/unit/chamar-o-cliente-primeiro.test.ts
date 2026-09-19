/**
 * FALAR PRIMEIRO — os elos que, se soltarem, soltam em silêncio.
 *
 * Cada caso aqui nasce de um defeito MEDIDO em 2026-09-19, não de uma hipótese.
 * O que os une é o modo de falhar: nenhum deles quebra o build, nenhum aparece
 * no typecheck, e todos produzem uma tela que parece funcionar e um envio que a
 * plataforma recusa — ou, pior, uma frase falsa oferecendo uma saída que não
 * existe.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { slotKey, missingSlots, buildComponents } from "@/lib/channels/meta/build-components";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";
import { aplicarValores } from "@/components/channels/CamposDoModelo";
import { iniciarConversaSchema, mensagemDeAberturaSchema, sendMessageSchema } from "@/lib/schemas/messaging";

/** Um modelo de abertura realista: saudação com nome + cabeçalho + botão de URL. */
const DEFINICAO = {
  name: "boas_vindas",
  language: "pt_BR",
  parameter_format: "POSITIONAL",
  components: [
    { type: "HEADER", format: "TEXT", text: "Olá, {{1}}!" },
    { type: "BODY", text: "Oi {{1}}, aqui é da {{2}}. Podemos falar sobre seu plano?" },
    {
      type: "BUTTONS",
      buttons: [{ type: "URL", text: "Ver fatura", url: "https://x.com/{{1}}" }],
    },
  ],
};

describe("a derivação é UMA — o formulário e o payload não têm como discordar", () => {
  it("a chave que a tela usa é a MESMA que o montador lê", () => {
    // O defeito que isto prende: se a tela montasse a chave por conta própria
    // (ex.: só pela `key`), os valores chegariam num endereço que
    // `buildComponents` não procura, e ele reportaria "parâmetro sem valor"
    // para um campo que o operador preencheu. Como as duas pontas chamam
    // `slotKey`, o desencontro é impossível por construção.
    const contrato = deriveTemplateContract(DEFINICAO as never);
    const valores: Record<string, string> = {};
    for (const slot of contrato.slots) valores[slotKey(slot.address, slot.key)] = "x";

    expect(missingSlots(contrato, valores)).toEqual([]);
    expect(() => buildComponents(contrato, valores)).not.toThrow();
  });

  it("header, corpo e botão são slots DISTINTOS, mesmo com a key repetida", () => {
    // Os três usam `{{1}}`. Chaveado só pela `key`, um valor sobrescreveria os
    // outros dois em silêncio: a tela mostraria um campo onde existem três, e o
    // envio iria com o texto do header dentro da URL do botão.
    const contrato = deriveTemplateContract(DEFINICAO as never);
    const chaves = contrato.slots.map((s) => slotKey(s.address, s.key));

    expect(new Set(chaves).size).toBe(chaves.length);
    // O corpo é o único sem prefixo — é o que casa com o `{{1}}` que o operador
    // vê, e é disso que o preview da tela depende para saber o que é do corpo.
    expect(chaves).toContain("1");
    expect(chaves.some((c) => c.startsWith("header:"))).toBe(true);
    expect(chaves.some((c) => c.startsWith("button"))).toBe(true);
  });

  it("valor faltando é detectado ANTES do envio, com o endereço do slot", () => {
    const contrato = deriveTemplateContract(DEFINICAO as never);
    const faltando = missingSlots(contrato, { "1": "Ana" });

    expect(faltando.length).toBeGreaterThan(0);
    // Espaço em branco conta como ausente: um campo com " " produziria um
    // parâmetro vazio, que a plataforma recusa com 132000.
    expect(missingSlots(contrato, { "1": "   " }).length).toBe(contrato.slots.length);
  });
});

describe("o preview mostra o que o cliente vai ler", () => {
  it("aplica os valores preenchidos e preserva os que faltam", () => {
    // Preservar o `{{n}}` cru é como a tela mostra o que ainda falta sem uma
    // segunda lista — trocar por vazio faria a frase parecer pronta.
    expect(aplicarValores("Oi {{1}}, da {{2}}.", { "1": "Ana" })).toBe("Oi Ana, da {{2}}.");
    expect(aplicarValores("Oi {{1}}.", { "1": "Ana" })).toBe("Oi Ana.");
    expect(aplicarValores("Oi {{1}}.", { "1": "  " })).toBe("Oi {{1}}.");
  });

  it("aceita placeholder NOMEADO, não só numerado", () => {
    // A Meta aceita `{{customer_name}}`, e a derivação já o trata. Um preview
    // que só entendesse dígitos mostraria a variável crua num modelo válido.
    expect(aplicarValores("Oi {{nome}}.", { nome: "Ana" })).toBe("Oi Ana.");
  });
});

describe("o schema de abertura é o MESMO conteúdo do de resposta", () => {
  it("aceita um template com valores", () => {
    const r = mensagemDeAberturaSchema.safeParse({
      type: "template",
      template_name: "boas_vindas",
      template_language: "pt_BR",
      template_values: { "1": "Ana" },
      body: "Oi Ana",
    });
    expect(r.success).toBe(true);
  });

  it("recusa mensagem sem conteúdo, com a MESMA regra do envio comum", () => {
    // O defeito que isto prende é o oposto do óbvio: não é o schema recusar de
    // menos, é ele divergir do irmão. Uma mensagem vazia recusada ao responder
    // e aceita ao iniciar viraria uma bolha em branco na conversa.
    const vazio = { type: "text" as const };
    expect(mensagemDeAberturaSchema.safeParse(vazio).success).toBe(false);
    expect(
      sendMessageSchema.safeParse({ ...vazio, conversation_id: crypto.randomUUID() }).success,
    ).toBe(false);
  });

  it("o schema de iniciar exige a CONEXÃO e um destinatário", () => {
    const base = {
      channel_session_id: crypto.randomUUID(),
      mensagem: { type: "text", body: "oi" },
    };
    expect(iniciarConversaSchema.safeParse(base).success).toBe(false);
    expect(
      iniciarConversaSchema.safeParse({ ...base, contact_id: crypto.randomUUID() }).success,
    ).toBe(true);
    expect(iniciarConversaSchema.safeParse({ ...base, phone_number: "+5532988887777" }).success).toBe(
      true,
    );
    // Sem conexão não passa: quem fala primeiro ESCOLHE o número por onde o
    // cliente vê a mensagem chegar. Deixar o sistema escolher mandaria a
    // apresentação por um número que o cliente não conhece.
    const { channel_session_id: _omitido, ...semConexao } = base;
    expect(
      iniciarConversaSchema.safeParse({ ...semConexao, contact_id: crypto.randomUUID() }).success,
    ).toBe(false);
  });
});

describe("a consulta dos modelos não pode esconder o canal oficial", () => {
  /** Client de mentira que grava a consulta montada e devolve o que se mandar. */
  function dbFalso(linhas: unknown[]) {
    const chamadas: { or?: string; eq: Record<string, unknown> } = { eq: {} };
    const q: Record<string, unknown> = {};
    const encadeia = () => q;
    Object.assign(q, {
      select: encadeia,
      order: () => ({ ...q, then: undefined, data: linhas, error: null }),
      eq: (col: string, val: unknown) => {
        chamadas.eq[col] = val;
        return q;
      },
      or: (expr: string) => {
        chamadas.or = expr;
        return q;
      },
      maybeSingle: async () => ({ data: { id: "s1", provider: "meta_cloud" }, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: linhas, error: null }),
    });
    return {
      chamadas,
      db: { from: () => q } as never,
    };
  }

  it("aceita a linha SEM dono — é assim que o sync oficial as grava", async () => {
    // O defeito que isto prende, medido em 2026-09-19: `syncTemplates` (canal
    // oficial) faz upsert só com as colunas que vêm da plataforma, então toda
    // linha dele nasce com `channel_session_id` NULL. Um `.eq()` puro
    // esconderia 100% dos modelos da Meta, e a tela diria "Nenhum modelo
    // aprovado ainda" para uma conta cheia deles.
    const { db, chamadas } = dbFalso([]);
    const { modelosParaEnvio } = await import("@/lib/channels/modelos-para-envio");
    await modelosParaEnvio(db, "org-1", "sessao-1");

    expect(chamadas.or, "a consulta voltou a filtrar só pela conexão").toBeDefined();
    expect(chamadas.or).toContain("channel_session_id.is.null");
    expect(chamadas.or).toContain("channel_session_id.eq.sessao-1");
  });

  it("a organização é SEMPRE filtrada à mão — o client é service role", async () => {
    // Anti-pattern 10: quem usa admin client bypassa RLS e precisa filtrar o
    // tenant manualmente. Sem isto, os modelos de outro cliente apareceriam.
    const { db, chamadas } = dbFalso([]);
    const { modelosParaEnvio } = await import("@/lib/channels/modelos-para-envio");
    await modelosParaEnvio(db, "org-1", "sessao-1");
    expect(chamadas.eq.organization_id).toBe("org-1");
  });
});

describe("os elos de tela que somem sem barulho", () => {
  it("a rota de modelos serve quem ATENDE, não só quem administra", () => {
    // O defeito medido: `/channels/templates` exige `admin`, então um `agent`
    // levava 403 e a tela mostrava "Nenhum modelo aprovado ainda" — falso. Quem
    // precisa mandar modelo quando a janela fecha é justamente quem atende.
    const fonte = readFileSync("app/api/v1/channels/modelos/route.ts", "utf8");
    expect(fonte).toMatch(/requireRole\("agent"/);
  });

  it("a rota de iniciar conversa também é do papel que atende", () => {
    const fonte = readFileSync("app/api/v1/conversations/iniciar/route.ts", "utf8");
    expect(fonte).toMatch(/requireRole\("agent"/);
  });

  it("iniciar conversa usa SERVICE ROLE — as RPCs são revogadas de `authenticated`", () => {
    // Defeito medido na revisão deste PR, antes de sair: a rota nasceu com
    // `createClient()` (client de sessão) e teria falhado em 100% das chamadas.
    // Abrir a conversa passa por `fn_service_begin`, e o baseline faz
    // `revoke execute … from public,anon,authenticated`. Nada disso aparece em
    // typecheck, lint ou unitário de lógica — só no uso real.
    //
    // O baseline entra na asserção de propósito: se um dia a função for
    // concedida a `authenticated`, este caso passa a medir uma verdade velha,
    // e é melhor que ele quebre e obrigue alguém a reler.
    const rota = readFileSync("app/api/v1/conversations/iniciar/route.ts", "utf8");
    expect(rota).toMatch(/createAdminClient\(\)/);
    expect(rota, "voltou ao client de sessão").not.toMatch(/createClient\(\)/);

    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const revogacoes = baseline
      .split("\n")
      .filter((l) => /^revoke execute on function public\.fn_service_begin/.test(l));
    expect(revogacoes.length, "fn_service_begin deixou de ser revogada").toBeGreaterThan(0);
    expect(revogacoes.some((l) => l.includes("authenticated"))).toBe(true);
  });

  it("nenhuma das telas novas nomeia um provider", () => {
    // Invariante 1 de `docs/doctrine/restricao-de-canal.md`. O `lint:channels`
    // é o guarda primário; este caso existe porque o lint tem allowlist e um
    // arquivo novo entrando nela passaria despercebido.
    for (const arquivo of [
      "components/contacts/ChamarNoWhatsAppDialog.tsx",
      "components/channels/CamposDoModelo.tsx",
      "components/kanban/ConversaNoDossie.tsx",
    ]) {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, `${arquivo} nomeia provider`).not.toMatch(
        /"zernio"|"meta_cloud"|"waha"|graph\.facebook\.com/,
      );
    }
  });

  it("a tela decide o modo por `exige_modelo`, não por adivinhação", () => {
    const fonte = readFileSync("components/contacts/ChamarNoWhatsAppDialog.tsx", "utf8");
    expect(fonte).toMatch(/exige_modelo/);
  });

  it("o botão de enviar fica travado enquanto faltar valor", () => {
    // Sem esta trava a tela repete o defeito que ela existe para consertar:
    // deixa clicar, a plataforma recusa com 132000, e o operador não sabe por
    // quê. A checagem local é o que transforma a recusa remota em campo vermelho.
    const fonte = readFileSync("components/contacts/ChamarNoWhatsAppDialog.tsx", "utf8");
    expect(fonte).toMatch(/faltando\.length === 0/);
    expect(fonte).toMatch(/disabled=\{!podeEnviar \|\| enviando\}/);
  });

  it("o seletor da janela fechada COLETA os valores — não manda vazio", () => {
    // O defeito medido: esta tela enviava `values: {}` e o próprio comentário
    // admitia que "a plataforma recusa". E mandava o operador para
    // "Conexões → Templates", que não tem envio nenhum — uma saída inexistente.
    const fonte = readFileSync("components/inbox/JanelaFechadaAviso.tsx", "utf8");
    expect(fonte).toMatch(/template_values: valores/);
    expect(fonte).toMatch(/<CamposDoModelo/);
    expect(fonte, "voltou a travar o envio com valores faltando").toMatch(
      /faltando\.length > 0/,
    );
  });

  it("a tool MCP de prospecção aceita template", () => {
    // Sem isto a tool servia só o canal que não precisa dela: prospecção fria é
    // falar com quem nunca escreveu, e é exatamente aí que a plataforma exige
    // modelo aprovado (131047).
    const fonte = readFileSync("lib/mcp/tools/start-conversation.ts", "utf8");
    expect(fonte).toMatch(/"template",/);
    expect(fonte).toMatch(/template_values/);
  });

  it("os valores do template entram na chave de idempotência", () => {
    // Fora dela, dois disparos do mesmo modelo com valores diferentes teriam o
    // mesmo hash: o segundo cliente receberia a resposta em cache do primeiro e
    // a mensagem dele nunca sairia — sem erro, sem rastro.
    const fonte = readFileSync("lib/mcp/tools/start-conversation.ts", "utf8");
    const hash = fonte.slice(fonte.indexOf("hashRequest({"), fonte.indexOf("if (input.idempotency_key)"));
    expect(hash).toMatch(/template_values/);
  });

  it("a conversa SOBREVIVE ao envio que falhou", () => {
    // `fn_service_begin` já abriu o atendimento e escreveu na linha do tempo.
    // Apagar a conversa apagaria esse rastro e faria o operador recomeçar sem
    // saber que já tinha tentado.
    const fonte = readFileSync("lib/messaging/iniciar-conversa.ts", "utf8");
    expect(fonte).toMatch(/envio: \{ ok: false, motivo/);
    const rota = readFileSync("app/api/v1/conversations/iniciar/route.ts", "utf8");
    // O `conversation_id` volta nos DOIS desfechos: é por ele que a tela leva o
    // operador para a conversa que acabou de nascer.
    expect(rota).toMatch(/conversation_id: resultado\.conversation_id/);
    expect(rota).toMatch(/erro_envio/);
  });

  it("o dossiê oferece começar quando não há conversa", () => {
    // Este componente devolvia `null` sem conversa. Era o caso mais comum de
    // todos — o cliente que a gente ainda não chamou — virando o único sem saída.
    const fonte = readFileSync("components/kanban/ConversaNoDossie.tsx", "utf8");
    expect(fonte).toMatch(/ChamarNoWhatsAppDialog/);
    // Sem contato não há a quem escrever, e aí o bloco continua sumindo.
    expect(fonte).toMatch(/if \(!contactId\) return null;/);
  });
});
