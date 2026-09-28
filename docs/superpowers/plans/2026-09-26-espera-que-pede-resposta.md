# Espera que pede resposta — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o termômetro de espera do card deixa de contar quando a última fala do cliente não pede resposta ("ok, obrigado" depois de "assim que eu agendar te chamo"). Quem decide é a Assistente (por baixo, o Jev); o humano só pode religar a contagem, nunca desligar.

**Architecture:** o contador continua nascendo na hora, pelo trigger `fn_conversations_espera_desde` (0279). Um consumidor novo de `message.received` pergunta ao Jev se as mensagens sem resposta pedem resposta; com probabilidade ≤ 0,15 ele DISPENSA a espera: guarda o `espera_desde` suspenso e zera a coluna, num UPDATE condicional à conversa não ter mudado. O trigger passa a respeitar a dispensa e a desfaz sozinho quando chega mensagem nova do cliente ou quando a empresa responde. O botão "Contar mesmo assim" devolve a espera original e trava a Assistente até o fim desse ciclo de espera.

**Tech Stack:** Postgres (trigger PL/pgSQL, migration + apêndice do baseline), Next.js route handler, event_log handler, Jev/System One pela OpenRouter, React Query, Vitest (unit + invariants), Playwright.

---

## Decisões fechadas com o dono (2026-09-26)

| # | Decisão |
|---|---|
| A | O contador começa na hora; a Assistente só pode **dispensar**. Falha, sem chave ou dúvida ⇒ conta, como hoje. |
| B | Régua assimétrica: dispensa só com P(pede resposta) ≤ **0,15**. |
| C | Mensagem nova do cliente depois da dispensa ⇒ a espera volta, contando **da mensagem nova**. |
| D | Humano só religa ("Contar mesmo assim"), qualquer `agent+`. Ninguém dispensa na mão. Religar trava a Assistente até a empresa responder. |
| E | Toda religada é erro medido da Assistente (evento `espera_mantida` + audit) — é o laço de retorno. |
| F | Para operador o nome é **"Assistente"** (fixo, sem configuração). "Jev" só aparece em Configurações (transparência LGPD: para onde vão as mensagens). No código continua `jev`. |
| G | Sem chave da OpenRouter a feature não roda (sem fallback para modelo de conversa: custo e latência não compensam para essa pergunta). |
| H | Fora de escopo: a "promessa pendente" do atendente ("te chamo depois") virar lembrete. Registrar como ideia. |

## Modelo de dados (DIRC)

Três colunas em `conversations` (todas `timestamptz null`), porque a dispensa é estado DA conversa, lido pelo card, pelo realtime e pela ordenação — nada disso pode fazer join:

| Coluna | Significado | Quem escreve |
|---|---|---|
| `espera_dispensada_ate` | a `last_inbound_at` que a Assistente julgou que não pede resposta. Não-nula ⇔ dispensa **ativa** | worker (liga); trigger (desliga) ; rota "manter" (desliga) |
| `espera_dispensada_desde` | o `espera_desde` suspenso, para a religada devolver a espera original | worker; trigger/rota limpam |
| `espera_mantida_em` | quando um humano mandou contar mesmo assim. Não-nula ⇒ a Assistente não dispensa neste ciclo | rota "manter"; trigger limpa quando o ciclo termina |

`espera_desde` continua sendo a única coluna que o card, a ordenação "mais tempo esperando" e o cursor leem. **Dispensa = `espera_desde` nulo**, então nenhuma consulta de lista muda.

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20260926120000_0285_espera_que_pede_resposta.sql` (novo) | colunas + nova versão do trigger |
| `supabase/baseline.sql` (apêndice) | o mesmo bloco, idempotente |
| `supabase/migrations/MANIFEST.md` | linha da 0285 |
| `tests/invariants/espera-dispensada-pela-assistente.test.ts` (novo) | o trigger respeita, desfaz e limpa a dispensa |
| `lib/espera/pede-resposta.ts` (novo) | parte pura: pergunta ao Jev, estado, leitura, decisão |
| `lib/espera/pede-resposta.test.ts` (novo) | testes da parte pura |
| `lib/espera/dados.ts` (novo) | leitura da conversa e o UPDATE condicional da dispensa (admin, filtra org) |
| `workers/espera-da-assistente.ts` (novo) | orquestra: pula, espera transcrição, pergunta, dispensa |
| `workers/espera-da-assistente.test.ts` (novo) | worker com dependências falsas |
| `workers/espera-da-assistente.handler.ts` (novo) | adaptador do dispatcher |
| `workers/classificador-comercial.ts` | `registrarNoLlmCalls` ganha `purpose` |
| `lib/event-log/register-handlers.ts` | registra o handler |
| `app/api/v1/conversations/[id]/manter-espera/route.ts` (+ `route.test.ts`) (novo) | "Contar mesmo assim" |
| `hooks/inbox/useManterEspera.ts` (novo) | mutação do botão |
| `lib/inbox/espera.ts` (+ teste) | `esperaDispensada()` |
| `components/inbox/FaixaDaEspera.tsx` (novo) | faixa no corpo do chat: aguardando / dispensada + botão |
| `components/inbox/InboxLayout.tsx` | monta a faixa entre o chat e o aviso de retenção |
| `components/inbox/ConversationListItem.tsx` | selo discreto "Não pede resposta" |
| `app/api/v1/conversations/_handler.ts`, `lib/types/messaging.ts` | colunas novas no SELECT e no tipo |
| `lib/inbox/eventos-da-conversa.ts` | tipos `espera_dispensada` / `espera_mantida` e rótulos |
| `lib/audit/actions.ts` | `conversation.espera_mantida` |
| `lib/i18n/dicionario.ts` | textos novos em es |
| `app/app/settings/atendimento/_regua-de-espera.tsx` | parágrafo de transparência (Assistente usa o Jev) |
| `tests/e2e/espera-que-pede-resposta.spec.ts` (novo) + `.github/workflows/e2e.yml` | prova pela tela |
| `docs/testing/user-journey-map.md`, `.changes/espera-que-pede-resposta.md` | registro |

---

### Task 1: Migration 0285 — colunas e trigger que respeita a dispensa

**Files:**
- Create: `supabase/migrations/20260926120000_0285_espera_que_pede_resposta.sql`
- Modify: `supabase/baseline.sql` (apêndice, depois do bloco da 0284)
- Modify: `supabase/migrations/MANIFEST.md`
- Test: `tests/invariants/espera-dispensada-pela-assistente.test.ts`

- [ ] **Step 1: Conferir o número**

Run: `ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1`
Expected: `0284` (se vier maior, use o seguinte e ajuste o nome em todo o plano).

- [ ] **Step 2: Escrever o teste de invariante (vermelho)**

```ts
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Migration 0285 — a Assistente dispensa a espera de uma fala que não pede
 * resposta ("ok, obrigado"). A dispensa é um UPDATE direto em `espera_desde`
 * (fora da lista de colunas do trigger), e o trigger precisa: (1) não
 * ressuscitar a espera num UPDATE de status; (2) desfazer a dispensa quando o
 * cliente escreve de novo, contando da mensagem NOVA; (3) limpar tudo quando a
 * empresa responde.
 */
const CONTATO = "dddddddd-3333-4000-8000-000000000285";
const CONVERSA = "dddddddd-4444-4000-8000-000000000285";

function col(nome: string): string {
  return lastLine(sql(`select coalesce(${nome}::text, '(null)') from public.conversations where id = '${CONVERSA}';`));
}
function mensagem(direcao: "inbound" | "outbound", em: string): void {
  sql(`select public.fn_mark_conversation_message('${CONVERSA}'::uuid, '${direcao}', 'x', '${em}'::timestamptz);`);
}
/** O que o worker faz: guarda o espera_desde e o zera, se nada mudou. */
function dispensar(): void {
  sql(`update public.conversations
          set espera_dispensada_desde = espera_desde,
              espera_dispensada_ate   = last_inbound_at,
              espera_desde            = null
        where id = '${CONVERSA}' and espera_desde is not null and espera_mantida_em is null;`);
}
/** O que a rota "Contar mesmo assim" faz. */
function manter(): void {
  sql(`update public.conversations
          set espera_desde = coalesce(espera_dispensada_desde, last_inbound_at),
              espera_dispensada_ate = null, espera_dispensada_desde = null,
              espera_mantida_em = now()
        where id = '${CONVERSA}' and espera_dispensada_ate is not null;`);
}

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.conversations where id = '${CONVERSA}';
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${GOV_ORG}', 'Contato 0285') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${GOV_ORG}', '${CONTATO}', '${GOV_SESSION}', 'open');
  `);
});

describe("0285 — espera dispensada pela Assistente", () => {
  it("dispensar zera a espera e guarda a original", () => {
    mensagem("inbound", "2026-09-26 10:00:00+00");
    dispensar();
    expect(col("espera_desde")).toBe("(null)");
    expect(col("espera_dispensada_desde")).toBe("2026-09-26 10:00:00+00");
    expect(col("espera_dispensada_ate")).toBe("2026-09-26 10:00:00+00");
  });

  it("um UPDATE de status NÃO ressuscita a espera dispensada", () => {
    sql(`update public.conversations set status = 'pending' where id = '${CONVERSA}';`);
    sql(`update public.conversations set status = 'open' where id = '${CONVERSA}';`);
    expect(col("espera_desde")).toBe("(null)");
    expect(col("espera_dispensada_ate")).toBe("2026-09-26 10:00:00+00");
  });

  it("mensagem nova do cliente desfaz a dispensa e conta DA MENSAGEM NOVA", () => {
    mensagem("inbound", "2026-09-26 10:20:00+00");
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
    expect(col("espera_dispensada_ate")).toBe("(null)");
    expect(col("espera_dispensada_desde")).toBe("(null)");
  });

  it("religar devolve a espera ORIGINAL e trava a Assistente", () => {
    dispensar();
    manter();
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
    expect(col("espera_mantida_em")).not.toBe("(null)");
    dispensar(); // a trava: o worker condiciona a `espera_mantida_em is null`
    expect(col("espera_desde")).toBe("2026-09-26 10:20:00+00");
  });

  it("a resposta da empresa encerra o ciclo e limpa a trava", () => {
    mensagem("outbound", "2026-09-26 10:30:00+00");
    expect(col("espera_desde")).toBe("(null)");
    expect(col("espera_mantida_em")).toBe("(null)");
    expect(col("espera_dispensada_ate")).toBe("(null)");
  });

  it("depois da resposta, a próxima entrada abre ciclo novo, dispensável", () => {
    mensagem("inbound", "2026-09-26 11:00:00+00");
    expect(col("espera_desde")).toBe("2026-09-26 11:00:00+00");
    dispensar();
    expect(col("espera_desde")).toBe("(null)");
  });

  it("encerrar limpa a dispensa", () => {
    sql(`update public.conversations set status = 'closed' where id = '${CONVERSA}';`);
    expect(col("espera_dispensada_ate")).toBe("(null)");
    expect(col("espera_dispensada_desde")).toBe("(null)");
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test:db -- tests/invariants/espera-dispensada-pela-assistente.test.ts` (se o script não aceitar filtro, `pnpm test:db` inteiro)
Expected: FAIL — `column "espera_dispensada_desde" does not exist`.

- [ ] **Step 4: Escrever a migration**

`supabase/migrations/20260926120000_0285_espera_que_pede_resposta.sql`:

```sql
-- 0285 — A espera que pede resposta.
--
-- A Assistente (Jev) dispensa a espera quando a fala do cliente não pede
-- resposta ("ok, obrigado"). A dispensa é um UPDATE direto em `espera_desde`
-- feito pelo worker `workers/espera-da-assistente.ts`, condicionado a nada ter
-- mudado. Este trigger:
--   · não ressuscita espera dispensada num UPDATE de status;
--   · desfaz a dispensa quando o cliente escreve de novo (conta da nova);
--   · limpa dispensa e trava humana quando o ciclo termina (resposta/encerramento).
-- As colunas novas ficam FORA da lista de colunas do trigger de propósito: o
-- UPDATE da dispensa e o da religada não o disparam.

alter table public.conversations add column if not exists espera_dispensada_ate   timestamptz;
alter table public.conversations add column if not exists espera_dispensada_desde timestamptz;
alter table public.conversations add column if not exists espera_mantida_em       timestamptz;

comment on column public.conversations.espera_dispensada_ate is
  'A last_inbound_at que a Assistente julgou não pedir resposta. Não-nula = dispensa ativa (espera_desde nulo). Migration 0285.';
comment on column public.conversations.espera_dispensada_desde is
  'O espera_desde suspenso pela dispensa, devolvido por "Contar mesmo assim". Migration 0285.';
comment on column public.conversations.espera_mantida_em is
  'Quando um humano mandou contar mesmo assim: a Assistente não dispensa até o ciclo de espera terminar. Migration 0285.';

create or replace function public.fn_conversations_espera_desde()
returns trigger language plpgsql set search_path = public as $$
declare
  v_sem_resposta boolean :=
    new.last_inbound_at is not null
    and (new.last_outbound_at is null or new.last_inbound_at > new.last_outbound_at)
    and (new.service_closed_at is null or new.last_inbound_at > new.service_closed_at)
    and new.status not in ('closed', 'resolved', 'archived');
  v_dispensada boolean :=
    v_sem_resposta
    and new.espera_dispensada_ate is not null
    and new.last_inbound_at <= new.espera_dispensada_ate;
begin
  if not v_dispensada then
    new.espera_dispensada_ate := null;
    new.espera_dispensada_desde := null;
  end if;
  if not v_sem_resposta then
    new.espera_mantida_em := null;
  end if;

  if not v_sem_resposta or v_dispensada then
    new.espera_desde := null;
  elsif tg_op = 'INSERT' then
    new.espera_desde := coalesce(new.espera_desde, new.last_inbound_at);
  elsif old.espera_desde is null then
    new.espera_desde := new.last_inbound_at;
  else
    new.espera_desde := old.espera_desde;
  end if;
  return new;
end; $$;

revoke execute on function public.fn_conversations_espera_desde() from public, anon;
```

Antes de colar, confira que a assinatura e o `revoke` batem com a versão atual: `sed -n 27975,28030p supabase/baseline.sql`. O trigger em si (`create trigger` só se faltar) **não** é recriado: a lista de colunas continua a mesma.

- [ ] **Step 5: Apêndice idempotente no baseline**

No fim de `supabase/baseline.sql`, depois do último bloco (0284), acrescentar o MESMO conteúdo do Step 4 dentro de:

```sql
-- ---- espera que pede resposta: dispensa pela Assistente (migration 0285) ----
<conteúdo do Step 4>
```

- [ ] **Step 6: MANIFEST**

Acrescentar na tabela "Applied" de `supabase/migrations/MANIFEST.md`:

```
| `20260926120000` | `0285_espera_que_pede_resposta` | **O termômetro não conta a fala que não pede resposta.** Três colunas em `conversations`: `espera_dispensada_ate` (a entrada que a Assistente julgou não pedir resposta; não-nula = dispensa ativa), `espera_dispensada_desde` (o `espera_desde` suspenso, que "Contar mesmo assim" devolve) e `espera_mantida_em` (humano religou: a Assistente não dispensa até o ciclo terminar). `fn_conversations_espera_desde` (0279) passa a respeitar a dispensa num UPDATE de status, desfazê-la quando o cliente escreve de novo (contando da mensagem nova) e limpar dispensa e trava quando a empresa responde ou encerra. As colunas ficam fora da lista do trigger: a dispensa e a religada não o disparam. Sem backfill. Gate: `tests/invariants/espera-dispensada-pela-assistente.test.ts`. |
```

- [ ] **Step 7: Rodar e ver passar — install e update**

Run: `pnpm test:db`
Expected: baseline aplica em modo install e update sem erro; o arquivo novo e `espera-desde-e-fila-do-time.test.ts` (0279) PASS.

- [ ] **Step 8: Tipos do banco**

Acrescentar as três colunas em `lib/database.types.ts` (`conversations` Row/Insert/Update: `string | null`, opcional em Insert/Update), no mesmo formato de `espera_desde`. Run: `pnpm typecheck` → exit 0.

- [ ] **Step 9: Commit**

```bash
git add supabase/ tests/invariants/espera-dispensada-pela-assistente.test.ts lib/database.types.ts
git commit -m "feat(espera): migration 0285 — o trigger respeita a espera dispensada"
```

---

### Task 2: A pergunta ao Jev (parte pura)

**Files:**
- Create: `lib/espera/pede-resposta.ts`
- Test: `lib/espera/pede-resposta.test.ts`

- [ ] **Step 1: Teste (vermelho)**

```ts
import { describe, expect, it } from "vitest";

import {
  decidirDispensa,
  LIMIAR_PARA_DISPENSAR,
  lerRespostaDaEspera,
  montarEstadoDaEspera,
  PERGUNTAS_DA_ESPERA,
} from "./pede-resposta";

const m = (direcao: "inbound" | "outbound", texto: string | null) => ({ direcao, texto });

describe("montarEstadoDaEspera", () => {
  it("separa as falas do cliente ainda sem resposta do histórico", () => {
    const e = montarEstadoDaEspera([
      m("inbound", "minha internet caiu"),
      m("outbound", "assim que eu agendar um horário eu te chamo"),
      m("inbound", "ok"),
      m("inbound", "obrigado"),
    ]);
    expect(e).toEqual({
      conversa: [
        { quem: "cliente", texto: "minha internet caiu" },
        { quem: "atendente", texto: "assim que eu agendar um horário eu te chamo" },
      ],
      sem_resposta: ["ok", "obrigado"],
    });
  });

  it("null quando a última fala não é do cliente", () => {
    expect(montarEstadoDaEspera([m("inbound", "oi"), m("outbound", "olá")])).toBeNull();
  });

  it("null quando alguma fala sem resposta não tem texto (mídia sem transcrição): conta", () => {
    expect(montarEstadoDaEspera([m("outbound", "te chamo"), m("inbound", null)])).toBeNull();
  });

  it("corta o histórico nas últimas 10 falas", () => {
    const hist = Array.from({ length: 30 }, (_, i) => m(i % 2 ? "outbound" : "inbound", `f${i}`));
    const e = montarEstadoDaEspera([...hist, m("outbound", "fim"), m("inbound", "ok")]);
    expect(e?.conversa).toHaveLength(10);
    expect(e?.conversa.at(-1)).toEqual({ quem: "atendente", texto: "fim" });
  });
});

describe("decidirDispensa", () => {
  it("só dispensa com probabilidade de pedir resposta ≤ limiar", () => {
    expect(LIMIAR_PARA_DISPENSAR).toBe(0.15);
    expect(decidirDispensa(0.1)).toBe(true);
    expect(decidirDispensa(0.15)).toBe(true);
    expect(decidirDispensa(0.16)).toBe(false);
    expect(decidirDispensa(0.5)).toBe(false);
  });
});

describe("lerRespostaDaEspera", () => {
  it("lê noul, modelo e custo", () => {
    const r = lerRespostaDaEspera(
      { model: "typesafe/jev-1.13-x", answers: { pede_resposta: { noul: 0.08 } }, usage: { input_tokens: 100, cost: 0.00001 } },
      "typesafe/jev-1.13",
    );
    expect(r).toEqual({ ok: true, leitura: { pedeResposta: 0.08, modelo: "typesafe/jev-1.13-x", tokensDeEntrada: 100, custoEmCentavos: 0.001 } });
  });

  it("formato errado vira falha de contrato, nunca lança", () => {
    const r = lerRespostaDaEspera({ answers: {} }, "typesafe/jev-1.13");
    expect(r.ok).toBe(false);
  });

  it("a pergunta é noul e cita as falas sem resposta", () => {
    expect(PERGUNTAS_DA_ESPERA.pede_resposta.type).toBe("noul");
    expect(PERGUNTAS_DA_ESPERA.pede_resposta.instructions).toContain("`sem_resposta`");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run lib/espera/pede-resposta.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
/**
 * A FALA DO CLIENTE PEDE RESPOSTA? — a parte pura da espera da Assistente.
 *
 * O termômetro do card (migration 0279) conta desde a primeira fala do cliente
 * sem resposta. Mas "ok, obrigado" depois de "assim que eu agendar te chamo"
 * não espera nada, e o card ficava vermelho à toa. A Assistente (o Jev, por
 * baixo — para o operador o nome é sempre "Assistente") responde UMA pergunta
 * `noul`: as falas em `sem_resposta` pedem resposta? A decisão é assimétrica
 * (`LIMIAR_PARA_DISPENSAR`): na dúvida, conta. Cliente marcado atrasado à toa
 * é incômodo; cliente esquecido é grave.
 */
import { z } from "zod";

import { CENTAVOS_POR_MILHAO_DE_TOKENS } from "@/lib/classificador-comercial/jev";
import type { MensagemParaEstado } from "@/lib/classificador-comercial/perguntas";

export { MODELO_DO_JEV } from "@/lib/classificador-comercial/perguntas";

/** Histórico que vai junto: o bastante para saber o que o atendente prometeu. */
export const LIMITE_DO_HISTORICO = 10;
export const LIMITE_DE_CARACTERES = 400;
/** Dispensa só quando P(pede resposta) ≤ este valor (decisão B do plano). */
export const LIMIAR_PARA_DISPENSAR = 0.15;

export interface EstadoDaEspera {
  conversa: Array<{ quem: "cliente" | "atendente"; texto: string }>;
  sem_resposta: string[];
}

export const PERGUNTAS_DA_ESPERA = {
  pede_resposta: {
    type: "noul",
    instructions:
      "As mensagens do cliente em `sem_resposta` (as últimas, ainda sem resposta; o histórico está em `conversa`) pedem uma resposta ou uma ação do atendente?",
    criteria: {
      true:
        "O cliente pergunta algo, pede algo, reclama, traz informação nova que o atendente precisa tratar, discorda, ou cobra algo que ficou pendente",
      false:
        "O cliente só confirma, concorda, agradece, se despede ou manda um emoji, por exemplo 'ok', 'tudo bem', 'obrigado', 'combinado', depois de o atendente já ter dado a informação ou dito que retorna",
    },
  },
} as const;

function cortar(texto: string): string {
  return Array.from(texto).slice(0, LIMITE_DE_CARACTERES).join("");
}

/**
 * `mensagens` em ordem cronológica (quem garante é `ultimasMensagens`).
 * `null` = não há o que perguntar e a espera CONTA: a última fala não é do
 * cliente, ou alguma fala sem resposta não tem texto (áudio sem transcrição).
 */
export function montarEstadoDaEspera(mensagens: MensagemParaEstado[]): EstadoDaEspera | null {
  let i = mensagens.length;
  while (i > 0 && mensagens[i - 1]!.direcao === "inbound") i--;
  const pendentes = mensagens.slice(i);
  if (pendentes.length === 0) return null;
  if (pendentes.some((p) => !(p.texto ?? "").trim())) return null;

  const conversa = mensagens
    .slice(0, i)
    .map((p) => ({ quem: p.direcao === "inbound" ? ("cliente" as const) : ("atendente" as const), texto: (p.texto ?? "").trim() }))
    .filter((p) => p.texto !== "")
    .slice(-LIMITE_DO_HISTORICO)
    .map((p) => ({ ...p, texto: cortar(p.texto) }));
  return { conversa, sem_resposta: pendentes.map((p) => cortar((p.texto ?? "").trim())) };
}

export function decidirDispensa(pedeResposta: number): boolean {
  return pedeResposta <= LIMIAR_PARA_DISPENSAR;
}

const respostaSchema = z.object({
  model: z.string().optional(),
  answers: z.object({ pede_resposta: z.object({ noul: z.number().min(0).max(1) }) }),
  usage: z
    .object({ input_tokens: z.number().int().nonnegative(), cost: z.number().nonnegative().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

export interface LeituraDaEspera {
  pedeResposta: number;
  modelo: string;
  tokensDeEntrada: number | null;
  custoEmCentavos: number | null;
}

export type ResultadoDaLeitura = { ok: true; leitura: LeituraDaEspera } | { ok: false; detalhe: string };

export function lerRespostaDaEspera(corpo: unknown, modeloPedido: string): ResultadoDaLeitura {
  const lido = respostaSchema.safeParse(corpo);
  if (!lido.success) {
    return { ok: false, detalhe: `resposta fora do formato esperado: ${lido.error.issues.map((i) => i.path.join(".") || "(raiz)").join(", ")}` };
  }
  const a = lido.data;
  const tokens = a.usage?.input_tokens ?? null;
  const custo =
    a.usage?.cost !== undefined ? a.usage.cost * 100 : tokens === null ? null : (tokens * CENTAVOS_POR_MILHAO_DE_TOKENS) / 1_000_000;
  return {
    ok: true,
    leitura: { pedeResposta: a.answers.pede_resposta.noul, modelo: a.model ?? modeloPedido, tokensDeEntrada: tokens, custoEmCentavos: custo },
  };
}
```

`CENTAVOS_POR_MILHAO_DE_TOKENS` já é exportado por `lib/classificador-comercial/jev.ts:39`. No teste do custo, `0.00001 * 100 = 0.001` — se o float der `0.0009999…`, troque o `toEqual` do campo por `toBeCloseTo`.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run lib/espera/pede-resposta.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/espera/
git commit -m "feat(espera): a pergunta da Assistente — a fala do cliente pede resposta?"
```

---

### Task 3: Dados da espera (leitura + dispensa condicional)

**Files:**
- Create: `lib/espera/dados.ts`
- Modify: `workers/classificador-comercial.ts` (`registrarNoLlmCalls` ganha `purpose`)

- [ ] **Step 1: Implementar `lib/espera/dados.ts`**

```ts
/**
 * O banco da espera da Assistente. Service role: TODA consulta filtra
 * `organization_id` (vem do evento, fonte confiável — nunca de payload externo).
 * Erro de banco LANÇA: o drain aplica backoff.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ConversaDaEspera {
  espera_desde: string | null;
  last_inbound_at: string | null;
  espera_mantida_em: string | null;
  comando_da_conversa: string | null;
  status: string;
}

export interface DadosDaEspera {
  conversa(org: string, conversationId: string): Promise<ConversaDaEspera | null>;
  /** UPDATE condicional: só dispensa se a espera e a última entrada ainda são as lidas. `true` = dispensou. */
  dispensar(org: string, conversationId: string, lida: { espera_desde: string; last_inbound_at: string }): Promise<boolean>;
  registrarEvento(org: string, conversationId: string, payload: Record<string, unknown>): Promise<void>;
}

export function dadosDaEsperaViaSupabase(admin: SupabaseClient): DadosDaEspera {
  return {
    async conversa(org, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select("espera_desde, last_inbound_at, espera_mantida_em, comando_da_conversa, status")
        .eq("organization_id", org)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(`conversa da espera: ${error.message}`);
      return (data as ConversaDaEspera | null) ?? null;
    },
    async dispensar(org, conversationId, lida) {
      const { data, error } = await admin
        .from("conversations")
        .update({
          espera_dispensada_desde: lida.espera_desde,
          espera_dispensada_ate: lida.last_inbound_at,
          espera_desde: null,
        })
        .eq("organization_id", org)
        .eq("id", conversationId)
        .eq("espera_desde", lida.espera_desde)
        .eq("last_inbound_at", lida.last_inbound_at)
        .is("espera_mantida_em", null)
        .select("id");
      if (error) throw new Error(`dispensar espera: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async registrarEvento(org, conversationId, payload) {
      const { error } = await admin.rpc("fn_conversation_event_add", {
        p_org: org,
        p_conversation: conversationId,
        p_type: "espera_dispensada",
        p_payload: payload,
      });
      if (error) throw new Error(`evento espera_dispensada: ${error.message}`);
    },
  };
}
```

(`"espera_dispensada"` vira constante na Task 7; troque o literal por `EVENTO_ESPERA_DISPENSADA` lá.)

- [ ] **Step 2: `registrarNoLlmCalls` com `purpose`**

Em `workers/classificador-comercial.ts`, mudar a assinatura para
`export function registrarNoLlmCalls(admin: SupabaseClient, purpose = "commercial_classify")` e, no insert, `purpose,` no lugar de `purpose: "commercial_classify",`. Nas duas mensagens de `logger.warn`, trocar o prefixo fixo por `` `${purpose}: llm_calls não gravou` ``.

- [ ] **Step 3: Verificar**

Run: `pnpm typecheck && pnpm vitest run workers/classificador-comercial` → exit 0, PASS (o default mantém o comportamento).

- [ ] **Step 4: Commit**

```bash
git add lib/espera/dados.ts workers/classificador-comercial.ts
git commit -m "feat(espera): leitura da conversa e dispensa condicional"
```

---

### Task 4: O worker da Assistente

**Files:**
- Create: `workers/espera-da-assistente.ts`
- Test: `workers/espera-da-assistente.test.ts`

- [ ] **Step 1: Teste (vermelho)**

```ts
import { describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { processarEspera, type DependenciasDaEspera } from "./espera-da-assistente";

const AGORA = new Date("2026-09-26T10:01:00Z");
const ESPERA = "2026-09-26T10:00:00+00:00";

function evento(extra: Partial<EventRow> = {}): EventRow {
  return {
    id: "e1",
    organization_id: "org",
    entity_id: "msg",
    created_at: "2026-09-26T10:00:30Z",
    payload: { direction: "inbound", message_id: "msg", conversation_id: "conv", contact_id: "ct" },
    ...extra,
  } as unknown as EventRow;
}

function deps(over: Partial<DependenciasDaEspera> = {}, noul = 0.05): DependenciasDaEspera {
  return {
    espera: {
      conversa: vi.fn().mockResolvedValue({ espera_desde: ESPERA, last_inbound_at: ESPERA, espera_mantida_em: null, comando_da_conversa: "humano", status: "open" }),
      dispensar: vi.fn().mockResolvedValue(true),
      registrarEvento: vi.fn().mockResolvedValue(undefined),
    },
    mensagens: {
      mensagem: vi.fn().mockResolvedValue({ type: "text", media_derived_status: null }),
      ultimasMensagens: vi.fn().mockResolvedValue([
        { direcao: "outbound", texto: "assim que eu agendar te chamo" },
        { direcao: "inbound", texto: "ok obrigado" },
      ]),
      derivacaoPendente: vi.fn().mockResolvedValue(false),
    },
    chave: vi.fn().mockResolvedValue({ apiKey: "sk-or-teste", origem: "organizacao" }),
    consultar: vi.fn().mockResolvedValue({ ok: true, status: 200, latenciaMs: 300, corpo: { answers: { pede_resposta: { noul } } } }),
    registrarChamada: vi.fn(),
    agora: () => AGORA,
    ...over,
  } as unknown as DependenciasDaEspera;
}

describe("processarEspera", () => {
  it("'ok obrigado' depois de promessa: dispensa e registra evento", async () => {
    const d = deps();
    const r = await processarEspera(evento(), d);
    expect(r).toEqual({ status: "dispensada", probabilidade: 0.05 });
    expect(d.espera.dispensar).toHaveBeenCalledWith("org", "conv", { espera_desde: ESPERA, last_inbound_at: ESPERA });
    expect(d.espera.registrarEvento).toHaveBeenCalledWith("org", "conv", expect.objectContaining({ probabilidade: 0.05 }));
    expect(d.registrarChamada).toHaveBeenCalledTimes(1);
  });

  it("pede resposta: não dispensa", async () => {
    const d = deps({}, 0.9);
    expect(await processarEspera(evento(), d)).toEqual({ status: "pede_resposta", probabilidade: 0.9 });
    expect(d.espera.dispensar).not.toHaveBeenCalled();
  });

  it("sem espera, automático ou mantida por humano: não chama o Jev", async () => {
    for (const c of [
      { espera_desde: null, last_inbound_at: ESPERA, espera_mantida_em: null, comando_da_conversa: "humano", status: "open" },
      { espera_desde: ESPERA, last_inbound_at: ESPERA, espera_mantida_em: null, comando_da_conversa: "automatico", status: "open" },
      { espera_desde: ESPERA, last_inbound_at: ESPERA, espera_mantida_em: ESPERA, comando_da_conversa: "humano", status: "open" },
    ]) {
      const d = deps();
      (d.espera.conversa as ReturnType<typeof vi.fn>).mockResolvedValue(c);
      expect((await processarEspera(evento(), d)).status).toBe("pulado");
      expect(d.consultar).not.toHaveBeenCalled();
    }
  });

  it("sem chave: pula (a espera conta)", async () => {
    const d = deps({ chave: vi.fn().mockResolvedValue(null) } as Partial<DependenciasDaEspera>);
    expect(await processarEspera(evento(), d)).toEqual({ status: "pulado", motivo: "sem_chave" });
  });

  it("áudio ainda sem transcrição: tenta de novo em 15 s", async () => {
    const d = deps();
    (d.mensagens.mensagem as ReturnType<typeof vi.fn>).mockResolvedValue({ type: "audio", media_derived_status: null });
    const r = await processarEspera(evento(), d);
    expect(r.status).toBe("tentar_de_novo");
  });

  it("falha temporária do Jev: tenta de novo; de conta: pula (conta)", async () => {
    const tmp = deps({ consultar: vi.fn().mockResolvedValue({ ok: false, latenciaMs: 1, falha: { tipo: "temporaria", status: 503, detalhe: "x" } }) } as Partial<DependenciasDaEspera>);
    expect((await processarEspera(evento(), tmp)).status).toBe("tentar_de_novo");
    const conta = deps({ consultar: vi.fn().mockResolvedValue({ ok: false, latenciaMs: 1, falha: { tipo: "conta", status: 401, detalhe: "x" } }) } as Partial<DependenciasDaEspera>);
    expect(await processarEspera(evento(), conta)).toEqual({ status: "pulado", motivo: "jev_falhou:conta" });
  });

  it("corrida (conversa mudou entre ler e gravar): não registra evento", async () => {
    const d = deps();
    (d.espera.dispensar as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await processarEspera(evento(), d)).toEqual({ status: "pulado", motivo: "conversa_mudou" });
    expect(d.espera.registrarEvento).not.toHaveBeenCalled();
  });

  it("saída do atendente não é avaliada", async () => {
    const d = deps();
    const r = await processarEspera(evento({ payload: { direction: "outbound" } } as Partial<EventRow>), d);
    expect(r.status).toBe("pulado");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run workers/espera-da-assistente.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar**

```ts
/**
 * A ASSISTENTE DECIDE SE A ESPERA CONTA — consumidor de `message.received`.
 *
 * O trigger (0279/0285) liga a espera na hora; aqui a Assistente (o Jev por
 * baixo) só pode DISPENSAR (decisão A do plano 2026-09-26). Toda saída que
 * não seja "dispensada" deixa a espera contando, como antes da feature.
 *
 * Ordem, do mais barato ao mais caro: é entrada? a conversa espera gente
 * (humano/aguardando) e ainda espera? um humano já mandou contar? → só então
 * transcrição, chave e Jev. A dispensa é um UPDATE condicional
 * (`lib/espera/dados.ts`): se o cliente escreveu ou alguém respondeu enquanto
 * o Jev pensava, não grava nada — o evento da mensagem nova decide de novo.
 *
 * Custo: toda chamada vira linha em `llm_calls` com `purpose = wait_classify`
 * (IA › Execuções). Sem chave da OpenRouter a feature não roda (decisão G).
 */
import { cabecalhosDeAtribuicaoOpenRouter } from "@/lib/agent-engine/edge/llm/providers";
import { chaveDaOpenRouter } from "@/lib/classificador-comercial/chave";
import { dadosViaSupabase, type DadosDoClassificador } from "@/lib/classificador-comercial/dados";
import { consultarSystemOne, type FalhaDoJev } from "@/lib/classificador-comercial/jev";
import { dadosDaEsperaViaSupabase, type DadosDaEspera } from "@/lib/espera/dados";
import { decidirDispensa, lerRespostaDaEspera, MODELO_DO_JEV, montarEstadoDaEspera, PERGUNTAS_DA_ESPERA } from "@/lib/espera/pede-resposta";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { DERIVACAO_TERMINADA, TIPOS_DERIVAVEIS } from "@/lib/messaging/media/derivable";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ESPERA_APOS_FALHA_TEMPORARIA_MS,
  ESPERA_POR_TRANSCRICAO_MS,
  registrarNoLlmCalls,
  TETO_DE_FALHA_TEMPORARIA_MS,
  TETO_ESPERA_TRANSCRICAO_MS,
  type LinhaDeChamada,
} from "@/workers/classificador-comercial";

export const TEMPO_LIMITE_DA_ESPERA_MS = 5_000;
const COMANDOS_QUE_ESPERAM_GENTE: ReadonlySet<string> = new Set(["humano", "aguardando"]);

export type ResultadoDaEspera =
  | { status: "pulado"; motivo: string }
  | { status: "tentar_de_novo"; em: Date; motivo: string }
  | { status: "pede_resposta"; probabilidade: number }
  | { status: "dispensada"; probabilidade: number };

export interface DependenciasDaEspera {
  espera: DadosDaEspera;
  mensagens: Pick<DadosDoClassificador, "mensagem" | "ultimasMensagens" | "derivacaoPendente">;
  chave: (org: string) => ReturnType<typeof chaveDaOpenRouter>;
  consultar: typeof consultarSystemOne;
  registrarChamada: (linha: LinhaDeChamada) => void;
  agora: () => Date;
  baseUrl?: string;
}

function dependenciasReais(): DependenciasDaEspera {
  const admin = createAdminClient();
  return {
    espera: dadosDaEsperaViaSupabase(admin),
    mensagens: dadosViaSupabase(admin),
    chave: (org) => chaveDaOpenRouter(admin, org),
    consultar: consultarSystemOne,
    registrarChamada: registrarNoLlmCalls(admin, "wait_classify"),
    agora: () => new Date(),
    baseUrl: process.env.CLASSIFICADOR_COMERCIAL_BASE_URL?.trim() || undefined,
  };
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Predicado `foraDaRequisicao`: só adia (paga o Jev fora do webhook) quem pode ser dispensado. Falha ⇒ adia. */
export async function esperaPodeSerDispensada(
  event: EventRow,
  espera: Pick<DadosDaEspera, "conversa"> = dadosDaEsperaViaSupabase(createAdminClient()),
): Promise<boolean> {
  const conversationId = texto(event.payload?.conversation_id);
  if (event.payload?.direction !== "inbound" || !conversationId) return false;
  try {
    const c = await espera.conversa(event.organization_id, conversationId);
    return Boolean(c?.espera_desde && !c.espera_mantida_em && COMANDOS_QUE_ESPERAM_GENTE.has(c.comando_da_conversa ?? ""));
  } catch {
    return true;
  }
}

export async function processarEspera(event: EventRow, deps: DependenciasDaEspera = dependenciasReais()): Promise<ResultadoDaEspera> {
  const p = event.payload ?? {};
  if (p.direction !== "inbound") return { status: "pulado", motivo: "nao_e_entrada" };
  const messageId = texto(p.message_id) ?? event.entity_id;
  const conversationId = texto(p.conversation_id);
  const contactId = texto(p.contact_id);
  if (!messageId || !conversationId || !contactId) return { status: "pulado", motivo: "payload_incompleto" };
  const org = event.organization_id;

  const c = await deps.espera.conversa(org, conversationId);
  if (!c || !c.espera_desde || !c.last_inbound_at) return { status: "pulado", motivo: "sem_espera" };
  if (!COMANDOS_QUE_ESPERAM_GENTE.has(c.comando_da_conversa ?? "")) return { status: "pulado", motivo: "automatico" };
  if (c.espera_mantida_em) return { status: "pulado", motivo: "mantida_por_humano" };

  const agora = deps.agora().getTime();
  const idadeMs = event.created_at ? agora - new Date(event.created_at).getTime() : Number.POSITIVE_INFINITY;

  const disparadora = await deps.mensagens.mensagem(org, messageId);
  const aguardandoTexto =
    disparadora && TIPOS_DERIVAVEIS.has(disparadora.type) && !DERIVACAO_TERMINADA.has(disparadora.media_derived_status ?? "");
  if (aguardandoTexto && idadeMs < TETO_ESPERA_TRANSCRICAO_MS) {
    return { status: "tentar_de_novo", em: new Date(agora + ESPERA_POR_TRANSCRICAO_MS), motivo: "aguardando_transcricao" };
  }

  const estado = montarEstadoDaEspera(await deps.mensagens.ultimasMensagens(org, conversationId, 40));
  if (!estado) return { status: "pulado", motivo: "sem_texto_para_ler" };

  const chave = await deps.chave(org);
  if (!chave) return { status: "pulado", motivo: "sem_chave" };

  const atribuicao = cabecalhosDeAtribuicaoOpenRouter();
  const r = await deps.consultar({
    apiKey: chave.apiKey,
    estado,
    perguntas: PERGUNTAS_DA_ESPERA,
    modelo: MODELO_DO_JEV,
    tempoLimiteMs: TEMPO_LIMITE_DA_ESPERA_MS,
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(atribuicao ? { cabecalhosExtras: atribuicao } : {}),
  });
  const lida = r.ok ? lerRespostaDaEspera(r.corpo, MODELO_DO_JEV) : null;
  const falha: FalhaDoJev | null = !r.ok
    ? r.falha
    : lida && !lida.ok
      ? { tipo: "contrato", status: r.status, detalhe: lida.detalhe }
      : null;
  const leitura = lida?.ok ? lida.leitura : null;
  deps.registrarChamada({
    organizationId: org,
    contactId,
    modelo: leitura?.modelo ?? MODELO_DO_JEV,
    tokensDeEntrada: leitura?.tokensDeEntrada ?? null,
    custoEmCentavos: leitura?.custoEmCentavos ?? null,
    latenciaMs: r.latenciaMs,
    falha,
  });

  if (!leitura) {
    if (falha?.tipo === "temporaria" && idadeMs < TETO_DE_FALHA_TEMPORARIA_MS) {
      return { status: "tentar_de_novo", em: new Date(agora + ESPERA_APOS_FALHA_TEMPORARIA_MS), motivo: `jev_${falha.status ?? "rede"}` };
    }
    logger.warn("espera-da-assistente: o Jev não decidiu — a espera conta", {
      organization_id: org,
      conversation_id: conversationId,
      tipo: falha?.tipo ?? "desconhecido",
    });
    return { status: "pulado", motivo: `jev_falhou:${falha?.tipo ?? "desconhecido"}` };
  }

  const probabilidade = Number(leitura.pedeResposta.toFixed(3));
  if (!decidirDispensa(leitura.pedeResposta)) return { status: "pede_resposta", probabilidade };

  const dispensou = await deps.espera.dispensar(org, conversationId, { espera_desde: c.espera_desde, last_inbound_at: c.last_inbound_at });
  if (!dispensou) return { status: "pulado", motivo: "conversa_mudou" };
  await deps.espera.registrarEvento(org, conversationId, { probabilidade, ate: c.last_inbound_at, modelo: leitura.modelo });
  return { status: "dispensada", probabilidade };
}
```

Confira que `DadosDoClassificador` expõe `mensagem`, `ultimasMensagens` e `derivacaoPendente` com esses nomes (`lib/classificador-comercial/dados.ts:48-63`).

O áudio com transcrição que falhou (passou do teto) chega a `montarEstadoDaEspera` com `texto: null` ⇒ `null` ⇒ `sem_texto_para_ler` ⇒ conta. É o comportamento desejado (decisão A).

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run workers/espera-da-assistente.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/espera-da-assistente.ts workers/espera-da-assistente.test.ts
git commit -m "feat(espera): a Assistente dispensa a espera de fala que não pede resposta"
```

---

### Task 5: Handler e registro

**Files:**
- Create: `workers/espera-da-assistente.handler.ts`
- Modify: `lib/event-log/register-handlers.ts`

- [ ] **Step 1: Handler**

```ts
/**
 * Adaptador de `workers/espera-da-assistente.ts` para o dispatcher.
 * `foraDaRequisicao`: só a conversa que ESPERA gente e pode ser dispensada
 * paga o Jev fora do webhook; as outras terminam na requisição num `skipped`.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { esperaPodeSerDispensada, processarEspera } from "@/workers/espera-da-assistente";

export const ESPERA_DA_ASSISTENTE_HANDLER_KEY = "espera-da-assistente.v1";

/** Pulos de quase toda mensagem: com `detail`, o drain os gravaria em `last_error`. */
const PULOS_SILENCIOSOS: ReadonlySet<string> = new Set(["nao_e_entrada", "sem_espera", "automatico", "mantida_por_humano", "sem_chave"]);

export const esperaDaAssistenteHandler: EventHandler = {
  key: ESPERA_DA_ASSISTENTE_HANDLER_KEY,
  events: ["message.received"],
  foraDaRequisicao: (row) => esperaPodeSerDispensada(row),
  async handle(row): Promise<HandlerResult> {
    const consumer_key = ESPERA_DA_ASSISTENTE_HANDLER_KEY;
    try {
      const r = await processarEspera(row);
      switch (r.status) {
        case "pulado":
          return PULOS_SILENCIOSOS.has(r.motivo) ? { consumer_key, status: "skipped" } : { consumer_key, status: "skipped", detail: r.motivo };
        case "tentar_de_novo":
          return { consumer_key, status: "retry", retry_at: r.em.toISOString(), detail: r.motivo };
        case "pede_resposta":
          return { consumer_key, status: "ok", detail: `conta:${r.probabilidade.toFixed(2)}` };
        case "dispensada":
          return { consumer_key, status: "ok", detail: `dispensada:${r.probabilidade.toFixed(2)}` };
      }
    } catch (err) {
      return { consumer_key, status: "error", detail: err instanceof Error ? err.message.slice(0, 160) : "erro" };
    }
  },
};
```

- [ ] **Step 2: Registrar depois do classificador comercial**

Em `lib/event-log/register-handlers.ts`, importar e registrar logo depois de `registerHandler(classificadorComercialHandler);`:

```ts
  // A espera da Assistente também espera o Jev (até 5 s): fica no fim dos
  // consumidores de `message.received`, pela mesma razão do classificador.
  registerHandler(esperaDaAssistenteHandler);
```

- [ ] **Step 3: Verificar**

Run: `pnpm typecheck && pnpm vitest run lib/event-log` → exit 0, PASS. Se houver teste que congela a LISTA de handlers (procure `grep -rn "classificador-comercial.v1" tests lib --include=*.test.ts`), inclua a chave nova nele.

- [ ] **Step 4: Commit**

```bash
git add workers/espera-da-assistente.handler.ts lib/event-log/register-handlers.ts
git commit -m "feat(espera): registra a Assistente em message.received"
```

---

### Task 6: Rota "Contar mesmo assim"

**Files:**
- Create: `app/api/v1/conversations/[id]/manter-espera/route.ts`
- Test: `app/api/v1/conversations/[id]/manter-espera/route.test.ts`
- Modify: `lib/audit/actions.ts`

- [ ] **Step 1: Ação de auditoria**

Depois de `"conversation.started_in_team"` em `lib/audit/actions.ts`:

```ts
  // "Contar mesmo assim": um humano religou a espera que a Assistente dispensou
  // (migration 0285). metadata: { espera_desde, dispensada_ate }. É o erro
  // medido da Assistente — o laço de retorno da feature.
  "conversation.espera_mantida",
```

- [ ] **Step 2: Teste da rota (vermelho)**

Siga o molde de `app/api/v1/conversations/[id]/pause-ai/route.test.ts` (mesmos mocks de `requireRole`, `createClient`, `createAdminClient`, `audit`). Casos:

1. conversa com `espera_dispensada_ate` preenchido ⇒ 200; o update enviado contém `espera_desde = espera_dispensada_desde`, `espera_dispensada_ate: null`, `espera_dispensada_desde: null` e `espera_mantida_em` (string ISO); `audit` chamado com `conversation.espera_mantida`; RPC `fn_conversation_event_add` com `p_type: "espera_mantida"` e `p_actor = user.id`.
2. `espera_dispensada_ate` nulo ⇒ 409 `state_conflict`, sem update.
3. update condicional sem linha (corrida) ⇒ 409.
4. conversa inexistente/fora do escopo ⇒ 404.
5. `requireRole` negado ⇒ a resposta dele.

Run: `pnpm vitest run "app/api/v1/conversations/[id]/manter-espera"` → FAIL.

- [ ] **Step 3: Implementar**

```ts
/**
 * POST /api/v1/conversations/:id/manter-espera — "Contar mesmo assim".
 *
 * A Assistente dispensou a espera (a fala do cliente não pedia resposta) e a
 * pessoa discorda. Devolve o `espera_desde` ORIGINAL e trava a Assistente até
 * o ciclo de espera terminar (`espera_mantida_em`, migration 0285). É o único
 * gesto humano sobre a espera: ninguém DISPENSA na mão (decisão D do plano
 * 2026-09-26). Cada chamada é um erro medido da Assistente.
 *
 * Auth: cookie session, agent+. Leitura e escrita pelo client do REQUEST: a
 * policy de `conversations` aplica o escopo de visibilidade.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { EVENTO_ESPERA_MANTIDA } from "@/lib/inbox/eventos-da-conversa";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const supabase = await createClient();
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id, last_inbound_at, espera_dispensada_ate, espera_dispensada_desde")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!conv) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  const c = conv as { last_inbound_at: string | null; espera_dispensada_ate: string | null; espera_dispensada_desde: string | null };
  if (!c.espera_dispensada_ate) {
    return fail("state_conflict", t("A espera desta conversa já está sendo contada."), 409, { requestId });
  }

  const esperaDesde = c.espera_dispensada_desde ?? c.last_inbound_at;
  const { data: atualizada, error: updErr } = await supabase
    .from("conversations")
    .update({
      espera_desde: esperaDesde,
      espera_dispensada_ate: null,
      espera_dispensada_desde: null,
      espera_mantida_em: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .eq("espera_dispensada_ate", c.espera_dispensada_ate)
    .is("espera_desde", null)
    .select("id, espera_desde, espera_mantida_em")
    .maybeSingle();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });
  if (!atualizada) {
    return fail("state_conflict", t("A conversa mudou enquanto você clicava. Atualize e veja de novo."), 409, { requestId });
  }

  await audit({
    action: "conversation.espera_mantida",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
    metadata: { espera_desde: esperaDesde, dispensada_ate: c.espera_dispensada_ate },
  });

  // A linha do tempo do painel (log visível). Falha aqui não desfaz a religada.
  const { error: evErr } = await createAdminClient().rpc("fn_conversation_event_add", {
    p_org: org.orgId,
    p_conversation: id,
    p_type: EVENTO_ESPERA_MANTIDA,
    p_actor: user.id,
    p_payload: { espera_desde: esperaDesde },
  });
  if (evErr) logger.warn("manter-espera: evento não gravou", { conversation_id: id, error: evErr.message.slice(0, 120) });

  return ok({ conversation: atualizada }, { requestId });
}
```

Confira o caminho de `requireSupportWrite` e o formato de `logger` no `pause-ai/route.ts` e siga igual. Se a policy de UPDATE de `conversations` para `agent` recusar a escrita dessas colunas (teste manual na Task 10), troque o UPDATE por admin client **mantendo** a leitura pelo client do request (é ela que prova o escopo) e o filtro `organization_id`.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run "app/api/v1/conversations/[id]/manter-espera"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/api/v1/conversations/[id]/manter-espera" lib/audit/actions.ts
git commit -m "feat(espera): rota Contar mesmo assim, com auditoria e evento"
```

---

### Task 7: Vocabulário de eventos, tipos e colunas na lista

**Files:**
- Modify: `lib/inbox/eventos-da-conversa.ts`
- Modify: `lib/espera/dados.ts` (usar a constante)
- Modify: `app/api/v1/conversations/_handler.ts:129-139` (`SELECT_COLS`)
- Modify: `lib/types/messaging.ts` (depois de `espera_desde`)

- [ ] **Step 1: Eventos**

Em `TIPOS_DE_EVENTO_DA_CONVERSA`, depois de `"cliente_insatisfeito"`:

```ts
  // Emitidos por TypeScript (migration 0285): a Assistente dispensou a espera
  // (`workers/espera-da-assistente.ts`) e um humano a religou
  // (`app/api/v1/conversations/[id]/manter-espera/route.ts`).
  "espera_dispensada",
  "espera_mantida",
```

Constantes, ao lado de `EVENTO_CLIENTE_INSATISFEITO`:

```ts
export const EVENTO_ESPERA_DISPENSADA: TipoDeEventoDaConversa = "espera_dispensada";
export const EVENTO_ESPERA_MANTIDA: TipoDeEventoDaConversa = "espera_mantida";
```

Em `descreverEventoDaConversa`, antes do `default`:

```ts
    case "espera_dispensada":
      return {
        titulo: t("Assistente: a mensagem do cliente não pede resposta"),
        detalhe: t("A espera deixou de ser contada."),
        tom: "neutro",
      };
    case "espera_mantida":
      return { titulo: t("Espera contada mesmo assim"), detalhe: por("Por"), tom: "espera" };
```

Em `lib/espera/dados.ts`, trocar `p_type: "espera_dispensada"` por `p_type: EVENTO_ESPERA_DISPENSADA` (import de `@/lib/inbox/eventos-da-conversa`).

- [ ] **Step 2: Colunas**

`SELECT_COLS`: `bot_silenced_until, last_handoff_at, espera_desde, espera_dispensada_ate, sentimento_atual, sentimento_minimo,`

`lib/types/messaging.ts`, depois de `espera_desde?`:

```ts
  /**
   * Não-nulo = a Assistente dispensou a espera: a fala do cliente não pedia
   * resposta (migration 0285). Nesse estado `espera_desde` é nulo. O trigger
   * limpa a coluna quando o cliente escreve de novo ou a empresa responde.
   */
  espera_dispensada_ate?: string | null;
```

(`espera_dispensada_desde` e `espera_mantida_em` não vão para a lista: só a rota e o worker os leem.)

- [ ] **Step 3: Verificar**

Run: `pnpm typecheck && pnpm vitest run lib/inbox app/api/v1/conversations`
Expected: PASS. O teste que casa os tipos do vocabulário com o baseline (procure `grep -rln "TIPOS_DE_EVENTO_DA_CONVERSA" tests lib --include=*.test.ts`) pode exigir os tipos novos em algum lugar; siga o que ele disser.

- [ ] **Step 4: Commit**

```bash
git add lib/inbox/eventos-da-conversa.ts lib/espera/dados.ts app/api/v1/conversations/_handler.ts lib/types/messaging.ts
git commit -m "feat(espera): eventos espera_dispensada/mantida e coluna na lista"
```

---

### Task 8: Regra pura da tela + selo no card

**Files:**
- Modify: `lib/inbox/espera.ts` (+ teste existente ao lado)
- Modify: `components/inbox/ConversationListItem.tsx:207-221, 361-382`

- [ ] **Step 1: Teste (vermelho)** — no arquivo de teste de `lib/inbox/espera.ts` (`ls lib/inbox/espera*.test.ts tests/unit/*espera*`):

```ts
import { esperaDispensada } from "@/lib/inbox/espera";

describe("esperaDispensada", () => {
  const base = { status: "open", espera_desde: null, espera_dispensada_ate: "2026-09-26T10:00:00Z", comando_da_conversa: "humano" };
  it("true quando a Assistente dispensou e a conversa espera gente", () => {
    expect(esperaDispensada(base)).toBe(true);
    expect(esperaDispensada({ ...base, comando_da_conversa: "aguardando" })).toBe(true);
  });
  it("false sem dispensa, com espera contando, encerrada ou no automático", () => {
    expect(esperaDispensada({ ...base, espera_dispensada_ate: null })).toBe(false);
    expect(esperaDispensada({ ...base, espera_desde: "2026-09-26T10:05:00Z" })).toBe(false);
    expect(esperaDispensada({ ...base, status: "closed" })).toBe(false);
    expect(esperaDispensada({ ...base, comando_da_conversa: "automatico" })).toBe(false);
  });
});
```

- [ ] **Step 2: Implementar** em `lib/inbox/espera.ts` (reusa `TERMINAIS` e `COMANDOS_QUE_ESPERAM_GENTE` do arquivo):

```ts
/**
 * A Assistente julgou que a fala do cliente não pede resposta (migration 0285):
 * não há termômetro, e a tela diz por quê. Mesmo recorte de `esperaDaConversa`.
 */
export function esperaDispensada(conversa: {
  status: string;
  espera_desde?: string | null;
  espera_dispensada_ate?: string | null;
  comando_da_conversa?: string | null;
}): boolean {
  if (TERMINAIS.has(conversa.status)) return false;
  if (conversa.comando_da_conversa && !COMANDOS_QUE_ESPERAM_GENTE.has(conversa.comando_da_conversa)) return false;
  return !conversa.espera_desde && Boolean(conversa.espera_dispensada_ate);
}
```

- [ ] **Step 3: Selo no card** — em `ConversationListItem.tsx`, depois do cálculo de `espera` (L221):

```tsx
  const dispensada = !espera && esperaDispensada({
    status: conversation.status,
    espera_desde: conversation.espera_desde,
    espera_dispensada_ate: conversation.espera_dispensada_ate,
    comando_da_conversa: comando.quem === "ninguem" ? "aguardando" : comando.quem,
  });
```

E logo depois do bloco do termômetro (fim do `{(espera || queuePosition !== undefined) && (...)}`, L382):

```tsx
            {dispensada && (
              <span
                className="inline-flex min-w-0 items-center gap-1 text-fg-muted"
                data-testid="espera-dispensada"
                title={t("A Assistente viu que a mensagem do cliente não pede resposta.")}
              >
                <CheckCircle size={12} weight="regular" aria-hidden />
                <span className="truncate">{t("Não pede resposta")}</span>
              </span>
            )}
```

Importe `CheckCircle` do mesmo pacote de ícones usado por `Siren`/`Thermometer` no arquivo (ou pelo wrapper `lib/ui/icons.ts`, se o arquivo usar ele) e `esperaDispensada` de `@/lib/inbox/espera`. Confira o token `text-fg-muted` em `app/globals.css` (`grep -n "fg-muted" app/globals.css`); se não existir, use o token de texto secundário que o próprio card já usa.

- [ ] **Step 4: Verificar** — `pnpm vitest run lib/inbox components/inbox && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/inbox/espera.ts lib/inbox/*espera*.test.ts components/inbox/ConversationListItem.tsx
git commit -m "feat(espera): selo Não pede resposta no card"
```

---

### Task 9: Faixa da espera no corpo do chat + botão

**Files:**
- Create: `hooks/inbox/useManterEspera.ts`
- Create: `components/inbox/FaixaDaEspera.tsx` (+ `FaixaDaEspera.test.tsx`)
- Modify: `components/inbox/InboxLayout.tsx` (entre `</div>` do `ChatThread` e `<RetentionNotice>`)

- [ ] **Step 1: Hook** (molde: `hooks/inbox/usePauseAiAttendance.ts`)

```ts
"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/lib/api/show-error";

/** "Contar mesmo assim": religa a espera que a Assistente dispensou. */
export function useManterEspera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => apiClient.post(`/api/v1/conversations/${conversationId}/manter-espera`, {}),
    onError: showApiError,
    onSuccess: (_d, conversationId) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      qc.invalidateQueries({ queryKey: ["linha-do-tempo", conversationId] });
    },
  });
}
```

Confira o import real de `showApiError` e a chave de cache da linha do tempo em `usePauseAiAttendance.ts` e `hooks/inbox/useAtendimentos.ts:41` e use as mesmas.

- [ ] **Step 2: Teste do componente (vermelho)** — com Testing Library, como os outros `components/inbox/*.test.tsx`:

1. conversa esperando (espera_desde há 6 min, régua padrão) ⇒ texto "Cliente aguardando resposta há 6 min", `data-nivel="laranja"`.
2. conversa dispensada ⇒ texto "Assistente: o cliente só confirmou ou agradeceu — não pede resposta." e botão "Contar mesmo assim"; clicar chama a mutação com o id.
3. conversa no automático ou encerrada ⇒ nada renderizado.
4. `somenteLeitura` (atendimento antigo) ⇒ nada renderizado.

- [ ] **Step 3: Componente**

```tsx
"use client";
/**
 * A ESPERA NO CORPO DO CHAT. Duas situações, uma faixa só (estado, não log —
 * uma linha por mensagem seria ruído):
 *  · o cliente espera ⇒ "Cliente aguardando resposta há X", na cor do termômetro;
 *  · a Assistente dispensou ⇒ o porquê, e o único gesto humano: religar.
 * O histórico (quem dispensou, quem religou) fica na linha do tempo do painel.
 */
import { CheckCircle, Thermometer } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { useManterEspera } from "@/hooks/inbox/useManterEspera";
import { useT } from "@/lib/i18n/use-t";
import { esperaDaConversa, esperaDispensada, formatarEspera } from "@/lib/inbox/espera";
import type { ReguaDeEspera } from "@/lib/schemas/settings";
import { cn } from "@/lib/utils";

interface Props {
  conversa: {
    id: string;
    status: string;
    last_inbound_at: string | null;
    last_outbound_at: string | null;
    espera_desde?: string | null;
    espera_dispensada_ate?: string | null;
    comando_da_conversa?: string | null;
  };
  regua?: ReguaDeEspera;
  agora: Date;
  somenteLeitura?: boolean;
}

const COR: Record<string, string> = {
  normal: "border-border bg-bg-subtle text-fg-muted",
  amarelo: "border-warning-border bg-warning-bg text-warning-fg",
  laranja: "border-alert/40 bg-alert/15 text-alert-fg",
  vermelho: "border-error bg-error/10 text-error",
};

export function FaixaDaEspera({ conversa, regua, agora, somenteLeitura = false }: Props) {
  const t = useT();
  const manter = useManterEspera();
  if (somenteLeitura) return null;

  const espera = esperaDaConversa(conversa, agora, regua);
  if (espera) {
    return (
      <div
        className={cn("flex items-center gap-2 border-t px-4 py-1.5 text-xs", COR[espera.nivel])}
        data-testid="faixa-da-espera"
        data-nivel={espera.nivel}
        role="status"
      >
        <Thermometer size={14} weight="fill" aria-hidden />
        <span>{`${t("Cliente aguardando resposta há")} ${formatarEspera(espera.ms, t)}`}</span>
      </div>
    );
  }
  if (!esperaDispensada(conversa)) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-bg-subtle px-4 py-1.5 text-xs text-fg-muted"
      data-testid="faixa-da-espera-dispensada"
      role="status"
    >
      <span className="inline-flex items-center gap-2">
        <CheckCircle size={14} aria-hidden />
        {t("Assistente: o cliente só confirmou ou agradeceu — não pede resposta.")}
      </span>
      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={manter.isPending} onClick={() => manter.mutate(conversa.id)}>
        {t("Contar mesmo assim")}
      </Button>
    </div>
  );
}
```

Ajuste os imports aos que o repositório usa de fato (ícones: veja o topo de `ConversationListItem.tsx`; `t`: veja como `InboxLayout.tsx` obtém `t`; tokens de cor: copie as classes de `COR_DA_ESPERA` em `ConversationListItem.tsx:133-140` se as de cima não existirem em `app/globals.css`). Tailwind 4: classe nova precisa estar ao alcance dos `@source` (o `components/` já está).

- [ ] **Step 4: Montar no layout** — em `InboxLayout.tsx`, entre o `</div>` que fecha o `ChatThread` e `<RetentionNotice ...>`:

```tsx
            <FaixaDaEspera
              conversa={selectedConversation}
              regua={activeOrg?.regua_de_espera}
              agora={agora}
              somenteLeitura={vendoAtendimentoAntigo}
            />
```

Se o `InboxLayout` não tiver relógio próprio, crie um igual ao de `ConversationList.tsx:52-54` (`useState(new Date())` + `setInterval(..., 30_000)`), dentro do `FaixaDaEspera` em vez de receber `agora` por prop — o que for mais simples no arquivo real. `comando_da_conversa` vem do SELECT (já está lá).

- [ ] **Step 5: Verificar** — `pnpm vitest run components/inbox hooks/inbox && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 6: Commit**

```bash
git add hooks/inbox/useManterEspera.ts components/inbox/FaixaDaEspera.tsx components/inbox/FaixaDaEspera.test.tsx components/inbox/InboxLayout.tsx
git commit -m "feat(espera): faixa da espera no chat e o botão Contar mesmo assim"
```

---

### Task 10: Textos (es), transparência em Configurações

**Files:**
- Modify: `lib/i18n/dicionario.ts` (antes do `};` final)
- Modify: `app/app/settings/atendimento/_regua-de-espera.tsx`

- [ ] **Step 1: Parágrafo de transparência** em `_regua-de-espera.tsx`, abaixo da descrição da régua:

```tsx
<p className="text-xs text-fg-muted">
  {t("Quando a mensagem do cliente só confirma ou agradece, a Assistente deixa de contar a espera. Com uma chave da OpenRouter, ela usa o Jev, da TypeSafe: as últimas mensagens da conversa são enviadas à OpenRouter e à TypeSafe. Sem a chave, a espera é sempre contada.")}
</p>
```

(Use o mesmo `t` e a mesma classe de texto secundário que o arquivo já usa.)

- [ ] **Step 2: Dicionário** — bloco novo:

```ts
  // ── Espera que pede resposta (migration 0285) ──
  "Não pede resposta": { es: "No requiere respuesta" },
  "A Assistente viu que a mensagem do cliente não pede resposta.": { es: "La Asistente vio que el mensaje del cliente no requiere respuesta." },
  "Cliente aguardando resposta há": { es: "Cliente esperando respuesta hace" },
  "Assistente: o cliente só confirmou ou agradeceu — não pede resposta.": { es: "Asistente: el cliente solo confirmó o agradeció — no requiere respuesta." },
  "Contar mesmo assim": { es: "Contar de todos modos" },
  "Assistente: a mensagem do cliente não pede resposta": { es: "Asistente: el mensaje del cliente no requiere respuesta" },
  "A espera deixou de ser contada.": { es: "La espera dejó de contarse." },
  "Espera contada mesmo assim": { es: "Espera contada de todos modos" },
  "A espera desta conversa já está sendo contada.": { es: "La espera de esta conversación ya se está contando." },
  "A conversa mudou enquanto você clicava. Atualize e veja de novo.": { es: "La conversación cambió mientras hacías clic. Actualiza y vuelve a ver." },
  "Quando a mensagem do cliente só confirma ou agradece, a Assistente deixa de contar a espera. Com uma chave da OpenRouter, ela usa o Jev, da TypeSafe: as últimas mensagens da conversa são enviadas à OpenRouter e à TypeSafe. Sem a chave, a espera é sempre contada.": {
    es: "Cuando el mensaje del cliente solo confirma o agradece, la Asistente deja de contar la espera. Con una clave de OpenRouter usa Jev, de TypeSafe: los últimos mensajes de la conversación se envían a OpenRouter y a TypeSafe. Sin la clave, la espera siempre se cuenta.",
  },
```

Antes de colar, `grep -n '"Contar mesmo assim"\|"Não pede resposta"' lib/i18n/dicionario.ts` — chave duplicada quebra o objeto.

- [ ] **Step 3: Verificar** — `pnpm vitest run tests/unit/*dicionario* tests/unit/branding.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/i18n/dicionario.ts app/app/settings/atendimento/_regua-de-espera.tsx
git commit -m "feat(espera): textos em es e transparência sobre o Jev em Configurações"
```

---

### Task 11: Prova pela tela (e2e) e QA com Jev falso

**Files:**
- Create: `tests/e2e/espera-que-pede-resposta.spec.ts`
- Modify: `.github/workflows/e2e.yml` (spec numa `SPECS_PARTE_*`)
- Modify: `docs/testing/user-journey-map.md`

- [ ] **Step 1: Spec** — siga o molde de uma spec do Inbox que semeia conversa pelo banco (procure `grep -ln "espera-da-conversa" tests/e2e/*.spec.ts`, provavelmente a da 1.42.0). Cenário:

1. Semeia conversa `humano` com inbound às `agora-6min`, sem outbound ⇒ no card `espera-da-conversa` com `data-nivel="laranja"`; no chat `faixa-da-espera`.
2. Simula a dispensa no banco (o mesmo UPDATE do worker: `espera_dispensada_desde = espera_desde, espera_dispensada_ate = last_inbound_at, espera_desde = null`) ⇒ pelo realtime, o card troca para `espera-dispensada` ("Não pede resposta") e o chat mostra `faixa-da-espera-dispensada`.
3. Clica "Contar mesmo assim" ⇒ o termômetro volta com a hora ORIGINAL (title "Cliente sem resposta desde HH:mm" da inbound semeada); a linha do tempo do painel mostra "Espera contada mesmo assim".
4. Screenshot de cada estado em `.superpowers/evidence/espera-que-pede-resposta/`.
Medidas por ferramenta (`getAttribute('data-nivel')`, texto), não a olho.

- [ ] **Step 2: Rodar** — `pnpm test:e2e tests/e2e/espera-que-pede-resposta.spec.ts` (receita de ambiente fresco do CLAUDE.md: baseline.sql + bootstrap-owner, `next build && next start`). Expected: PASS.

- [ ] **Step 3: QA com o worker de verdade** — suba um receptor HTTP local que imite `POST /systemone` devolvendo `{ "model": "typesafe/jev-1.13", "answers": { "pede_resposta": { "noul": 0.05 } }, "usage": { "input_tokens": 120 } }`, aponte `CLASSIFICADOR_COMERCIAL_BASE_URL` para ele e cadastre uma chave OpenRouter de teste na org. Envie pelo canal de teste "minha internet caiu", responda como atendente "assim que eu agendar te chamo", envie "ok obrigado", rode o dreno (`curl` no endpoint de cron do event_log) e prove pela tela: o card troca para "Não pede resposta". Troque o receptor para `noul: 0.9`, mande "e o horário de sábado?" ⇒ termômetro contando desde essa mensagem. Confira `llm_calls` com `purpose = 'wait_classify'`. Evidência em `.superpowers/evidence/`.

- [ ] **Step 4: Registrar** — em `.github/workflows/e2e.yml`, a spec numa `SPECS_PARTE_*` (a de menor tempo); rode `pnpm vitest run tests/unit/e2e-cobertura-completa.test.ts` → PASS. Em `docs/testing/user-journey-map.md`, na jornada do Inbox, o caso "espera dispensada pela Assistente e religada pelo atendente" com a spec.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/espera-que-pede-resposta.spec.ts .github/workflows/e2e.yml docs/testing/user-journey-map.md
git commit -m "test(espera): prova pela tela — dispensada, selo, faixa e religada"
```

---

### Task 12: Sistema vivo, fragmento, verificação final

**Files:**
- Create: `.changes/espera-que-pede-resposta.md`
- Modify: mapa em `docs/architecture/` que cita `espera_desde` (`grep -ln "espera_desde\|termometro" docs/architecture/*.json`)

- [ ] **Step 1: Mapa vivo** — no mapa que contém o termômetro, nó `espera-da-assistente` com arestas: `message.received` → worker; worker → `conversations.espera_*`; worker → `llm_calls (wait_classify)`; worker → `conversation_events (espera_dispensada)`; rota `manter-espera` → `conversations` + `api_audit_log` + `conversation_events (espera_mantida)`. Rode `pnpm vitest run tests/unit/mapas-de-arquitetura.test.ts` → PASS.

- [ ] **Step 2: Laço de retorno (invariante 7)** — documentar no cabeçalho de `workers/espera-da-assistente.ts` a consulta que mede o erro da Assistente:

```sql
select date_trunc('day', created_at) dia,
       count(*) filter (where type = 'espera_dispensada') dispensadas,
       count(*) filter (where type = 'espera_mantida')    religadas
  from conversation_events
 where organization_id = :org and type in ('espera_dispensada','espera_mantida')
 group by 1 order by 1 desc;
```

Religadas/dispensadas alto ⇒ baixar `LIMIAR_PARA_DISPENSAR` ou reescrever os critérios.

- [ ] **Step 3: Fragmento**

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: O termômetro de espera não conta mais o "ok, obrigado" do cliente
---

O termômetro do card (as cores de 2, 5 e 10 minutos) contava toda mensagem do cliente sem
resposta — inclusive "ok, tudo bem, obrigado" depois de o atendente dizer que retornaria. Agora a
Assistente lê as últimas mensagens e, quando o cliente só confirma, agradece ou se despede, deixa de
contar a espera: o card mostra "Não pede resposta" e o chat explica o porquê. Na dúvida, a espera
continua contando. Se o cliente escrever de novo, a contagem volta a partir da mensagem nova.

Quem discorda clica em "Contar mesmo assim", e a espera volta desde a primeira mensagem sem
resposta. Ninguém consegue desligar a contagem na mão. Cada religada fica registrada na linha do
tempo da conversa.

Funciona com uma chave da OpenRouter (em IA › Credenciais ou na instalação), pelo Jev. Sem ela, a
espera é contada como antes. Nada precisa ser configurado; o banco recebe três colunas novas no
`update.sh`.
```

Run: `pnpm release:conferir` → válido.

- [ ] **Step 4: Suíte completa (CLAUDE.md §Testes)**

```bash
pnpm typecheck && pnpm lint
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |Errors " /tmp/vt.log | tail -3
pnpm test:db
```

Expected: `exit=0`, 0 failed, sem linha `Errors`; `test:db` verde (install + update + invariantes). Vermelhos conhecidos desta máquina (`leads-import-route`, apóstrofo do `test-validators`, `rate-limit` sem Redis local) não são desta mudança — confirme que são os mesmos da `main`.

- [ ] **Step 5: Commit**

```bash
git add .changes/espera-que-pede-resposta.md docs/architecture workers/espera-da-assistente.ts
git commit -m "docs(espera): mapa vivo, laço de retorno e fragmento de release"
```

---

## Fora de escopo (registrado)

- **Promessa pendente vira lembrete** (decisão H): "assim que eu agendar te chamo" é uma dívida NOSSA; a Assistente poderia sugerir um lembrete. Issue separada.
- **"Assistente" nos textos já existentes** voltados ao operador (selo de sentimento etc.): hoje nenhum cita "Jev" para o operador; revisar numa passada própria se o dono quiser a mesma voz em tudo.
