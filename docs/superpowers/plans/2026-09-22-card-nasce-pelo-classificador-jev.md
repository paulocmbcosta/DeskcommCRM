# O card nasce quando a conversa é comercial (classificador Jev) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Com a regra "Só conversas comerciais" ligada numa organização, a primeira mensagem deixa de abrir card no CRM; a cada mensagem recebida de um contato **sem card aberto**, o Jev (TypeSafe, via OpenRouter) decide se a conversa é comercial, e só então o card nasce, com o motivo registrado na linha do tempo. Quem já tem card não gera chamada nenhuma ao Jev.

**Architecture:** O ingest (`lib/channels/pos-entrada.ts` → `garantirLeadDaConversa`) passa a consultar `organizations.settings.crm.nascimento_do_card`. No modo `classificador`, ele não cria o card. Um handler novo do `event_log` (`classificador-comercial.v1`, em `message.received`) roda assíncrono no serviço `worker`: confere se o contato já tem card (se tiver, para ali), monta o estado com as últimas mensagens, chama `POST https://openrouter.ai/api/v1/systemone` com o modelo `typesafe/jev-1.13` e, se a probabilidade passar do limiar, cria o card pela **mesma** função de sempre (`garantirLeadDaConversa`, com trava contra duplicata). A falha do classificador cria o card como hoje, com a causa na linha do tempo.

**Tech Stack:** Next.js 16 / TypeScript estrito, Supabase (admin client no worker), Zod 4, Vitest (unit + invariantes com Postgres real via `pnpm test:db`), Playwright (e2e), API System One do Jev pela OpenRouter.

> **Registro da execução (22/09/2026):** as Tarefas 1–3 mudaram a interface prevista aqui. `RespostaDoJev` passou a ter `assunto: string | null`, `tokensDeEntrada: number | null` e `custoEmCentavos: number | null` (o custo real que a OpenRouter devolve em `usage.cost`); `FalhaDoJev.status` pode ser `null` em qualquer tipo; `custoEmCentavos()` recebe e devolve `number | null`. A redação do `detalhe` reusa `lib/ai/redigir-mensagem-do-provedor.ts` (extraída de `run-model-call.ts`), e a extração consertou um defeito antigo: desde a 1.2.0 a redação de chave em `llm_calls.error_message` nunca funcionava (byte 0x08 no lugar de `\b`). A sonda lê a chave de `.env.sonda`, e mediu 12/12 com mediana de ~315 ms. O texto das Tarefas 3 e 8 abaixo já reflete isso; o código de referência das Tarefas 1 e 2 é o que está no repositório.

---

## Decisões

**Do dono do produto (22/09/2026):**

1. Classificador = **Jev via OpenRouter**, pelo custo (US$ 0,042 por milhão de tokens de entrada, saída grátis — conferido no catálogo da OpenRouter em 22/09: `typesafe/jev-1.13`, `pricing.prompt = 0.000000042`, `completion = 0`) e pela latência.
2. O card **não** nasce no começo da conversa.
3. A cada mensagem recebida: se o contato já tem card aberto, **não chama o Jev**. Se não tem, chama. Se for comercial, cria o card e registra isso na linha do tempo. Depois disso, as mensagens seguintes não chamam mais o Jev, porque o card existe.

**Tomadas neste plano. Confirmar com o dono antes da Task 6:**

| # | Decisão | Por quê |
|---|---|---|
| A | Classificador indisponível (sem chave, chave recusada/sem saldo, fora do ar por mais de 10 min, resposta fora do formato) ⇒ **o card nasce como hoje**, com a causa na linha do tempo | Card a mais se arquiva; card a menos é venda que some sem ninguém ver (a mesma regra de `lib/leads/nascimento-do-lead.ts`) |
| B | Limiar padrão **70%**, com opções de 60/70/80/90% na tela | A doc do Jev manda começar conservador e ajustar com dado real |
| C | **Cancelamento não conta como comercial** | Não estava na lista do dono (contratação, mudança de plano, conhecer planos) |
| D | Versão **fixa** `typesafe/jev-1.13`, não `~typesafe/jev-latest` | A doc do Jev: o alias muda de modelo sozinho e desafina o limiar calibrado |
| E | O Jev lê as **últimas 12 mensagens** (cliente e atendente), cada uma cortada em 500 caracteres | A doc do Jev: estado grande com texto irrelevante derruba a acurácia |
| F | Regra **por organização**, desligada por padrão. Nenhuma instalação muda sozinha | Self-host: atualização não pode mudar comportamento sem o operador pedir |
| G | Classificação "não comercial" fica registrada em **IA › Execuções** (`llm_calls`, `purpose = commercial_classify`) e no log, **não** na linha do tempo | A linha do tempo registra mudança de estado; "ainda não é comercial" não muda nada |

**Riscos medidos na doc do Jev (e onde este plano os trata):**

- Português não é a língua principal do Jev ("test on your own content") → **Task 3** mede com conversas de exemplo antes de construir o resto; **Task 15** calibra com conversas reais da Totus.
- Leitura literal → critérios explícitos do que conta e do que não conta (Task 1).
- Limite de uso "pode mudar sem aviso" → 429/529 viram nova tentativa com teto de 10 min, e depois a regra A.
- Sem retenção zero de dados fora do plano empresarial → o texto das conversas passa pela OpenRouter e pela TypeSafe. **Decisão do dono antes de ligar em produção (Task 15).**

**O que este plano NÃO faz (fica para depois, se o dado pedir):** critério "o que conta como comercial" editável por organização; funil de retenção para cancelamento; botão "Criar negócio" no Inbox para corrigir um "não" errado (hoje o humano já cria o card pelo quadro); uso do Jev fora da decisão de card.

---

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `lib/classificador-comercial/perguntas.ts` (novo) | Puro: modelo fixo, perguntas ao Jev, montagem do estado, assuntos e rótulos, decisão pelo limiar |
| `lib/classificador-comercial/jev.ts` (novo) | Cliente HTTP do System One pela OpenRouter; classifica falhas; custo em centavos |
| `lib/classificador-comercial/chave.ts` (novo) | Chave da OpenRouter: a da organização (IA › Credenciais), senão a da instalação |
| `lib/classificador-comercial/dados.ts` (novo) | Leituras do worker (regra, card aberto, bloqueio, mensagem, últimas mensagens), atrás de uma interface para teste |
| `workers/classificador-comercial.ts` (novo) | Orquestra uma classificação; grava `llm_calls` |
| `workers/classificador-comercial.handler.ts` (novo) | Adaptador para o dispatcher do `event_log` |
| `scripts/sondar-jev.ts` (novo) | Sonda real: manda conversas de exemplo ao Jev e imprime acerto e latência |
| `tests/fixtures/jev/conversas-de-exemplo.json` (novo) | 12 conversas sintéticas rotuladas (sem dado pessoal) |
| `tests/fixtures/jev/resposta-real.json` (novo, gerado na Task 3) | Resposta crua do Jev pela OpenRouter: o contrato medido |
| `lib/schemas/settings.ts` | `settings.crm.nascimento_do_card`: leitura que perdoa, escrita estrita |
| `lib/leads/modo-de-nascimento.ts` (novo) | Lê a regra no servidor; nunca lança |
| `lib/leads/nascimento-do-lead.ts` | Recebe a ORIGEM do nascimento; o ingest respeita a regra; razão da linha do tempo por origem |
| `lib/event-log/register-handlers.ts` | Registra o handler novo |
| `lib/ai/pontos/registro.ts` | Ponto de IA `commercial_classify` (fixo: openrouter / `typesafe/jev-1.13`) |
| `app/actions/settings/definirNascimentoDoCard.ts` (novo) | Server action: grava a regra (admin), recusa ligar sem chave, audita |
| `lib/audit/actions.ts` | Ação `crm.nascimento_do_card_alterado` |
| `components/crm/NascimentoDoCard.tsx` (novo) | Seção "Quando o card nasce" |
| `app/app/settings/tenant/pipelines/page.tsx` | Monta a seção no topo da tela de funis (porta de navegação já existe) |
| `lib/i18n/dicionario.ts` | Textos novos em espanhol |
| `lib/env.ts`, `.env.example` | `CLASSIFICADOR_COMERCIAL_BASE_URL` (opcional; padrão OpenRouter) |
| `docs/architecture/card-pelo-classificador.architecture.json` (novo) + `README.md` | Mapa vivo |
| `.changes/card-nasce-pelo-classificador.md` (novo) | Fragmento de release |
| `scripts/seed-e2e-classificador-comercial.ts` (novo), `tests/e2e/card-pelo-classificador.spec.ts` (novo), `.github/workflows/e2e.yml` | Prova pela tela com um Jev falso local |

**Sem migration:** a regra mora em `organizations.settings` (jsonb já existente) e é gravada pelo admin client no molde de `definirExigenciaDeMfa` (`app/actions/auth/politicaDeMfa.ts`). `llm_calls.purpose` não tem CHECK. A constraint de provedor de `ai_provider_credentials` já foi removida (baseline, linha ~11111), então credencial `openrouter` por organização já é aceita.

---

### Task 1: Perguntas, estado e decisão (puro)

**Files:**
- Create: `lib/classificador-comercial/perguntas.ts`
- Test: `tests/unit/classificador-comercial-perguntas.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/classificador-comercial-perguntas.test.ts
import { describe, expect, it } from "vitest";

import {
  ASSUNTOS,
  ASSUNTOS_COMERCIAIS,
  decidir,
  LIMITE_DE_CARACTERES_POR_MENSAGEM,
  LIMITE_DE_MENSAGENS,
  MODELO_DO_JEV,
  montarEstado,
  PERGUNTAS,
  ROTULO_DO_ASSUNTO,
} from "@/lib/classificador-comercial/perguntas";

describe("montarEstado", () => {
  it("rotula quem falou e mantém a ordem da conversa", () => {
    const estado = montarEstado([
      { direcao: "inbound", texto: "boa tarde" },
      { direcao: "outbound", texto: "Olá! Como posso ajudar?" },
      { direcao: "inbound", texto: "quero aumentar minha internet" },
    ]);
    expect(estado).toEqual({
      conversa: [
        { quem: "cliente", texto: "boa tarde" },
        { quem: "atendente", texto: "Olá! Como posso ajudar?" },
        { quem: "cliente", texto: "quero aumentar minha internet" },
      ],
    });
  });

  it("guarda só as últimas mensagens e corta as longas", () => {
    const muitas = Array.from({ length: 30 }, (_, i) => ({
      direcao: "inbound" as const,
      texto: `mensagem ${i} ${"x".repeat(900)}`,
    }));
    const estado = montarEstado(muitas)!;
    expect(estado.conversa).toHaveLength(LIMITE_DE_MENSAGENS);
    expect(estado.conversa[0]!.texto.startsWith("mensagem 18 ")).toBe(true);
    expect(estado.conversa.every((m) => m.texto.length <= LIMITE_DE_CARACTERES_POR_MENSAGEM)).toBe(true);
  });

  it("ignora mensagem sem texto (mídia ainda sem transcrição)", () => {
    const estado = montarEstado([
      { direcao: "inbound", texto: null },
      { direcao: "inbound", texto: "   " },
      { direcao: "inbound", texto: "tem plano de 1 giga?" },
    ]);
    expect(estado?.conversa).toEqual([{ quem: "cliente", texto: "tem plano de 1 giga?" }]);
  });

  it("sem nenhuma fala do cliente não há o que classificar", () => {
    expect(montarEstado([{ direcao: "outbound", texto: "Promoção de setembro!" }])).toBeNull();
    expect(montarEstado([])).toBeNull();
  });
});

describe("PERGUNTAS", () => {
  it("uma noul para a decisão e uma choice para o motivo, e nada mais", () => {
    expect(PERGUNTAS.comercial.type).toBe("noul");
    expect(PERGUNTAS.assunto.type).toBe("choice");
    expect(Object.keys(PERGUNTAS.assunto.criteria)).toEqual(Object.keys(ASSUNTOS));
  });

  it("o modelo é uma versão FIXA, nunca o alias que muda sozinho", () => {
    expect(MODELO_DO_JEV).toBe("typesafe/jev-1.13");
    expect(MODELO_DO_JEV).not.toContain("latest");
  });

  it("cancelamento, suporte e financeiro não são comerciais (decisão C)", () => {
    expect([...ASSUNTOS_COMERCIAIS].sort()).toEqual(["conhecer_planos", "contratacao", "mudanca_de_plano"]);
  });

  it("todo assunto tem rótulo legível para a linha do tempo", () => {
    for (const a of Object.keys(ASSUNTOS)) expect(ROTULO_DO_ASSUNTO[a as keyof typeof ASSUNTOS]).toBeTruthy();
  });
});

describe("decidir", () => {
  const base = { assunto: "mudanca_de_plano", confiancaDoAssunto: 0.8, modelo: "jev-1.13.0", tokensDeEntrada: 500 };

  it("cria quando a probabilidade alcança o limiar", () => {
    expect(decidir({ ...base, comercial: 0.7 }, 0.7)).toEqual({ criar: true, assunto: "mudanca_de_plano", probabilidade: 0.7 });
  });

  it("não cria abaixo do limiar", () => {
    expect(decidir({ ...base, comercial: 0.69 }, 0.7).criar).toBe(false);
  });

  it("assunto fora da lista vira 'outro' — nunca um rótulo inventado", () => {
    expect(decidir({ ...base, comercial: 0.9, assunto: "vendas" }, 0.7).assunto).toBe("outro");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/classificador-comercial-perguntas.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/classificador-comercial/perguntas"`.

- [ ] **Step 3: Implementar**

```ts
// lib/classificador-comercial/perguntas.ts
/**
 * O QUE O JEV LÊ E O QUE ELE RESPONDE — a parte pura do classificador comercial.
 *
 * O Jev (TypeSafe) não gera texto: recebe um ESTADO e perguntas tipadas e
 * devolve probabilidades. Duas perguntas, cada decisão feita de UM jeito só (a
 * doc do Jev avisa que noul e choice sobre a mesma coisa não somam 1):
 *
 *  - `comercial` (noul) DECIDE: probabilidade de o cliente querer contratar,
 *    mudar de plano ou conhecer planos. Contra o limiar da organização.
 *  - `assunto` (choice) só EXPLICA: vai para a linha do tempo e para o log.
 *
 * Critérios escritos com o que conta E o que não conta, porque o Jev lê ao pé
 * da letra ("answers the question you wrote, not the one you meant").
 *
 * Nenhum nome de funil, de organização ou de nicho aparece aqui: "plano" e
 * "serviço" servem a provedor de internet, clínica e loja.
 */

/** Versão FIXA: o alias `~typesafe/jev-latest` troca de modelo sozinho e desafina o limiar. */
export const MODELO_DO_JEV = "typesafe/jev-1.13";

/** Quantas falas o Jev lê. Estado grande com texto irrelevante derruba a acurácia. */
export const LIMITE_DE_MENSAGENS = 12;
export const LIMITE_DE_CARACTERES_POR_MENSAGEM = 500;

export interface MensagemParaEstado {
  direcao: "inbound" | "outbound";
  /** Corpo, ou transcrição/descrição da mídia. `null` = ainda sem texto. */
  texto: string | null;
}

export interface EstadoDoJev {
  conversa: Array<{ quem: "cliente" | "atendente"; texto: string }>;
}

export function montarEstado(mensagens: MensagemParaEstado[]): EstadoDoJev | null {
  const conversa = mensagens
    .map((m) => ({
      quem: m.direcao === "inbound" ? ("cliente" as const) : ("atendente" as const),
      texto: (m.texto ?? "").trim(),
    }))
    .filter((m) => m.texto !== "")
    .slice(-LIMITE_DE_MENSAGENS)
    .map((m) => ({ ...m, texto: m.texto.slice(0, LIMITE_DE_CARACTERES_POR_MENSAGEM) }));

  // Só o atendente falando (campanha, aviso) não é conversa a classificar.
  if (!conversa.some((m) => m.quem === "cliente")) return null;
  return { conversa };
}

export const ASSUNTOS = {
  contratacao: "Quer contratar ou comprar um produto ou serviço pela primeira vez",
  mudanca_de_plano: "Já é cliente e quer mudar, ampliar ou trocar de plano, produto ou serviço",
  conhecer_planos: "Quer conhecer planos, produtos, preços, promoções ou disponibilidade antes de decidir",
  suporte: "Relata problema técnico, serviço que não funciona ou pede ajuda para usar o que já tem",
  financeiro: "Fala de boleto, segunda via, fatura, pagamento, cobrança ou desbloqueio por pagamento",
  cancelamento: "Quer cancelar, encerrar ou suspender o serviço",
  outro: "Só cumprimentou, ainda não disse o assunto, ou fala de fornecedor, vaga de emprego ou assunto pessoal",
} as const;

export type Assunto = keyof typeof ASSUNTOS;

/** Decisão C do plano: cancelamento fica de fora. */
export const ASSUNTOS_COMERCIAIS: ReadonlySet<Assunto> = new Set<Assunto>([
  "contratacao",
  "mudanca_de_plano",
  "conhecer_planos",
]);

export const ROTULO_DO_ASSUNTO: Record<Assunto, string> = {
  contratacao: "contratação",
  mudanca_de_plano: "mudança de plano",
  conhecer_planos: "conhecer planos e preços",
  suporte: "suporte",
  financeiro: "financeiro",
  cancelamento: "cancelamento",
  outro: "sem assunto definido",
};

export const PERGUNTAS = {
  comercial: {
    type: "noul",
    instructions:
      "Na `conversa`, o cliente quer comprar ou contratar algo, mudar ou ampliar um plano ou serviço que já tem, ou conhecer planos, produtos e preços?",
    criteria: {
      true: "O cliente pede ou demonstra interesse em contratar, comprar, mudar de plano, ampliar o serviço ou saber planos e preços",
      false:
        "O cliente só cumprimentou, ou fala de suporte técnico, boleto, pagamento, cobrança, cancelamento, reclamação, fornecedor ou assunto pessoal",
    },
  },
  assunto: {
    type: "choice",
    instructions: "Qual é o assunto principal do cliente na `conversa`?",
    criteria: ASSUNTOS,
  },
} as const;

/** A resposta do Jev já traduzida para o que o produto usa. */
export interface RespostaDoJev {
  comercial: number;
  assunto: string;
  confiancaDoAssunto: number | null;
  /** Versão que respondeu, como o provedor a devolveu (ex.: `jev-1.13.0`). */
  modelo: string;
  tokensDeEntrada: number;
}

export interface Decisao {
  criar: boolean;
  assunto: Assunto;
  probabilidade: number;
}

export function decidir(resposta: RespostaDoJev, limiar: number): Decisao {
  const assunto: Assunto = resposta.assunto in ASSUNTOS ? (resposta.assunto as Assunto) : "outro";
  return { criar: resposta.comercial >= limiar, assunto, probabilidade: resposta.comercial };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/classificador-comercial-perguntas.test.ts`
Expected: PASS (11 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/classificador-comercial/perguntas.ts tests/unit/classificador-comercial-perguntas.test.ts
git commit -m "feat(classificador-comercial): perguntas ao Jev, estado e decisão pelo limiar"
```

---

### Task 2: Cliente HTTP do Jev pela OpenRouter

**Files:**
- Create: `lib/classificador-comercial/jev.ts`
- Test: `tests/unit/classificador-comercial-jev.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/classificador-comercial-jev.test.ts
import { describe, expect, it } from "vitest";

import { custoEmCentavos, perguntarAoJev } from "@/lib/classificador-comercial/jev";
import { MODELO_DO_JEV } from "@/lib/classificador-comercial/perguntas";

const ESTADO = { conversa: [{ quem: "cliente" as const, texto: "quero mudar meu plano" }] };

/** O formato da doc da TypeSafe. A Task 3 troca isto pela resposta REAL medida. */
const RESPOSTA_DOCUMENTADA = {
  model: "jev-1.13.0",
  answers: {
    comercial: { type: "noul", noul: 0.93 },
    assunto: {
      type: "choice",
      choice: "mudanca_de_plano",
      confidence: 0.81,
      probabilities: { mudanca_de_plano: 0.88, suporte: 0.05 },
    },
  },
  usage: { input_tokens: 812, output_tokens: 40 },
};

function fetchQueDevolve(status: number, corpo: unknown) {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    chamadas.push({ url, init });
    return new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status });
  }) as unknown as typeof fetch;
  return { f, chamadas };
}

describe("perguntarAoJev", () => {
  it("manda state + questions para /systemone da OpenRouter, com a chave no header", async () => {
    const { f, chamadas } = fetchQueDevolve(200, RESPOSTA_DOCUMENTADA);
    await perguntarAoJev({ apiKey: "sk-or-teste", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe("https://openrouter.ai/api/v1/systemone");
    const headers = chamadas[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-teste");
    const corpo = JSON.parse(String(chamadas[0]!.init.body)) as Record<string, unknown>;
    expect(corpo.model).toBe("typesafe/jev-1.13");
    expect(corpo.state).toEqual(ESTADO);
    expect(Object.keys(corpo.questions as object).sort()).toEqual(["assunto", "comercial"]);
  });

  it("traduz a resposta para o que o produto usa", async () => {
    const { f } = fetchQueDevolve(200, RESPOSTA_DOCUMENTADA);
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(r.ok && r.resposta).toEqual({
      comercial: 0.93,
      assunto: "mudanca_de_plano",
      confiancaDoAssunto: 0.81,
      modelo: "jev-1.13.0",
      tokensDeEntrada: 812,
    });
  });

  it.each([401, 402, 403])("%i é problema de conta — tentar de novo não resolve", async (status) => {
    const { f } = fetchQueDevolve(status, { error: { message: "Insufficient credits" } });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha).toMatchObject({ tipo: "conta", status });
  });

  it.each([408, 429, 500, 502, 529])("%i é temporário", async (status) => {
    const { f } = fetchQueDevolve(status, "sobrecarregado");
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha).toMatchObject({ tipo: "temporaria", status });
  });

  it("400 é contrato — o pedido está errado, não o serviço", async () => {
    const { f } = fetchQueDevolve(400, { error: "questions inválidas" });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha.tipo).toBe("contrato");
  });

  it("rede caída ou tempo esgotado é temporário, e nunca lança", async () => {
    const f = (async () => {
      throw new DOMException("tempo esgotado", "TimeoutError");
    }) as unknown as typeof fetch;
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha).toMatchObject({ tipo: "temporaria", status: null, detalhe: "TimeoutError" });
  });

  it("200 com corpo fora do formato é contrato, e nunca lança", async () => {
    const { f } = fetchQueDevolve(200, { answers: {} });
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(!r.ok && r.falha.tipo).toBe("contrato");
  });

  it("base configurável, sem barra dupla", async () => {
    const { f, chamadas } = fetchQueDevolve(200, RESPOSTA_DOCUMENTADA);
    await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f, baseUrl: "http://127.0.0.1:3998/" });
    expect(chamadas[0]!.url).toBe("http://127.0.0.1:3998/systemone");
  });
});

describe("custoEmCentavos", () => {
  it("US$ 0,042 por milhão de tokens de entrada = 4,2 centavos por milhão", () => {
    expect(custoEmCentavos(1_000_000)).toBeCloseTo(4.2, 10);
    expect(custoEmCentavos(2_000)).toBeCloseTo(0.0084, 10);
    expect(custoEmCentavos(0)).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/classificador-comercial-jev.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/classificador-comercial/jev"`.

- [ ] **Step 3: Implementar**

```ts
// lib/classificador-comercial/jev.ts
/**
 * O CLIENTE DO JEV — a API System One da TypeSafe, pela OpenRouter.
 *
 * Não é chat: é `POST {base}/systemone` com `{ model, state, questions }`, e a
 * resposta são probabilidades (`answers.<id>.noul`, `answers.<id>.choice`).
 * Por isso não passa pelo AI SDK nem pelo `runModelCall`: os dois falam
 * `chat/completions`.
 *
 * NUNCA LANÇA. Toda falha volta classificada, porque quem chama decide coisas
 * diferentes para cada uma:
 *  - `conta` (401/402/403): chave recusada ou sem saldo. Tentar de novo não resolve.
 *  - `temporaria` (408/429/5xx/rede/tempo): tentar de novo resolve.
 *  - `contrato` (outro 4xx, ou 200 fora do formato): o pedido ou a resposta
 *    mudou. É defeito nosso ou do provedor, e precisa aparecer.
 *
 * O `detalhe` nunca carrega a chave: vem do corpo de erro do provedor ou do
 * NOME do erro de rede.
 */
import { z } from "zod";

import { PERGUNTAS, type EstadoDoJev, type RespostaDoJev } from "./perguntas";

export const OPENROUTER_BASE_PADRAO = "https://openrouter.ai/api/v1";
export const TEMPO_LIMITE_MS = 8_000;

/** US$ 0,042 por milhão de tokens de entrada; saída não é cobrada (catálogo da OpenRouter, 22/09/2026). */
export const CENTAVOS_POR_MILHAO_DE_TOKENS = 4.2;

export type FalhaDoJev =
  | { tipo: "temporaria"; status: number | null; detalhe: string }
  | { tipo: "conta"; status: number; detalhe: string }
  | { tipo: "contrato"; status: number | null; detalhe: string };

export type ResultadoDoJev =
  | { ok: true; resposta: RespostaDoJev; latenciaMs: number }
  | { ok: false; falha: FalhaDoJev; latenciaMs: number };

/** Só o que o produto usa. `passthrough` implícito: campo novo do provedor não quebra. */
const respostaSchema = z.object({
  model: z.string().optional(),
  answers: z.object({
    comercial: z.object({ noul: z.number().min(0).max(1) }),
    assunto: z.object({
      choice: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  }),
  usage: z.object({ input_tokens: z.number().int().nonnegative() }).optional(),
});

/**
 * Custo EXATO, fracionário. `computeCost` (lib/ai/cost.ts) arredonda para
 * cima em centavo inteiro — uma chamada de US$ 0,0001 viraria 1 centavo, cem
 * vezes o real, e o teto de orçamento da organização estouraria de mentira.
 */
export function custoEmCentavos(tokensDeEntrada: number): number {
  return (tokensDeEntrada * CENTAVOS_POR_MILHAO_DE_TOKENS) / 1_000_000;
}

export async function perguntarAoJev(entrada: {
  apiKey: string;
  estado: EstadoDoJev;
  modelo: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  tempoLimiteMs?: number;
  cabecalhosExtras?: Record<string, string>;
}): Promise<ResultadoDoJev> {
  const inicio = Date.now();
  const base = (entrada.baseUrl?.trim() || OPENROUTER_BASE_PADRAO).replace(/\/+$/, "");
  const f = entrada.fetchImpl ?? fetch;

  let resp: Response;
  try {
    resp = await f(`${base}/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${entrada.apiKey}`,
        "Content-Type": "application/json",
        ...(entrada.cabecalhosExtras ?? {}),
      },
      body: JSON.stringify({ model: entrada.modelo, state: entrada.estado, questions: PERGUNTAS }),
      signal: AbortSignal.timeout(entrada.tempoLimiteMs ?? TEMPO_LIMITE_MS),
    });
  } catch (err) {
    return {
      ok: false,
      latenciaMs: Date.now() - inicio,
      falha: { tipo: "temporaria", status: null, detalhe: err instanceof Error ? err.name : "rede" },
    };
  }

  const latenciaMs = Date.now() - inicio;
  if (!resp.ok) {
    const detalhe = (await resp.text().catch(() => "")).slice(0, 200);
    const s = resp.status;
    if (s === 401 || s === 402 || s === 403) return { ok: false, latenciaMs, falha: { tipo: "conta", status: s, detalhe } };
    if (s === 408 || s === 429 || s >= 500) return { ok: false, latenciaMs, falha: { tipo: "temporaria", status: s, detalhe } };
    return { ok: false, latenciaMs, falha: { tipo: "contrato", status: s, detalhe } };
  }

  const corpo: unknown = await resp.json().catch(() => null);
  const lido = respostaSchema.safeParse(corpo);
  if (!lido.success) {
    return {
      ok: false,
      latenciaMs,
      falha: { tipo: "contrato", status: resp.status, detalhe: "resposta fora do formato esperado" },
    };
  }

  const a = lido.data;
  return {
    ok: true,
    latenciaMs,
    resposta: {
      comercial: a.answers.comercial.noul,
      assunto: a.answers.assunto.choice,
      confiancaDoAssunto: a.answers.assunto.confidence ?? null,
      modelo: a.model ?? entrada.modelo,
      tokensDeEntrada: a.usage?.input_tokens ?? 0,
    },
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/classificador-comercial-jev.test.ts`
Expected: PASS (15 testes: 14 de `perguntarAoJev` contando os `each`, mais o de custo).

- [ ] **Step 5: Commit**

```bash
git add lib/classificador-comercial/jev.ts tests/unit/classificador-comercial-jev.test.ts
git commit -m "feat(classificador-comercial): cliente do Jev pela OpenRouter, com falhas classificadas"
```

---

### Task 3: Sonda real do Jev (o contrato e o português, MEDIDOS)

**Esta task é um portão.** Se a resposta real não bater com o schema da Task 2, ou se o acerto em português for ruim, pare e leve o resultado ao dono antes da Task 4.

**Files:**
- Create: `tests/fixtures/jev/conversas-de-exemplo.json`
- Create: `scripts/sondar-jev.ts`
- Create (gerado): `tests/fixtures/jev/resposta-real.json`
- Modify: `tests/unit/classificador-comercial-jev.test.ts`

**Pré-requisito:** a chave da OpenRouter já está em `OPENROUTER_API_KEY` no arquivo `.env.sonda` na raiz do worktree (gitignored, criado pelo dono). NUNCA imprima, copie ou comite o valor; não leia o arquivo com `cat`. Ela fica fora do `.env.local` para não mudar o roteamento do chat nos testes.

- [ ] **Step 1: Criar as conversas de exemplo (sintéticas, sem dado pessoal)**

```json
[
  { "esperado": "nao", "assunto": "outro", "conversa": [{ "quem": "cliente", "texto": "oi" }] },
  { "esperado": "sim", "assunto": "conhecer_planos", "conversa": [{ "quem": "cliente", "texto": "Oi, quanto custa o plano de 500 mega?" }] },
  { "esperado": "nao", "assunto": "suporte", "conversa": [{ "quem": "cliente", "texto": "Minha internet caiu desde ontem, a luz do aparelho tá vermelha" }] },
  { "esperado": "nao", "assunto": "financeiro", "conversa": [{ "quem": "cliente", "texto": "Preciso da segunda via do boleto de setembro" }] },
  { "esperado": "sim", "assunto": "mudanca_de_plano", "conversa": [{ "quem": "cliente", "texto": "Quero aumentar minha velocidade, hoje tenho 300 mega" }] },
  { "esperado": "sim", "assunto": "contratacao", "conversa": [{ "quem": "cliente", "texto": "Vocês atendem no Setor O? Queria instalar internet em casa" }] },
  { "esperado": "nao", "assunto": "cancelamento", "conversa": [{ "quem": "cliente", "texto": "Quero cancelar meu contrato" }] },
  { "esperado": "sim", "assunto": "mudanca_de_plano", "conversa": [{ "quem": "cliente", "texto": "então moço é que eu mudei de casa e queria ver se dá pra levar a internet e se tem um plano melhor que o meu" }] },
  { "esperado": "nao", "assunto": "suporte", "conversa": [
    { "quem": "cliente", "texto": "boa tarde" },
    { "quem": "atendente", "texto": "Olá! Como posso ajudar?" },
    { "quem": "cliente", "texto": "tô sem sinal nenhum aqui" }
  ] },
  { "esperado": "nao", "assunto": "financeiro", "conversa": [{ "quem": "cliente", "texto": "paguei o boleto mas continua bloqueado" }] },
  { "esperado": "sim", "assunto": "contratacao", "conversa": [{ "quem": "cliente", "texto": "Tem plano empresarial? Tenho uma loja no centro" }] },
  { "esperado": "nao", "assunto": "outro", "conversa": [{ "quem": "cliente", "texto": "Sou fornecedor de cabos de fibra, com quem eu falo?" }] }
]
```

- [ ] **Step 2: Criar o script da sonda**

```ts
// scripts/sondar-jev.ts
/**
 * SONDA DO JEV — manda conversas rotuladas ao Jev pela OpenRouter e imprime o
 * que ele decidiu, com a latência. Mede ANTES de construir o resto: a doc do
 * Jev diz que o português "não funciona igualmente bem" e manda testar.
 *
 * Uso:
 *   npx tsx --env-file=.env.sonda scripts/sondar-jev.ts [arquivo.json] [limiar]
 *   (padrão: tests/fixtures/jev/conversas-de-exemplo.json, limiar 0.7)
 *
 * Grava a PRIMEIRA resposta crua em tests/fixtures/jev/resposta-real.json: o
 * teste do cliente a lê, e é isso que amarra o schema ao contrato REAL.
 * A chave nunca é impressa. Para calibrar com conversas reais de um cliente,
 * use um arquivo FORA do repositório (tem dado pessoal).
 */
import * as fs from "node:fs";

import { perguntarAoJev } from "@/lib/classificador-comercial/jev";
import { decidir, MODELO_DO_JEV, type EstadoDoJev } from "@/lib/classificador-comercial/perguntas";

interface Caso {
  esperado: "sim" | "nao";
  assunto: string;
  conversa: EstadoDoJev["conversa"];
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write("OPENROUTER_API_KEY ausente — coloque no .env.sonda e rode com --env-file=.env.sonda\n");
    process.exit(2);
  }
  const arquivo = process.argv[2] ?? "tests/fixtures/jev/conversas-de-exemplo.json";
  const limiar = Number(process.argv[3] ?? 0.7);
  const casos = JSON.parse(fs.readFileSync(arquivo, "utf8")) as Caso[];

  let cru: unknown = null;
  const fetchQueGuarda: typeof fetch = async (url, init) => {
    const r = await fetch(url, init);
    if (cru === null && r.ok) cru = JSON.parse(await r.clone().text());
    return r;
  };

  let acertos = 0;
  const latencias: number[] = [];
  for (const [i, caso] of casos.entries()) {
    const r = await perguntarAoJev({ apiKey, estado: { conversa: caso.conversa }, modelo: MODELO_DO_JEV, fetchImpl: fetchQueGuarda });
    latencias.push(r.latenciaMs);
    if (!r.ok) {
      process.stdout.write(`#${i + 1} FALHA ${r.falha.tipo} ${r.falha.status ?? "-"} ${r.falha.detalhe}\n`);
      continue;
    }
    const d = decidir(r.resposta, limiar);
    const obtido = d.criar ? "sim" : "nao";
    if (obtido === caso.esperado) acertos++;
    process.stdout.write(
      `#${i + 1} esperado=${caso.esperado}/${caso.assunto} obtido=${obtido}/${d.assunto} ` +
        `p=${r.resposta.comercial.toFixed(2)} ${r.latenciaMs}ms ${obtido === caso.esperado ? "OK" : "ERRO"}\n`,
    );
  }

  if (cru !== null) {
    fs.mkdirSync("tests/fixtures/jev", { recursive: true });
    fs.writeFileSync("tests/fixtures/jev/resposta-real.json", `${JSON.stringify(cru, null, 2)}\n`);
  }
  const ordenadas = [...latencias].sort((a, b) => a - b);
  const mediana = ordenadas[Math.floor(ordenadas.length / 2)] ?? 0;
  process.stdout.write(
    `\nacertos: ${acertos}/${casos.length} (limiar ${limiar}) · latência mediana ${mediana}ms · máx ${ordenadas.at(-1) ?? 0}ms\n`,
  );
}

void main();
```

- [ ] **Step 3: Rodar a sonda**

Run: `npx tsx --env-file=.env.sonda scripts/sondar-jev.ts`
Expected: 12 linhas `#n ...` e um rodapé `acertos: X/12`. Cole a saída inteira no relatório para o dono. Se aparecer `FALHA contrato`, a resposta real diverge da doc: abra `tests/fixtures/jev/resposta-real.json` (ou rode `curl` com a chave para ver o corpo) e ajuste `respostaSchema` na Task 2 antes de seguir.

- [ ] **Step 4: Amarrar o schema ao contrato real**

Acrescente ao fim de `tests/unit/classificador-comercial-jev.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";

describe("contrato REAL medido pela sonda (tests/fixtures/jev/resposta-real.json)", () => {
  it("o schema aceita a resposta que a OpenRouter devolveu de verdade", async () => {
    const caminho = "tests/fixtures/jev/resposta-real.json";
    expect(existsSync(caminho), "rode scripts/sondar-jev.ts (Task 3) — sem a resposta real este teste não prova nada").toBe(true);
    const real = JSON.parse(readFileSync(caminho, "utf8")) as unknown;
    const { f } = fetchQueDevolve(200, real);
    const r = await perguntarAoJev({ apiKey: "k", estado: ESTADO, modelo: MODELO_DO_JEV, fetchImpl: f });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});
```

(Mova os dois `import` para o topo do arquivo, junto dos outros.)

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/classificador-comercial-jev.test.ts`
Expected: PASS (16 testes).

- [ ] **Step 6: Commit**

```bash
git add scripts/sondar-jev.ts tests/fixtures/jev/ tests/unit/classificador-comercial-jev.test.ts
git commit -m "test(classificador-comercial): sonda real do Jev e schema amarrado à resposta medida"
```

- [ ] **Step 7: PORTÃO — relatório ao dono**

Mande ao dono: acertos X/12, as linhas com `ERRO`, a latência mediana e a máxima. **Não siga para a Task 4 sem o "segue".** Se o acerto for baixo, as saídas possíveis são: reescrever critérios (Task 1), mudar o limiar, ou desistir do Jev para esta decisão.

---

### Task 4: A regra da organização (`settings.crm.nascimento_do_card`)

**Files:**
- Modify: `lib/schemas/settings.ts` (depois de `clientePelaAgendaLigado`, ~linha 272)
- Create: `lib/leads/modo-de-nascimento.ts`
- Test: `tests/unit/nascimento-do-card-settings.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/nascimento-do-card-settings.test.ts
import { describe, expect, it, vi } from "vitest";

import {
  NASCIMENTO_DO_CARD_PADRAO,
  nascimentoDoCard,
  nascimentoDoCardWriteSchema,
} from "@/lib/schemas/settings";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe("nascimentoDoCard — leitura que perdoa", () => {
  it("organização sem a chave lê como toda_conversa, o comportamento de sempre", () => {
    expect(nascimentoDoCard({})).toEqual({ modo: "toda_conversa", limiar: 0.7 });
    expect(nascimentoDoCard(null)).toEqual(NASCIMENTO_DO_CARD_PADRAO);
  });

  it("lê o modo classificador e o limiar gravados", () => {
    expect(nascimentoDoCard({ crm: { nascimento_do_card: { modo: "classificador", limiar: 0.8 } } })).toEqual({
      modo: "classificador",
      limiar: 0.8,
    });
  });

  it("lixo cai no padrão — na dúvida, o card nasce", () => {
    expect(nascimentoDoCard({ crm: { nascimento_do_card: { modo: "talvez", limiar: "alto" } } })).toEqual(
      NASCIMENTO_DO_CARD_PADRAO,
    );
    expect(nascimentoDoCard({ crm: "x" })).toEqual(NASCIMENTO_DO_CARD_PADRAO);
  });

  it("não confunde a vizinha cliente_pela_agenda", () => {
    expect(nascimentoDoCard({ crm: { cliente_pela_agenda: true } }).modo).toBe("toda_conversa");
  });
});

describe("nascimentoDoCardWriteSchema — escrita estrita", () => {
  it("aceita só os limiares da tela", () => {
    expect(nascimentoDoCardWriteSchema.safeParse({ modo: "classificador", limiar: 0.7 }).success).toBe(true);
    expect(nascimentoDoCardWriteSchema.safeParse({ modo: "classificador", limiar: 0.75 }).success).toBe(false);
    expect(nascimentoDoCardWriteSchema.safeParse({ modo: "outro", limiar: 0.7 }).success).toBe(false);
  });
});

describe("lerNascimentoDoCard — servidor, nunca lança", () => {
  it("falha de leitura devolve o padrão (o card nasce como sempre)", async () => {
    const { lerNascimentoDoCard } = await import("@/lib/leads/modo-de-nascimento");
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "fora" } }) }) }),
      }),
    } as never;
    expect(await lerNascimentoDoCard(db, "org-1")).toEqual(NASCIMENTO_DO_CARD_PADRAO);
  });

  it("lê a regra gravada", async () => {
    const { lerNascimentoDoCard } = await import("@/lib/leads/modo-de-nascimento");
    const settings = { crm: { nascimento_do_card: { modo: "classificador", limiar: 0.9 } } };
    const db = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings }, error: null }) }) }) }),
    } as never;
    expect(await lerNascimentoDoCard(db, "org-1")).toEqual({ modo: "classificador", limiar: 0.9 });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/nascimento-do-card-settings.test.ts`
Expected: FAIL — `NASCIMENTO_DO_CARD_PADRAO` não exportado / módulo `modo-de-nascimento` inexistente.

- [ ] **Step 3: Implementar em `lib/schemas/settings.ts`** (logo depois de `clientePelaAgendaLigado`)

```ts
/**
 * `organizations.settings.crm.nascimento_do_card` — QUANDO o card nasce.
 *
 * `toda_conversa` (padrão de toda organização, e o comportamento de sempre): a
 * primeira mensagem de quem não tem card abre um no funil de entrada.
 * `classificador`: nenhuma mensagem abre card sozinha. A cada mensagem de um
 * contato SEM card aberto, o Jev decide se a conversa é comercial
 * (`workers/classificador-comercial.ts`), e o card nasce quando a probabilidade
 * alcança o `limiar`.
 *
 * Lixo lê como `toda_conversa`: na dúvida, o card nasce. Card a mais se
 * arquiva; card a menos é venda que some sem ninguém ver.
 */
export const MODOS_DE_NASCIMENTO_DO_CARD = ["toda_conversa", "classificador"] as const;
export type ModoDeNascimentoDoCard = (typeof MODOS_DE_NASCIMENTO_DO_CARD)[number];
/** As opções da tela. A escrita só aceita estas; a leitura aceita qualquer valor em [0.5, 0.95]. */
export const LIMIARES_DO_CLASSIFICADOR = [0.6, 0.7, 0.8, 0.9] as const;
export const NASCIMENTO_DO_CARD_PADRAO = { modo: "toda_conversa", limiar: 0.7 } as const satisfies {
  modo: ModoDeNascimentoDoCard;
  limiar: number;
};

export const nascimentoDoCardSchema = z
  .object({
    modo: z.enum(MODOS_DE_NASCIMENTO_DO_CARD).catch(NASCIMENTO_DO_CARD_PADRAO.modo),
    limiar: z.number().min(0.5).max(0.95).catch(NASCIMENTO_DO_CARD_PADRAO.limiar),
  })
  .catch({ ...NASCIMENTO_DO_CARD_PADRAO });
export type NascimentoDoCard = z.infer<typeof nascimentoDoCardSchema>;

export const nascimentoDoCardWriteSchema = z.object({
  modo: z.enum(MODOS_DE_NASCIMENTO_DO_CARD),
  limiar: z
    .number()
    .refine((v) => (LIMIARES_DO_CLASSIFICADOR as readonly number[]).includes(v), "limiar fora das opções"),
});

/** A regra em vigor. Nunca lança. */
export function nascimentoDoCard(settings: unknown): NascimentoDoCard {
  const objeto = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  return nascimentoDoCardSchema.parse(objeto(objeto(settings)?.crm)?.nascimento_do_card ?? {});
}
```

- [ ] **Step 4: Criar `lib/leads/modo-de-nascimento.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { NASCIMENTO_DO_CARD_PADRAO, nascimentoDoCard, type NascimentoDoCard } from "@/lib/schemas/settings";

/**
 * A regra "quando o card nasce" desta organização — para o SERVIDOR (ingest e
 * worker, ambos com service role; o filtro por organização é explícito).
 *
 * ⚠️ FALHA LÊ COMO `toda_conversa`. Quem consome decide se um card nasce, e
 * errar para o lado de criar é o comportamento de antes da regra existir:
 * visível e corrigível. O erro não some: vai para o log com a organização.
 */
export async function lerNascimentoDoCard(db: SupabaseClient, organizationId: string): Promise<NascimentoDoCard> {
  const { data, error } = await db.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
  if (error) {
    logger.warn("[nascimento-do-card] leitura da regra falhou; seguindo como toda_conversa", {
      organization_id: organizationId,
      error: error.message,
    });
    return { ...NASCIMENTO_DO_CARD_PADRAO };
  }
  return nascimentoDoCard((data as { settings?: unknown } | null)?.settings);
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/nascimento-do-card-settings.test.ts`
Expected: PASS (7 testes).

- [ ] **Step 6: Commit**

```bash
git add lib/schemas/settings.ts lib/leads/modo-de-nascimento.ts tests/unit/nascimento-do-card-settings.test.ts
git commit -m "feat(crm): regra por organização de quando o card nasce (toda conversa | classificador)"
```

---

### Task 5: A chave da OpenRouter

**Files:**
- Create: `lib/classificador-comercial/chave.ts`
- Test: `tests/unit/classificador-comercial-chave.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/classificador-comercial-chave.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: vi.fn(() => "sk-or-da-organizacao"),
  byteaToBuffer: vi.fn((v: unknown) => v),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { chaveDaOpenRouter } = await import("@/lib/classificador-comercial/chave");

/** Imita o builder do PostgREST e guarda os filtros aplicados. */
function adminQueDevolve(linha: unknown, lanca?: Error) {
  const filtros: Array<[string, unknown[]]> = [];
  const cadeia: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "order", "limit"]) {
    cadeia[m] = (...args: unknown[]) => {
      filtros.push([m, args]);
      return cadeia;
    };
  }
  cadeia.maybeSingle = async () => {
    if (lanca) throw lanca;
    return { data: linha, error: null };
  };
  return { admin: { from: () => cadeia } as never, filtros };
}

const CIFRADA = { api_key_encrypted: "c", api_key_iv: "i", api_key_tag: "t" };

describe("chaveDaOpenRouter", () => {
  it("prefere a credencial da ORGANIZAÇÃO, ativa, validada e do provedor openrouter", async () => {
    const { admin, filtros } = adminQueDevolve(CIFRADA);
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: "sk-or-da-instalacao" })).toEqual({
      apiKey: "sk-or-da-organizacao",
      origem: "organizacao",
    });
    expect(filtros).toContainEqual(["eq", ["organization_id", "org-1"]]);
    expect(filtros).toContainEqual(["eq", ["provider", "openrouter"]]);
    expect(filtros).toContainEqual(["eq", ["is_active", true]]);
    expect(filtros).toContainEqual(["not", ["validated_at", "is", null]]);
  });

  it("sem credencial da organização, usa a da instalação", async () => {
    const { admin } = adminQueDevolve(null);
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: " sk-or-da-instalacao " })).toEqual({
      apiKey: "sk-or-da-instalacao",
      origem: "instalacao",
    });
  });

  it("sem nenhuma das duas, null", async () => {
    const { admin } = adminQueDevolve(null);
    expect(await chaveDaOpenRouter(admin, "org-1", {})).toBeNull();
  });

  it("leitura que lança cai para a da instalação, e não derruba quem chamou", async () => {
    const { admin } = adminQueDevolve(null, new Error("tabela fora"));
    expect(await chaveDaOpenRouter(admin, "org-1", { OPENROUTER_API_KEY: "sk-or-x" })).toEqual({
      apiKey: "sk-or-x",
      origem: "instalacao",
    });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/classificador-comercial-chave.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
// lib/classificador-comercial/chave.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";

export type OrigemDaChave = "organizacao" | "instalacao";

/**
 * A chave da OpenRouter que paga o Jev: a da organização (IA › Credenciais),
 * senão a da instalação (`OPENROUTER_API_KEY`).
 *
 * Independe do provedor PADRÃO da organização: quem conversa pode ser Anthropic,
 * e o Jev só existe na OpenRouter. É por isso que isto não reusa
 * `credencialDaOrganizacao` (lib/ai/gateway-binding.ts), que filtra pelo
 * provedor de `settings.llm`.
 *
 * Nunca lança. Plaintext só existe no retorno. O log leva só a CLASSE do erro:
 * a mensagem pode carregar material da credencial.
 */
export async function chaveDaOpenRouter(
  admin: SupabaseClient,
  organizationId: string,
  env: { OPENROUTER_API_KEY?: string } = process.env,
): Promise<{ apiKey: string; origem: OrigemDaChave } | null> {
  try {
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", "openrouter")
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      return {
        origem: "organizacao",
        apiKey: decryptKey({
          ciphertext: byteaToBuffer(data.api_key_encrypted),
          iv: byteaToBuffer(data.api_key_iv),
          tag: byteaToBuffer(data.api_key_tag),
        }),
      };
    }
  } catch (erro) {
    logger.warn("classificador-comercial: credencial da OpenRouter da organização ilegível; tentando a da instalação", {
      organization_id: organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
  }
  const daInstalacao = env.OPENROUTER_API_KEY?.trim();
  return daInstalacao ? { origem: "instalacao", apiKey: daInstalacao } : null;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/classificador-comercial-chave.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/classificador-comercial/chave.ts tests/unit/classificador-comercial-chave.test.ts
git commit -m "feat(classificador-comercial): chave da OpenRouter — a da organização, senão a da instalação"
```

---

### Task 6: `garantirLeadDaConversa` passa a saber QUEM decidiu

**Pré-requisito:** o dono confirmou as decisões A–G.

**Files:**
- Modify: `lib/leads/nascimento-do-lead.ts`
- Test: `tests/invariants/nascimento-do-lead.test.ts` (Postgres real, `pnpm test:db`)

- [ ] **Step 1: Escrever os testes que falham** — em `tests/invariants/nascimento-do-lead.test.ts`:

Acrescente a constante junto das outras orgs:

```ts
/** Org com a regra "só conversas comerciais" ligada. */
const ORG_CLASSIFICADOR = "1ead7e00-0000-4000-8000-000000000005";
```

No `beforeAll`, depois de criar as outras orgs:

```ts
  await criarOrg(ORG_CLASSIFICADOR, "org-nascimento-classificador");
  await pool.query(
    `update organizations
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{crm}',
              '{"nascimento_do_card": {"modo": "classificador", "limiar": 0.7}}'::jsonb)
      where id = $1`,
    [ORG_CLASSIFICADOR],
  );
```

No `afterAll`, acrescente `ORG_CLASSIFICADOR` à lista de `delete from organizations`.

No fim do arquivo:

```ts
describe("regra 'só conversas comerciais' (settings.crm.nascimento_do_card)", () => {
  async function leadsDo(contato: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from crm_leads where organization_id = $1 and contact_id = $2",
      [ORG_CLASSIFICADOR, contato],
    );
    return rows[0]!.n;
  }

  async function atividadeDeCriacao(contato: string) {
    const { rows } = await pool.query<{ reason: string; source_module: string; payload: Record<string, unknown> }>(
      `select reason, source_module, payload from crm_lead_activities
        where organization_id = $1 and contact_id = $2 and type = 'lead_created'`,
      [ORG_CLASSIFICADOR, contato],
    );
    return rows;
  }

  it("o ingest NÃO abre card — espera o classificador", async () => {
    const contato = await criarContato(ORG_CLASSIFICADOR, "Pedro Suporte");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG_CLASSIFICADOR,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: "Pedro Suporte",
    });
    expect(r).toEqual({ criado: false, motivo: "aguarda_classificador" });
    expect(await leadsDo(contato)).toBe(0);
  });

  it("o classificador abre o card, e a linha do tempo diz por quê", async () => {
    const contato = await criarContato(ORG_CLASSIFICADOR, "Ana Comercial");
    const r = await garantirLeadDaConversa(
      db,
      { organizationId: ORG_CLASSIFICADOR, contactId: contato, conversationId: CONVERSA, nomeDoContato: "Ana Comercial" },
      { tipo: "classificador", assunto: "mudanca_de_plano", rotuloDoAssunto: "mudança de plano", probabilidade: 0.93, modelo: "jev-1.13.0" },
    );
    expect(r.criado, JSON.stringify(r)).toBe(true);
    expect(await leadsDo(contato)).toBe(1);

    const [at] = await atividadeDeCriacao(contato);
    expect(at!.reason).toBe("conversa identificada como comercial: mudança de plano (93%)");
    expect(at!.source_module).toBe("crm.classificador_comercial");
    expect(at!.payload.classificacao).toMatchObject({ assunto: "mudanca_de_plano", probabilidade: 0.93, modelo: "jev-1.13.0" });
  });

  it("sem classificação o card nasce mesmo assim, e a razão diz a causa (decisão A)", async () => {
    const contato = await criarContato(ORG_CLASSIFICADOR, "Bruno Sem Chave");
    const r = await garantirLeadDaConversa(
      db,
      { organizationId: ORG_CLASSIFICADOR, contactId: contato, conversationId: CONVERSA, nomeDoContato: "Bruno Sem Chave" },
      { tipo: "sem_classificacao", causa: "sem chave da OpenRouter" },
    );
    expect(r.criado).toBe(true);
    const [at] = await atividadeDeCriacao(contato);
    expect(at!.reason).toBe("card criado sem classificar a conversa (sem chave da OpenRouter)");
  });

  it("o classificador também respeita um por demanda: segundo 'sim' não abre segundo card", async () => {
    const contato = await criarContato(ORG_CLASSIFICADOR, "Carla Duas Vezes");
    const origem = { tipo: "classificador", assunto: "contratacao", rotuloDoAssunto: "contratação", probabilidade: 0.9, modelo: "jev-1.13.0" } as const;
    const dados = { organizationId: ORG_CLASSIFICADOR, contactId: contato, conversationId: CONVERSA, nomeDoContato: "Carla Duas Vezes" };
    await garantirLeadDaConversa(db, dados, origem);
    const segundo = await garantirLeadDaConversa(db, dados, origem);
    expect(segundo).toEqual({ criado: false, motivo: "ja_existe" });
    expect(await leadsDo(contato)).toBe(1);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:db -- tests/invariants/nascimento-do-lead.test.ts` (se o script não aceitar filtro, rode `pnpm test:db` inteiro)
Expected: FAIL — o primeiro caso cria o card (`criado: true`) em vez de `aguarda_classificador`; os outros falham na assinatura.

- [ ] **Step 3: Implementar em `lib/leads/nascimento-do-lead.ts`**

3a. Import (junto dos outros):

```ts
import { lerNascimentoDoCard } from "./modo-de-nascimento";
```

3b. Acrescente `"aguarda_classificador"` ao union `MotivoSemLead`:

```ts
export type MotivoSemLead =
  | "ja_existe" // o contato já tem lead aberto: um por demanda, não um por mensagem
  | "contato_bloqueado" // pediu para sair; criar oportunidade seria desrespeito registrado
  | "aguarda_classificador" // a organização só abre card para conversa comercial, e quem decide é o classificador
  | "sem_funil_de_entrada" // a organização não tem funil padrão — falha de configuração, visível
  | "sem_etapa" // o funil existe e não tem etapa utilizável
  | "erro"; // qualquer falha de escrita
```

3c. Depois de `DadosDoNascimento`, o tipo da origem e a razão:

```ts
/**
 * QUEM decidiu que esta conversa vira card.
 *
 * `ingest`: a mensagem chegou (o caminho de sempre). É o ÚNICO que consulta a
 * regra da organização — no modo `classificador` ele recua.
 * `classificador`: o Jev disse que a conversa é comercial.
 * `sem_classificacao`: o classificador não conseguiu decidir, e o card nasce
 * assim mesmo (decisão A do plano 2026-09-22): card a mais se arquiva, card a
 * menos é venda que some.
 */
export type OrigemDoNascimento =
  | { tipo: "ingest" }
  | { tipo: "classificador"; assunto: string; rotuloDoAssunto: string; probabilidade: number; modelo: string }
  | { tipo: "sem_classificacao"; causa: string };

function razaoDoNascimento(origem: OrigemDoNascimento, ehCliente: boolean): string {
  if (origem.tipo === "classificador") {
    return `conversa identificada como comercial: ${origem.rotuloDoAssunto} (${Math.round(origem.probabilidade * 100)}%)`;
  }
  if (origem.tipo === "sem_classificacao") return `card criado sem classificar a conversa (${origem.causa})`;
  return ehCliente ? "cliente conhecido voltou a escrever" : "primeira mensagem recebida no WhatsApp";
}
```

3d. Assinatura:

```ts
export async function garantirLeadDaConversa(
  db: SupabaseClient,
  dados: DadosDoNascimento,
  origem: OrigemDoNascimento = { tipo: "ingest" },
): Promise<NascimentoDoLead> {
```

3e. Logo depois do bloco `// 2 · já existe demanda aberta?` (depois de `if (existente) return ...`):

```ts
  // 2b · quem decide se a conversa vira card (settings.crm.nascimento_do_card).
  //
  // Só o INGEST pergunta, e só depois do passo 2: quem já tem card não paga a
  // consulta. O classificador não pergunta porque ELE é a decisão — e o caminho
  // de falha dele (`sem_classificacao`) existe justamente para criar mesmo assim.
  if (origem.tipo === "ingest") {
    const regra = await lerNascimentoDoCard(db, organizationId);
    if (regra.modo === "classificador") return { criado: false, motivo: "aguarda_classificador" };
  }
```

3f. Na chamada de `emitLeadActivity`, troque `sourceModule`, `actor`, `reason` e `payload`:

```ts
    sourceModule: origem.tipo === "ingest" ? "canal.ingest" : "crm.classificador_comercial",
    sourceId: conversationId,
    actor: { type: "webhook_source", id: origem.tipo === "ingest" ? "canal-inbound" : "classificador-comercial" },
    reason: razaoDoNascimento(origem, ehCliente),
    payload: {
      conversation_id: conversationId,
      cliente: ehCliente,
      ...(origem.tipo === "classificador"
        ? { classificacao: { assunto: origem.assunto, probabilidade: origem.probabilidade, modelo: origem.modelo } }
        : {}),
      ...(origem.tipo === "sem_classificacao" ? { sem_classificacao: origem.causa } : {}),
    },
```

(Mantenha o comentário existente sobre `canal.ingest` e acrescente uma linha: "`crm.classificador_comercial` quando quem decidiu foi o classificador; a linha do tempo da conversa (`app/api/v1/conversations/[id]/timeline/route.ts`) mostra esta razão.")

3g. Atualize o cabeçalho do arquivo, seção "O SISTEMA CRIA, NÃO O MODELO", com um parágrafo:

```ts
 * ⚠️ DESDE 2026-09-22 HÁ UM SEGUNDO JEITO DE NASCER, e a frase acima continua
 * valendo. Com `settings.crm.nascimento_do_card.modo = 'classificador'`, o
 * ingest recua e quem cria é `workers/classificador-comercial.ts` — ainda o
 * SISTEMA, a cada mensagem de quem não tem card, e nunca o agente lembrando de
 * chamar uma ferramenta. O modelo (o Jev) só responde "é comercial?"; funil,
 * etapa, título e a trava contra duplicata continuam aqui.
```

- [ ] **Step 4: Rodar e ver passar (e o resto do arquivo continuar verde)**

Run: `pnpm test:db`
Expected: a suíte de invariantes inteira verde, incluindo os 4 casos novos e os antigos de `nascimento-do-lead`, `tres-mensagens-um-negocio` e `cliente-nasce-do-agendamento` (a origem padrão é `ingest`, e a regra padrão é `toda_conversa`).

- [ ] **Step 5: Sabotar para provar que o teste vigia**

Troque temporariamente `if (regra.modo === "classificador")` por `if (false)`. Rode `pnpm test:db`: o caso "o ingest NÃO abre card" tem de ficar **vermelho**. Desfaça a sabotagem e confirme verde de novo.

- [ ] **Step 6: Commit**

```bash
git add lib/leads/nascimento-do-lead.ts tests/invariants/nascimento-do-lead.test.ts
git commit -m "feat(crm): o card sabe quem decidiu que ele nasce — ingest recua no modo classificador"
```

---

### Task 7: As leituras do worker

**Files:**
- Create: `lib/classificador-comercial/dados.ts`
- Test: `tests/unit/classificador-comercial-dados.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/classificador-comercial-dados.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { dadosViaSupabase } = await import("@/lib/classificador-comercial/dados");

/** Builder falso: registra filtros e devolve `resultado` no fim da cadeia. */
function dbQueDevolve(porTabela: Record<string, { data: unknown; error: { message: string } | null }>) {
  const filtros: Array<[string, string, unknown[]]> = [];
  return {
    filtros,
    db: {
      from(tabela: string) {
        const cadeia: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit"]) {
          cadeia[m] = (...args: unknown[]) => {
            filtros.push([tabela, m, args]);
            return cadeia;
          };
        }
        cadeia.maybeSingle = async () => porTabela[tabela];
        cadeia.then = (resolve: (v: unknown) => void) => Promise.resolve(porTabela[tabela]).then(resolve);
        return cadeia;
      },
    } as never,
  };
}

describe("dadosViaSupabase", () => {
  it("temCardAberto filtra organização, contato e status open", async () => {
    const { db, filtros } = dbQueDevolve({ crm_leads: { data: { id: "lead-1" }, error: null } });
    expect(await dadosViaSupabase(db).temCardAberto("org-1", "contato-1")).toBe(true);
    expect(filtros).toContainEqual(["crm_leads", "eq", ["organization_id", "org-1"]]);
    expect(filtros).toContainEqual(["crm_leads", "eq", ["contact_id", "contato-1"]]);
    expect(filtros).toContainEqual(["crm_leads", "eq", ["status", "open"]]);
  });

  it("temCardAberto sem linha é false; erro de banco LANÇA (o drain tenta de novo)", async () => {
    expect(await dadosViaSupabase(dbQueDevolve({ crm_leads: { data: null, error: null } }).db).temCardAberto("o", "c")).toBe(false);
    await expect(
      dadosViaSupabase(dbQueDevolve({ crm_leads: { data: null, error: { message: "fora" } } }).db).temCardAberto("o", "c"),
    ).rejects.toThrow("fora");
  });

  it("ultimasMensagens devolve em ordem cronológica, sem sistema, reação ou apagada, e usa a transcrição", async () => {
    const linhas = [
      { direction: "inbound", type: "audio", body: null, media_derived_text: "quero o plano de 1 giga", revoked_at: null },
      { direction: "outbound", type: "system", body: "atendimento aberto", media_derived_text: null, revoked_at: null },
      { direction: "inbound", type: "reaction", body: "👍", media_derived_text: null, revoked_at: null },
      { direction: "inbound", type: "text", body: "mensagem apagada", media_derived_text: null, revoked_at: "2026-09-22T10:00:00Z" },
      { direction: "outbound", type: "text", body: "Olá!", media_derived_text: null, revoked_at: null },
      { direction: "inbound", type: "image", body: "olha a fatura", media_derived_text: "foto de uma fatura", revoked_at: null },
    ]; // do MAIS NOVO para o mais velho, como a consulta devolve
    const { db, filtros } = dbQueDevolve({ messages: { data: linhas, error: null } });
    const r = await dadosViaSupabase(db).ultimasMensagens("org-1", "conversa-1", 24);
    expect(r).toEqual([
      { direcao: "inbound", texto: "olha a fatura — foto de uma fatura" },
      { direcao: "outbound", texto: "Olá!" },
      { direcao: "inbound", texto: "quero o plano de 1 giga" },
    ]);
    expect(filtros).toContainEqual(["messages", "eq", ["organization_id", "org-1"]]);
    expect(filtros).toContainEqual(["messages", "eq", ["conversation_id", "conversa-1"]]);
    expect(filtros).toContainEqual(["messages", "order", ["sent_at", { ascending: false }]]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/classificador-comercial-dados.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
// lib/classificador-comercial/dados.ts
/**
 * O QUE O CLASSIFICADOR LÊ DO BANCO — atrás de uma interface, para o worker
 * ser testado sem Postgres e para a leitura real ter UM lugar.
 *
 * Service role: TODA consulta filtra `organization_id` explicitamente, com o
 * valor vindo da linha do `event_log` (fonte confiável), nunca do payload de
 * fora (CLAUDE.md, anti-pattern 10).
 *
 * Erro de banco LANÇA de propósito: o handler devolve `error` e o drain do
 * `event_log` tenta de novo com backoff. Decidir "sem card" em cima de uma
 * leitura que falhou chamaria o Jev à toa ou, pior, pularia a decisão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerNascimentoDoCard } from "@/lib/leads/modo-de-nascimento";
import type { NascimentoDoCard } from "@/lib/schemas/settings";

import type { MensagemParaEstado } from "./perguntas";

export interface MensagemDisparadora {
  type: string;
  media_derived_status: string | null;
}

export interface DadosDoClassificador {
  regra(organizationId: string): Promise<NascimentoDoCard>;
  temCardAberto(organizationId: string, contactId: string): Promise<boolean>;
  contatoBloqueado(organizationId: string, contactId: string): Promise<boolean>;
  mensagem(organizationId: string, messageId: string): Promise<MensagemDisparadora | null>;
  /** Do mais velho para o mais novo, já sem o que não é fala. */
  ultimasMensagens(organizationId: string, conversationId: string, limite: number): Promise<MensagemParaEstado[]>;
}

const TIPOS_QUE_NAO_SAO_FALA = new Set(["system", "reaction"]);

export function dadosViaSupabase(db: SupabaseClient): DadosDoClassificador {
  return {
    regra: (organizationId) => lerNascimentoDoCard(db, organizationId),

    async temCardAberto(organizationId, contactId) {
      // Mesma régua de `garantirLeadDaConversa` (passo 2): um card aberto do
      // contato, em QUALQUER funil, encerra a decisão.
      const { data, error } = await db
        .from("crm_leads")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data !== null;
    },

    async contatoBloqueado(organizationId, contactId) {
      const { data, error } = await db
        .from("contacts")
        .select("is_blocked")
        .eq("organization_id", organizationId)
        .eq("id", contactId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { is_blocked?: boolean } | null)?.is_blocked === true;
    },

    async mensagem(organizationId, messageId) {
      const { data, error } = await db
        .from("messages")
        .select("type, media_derived_status")
        .eq("organization_id", organizationId)
        .eq("id", messageId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as MensagemDisparadora | null) ?? null;
    },

    async ultimasMensagens(organizationId, conversationId, limite) {
      // Filtro de tipo e de apagada em CÓDIGO: a consulta usa só eq/order/limit,
      // e por isso o `limite` pedido é o dobro do que o Jev lê (quem chama
      // passa LIMITE_DE_MENSAGENS * 2) — sobra para o que for descartado.
      const { data, error } = await db
        .from("messages")
        .select("direction, type, body, media_derived_text, revoked_at")
        .eq("organization_id", organizationId)
        .eq("conversation_id", conversationId)
        .order("sent_at", { ascending: false })
        .limit(limite);
      if (error) throw new Error(error.message);
      const linhas = (data ?? []) as Array<{
        direction: "inbound" | "outbound";
        type: string;
        body: string | null;
        media_derived_text: string | null;
        revoked_at: string | null;
      }>;
      return linhas
        .filter((m) => !TIPOS_QUE_NAO_SAO_FALA.has(m.type) && m.revoked_at === null)
        .reverse()
        .map((m) => ({
          direcao: m.direction,
          texto: [m.body, m.media_derived_text].filter((t): t is string => !!t && t.trim() !== "").join(" — ") || null,
        }));
    },
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/classificador-comercial-dados.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/classificador-comercial/dados.ts tests/unit/classificador-comercial-dados.test.ts
git commit -m "feat(classificador-comercial): leituras do worker atrás de uma interface"
```

---

### Task 8: O worker, o handler e o registro no dispatcher

**Files:**
- Create: `workers/classificador-comercial.ts`
- Create: `workers/classificador-comercial.handler.ts`
- Modify: `lib/event-log/register-handlers.ts`
- Modify: `lib/env.ts` (bloco de AI providers, depois de `OPENROUTER_APP_TITLE`), `.env.example` (depois de `OPENROUTER_BASE_URL=`)
- Test: `tests/unit/classificador-comercial-worker.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/classificador-comercial-worker.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { DadosDoClassificador } from "@/lib/classificador-comercial/dados";
import type { ResultadoDoJev } from "@/lib/classificador-comercial/jev";

const { processarClassificacao } = await import("@/workers/classificador-comercial");
const { classificadorComercialHandler } = await import("@/workers/classificador-comercial.handler");

const AGORA = new Date("2026-09-22T15:00:00Z");

function evento(over: Partial<EventRow> = {}, payload: Record<string, unknown> = {}): EventRow {
  return {
    id: "ev-1",
    organization_id: "org-1",
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "msg-1",
    payload: { message_id: "msg-1", conversation_id: "conv-1", contact_id: "contato-1", direction: "inbound", ...payload },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date(AGORA.getTime() - 5_000).toISOString(),
    ...over,
  };
}

const RESPOSTA_SIM: ResultadoDoJev = {
  ok: true,
  latenciaMs: 180,
  resposta: {
    comercial: 0.93,
    assunto: "mudanca_de_plano",
    confiancaDoAssunto: 0.8,
    modelo: "jev-1.13.0",
    tokensDeEntrada: 700,
    custoEmCentavos: 0.00294,
  },
};
const RESPOSTA_NAO: ResultadoDoJev = {
  ok: true,
  latenciaMs: 150,
  resposta: {
    comercial: 0.08,
    assunto: "suporte",
    confiancaDoAssunto: 0.9,
    modelo: "jev-1.13.0",
    tokensDeEntrada: 650,
    custoEmCentavos: 0.00273,
  },
};

let dados: DadosDoClassificador;
let perguntar: ReturnType<typeof vi.fn>;
let garantir: ReturnType<typeof vi.fn>;
let chave: ReturnType<typeof vi.fn>;
let registrarChamada: ReturnType<typeof vi.fn>;

function deps() {
  return {
    admin: {} as never,
    dados,
    chave: chave as never,
    perguntar: perguntar as never,
    garantir: garantir as never,
    registrarChamada: registrarChamada as never,
    agora: () => AGORA,
  };
}

beforeEach(() => {
  dados = {
    regra: async () => ({ modo: "classificador", limiar: 0.7 }),
    temCardAberto: async () => false,
    contatoBloqueado: async () => false,
    mensagem: async () => ({ type: "text", media_derived_status: null }),
    ultimasMensagens: async () => [{ direcao: "inbound", texto: "quero mudar meu plano para 500 mega" }],
  };
  perguntar = vi.fn(async () => RESPOSTA_SIM);
  garantir = vi.fn(async () => ({ criado: true, leadId: "lead-1", pipelineId: "p", stageId: "s" }));
  chave = vi.fn(async () => ({ apiKey: "sk-or-teste", origem: "organizacao" }));
  registrarChamada = vi.fn();
});

describe("processarClassificacao — quando NÃO chama o Jev", () => {
  it("organização no modo de sempre: pula, sem chamar o Jev", async () => {
    dados.regra = async () => ({ modo: "toda_conversa", limiar: 0.7 });
    expect(await processarClassificacao(evento(), deps())).toEqual({ status: "pulado", motivo: "modo_toda_conversa" });
    expect(perguntar).not.toHaveBeenCalled();
  });

  it("contato que JÁ TEM CARD: pula, sem chamar o Jev (o pedido do dono)", async () => {
    dados.temCardAberto = async () => true;
    expect(await processarClassificacao(evento(), deps())).toEqual({ status: "pulado", motivo: "ja_tem_card" });
    expect(perguntar).not.toHaveBeenCalled();
    expect(chave).not.toHaveBeenCalled();
  });

  it("mensagem nossa (saída) não é classificada", async () => {
    expect(await processarClassificacao(evento({}, { direction: "outbound" }), deps())).toEqual({
      status: "pulado",
      motivo: "nao_e_entrada",
    });
    expect(perguntar).not.toHaveBeenCalled();
  });

  it("contato bloqueado (pediu para sair): pula", async () => {
    dados.contatoBloqueado = async () => true;
    expect((await processarClassificacao(evento(), deps())).status).toBe("pulado");
    expect(perguntar).not.toHaveBeenCalled();
  });

  it("sem nenhuma fala do cliente: pula", async () => {
    dados.ultimasMensagens = async () => [{ direcao: "outbound", texto: "Promoção!" }];
    expect(await processarClassificacao(evento(), deps())).toEqual({ status: "pulado", motivo: "sem_texto_do_cliente" });
    expect(perguntar).not.toHaveBeenCalled();
  });

  it("áudio ainda sendo transcrito: espera e tenta de novo em 15 s", async () => {
    dados.mensagem = async () => ({ type: "audio", media_derived_status: "pending" });
    const r = await processarClassificacao(evento(), deps());
    expect(r).toEqual({ status: "tentar_de_novo", em: new Date(AGORA.getTime() + 15_000), motivo: "aguardando_transcricao" });
    expect(perguntar).not.toHaveBeenCalled();
  });

  it("áudio que passou de 2 min sem transcrição: classifica com o que houver", async () => {
    dados.mensagem = async () => ({ type: "audio", media_derived_status: "pending" });
    const velho = evento({ created_at: new Date(AGORA.getTime() - 121_000).toISOString() });
    expect((await processarClassificacao(velho, deps())).status).toBe("classificado");
  });
});

describe("processarClassificacao — a decisão", () => {
  it("comercial acima do limiar: cria o card com a origem do classificador", async () => {
    const r = await processarClassificacao(evento(), deps());
    expect(r).toEqual({ status: "classificado", criouCard: true, assunto: "mudanca_de_plano", probabilidade: 0.93 });
    expect(garantir).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: "org-1", contactId: "contato-1", conversationId: "conv-1", nomeDoContato: null },
      { tipo: "classificador", assunto: "mudanca_de_plano", rotuloDoAssunto: "mudança de plano", probabilidade: 0.93, modelo: "jev-1.13.0" },
    );
  });

  it("não comercial: não cria card", async () => {
    perguntar.mockResolvedValue(RESPOSTA_NAO);
    expect(await processarClassificacao(evento(), deps())).toEqual({
      status: "classificado",
      criouCard: false,
      assunto: "suporte",
      probabilidade: 0.08,
    });
    expect(garantir).not.toHaveBeenCalled();
  });

  it("respeita o limiar da organização", async () => {
    dados.regra = async () => ({ modo: "classificador", limiar: 0.95 });
    expect((await processarClassificacao(evento(), deps())).status).toBe("classificado");
    expect(garantir).not.toHaveBeenCalled();
  });

  it("registra a chamada em llm_calls, com tokens e latência", async () => {
    await processarClassificacao(evento(), deps());
    expect(registrarChamada).toHaveBeenCalledWith({
      organizationId: "org-1",
      contactId: "contato-1",
      modelo: "jev-1.13.0",
      tokensDeEntrada: 700,
      custoEmCentavos: 0.00294,
      latenciaMs: 180,
      falha: null,
    });
  });
});

describe("processarClassificacao — quando o classificador falha (decisão A)", () => {
  it("sem chave: o card nasce sem classificar, e o Jev não é chamado", async () => {
    chave.mockResolvedValue(null);
    expect(await processarClassificacao(evento(), deps())).toEqual({
      status: "card_sem_classificar",
      causa: "sem chave da OpenRouter",
      criouCard: true,
    });
    expect(perguntar).not.toHaveBeenCalled();
    expect(garantir).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      tipo: "sem_classificacao",
      causa: "sem chave da OpenRouter",
    });
  });

  it("falha temporária recente: tenta de novo em 60 s, sem criar card", async () => {
    perguntar.mockResolvedValue({ ok: false, latenciaMs: 8000, falha: { tipo: "temporaria", status: 529, detalhe: "" } });
    expect(await processarClassificacao(evento(), deps())).toEqual({
      status: "tentar_de_novo",
      em: new Date(AGORA.getTime() + 60_000),
      motivo: "jev_529",
    });
    expect(garantir).not.toHaveBeenCalled();
    expect(registrarChamada).toHaveBeenCalledWith(expect.objectContaining({ falha: expect.objectContaining({ tipo: "temporaria" }) }));
  });

  it("falha temporária há mais de 10 min: o card nasce sem classificar", async () => {
    perguntar.mockResolvedValue({ ok: false, latenciaMs: 8000, falha: { tipo: "temporaria", status: null, detalhe: "TimeoutError" } });
    const velho = evento({ created_at: new Date(AGORA.getTime() - 11 * 60_000).toISOString() });
    const r = await processarClassificacao(velho, deps());
    expect(r).toEqual({
      status: "card_sem_classificar",
      causa: "o classificador ficou fora do ar por mais de 10 minutos",
      criouCard: true,
    });
  });

  it("chave recusada ou sem saldo: o card nasce sem classificar, na hora", async () => {
    perguntar.mockResolvedValue({ ok: false, latenciaMs: 90, falha: { tipo: "conta", status: 402, detalhe: "Insufficient credits" } });
    const r = await processarClassificacao(evento(), deps());
    expect(r).toEqual({
      status: "card_sem_classificar",
      causa: "a OpenRouter recusou o pedido (chave inválida, sem saldo ou pedido barrado)",
      criouCard: true,
    });
  });
});

describe("classificadorComercialHandler", () => {
  it("consome message.received com chave estável", () => {
    expect(classificadorComercialHandler.key).toBe("classificador-comercial.v1");
    expect(classificadorComercialHandler.events).toEqual(["message.received"]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/classificador-comercial-worker.test.ts`
Expected: FAIL — `workers/classificador-comercial` inexistente.

- [ ] **Step 3: Implementar o worker**

```ts
// workers/classificador-comercial.ts
/**
 * O CARD NASCE QUANDO A CONVERSA É COMERCIAL — o classificador (Jev).
 *
 * Consome `message.received` (emitido pelo gatilho `trg_messages_emit_event`
 * em TODO canal), em paralelo com os outros consumidores. Só age quando a
 * organização ligou `settings.crm.nascimento_do_card.modo = 'classificador'`;
 * no modo de sempre quem abre o card é o ingest, e aqui é um `skipped` barato.
 *
 * A ORDEM é o pedido do dono, e é o que economiza o Jev:
 *   1. o contato JÁ TEM card aberto? → para. Nenhuma chamada.
 *   2. não tem → o Jev lê as últimas falas e responde "é comercial?".
 *   3. passou do limiar → o card nasce por `garantirLeadDaConversa` (a mesma
 *      função do ingest: funil de entrada, primeira etapa, trava por contato) e
 *      a linha do tempo diz por quê. Dali em diante o passo 1 encerra tudo.
 *
 * Quando o classificador NÃO consegue decidir, o card nasce assim mesmo, com a
 * causa na linha do tempo (decisão A do plano 2026-09-22). Card a mais se
 * arquiva; card a menos é venda que some sem ninguém ver.
 *
 * Toda chamada, com sucesso ou falha, vira uma linha em `llm_calls`
 * (`purpose = commercial_classify`): é o que aparece em IA › Execuções.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { cabecalhosDeAtribuicaoOpenRouter } from "@/lib/agent-engine/edge/llm/providers";
import { chaveDaOpenRouter } from "@/lib/classificador-comercial/chave";
import { dadosViaSupabase, type DadosDoClassificador } from "@/lib/classificador-comercial/dados";
import { perguntarAoJev, type FalhaDoJev } from "@/lib/classificador-comercial/jev";
import {
  decidir,
  LIMITE_DE_MENSAGENS,
  MODELO_DO_JEV,
  montarEstado,
  ROTULO_DO_ASSUNTO,
} from "@/lib/classificador-comercial/perguntas";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { garantirLeadDaConversa, type DadosDoNascimento } from "@/lib/leads/nascimento-do-lead";
import { logger } from "@/lib/logger";
import { DERIVACAO_TERMINADA, TIPOS_DERIVAVEIS } from "@/lib/messaging/media/derivable";
import { createAdminClient } from "@/lib/supabase/admin";

export const ESPERA_POR_TRANSCRICAO_MS = 15_000;
/** O mesmo teto que o drain do agente usa para esperar a mídia virar texto. */
export const TETO_ESPERA_TRANSCRICAO_MS = 120_000;
export const ESPERA_APOS_FALHA_TEMPORARIA_MS = 60_000;
/** O `retry` do dispatcher não conta tentativa: o teto é pela IDADE do evento. */
export const TETO_DE_FALHA_TEMPORARIA_MS = 10 * 60_000;

export type ResultadoDaClassificacao =
  | { status: "pulado"; motivo: string }
  | { status: "tentar_de_novo"; em: Date; motivo: string }
  | { status: "classificado"; criouCard: boolean; assunto: string; probabilidade: number }
  | { status: "card_sem_classificar"; causa: string; criouCard: boolean };

export interface LinhaDeChamada {
  organizationId: string;
  contactId: string;
  modelo: string;
  /** `null` = o provedor não disse (e aí o custo também é desconhecido). */
  tokensDeEntrada: number | null;
  /** O custo que a própria resposta traz (`RespostaDoJev.custoEmCentavos`); `null` = desconhecido. */
  custoEmCentavos: number | null;
  latenciaMs: number;
  falha: FalhaDoJev | null;
}

export interface DependenciasDoClassificador {
  admin: SupabaseClient;
  dados: DadosDoClassificador;
  chave: typeof chaveDaOpenRouter;
  perguntar: typeof perguntarAoJev;
  garantir: typeof garantirLeadDaConversa;
  registrarChamada: (linha: LinhaDeChamada) => void;
  agora: () => Date;
  baseUrl?: string;
}

/** Fire-and-forget: a telemetria não derruba a decisão que ela descreve. */
function registrarNoLlmCalls(admin: SupabaseClient) {
  return (l: LinhaDeChamada): void => {
    void admin
      .from("llm_calls")
      .insert({
        organization_id: l.organizationId,
        contact_id: l.contactId,
        purpose: "commercial_classify",
        provider: "openrouter",
        model: l.modelo,
        // `input_tokens` é NOT NULL (default 0); quem diz "não sei" é `cost_cents`,
        // que fica `null` quando o custo é desconhecido ou a chamada falhou —
        // a coluna manda: "null = preço desconhecido — nunca inventar 0".
        input_tokens: l.tokensDeEntrada ?? 0,
        output_tokens: 0,
        cost_cents: l.falha ? null : l.custoEmCentavos,
        latency_ms: l.latenciaMs,
        status: l.falha ? "erro" : "ok",
        error_code: l.falha?.tipo ?? null,
        error_message: l.falha?.detalhe ?? null,
        http_status: l.falha?.status ?? null,
      })
      .then(({ error }) => {
        if (error) {
          logger.warn("classificador-comercial: llm_calls não gravou", {
            organization_id: l.organizationId,
            error: error.message.slice(0, 120),
          });
        }
      });
  };
}

function dependenciasReais(): DependenciasDoClassificador {
  const admin = createAdminClient();
  return {
    admin,
    dados: dadosViaSupabase(admin),
    chave: chaveDaOpenRouter,
    perguntar: perguntarAoJev,
    garantir: garantirLeadDaConversa,
    registrarChamada: registrarNoLlmCalls(admin),
    agora: () => new Date(),
    baseUrl: process.env.CLASSIFICADOR_COMERCIAL_BASE_URL?.trim() || undefined,
  };
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function causaLegivel(falha: FalhaDoJev): string {
  // 403 na OpenRouter também é pedido barrado (moderação), não só chave ruim.
  if (falha.tipo === "conta") return "a OpenRouter recusou o pedido (chave inválida, sem saldo ou pedido barrado)";
  if (falha.tipo === "temporaria") return "o classificador ficou fora do ar por mais de 10 minutos";
  return "o classificador respondeu num formato inesperado";
}

async function criarSemClassificar(
  deps: DependenciasDoClassificador,
  dados: DadosDoNascimento,
  causa: string,
): Promise<ResultadoDaClassificacao> {
  const nascimento = await deps.garantir(deps.admin, dados, { tipo: "sem_classificacao", causa });
  logger.warn("classificador-comercial: card criado sem classificar", {
    organization_id: dados.organizationId,
    conversation_id: dados.conversationId,
    causa,
    criado: nascimento.criado,
  });
  return { status: "card_sem_classificar", causa, criouCard: nascimento.criado };
}

export async function processarClassificacao(
  event: EventRow,
  deps: DependenciasDoClassificador = dependenciasReais(),
): Promise<ResultadoDaClassificacao> {
  const p = event.payload ?? {};
  if (p.direction !== "inbound") return { status: "pulado", motivo: "nao_e_entrada" };
  const messageId = texto(p.message_id) ?? event.entity_id;
  const conversationId = texto(p.conversation_id);
  const contactId = texto(p.contact_id);
  if (!messageId || !conversationId || !contactId) return { status: "pulado", motivo: "payload_incompleto" };
  const org = event.organization_id;

  // 1 · a regra. No modo de sempre, o ingest já cuidou do card.
  const regra = await deps.dados.regra(org);
  if (regra.modo !== "classificador") return { status: "pulado", motivo: "modo_toda_conversa" };

  // 2 · JÁ TEM CARD? Então não há o que decidir — e o Jev não é chamado.
  if (await deps.dados.temCardAberto(org, contactId)) return { status: "pulado", motivo: "ja_tem_card" };
  if (await deps.dados.contatoBloqueado(org, contactId)) return { status: "pulado", motivo: "contato_bloqueado" };

  const agora = deps.agora().getTime();
  const idadeMs = event.created_at ? agora - new Date(event.created_at).getTime() : 0;

  // 3 · áudio ainda virando texto: esperar, senão o Jev lê uma conversa vazia.
  const disparadora = await deps.dados.mensagem(org, messageId);
  if (
    disparadora &&
    TIPOS_DERIVAVEIS.has(disparadora.type) &&
    !DERIVACAO_TERMINADA.has(disparadora.media_derived_status ?? "") &&
    idadeMs < TETO_ESPERA_TRANSCRICAO_MS
  ) {
    return { status: "tentar_de_novo", em: new Date(agora + ESPERA_POR_TRANSCRICAO_MS), motivo: "aguardando_transcricao" };
  }

  // 4 · o que o Jev lê.
  const estado = montarEstado(await deps.dados.ultimasMensagens(org, conversationId, LIMITE_DE_MENSAGENS * 2));
  if (!estado) return { status: "pulado", motivo: "sem_texto_do_cliente" };

  const dadosDoCard: DadosDoNascimento = { organizationId: org, contactId, conversationId, nomeDoContato: null };

  const chave = await deps.chave(deps.admin, org);
  if (!chave) return criarSemClassificar(deps, dadosDoCard, "sem chave da OpenRouter");

  // 5 · a pergunta.
  const atribuicao = cabecalhosDeAtribuicaoOpenRouter();
  const r = await deps.perguntar({
    apiKey: chave.apiKey,
    estado,
    modelo: MODELO_DO_JEV,
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(atribuicao ? { cabecalhosExtras: atribuicao } : {}),
  });
  deps.registrarChamada({
    organizationId: org,
    contactId,
    modelo: r.ok ? r.resposta.modelo : MODELO_DO_JEV,
    tokensDeEntrada: r.ok ? r.resposta.tokensDeEntrada : null,
    custoEmCentavos: r.ok ? r.resposta.custoEmCentavos : null,
    latenciaMs: r.latenciaMs,
    falha: r.ok ? null : r.falha,
  });

  if (!r.ok) {
    if (r.falha.tipo === "temporaria" && idadeMs < TETO_DE_FALHA_TEMPORARIA_MS) {
      return {
        status: "tentar_de_novo",
        em: new Date(agora + ESPERA_APOS_FALHA_TEMPORARIA_MS),
        motivo: `jev_${r.falha.status ?? "rede"}`,
      };
    }
    logger.error("classificador-comercial: o Jev não decidiu", {
      organization_id: org,
      conversation_id: conversationId,
      tipo: r.falha.tipo,
      status: r.falha.status,
    });
    return criarSemClassificar(deps, dadosDoCard, causaLegivel(r.falha));
  }

  // 6 · a decisão.
  const decisao = decidir(r.resposta, regra.limiar);
  logger.info("classificador-comercial: conversa classificada", {
    organization_id: org,
    conversation_id: conversationId,
    assunto: decisao.assunto,
    // O que o Jev devolveu de fato. Se ele passar a responder fora da lista, todo
    // card sai "sem assunto definido" — e é aqui que isso aparece.
    assunto_recebido: r.resposta.assunto,
    probabilidade: Number(decisao.probabilidade.toFixed(3)),
    limiar: regra.limiar,
    criar: decisao.criar,
  });
  if (!decisao.criar) {
    return { status: "classificado", criouCard: false, assunto: decisao.assunto, probabilidade: decisao.probabilidade };
  }

  const nascimento = await deps.garantir(deps.admin, dadosDoCard, {
    tipo: "classificador",
    assunto: decisao.assunto,
    rotuloDoAssunto: ROTULO_DO_ASSUNTO[decisao.assunto],
    probabilidade: decisao.probabilidade,
    modelo: r.resposta.modelo,
  });
  return {
    status: "classificado",
    criouCard: nascimento.criado,
    assunto: decisao.assunto,
    probabilidade: decisao.probabilidade,
  };
}
```

- [ ] **Step 4: Implementar o handler**

```ts
// workers/classificador-comercial.handler.ts
/**
 * Adaptador de `workers/classificador-comercial.ts` para o dispatcher do
 * `event_log`. Registra em `message.received`, em paralelo com o agente e o
 * sentimento — nunca segura o caminho do atendimento.
 *
 * `retry` não conta tentativa no drain (lib/event-log/drain.ts): por isso o
 * worker tem teto pela IDADE do evento, e não pelo número de voltas.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { processarClassificacao } from "@/workers/classificador-comercial";

export const CLASSIFICADOR_COMERCIAL_HANDLER_KEY = "classificador-comercial.v1";

export const classificadorComercialHandler: EventHandler = {
  key: CLASSIFICADOR_COMERCIAL_HANDLER_KEY,
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    const consumer_key = CLASSIFICADOR_COMERCIAL_HANDLER_KEY;
    try {
      const r = await processarClassificacao(row);
      switch (r.status) {
        case "pulado":
          return { consumer_key, status: "skipped", detail: r.motivo };
        case "tentar_de_novo":
          return { consumer_key, status: "retry", retry_at: r.em.toISOString(), detail: r.motivo };
        case "classificado":
          return {
            consumer_key,
            status: "ok",
            detail: `${r.criouCard ? "card" : "sem_card"}:${r.assunto}:${r.probabilidade.toFixed(2)}`,
          };
        case "card_sem_classificar":
          return { consumer_key, status: "ok", detail: `sem_classificar:${r.causa}` };
      }
    } catch (err) {
      return { consumer_key, status: "error", detail: err instanceof Error ? err.message.slice(0, 160) : "erro" };
    }
  },
};
```

- [ ] **Step 5: Registrar no dispatcher** — em `lib/event-log/register-handlers.ts`:

```ts
import { classificadorComercialHandler } from "@/workers/classificador-comercial.handler";
```

e dentro de `ensureHandlersRegistered()`, logo depois de `registerHandler(aiSentimentHandler);`:

```ts
  registerHandler(classificadorComercialHandler);
```

- [ ] **Step 6: A variável opcional da base** — em `lib/env.ts`, depois de `OPENROUTER_APP_TITLE`:

```ts
  // Base do System One do classificador comercial (Jev). Vazio = OpenRouter
  // (https://openrouter.ai/api/v1). Existe para o e2e apontar para um Jev falso
  // local sem mexer no roteamento do chat (OPENROUTER_BASE_URL).
  CLASSIFICADOR_COMERCIAL_BASE_URL: z.string().optional().default(""),
```

e em `.env.example`, logo abaixo de `OPENROUTER_BASE_URL=`:

```bash
CLASSIFICADOR_COMERCIAL_BASE_URL=        # vazio = https://openrouter.ai/api/v1 (Jev da TypeSafe, "Só conversas comerciais")
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/classificador-comercial-worker.test.ts`
Expected: PASS (16 testes).

- [ ] **Step 8: Sabotar o portão principal**

Comente a linha `if (await deps.dados.temCardAberto(...)) return ...`. Rode o teste: "contato que JÁ TEM CARD" tem de ficar **vermelho**. Desfaça.

- [ ] **Step 9: Conferir quem conta handlers registrados**

Run: `grep -rn "ensureHandlersRegistered\|registerHandler(" tests/unit | head`
Se algum teste conta os handlers ou lista as chaves, atualize-o para incluir `classificador-comercial.v1`.

- [ ] **Step 10: Commit**

```bash
git add workers/classificador-comercial.ts workers/classificador-comercial.handler.ts lib/event-log/register-handlers.ts lib/env.ts .env.example tests/unit/classificador-comercial-worker.test.ts
git commit -m "feat(classificador-comercial): worker que chama o Jev só para quem não tem card e cria o card comercial"
```

---

### Task 9: O ponto de IA no registro

**Files:**
- Modify: `lib/ai/pontos/registro.ts` (seção "Entender a conversa", depois do ponto `stage_classifier`)
- Test: `tests/unit/pontos-de-ia-completude.test.ts` (já existe; deve reprovar sem o ponto)

- [ ] **Step 1: Ver o teste reprovar**

Run: `pnpm vitest run tests/unit/pontos-de-ia-completude.test.ts`
Expected: FAIL — `commercial_classify` aparece em `purpose:` em `workers/classificador-comercial.ts` e não está no registro ("ponto oculto").

- [ ] **Step 2: Acrescentar o ponto**

```ts
  {
    id: "commercial_classify",
    rotulo: "Decidir se a conversa vira card",
    oQueFaz:
      "Com a regra \"Só conversas comerciais\" ligada, lê a conversa de quem ainda não tem card e decide se o assunto é contratação, mudança de plano ou conhecer planos. Só então o card nasce no funil.",
    papel: "entender",
    exige: {},
    emissor: "workers/classificador-comercial.ts",
    fixo: {
      razao:
        "Usa o Jev, da TypeSafe: um modelo que devolve decisões com probabilidade em vez de texto. Ele não é um modelo de conversa e fala outra API (System One), por isso não entra na troca de modelos deste painel. Paga com a chave da OpenRouter cadastrada aqui, ou com a da instalação.",
      usa: { provider: "openrouter", modelId: "typesafe/jev-1.13" },
    },
    sintomaDeFalha:
      "Com \"Só conversas comerciais\" ligada, os cards voltam a nascer para toda conversa — o produto cria o card quando não consegue classificar — e a linha do tempo do card diz por quê.",
    registraEm: "llm_calls",
  },
```

- [ ] **Step 3: Rodar os testes do registro e da tela de provedores**

Run: `pnpm vitest run tests/unit/pontos-de-ia-completude.test.ts && grep -rln "PONTOS_DE_IA" tests/unit app lib | xargs -I{} echo {}`
Expected: completude PASS. Rode também cada teste listado pelo `grep` que esteja em `tests/unit/` (ex.: `pnpm vitest run <arquivo>`) — se algum conta os pontos ou exige que `fixo.usa.modelId` exista no catálogo de modelos, ajuste conforme a mensagem do teste (o id `typesafe/jev-1.13` existe no catálogo público da OpenRouter).

- [ ] **Step 4: Commit**

```bash
git add lib/ai/pontos/registro.ts
git commit -m "feat(ia): ponto commercial_classify no registro — fixo no Jev pela OpenRouter"
```

---

### Task 10: A server action que liga e desliga

**Files:**
- Create: `app/actions/settings/definirNascimentoDoCard.ts`
- Modify: `lib/audit/actions.ts` (depois de `"crm.cliente_pela_agenda_alterado",`)
- Test: `tests/unit/definir-nascimento-do-card.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/definir-nascimento-do-card.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

let papel = "admin";
let suporte: Record<string, unknown> | null = null;
let settingsAtuais: Record<string, unknown> = {};
let chaveDisponivel: { apiKey: string; origem: string } | null = { apiKey: "k", origem: "organizacao" };
const gravados: Array<Record<string, unknown>> = [];
const auditadas: Array<Record<string, unknown>> = [];
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, is_platform_admin: false, support: suporte })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Provedor", role: papel })),
}));
vi.mock("@/lib/classificador-comercial/chave", () => ({
  chaveDaOpenRouter: vi.fn(async () => chaveDisponivel),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: settingsAtuais }, error: null }) }) }),
      update: (payload: Record<string, unknown>) => ({
        eq: async () => {
          gravados.push(payload);
          return { error: null };
        },
      }),
    }),
  }),
}));

const { definirNascimentoDoCard } = await import("@/app/actions/settings/definirNascimentoDoCard");

beforeEach(() => {
  papel = "admin";
  suporte = null;
  settingsAtuais = { llm: { provider: "anthropic" }, crm: { cliente_pela_agenda: true } };
  chaveDisponivel = { apiKey: "k", origem: "organizacao" };
  gravados.length = 0;
  auditadas.length = 0;
  revalidatePath.mockClear();
});

describe("definirNascimentoDoCard", () => {
  it.each(["manager", "agent", "viewer"])("%s → sem_permissao, e nada é gravado", async (p) => {
    papel = p;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({ ok: false, erro: "sem_permissao" });
    expect(gravados).toEqual([]);
  });

  it("entrada inválida → invalido", async () => {
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.75 })).toEqual({ ok: false, erro: "invalido" });
    expect(await definirNascimentoDoCard("lixo")).toEqual({ ok: false, erro: "invalido" });
  });

  it("não liga o classificador sem chave da OpenRouter", async () => {
    chaveDisponivel = null;
    expect(await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 })).toEqual({
      ok: false,
      erro: "sem_chave_openrouter",
    });
    expect(gravados).toEqual([]);
  });

  it("desligar não exige chave", async () => {
    chaveDisponivel = null;
    expect(await definirNascimentoDoCard({ modo: "toda_conversa", limiar: 0.7 })).toEqual({
      ok: true,
      modo: "toda_conversa",
      limiar: 0.7,
    });
  });

  it("grava mesclando: preserva o provedor de IA e a vizinha cliente_pela_agenda", async () => {
    await definirNascimentoDoCard({ modo: "classificador", limiar: 0.8 });
    expect(gravados).toEqual([
      {
        settings: {
          llm: { provider: "anthropic" },
          crm: { cliente_pela_agenda: true, nascimento_do_card: { modo: "classificador", limiar: 0.8 } },
        },
      },
    ]);
  });

  it("audita antes e depois, e revalida a tela", async () => {
    await definirNascimentoDoCard({ modo: "classificador", limiar: 0.8 });
    expect(auditadas).toEqual([
      expect.objectContaining({
        action: "crm.nascimento_do_card_alterado",
        organizationId: ORG,
        metadata: { antes: { modo: "toda_conversa", limiar: 0.7 }, depois: { modo: "classificador", limiar: 0.8 } },
      }),
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/app/settings/tenant/pipelines");
  });

  it("suporte somente leitura → somente_leitura", async () => {
    // Formato de `SupportContext` lido por `supportWriteError` (lib/impersonate/support.ts).
    suporte = { id: "s", organization_id: ORG, status: "active", access_mode: "read_only" };
    const r = await definirNascimentoDoCard({ modo: "classificador", limiar: 0.7 });
    expect(r).toEqual({ ok: false, erro: "somente_leitura" });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/definir-nascimento-do-card.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Acrescentar a ação de auditoria** — em `lib/audit/actions.ts`, depois de `"crm.cliente_pela_agenda_alterado",`:

```ts
  // "Quando o card nasce" alterada: toda conversa ↔ só conversas comerciais
  // (classificador Jev). metadata leva a regra antes e depois.
  "crm.nascimento_do_card_alterado",
```

- [ ] **Step 4: Implementar a action**

```ts
// app/actions/settings/definirNascimentoDoCard.ts
"use server";

/**
 * QUANDO O CARD NASCE — toda conversa (padrão) ou só a comercial (Jev).
 *
 * Leitura-mescla-escrita pelo ADMIN client, no molde de `definirExigenciaDeMfa`
 * (app/actions/auth/politicaDeMfa.ts): é configuração reversível que não
 * reescreve dado nenhum. Pela sessão, `.from("organizations").update` de um
 * admin de tenant casaria ZERO linhas e devolveria sucesso.
 *
 * `settings` é jsonb compartilhado (o provedor de IA e a regra "cliente pela
 * agenda" moram nele): mesclar preserva o que não é nosso.
 *
 * Não liga o classificador sem chave da OpenRouter: ligado sem chave, todo card
 * nasceria "sem classificar" — o comportamento de antes com um rótulo de erro.
 * Melhor recusar na tela, onde dá para consertar.
 *
 * O `organization_id` vem de `resolveActiveOrg`, nunca de argumento.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { chaveDaOpenRouter } from "@/lib/classificador-comercial/chave";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import {
  nascimentoDoCard,
  nascimentoDoCardWriteSchema,
  type ModoDeNascimentoDoCard,
} from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/** Códigos, e não frases: a tela traduz (pt-BR/es). */
export type ErroNascimentoDoCard =
  | "invalido"
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "sem_chave_openrouter"
  | "falha";

export type RespostaNascimentoDoCard =
  | { ok: true; modo: ModoDeNascimentoDoCard; limiar: number }
  | { ok: false; erro: ErroNascimentoDoCard };

export async function definirNascimentoDoCard(entrada: unknown): Promise<RespostaNascimentoDoCard> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const lido = nascimentoDoCardWriteSchema.safeParse(entrada);
  if (!lido.success) return { ok: false, erro: "invalido" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "sem_empresa" };
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) return { ok: false, erro: "sem_permissao" };

  const admin = createAdminClient();
  if (lido.data.modo === "classificador" && !(await chaveDaOpenRouter(admin, org.orgId))) {
    return { ok: false, erro: "sem_chave_openrouter" };
  }

  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, erro: "falha" };

  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const crm =
    settings.crm && typeof settings.crm === "object" && !Array.isArray(settings.crm)
      ? (settings.crm as Record<string, unknown>)
      : {};
  const antes = nascimentoDoCard(settings);
  const novo = { ...settings, crm: { ...crm, nascimento_do_card: lido.data } };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) {
    logger.error("[nascimento-do-card] gravação falhou", { organization_id: org.orgId, error: error.message });
    return { ok: false, erro: "falha" };
  }

  await audit({
    action: "crm.nascimento_do_card_alterado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { antes, depois: lido.data },
  });

  revalidatePath("/app/settings/tenant/pipelines");
  return { ok: true, ...lido.data };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/definir-nascimento-do-card.test.ts`
Expected: PASS (9 testes).

- [ ] **Step 6: Commit**

```bash
git add app/actions/settings/definirNascimentoDoCard.ts lib/audit/actions.ts tests/unit/definir-nascimento-do-card.test.ts
git commit -m "feat(crm): action que liga 'só conversas comerciais' — admin, exige chave, audita"
```

---

### Task 11: A seção "Quando o card nasce" na tela de funis

**Files:**
- Create: `components/crm/NascimentoDoCard.tsx`
- Modify: `app/app/settings/tenant/pipelines/page.tsx`
- Modify: `lib/i18n/dicionario.ts`
- Test: `components/crm/NascimentoDoCard.test.tsx`

- [ ] **Step 1: Escrever o teste que falha**

```tsx
// components/crm/NascimentoDoCard.test.tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const definir = vi.fn();
const toastErro = vi.fn();
const toastOk = vi.fn();

vi.mock("sonner", () => ({ toast: { success: (m: string) => toastOk(m), error: (m: string) => toastErro(m) } }));
vi.mock("@/app/actions/settings/definirNascimentoDoCard", () => ({
  definirNascimentoDoCard: (e: unknown) => definir(e),
}));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const { NascimentoDoCard } = await import("@/components/crm/NascimentoDoCard");

beforeEach(() => {
  definir.mockReset();
  toastErro.mockReset();
  toastOk.mockReset();
});

describe("NascimentoDoCard", () => {
  it("no modo de sempre, não mostra a certeza mínima", () => {
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    expect(screen.getByLabelText(/toda conversa vira card/i)).toBeChecked();
    expect(screen.queryByText(/certeza mínima/i)).toBeNull();
  });

  it("escolher 'Só conversas comerciais' mostra a certeza mínima e salva a escolha", async () => {
    definir.mockResolvedValue({ ok: true, modo: "classificador", limiar: 0.7 });
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    expect(screen.getByText(/certeza mínima/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() => expect(definir).toHaveBeenCalledWith({ modo: "classificador", limiar: 0.7 }));
    await waitFor(() => expect(toastOk).toHaveBeenCalled());
  });

  it("sem chave da OpenRouter, diz onde cadastrar", async () => {
    definir.mockResolvedValue({ ok: false, erro: "sem_chave_openrouter" });
    render(<NascimentoDoCard inicial={{ modo: "toda_conversa", limiar: 0.7 }} podeEditar />);
    fireEvent.click(screen.getByLabelText(/só conversas comerciais/i));
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));
    await waitFor(() => expect(toastErro).toHaveBeenCalledWith(expect.stringMatching(/OpenRouter.*Credenciais/)));
  });

  it("quem não é admin vê a regra, mas não muda", () => {
    render(<NascimentoDoCard inicial={{ modo: "classificador", limiar: 0.8 }} podeEditar={false} />);
    expect(screen.getByLabelText(/só conversas comerciais/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /salvar/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run components/crm/NascimentoDoCard.test.tsx`
Expected: FAIL — componente inexistente.

- [ ] **Step 3: Implementar o componente**

```tsx
// components/crm/NascimentoDoCard.tsx
"use client";

/**
 * "QUANDO O CARD NASCE" — a superfície da regra `settings.crm.nascimento_do_card`.
 *
 * Mora na tela de funis porque é dela a pergunta "por que este card está aqui?".
 * Quem não é admin VÊ a regra em vigor (saber por que um card não nasceu é
 * direito de quem opera), mas só o admin a muda — a action confere de novo.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { definirNascimentoDoCard, type ErroNascimentoDoCard } from "@/app/actions/settings/definirNascimentoDoCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import {
  LIMIARES_DO_CLASSIFICADOR,
  type ModoDeNascimentoDoCard,
  type NascimentoDoCard as Regra,
} from "@/lib/schemas/settings";

const MENSAGEM_DO_ERRO: Record<ErroNascimentoDoCard, string> = {
  invalido: "Escolha um modo e uma certeza mínima válidos.",
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só um administrador pode mudar essa regra.",
  sem_chave_openrouter: "Cadastre uma chave da OpenRouter em IA › Credenciais antes de ligar esta regra.",
  falha: "Não consegui salvar essa mudança agora.",
};

export function NascimentoDoCard({ inicial, podeEditar }: { inicial: Regra; podeEditar: boolean }) {
  const t = useT();
  const [modo, setModo] = useState<ModoDeNascimentoDoCard>(inicial.modo);
  const [limiar, setLimiar] = useState<number>(inicial.limiar);
  const [salvando, iniciar] = useTransition();
  const mudou = modo !== inicial.modo || limiar !== inicial.limiar;
  const bloqueado = !podeEditar || salvando;

  function salvar() {
    iniciar(async () => {
      const r = await definirNascimentoDoCard({ modo, limiar });
      if (r.ok) toast.success(t("Regra salva."));
      else toast.error(t(MENSAGEM_DO_ERRO[r.erro]));
    });
  }

  return (
    <Card className="space-y-4 p-4" data-testid="nascimento-do-card">
      <div>
        <h2 className="text-base font-semibold">{t("Quando o card nasce")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Decide quais conversas abrem um card no funil de entrada.")}
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className="sr-only">{t("Quando o card nasce")}</legend>
        <div className="flex items-start gap-2">
          <input
            id="nascimento-toda-conversa"
            type="radio"
            name="modo-nascimento"
            className="mt-1"
            checked={modo === "toda_conversa"}
            disabled={bloqueado}
            onChange={() => setModo("toda_conversa")}
          />
          <Label htmlFor="nascimento-toda-conversa" className="font-normal leading-snug">
            <strong>{t("Toda conversa vira card")}</strong>
            <span className="block text-muted-foreground">
              {t("A primeira mensagem de quem não tem card abre um no funil de entrada.")}
            </span>
          </Label>
        </div>
        <div className="flex items-start gap-2">
          <input
            id="nascimento-classificador"
            type="radio"
            name="modo-nascimento"
            className="mt-1"
            checked={modo === "classificador"}
            disabled={bloqueado}
            onChange={() => setModo("classificador")}
          />
          <Label htmlFor="nascimento-classificador" className="font-normal leading-snug">
            <strong>{t("Só conversas comerciais")}</strong>
            <span className="block text-muted-foreground">
              {t(
                "A cada mensagem de quem ainda não tem card, a IA decide se o assunto é contratação, mudança de plano ou conhecer planos. Suporte, financeiro e cancelamento não abrem card.",
              )}
            </span>
          </Label>
        </div>
      </fieldset>

      {modo === "classificador" ? (
        <div className="space-y-1">
          <Label htmlFor="limiar-classificador">{t("Certeza mínima para abrir o card")}</Label>
          <Select value={String(limiar)} onValueChange={(v) => setLimiar(Number(v))} disabled={bloqueado}>
            <SelectTrigger id="limiar-classificador" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIARES_DO_CLASSIFICADOR.map((l) => (
                <SelectItem key={l} value={String(l)}>
                  {Math.round(l * 100)}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t(
              "Mais alto abre menos cards por engano, mas pode deixar passar uma venda. Se a IA não conseguir responder, o card nasce assim mesmo e a linha do tempo diz por quê.",
            )}
          </p>
        </div>
      ) : null}

      {podeEditar ? (
        <Button onClick={salvar} disabled={!mudou || salvando}>
          {salvando ? t("Salvando…") : t("Salvar")}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t("Só um administrador pode mudar essa regra.")}</p>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Montar na página** — em `app/app/settings/tenant/pipelines/page.tsx`:

Imports:

```tsx
import { NascimentoDoCard } from "@/components/crm/NascimentoDoCard";
import { nascimentoDoCard } from "@/lib/schemas/settings";
```

Depois da consulta de `crm_pipelines`:

```tsx
  // A regra "quando o card nasce" (settings.crm.nascimento_do_card). Membro lê
  // a própria organização pela RLS; falha de leitura mostra o padrão, que é o
  // que a ingestão também assume.
  const { data: org } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const regraDeNascimento = nascimentoDoCard((org as { settings?: unknown } | null)?.settings);
```

E no JSX, entre o `</header>` e o `<PipelinesClient ... />`:

```tsx
      <NascimentoDoCard inicial={regraDeNascimento} podeEditar={podeEditarConfig} />
```

- [ ] **Step 5: Textos em espanhol** — em `lib/i18n/dicionario.ts`, dentro de `DICIONARIO` (perto de `"Entrou pelo WhatsApp"`):

```ts
  "Quando o card nasce": { es: "Cuándo nace la tarjeta" },
  "Decide quais conversas abrem um card no funil de entrada.": { es: "Decide qué conversaciones abren una tarjeta en el embudo de entrada." },
  "Toda conversa vira card": { es: "Toda conversación se vuelve tarjeta" },
  "A primeira mensagem de quem não tem card abre um no funil de entrada.": { es: "El primer mensaje de quien no tiene tarjeta abre una en el embudo de entrada." },
  "Só conversas comerciais": { es: "Solo conversaciones comerciales" },
  "A cada mensagem de quem ainda não tem card, a IA decide se o assunto é contratação, mudança de plano ou conhecer planos. Suporte, financeiro e cancelamento não abrem card.": { es: "En cada mensaje de quien aún no tiene tarjeta, la IA decide si el asunto es contratación, cambio de plan o conocer planes. Soporte, finanzas y cancelación no abren tarjeta." },
  "Certeza mínima para abrir o card": { es: "Certeza mínima para abrir la tarjeta" },
  "Mais alto abre menos cards por engano, mas pode deixar passar uma venda. Se a IA não conseguir responder, o card nasce assim mesmo e a linha do tempo diz por quê.": { es: "Más alto abre menos tarjetas por error, pero puede dejar pasar una venta. Si la IA no logra responder, la tarjeta nace igual y la línea de tiempo dice por qué." },
  "Regra salva.": { es: "Regla guardada." },
  "Escolha um modo e uma certeza mínima válidos.": { es: "Elige un modo y una certeza mínima válidos." },
  "Cadastre uma chave da OpenRouter em IA › Credenciais antes de ligar esta regra.": { es: "Registra una clave de OpenRouter en IA › Credenciales antes de activar esta regla." },
```

Antes de colar, confira com `grep -n '"Salvar"\|"Salvando…"\|"Sua sessão expirou. Entre de novo."\|"Nenhuma empresa ativa."\|"Só um administrador pode mudar essa regra."\|"Não consegui salvar essa mudança agora."\|"Acompanhamento somente leitura ou encerrado."' lib/i18n/dicionario.ts` quais desses já existem; acrescente só os que faltarem (chave duplicada num objeto literal quebra o lint).

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm vitest run components/crm/NascimentoDoCard.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/idioma-da-interface.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/crm/NascimentoDoCard.tsx components/crm/NascimentoDoCard.test.tsx app/app/settings/tenant/pipelines/page.tsx lib/i18n/dicionario.ts
git commit -m "feat(crm): seção 'Quando o card nasce' na tela de funis"
```

---

### Task 12: Mapa vivo, fragmento de release e documentação

**Files:**
- Create: `docs/architecture/card-pelo-classificador.architecture.json`
- Modify: `docs/architecture/README.md` (tabela "Mapas")
- Create: `.changes/card-nasce-pelo-classificador.md`
- Modify: `docs/testing/user-journey-map.md`

- [ ] **Step 1: O mapa**

```json
{
  "schema_version": 1,
  "diagram_type": "architecture",
  "meta": {
    "title": "O card nasce quando a conversa é comercial",
    "subtitle": "ingest recua, o Jev decide só para quem não tem card, e o card nasce pela mesma função de sempre",
    "output": "card-pelo-classificador.html",
    "quality_profile": "standard"
  },
  "lanes": [
    { "id": "tela", "label": "Tela" },
    { "id": "entrada", "label": "Entrada da mensagem" },
    { "id": "worker", "label": "Worker (event_log)" },
    { "id": "banco", "label": "Banco" },
    { "id": "fora", "label": "Fora" }
  ],
  "mainPath": ["ingest", "evento", "worker", "gate", "jev", "nascer", "timeline"],
  "nodes": [
    { "id": "config", "lane": "tela", "col": 1, "type": "frontend", "label": "Funis › Quando o card nasce (admin) — toda conversa | só comerciais + certeza mínima" },
    { "id": "timeline", "lane": "tela", "col": 3, "type": "frontend", "label": "Linha do tempo da conversa — 'conversa identificada como comercial: mudança de plano (93%)'" },
    { "id": "execucoes", "lane": "tela", "col": 4, "type": "frontend", "label": "IA › Execuções — toda chamada ao Jev, com custo e falha (purpose commercial_classify)" },
    { "id": "ingest", "lane": "entrada", "col": 1, "type": "backend", "label": "pos-entrada → garantirLeadDaConversa(origem ingest) — recua com 'aguarda_classificador'" },
    { "id": "evento", "lane": "entrada", "col": 2, "type": "messagebus", "label": "message.received (trg_messages_emit_event, todo canal)" },
    { "id": "worker", "lane": "worker", "col": 2, "type": "backend", "label": "classificador-comercial.v1 — regra, card aberto?, bloqueado?, transcrição" },
    { "id": "gate", "lane": "worker", "col": 3, "type": "backend", "label": "JÁ TEM CARD? → para, sem chamar o Jev" },
    { "id": "nascer", "lane": "worker", "col": 4, "type": "backend", "label": "garantirLeadDaConversa(origem classificador | sem_classificacao) — trava por contato" },
    { "id": "settings", "lane": "banco", "col": 1, "type": "database", "label": "organizations.settings.crm.nascimento_do_card" },
    { "id": "leads", "lane": "banco", "col": 3, "type": "database", "label": "crm_leads (open por contato) + crm_lead_activities (lead_created, reason)" },
    { "id": "llmcalls", "lane": "banco", "col": 4, "type": "database", "label": "llm_calls — custo exato fracionário (US$ 0,042/M)" },
    { "id": "jev", "lane": "fora", "col": 3, "type": "external", "label": "Jev (TypeSafe) via OpenRouter — POST /api/v1/systemone, typesafe/jev-1.13" }
  ],
  "edges": [
    { "from": "config", "to": "settings", "label": "grava a regra (admin client, audita)" },
    { "from": "ingest", "to": "settings", "label": "lê a regra (só quem não tem card)" },
    { "from": "ingest", "to": "evento", "label": "a mensagem gravada emite" },
    { "from": "evento", "to": "worker", "label": "drain do event_log" },
    { "from": "worker", "to": "settings", "label": "modo e limiar" },
    { "from": "worker", "to": "gate", "label": "antes de gastar" },
    { "from": "gate", "to": "leads", "label": "card aberto do contato?" },
    { "from": "gate", "to": "jev", "label": "só sem card: últimas 12 falas" },
    { "from": "jev", "to": "worker", "label": "noul comercial + choice assunto" },
    { "from": "worker", "to": "llmcalls", "label": "toda chamada, ok ou erro" },
    { "from": "worker", "to": "nascer", "label": "passou do limiar, ou falhou (decisão A)" },
    { "from": "nascer", "to": "leads", "label": "card + lead_created com a razão" },
    { "from": "leads", "to": "timeline", "label": "a conversa mostra a atividade do negócio" },
    { "from": "llmcalls", "to": "execucoes", "label": "o operador vê custo e falha" }
  ],
  "cards": [
    {
      "dot": "rose",
      "title": "O que a forma não mostra",
      "items": [
        "Quem já tem card não paga chamada — o portão vem ANTES da chave e do Jev",
        "Falha do classificador cria o card: card a mais se arquiva, card a menos é venda que some",
        "O modelo só responde 'é comercial?'; funil, etapa, título e trava continuam em garantirLeadDaConversa"
      ]
    }
  ]
}
```

- [ ] **Step 2: Linha no README dos mapas** — na tabela "Mapas" de `docs/architecture/README.md`:

```markdown
| `card-pelo-classificador.architecture.json` | o card nasce quando a conversa é comercial (plano 2026-09-22) — 12 peças, 14 arestas, 5 faixas; o ingest recua no modo `classificador`, o worker só chama o Jev (TypeSafe, via OpenRouter) para contato **sem** card, e o card nasce pela mesma `garantirLeadDaConversa`, com a razão na linha do tempo; falha do classificador cria o card |
```

- [ ] **Step 3: Rodar o gate dos mapas**

Run: `pnpm vitest run tests/unit/mapas-de-arquitetura.test.ts`
Expected: PASS (nenhuma aresta para id inexistente, nenhuma peça órfã).

- [ ] **Step 4: Fragmento de release** — `.changes/card-nasce-pelo-classificador.md`:

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: Funil — o card pode nascer só para conversas comerciais
---

Em **CRM › Etapas do funil**, a seção nova **Quando o card nasce** tem duas opções. **Toda
conversa vira card** é o comportamento de sempre e continua sendo o padrão: nada muda até
alguém escolher a outra.

**Só conversas comerciais**: a primeira mensagem deixa de abrir card. A cada mensagem de quem
ainda não tem card, a IA (o Jev, da TypeSafe, pela OpenRouter) decide se o assunto é
contratação, mudança de plano ou conhecer planos. Suporte, financeiro e cancelamento não abrem
card. Quando abre, a linha do tempo da conversa diz por quê, por exemplo "conversa identificada
como comercial: mudança de plano (93%)". Quem já tem card não gera consulta nenhuma. A
**certeza mínima** (60 a 90%) regula o quanto a IA precisa estar segura.

Precisa de uma chave da **OpenRouter** em **IA › Credenciais** (ou `OPENROUTER_API_KEY` na
instalação). Cada consulta custa menos de um centésimo de centavo de dólar e aparece em
**IA › Execuções**. Se a IA não conseguir responder (chave sem saldo, serviço fora do ar), o
card nasce como antes, e a linha do tempo registra a causa.
```

- [ ] **Step 5: Conferir o fragmento**

Run: `pnpm release:conferir`
Expected: o fragmento aparece como válido, com `capacidade_nova`.

- [ ] **Step 6: Mapa de jornadas** — em `docs/testing/user-journey-map.md`, na jornada do funil/lead, acrescente:

```markdown
- [P1] Só conversas comerciais: com a regra ligada, mensagem de suporte NÃO abre card; mensagem de contratação/mudança de plano abre, com a razão na linha do tempo; a mensagem seguinte do mesmo contato não chama o classificador — `tests/e2e/card-pelo-classificador.spec.ts` (Jev falso local), evidência em `evidence/card-pelo-classificador/`.
```

- [ ] **Step 7: Commit**

```bash
git add docs/architecture/card-pelo-classificador.architecture.json docs/architecture/README.md .changes/card-nasce-pelo-classificador.md docs/testing/user-journey-map.md
git commit -m "docs(crm): mapa vivo, fragmento de release e jornada do card pelo classificador"
```

---

### Task 13: Suíte completa (a régua do CLAUDE.md, sem recorte)

- [ ] **Step 1: Typecheck e lint**

Run: `pnpm typecheck && pnpm lint && pnpm lint:channels`
Expected: zero erro. (`lint:channels`: nenhum arquivo novo nomeia provider de canal.)

- [ ] **Step 2: A suíte unit INTEIRA, com o protocolo de leitura**

```bash
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/vt.log | tail -2
grep -aE "^ *Errors " /tmp/vt.log
r=$(grep -aE "^ *Tests " /tmp/vt.log | tail -1 | grep -oE "[0-9]+ failed" | head -1)
g=$(grep -acE "^ *FAIL " /tmp/vt.log)
echo "rodapé: ${r:-0 failed} | grep contou: $g"
```

Expected: `exit=0`, rodapé sem `failed`, linha `Errors` vazia. Vermelhos conhecidos desta máquina que NÃO são desta mudança (memória "Vermelhos locais desta máquina"): `leads-import-route` e o apóstrofo do `test-validators` no macOS, e `lib/ai/dispatcher/rate-limit.test.ts` se o Redis local estiver parado. Qualquer outro vermelho é desta mudança: conserte.

- [ ] **Step 3: Invariantes (Postgres real)**

Run: `pnpm test:db`
Expected: verde, incluindo os 4 casos novos de `nascimento-do-lead`.

- [ ] **Step 4: Build de produção**

Run: `pnpm build`
Expected: build completo (o TS2589 às vezes só aparece aqui).

- [ ] **Step 5: Commit (se algo foi ajustado)**

```bash
git add -A && git commit -m "chore(classificador-comercial): ajustes da suíte completa"
```

---

### Task 14: Prova pela tela, num ambiente fresco, com um Jev falso local

**Files:**
- Create: `scripts/seed-e2e-classificador-comercial.ts`
- Create: `tests/e2e/card-pelo-classificador.spec.ts`
- Modify: `.github/workflows/e2e.yml` (acrescentar a spec a uma `SPECS_PARTE_*`)
- Modify: onde o workflow gera o `.env.e2e` (o arquivo é gitignored) — `CLASSIFICADOR_COMERCIAL_BASE_URL=http://127.0.0.1:3998`

- [ ] **Step 1: O seed** — credencial OpenRouter falsa na organização de e2e, e restauração da regra:

```ts
// scripts/seed-e2e-classificador-comercial.ts
/**
 * Seed E2E do card pelo classificador.
 *
 * Grava uma credencial `openrouter` (falsa, cifrada como o produto cifra) na
 * organização de e2e, para o worker ter chave SEM `OPENROUTER_API_KEY` no
 * ambiente — que mudaria o roteamento do chat das outras specs.
 * `restaurar` devolve a regra para `toda_conversa` (a organização é
 * compartilhada; os workers do Playwright são 1, então a spec roda sozinha).
 *
 * Run: npx tsx scripts/seed-e2e-classificador-comercial.ts [restaurar]
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";

import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-classificador-comercial", credenciais);
const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const creds = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8")) as { org_id: string };

async function restaurar(): Promise<void> {
  const { data } = await admin.from("organizations").select("settings").eq("id", creds.org_id).single();
  const settings = (data?.settings ?? {}) as Record<string, unknown>;
  const crm = (settings.crm ?? {}) as Record<string, unknown>;
  await admin
    .from("organizations")
    .update({ settings: { ...settings, crm: { ...crm, nascimento_do_card: { modo: "toda_conversa", limiar: 0.7 } } } })
    .eq("id", creds.org_id);
}

async function semear(): Promise<void> {
  const { data: existente } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", creds.org_id)
    .eq("provider", "openrouter")
    .eq("label", "e2e-classificador")
    .maybeSingle();
  if (existente) return;
  const cifrada = encryptKey("sk-or-e2e-falsa-0000");
  const { error } = await admin.from("ai_provider_credentials").insert({
    organization_id: creds.org_id,
    provider: "openrouter",
    label: "e2e-classificador",
    api_key_encrypted: bufToBytea(cifrada.ciphertext),
    api_key_iv: bufToBytea(cifrada.iv),
    api_key_tag: bufToBytea(cifrada.tag),
    api_key_last4: cifrada.last4,
    validated_at: new Date().toISOString(),
    is_active: true,
  });
  if (error) throw new Error(error.message);
}

void (process.argv[2] === "restaurar" ? restaurar() : semear());
```

Antes de rodar, confira em `lib/crypto/aes_gcm.ts` (linha ~85) que `bufToBytea` é o formato que a rota de credenciais usa ao gravar (`grep -rn "bufToBytea" app/api/v1 | head -3`); se a rota grava de outro jeito, use o mesmo.

- [ ] **Step 2: A spec**

```ts
// tests/e2e/card-pelo-classificador.spec.ts
/**
 * O CARD NASCE QUANDO A CONVERSA É COMERCIAL — provado PELA TELA (DoD 12).
 *
 * A mensagem entra pelo caminho de produção (webhook do WAHA, como em
 * `conversa-vira-lead.spec.ts`), o evento é drenado pela rota de cron de
 * verdade, e o worker chama um Jev FALSO local (receiver HTTP real na porta
 * 3998, via `CLASSIFICADOR_COMERCIAL_BASE_URL`). O falso responde "comercial"
 * quando a última fala do cliente fala de plano/mega/contratar, e conta as
 * chamadas — é assim que se prova que quem já tem card NÃO chama o Jev.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { lerCreds as lerCredsAdmin, loginComoAdmin } from "./helpers/login-admin";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const PORTA_DO_JEV_FALSO = 3998;

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  nascimento?: { webhook_token: string; session_name: string; pipeline_default_id: string };
}

function lerCreds(): Creds {
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.nascimento?.webhook_token) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-nascimento-do-lead.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

lerCredsAdmin(); // garante .e2e-creds.json semeado
const creds = lerCreds();

const sufixo = String(process.pid).padStart(6, "0").slice(-6);
const TELEFONE = `55318${sufixo}`;
const NOME = `Cliente Classificado ${sufixo}`;

let chamadasAoJev = 0;
let servidor: http.Server;

function jevFalso(): http.Server {
  return http.createServer((req, res) => {
    let corpo = "";
    req.on("data", (c) => (corpo += c));
    req.on("end", () => {
      chamadasAoJev++;
      const pedido = JSON.parse(corpo) as { state: { conversa: Array<{ quem: string; texto: string }> } };
      const ultima = [...pedido.state.conversa].reverse().find((m) => m.quem === "cliente")?.texto ?? "";
      const comercial = /plano|mega|contratar/i.test(ultima);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            comercial: { type: "noul", noul: comercial ? 0.93 : 0.06 },
            assunto: { type: "choice", choice: comercial ? "mudanca_de_plano" : "suporte", confidence: 0.9 },
          },
          usage: { input_tokens: 400, output_tokens: 20 },
        }),
      );
    });
  });
}

async function mandarMensagem(page: Page, texto: string, id: string): Promise<void> {
  const r = await page.request.post(`/api/v1/webhooks/waha/${creds.nascimento!.webhook_token}`, {
    data: {
      event: "message",
      session: creds.nascimento!.session_name,
      payload: {
        id,
        from: `${TELEFONE}@c.us`,
        fromMe: false,
        body: texto,
        timestamp: Math.floor(Date.now() / 1000),
        _data: { notifyName: NOME },
      },
    },
  });
  expect(r.status(), "o webhook precisa ACEITAR").toBe(200);
}

/** Drena o event_log pela rota de cron até o Jev falso ser chamado `esperadas` vezes (ou desistir). */
async function drenarAte(page: Page, esperadas: number): Promise<void> {
  for (let i = 0; i < 10 && chamadasAoJev < esperadas; i++) {
    await page.request.post("/api/v1/cron/event-log-drain", {
      headers: { Authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}` },
    });
    await page.waitForTimeout(500);
  }
}

test.describe.configure({ mode: "serial" });

test.describe("o card nasce quando a conversa é comercial", () => {
  test.beforeAll(async () => {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-classificador-comercial.ts"], { stdio: "inherit" });
    servidor = jevFalso();
    await new Promise<void>((ok) => servidor.listen(PORTA_DO_JEV_FALSO, "127.0.0.1", ok));
  });

  test.afterAll(async () => {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-classificador-comercial.ts", "restaurar"], { stdio: "inherit" });
    await new Promise<void>((ok) => servidor.close(() => ok()));
  });

  test("o admin liga 'Só conversas comerciais' pela tela", async ({ page }) => {
    await loginComoAdmin(page, lerCredsAdmin());
    await page.goto("/app/settings/tenant/pipelines");
    const secao = page.getByTestId("nascimento-do-card");
    await expect(secao.getByText("Quando o card nasce")).toBeVisible();
    await secao.getByLabel(/só conversas comerciais/i).check();
    await expect(secao.getByText(/certeza mínima/i)).toBeVisible();
    await secao.getByRole("button", { name: /salvar/i }).click();
    await expect(page.getByText("Regra salva.")).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByTestId("nascimento-do-card").getByLabel(/só conversas comerciais/i)).toBeChecked();
    fs.mkdirSync("evidence/card-pelo-classificador", { recursive: true });
    await page.screenshot({ path: "evidence/card-pelo-classificador/regra-ligada.png", fullPage: true });
  });

  test("mensagem de suporte NÃO abre card", async ({ page }) => {
    await mandarMensagem(page, "minha internet caiu desde ontem", `e2e-clf-${sufixo}-1`);
    await drenarAte(page, 1);
    expect(chamadasAoJev, "o Jev tem de ter sido consultado").toBe(1);

    await loginComoAdmin(page, lerCredsAdmin());
    await page.goto(`/app/pipelines/${creds.nascimento!.pipeline_default_id}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(NOME, { exact: false })).toHaveCount(0);
  });

  test("mensagem de mudança de plano abre o card, e a linha do tempo diz por quê", async ({ page }) => {
    await mandarMensagem(page, "e queria aumentar meu plano pra 500 mega", `e2e-clf-${sufixo}-2`);
    await drenarAte(page, 2);
    expect(chamadasAoJev).toBe(2);

    await loginComoAdmin(page, lerCredsAdmin());
    await page.goto(`/app/pipelines/${creds.nascimento!.pipeline_default_id}`);
    const card = page.getByText(NOME, { exact: false }).first();
    await expect(card, "o card tem de aparecer no quadro").toBeVisible({ timeout: 20_000 });
    await card.click();
    await expect(
      page.getByText(/conversa identificada como comercial: mudança de plano \(93%\)/i).first(),
    ).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: "evidence/card-pelo-classificador/card-nascido-comercial.png", fullPage: true });
  });

  test("com o card aberto, a mensagem seguinte NÃO chama o Jev", async ({ page }) => {
    await mandarMensagem(page, "quanto fica por mês?", `e2e-clf-${sufixo}-3`);
    // Drena algumas voltas mesmo sem esperar chamada: o ponto é que ela NÃO acontece.
    for (let i = 0; i < 3; i++) {
      await page.request.post("/api/v1/cron/event-log-drain", {
        headers: { Authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}` },
      });
      await page.waitForTimeout(500);
    }
    expect(chamadasAoJev, "quem já tem card não gera chamada").toBe(2);
  });
});
```

Se o dossiê do card não mostrar a linha do tempo da conversa, procure a razão no painel da conversa do Inbox (`components/inbox/PainelDaConversa.tsx` renderiza `a.reason`): abra a conversa pelo Inbox e ajuste o seletor do terceiro teste, **sem** afrouxar o texto esperado.

- [ ] **Step 3: Apontar o e2e para o Jev falso**

O `.env.e2e` é gitignored. Ache onde o CI o monta (`grep -n "env.e2e\|GITHUB_ENV" .github/workflows/e2e.yml`) e acrescente ali `CLASSIFICADOR_COMERCIAL_BASE_URL=http://127.0.0.1:3998`; ponha a mesma linha no seu `.env.e2e` local. Acrescente `card-pelo-classificador.spec.ts` a uma das `SPECS_PARTE_*` de `.github/workflows/e2e.yml`.

- [ ] **Step 4: Rodar no ambiente fresco estilo VPS**

Receita do CLAUDE.md: Supabase local **pg15** com `supabase/baseline.sql`, `scripts/bootstrap-owner.ts`, `next build && next start`, worktree com `node_modules` real (não symlink). Depois:

Run: `pnpm test:e2e tests/e2e/card-pelo-classificador.spec.ts tests/e2e/conversa-vira-lead.spec.ts`
Expected: as duas verdes. A `conversa-vira-lead` é o controle: o modo de sempre continua abrindo card na primeira mensagem, e o `afterAll` desta spec restaurou a regra.

- [ ] **Step 5: Evidência e gate de cobertura**

Run: `pnpm vitest run tests/unit/e2e-cobertura-completa.test.ts && ls evidence/card-pelo-classificador/`
Expected: PASS, e as duas capturas de tela da spec (a regra ligada e o card nascido) em `evidence/card-pelo-classificador/`. Abra as duas e confira a olho que a seção e a razão estão legíveis. (Nomes de imagem citados em prosa num doc versionado precisam existir no `git ls-files` — `tests/unit/evidencia-citada.test.ts` reprova o contrário.)

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-e2e-classificador-comercial.ts tests/e2e/card-pelo-classificador.spec.ts .github/workflows/e2e.yml evidence/card-pelo-classificador/
git commit -m "test(e2e): card pelo classificador provado pela tela, com Jev falso local"
```

---

### Task 15: Produção (cada passo pede autorização do dono)

Memória "Autorização de deploy é por pedido": PR verde **não** autoriza merge, release nem VPS. Pergunte antes de cada linha abaixo.

- [ ] **Step 1: PR** — `git push -u origin claude/crm-card-filter-conversation-type-4983d9` e abrir o PR com o resumo, a saída da sonda (Task 3), as evidências (Task 14) e as decisões A–G. Acompanhar os 4 checks obrigatórios (`verify, build-and-size, invariants, imagens-ok`).
- [ ] **Step 2: (autorizado) Merge + release** pelo fluxo do repo (`pnpm release:conferir`; PR de release gerado pelos fragmentos).
- [ ] **Step 3: (autorizado) VPS** — atualizar pelo `update.sh` (runbook `docs/runbooks/deploy.md`), com os dois arquivos de compose se houver Traefik, e conferir que o domínio responde **307**.
- [ ] **Step 4: (decisão do dono) LGPD** — confirmar que é aceitável o texto das conversas da Totus passar pela OpenRouter e pela TypeSafe (a TypeSafe só oferece retenção zero no plano empresarial). Se sim, registrar o operador novo onde a Totus declara seus operadores.
- [ ] **Step 5: (autorizado) Chave** — o dono cadastra a chave da OpenRouter em **IA › Credenciais** da org Totus Telecom (nunca pelo chat).
- [ ] **Step 6: (autorizado) Calibrar antes de ligar** — exportar 30 a 50 conversas recentes da Totus por consulta só-leitura, para um arquivo **fora do repositório**, no formato de `tests/fixtures/jev/conversas-de-exemplo.json`. O dono rotula `esperado`. Rodar `npx tsx --env-file=.env.sonda scripts/sondar-jev.ts <arquivo> 0.6`, depois `0.7`, `0.8` e `0.9`, e escolher o limiar pela tabela de acertos. Apagar o arquivo ao fim.
- [ ] **Step 7: (autorizado) Ligar** — em **CRM › Etapas do funil › Quando o card nasce**, "Só conversas comerciais" com o limiar escolhido.
- [ ] **Step 8: Observar 48 h** — em IA › Execuções (`commercial_classify`): quantidade, custo, falhas. Por SQL só-leitura: cards criados com `source_module = 'crm.classificador_comercial'` × `sem_classificacao`, e conversas sem card cujo atendente acabou criando card à mão (os "nãos" errados). Relatar ao dono e ajustar o limiar se preciso.

---

## Auto-revisão

**Cobertura do pedido:**
- Card não nasce no começo → Task 6 (ingest recua) + Task 14 (suporte não abre card).
- A cada mensagem, confere se já tem card; se tiver, não chama o Jev → Task 8 (portão antes da chave e do Jev, com sabotagem) + Task 14 (contagem de chamadas no Jev falso).
- Sem card → chama o Jev com a estrutura que a OpenRouter pede → Tasks 1–3 (`POST /api/v1/systemone`, `typesafe/jev-1.13`, contrato medido).
- Comercial → cria o card e documenta na linha do tempo → Task 6 (razão e `payload.classificacao`) + Task 14 (texto visível na tela).
- Para de verificar depois do card → mesmo portão da Task 8.
- Custo e velocidade → custo exato em `llm_calls` (Task 8), latência medida (Task 3), visíveis em IA › Execuções (Task 9).

**Definition of Done do CLAUDE.md:** typecheck/lint/unit/db/build (Task 13); sem tabela nova, então sem RLS nova (a leitura das settings usa a RLS existente); auditoria na mutação (Task 10); sem rota pública nova; Zod na entrada externa (resposta do Jev, action); sem `console.log`; env nova no `.env.example` + `lib/env.ts` (Task 8); sem migration (justificado no mapa de arquivos); prova pela tela (Task 14); sistema vivo — entrada (mensagem), saída (card + linha do tempo), log (`llm_calls` + logger), tela (Funis, Execuções), porta (tela de funis já no catálogo de navegação), laço de retorno (a falha cria o card com a causa; os "nãos" errados são medidos na Task 15), mapa com ≥2 arestas por peça (Task 12); fragmento de release (Task 12); afirmação de estado atualizada (cabeçalho de `nascimento-do-lead.ts`, Task 6).

**NÃO MEDIDO por este plano até a execução:** o formato exato da resposta da OpenRouter para `/systemone` (a Task 3 mede); a acurácia do Jev em português real da Totus (Task 15 mede); a latência em produção (Task 3 dá o número de laboratório).
