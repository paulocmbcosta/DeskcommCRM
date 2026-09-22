# A IA identifica o cliente no IXC e envia a cobrança — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dar ao agente de IA duas ferramentas — `crm_consultar_cliente_erp` e `crm_enviar_cobranca_erp` — que identificam o cliente da conversa no IXC e enviam a cobrança da fatura da vez (Pix ou boleto) pela saída do motor, com o limite de dias configurável na tela.

**Architecture:** o conector ganha `DefinicaoDeConector.agente` (contrato sem IXC em `lib/conectores/tipos.ts`), implementado em `lib/conectores/ixc/agente.ts`. O motor monta as ferramentas nativas em `lib/agent-engine/agent/ferramentas-do-conector.ts`, falando só com o registro, e cada mensagem da cobrança sai pela cadeia `runBeforeSend` (nova opção `conteudoDoSistema`) e pelo canal do turno, que ganha `media`. Catálogo + handler MCP que recusa existem só para a tela; a migration 0274 guarda o limite de dias.

**Tech Stack:** Next.js 16 / TypeScript 6, AI SDK v6 (`tool`), Zod 4, Supabase (admin client + Storage), Postgres (`pg`), Vitest, Playwright.

**Spec:** [`docs/superpowers/specs/2026-09-22-ia-envia-cobranca-ixc-design.md`](../specs/2026-09-22-ia-envia-cobranca-ixc-design.md). Leia-a antes de começar.

---

## Correções decididas DURANTE a execução (leia antes das tarefas)

1. **O telefone tem TRÊS estados, não dois.** As Tarefas 1 e 4 saíram com um booleano
   `telefoneEhIdentidade(provider)`, e a revisão mostrou o buraco: `false` significava tanto
   "canal de telefone digitado" quanto "não sei" (chamada sem `?conversa=`, provider que a
   imagem não conhece, erro de leitura) — e, como o painel passou a ESCONDER vínculo por
   telefone no `false`, uma aba antiga aberta depois de uma atualização faria todo contato de
   WhatsApp aparecer como não vinculado. A régua virou
   `identidadeDoTelefone(provider): "sim" | "nao" | "desconhecido"` (a capacidade booleana da
   matriz continua): vincula sozinho só em `"sim"`; descarta vínculo `telefone` existente só em
   `"nao"`. As Tarefas 5, 6, 7 e 13 abaixo já estão escritas com o tri-estado.
2. **Promover, nunca duplicar.** `vincular` promove a linha existente quando o vínculo novo é
   mais forte (`documento`/`manual` sobre `telefone`) em vez de devolver `false` no 23505 —
   senão o contato que o furo antigo vinculou fica preso em "escolher" para sempre.
3. **Fatura de valor zero não se cobra** (Tarefa 7): `reaisParaCents` devolve 0 para valor
   ilegível, e a IA mandaria uma cobrança de R$ 0,00.
4. **`vincular` mudou de assinatura** (Tarefa 6): devolve `{ vinculou, promovido }`, não mais
   `boolean` — `vinculou` é true tanto para linha nova quanto para promoção.

## Regras que valem para todas as tarefas

- Worktree: `/Volumes/T9/Dyper/.claude/worktrees/bia-ixc-cobranca-tools-32a240`, branch `claude/bia-ixc-cobranca-tools-32a240`. Antes de começar e antes do PR: `git fetch origin && git merge origin/main`.
- Rodar um arquivo de teste: `pnpm exec vitest run <caminho>`. Suíte: `pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"` e ler o rodapé (`grep -aE "Test Files|Tests |Errors " /tmp/vt.log | tail -3`). **O exit code é a autoridade.**
- Vermelhos locais conhecidos desta máquina (não são desta feature): `leads-import-route` (11) e o apóstrofo de `test-validators` — memória `deskcomm-vermelhos-locais-desta-maquina`; `lib/ai/dispatcher/rate-limit.test.ts` se o Redis local estiver fora.
- Commit ao fim de cada tarefa, mensagem em português, terminando com `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Todo `t("…")` novo em tela precisa de entrada em `lib/i18n/dicionario.ts` (`"texto": { es: "…" }`) — `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` reprova sem.

## Mapa de arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `lib/channels/types.ts`, `lib/channels/capabilities.ts` | modificar | capacidade `telefoneEhIdentidade` + helper fail-closed |
| `lib/conectores/ixc/faturas.ts` | modificar | `faturaDaVez`; `FORMAS_DE_COBRANCA` passa a vir de `tipos.ts` |
| `lib/conectores/ixc/campos.ts` | modificar | `CAMPOS_DA_CONFERENCIA` |
| `lib/conectores/ixc/identificar.ts` | modificar | `nascimentoDoIxc`, `dataInformada`, `cadastrosQueConferem` |
| `lib/conectores/ixc/painel.ts` + rota + hook + `PainelIxc.tsx` | modificar | 1 candidato só vincula sozinho onde o telefone é identidade |
| `lib/conectores/tipos.ts` | modificar | contrato `CapacidadeDoAgente` e tipos da cobrança |
| `lib/conectores/ferramentas-do-agente.ts` | criar | ids e descrições das duas ferramentas (fonte única) |
| `lib/conectores/ixc/agente.ts` | criar | `consultar` + `enviarCobranca` do IXC |
| `lib/conectores/ixc/enviar-cobranca.ts` | modificar | tipos das portas passam a vir de `tipos.ts` |
| `lib/conectores/registro.ts` | modificar | `conectorDoAgente(admin, orgId)` |
| `lib/conectores/conexao.ts` | modificar | limite de dias: ler/salvar, e na `ConexaoPublica` |
| `supabase/migrations/20260922120000_0274_conector_cobranca_limite_de_dias.sql`, `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`, `lib/database.types.ts` | criar/modificar | a coluna do limite |
| `app/api/v1/conectores/route.ts`, `app/api/v1/conectores/[conector]/conexao/route.ts`, `app/app/settings/conectores/_components/ConectoresClient.tsx` | modificar | o limite na tela |
| `lib/agent-engine/channel-adapter.ts`, `lib/agent-engine/edge/crm/send-message.ts` | modificar | `media` na saída do motor |
| `lib/agent-engine/guardrails/before-send.ts` | modificar | `conteudoDoSistema` |
| `lib/mcp/tools/catalogo/sistema-de-gestao.ts`, `lib/mcp/tools/catalogo/index.ts`, `lib/mcp/tools/sistema-de-gestao.ts`, `lib/mcp/tools/index.ts` | criar/modificar | capacidade na tela + handler que recusa |
| `app/api/v1/mcp/tools/route.ts` | modificar | só oferece as duas a quem tem conector |
| `lib/agent-engine/edge/crm/mcp-tools.ts` | modificar | `NATIVAS_DO_MOTOR`: a ponte nunca as monta |
| `lib/agent-engine/agent/ferramentas-do-conector.ts` | criar | as ferramentas nativas |
| `lib/agent-engine/agent/inbound-turn.ts`, `lib/agent-engine/agent/preview.ts`, `lib/agent-engine/edge/llm/fila-de-envio.ts` | modificar | a ligação no turno, na prévia e na fila |
| `lib/audit/actions.ts` | modificar | 3 ações novas |
| `scripts/e2e-turno-da-ia-cobranca.ts`, `tests/e2e/conector-ixc-no-painel.spec.ts` | criar/modificar | prova pela tela |
| `docs/architecture/conectores.architecture.json`, `docs/testing/user-journey-map.md`, `.changes/ia-envia-cobranca-ixc.md` | modificar/criar | mapa vivo, jornada, fragmento |

---

### Task 1: capacidade de canal `telefoneEhIdentidade`

**Files:**
- Modify: `lib/channels/types.ts` (interface `ChannelCapabilities`)
- Modify: `lib/channels/capabilities.ts` (matriz + helper)
- Test: `tests/unit/channel-capability-matrix.test.ts`

- [ ] **Step 1: teste que falha**

Em `tests/unit/channel-capability-matrix.test.ts`, acrescente `"telefoneEhIdentidade"` ao fim do array `CAPABILITIES`, importe `telefoneEhIdentidade` de `@/lib/channels/capabilities` e acrescente dentro do `describe("matriz capability × provider é exaustiva", …)`:

```ts
  it("o telefone só é identidade onde o transporte É o número (chat do site: digitado)", () => {
    expect(capabilitiesOf("waha").telefoneEhIdentidade).toBe(true);
    expect(capabilitiesOf("meta_cloud").telefoneEhIdentidade).toBe(true);
    expect(capabilitiesOf("zernio").telefoneEhIdentidade).toBe(true);
    expect(capabilitiesOf("site_widget").telefoneEhIdentidade).toBe(false);
  });

  it("o helper falha fechado: provider ausente, de voz ou desconhecido não é identidade", () => {
    expect(telefoneEhIdentidade("waha")).toBe(true);
    expect(telefoneEhIdentidade("site_widget")).toBe(false);
    expect(telefoneEhIdentidade("wacalls")).toBe(false);
    expect(telefoneEhIdentidade("provider-que-nao-existe")).toBe(false);
    expect(telefoneEhIdentidade(null)).toBe(false);
    expect(telefoneEhIdentidade(undefined)).toBe(false);
  });
```

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run tests/unit/channel-capability-matrix.test.ts` → FAIL (`telefoneEhIdentidade` não existe / propriedade ausente).

- [ ] **Step 3: implementar**

Em `lib/channels/types.ts`, dentro de `ChannelCapabilities`, depois de `outboundFirst`:

```ts
  /**
   * O telefone do contato É a identidade do transporte neste canal?
   *
   * `true` = quem escreve controla aquele número (no WhatsApp a mensagem chega DO
   * número). `false` = o telefone, se existe, foi DIGITADO num formulário aberto —
   * o chat do site grava em `contacts.phone_number` o que o visitante digitou — e
   * não prova nada. Quem identifica um cliente num sistema externo pelo telefone
   * (o painel do IXC, a IA que envia a cobrança) pergunta ISTO: sem a pergunta,
   * quem digitasse o celular de outra pessoa receberia a fatura dela.
   */
  telefoneEhIdentidade: boolean;
```

Em `lib/channels/capabilities.ts`, acrescente `identidadeDoTelefone: "sim",` nas entradas `waha`, `meta_cloud` e `zernio` e `identidadeDoTelefone: "nao",` em `site_widget`. Depois de `capabilitiesOf`, acrescente:

```ts
/**
 * O telefone é identidade no canal deste provider? Fail-closed: provider
 * ausente, de voz ou que esta imagem não conhece responde `false` — errar para o
 * lado de "é identidade" entregaria dado de um cliente a quem só digitou o
 * número dele.
 */
export function telefoneEhIdentidade(provider: string | null | undefined): boolean {
  const linha = (CHANNEL_CAPABILITIES as Partial<Record<string, ChannelCapabilities>>)[provider ?? ""];
  return linha?.telefoneEhIdentidade === true;
}
```

- [ ] **Step 4: ver passar** — mesmo comando → PASS. Rode também `pnpm typecheck` (algum fixture que monte `ChannelCapabilities` à mão acusa a propriedade faltando; acrescente-a nele).

- [ ] **Step 5: commit**

```bash
git add lib/channels/types.ts lib/channels/capabilities.ts tests/unit/channel-capability-matrix.test.ts
git commit -m "feat(canais): capacidade telefoneEhIdentidade — o telefone só prova quem é onde ele é o transporte

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `faturaDaVez` e `FORMAS_DE_COBRANCA` no contrato

**Files:**
- Modify: `lib/conectores/tipos.ts`, `lib/conectores/ixc/faturas.ts`
- Test: `lib/conectores/ixc/faturas.test.ts`

- [ ] **Step 1: teste que falha** — ao fim de `lib/conectores/ixc/faturas.test.ts`:

```ts
import { faturaDaVez, lerFatura } from "./faturas";

describe("faturaDaVez — UMA fatura por vez (regra do dono, 22/09)", () => {
  const HOJE = "2026-09-22";
  const f = (id: string, venc: string) =>
    lerFatura({ id, id_cliente: "10", status: "A", data_vencimento: venc, valor: "100.00", valor_aberto: "100.00" }, HOJE)!;

  it("a vencida MAIS ANTIGA vence qualquer outra", () => {
    const escolhida = faturaDaVez([f("3", "2026-09-10"), f("1", "2026-07-14"), f("9", "2026-10-12"), f("2", "2026-08-13")]);
    expect(escolhida?.id).toBe("1");
    expect(escolhida?.situacao).toBe("vencida");
  });

  it("sem vencida, a que vence primeiro", () => {
    expect(faturaDaVez([f("9", "2026-11-12"), f("8", "2026-10-12")])?.id).toBe("8");
  });

  it("empate no vencimento: decide o id, não a ordem de chegada", () => {
    expect(faturaDaVez([f("20", "2026-07-14"), f("7", "2026-07-14")])?.id).toBe("7");
    expect(faturaDaVez([f("7", "2026-07-14"), f("20", "2026-07-14")])?.id).toBe("7");
  });

  it("nenhuma fatura: null", () => {
    expect(faturaDaVez([])).toBeNull();
  });
});
```

(Se `faturas.test.ts` já importa de `./faturas`, junte os nomes no import existente em vez de duplicá-lo.)

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run lib/conectores/ixc/faturas.test.ts` → FAIL (`faturaDaVez` não é função).

- [ ] **Step 3: implementar**

Em `lib/conectores/tipos.ts`, depois de `FORMAS_DE_VERIFICACAO`:

```ts
/** Como a cobrança sai: o PDF do boleto ou o Pix. Vocabulário do produto, não do ERP. */
export const FORMAS_DE_COBRANCA = ["boleto", "pix"] as const;
export type FormaDeCobranca = (typeof FORMAS_DE_COBRANCA)[number];
```

Em `lib/conectores/ixc/faturas.ts`, troque

```ts
export const FORMAS_DE_COBRANCA = ["boleto", "pix"] as const;
export type FormaDeCobranca = (typeof FORMAS_DE_COBRANCA)[number];
```

por

```ts
// O vocabulário mora no contrato (`../tipos`): o motor fala dele sem conhecer o IXC.
export { FORMAS_DE_COBRANCA, type FormaDeCobranca } from "../tipos";
```

e acrescente, depois de `recortarFaturas`:

```ts
/**
 * A FATURA DA VEZ — a única que se cobra agora (regra do dono, 22/09): a vencida
 * mais antiga; sem vencida, a que vence primeiro. Nunca duas.
 *
 * Em ordem crescente de vencimento a primeira JÁ é a resposta — toda vencida
 * vence antes de toda a vencer. O desempate pelo id existe para a escolha não
 * depender da ordem em que o IXC devolveu duas parcelas do mesmo dia.
 */
export function faturaDaVez(faturas: readonly Fatura[]): Fatura | null {
  const ordenadas = [...faturas].sort(
    (a, b) => a.vencimento.localeCompare(b.vencimento) || a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
  return ordenadas[0] ?? null;
}
```

- [ ] **Step 4: ver passar** — mesmo comando → PASS; `pnpm typecheck` → 0 erros (os importadores de `FORMAS_DE_COBRANCA` continuam achando pelo re-export).

- [ ] **Step 5: commit** — `git add lib/conectores/tipos.ts lib/conectores/ixc/faturas.ts lib/conectores/ixc/faturas.test.ts && git commit -m "feat(ixc): faturaDaVez — a mais atrasada, senão a próxima; nunca duas" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 3: conferência de CPF + data de nascimento

**Files:**
- Modify: `lib/conectores/ixc/campos.ts`, `lib/conectores/ixc/identificar.ts`
- Test: `lib/conectores/ixc/identificar.test.ts`

- [ ] **Step 1: testes que falham** — ao fim de `lib/conectores/ixc/identificar.test.ts` (o arquivo já declara `const listar = vi.fn()` e mocka `./http` com ele; os casos abaixo o reusam):

```ts
import { cadastrosQueConferem, dataInformada, nascimentoDoIxc } from "./identificar";

describe("data de nascimento — como o IXC grava (medido em 22/09)", () => {
  it("AAAA-MM-DD vale; 0000-00-00, vazio e ano < 1900 são 'sem data'", () => {
    expect(nascimentoDoIxc("1985-03-12")).toBe("1985-03-12");
    expect(nascimentoDoIxc("0000-00-00")).toBeNull();
    expect(nascimentoDoIxc("")).toBeNull();
    expect(nascimentoDoIxc(undefined)).toBeNull();
    expect(nascimentoDoIxc("0001-01-01")).toBeNull();
  });

  it("a data que o cliente informa: AAAA-MM-DD ou DD/MM/AAAA, e tem de existir no calendário", () => {
    expect(dataInformada("1985-03-12")).toBe("1985-03-12");
    expect(dataInformada("12/03/1985")).toBe("1985-03-12");
    expect(dataInformada("1985-02-30")).toBeNull();
    expect(dataInformada("12/3/85")).toBeNull();
    expect(dataInformada("ontem")).toBeNull();
  });
});

describe("cadastrosQueConferem — CPF + nascimento, resposta única para toda recusa", () => {
  const MARIA = { id: "10", razao: "Maria da Silva", cnpj_cpf: "529.982.247-25", tipo_pessoa: "F", ativo: "S", data_nascimento: "1985-03-12", senha: "x" };
  const CRED = { baseUrl: "https://erp.exemplo.com.br", token: "1:x" };

  it("confere quando CPF e data batem, e a data NÃO sai no ClienteIxc", async () => {
    listar.mockImplementation(async (_c: unknown, p: { campos: readonly string[] }) => ({
      total: 1,
      registros: [Object.fromEntries(p.campos.map((c) => [c, (MARIA as Record<string, string>)[c] ?? ""]))],
    }));
    const achados = await cadastrosQueConferem(CRED, "529.982.247-25", "1985-03-12");
    expect(achados.map((c) => c.id)).toEqual(["10"]);
    expect(JSON.stringify(achados)).not.toContain("1985");
    // pediu a data, e só pela lista da conferência
    expect(listar.mock.calls.at(-1)?.[1].campos).toContain("data_nascimento");
  });

  it("data diferente e cadastro sem data dão a MESMA lista vazia", async () => {
    listar.mockResolvedValueOnce({ total: 1, registros: [{ ...MARIA, data_nascimento: "1990-01-01" }] });
    expect(await cadastrosQueConferem(CRED, "529.982.247-25", "1985-03-12")).toEqual([]);
    listar.mockResolvedValueOnce({ total: 1, registros: [{ ...MARIA, data_nascimento: "0000-00-00" }] });
    expect(await cadastrosQueConferem(CRED, "529.982.247-25", "1985-03-12")).toEqual([]);
    listar.mockResolvedValueOnce({ total: 0, registros: [] });
    expect(await cadastrosQueConferem(CRED, "529.982.247-25", "1985-03-12")).toEqual([]);
  });
});
```

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run lib/conectores/ixc/identificar.test.ts` → FAIL.

- [ ] **Step 3: implementar**

Em `lib/conectores/ixc/campos.ts`, depois de `CAMPOS_DO_CLIENTE`:

```ts
/**
 * `cliente` + a data de nascimento — SÓ para a conferência de identidade da IA
 * (CPF + nascimento, decisão do dono de 21/09). Lista separada de propósito: a
 * data não entra em `CAMPOS_DO_CLIENTE`, que alimenta o painel e o navegador.
 * Formato medido no IXC real em 22/09: sempre `AAAA-MM-DD`; vazio = `0000-00-00`.
 */
export const CAMPOS_DA_CONFERENCIA = [...CAMPOS_DO_CLIENTE, "data_nascimento"] as const;
```

e em `LISTAS_BRANCAS` acrescente a linha `"cliente (conferência)": CAMPOS_DA_CONFERENCIA,`.

Em `lib/conectores/ixc/identificar.ts`, troque o import de campos por `import { CAMPOS_DA_CONFERENCIA, CAMPOS_DO_CLIENTE } from "./campos";` e acrescente ao fim:

```ts
/**
 * `data_nascimento` como o IXC grava. Medido em 22/09 (3 amostras de 1000): sempre
 * `AAAA-MM-DD`, e "sem data" é `0000-00-00`. Ano antes de 1900 é lixo de cadastro
 * antigo (medido: ano 1) e vale como "sem data".
 */
export function nascimentoDoIxc(bruto: string | undefined): string | null {
  const v = (bruto ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return Number(v.slice(0, 4)) >= 1900 ? v : null;
}

/** A data que o cliente informou, em `AAAA-MM-DD` (aceita `DD/MM/AAAA`). `null` se não existir no calendário. */
export function dataInformada(bruto: string): string | null {
  const t = bruto.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : t;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number(iso.slice(0, 4)) < 1900) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Os cadastros deste CPF/CNPJ cuja data de nascimento é a informada.
 *
 * Lista vazia para TODA recusa — CPF inexistente, data diferente, cadastro sem
 * data —, de propósito: quem chama não consegue distinguir, e por isso não tem
 * como contar a ninguém qual dos dois dados não conferiu. A data é lida,
 * comparada e descartada: nunca entra em `ClienteIxc`.
 */
export async function cadastrosQueConferem(
  credencial: CredencialDeConector,
  documentoMascarado: string,
  nascimento: string,
): Promise<ClienteIxc[]> {
  const { registros } = await listarNoIxc(credencial, {
    tabela: "cliente",
    filtro: { campo: "cliente.cnpj_cpf", operador: "=", valor: documentoMascarado },
    campos: CAMPOS_DA_CONFERENCIA,
    limite: 20,
  });
  return registros
    .filter((r) => r.id && nascimentoDoIxc(r.data_nascimento) === nascimento)
    .map(lerCliente)
    .sort(ativosPrimeiro);
}
```

- [ ] **Step 4: ver passar** — `pnpm exec vitest run lib/conectores/ixc/identificar.test.ts tests/unit/conector-ixc-lista-branca.test.ts` → PASS.

- [ ] **Step 5: commit** — `git add lib/conectores/ixc/campos.ts lib/conectores/ixc/identificar.ts lib/conectores/ixc/identificar.test.ts && git commit -m "feat(ixc): conferência de CPF + data de nascimento, com resposta única para toda recusa" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 4: o painel só vincula sozinho onde o telefone é identidade

**Files:**
- Modify: `lib/conectores/ixc/painel.ts`, `app/api/v1/contacts/[id]/conectores/ixc/_contexto.ts`, `app/api/v1/contacts/[id]/conectores/ixc/route.ts`, `hooks/conectores/ixc/usePainelIxc.ts`, `components/conectores/ixc/PainelIxc.tsx`
- Test: `lib/conectores/ixc/painel.test.ts`

- [ ] **Step 1: teste que falha** — em `lib/conectores/ixc/painel.test.ts`, acrescente `telefoneEhIdentidade: true` ao objeto `BASE` (os casos existentes seguem valendo) e acrescente:

```ts
describe("telefone que NÃO é identidade (chat do site: número digitado)", () => {
  it("1 candidato pelo telefone NÃO vincula sozinho: cai em escolher", async () => {
    listarVinculos.mockResolvedValue([]);
    ixcFalso({ cliente: [MARIA] });
    const estado = await estadoDoPainelIxc({ ...BASE, identidadeDoTelefone: "nao" });
    expect(estado.estado).toBe("escolher");
    if (estado.estado !== "escolher") throw new Error("inalcançável");
    expect(estado.candidatos.map((c) => c.id)).toEqual(["10"]);
    expect(vincular).not.toHaveBeenCalled();
  });

  it("controle: com telefone de identidade, o mesmo candidato vincula (o caso de antes)", async () => {
    listarVinculos.mockResolvedValue([]);
    vincular.mockResolvedValue(true);
    ixcFalso({ cliente: [MARIA] });
    const estado = await estadoDoPainelIxc({ ...BASE, identidadeDoTelefone: "sim" });
    expect(vincular).toHaveBeenCalledWith(expect.objectContaining({ externalId: "10", verificadoPor: "telefone" }));
    expect(estado.estado).not.toBe("escolher");
  });
});
```

(Se o `beforeEach` do arquivo não zera `vincular`/`listarVinculos`, acrescente `vincular.mockReset(); listarVinculos.mockReset();` no início de cada caso novo.)

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run lib/conectores/ixc/painel.test.ts` → FAIL (o 1º caso vincula).

- [ ] **Step 3: implementar**

`lib/conectores/ixc/painel.ts` — no cabeçalho, substitua o parágrafo "Um ÚNICO candidato pelo telefone vincula sozinho…" por:

```ts
 * Um ÚNICO candidato pelo telefone vincula sozinho (`verificado_por = telefone`)
 * — mas SÓ onde o telefone é a identidade do canal (`telefoneEhIdentidade`, de
 * `lib/channels/capabilities.ts`). No WhatsApp o número da conversa é a prova; no
 * chat do site ele foi DIGITADO pelo visitante e não prova nada: lá o candidato
 * aparece em "escolher", e quem confirma é o atendente.
```

Em `PedidoDoPainel`, acrescente depois de `telefone`:

```ts
  /** O telefone é identidade no canal da conversa aberta? Sem conversa conhecida: `false`. */
  telefoneEhIdentidade: boolean;
```

e troque `const unico = candidatos.length === 1 ? candidatos[0] : undefined;` por:

```ts
    const unico = candidatos.length === 1 && p.telefoneEhIdentidade ? candidatos[0] : undefined;
```

`app/api/v1/contacts/[id]/conectores/ixc/_contexto.ts` — acrescente os imports `import { telefoneEhIdentidade } from "@/lib/channels/capabilities";` e, ao fim do arquivo:

```ts
/**
 * O telefone do contato é identidade no canal DESTA conversa? A conversa vem do
 * navegador, então tem de ser deste contato e desta organização; sem conversa
 * válida a resposta é `false` — fail-closed: o painel mostra o candidato para o
 * atendente escolher em vez de vincular sozinho.
 */
export async function telefoneEhIdentidadeNaConversa(
  ctx: Extract<ContextoIxc, { ok: true }>,
  conversationId: string | null,
): Promise<boolean> {
  if (!conversationId || !z.string().uuid().safeParse(conversationId).success) return false;
  const { data: conversa } = await ctx.admin
    .from("conversations")
    .select("channel_session_id")
    .eq("id", conversationId)
    .eq("contact_id", ctx.contato.id)
    .eq("organization_id", ctx.orgId)
    .maybeSingle();
  if (!conversa?.channel_session_id) return false;
  const { data: sessao } = await ctx.admin
    .from("channel_sessions")
    .select("provider")
    .eq("id", conversa.channel_session_id)
    .eq("organization_id", ctx.orgId)
    .maybeSingle();
  return telefoneEhIdentidade(sessao?.provider as string | undefined);
}
```

`app/api/v1/contacts/[id]/conectores/ixc/route.ts` — importe `telefoneEhIdentidadeNaConversa` de `./_contexto`, acrescente ao cabeçalho a linha ` * \`?conversa=<id>\` diz em que canal o painel está aberto — o telefone só vincula sozinho onde é identidade.` e passe ao `estadoDoPainelIxc`:

```ts
      telefoneEhIdentidade: await telefoneEhIdentidadeNaConversa(ctx, req.nextUrl.searchParams.get("conversa")),
```

`hooks/conectores/ixc/usePainelIxc.ts` — troque a função por:

```ts
export function usePainelIxc(contactId: string | null, cadastro: string | null, conversationId: string | null) {
  return useQuery({
    queryKey: [...chave(contactId, cadastro), conversationId] as const,
    enabled: !!contactId,
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (cadastro) qs.set("cadastro", cadastro);
      if (conversationId) qs.set("conversa", conversationId);
      const sufixo = qs.size > 0 ? `?${qs.toString()}` : "";
      return (
        await apiClient.get<{ data: EstadoDoPainelIxc }>(`/api/v1/contacts/${contactId}/conectores/ixc${sufixo}`, {
          timeoutMs: PRAZO_DO_ERP_MS,
        })
      ).data;
    },
    staleTime: 60_000,
    retry: false,
  });
}
```

(mantenha os dois comentários que estavam dentro da função original). A chave continua começando por `["conector", "ixc", contactId]`, então os `invalidateQueries` das mutações seguem alcançando-a.

`components/conectores/ixc/PainelIxc.tsx` — troque `const painel = usePainelIxc(contactId, cadastro);` por `const painel = usePainelIxc(contactId, cadastro, conversationId);`.

- [ ] **Step 4: ver passar** — `pnpm exec vitest run lib/conectores/ixc/painel.test.ts tests/unit/conector-ixc-rotas-nao-abrem-o-cliente-errado.test.ts` → PASS; `pnpm typecheck` → 0 erros.

- [ ] **Step 5: commit** — `git add lib/conectores/ixc/painel.ts lib/conectores/ixc/painel.test.ts "app/api/v1/contacts/[id]/conectores/ixc" hooks/conectores/ixc/usePainelIxc.ts components/conectores/ixc/PainelIxc.tsx && git commit -m "fix(ixc): o painel só vincula sozinho onde o telefone é identidade do canal" -m "No chat do site o telefone é digitado pelo visitante: um único candidato ia para o vínculo e abria a ficha (e a fatura) de outra pessoa. Agora cai em 'escolher'." -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 5: o contrato do agente, as descrições e `conectorDoAgente`

**Files:**
- Modify: `lib/conectores/tipos.ts`, `lib/conectores/ixc/enviar-cobranca.ts`, `lib/conectores/registro.ts`
- Create: `lib/conectores/ferramentas-do-agente.ts`

- [ ] **Step 1: tipos do contrato** — em `lib/conectores/tipos.ts`, acrescente no topo `import type { SupabaseClient } from "@supabase/supabase-js";` e, depois de `ResultadoDoTeste`:

```ts
// ─── O que o AGENTE DE IA faz com um conector ────────────────────────────────
//
// O motor conhece ESTES tipos e o registro — nunca a pasta de um conector. Os
// nomes falam de cliente, situação, fatura e forma, não de `fn_areceber`.
// Spec: docs/superpowers/specs/2026-09-22-ia-envia-cobranca-ixc-design.md.

/** Um arquivo que a cobrança leva: o PDF do boleto, o PNG do QR do Pix. */
export interface ArquivoDaCobranca {
  /** Sem extensão e sem caminho: `boleto-10-09-2026`. Quem guarda decide onde. */
  nome: string;
  extensao: "pdf" | "png";
  mime: "application/pdf" | "image/png";
  conteudo: Buffer;
}

export interface MensagemDaCobranca {
  type: "text" | "document" | "image";
  body: string;
  media_storage_path?: string;
  media_mime?: string;
  media_size_bytes?: number;
}

export interface PortasDoEnvio {
  /** Sobe o arquivo (storage-first) e devolve o caminho que `enviar` vai citar. */
  guardarArquivo(arquivo: ArquivoDaCobranca): Promise<string>;
  /** Envia UMA mensagem na conversa — a saída de sempre: fila, anti-banimento, opt-out. */
  enviar(mensagem: MensagemDaCobranca): Promise<void>;
}

export interface FaturaParaAgente {
  /** `AAAA-MM-DD`. */
  vencimento: string;
  valorCents: number;
  /** 0 quando ainda não venceu. */
  diasDeAtraso: number;
}

export interface FinanceiroParaAgente {
  vencidas: FaturaParaAgente[];
  proxima: FaturaParaAgente | null;
  totalVencidoCents: number;
  /** A ÚNICA fatura que se cobra agora (regra do dono, 22/09). */
  daVez: FaturaParaAgente | null;
}

/** O que a IA pode saber do cliente (decisão de 21/09). `null` = a seção não pôde ser lida. */
export interface ClienteParaAgente {
  primeiroNome: string;
  situacao: string | null;
  motivoDaSituacao: string | null;
  bloqueado: boolean | null;
  plano: string | null;
  /** `AAAA-MM-DD` do contrato em vigor mais antigo. */
  clienteDesde: string | null;
  conexao: "online" | "offline" | "sem_informacao" | null;
  temOsAberta: boolean | null;
}

export interface PedidoDeConsulta {
  admin: SupabaseClient;
  credencial: CredencialDeConector;
  orgId: string;
  contactId: string;
  telefone: string | null;
  /**
   * O telefone é identidade no canal desta conversa (`lib/channels/capabilities.ts`).
   * "desconhecido" (canal ilegível, provider que esta imagem não conhece) NÃO é "nao":
   * ele bloqueia vincular pelo telefone, mas não descarta vínculo que já existe.
   */
  identidadeDoTelefone: IdentidadeDoTelefone;
  cpfCnpj?: string;
  dataNascimento?: string;
  agora?: Date;
}

export type ResultadoDaConsulta =
  | {
      estado: "identificado";
      cliente: ClienteParaAgente;
      /** `null` quando o financeiro não pôde ser lido. */
      financeiro: FinanceiroParaAgente | null;
      /** Presente quando ESTA consulta criou o vínculo — vai para a auditoria. */
      vinculou: { verificadoPor: FormaDeVerificacao; cadastros: string[] } | null;
    }
  | { estado: "precisa_cpf" | "precisa_cpf_e_nascimento" | "cpf_invalido" | "data_invalida" | "nao_conferiu" };

export interface PedidoDeCobranca {
  admin: SupabaseClient;
  credencial: CredencialDeConector;
  orgId: string;
  contactId: string;
  identidadeDoTelefone: IdentidadeDoTelefone;
  forma: FormaDeCobranca;
  /** Fatura com MAIS dias de atraso que isto não é enviada: vai para a Cobrança. */
  limiteDeDias: number;
  portas: PortasDoEnvio;
  agora?: Date;
}

/** `faturaId` é para a AUDITORIA — o motor nunca o repassa ao modelo. */
export type ResultadoDaCobranca =
  | {
      resultado: "enviada";
      forma: FormaDeCobranca;
      fatura: FaturaParaAgente;
      faturaId: string;
      enviadas: number;
      previstas: number;
      pixGeradoAgora: boolean;
      /** O Pix falhou e saiu o BOLETO da mesma fatura no lugar. */
      pixIndisponivel: boolean;
    }
  | { resultado: "cliente_nao_identificado" | "sem_fatura_em_aberto" }
  | { resultado: "encaminhar_para_cobranca" | "boleto_indisponivel"; fatura: FaturaParaAgente; faturaId: string }
  | { resultado: "sem_como_cobrar"; fatura: FaturaParaAgente; faturaId: string; detalheDoErp?: string };

export interface CapacidadeDoAgente {
  consultar(p: PedidoDeConsulta): Promise<ResultadoDaConsulta>;
  enviarCobranca(p: PedidoDeCobranca): Promise<ResultadoDaCobranca>;
}
```

Em `DefinicaoDeConector`, depois de `testar`, acrescente:

```ts
  /**
   * O que o agente de IA faz com este conector (identificar, cobrar). Ausente =
   * o conector não tem cobrança, e as ferramentas dele não entram no turno.
   */
  agente?: CapacidadeDoAgente;
```

- [ ] **Step 2: `enviar-cobranca.ts` passa a usar os tipos do contrato** — em `lib/conectores/ixc/enviar-cobranca.ts`, apague as três interfaces locais `ArquivoDaCobranca`, `MensagemDaCobranca` e `PortasDoEnvio` e troque o import `import type { CredencialDeConector } from "../tipos";` por:

```ts
import type { ArquivoDaCobranca, CredencialDeConector, MensagemDaCobranca, PortasDoEnvio } from "../tipos";

// Os tipos das portas moram no contrato: o motor preenche as mesmas portas sem conhecer o IXC.
export type { ArquivoDaCobranca, MensagemDaCobranca, PortasDoEnvio };
```

- [ ] **Step 3: as duas ferramentas, fonte única** — crie `lib/conectores/ferramentas-do-agente.ts`:

```ts
/**
 * AS DUAS FERRAMENTAS QUE O AGENTE DE IA USA COM UM CONECTOR — os nomes e o texto
 * que o MODELO lê.
 *
 * Uma fonte para três lugares: o motor (ferramentas nativas,
 * `lib/agent-engine/agent/ferramentas-do-conector.ts`), o handler MCP que existe
 * pela paridade catálogo×handler (`lib/mcp/tools/sistema-de-gestao.ts`) e a rota
 * que serve o catálogo à tela (só as oferece a quem tem conector). O nome é
 * contrato de wire: renomear quebra `tool_ids` de agente publicado.
 */
export const FERRAMENTA_CONSULTAR_CLIENTE = "crm_consultar_cliente_erp";
export const FERRAMENTA_ENVIAR_COBRANCA = "crm_enviar_cobranca_erp";

export const FERRAMENTAS_DO_CONECTOR: readonly string[] = [FERRAMENTA_CONSULTAR_CLIENTE, FERRAMENTA_ENVIAR_COBRANCA];

export const DESCRICAO_CONSULTAR_CLIENTE =
  "Consulta o cliente DESTA conversa no sistema de gestão da empresa: situação do acesso, plano, " +
  "conexão, se há ordem de serviço aberta e as faturas em aberto. Chame SEM argumentos primeiro. " +
  "Se a resposta pedir CPF (ou CPF e data de nascimento), peça ao cliente e chame de novo com os " +
  "dados — a data vai como AAAA-MM-DD. Nunca diga ao cliente qual dado não conferiu. Use antes de " +
  "falar de pagamento, bloqueio ou fatura, e siga a `orientacao` da resposta.";

export const DESCRICAO_ENVIAR_COBRANCA =
  "Envia ao cliente DESTA conversa a cobrança da fatura da vez — a mais atrasada; sem atrasada, a " +
  "próxima a vencer; NUNCA duas. Sai em duas mensagens: o arquivo (QR code do Pix ou PDF do boleto) " +
  "e o código para copiar. Por padrão é Pix; use forma \"boleto\" só se o cliente pedir boleto. " +
  "Chame ANTES de escrever texto no turno (a cobrança ocupa 2 dos envios do turno) e depois escreva " +
  "no máximo uma frase curta, sem repetir código nem valor. Siga a `orientacao` da resposta.";
```

- [ ] **Step 4: `conectorDoAgente` no registro** — em `lib/conectores/registro.ts`:

```ts
import type { createAdminClient } from "@/lib/supabase/admin";

import { conectoresLigados } from "./conexao";
import { conectorIxc } from "./ixc";
import { ehConectorId, type CapacidadeDoAgente, type ConectorId, type DefinicaoDeConector } from "./tipos";
```

e ao fim:

```ts
/**
 * O conector desta organização que atende o AGENTE DE IA — o primeiro LIGADO que
 * declara `agente`. `null` = nenhum: as ferramentas do conector não entram no
 * turno e a tela não as oferece. É por aqui (e nunca por `./ixc`) que o motor
 * chega a um conector.
 */
export async function conectorDoAgente(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<{ id: ConectorId; agente: CapacidadeDoAgente } | null> {
  for (const id of await conectoresLigados(admin, orgId)) {
    const agente = CONECTORES[id].agente;
    if (agente) return { id, agente };
  }
  return null;
}
```

- [ ] **Step 5: verificar e commitar** — `pnpm typecheck` → 0 erros; `pnpm exec vitest run lib/conectores tests/unit/conectores-cerca.test.ts` → PASS.

```bash
git add lib/conectores/tipos.ts lib/conectores/ixc/enviar-cobranca.ts lib/conectores/ferramentas-do-agente.ts lib/conectores/registro.ts
git commit -m "feat(conectores): contrato CapacidadeDoAgente e conectorDoAgente — o motor chega ao conector pelo registro

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `agente.ts` do IXC — consultar

**Files:**
- Create: `lib/conectores/ixc/agente.ts`, `lib/conectores/ixc/agente.test.ts`
- Modify: `lib/conectores/ixc/index.ts`

- [ ] **Step 1: testes que falham** — crie `lib/conectores/ixc/agente.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const listar = vi.fn();
const baixarBoleto = vi.fn();
const buscarPix = vi.fn();
vi.mock("./http", () => ({
  listarNoIxc: (...a: unknown[]) => listar(...a),
  baixarBoletoDoIxc: (...a: unknown[]) => baixarBoleto(...a),
  buscarPixNoIxc: (...a: unknown[]) => buscarPix(...a),
}));
const listarVinculos = vi.fn();
const vincular = vi.fn();
vi.mock("../vinculos", () => ({
  listarVinculos: (...a: unknown[]) => listarVinculos(...a),
  vincular: (...a: unknown[]) => vincular(...a),
}));

import { agenteIxc } from "./agente";

const CRED = { baseUrl: "https://erp.exemplo.com.br", token: "1:x" };
const AGORA = new Date("2026-09-22T15:00:00Z"); // hoje em SP = 2026-09-22
const BASE = { admin: {} as never, credencial: CRED, orgId: "org-1", contactId: "contato-1", telefone: "+5561993040271", agora: AGORA };

type Linha = Record<string, string>;
const MARIA: Linha = { id: "10", razao: "Maria Aparecida Souza", cnpj_cpf: "529.982.247-25", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0271", data_nascimento: "1985-03-12", senha: "segredo" };
const JOSE: Linha = { id: "20", razao: "José Souza", cnpj_cpf: "111.444.777-35", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0271", data_nascimento: "1980-01-01", senha: "x" };
const CONTRATO: Linha = { id: "700", id_cliente: "10", contrato: "Fibra 500 Mega", status: "A", status_internet: "FA", data_ativacao: "2024-03-10", endereco: "Rua das Flores", numero: "120", bairro: "Centro" };
const fatura = (id: string, venc: string, extra: Linha = {}): Linha => ({ id, id_cliente: "10", id_contrato: "700", status: "A", data_vencimento: venc, valor: "129.90", valor_aberto: "129.90", linha_digitavel: "", pix_txid: "", ...extra });
const LOGIN: Linha = { id: "5", id_cliente: "10", id_contrato: "700", login: "maria", ativo: "S", online: "N", ip: "100.64.10.27", mac: "AA:BB:CC:DD:EE:FF" };

/** IXC de mentira: filtra pelo que o conector pediu e PROJETA nos campos pedidos, como `http.ts`. */
function ixc(tabelas: Record<string, Linha[]>) {
  listar.mockImplementation(async (_c: unknown, p: { tabela: string; filtro: { campo: string; valor: string; operador: string }; tambem?: Array<{ campo: string; valor: string; operador: string }>; campos: readonly string[] }) => {
    const casa = (l: Linha, f: { campo: string; valor: string; operador: string }) => {
      const v = l[f.campo.split(".").pop() ?? ""] ?? "";
      if (f.operador === "=") return v === f.valor;
      if (f.operador === "!=") return v !== f.valor;
      if (f.operador === "L") return v.includes(f.valor);
      return true;
    };
    const achadas = (tabelas[p.tabela] ?? []).filter((l) => [p.filtro, ...(p.tambem ?? [])].every((f) => casa(l, f)));
    return { total: achadas.length, registros: achadas.map((l) => Object.fromEntries(p.campos.map((c) => [c, l[c] ?? ""]))) };
  });
}

beforeEach(() => {
  for (const m of [listar, baixarBoleto, buscarPix, listarVinculos, vincular]) m.mockReset();
  vincular.mockResolvedValue(true);
  listarVinculos.mockResolvedValue([]);
});

describe("consultar — identidade antes de dinheiro (D1)", () => {
  it("vínculo existente identifica, e a projeção não leva id, CPF, endereço, IP, MAC nem senha", async () => {
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "documento", created_at: "" }]);
    ixc({ cliente: [MARIA], cliente_contrato: [CONTRATO], fn_areceber: [fatura("900", "2026-07-14"), fatura("950", "2026-10-12")], radusuarios: [LOGIN] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.cliente).toMatchObject({ primeiroNome: "Maria", situacao: "Bloqueado", motivoDaSituacao: "financeiro em atraso", bloqueado: true, plano: "Fibra 500 Mega", clienteDesde: "2024-03-10", conexao: "offline", temOsAberta: false });
    expect(r.financeiro?.daVez).toEqual({ vencimento: "2026-07-14", valorCents: 12990, diasDeAtraso: 70 });
    expect(r.financeiro?.proxima?.vencimento).toBe("2026-10-12");
    const json = JSON.stringify(r);
    for (const proibido of ["529.982", "Rua das Flores", "100.64", "AA:BB", "segredo", "\"900\"", "\"10\"", "\"700\""]) expect(json).not.toContain(proibido);
    expect(vincular).not.toHaveBeenCalled();
  });

  it("vínculo `telefone` num canal SEM telefone de identidade não conta", async () => {
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "telefone", created_at: "" }]);
    ixc({ cliente: [MARIA] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "nao" });
    expect(r.estado).toBe("precisa_cpf_e_nascimento");
  });

  it("WhatsApp com 1 cadastro no telefone: vincula como telefone", async () => {
    ixc({ cliente: [MARIA], cliente_contrato: [CONTRATO] });
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.vinculou).toEqual({ verificadoPor: "telefone", cadastros: ["10"] });
  });

  it("chat do site com o MESMO telefone: não vincula, pede CPF + nascimento", async () => {
    ixc({ cliente: [MARIA] });
    expect((await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "nao" })).estado).toBe("precisa_cpf_e_nascimento");
    expect(vincular).not.toHaveBeenCalled();
  });

  it("2 cadastros no telefone: pede CPF; o CPF de um deles escolhe e vincula como documento", async () => {
    ixc({ cliente: [MARIA, JOSE], cliente_contrato: [CONTRATO] });
    expect((await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim" })).estado).toBe("precisa_cpf");
    const r = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: "52998224725" });
    expect(r.estado).toBe("identificado");
    if (r.estado !== "identificado") throw new Error("inalcançável");
    expect(r.vinculou).toEqual({ verificadoPor: "documento", cadastros: ["10"] });
  });

  it("sem cadastro no telefone: CPF + nascimento que batem vinculam; qualquer recusa é nao_conferiu", async () => {
    ixc({ cliente: [{ ...MARIA, telefone_celular: "(61) 98888-0000" }], cliente_contrato: [CONTRATO] });
    const ok = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: "529.982.247-25", dataNascimento: "12/03/1985" });
    expect(ok.estado).toBe("identificado");
    const errada = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: "529.982.247-25", dataNascimento: "1985-03-13" });
    const inexistente = await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "sim", cpfCnpj: "390.533.447-05", dataNascimento: "1985-03-12" });
    expect(errada).toEqual({ estado: "nao_conferiu" });
    expect(inexistente).toEqual({ estado: "nao_conferiu" });
  });

  it("CPF com dígito errado e data impossível NÃO consultam o IXC (não gastam tentativa)", async () => {
    ixc({ cliente: [] });
    expect((await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "nao", cpfCnpj: "529.982.247-26", dataNascimento: "1985-03-12" })).estado).toBe("cpf_invalido");
    expect((await agenteIxc.consultar({ ...BASE, identidadeDoTelefone: "nao", cpfCnpj: "529.982.247-25", dataNascimento: "1985-02-30" })).estado).toBe("data_invalida");
    expect(listar).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run lib/conectores/ixc/agente.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: implementar** — crie `lib/conectores/ixc/agente.ts`:

```ts
/**
 * O IXC PARA O AGENTE DE IA — identificar o cliente da conversa e enviar a cobrança.
 *
 * É a implementação de `CapacidadeDoAgente` (lib/conectores/tipos.ts). O motor não
 * sabe que isto é IXC: pede ao registro o conector da organização que declara
 * `agente` e chama `consultar` / `enviarCobranca`. Spec:
 * docs/superpowers/specs/2026-09-22-ia-envia-cobranca-ixc-design.md.
 *
 * Três regras do dono moram aqui porque dependem do que o IXC é:
 *   1. identidade antes de dinheiro (§6): telefone que bate com UM cadastro — e
 *      só num canal em que o telefone É a identidade —; o CPF escolhe entre os
 *      cadastros do telefone; fora disso, CPF + data de nascimento;
 *   2. UMA fatura por vez (§7): a vencida mais antiga, senão a próxima;
 *   3. fatura acima do limite de dias não sai (§7): vai para a Cobrança.
 *
 * O que NÃO mora aqui: contar tentativas, auditar, falar com o modelo. Isso é do
 * motor, que é quem sabe de conversa, atendimento e agente.
 */
import type {
  CapacidadeDoAgente,
  ClienteParaAgente,
  CredencialDeConector,
  FaturaParaAgente,
  FinanceiroParaAgente,
  FormaDeVerificacao,
  PedidoDeCobranca,
  PedidoDeConsulta,
  ResultadoDaCobranca,
  ResultadoDaConsulta,
} from "../tipos";
import { listarVinculos, vincular } from "../vinculos";
import { CAMPOS_DA_FATURA } from "./campos";
import { enviarCobrancaIxc, type ResultadoDoEnvio } from "./enviar-cobranca";
import { faturaDaVez, hojeEmSaoPaulo, recortarFaturas, type Fatura, type RecorteDeFaturas } from "./faturas";
import { listarNoIxc } from "./http";
import { TETO_DE_CANDIDATOS, cadastrosQueConferem, clientesPorTelefone, dataInformada } from "./identificar";
import { documentoNaMascara, soDigitos } from "./mascara";
import { montarResumo, type ResumoIxc } from "./resumo";

type Pedido = Pick<PedidoDeConsulta, "admin" | "orgId" | "contactId" | "identidadeDoTelefone">;

/**
 * Os cadastros vinculados que VALEM para a IA. O vínculo `telefone` é descartado
 * onde o telefone SABIDAMENTE não é identidade (antes do conserto de 22/09 o
 * painel vinculava pelo número DIGITADO no chat do site). Canal "desconhecido"
 * NÃO descarta: "não sei" não é "não é" — esconder vínculo legítimo faria a IA
 * pedir CPF a quem já está identificado.
 */
async function cadastrosValidos(p: Pedido): Promise<string[]> {
  const vinculos = await listarVinculos(p.admin, p.orgId, p.contactId, "ixc");
  return vinculos
    .filter((v) => v.verificado_por !== "telefone" || p.identidadeDoTelefone !== "nao")
    .map((v) => v.external_id);
}

function paraAgente(f: Fatura): FaturaParaAgente {
  return { vencimento: f.vencimento, valorCents: f.valorCents, diasDeAtraso: f.diasDeAtraso };
}

/** As faturas ABERTAS de todos os cadastros: "a mais atrasada de todas" olha para todos. */
async function recorteDe(credencial: CredencialDeConector, cadastros: readonly string[], agora?: Date): Promise<RecorteDeFaturas> {
  const listas = await Promise.all(
    cadastros.map((id) =>
      listarNoIxc(credencial, {
        tabela: "fn_areceber",
        filtro: { campo: "fn_areceber.id_cliente", operador: "=", valor: id },
        tambem: [{ campo: "fn_areceber.status", operador: "=", valor: "A" }],
        campos: CAMPOS_DA_FATURA,
        limite: 50,
        ordenarPor: "fn_areceber.data_vencimento",
        ordem: "asc",
      }),
    ),
  );
  return recortarFaturas(listas.flatMap((l) => l.registros), hojeEmSaoPaulo(agora));
}

function financeiroDe(r: RecorteDeFaturas): FinanceiroParaAgente {
  const daVez = faturaDaVez([...r.vencidas, ...r.proximas]);
  const proxima = r.proximas[0];
  return {
    vencidas: r.vencidas.map(paraAgente),
    proxima: proxima ? paraAgente(proxima) : null,
    totalVencidoCents: r.totalVencidoCents,
    daVez: daVez ? paraAgente(daVez) : null,
  };
}

function clienteDe(resumo: ResumoIxc): ClienteParaAgente {
  const contratos = resumo.contratos.ok ? resumo.contratos.dados : null;
  const vigentes = contratos?.filter((c) => c.vigente) ?? [];
  const conexoes = resumo.conexoes.ok ? resumo.conexoes.dados : null;
  const os = resumo.ordensDeServico.ok ? resumo.ordensDeServico.dados : null;
  const nome = resumo.cliente.nome.trim();
  return {
    // Pessoa jurídica é tratada pelo nome inteiro: o "primeiro nome" de
    // "Mercado do Zé Ltda" seria "Mercado".
    primeiroNome: resumo.cliente.pessoaJuridica ? nome : (nome.split(/\s+/)[0] ?? ""),
    situacao: contratos ? resumo.situacao.rotulo : null,
    motivoDaSituacao: contratos ? (resumo.situacao.detalhe ?? null) : null,
    bloqueado: contratos ? vigentes.some((c) => c.bloqueado) : null,
    plano: vigentes.map((c) => c.plano).filter(Boolean).join(" + ") || null,
    clienteDesde:
      vigentes
        .map((c) => c.ativadoEm.slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()[0] ?? null,
    conexao:
      conexoes === null
        ? null
        : conexoes.some((c) => c.estado.tom === "bom")
          ? "online"
          : conexoes.some((c) => c.estado.tom === "ruim")
            ? "offline"
            : "sem_informacao",
    temOsAberta: os === null ? null : os.total > 0 || os.abertas.length > 0,
  };
}

/** `null` = o cadastro vinculado não existe mais no IXC. */
async function identificado(
  p: PedidoDeConsulta,
  cadastros: string[],
  vinculou: { verificadoPor: FormaDeVerificacao; cadastros: string[] } | null,
): Promise<ResultadoDaConsulta | null> {
  const [principal = ""] = cadastros;
  const [resumo, recorteDeTodos] = await Promise.all([
    montarResumo(p.credencial, principal, p.agora),
    cadastros.length > 1 ? recorteDe(p.credencial, cadastros, p.agora).catch(() => null) : Promise.resolve(undefined),
  ]);
  if (!resumo) return null;
  const recorte = recorteDeTodos === undefined ? (resumo.financeiro.ok ? resumo.financeiro.dados : null) : recorteDeTodos;
  return { estado: "identificado", cliente: clienteDe(resumo), financeiro: recorte ? financeiroDe(recorte) : null, vinculou };
}

async function vincularE(p: PedidoDeConsulta, cadastros: string[], verificadoPor: FormaDeVerificacao): Promise<ResultadoDaConsulta> {
  let criou = false;
  for (const externalId of cadastros) {
    // `vincular` devolve `{ vinculou, promovido }`: gravou agora OU promoveu a
    // linha que existia (o vínculo por telefone vira `documento` quando o CPF
    // confere). Os dois casos são "mudou o vínculo" e vão para a auditoria.
    const { vinculou } = await vincular({ admin: p.admin, orgId: p.orgId, contactId: p.contactId, conector: "ixc", externalId, verificadoPor, userId: null });
    criou = criou || vinculou;
  }
  return (await identificado(p, cadastros, criou ? { verificadoPor, cadastros } : null)) ?? { estado: "precisa_cpf_e_nascimento" };
}

async function consultar(p: PedidoDeConsulta): Promise<ResultadoDaConsulta> {
  const validos = await cadastrosValidos(p);
  if (validos.length > 0) {
    const r = await identificado(p, validos, null);
    if (r) return r;
    // O vínculo aponta para um cadastro que o IXC não devolve mais: identifica de novo.
  }

  // Conta antes de consulta: dígito verificador e calendário não revelam se o CPF é de alguém.
  const documento = p.cpfCnpj === undefined ? null : documentoNaMascara(p.cpfCnpj);
  if (p.cpfCnpj !== undefined && documento === null) return { estado: "cpf_invalido" };
  const nascimento = p.dataNascimento === undefined ? null : dataInformada(p.dataNascimento);
  if (p.dataNascimento !== undefined && nascimento === null) return { estado: "data_invalida" };

  // Procurar pelo telefone só onde ele prova quem é — fail-closed em "desconhecido".
  if (p.identidadeDoTelefone === "sim") {
    const candidatos = (await clientesPorTelefone(p.credencial, p.telefone)).slice(0, TETO_DE_CANDIDATOS);
    const [unico] = candidatos;
    if (candidatos.length === 1 && unico) return vincularE(p, [unico.id], "telefone");
    if (candidatos.length > 1) {
      if (!documento) return { estado: "precisa_cpf" };
      const doTitular = candidatos.filter((c) => soDigitos(c.documento) === soDigitos(documento));
      if (doTitular.length > 0) return vincularE(p, doTitular.map((c) => c.id), "documento");
      // O CPF não é de nenhum cadastro deste telefone: vale a regra de quem escreve de outro número.
    }
  }

  if (!documento || !nascimento) return { estado: "precisa_cpf_e_nascimento" };
  const conferidos = await cadastrosQueConferem(p.credencial, documento, nascimento);
  if (conferidos.length === 0) return { estado: "nao_conferiu" };
  return vincularE(p, conferidos.slice(0, TETO_DE_CANDIDATOS).map((c) => c.id), "documento");
}

// `enviarCobranca` entra na Task 7.
export const agenteIxc: CapacidadeDoAgente = {
  consultar,
  enviarCobranca: async () => ({ resultado: "cliente_nao_identificado" }),
};
```

Em `lib/conectores/ixc/index.ts`, importe `import { agenteIxc } from "./agente";` e acrescente `agente: agenteIxc,` ao objeto `conectorIxc` (depois de `ajudaDoToken`).

- [ ] **Step 4: ver passar** — `pnpm exec vitest run lib/conectores/ixc/agente.test.ts` → PASS. Se o caso "vínculo existente…" acusar o `"10"` proibido, confira que nenhum campo da projeção carrega id (o `JSON.stringify` do resultado inteiro é a régua).

- [ ] **Step 5: commit** — `git add lib/conectores/ixc/agente.ts lib/conectores/ixc/agente.test.ts lib/conectores/ixc/index.ts && git commit -m "feat(ixc): a IA identifica o cliente — telefone de identidade, CPF entre os do telefone, ou CPF + nascimento" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 7: `agente.ts` do IXC — enviar a cobrança

**Files:**
- Modify: `lib/conectores/ixc/agente.ts`, `lib/conectores/ixc/agente.test.ts`

- [ ] **Step 1: testes que falham** — acrescente a `lib/conectores/ixc/agente.test.ts`:

```ts
import type { ArquivoDaCobranca, MensagemDaCobranca } from "../tipos";

const PDF = Buffer.from("%PDF-1.4 boleto %%EOF", "latin1");
const BR_CODE =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";

function portas() {
  const enviadas: MensagemDaCobranca[] = [];
  return {
    enviadas,
    portas: {
      guardarArquivo: vi.fn(async (a: ArquivoDaCobranca) => `org-1/conv/cobranca-x/${a.nome}.${a.extensao}`),
      enviar: vi.fn(async (m: MensagemDaCobranca) => void enviadas.push(m)),
    },
  };
}
const COBRAR = { ...BASE, identidadeDoTelefone: "sim" as const, forma: "pix" as const, limiteDeDias: 60 };

describe("enviarCobranca — UMA fatura por vez (D2), limite (D5), Pix padrão (D3), sem como cobrar (D6)", () => {
  beforeEach(() => {
    listarVinculos.mockResolvedValue([{ external_id: "10", verificado_por: "telefone", created_at: "" }]);
    baixarBoleto.mockResolvedValue(PDF);
    buscarPix.mockResolvedValue({ ok: true, pix: { copiaECola: BR_CODE, status: "ATIVA", valorOriginal: "129.90" } });
  });

  it("envia a vencida mais antiga, por Pix, em duas mensagens — e nunca pede a outra fatura", async () => {
    ixc({ fn_areceber: [fatura("902", "2026-09-10", { linha_digitavel: "0019 x" }), fatura("901", "2026-08-20"), fatura("950", "2026-10-12")] });
    const { portas: p, enviadas } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, portas: p });
    expect(r).toMatchObject({ resultado: "enviada", forma: "pix", faturaId: "901", enviadas: 2, previstas: 2, pixIndisponivel: false });
    expect(enviadas.map((m) => m.type)).toEqual(["image", "text"]);
    expect(buscarPix.mock.calls.map((c) => c[1])).toEqual(["901"]);
  });

  it("acima do limite: NADA sai e o resultado é encaminhar_para_cobranca", async () => {
    ixc({ fn_areceber: [fatura("900", "2026-07-14"), fatura("950", "2026-10-12")] }); // 70 dias
    const { portas: p } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, portas: p });
    expect(r).toMatchObject({ resultado: "encaminhar_para_cobranca", faturaId: "900", fatura: { diasDeAtraso: 70 } });
    expect(p.enviar).not.toHaveBeenCalled();
    expect(buscarPix).not.toHaveBeenCalled();
  });

  it("controle do limite: 60 dias exatos ainda saem (a regra é MAIS de N)", async () => {
    ixc({ fn_areceber: [fatura("900", "2026-07-24")] }); // 60 dias
    const { portas: p } = portas();
    expect((await agenteIxc.enviarCobranca({ ...COBRAR, portas: p })).resultado).toBe("enviada");
  });

  it("boleto pedido sem registro: boleto_indisponivel, e o Pix NÃO é trocado sem perguntar", async () => {
    ixc({ fn_areceber: [fatura("901", "2026-08-20")] });
    const { portas: p } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, forma: "boleto", portas: p });
    expect(r.resultado).toBe("boleto_indisponivel");
    expect(buscarPix).not.toHaveBeenCalled();
  });

  it("Pix recusado e boleto registrado: sai o BOLETO da mesma fatura", async () => {
    ixc({ fn_areceber: [fatura("901", "2026-08-20", { linha_digitavel: "00190.00009 01234.567890 12345.678901 2 99990000012990" })] });
    buscarPix.mockResolvedValue({ ok: false, mensagemDoIxc: "carteira sem Pix" });
    const { portas: p, enviadas } = portas();
    const r = await agenteIxc.enviarCobranca({ ...COBRAR, portas: p });
    expect(r).toMatchObject({ resultado: "enviada", forma: "boleto", pixIndisponivel: true, faturaId: "901" });
    expect(enviadas[0]?.type).toBe("document");
  });

  it("Pix recusado e sem boleto: sem_como_cobrar com a frase do IXC", async () => {
    ixc({ fn_areceber: [fatura("901", "2026-08-20")] });
    buscarPix.mockResolvedValue({ ok: false, mensagemDoIxc: "carteira sem Pix" });
    const { portas: p } = portas();
    expect(await agenteIxc.enviarCobranca({ ...COBRAR, portas: p })).toMatchObject({ resultado: "sem_como_cobrar", detalheDoErp: "carteira sem Pix" });
  });

  it("sem fatura aberta e sem vínculo válido", async () => {
    ixc({ fn_areceber: [] });
    const { portas: p } = portas();
    expect((await agenteIxc.enviarCobranca({ ...COBRAR, portas: p })).resultado).toBe("sem_fatura_em_aberto");
    expect((await agenteIxc.enviarCobranca({ ...COBRAR, identidadeDoTelefone: "nao", portas: p })).resultado).toBe("cliente_nao_identificado");
  });

  it("a mais atrasada entre DOIS cadastros vinculados", async () => {
    listarVinculos.mockResolvedValue([
      { external_id: "10", verificado_por: "documento", created_at: "" },
      { external_id: "20", verificado_por: "documento", created_at: "" },
    ]);
    ixc({ fn_areceber: [fatura("901", "2026-08-20"), { ...fatura("801", "2026-08-01"), id_cliente: "20" }] });
    const { portas: p } = portas();
    expect(await agenteIxc.enviarCobranca({ ...COBRAR, portas: p })).toMatchObject({ resultado: "enviada", faturaId: "801" });
  });
});
```

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run lib/conectores/ixc/agente.test.ts` → os casos novos FAIL.

- [ ] **Step 3: implementar** — em `lib/conectores/ixc/agente.ts`, substitua o objeto `agenteIxc` (e o comentário "entra na Task 7") por:

```ts
const MOTIVOS_DE_PIX_QUE_O_BOLETO_SUPRE = new Set(["cobranca_indisponivel", "pix_inativo", "pix_corrompido"]);

function enviada(r: Extract<ResultadoDoEnvio, { ok: true }>, pixIndisponivel: boolean): ResultadoDaCobranca {
  return {
    resultado: "enviada",
    forma: r.forma,
    fatura: paraAgente(r.fatura),
    faturaId: r.fatura.id,
    enviadas: r.enviadas,
    previstas: r.previstas,
    pixGeradoAgora: r.pixGeradoAgora,
    pixIndisponivel,
  };
}

async function enviarCobranca(p: PedidoDeCobranca): Promise<ResultadoDaCobranca> {
  const cadastros = await cadastrosValidos(p);
  if (cadastros.length === 0) return { resultado: "cliente_nao_identificado" };

  const recorte = await recorteDe(p.credencial, cadastros, p.agora);
  // Valor ilegível vira 0 em `reaisParaCents`: cobrar R$ 0,00 é pior que não cobrar.
  const cobraveis = [...recorte.vencidas, ...recorte.proximas].filter((f) => f.valorCents > 0);
  const daVez = faturaDaVez(cobraveis);
  if (!daVez) return { resultado: "sem_fatura_em_aberto" };
  const base = { fatura: paraAgente(daVez), faturaId: daVez.id };
  // D5: acima do limite, a fatura é da Cobrança — nada sai.
  if (daVez.diasDeAtraso > p.limiteDeDias) return { resultado: "encaminhar_para_cobranca", ...base };

  const pedir = (forma: "pix" | "boleto") =>
    enviarCobrancaIxc({
      credencial: p.credencial,
      cadastrosVinculados: new Set(cadastros),
      faturaId: daVez.id,
      forma,
      portas: p.portas,
      ...(p.agora ? { agora: p.agora } : {}),
    });

  if (p.forma === "boleto") {
    const boleto = await pedir("boleto");
    if (boleto.ok) return enviada(boleto, false);
    // O cliente ESCOLHEU boleto: trocar pelo Pix sem perguntar desfaria a escolha dele.
    if (boleto.motivo === "forma_indisponivel") return { resultado: "boleto_indisponivel", ...base };
    return { resultado: "sem_como_cobrar", ...base, ...(boleto.detalheDoErp ? { detalheDoErp: boleto.detalheDoErp } : {}) };
  }

  const pix = await pedir("pix");
  if (pix.ok) return enviada(pix, false);
  // D3 + D6: o Pix falhou; se o boleto já está registrado, ele sai no lugar — só
  // as DUAS formas falhando é que mandam a conversa para a Cobrança.
  if (daVez.temBoleto && MOTIVOS_DE_PIX_QUE_O_BOLETO_SUPRE.has(pix.motivo)) {
    const boleto = await pedir("boleto");
    if (boleto.ok) return enviada(boleto, true);
  }
  return { resultado: "sem_como_cobrar", ...base, ...(pix.detalheDoErp ? { detalheDoErp: pix.detalheDoErp } : {}) };
}

export const agenteIxc: CapacidadeDoAgente = { consultar, enviarCobranca };
```

- [ ] **Step 4: ver passar** — `pnpm exec vitest run lib/conectores/ixc` → PASS (inclui `enviar-cobranca.test.ts`, que não mudou de comportamento).

- [ ] **Step 5: commit** — `git add lib/conectores/ixc/agente.ts lib/conectores/ixc/agente.test.ts && git commit -m "feat(ixc): a IA envia a cobrança da fatura da vez — Pix padrão, boleto a pedido, limite de dias" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 8: migration 0274 — o limite de dias

**Files:**
- Create: `supabase/migrations/20260922120000_0274_conector_cobranca_limite_de_dias.sql`, `tests/invariants/conector-limite-de-cobranca.test.ts`
- Modify: `supabase/baseline.sql` (apêndice ANTES do bloco `-- ---- VARREDURA anon`), `supabase/migrations/MANIFEST.md`, `lib/database.types.ts`, `lib/conectores/conexao.ts`

- [ ] **Step 1: confirmar o número** — `ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1` → `0273`. Se outro PR tiver entrado com 0274, use o seguinte e ajuste os nomes abaixo.

- [ ] **Step 2: invariante que falha** — crie `tests/invariants/conector-limite-de-cobranca.test.ts`:

```ts
/**
 * O LIMITE DE DIAS DA COBRANÇA PELA IA É COLUNA COM FAIXA — MEDIDO (migration 0274).
 *
 * A IA não envia fatura com mais de N dias de atraso: encaminha à Cobrança (regra
 * do dono, 22/09). N é configuração da TELA, e o CHECK é quem impede um N que
 * desligaria a regra em silêncio (0, negativo) ou a tornaria absurda.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "c0de0274-0000-4000-8000-00000000000a";

function tenta(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

describe("conector_conexoes.cobranca_encaminha_apos_dias", () => {
  it("existe, é integer not null e nasce 60", () => {
    const linha = sql(`
      select data_type || '|' || is_nullable || '|' || column_default
        from information_schema.columns
       where table_schema = 'public' and table_name = 'conector_conexoes'
         and column_name = 'cobranca_encaminha_apos_dias';`).trim();
    expect(linha).toBe("integer|NO|60");
  });

  it("o CHECK recusa 0 e 3651 e aceita 1, 60 e 3650", () => {
    sql(`insert into organizations (id, slug, legal_name, display_name)
         values ('${ORG}', 'limite-cobranca-0274', 'Limite 0274', 'Limite 0274') on conflict (id) do nothing;
         delete from conector_conexoes where organization_id = '${ORG}';
         insert into conector_conexoes (organization_id, conector, base_url, token_encrypted, token_iv, token_tag, token_last4)
         values ('${ORG}', 'ixc', 'https://erp.exemplo', '\\x00', '\\x00', '\\x00', 'abcd');`);
    for (const ok of [1, 60, 3650]) {
      expect(tenta(`update conector_conexoes set cobranca_encaminha_apos_dias = ${ok} where organization_id = '${ORG}';`)).toBeNull();
    }
    for (const ruim of [0, -5, 3651]) {
      expect(tenta(`update conector_conexoes set cobranca_encaminha_apos_dias = ${ruim} where organization_id = '${ORG}';`)).toContain("check constraint");
    }
    sql(`delete from organizations where id = '${ORG}';`);
  });
});
```

- [ ] **Step 3: a migration** — crie `supabase/migrations/20260922120000_0274_conector_cobranca_limite_de_dias.sql`:

```sql
-- 0274 · O limite de dias para a IA encaminhar a fatura à Cobrança.
--
-- Fase 4 do conector IXC: a IA identifica o cliente e envia a cobrança da fatura
-- da vez (spec docs/superpowers/specs/2026-09-22-ia-envia-cobranca-ixc-design.md).
-- Regra do dono do produto (22/09): fatura com MAIS de N dias de atraso não é
-- enviada — a IA diz que ela foi encaminhada ao setor de cobrança e transfere a
-- conversa. N é configuração da TELA (Configurações › Conectores), padrão 60.
--
-- Mora em `conector_conexoes` porque é política de cobrança DAQUELA conexão com o
-- sistema de gestão, e a tabela já é server-side only (0271): nenhum GRANT novo.
-- Coluna tipada, não jsonb: é um número com faixa, e o CHECK é quem a guarda.
--
-- Idempotente: `add column if not exists` com default (preenche as linhas que já
-- existem — não há dado a corrigir) e o CHECK criado só se faltar.

alter table public.conector_conexoes
  add column if not exists cobranca_encaminha_apos_dias integer not null default 60;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'conector_conexoes_cobranca_encaminha_apos_dias_check'
       and conrelid = 'public.conector_conexoes'::regclass
  ) then
    alter table public.conector_conexoes
      add constraint conector_conexoes_cobranca_encaminha_apos_dias_check
      check (cobranca_encaminha_apos_dias between 1 and 3650);
  end if;
end $$;

comment on column public.conector_conexoes.cobranca_encaminha_apos_dias is
  'Fatura com mais dias de atraso que isto a IA NÃO envia: encaminha à Cobrança (migration 0274).';

notify pgrst, 'reload schema';
```

- [ ] **Step 4: o apêndice do baseline** — em `supabase/baseline.sql`, imediatamente ANTES da linha `-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----`, cole:

```sql
-- ---- o limite de dias para a IA encaminhar a fatura à Cobrança (migration 0274) ----
-- Fatura com MAIS de N dias de atraso a IA não envia: encaminha à Cobrança e
-- transfere (regra do dono, 22/09). N é da tela, padrão 60. Racional completo no
-- cabeçalho da migration 0274.
alter table public.conector_conexoes
  add column if not exists cobranca_encaminha_apos_dias integer not null default 60;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'conector_conexoes_cobranca_encaminha_apos_dias_check'
       and conrelid = 'public.conector_conexoes'::regclass
  ) then
    alter table public.conector_conexoes
      add constraint conector_conexoes_cobranca_encaminha_apos_dias_check
      check (cobranca_encaminha_apos_dias between 1 and 3650);
  end if;
end $$;

comment on column public.conector_conexoes.cobranca_encaminha_apos_dias is
  'Fatura com mais dias de atraso que isto a IA NÃO envia: encaminha à Cobrança (migration 0274).';

notify pgrst, 'reload schema';

```

- [ ] **Step 5: MANIFEST** — acrescente ao fim da tabela "Applied" de `supabase/migrations/MANIFEST.md`:

```markdown
| `20260922120000` | `0274_conector_cobranca_limite_de_dias` | **O limite de dias para a IA encaminhar a fatura à Cobrança.** Fase 4 do conector IXC: a IA identifica o cliente e envia a cobrança da fatura da vez (spec `2026-09-22-ia-envia-cobranca-ixc-design.md`). Regra do dono (22/09): fatura com MAIS de N dias de atraso não é enviada — a IA diz que ela foi encaminhada ao setor de cobrança e transfere. `conector_conexoes.cobranca_encaminha_apos_dias integer not null default 60` + CHECK `between 1 and 3650` criado só se faltar; configurado em Configurações › Conectores. Mora na conexão porque é política de cobrança daquela ligação com o sistema de gestão, e a tabela já é server-side only (0271) — nenhum GRANT novo. Sem dado a corrigir: o default preenche as linhas existentes. Gate: `tests/invariants/conector-limite-de-cobranca.test.ts`. |
```

- [ ] **Step 6: tipos gerados** — em `lib/database.types.ts`, no bloco `conector_conexoes`, acrescente em ordem alfabética: em `Row` `cobranca_encaminha_apos_dias: number`; em `Insert` e `Update` `cobranca_encaminha_apos_dias?: number`.

- [ ] **Step 7: `conexao.ts` lê e grava o limite** — em `lib/conectores/conexao.ts`:
  - troque `COLUNAS_PUBLICAS` por `"conector, base_url, token_last4, status, status_detalhe, verificada_em, updated_at, cobranca_encaminha_apos_dias"`;
  - acrescente a `ConexaoPublica` o campo `cobranca_encaminha_apos_dias: number;`;
  - acrescente ao fim:

```ts
/** A regra do dono (22/09): sem configuração, fatura com MAIS de 60 dias de atraso vai para a Cobrança. */
export const LIMITE_PADRAO_DA_COBRANCA = 60;

/**
 * O limite de dias desta conexão. Cai no padrão quando a coluna ainda não existe
 * (clone no meio do `update.sh`, antes do baseline) ou não há conexão: a IA
 * continua com a regra do dono em vez de cair o turno.
 */
export async function lerLimiteDeCobranca(admin: Admin, orgId: string, conector: ConectorId): Promise<number> {
  const { data, error } = await admin
    .from("conector_conexoes")
    .select("cobranca_encaminha_apos_dias")
    .eq("organization_id", orgId)
    .eq("conector", conector)
    .maybeSingle();
  const n = Number((data as { cobranca_encaminha_apos_dias?: unknown } | null)?.cobranca_encaminha_apos_dias);
  return !error && Number.isInteger(n) && n >= 1 ? n : LIMITE_PADRAO_DA_COBRANCA;
}

/** Grava o limite. `false` = não havia conexão para gravar. O CHECK do banco guarda a faixa. */
export async function salvarLimiteDeCobranca(admin: Admin, orgId: string, conector: ConectorId, dias: number): Promise<boolean> {
  const { data, error } = await admin
    .from("conector_conexoes")
    .update({ cobranca_encaminha_apos_dias: dias, updated_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("conector", conector)
    .select("id");
  if (error) throw new Error(`conector_conexoes: ${error.message}`);
  return (data ?? []).length > 0;
}
```

- [ ] **Step 8: provar o baseline** — `pnpm test:db > /tmp/db.log 2>&1; echo "exit=$?"`; esperado `exit=0` e, no log, o arquivo novo PASS (`grep -a "conector-limite-de-cobranca" /tmp/db.log`). O `test:db` aplica o baseline em install (ON_ERROR_STOP) E em update. Sabotagem: apague temporariamente o bloco `do $$ … $$` do apêndice, rode só `pnpm test:db` de novo e confirme o caso do CHECK VERMELHO; restaure.

- [ ] **Step 9: commit**

```bash
git add supabase/migrations/20260922120000_0274_conector_cobranca_limite_de_dias.sql supabase/baseline.sql supabase/migrations/MANIFEST.md lib/database.types.ts lib/conectores/conexao.ts tests/invariants/conector-limite-de-cobranca.test.ts
git commit -m "feat(conectores): migration 0274 — o limite de dias para a IA encaminhar a fatura à Cobrança

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: o limite na tela de Configurações › Conectores

**Files:**
- Modify: `app/api/v1/conectores/route.ts`, `app/api/v1/conectores/[conector]/conexao/route.ts`, `app/app/settings/conectores/_components/ConectoresClient.tsx`, `lib/audit/actions.ts`, `lib/i18n/dicionario.ts`
- Test: `tests/unit/conector-limite-de-cobranca-rota.test.ts`

- [ ] **Step 1: ações de auditoria** — em `lib/audit/actions.ts`, depois de `"conector.fatura_enviada",`:

```ts
  // Fase 4 (a IA cobra): o limite de dias que manda a fatura para a Cobrança é
  // política da empresa — quem mudou e de quanto para quanto. A recusa de
  // identidade é o CONTADOR das 3 tentativas por atendimento (sem CPF nem data no
  // metadata). E o encaminhamento é o registro de que a IA NÃO mandou, e por quê.
  "conector.preferencias_alteradas",
  "conector.identificacao_recusada",
  "conector.cobranca_encaminhada",
```

- [ ] **Step 2: teste da rota que falha** — crie `tests/unit/conector-limite-de-cobranca-rota.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireRole = vi.fn();
vi.mock("@/lib/auth/require-role", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const salvarLimite = vi.fn();
const lerPublica = vi.fn();
vi.mock("@/lib/conectores/conexao", () => ({
  salvarLimiteDeCobranca: (...a: unknown[]) => salvarLimite(...a),
  lerConexaoPublica: (...a: unknown[]) => lerPublica(...a),
  lerCredencial: vi.fn(),
  removerConexao: vi.fn(),
  salvarConexao: vi.fn(),
}));
const audit = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));

import { PATCH } from "@/app/api/v1/conectores/[conector]/conexao/route";

const pedido = (corpo: unknown) =>
  new Request("http://x/api/v1/conectores/ixc/conexao", { method: "PATCH", body: JSON.stringify(corpo) }) as never;
const params = { params: Promise.resolve({ conector: "ixc" }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org-1", role: "admin" } });
  lerPublica.mockResolvedValue({ conector: "ixc", cobranca_encaminha_apos_dias: 45 });
  salvarLimite.mockResolvedValue(true);
});

describe("PATCH /api/v1/conectores/[conector]/conexao — o limite de dias", () => {
  it("é de admin", async () => {
    await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
  });

  it("grava, audita de quanto para quanto, e não pede o token", async () => {
    lerPublica.mockResolvedValueOnce({ conector: "ixc", cobranca_encaminha_apos_dias: 60 });
    const r = await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params);
    expect(r.status).toBe(200);
    expect(salvarLimite).toHaveBeenCalledWith(expect.anything(), "org-1", "ixc", 45);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conector.preferencias_alteradas", metadata: expect.objectContaining({ de: 60, para: 45 }) }));
  });

  it("recusa fora de 1..3650, fração e campo desconhecido", async () => {
    for (const corpo of [{ cobranca_encaminha_apos_dias: 0 }, { cobranca_encaminha_apos_dias: 3651 }, { cobranca_encaminha_apos_dias: 1.5 }, { cobranca_encaminha_apos_dias: 30, organization_id: "x" }]) {
      expect((await PATCH(pedido(corpo), params)).status).toBe(422);
    }
    expect(salvarLimite).not.toHaveBeenCalled();
  });

  it("conector desligado: 404", async () => {
    salvarLimite.mockResolvedValue(false);
    expect((await PATCH(pedido({ cobranca_encaminha_apos_dias: 45 }), params)).status).toBe(404);
  });
});
```

- [ ] **Step 3: ver falhar** — `pnpm exec vitest run tests/unit/conector-limite-de-cobranca-rota.test.ts` → FAIL (`PATCH` não exportado).

- [ ] **Step 4: a rota** — em `app/api/v1/conectores/[conector]/conexao/route.ts`:
  - no cabeçalho, acrescente a linha ` * PATCH  /api/v1/conectores/[conector]/conexao — ajusta o limite de dias da cobrança pela IA (admin).`;
  - acrescente `salvarLimiteDeCobranca` ao import de `@/lib/conectores/conexao`;
  - acrescente ao fim:

```ts
const preferenciasSchema = z
  .object({ cobranca_encaminha_apos_dias: z.number().int().min(1).max(3650) })
  .strict();

/**
 * O limite de dias da cobrança pela IA: fatura com MAIS dias de atraso que isto a
 * IA não envia — encaminha à Cobrança (regra do dono, 22/09). Não passa pelo teste
 * do token: é política da empresa, não credencial. `.strict()` recusa campo
 * estranho (inclusive `organization_id`) em vez de ignorar.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ conector: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "conectores" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const conector = obterConector((await ctx.params).conector);
  if (!conector) return fail("conector_desconhecido", t("Conector desconhecido."), 404, { requestId });

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = preferenciasSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", t("Informe um número inteiro de dias, entre 1 e 3650."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  try {
    const antes = await lerConexaoPublica(admin, orgId, conector.id);
    const gravou = await salvarLimiteDeCobranca(admin, orgId, conector.id, parsed.data.cobranca_encaminha_apos_dias);
    if (!gravou) return fail("conector_desligado", t("Este conector está desligado."), 404, { requestId });

    void audit({
      action: "conector.preferencias_alteradas",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "conector_conexao",
      resourceId: null,
      metadata: {
        conector: conector.id,
        campo: "cobranca_encaminha_apos_dias",
        de: antes?.cobranca_encaminha_apos_dias ?? null,
        para: parsed.data.cobranca_encaminha_apos_dias,
      },
      requestId,
    });
    return ok(await lerConexaoPublica(admin, orgId, conector.id), { requestId });
  } catch {
    return fail("internal_error", "Erro ao salvar a preferência.", 500, { requestId });
  }
}
```

- [ ] **Step 5: o GET diz quem cobra pela IA** — em `app/api/v1/conectores/route.ts`, no objeto de cada conector, acrescente `cobra_pela_ia: Boolean(c.agente),` depois de `ajuda_do_token`.

- [ ] **Step 6: a tela** — em `ConectoresClient.tsx`:
  - em `ConectorDaTela`, acrescente `cobra_pela_ia: boolean;`;
  - antes de `function Ficha`, acrescente o componente:

```tsx
/**
 * O limite de dias da cobrança pela IA (migration 0274). Mora na ficha do
 * conector porque é política DAQUELA ligação com o sistema de gestão.
 */
function LimiteDaCobranca({ conector, dias }: { conector: string; dias: number }) {
  const t = useT();
  const qc = useQueryClient();
  const [valor, setValor] = useState(String(dias));
  const salvar = useMutation({
    mutationFn: () =>
      apiClient.patch(`/api/v1/conectores/${conector}/conexao`, { cobranca_encaminha_apos_dias: Number(valor) }),
    onSuccess: () => {
      toast.success(t("Limite salvo."));
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: (err) => toast.error(mensagemDoErro(err, t("Não consegui salvar o limite."))),
  });
  return (
    <form
      className="mt-4 space-y-1.5 border-t border-border pt-4"
      data-testid={`limite-cobranca-${conector}`}
      onSubmit={(e) => {
        e.preventDefault();
        salvar.mutate();
      }}
    >
      <Label htmlFor={`limite-${conector}`}>{t("Cobrança pela IA")}</Label>
      <div className="flex flex-wrap items-center gap-2 text-sm text-text">
        <span>{t("Faturas com mais de")}</span>
        <Input
          id={`limite-${conector}`}
          type="number"
          inputMode="numeric"
          min={1}
          max={3650}
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          className="w-24"
          aria-label={t("Dias de atraso")}
        />
        <span>{t("dias de atraso vão para a Cobrança.")}</span>
        <Button type="submit" variant="outline" disabled={salvar.isPending || valor === String(dias)}>
          {t("Salvar")}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        {t("A IA não envia a cobrança dessas faturas: avisa o cliente que ela foi encaminhada ao setor de cobrança e transfere a conversa.")}
      </p>
    </form>
  );
}
```

  - dentro de `Ficha`, logo depois do bloco `{conexao && !editando && ( <dl …> … </dl> )}`, acrescente:

```tsx
      {conexao && !editando && conector.cobra_pela_ia && (
        <LimiteDaCobranca conector={conector.id} dias={conexao.cobranca_encaminha_apos_dias} />
      )}
```

- [ ] **Step 7: dicionário** — em `lib/i18n/dicionario.ts`, perto de `"Testar conexão"`, acrescente:

```ts
  "Cobrança pela IA": { es: "Cobro por la IA" },
  "Faturas com mais de": { es: "Facturas con más de" },
  "Dias de atraso": { es: "Días de atraso" },
  "dias de atraso vão para a Cobrança.": { es: "días de atraso van a Cobranzas." },
  "A IA não envia a cobrança dessas faturas: avisa o cliente que ela foi encaminhada ao setor de cobrança e transfere a conversa.": { es: "La IA no envía el cobro de esas facturas: avisa al cliente que fue derivada al sector de cobranzas y transfiere la conversación." },
  "Limite salvo.": { es: "Límite guardado." },
  "Não consegui salvar o limite.": { es: "No pude guardar el límite." },
  "Informe um número inteiro de dias, entre 1 e 3650.": { es: "Informe un número entero de días, entre 1 y 3650." },
  "Este conector está desligado.": { es: "Este conector está desactivado." },
```

(Antes de acrescentar, `grep -n '"Salvar"' lib/i18n/dicionario.ts` — se já existir, não duplique.)

- [ ] **Step 8: ver passar** — `pnpm exec vitest run tests/unit/conector-limite-de-cobranca-rota.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts` → PASS; `pnpm typecheck`; `pnpm lint:role-rank`.

- [ ] **Step 9: commit** — `git add app/api/v1/conectores lib/audit/actions.ts app/app/settings/conectores lib/i18n/dicionario.ts tests/unit/conector-limite-de-cobranca-rota.test.ts && git commit -m "feat(conectores): o limite de dias da cobrança pela IA em Configurações › Conectores" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 10: a saída do motor ganha mídia

**Files:**
- Modify: `lib/agent-engine/channel-adapter.ts`, `lib/agent-engine/edge/crm/send-message.ts`
- Test: `tests/unit/saida-do-motor-com-midia.test.ts`

- [ ] **Step 1: teste que falha** — crie `tests/unit/saida-do-motor-com-midia.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const handler = vi.fn();
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: (...a: unknown[]) => handler(...a) }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({ requireCurrentServiceBoundary: async () => undefined }));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  pgSendLedger: () => ({}),
  sendWithLedger: async (_s: unknown, _i: unknown, enviar: (k: string, m: string) => Promise<{ id: string }>) => {
    const m = await enviar("key-1", "msg-1");
    return { kind: "sent", idempotencyKey: "key-1", messageId: m.id };
  },
}));

import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";

const db = { query: vi.fn(async () => ({ rows: [{ kind: "inbound_turn", payload: {} }] })) };
const base = {
  tenantId: "org-1",
  leadId: "lead-1",
  jobId: "job-1",
  seq: 1,
  conversationId: "conv-1",
  body: "Segue o Pix da sua fatura.",
};

beforeEach(() => {
  handler.mockReset();
  handler.mockResolvedValue({ id: "m-1" });
});

describe("a saída do motor leva ARQUIVO", () => {
  it("media vira type document/image + os campos de storage do handler", async () => {
    await sendTurnMessage(db as never, { supabase: {} as never }, {
      ...base,
      media: { kind: "image", storagePath: "org-1/conv-1/cobranca-ab12cd34/pix-10-09-2026.png", mime: "image/png", sizeBytes: 1234 },
    });
    expect(handler.mock.calls[0]?.[2]).toMatchObject({
      conversation_id: "conv-1",
      type: "image",
      body: "Segue o Pix da sua fatura.",
      media_storage_path: "org-1/conv-1/cobranca-ab12cd34/pix-10-09-2026.png",
      media_mime: "image/png",
      media_size_bytes: 1234,
    });
  });

  it("controle: sem media continua texto", async () => {
    await sendTurnMessage(db as never, { supabase: {} as never }, base);
    expect(handler.mock.calls[0]?.[2]).toMatchObject({ type: "text", body: base.body });
    expect(handler.mock.calls[0]?.[2]).not.toHaveProperty("media_storage_path");
  });
});
```

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run tests/unit/saida-do-motor-com-midia.test.ts` → FAIL (tipo `image` não chega; `media` ignorada). Se o mock do módulo do ledger não casar com o caminho do import de `send-message.ts` (`./send-ledger`), troque o `vi.mock` para o caminho absoluto resolvido `@/lib/agent-engine/edge/crm/send-ledger` — que é o mesmo módulo.

- [ ] **Step 3: implementar**

`lib/agent-engine/channel-adapter.ts` — em `ChannelSendInput`, depois de `template`:

```ts
  /**
   * Presente = a mensagem leva um ARQUIVO, já guardado no Storage (storage-first);
   * `body` é a legenda. Opcional pelo mesmo motivo do `template`: adapter que não
   * conhece o campo envia só a legenda — degrada, não estoura. Hoje quem usa é a
   * cobrança do conector (lib/agent-engine/agent/ferramentas-do-conector.ts).
   */
  media?: { kind: 'document' | 'image'; storagePath: string; mime: string; sizeBytes: number };
```

(e troque o doc da interface `/** Uma mensagem de texto a enviar ao lead. …` por `/** Uma mensagem a enviar ao lead — texto, template ou arquivo com legenda. Identidade da intenção = (jobId, seq). */`).

`lib/agent-engine/edge/crm/send-message.ts` — em `SendMessageInput`, depois de `template`:

```ts
  /** Arquivo com legenda (`body`), já no Storage — ver `ChannelSendInput.media`. */
  media?: { kind: 'document' | 'image'; storagePath: string; mime: string; sizeBytes: number };
```

e, na chamada ao `sendMessageHandler`, troque o bloco do tipo por:

```ts
          ...(input.template
            ? {
                type: 'template' as const,
                template_name: input.template.name,
                template_language: input.template.language,
                template_values: input.template.values,
              }
            : input.media
              ? {
                  type: input.media.kind,
                  media_storage_path: input.media.storagePath,
                  media_mime: input.media.mime,
                  media_size_bytes: input.media.sizeBytes,
                }
              : { type: 'text' as const }),
```

- [ ] **Step 4: ver passar** — mesmo comando → PASS; `pnpm typecheck` → 0 erros; `pnpm lint:channels` → verde (nenhum provider nomeado).

- [ ] **Step 5: commit** — `git add lib/agent-engine/channel-adapter.ts lib/agent-engine/edge/crm/send-message.ts tests/unit/saida-do-motor-com-midia.test.ts && git commit -m "feat(motor): a saída do turno leva arquivo com legenda (media no ChannelSendInput)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 11: `conteudoDoSistema` na cadeia before-send

**Files:**
- Modify: `lib/agent-engine/guardrails/before-send.ts`
- Test: `tests/unit/before-send-conteudo-do-sistema.test.ts`

- [ ] **Step 1: teste que falha** — crie `tests/unit/before-send-conteudo-do-sistema.test.ts`:

```ts
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { evaluateBeforeSend, runBeforeSend, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { hashNormalized, normalizeCopy } from "@/lib/agent-engine/spinning/engine";

/**
 * A cobrança é texto do SISTEMA, conferido no ERP — não do modelo. A legenda
 * "Valor: R$ 129,90" cairia no piso de preço da tabela de promessas, e a mesma
 * legenda para o 3º cliente do número cairia no anti-repetição (a janela cruza
 * clientes). `conteudoDoSistema` desarma SÓ esses dois, com `skipped` no trace;
 * opt-out, LGPD, ritmo, janela e aviso de IA continuam valendo.
 */
const COMERCIAL = new Date("2026-07-28T13:00:00Z");
const LEGENDA = "Segue o Pix da sua fatura.\n\nVencimento: 14/07/2026\nValor: R$ 129,90";
const copia = { normalizedText: normalizeCopy(LEGENDA), normalizedHash: hashNormalized(normalizeCopy(LEGENDA)) };

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: COMERCIAL,
    body: LEGENDA,
    optedOut: false,
    provider: "meta_cloud",
    messagingWindow: { lastInboundAt: new Date(COMERCIAL.getTime() - 60_000) },
    pacing: { knobs: PACING_DEFAULTS, state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null }, crmDailyLimit: null, rng: () => 0 },
    spinning: { knobs: SPINNING_DEFAULTS, window: [copia, copia, copia] },
    promise: { table: { minPriceCents: 20_000 } },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  } as GateContext;
}

describe("conteudoDoSistema", () => {
  it("controle: SEM a opção, a legenda da cobrança é vetada (repetição ou piso de preço)", () => {
    expect(evaluateBeforeSend(ctx()).veto).not.toBeNull();
  });

  it("COM a opção, spinning e promise saem skipped com o motivo, e nada veta", () => {
    const r = evaluateBeforeSend(ctx({ conteudoDoSistema: true }));
    expect(r.veto).toBeNull();
    expect(r.trace).toContainEqual({ gate: "spinning", verdict: "skipped", code: "conteudo_do_sistema" });
    expect(r.trace).toContainEqual({ gate: "promise", verdict: "skipped", code: "conteudo_do_sistema" });
  });

  it("opt-out continua vetando conteúdo do sistema", () => {
    const r = evaluateBeforeSend(ctx({ conteudoDoSistema: true, optedOut: true }));
    expect(r.veto?.code).toBe("contato_bloqueado");
  });

  it("no runner: a legenda do sistema NÃO entra na janela de cópias que julga os outros", async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rows: [{ id: "t" }] }) } as unknown as pg.Pool;
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const r = await runBeforeSend({
      pool, log,
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body: LEGENDA, conteudoDoSistema: true, optedOutThisTurn: false, crmDailyLimit: null,
      now: COMERCIAL, rng: () => 0, sleep: async () => {}, gates: [],
      send: async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }),
    });
    expect(r.status).toBe("sent");
    const sqls = client.query.mock.calls.map(([s]) => String(s));
    expect(sqls.some((s) => s.includes("insert into outbound_copies"))).toBe(false);
  });
});
```

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run tests/unit/before-send-conteudo-do-sistema.test.ts` → FAIL (o 2º caso veta; `conteudoDoSistema` não existe no tipo).

- [ ] **Step 3: implementar** em `lib/agent-engine/guardrails/before-send.ts`:

  1. Em `GateContext`, depois de `spinningEnforced?: boolean;`:

```ts
  /**
   * O corpo é CONTEÚDO DO SISTEMA — composto pelo código a partir de dado
   * conferido (hoje: a cobrança do conector, com o valor e o código relidos no
   * ERP) — e não texto do modelo. Desarma SÓ os gates que julgam a cópia do
   * modelo: `spinning` (a mesma legenda para o 3º cliente do número seria vetada,
   * a janela cruza clientes — a mesma conta do aviso de escalação) e `promise`
   * (o valor da fatura cairia no piso de preço). Os dois saem `skipped` com
   * `conteudo_do_sistema` no trace. Opt-out, LGPD, ritmo, janela e aviso de IA
   * continuam valendo integralmente. Ausente = conteúdo do modelo (tudo armado).
   */
  conteudoDoSistema?: boolean;
```

  2. Em `GateVerdict`, troque `skipped?: 'not_applicable'` por `skipped?: 'not_applicable' | 'conteudo_do_sistema'`.

  3. Em `promiseGate.evaluate`, primeira linha: `if (ctx.conteudoDoSistema === true) return { pass: true, skipped: 'conteudo_do_sistema' };`

  4. Em `spinningGate.evaluate`, antes da linha do `spinningEnforced`: `if (ctx.conteudoDoSistema === true) return { pass: true, skipped: 'conteudo_do_sistema' };`

  5. Em `RunBeforeSendArgs`, depois de `enforceSpinning?: boolean;`:

```ts
  /** Ver `GateContext.conteudoDoSistema`. Também não chama o classificador semântico nem grava a cópia. */
  conteudoDoSistema?: boolean;
```

  6. Em `runBeforeSend`: troque a linha do `semanticPromise` por

```ts
    const semanticPromise =
      args.classifyPromiseSemantic && args.conteudoDoSistema !== true
        ? await args.classifyPromiseSemantic(args.body)
        : null;
```

  acrescente ao objeto `ctx` a linha `...(args.conteudoDoSistema === true ? { conteudoDoSistema: true } : {}),` (junto do `spinningEnforced`), e troque `if (args.enforceSpinning !== false) {` (antes do `recordCopy`) por `if (args.enforceSpinning !== false && args.conteudoDoSistema !== true) {`.

- [ ] **Step 4: ver passar** — `pnpm exec vitest run tests/unit/before-send-conteudo-do-sistema.test.ts tests/unit/before-send-chain-shape.test.ts tests/unit/gate-pacing-capability.test.ts` → PASS (a composição da cadeia não mudou: sem bump de versão).

- [ ] **Step 5: commit** — `git add lib/agent-engine/guardrails/before-send.ts tests/unit/before-send-conteudo-do-sistema.test.ts && git commit -m "feat(motor): conteudoDoSistema — a cobrança não é julgada como cópia do modelo" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 12: a capacidade na tela (catálogo, handler que recusa, filtro por conector)

**Files:**
- Create: `lib/mcp/tools/catalogo/sistema-de-gestao.ts`, `lib/mcp/tools/sistema-de-gestao.ts`
- Modify: `lib/mcp/tools/catalogo/index.ts`, `lib/mcp/tools/index.ts`, `app/api/v1/mcp/tools/route.ts`, `lib/agent-engine/edge/crm/mcp-tools.ts`
- Test: `tests/unit/capacidade-do-sistema-de-gestao.test.ts`

- [ ] **Step 1: teste que falha** — crie `tests/unit/capacidade-do-sistema-de-gestao.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { NATIVAS_DO_MOTOR } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { FERRAMENTAS_DO_CONECTOR } from "@/lib/conectores/ferramentas-do-agente";
import { capacidadesAutomaticasDoPacote } from "@/lib/mcp/tools/selecao-por-pacote";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { getToolByName } from "@/lib/mcp/tools";

describe("as ferramentas do conector na tela", () => {
  it("estão no catálogo, com os ids da fonte única", () => {
    for (const id of FERRAMENTAS_DO_CONECTOR) expect(TOOL_CATALOG.map((t) => t.name)).toContain(id);
  });

  it("enviar cobrança é CRÍTICA: ligar o pacote Atender não a liga sozinha", () => {
    expect(TOOL_CATALOG.find((t) => t.name === "crm_enviar_cobranca_erp")?.risco).toBe("critico");
    expect(capacidadesAutomaticasDoPacote(TOOL_CATALOG, "atender")).not.toContain("crm_enviar_cobranca_erp");
  });

  it("o handler MCP RECUSA fora de uma conversa do agente (não consulta nem envia nada)", async () => {
    for (const id of FERRAMENTAS_DO_CONECTOR) {
      const r = (await getToolByName(id)!.handler({} as never, {} as never)) as { error?: string };
      expect(r.error).toMatch(/dentro de uma conversa/);
    }
  });

  it("a ponte MCP nunca as monta — nem no Conversador sem conector, nem no Operador", () => {
    for (const id of FERRAMENTAS_DO_CONECTOR) expect(NATIVAS_DO_MOTOR.has(id)).toBe(true);
  });
});
```

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run tests/unit/capacidade-do-sistema-de-gestao.test.ts` → FAIL.

- [ ] **Step 3: catálogo** — crie `lib/mcp/tools/catalogo/sistema-de-gestao.ts`:

```ts
/**
 * Capacidades do SISTEMA DE GESTÃO conectado (fase 4 do conector IXC) — consultar
 * o cliente da conversa e enviar a cobrança dele.
 *
 * São ferramentas NATIVAS do motor (`lib/agent-engine/agent/ferramentas-do-conector.ts`):
 * a cobrança tem de sair pela cadeia de envio do turno. O item de catálogo existe
 * para a TELA — é o interruptor por agente —, e o handler MCP correspondente só
 * recusa. `GET /api/v1/mcp/tools` só as serve a quem tem conector ligado.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente. O texto do MODELO mora em
 * `lib/conectores/ferramentas-do-agente.ts`.
 */
import { declararTools } from "./tipos";

export const TOOLS_SISTEMA_DE_GESTAO = declararTools([
  {
    name: "crm_consultar_cliente_erp",
    category: "read",
    rotulo: "Consultar o cliente no sistema de gestão",
    explicacao:
      "Procura o cliente da conversa no sistema de gestão conectado e mostra ao agente a situação do acesso, o plano, a conexão e as faturas em aberto — sem CPF, endereço nem senha. Quem não é reconhecido pelo telefone precisa confirmar CPF e data de nascimento.",
    oQueToca: "Sistema de gestão conectado",
    risco: "atencao",
    pacotes: ["atender"],
  },
  {
    name: "crm_enviar_cobranca_erp",
    category: "write",
    rotulo: "Enviar a cobrança do cliente (Pix ou boleto)",
    explicacao:
      "Manda ao cliente a cobrança de UMA fatura — a mais atrasada, ou a próxima a vencer —, com o QR code do Pix ou o PDF do boleto e o código para copiar. Fatura com atraso acima do limite configurado não é enviada: a conversa vai para a cobrança.",
    oQueToca: "Mensagens ao cliente e sistema de gestão",
    risco: "critico",
    pacotes: ["atender"],
  },
]);
```

Em `lib/mcp/tools/catalogo/index.ts`: `import { TOOLS_SISTEMA_DE_GESTAO } from "./sistema-de-gestao";` e `...TOOLS_SISTEMA_DE_GESTAO,` no fim do array `TOOL_CATALOG`.

- [ ] **Step 4: handler que recusa** — crie `lib/mcp/tools/sistema-de-gestao.ts`:

```ts
/**
 * crm_consultar_cliente_erp / crm_enviar_cobranca_erp — pela PONTE MCP, só recusam.
 *
 * As duas existem de verdade como ferramentas NATIVAS do motor
 * (`lib/agent-engine/agent/ferramentas-do-conector.ts`): usam o cliente DAQUELA
 * conversa e enviam pela saída DAQUELE turno. Um cliente MCP externo não tem
 * conversa para amarrar, e abrir o ERP por contato a uma integração é superfície
 * que ninguém pediu. Este handler existe pela paridade catálogo×handler
 * (`lib/mcp/tools/index.ts`), e `NATIVAS_DO_MOTOR` impede a ponte de montá-lo num turno.
 */
import { z } from "zod";

import {
  DESCRICAO_CONSULTAR_CLIENTE,
  DESCRICAO_ENVIAR_COBRANCA,
  FERRAMENTA_CONSULTAR_CLIENTE,
  FERRAMENTA_ENVIAR_COBRANCA,
} from "@/lib/conectores/ferramentas-do-agente";

import type { McpToolDefinition } from "../types";

const RECUSA = {
  error:
    "Esta capacidade só funciona dentro de uma conversa atendida por um agente de IA: ela usa o cliente daquela conversa e envia pela saída dela.",
};

const consultarShape = { cpf_cnpj: z.string().optional(), data_nascimento: z.string().optional() };
const enviarShape = { forma: z.string().optional() };

export const crmConsultarClienteErp: McpToolDefinition<typeof consultarShape> = {
  name: FERRAMENTA_CONSULTAR_CLIENTE,
  description: DESCRICAO_CONSULTAR_CLIENTE,
  inputSchema: consultarShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async () => RECUSA,
};

export const crmEnviarCobrancaErp: McpToolDefinition<typeof enviarShape> = {
  name: FERRAMENTA_ENVIAR_COBRANCA,
  description: DESCRICAO_ENVIAR_COBRANCA,
  inputSchema: enviarShape,
  category: "write",
  // Paridade com a rota do botão (`…/faturas/[id]/enviar`), que pede `agent`.
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async () => RECUSA,
};
```

Em `lib/mcp/tools/index.ts`: `import { crmConsultarClienteErp, crmEnviarCobrancaErp } from "./sistema-de-gestao";`, `crmConsultarClienteErp,` no grupo `// read` de `allTools` e `crmEnviarCobrancaErp,` no grupo de escrita (siga os comentários de grupo existentes).

- [ ] **Step 5: a ponte nunca as monta** — em `lib/agent-engine/edge/crm/mcp-tools.ts`, importe `import { FERRAMENTAS_DO_CONECTOR } from '@/lib/conectores/ferramentas-do-agente';`, acrescente depois de `BLOCKED_TOOL_IDS`:

```ts
/**
 * Ids do catálogo implementados NATIVAMENTE pelo motor — a ponte nunca os monta.
 * O handler MCP deles só recusa (existe pela paridade catálogo×handler); montá-lo
 * poria no turno uma ferramenta que sempre diz não: no Conversador sem conector,
 * ou no Operador, que não fala com o cliente. Diferente de `BLOCKED_TOOL_IDS`, sai
 * em silêncio: estar ligado na tela é o estado normal, não um alerta.
 */
export const NATIVAS_DO_MOTOR: ReadonlySet<string> = new Set(FERRAMENTAS_DO_CONECTOR);
```

e troque `const allowed = agentConfig.toolIds.filter((id) => !BLOCKED_TOOL_IDS.has(id));` por `const allowed = agentConfig.toolIds.filter((id) => !BLOCKED_TOOL_IDS.has(id) && !NATIVAS_DO_MOTOR.has(id));`.

- [ ] **Step 6: a tela só as oferece a quem tem conector** — em `app/api/v1/mcp/tools/route.ts`, importe `FERRAMENTAS_DO_CONECTOR` de `@/lib/conectores/ferramentas-do-agente`, `conectorDoAgente` de `@/lib/conectores/registro` e `createAdminClient` de `@/lib/supabase/admin`, e antes do `const tools = …`:

```ts
  // As ferramentas do sistema de gestão só existem para quem tem um conectado:
  // sem ele, oferecer "Enviar a cobrança" prometeria na tela uma capacidade que o
  // turno nunca monta. Falha ao ler = não oferece (o turno também não montaria).
  let temConector = false;
  try {
    temConector = (await conectorDoAgente(createAdminClient(), activeOrg.orgId)) !== null;
  } catch {
    temConector = false;
  }
  const oferecidas = servidas.filter((c) => temConector || !FERRAMENTAS_DO_CONECTOR.includes(c.id));
```

e troque `const tools = servidas.map(` por `const tools = oferecidas.map(`.

- [ ] **Step 7: a escrita de atendente, declarada** — `tests/unit/capacidade-alcancavel-pelo-agente.test.ts` exige que toda tool de ESCRITA com `requiresRole: "agent"` esteja em `ESCRITA_QUE_E_TRABALHO_DE_ATENDENTE`, com a rota HTTP equivalente. Acrescente ao fim do array:

```ts
  // `app/api/v1/contacts/[id]/conectores/ixc/faturas/[faturaId]/enviar/` — POST
  // exige `agent` (`contextoIxc` → `requireRole("agent")`): mandar a cobrança é o
  // botão do atendente. Pela ponte MCP a tool só recusa; quem envia é a ferramenta
  // nativa do motor, pela cadeia de envio do turno.
  "crm_enviar_cobranca_erp",
```

- [ ] **Step 8: ver passar** — `pnpm exec vitest run tests/unit/capacidade-do-sistema-de-gestao.test.ts tests/unit/catalogo-tools-leigo-friendly.test.ts tests/unit/capacidade-alcancavel-pelo-agente.test.ts tests/unit/operador-nao-tem-canal.test.ts tests/unit/tool-read-nao-muta.test.ts tests/unit/selecao-por-pacote.test.ts tests/unit/catalogo-servido.test.ts tests/unit/vazamento-interno-detector.test.ts tests/unit/capacidades-padrao-do-onboarding.test.ts` → PASS. Se o gate leigo (`catalogo-tools-leigo-friendly`) reprovar uma palavra da `explicacao`, reescreva a frase trocando a palavra que a mensagem do teste aponta — o texto é do humano, o do modelo não muda.

- [ ] **Step 9: commit** — `git add lib/mcp/tools lib/agent-engine/edge/crm/mcp-tools.ts app/api/v1/mcp/tools/route.ts tests/unit/capacidade-do-sistema-de-gestao.test.ts tests/unit/capacidade-alcancavel-pelo-agente.test.ts && git commit -m "feat(capacidades): consultar cliente e enviar cobrança na tela do agente — só para quem tem sistema de gestão" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 13: as ferramentas nativas do motor

**Files:**
- Create: `lib/agent-engine/agent/ferramentas-do-conector.ts`, `tests/unit/ferramentas-do-conector.test.ts`

- [ ] **Step 1: testes que falham** — crie `tests/unit/ferramentas-do-conector.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const conectorDoAgente = vi.fn();
vi.mock("@/lib/conectores/registro", () => ({ conectorDoAgente: (...a: unknown[]) => conectorDoAgente(...a) }));
const lerCredencial = vi.fn();
const lerLimite = vi.fn();
const carimbar = vi.fn();
vi.mock("@/lib/conectores/conexao", () => ({
  lerCredencial: (...a: unknown[]) => lerCredencial(...a),
  lerLimiteDeCobranca: (...a: unknown[]) => lerLimite(...a),
  carimbarEstado: (...a: unknown[]) => carimbar(...a),
}));
const audit = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));

import { FalhaDoConector } from "@/lib/conectores/tipos";
import { montarFerramentasDoConector } from "@/lib/agent-engine/agent/ferramentas-do-conector";

const consultar = vi.fn();
const enviarCobranca = vi.fn();
const upload = vi.fn(async () => ({ error: null }));
let recusas = 0;
let provider = "meta_cloud";
const pool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("from contacts")) return { rows: [{ phone_number: "+5561993040271", provider }] };
    if (sql.includes("api_audit_log")) return { rows: [{ n: recusas }] };
    return { rows: [] };
  }),
};
const saida = { vagas: vi.fn(() => 3), enviar: vi.fn(async () => ({ ok: true as const, outcome: { kind: "sent" as const, idempotencyKey: "k", messageId: "m" } })) };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const montar = (toolIds: string[] = ["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]) =>
  montarFerramentasDoConector({
    pool: pool as never,
    supabase: { storage: { from: () => ({ upload }) } } as never,
    log,
    tenantId: "org-1",
    leadId: "lead-1",
    conversationId: "00000000-0000-4000-8000-0000000000c1",
    channelSessionId: "sess-1",
    toolIds,
    agentId: "agente-1",
    saida,
    agora: () => new Date("2026-09-22T15:00:00Z"),
  });
const rodar = async (nome: string, args: object = {}) => {
  const { tools } = await montar();
  return (await tools[nome]!.execute!(args as never, { toolCallId: "t", messages: [] } as never)) as Record<string, unknown>;
};

const IDENTIFICADO = {
  estado: "identificado",
  cliente: { primeiroNome: "Maria", situacao: "Bloqueado", motivoDaSituacao: "financeiro em atraso", bloqueado: true, plano: "Fibra 500 Mega", clienteDesde: "2024-03-10", conexao: "offline", temOsAberta: false },
  financeiro: {
    vencidas: [{ vencimento: "2026-07-14", valorCents: 12990, diasDeAtraso: 70 }],
    proxima: { vencimento: "2026-10-12", valorCents: 12990, diasDeAtraso: 0 },
    totalVencidoCents: 12990,
    daVez: { vencimento: "2026-07-14", valorCents: 12990, diasDeAtraso: 70 },
  },
  vinculou: { verificadoPor: "telefone", cadastros: ["10"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  recusas = 0;
  provider = "meta_cloud";
  conectorDoAgente.mockResolvedValue({ id: "ixc", agente: { consultar, enviarCobranca } });
  lerCredencial.mockResolvedValue({ baseUrl: "https://erp", token: "t", status: "ativa" });
  lerLimite.mockResolvedValue(60);
  saida.vagas.mockReturnValue(3);
});

describe("montagem", () => {
  it("sem as capacidades ligadas: nada entra, nada é lido", async () => {
    expect(Object.keys((await montar([])).tools)).toEqual([]);
    expect(conectorDoAgente).not.toHaveBeenCalled();
  });

  it("ligadas sem conector na organização: não entram, e voltam como ausentes", async () => {
    conectorDoAgente.mockResolvedValue(null);
    const r = await montar();
    expect(Object.keys(r.tools)).toEqual([]);
    expect(r.ausentes).toEqual(["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]);
  });
});

describe("crm_consultar_cliente_erp", () => {
  it("formata para o modelo, sem id, e manda NÃO enviar quando a fatura passa do limite", async () => {
    consultar.mockResolvedValue(IDENTIFICADO);
    const r = await rodar("crm_consultar_cliente_erp");
    expect(r).toMatchObject({ ok: true, estado: "identificado", cliente: { primeiro_nome: "Maria", cliente_desde: "10/03/2024", bloqueado: true } });
    expect(r.financeiro).toMatchObject({ total_vencido: "R$ 129,90", fatura_da_vez: { vencimento: "14/07/2026", valor: "R$ 129,90", dias_de_atraso: 70, vai_para_a_cobranca: true } });
    expect(String(r.orientacao)).toMatch(/NÃO envie/);
    expect(JSON.stringify(r)).not.toMatch(/"10"|cadastro/);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conector.vinculo_criado", metadata: expect.objectContaining({ ator: "ai_agent", agente_id: "agente-1" }) }));
  });

  it("passa ao conector o estado do telefone NESTE canal (sim/nao/desconhecido)", async () => {
    consultar.mockResolvedValue({ estado: "precisa_cpf_e_nascimento" });
    provider = "site_widget";
    await rodar("crm_consultar_cliente_erp");
    expect(consultar).toHaveBeenCalledWith(expect.objectContaining({ identidadeDoTelefone: "nao", telefone: "+5561993040271" }));
  });

  it("recusa: audita (aguardando) e devolve as tentativas que sobram, sem dizer qual dado errou", async () => {
    consultar.mockResolvedValue({ estado: "nao_conferiu" });
    audit.mockImplementation(async () => {
      recusas += 1;
    });
    const r = await rodar("crm_consultar_cliente_erp", { cpf_cnpj: "52998224725", data_nascimento: "1985-03-13" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conector.identificacao_recusada", resourceType: "conversation" }));
    expect(r).toMatchObject({ ok: false, estado: "nao_conferiu", tentativas_restantes: 2 });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("52998224725");
  });

  it("3 recusas no atendimento: esgotadas, sem nem consultar", async () => {
    recusas = 3;
    const r = await rodar("crm_consultar_cliente_erp", { cpf_cnpj: "52998224725", data_nascimento: "1985-03-12" });
    expect(r.estado).toBe("tentativas_esgotadas");
    expect(consultar).not.toHaveBeenCalled();
  });

  it("IXC fora: carimba erro na conexão e manda transferir, sem inventar", async () => {
    consultar.mockRejectedValue(new FalhaDoConector("sem_resposta", "x"));
    const r = await rodar("crm_consultar_cliente_erp");
    expect(r.estado).toBe("sistema_indisponivel");
    expect(carimbar).toHaveBeenCalledWith(expect.anything(), "org-1", "ixc", "erro", "sem_resposta");
  });
});

describe("crm_enviar_cobranca_erp", () => {
  it("sem 2 vagas no turno: recusa ANTES de ir ao ERP", async () => {
    saida.vagas.mockReturnValue(1);
    const r = await rodar("crm_enviar_cobranca_erp");
    expect(r).toMatchObject({ ok: false, error: { code: "max_sends_per_turn" } });
    expect(enviarCobranca).not.toHaveBeenCalled();
  });

  it("guarda o arquivo no prefixo da conversa, envia pela saída do turno e audita com o agente", async () => {
    enviarCobranca.mockImplementation(async (p: { portas: { guardarArquivo: (a: object) => Promise<string>; enviar: (m: object) => Promise<void> }; forma: string; limiteDeDias: number }) => {
      const caminho = await p.portas.guardarArquivo({ nome: "pix-14-07-2026", extensao: "png", mime: "image/png", conteudo: Buffer.from("x") });
      await p.portas.enviar({ type: "image", body: "Segue o Pix", media_storage_path: caminho, media_mime: "image/png", media_size_bytes: 1 });
      await p.portas.enviar({ type: "text", body: "000201..." });
      return { resultado: "enviada", forma: "pix", fatura: { vencimento: "2026-08-20", valorCents: 12990, diasDeAtraso: 33 }, faturaId: "901", enviadas: 2, previstas: 2, pixGeradoAgora: true, pixIndisponivel: false };
    });
    const r = await rodar("crm_enviar_cobranca_erp", { forma: "PIX" });
    expect(enviarCobranca).toHaveBeenCalledWith(expect.objectContaining({ forma: "pix", limiteDeDias: 60 }));
    expect(upload.mock.calls[0]?.[0]).toMatch(/^org-1\/00000000-0000-4000-8000-0000000000c1\/cobranca-[0-9a-f]{8}\/pix-14-07-2026\.png$/);
    expect(saida.enviar).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: true, estado: "enviada", forma: "pix", fatura: { valor: "R$ 129,90" } });
    expect(JSON.stringify(r)).not.toContain("901");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conector.fatura_enviada", metadata: expect.objectContaining({ fatura: "901", ator: "ai_agent", pix_gerado_agora: true }) }));
  });

  it("veto da saída (opt-out) volta ao modelo com o código", async () => {
    saida.enviar.mockResolvedValueOnce({ ok: false, code: "contato_bloqueado", message: "opt-out" } as never);
    enviarCobranca.mockImplementation(async (p: { portas: { enviar: (m: object) => Promise<void> } }) => {
      await p.portas.enviar({ type: "image", body: "x" });
      throw new Error("inalcançável");
    });
    expect(await rodar("crm_enviar_cobranca_erp")).toMatchObject({ ok: false, error: { code: "contato_bloqueado" } });
  });

  it("acima do limite: audita o encaminhamento e manda transferir", async () => {
    enviarCobranca.mockResolvedValue({ resultado: "encaminhar_para_cobranca", fatura: { vencimento: "2026-07-14", valorCents: 12990, diasDeAtraso: 70 }, faturaId: "900" });
    const r = await rodar("crm_enviar_cobranca_erp");
    expect(r).toMatchObject({ ok: false, estado: "encaminhar_para_cobranca" });
    expect(String(r.orientacao)).toMatch(/setor de cobrança/);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conector.cobranca_encaminhada", metadata: expect.objectContaining({ dias_de_atraso: 70, limite_de_dias: 60 }) }));
  });
});
```

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run tests/unit/ferramentas-do-conector.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: implementar** — crie `lib/agent-engine/agent/ferramentas-do-conector.ts`:

```ts
/**
 * AS FERRAMENTAS DO CONECTOR NO TURNO DO AGENTE — consultar o cliente no sistema
 * de gestão e enviar a cobrança dele.
 *
 * O motor não conhece o IXC: pede ao registro o conector da organização que
 * declara `agente` (lib/conectores/registro.ts) e fala com ele pelo contrato de
 * lib/conectores/tipos.ts. A cerca é tests/unit/conectores-cerca.test.ts.
 *
 * O que mora AQUI, e não no conector, é o que depende de conversa, atendimento e
 * agente:
 *   - a conversa, o contato e o canal vêm do closure do turno — o modelo nunca
 *     passa contato, conversa nem id de fatura;
 *   - as 3 tentativas de identificação por ATENDIMENTO, contadas pela auditoria;
 *   - a auditoria com o agente como ator;
 *   - a SAÍDA: cada mensagem da cobrança passa pela cadeia before-send do turno
 *     (`PortaDeEnvioDoTurno`, montada no inbound-turn), nunca por fora;
 *   - o que o MODELO lê: valores e datas formatados, a `orientacao` de cada caso,
 *     e nada de id, CPF, endereço, IP, MAC ou senha (decisão de 21/09).
 *
 * Spec: docs/superpowers/specs/2026-09-22-ia-envia-cobranca-ixc-design.md.
 */
import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { tool, type ToolSet } from 'ai';
import type pg from 'pg';
import { z } from 'zod';

import { audit } from '@/lib/audit';
import { identidadeDoTelefone } from '@/lib/channels/capabilities';
import { carimbarEstado, lerCredencial, lerLimiteDeCobranca } from '@/lib/conectores/conexao';
import {
  DESCRICAO_CONSULTAR_CLIENTE,
  DESCRICAO_ENVIAR_COBRANCA,
  FERRAMENTA_CONSULTAR_CLIENTE,
  FERRAMENTA_ENVIAR_COBRANCA,
  FERRAMENTAS_DO_CONECTOR,
} from '@/lib/conectores/ferramentas-do-agente';
import { conectorDoAgente } from '@/lib/conectores/registro';
import {
  FalhaDoConector,
  type CapacidadeDoAgente,
  type ConectorId,
  type FaturaParaAgente,
  type MensagemDaCobranca,
  type ResultadoDaCobranca,
  type ResultadoDaConsulta,
} from '@/lib/conectores/tipos';

import type { ChannelSendResult } from '../channel-adapter';
import type { Logger } from '../obs/logger';

/** Na 3ª recusa de identidade no atendimento, a IA para de pedir e transfere (decisão de 21/09). */
export const TENTATIVAS_DE_IDENTIFICACAO = 3;
/** Uma cobrança são duas mensagens: o arquivo com a legenda e o código para copiar. */
export const MENSAGENS_POR_COBRANCA = 2;

export type EnvioDoTurno = { ok: true; outcome: ChannelSendResult } | { ok: false; code: string; message: string };

/** A saída do turno, montada no inbound-turn: cadeia before-send + canal + `seq`. */
export interface PortaDeEnvioDoTurno {
  /** Quantas mensagens ainda cabem neste turno (teto de envios). */
  vagas(): number;
  enviar(mensagem: MensagemDaCobranca): Promise<EnvioDoTurno>;
}

export interface PedidoDeFerramentas {
  pool: pg.Pool;
  supabase: SupabaseClient;
  log: Logger;
  tenantId: string;
  leadId: string;
  conversationId: string;
  channelSessionId: string;
  toolIds: readonly string[];
  agentId: string | null;
  saida: PortaDeEnvioDoTurno;
  agora: () => Date;
}

export interface FerramentasDoConector {
  tools: ToolSet;
  /** Ligadas na tela sem conector que as sirva nesta organização — vira aviso na Central. */
  ausentes: string[];
}

interface ConectorDoTurno {
  id: ConectorId;
  agente: CapacidadeDoAgente;
}

type Resposta = Record<string, unknown>;

/** O veto da cadeia de saída, levado por dentro de `enviarCobranca` do conector até aqui. */
class VetoDaSaida extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VetoDaSaida';
  }
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const valor = (cents: number): string => BRL.format(cents / 100).replace(/ /g, ' ');
const dataBr = (ymd: string | null): string | null => {
  const [a, m, d] = (ymd ?? '').split('-');
  return a && m && d ? `${d}/${m}/${a}` : null;
};
const faturaDoModelo = (f: FaturaParaAgente): Resposta => ({
  vencimento: dataBr(f.vencimento),
  valor: valor(f.valorCents),
  ...(f.diasDeAtraso > 0 ? { dias_de_atraso: f.diasDeAtraso } : {}),
});

const TRANSFERIR_COBRANCA = 'transfira a conversa para o time que cuida de cobrança/financeiro';

function indisponivel(): Resposta {
  return {
    ok: false,
    estado: 'sistema_indisponivel',
    orientacao:
      'Não consegui consultar o sistema de gestão agora. Diga isso ao cliente com naturalidade e ' +
      'transfira a conversa para uma pessoa — não invente situação, valor nem vencimento.',
  };
}

function esgotadas(): Resposta {
  return {
    ok: false,
    estado: 'tentativas_esgotadas',
    orientacao:
      'Não foi possível confirmar a identidade neste atendimento. Não peça mais dados e não fale de ' +
      `valores: diga que vai passar para o setor de cobrança e ${TRANSFERIR_COBRANCA}.`,
  };
}

export async function montarFerramentasDoConector(p: PedidoDeFerramentas): Promise<FerramentasDoConector> {
  const pedidas = FERRAMENTAS_DO_CONECTOR.filter((id) => p.toolIds.includes(id));
  if (pedidas.length === 0) return { tools: {}, ausentes: [] };
  const conector = await conectorDoAgente(p.supabase, p.tenantId);
  if (!conector) return { tools: {}, ausentes: pedidas };

  const tools: ToolSet = {};
  if (pedidas.includes(FERRAMENTA_CONSULTAR_CLIENTE)) {
    tools[FERRAMENTA_CONSULTAR_CLIENTE] = tool({
      description: DESCRICAO_CONSULTAR_CLIENTE,
      // Schema LARGO de propósito: dado mal formatado tem de chegar aqui e voltar
      // como `orientacao` que o modelo entende, nunca como erro de validação do SDK.
      inputSchema: z
        .object({
          cpf_cnpj: z.string().optional().describe('CPF ou CNPJ do titular, como o cliente digitou'),
          data_nascimento: z.string().optional().describe('data de nascimento do titular, AAAA-MM-DD'),
        })
        .passthrough(),
      execute: ({ cpf_cnpj, data_nascimento }) => consultar(p, conector, cpf_cnpj, data_nascimento),
    });
  }
  if (pedidas.includes(FERRAMENTA_ENVIAR_COBRANCA)) {
    tools[FERRAMENTA_ENVIAR_COBRANCA] = tool({
      description: DESCRICAO_ENVIAR_COBRANCA,
      inputSchema: z
        .object({ forma: z.string().optional().describe('"pix" (padrão) ou "boleto" — boleto só se o cliente pedir') })
        .passthrough(),
      execute: ({ forma }) => enviarCobranca(p, conector, forma),
    });
  }
  return { tools, ausentes: [] };
}

async function conversa(p: PedidoDeFerramentas): Promise<{ telefone: string | null; identidadeDoTelefone: ReturnType<typeof identidadeDoTelefone> }> {
  const { rows } = await p.pool.query<{ phone_number: string | null; provider: string | null }>(
    `select c.phone_number, s.provider
       from contacts c
       left join channel_sessions s on s.id = $3 and s.organization_id = c.organization_id
      where c.organization_id = $1 and c.id = $2`,
    [p.tenantId, p.leadId, p.channelSessionId],
  );
  return { telefone: rows[0]?.phone_number ?? null, identidadeDoTelefone: identidadeDoTelefone(rows[0]?.provider) };
}

/** Recusas de identidade no ATENDIMENTO atual — cliente que volta noutro atendimento recomeça do zero. */
async function recusasNoAtendimento(p: PedidoDeFerramentas): Promise<number> {
  const { rows } = await p.pool.query<{ n: number }>(
    `select count(*)::int as n
       from api_audit_log a
      where a.organization_id = $1
        and a.action = 'conector.identificacao_recusada'
        and a.resource_type = 'conversation'
        and a.resource_id = $2::uuid
        and a.created_at >= coalesce(
              (select v.service_started_at from conversations v
                where v.id = $2::uuid and v.organization_id = $1),
              '-infinity'::timestamptz)`,
    [p.tenantId, p.conversationId],
  );
  return rows[0]?.n ?? 0;
}

const ator = (p: PedidoDeFerramentas) => ({ ator: 'ai_agent', agente_id: p.agentId });

async function falha(p: PedidoDeFerramentas, conector: ConectorDoTurno, err: unknown): Promise<Resposta> {
  if (err instanceof FalhaDoConector) {
    // O mesmo laço do painel: o admin vê em Configurações › Conectores o que a IA encontrou.
    if (err.motivo !== 'recurso_indisponivel') {
      await carimbarEstado(p.supabase, p.tenantId, conector.id, 'erro', err.motivo).catch(() => undefined);
    }
    p.log.warn('sistema de gestão indisponível na ferramenta do agente', { conector: conector.id, motivo: err.motivo });
  } else {
    p.log.error('ferramenta do conector falhou', {
      conector: conector.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
  }
  return indisponivel();
}

async function voltouAoAr(p: PedidoDeFerramentas, conector: ConectorDoTurno, status: string): Promise<void> {
  if (status === 'erro') await carimbarEstado(p.supabase, p.tenantId, conector.id, 'ativa', null).catch(() => undefined);
}

async function consultar(
  p: PedidoDeFerramentas,
  conector: ConectorDoTurno,
  cpfCnpj: string | undefined,
  dataNascimento: string | undefined,
): Promise<Resposta> {
  try {
    const credencial = await lerCredencial(p.supabase, p.tenantId, conector.id);
    if (!credencial) return indisponivel();
    const cpf = cpfCnpj?.trim() || undefined;
    const nascimento = dataNascimento?.trim() || undefined;
    if ((cpf || nascimento) && (await recusasNoAtendimento(p)) >= TENTATIVAS_DE_IDENTIFICACAO) return esgotadas();
    const c = await conversa(p);
    const r = await conector.agente.consultar({
      admin: p.supabase,
      credencial,
      orgId: p.tenantId,
      contactId: p.leadId,
      telefone: c.telefone,
      identidadeDoTelefone: c.identidadeDoTelefone,
      ...(cpf ? { cpfCnpj: cpf } : {}),
      ...(nascimento ? { dataNascimento: nascimento } : {}),
      agora: p.agora(),
    });
    await voltouAoAr(p, conector, credencial.status);
    return await respostaDaConsulta(p, conector, r);
  } catch (err) {
    return falha(p, conector, err);
  }
}

function orientacaoDaConsulta(r: Extract<ResultadoDaConsulta, { estado: 'identificado' }>, limite: number): string {
  const daVez = r.financeiro?.daVez;
  if (daVez && daVez.diasDeAtraso > limite) {
    return (
      `A fatura da vez tem ${daVez.diasDeAtraso} dias de atraso, acima do limite de ${limite}: NÃO envie ` +
      `a cobrança. Diga que a fatura foi encaminhada ao setor de cobrança e ${TRANSFERIR_COBRANCA}.`
    );
  }
  const partes: string[] = [];
  if (r.cliente.bloqueado === true) {
    partes.push(
      'O acesso está bloqueado. Se o cliente quiser pagar, envie a cobrança e explique que a liberação ' +
        'acontece depois que o pagamento for compensado — sem prometer prazo.',
    );
  }
  if (daVez) {
    partes.push(
      `Para cobrar, use ${FERRAMENTA_ENVIAR_COBRANCA}: ela envia só a fatura da vez, por Pix, a menos que ` +
        'o cliente peça boleto. Não prometa enviar mais de uma fatura.',
    );
  } else if (r.financeiro) {
    partes.push('Não há fatura em aberto.');
  } else {
    partes.push('O financeiro não pôde ser lido agora: não afirme valores nem vencimentos.');
  }
  return partes.join(' ');
}

async function respostaDaConsulta(p: PedidoDeFerramentas, conector: ConectorDoTurno, r: ResultadoDaConsulta): Promise<Resposta> {
  switch (r.estado) {
    case 'identificado': {
      if (r.vinculou) {
        void audit({
          action: 'conector.vinculo_criado',
          organizationId: p.tenantId,
          resourceType: 'contact',
          resourceId: p.leadId,
          metadata: { conector: conector.id, cadastros: r.vinculou.cadastros, verificado_por: r.vinculou.verificadoPor, conversa: p.conversationId, ...ator(p) },
        });
      }
      const limite = await lerLimiteDeCobranca(p.supabase, p.tenantId, conector.id);
      const f = r.financeiro;
      const nd = 'indisponivel';
      return {
        ok: true,
        estado: 'identificado',
        cliente: {
          primeiro_nome: r.cliente.primeiroNome,
          situacao: r.cliente.situacao ?? nd,
          ...(r.cliente.motivoDaSituacao ? { motivo_da_situacao: r.cliente.motivoDaSituacao } : {}),
          bloqueado: r.cliente.bloqueado ?? nd,
          plano: r.cliente.plano ?? nd,
          cliente_desde: dataBr(r.cliente.clienteDesde) ?? nd,
          conexao: r.cliente.conexao ?? nd,
          tem_os_aberta: r.cliente.temOsAberta ?? nd,
        },
        financeiro: f
          ? {
              vencidas: f.vencidas.map(faturaDoModelo),
              proxima: f.proxima ? faturaDoModelo(f.proxima) : null,
              total_vencido: valor(f.totalVencidoCents),
              fatura_da_vez: f.daVez ? { ...faturaDoModelo(f.daVez), vai_para_a_cobranca: f.daVez.diasDeAtraso > limite } : null,
            }
          : nd,
        orientacao: orientacaoDaConsulta(r, limite),
      };
    }
    case 'precisa_cpf':
      return { ok: false, estado: r.estado, orientacao: 'Este telefone está em mais de um cadastro. Peça o CPF (ou CNPJ) do titular e chame de novo com cpf_cnpj.' };
    case 'precisa_cpf_e_nascimento':
      return { ok: false, estado: r.estado, orientacao: 'Para falar de conta e pagamento, peça o CPF (ou CNPJ) e a data de nascimento do titular e chame de novo com os dois.' };
    case 'cpf_invalido':
      return { ok: false, estado: r.estado, orientacao: 'O CPF/CNPJ informado não é válido. Peça para a pessoa conferir e digitar de novo.' };
    case 'data_invalida':
      return { ok: false, estado: r.estado, orientacao: 'A data informada não é uma data válida. Peça de novo (dia/mês/ano) e envie como AAAA-MM-DD.' };
    case 'nao_conferiu': {
      // AGUARDADA: é o contador das tentativas, não telemetria. Sem CPF nem data no metadata.
      await audit({
        action: 'conector.identificacao_recusada',
        organizationId: p.tenantId,
        resourceType: 'conversation',
        resourceId: p.conversationId,
        metadata: { conector: conector.id, ...ator(p) },
      });
      const restantes = Math.max(0, TENTATIVAS_DE_IDENTIFICACAO - (await recusasNoAtendimento(p)));
      if (restantes === 0) return esgotadas();
      return {
        ok: false,
        estado: 'nao_conferiu',
        tentativas_restantes: restantes,
        orientacao: 'Os dados não conferem com o cadastro. NÃO diga qual deles está errado. Peça para a pessoa conferir e informar de novo.',
      };
    }
  }
}

async function enviarCobranca(p: PedidoDeFerramentas, conector: ConectorDoTurno, formaBruta: string | undefined): Promise<Resposta> {
  const forma = formaBruta?.trim().toLowerCase() === 'boleto' ? 'boleto' : 'pix';
  const vagas = p.saida.vagas();
  if (vagas < MENSAGENS_POR_COBRANCA) {
    return {
      ok: false,
      error: {
        code: 'max_sends_per_turn',
        message:
          `a cobrança são ${MENSAGENS_POR_COBRANCA} mensagens e este turno só tem ${Math.max(0, vagas)} envio(s) ` +
          'livre(s). Não envie mais nada agora: encerre o turno. Na próxima vez, chame esta ferramenta ANTES de escrever texto.',
      },
    };
  }
  try {
    const credencial = await lerCredencial(p.supabase, p.tenantId, conector.id);
    if (!credencial) return indisponivel();
    const c = await conversa(p);
    const limite = await lerLimiteDeCobranca(p.supabase, p.tenantId, conector.id);
    const r = await conector.agente.enviarCobranca({
      admin: p.supabase,
      credencial,
      orgId: p.tenantId,
      contactId: p.leadId,
      identidadeDoTelefone: c.identidadeDoTelefone,
      forma,
      limiteDeDias: limite,
      agora: p.agora(),
      portas: {
        // Storage-first, no prefixo que o handler de envio confere (`<org>/<conversa>/…`).
        // O ÚLTIMO segmento é o nome que o cliente vê — igual à rota do botão.
        guardarArquivo: async (arquivo) => {
          const caminho = `${p.tenantId}/${p.conversationId}/cobranca-${randomUUID().slice(0, 8)}/${arquivo.nome}.${arquivo.extensao}`;
          const { error } = await p.supabase.storage
            .from('whatsapp-media')
            .upload(caminho, arquivo.conteudo, { contentType: arquivo.mime, upsert: false });
          if (error) throw new Error(`storage: ${error.message}`);
          return caminho;
        },
        enviar: async (mensagem) => {
          const envio = await p.saida.enviar(mensagem);
          if (!envio.ok) throw new VetoDaSaida(envio.code, envio.message);
        },
      },
    });
    await voltouAoAr(p, conector, credencial.status);
    return respostaDaCobranca(p, conector, r, limite);
  } catch (err) {
    if (err instanceof VetoDaSaida) return { ok: false, error: { code: err.code, message: err.message } };
    return falha(p, conector, err);
  }
}

function respostaDaCobranca(p: PedidoDeFerramentas, conector: ConectorDoTurno, r: ResultadoDaCobranca, limite: number): Resposta {
  switch (r.resultado) {
    case 'enviada': {
      // A mesma ação do botão, com o agente como ator. O id, a forma e o valor —
      // nunca a linha digitável nem o copia-e-cola.
      void audit({
        action: 'conector.fatura_enviada',
        organizationId: p.tenantId,
        resourceType: 'conversation',
        resourceId: p.conversationId,
        metadata: {
          conector: conector.id,
          fatura: r.faturaId,
          forma: r.forma,
          vencimento: r.fatura.vencimento,
          valor_cents: r.fatura.valorCents,
          mensagens_enviadas: r.enviadas,
          mensagens_previstas: r.previstas,
          pix_gerado_agora: r.pixGeradoAgora,
          pix_indisponivel: r.pixIndisponivel,
          ...ator(p),
        },
      });
      if (r.enviadas < r.previstas) {
        return { ok: false, estado: 'enviada_em_parte', orientacao: 'Só o arquivo da cobrança saiu; o código para copiar não. Avise o cliente e transfira a conversa para uma pessoa.' };
      }
      return {
        ok: true,
        estado: 'enviada',
        forma: r.forma,
        fatura: faturaDoModelo(r.fatura),
        ...(r.pixIndisponivel ? { pix_indisponivel: true } : {}),
        orientacao:
          (r.pixIndisponivel ? 'O Pix não pôde ser gerado, então foi enviado o BOLETO desta fatura — conte isso ao cliente. ' : '') +
          'A cobrança foi enviada (arquivo + código para copiar). Não repita o código nem o valor em texto; se quiser, escreva no máximo uma frase curta.',
      };
    }
    case 'cliente_nao_identificado':
      return { ok: false, estado: r.resultado, orientacao: `O cliente desta conversa ainda não foi identificado. Chame ${FERRAMENTA_CONSULTAR_CLIENTE} primeiro.` };
    case 'sem_fatura_em_aberto':
      return { ok: false, estado: r.resultado, orientacao: 'Não há fatura em aberto para este cliente. Diga isso a ele.' };
    case 'encaminhar_para_cobranca': {
      void audit({
        action: 'conector.cobranca_encaminhada',
        organizationId: p.tenantId,
        resourceType: 'conversation',
        resourceId: p.conversationId,
        metadata: { conector: conector.id, fatura: r.faturaId, dias_de_atraso: r.fatura.diasDeAtraso, limite_de_dias: limite, ...ator(p) },
      });
      return {
        ok: false,
        estado: r.resultado,
        fatura: faturaDoModelo(r.fatura),
        orientacao: `Esta fatura tem ${r.fatura.diasDeAtraso} dias de atraso, acima do limite de ${limite}: nada foi enviado. Diga que ela foi encaminhada ao setor de cobrança e ${TRANSFERIR_COBRANCA}.`,
      };
    }
    case 'boleto_indisponivel':
      return { ok: false, estado: r.resultado, fatura: faturaDoModelo(r.fatura), orientacao: 'O boleto desta fatura ainda não foi emitido. Ofereça o Pix; se o cliente aceitar, chame de novo com forma "pix".' };
    case 'sem_como_cobrar':
      return {
        ok: false,
        estado: r.resultado,
        fatura: faturaDoModelo(r.fatura),
        ...(r.detalheDoErp ? { resposta_do_sistema: r.detalheDoErp } : {}),
        orientacao: `Não foi possível gerar a cobrança desta fatura agora. Diga que vai passar para o setor de cobrança e ${TRANSFERIR_COBRANCA} (a resposta do sistema vai no motivo da transferência, não para o cliente).`,
      };
  }
}
```

- [ ] **Step 4: ver passar** — `pnpm exec vitest run tests/unit/ferramentas-do-conector.test.ts tests/unit/conectores-cerca.test.ts` → PASS; `pnpm typecheck` → 0 erros.

- [ ] **Step 5: commit** — `git add lib/agent-engine/agent/ferramentas-do-conector.ts tests/unit/ferramentas-do-conector.test.ts && git commit -m "feat(motor): ferramentas nativas do conector — consultar o cliente e enviar a cobrança pela saída do turno" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 14: a ligação no turno, na prévia e na fila de envio

**Files:**
- Modify: `lib/agent-engine/agent/inbound-turn.ts`, `lib/agent-engine/agent/preview.ts`, `lib/agent-engine/edge/llm/fila-de-envio.ts`
- Test: `tests/unit/ferramentas-do-conector-ligacao.test.ts`

- [ ] **Step 1: guarda de ligação que falha** — crie `tests/unit/ferramentas-do-conector-ligacao.test.ts` (molde: `tests/unit/send-template-wiring.test.ts`):

```ts
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { FERRAMENTAS_DE_ENVIO } from "@/lib/agent-engine/edge/llm/fila-de-envio";
import { applyPreviewPolicy } from "@/lib/agent-engine/agent/preview";

/**
 * A LIGAÇÃO das ferramentas do conector no turno — o que nenhum teste das peças toca.
 * Prova que as quatro decisões estão escritas no código que roda; cada uma quebraria
 * em silêncio num refactor. NÃO prova que um modelo de verdade escolhe a ferramenta —
 * isso é o e2e (`tests/e2e/conector-ixc-no-painel.spec.ts`).
 */
const TURNO = fs.readFileSync(path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

describe("ferramentas do conector no turno", () => {
  it("o turno as monta e a saída delas passa pela cadeia com conteudoDoSistema", () => {
    expect(TURNO).toContain("montarFerramentasDoConector(");
    const bloco = TURNO.slice(TURNO.indexOf("montarFerramentasDoConector("));
    expect(bloco.slice(0, 4000)).toMatch(/runBeforeSend\(\{[\s\S]*conteudoDoSistema: true/);
    expect(bloco.slice(0, 4000)).toMatch(/seq \+= 1/);
  });

  it("capacidade ligada sem conector vira aviso na Central", () => {
    const bloco = TURNO.slice(TURNO.indexOf("montarFerramentasDoConector("));
    expect(bloco.slice(0, 5000)).toContain("avisarCapacidadesAusentes(");
  });

  it("a cobrança entra na fila de envio (ordem com o send_message)", () => {
    expect(FERRAMENTAS_DE_ENVIO).toContain("crm_enviar_cobranca_erp");
  });

  it("no botão Testar as duas viram proposta: nada é consultado nem enviado", async () => {
    let executou = false;
    const real = { description: "x", inputSchema: {} as never, execute: async () => { executou = true; return {}; } };
    const preview = { kind: "sandbox", contactId: "lead-real", result: { proposals: [] as unknown[], impediments: [], candidates: [] } };
    const tools = applyPreviewPolicy(
      { crm_consultar_cliente_erp: real, crm_enviar_cobranca_erp: real } as never,
      preview as never,
      {} as never,
      () => [],
    ) as Record<string, { execute: (a: unknown) => Promise<{ status?: string }> }>;
    for (const nome of ["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]) {
      expect((await tools[nome]!.execute({})).status).toBe("proposal_only");
    }
    expect(executou).toBe(false);
    expect(preview.result.proposals).toHaveLength(2);
  });
});
```

- [ ] **Step 2: ver falhar** — `pnpm exec vitest run tests/unit/ferramentas-do-conector-ligacao.test.ts` → FAIL.

- [ ] **Step 3: fila de envio** — em `lib/agent-engine/edge/llm/fila-de-envio.ts`, importe `import { FERRAMENTA_ENVIAR_COBRANCA } from '@/lib/conectores/ferramentas-do-agente';` e troque a constante por:

```ts
export const FERRAMENTAS_DE_ENVIO = ['send_message', 'send_template', FERRAMENTA_ENVIAR_COBRANCA] as const;
```

(se o comentário acima dela listar as ferramentas, acrescente a cobrança nele).

- [ ] **Step 4: prévia** — em `lib/agent-engine/agent/preview.ts`, importe `import { FERRAMENTAS_DO_CONECTOR } from '@/lib/conectores/ferramentas-do-agente';`, e em `applyPreviewPolicy`:
  - logo depois de `const catalog = getToolByName(name);`, acrescente `const doConector = FERRAMENTAS_DO_CONECTOR.includes(name);` e o comentário `// As ferramentas do conector tocam o ERP e gravam (vínculo, auditoria, envio): na prévia são SEMPRE proposta — mesmo a consulta, que o catálogo marca como leitura.`;
  - troque o `if (` da passagem direta por `if (!doConector && (nativeRead || (catalog?.category === 'read' && (p.contactId !== null || SCENARIO_READS.has(name)))))`;
  - troque `if (catalog?.category === 'read')` (o do `scenario_contact_unavailable`) por `if (catalog?.category === 'read' && !doConector)`;
  - no array de nomes do ramo de proposta, acrescente `...FERRAMENTAS_DO_CONECTOR,`.

- [ ] **Step 5: o turno** — em `lib/agent-engine/agent/inbound-turn.ts`:
  - importe `import { montarFerramentasDoConector } from './ferramentas-do-conector';`;
  - logo DEPOIS do bloco que apaga `send_template` (o `{ const provider = … if (!capabilitiesOf(provider).requiresTemplates) { delete rawTools.send_template; } }`) e ANTES do comentário `// 2B-tools:`, cole:

```ts
  // Ferramentas do CONECTOR (consultar o cliente no sistema de gestão, enviar a
  // cobrança): nativas do motor, porque a cobrança tem de sair por ESTA cadeia de
  // envio — opt-out, LGPD, ritmo, janela e o ledger (job, seq). Entram antes das do
  // catálogo; o nome nativo tem precedência e a ponte nunca monta o handler MCP
  // delas (`NATIVAS_DO_MOTOR`). Ver ferramentas-do-conector.ts.
  if (agentConfig !== null) {
    try {
      const doConector = await montarFerramentasDoConector({
        pool,
        supabase: deps.crmCfg.supabase,
        log: runLog,
        tenantId,
        leadId,
        conversationId: input.conversationId,
        channelSessionId: input.channelSessionId,
        toolIds: agentConfig.toolIds,
        agentId: agentConfig.agentId,
        agora: clock,
        saida: {
          vagas: () => maxSendsPerTurn - seq,
          enviar: async (mensagem) => {
            // O corpo é a legenda (ou o código): é ele que a cadeia avalia e que o
            // ledger identifica. `conteudoDoSistema`: valor e código vêm do ERP.
            const chain = await runBeforeSend({
              pool,
              log: runLog,
              agentOperation,
              tenantId,
              leadId,
              jobId: liveJob().id,
              channelSessionId: input.channelSessionId,
              body: mensagem.body,
              conteudoDoSistema: true,
              optedOutThisTurn,
              crmDailyLimit: null,
              now: clock(),
              sleep: deps.sleep,
              lgpd,
              agentId: agentConfig.agentId,
              send: (finalBody: string) => {
                seq += 1;
                return liveChannel().send({
                  tenantId,
                  leadId,
                  jobId: liveJob().id,
                  jobClaim: claimOfJob(liveJob()),
                  agentOperation,
                  seq,
                  conversationId: input.conversationId,
                  body: finalBody,
                  ...(mensagem.media_storage_path
                    ? {
                        media: {
                          kind: mensagem.type === 'image' ? ('image' as const) : ('document' as const),
                          storagePath: mensagem.media_storage_path,
                          mime: mensagem.media_mime ?? 'application/octet-stream',
                          sizeBytes: mensagem.media_size_bytes ?? 0,
                        },
                      }
                    : {}),
                });
              },
            });
            if (chain.status === 'vetoed') return { ok: false, code: chain.code, message: chain.message };
            outcomes.push(chain.outcome);
            if (chain.outcome.kind === 'blocked') {
              return { ok: false, code: 'contato_bloqueado', message: 'o contato optou por sair — nada mais deve ser enviado.' };
            }
            return { ok: true, outcome: chain.outcome };
          },
        },
      });
      Object.assign(rawTools, doConector.tools);
      if (doConector.ausentes.length > 0) {
        const detalhe = `capacidades ligadas sem sistema de gestão conectado: ${doConector.ausentes.join(', ')}`;
        runLog.warn('ferramentas do conector ligadas sem conector na organização', { ausentes: doConector.ausentes });
        if (preview) {
          preview.result.impediments.push({ code: 'capabilities_unavailable', message: 'O sistema de gestão não está conectado.' });
        } else {
          await avisarCapacidadesAusentes(pool, tenantId, input.conversationId, detalhe, runLog);
        }
      }
    } catch (err) {
      // Mesma regra das tools do catálogo: capacidade extra não derruba o turno,
      // mas a ausência dela aparece na Central — não num log que ninguém lê.
      const detalhe = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      runLog.error('ferramentas do conector não montadas — turno segue sem elas', { error: detalhe });
      if (preview) {
        preview.result.impediments.push({ code: 'capabilities_unavailable', message: 'Não foi possível carregar as capacidades configuradas.' });
      } else {
        await avisarCapacidadesAusentes(pool, tenantId, input.conversationId, detalhe, runLog);
      }
    }
  }
```

  Confira com `grep -n "const maxSendsPerTurn\|let seq = 0\|const outcomes\|const optedOutThisTurn\|const lgpd = \|const agentOperation" lib/agent-engine/agent/inbound-turn.ts` que todos esses nomes estão declarados ANTES do ponto de inserção (estão: `seq`/`maxSendsPerTurn` ~2320, `outcomes` ~2406, `lgpd`/`optedOutThisTurn` ~2100, `agentOperation` ~1887).

- [ ] **Step 6: ver passar** — `pnpm exec vitest run tests/unit/ferramentas-do-conector-ligacao.test.ts tests/unit/envios-do-turno-saem-na-ordem.test.ts tests/unit/send-template-wiring.test.ts tests/unit/gate-vazamento-interno.test.ts tests/unit/handoff-por-orcamento.test.ts` → PASS; `pnpm typecheck` → 0 erros; `pnpm lint && pnpm lint:channels && pnpm lint:role-rank` → verdes.

- [ ] **Step 7: commit** — `git add lib/agent-engine/agent/inbound-turn.ts lib/agent-engine/agent/preview.ts lib/agent-engine/edge/llm/fila-de-envio.ts tests/unit/ferramentas-do-conector-ligacao.test.ts && git commit -m "feat(motor): as ferramentas do conector entram no turno, na prévia (proposta) e na fila de envio" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 15: a prova pela tela (e2e) com o IXC falso

**Files:**
- Create: `scripts/e2e-turno-da-ia-cobranca.ts`
- Modify: `tests/e2e/conector-ixc-no-painel.spec.ts`

- [ ] **Step 1: o turno com modelo roteirizado** — crie `scripts/e2e-turno-da-ia-cobranca.ts`:

```ts
/**
 * Roda UM turno da IA numa conversa — o motor REAL (ferramentas, cadeia de envio,
 * ledger, `sendMessageHandler`, Storage, canal WAHA do rig), com SÓ o modelo
 * trocado por um roteiro. É o que a spec e2e do conector usa para provar pela tela
 * que a IA manda a cobrança sem worker nem chave de IA no CI.
 *
 * O roteiro: consulta o cliente; se identificado, pede a cobrança; escreve uma
 * frase conforme o que a ferramenta respondeu. Mesmo recorte de
 * `lib/agent-engine/agent/preview-fixture.ts` para as chamadas internas (memória,
 * compactação), que não têm ferramentas.
 *
 * Uso: npx tsx scripts/e2e-turno-da-ia-cobranca.ts <org> <conversa>
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import pg from "pg";

// `lib/env.ts` valida o ambiente AO SER IMPORTADO: o `.env.local` do rig entra no
// process.env antes de qualquer módulo do app (o ambiente já definido vence).
for (const linha of (fs.existsSync(".env.local") ? fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8") : "").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(linha);
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = (m[2] ?? "").replace(/^"(.*)"$/, "$1").trim();
}

const USO = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

async function main(): Promise<void> {
  const [org, conversa] = process.argv.slice(2);
  if (!org || !conversa) throw new Error("uso: e2e-turno-da-ia-cobranca.ts <org> <conversa>");
  const { credenciaisSupabaseDeTeste } = await import("./lib/env-de-teste");
  const cred = credenciaisSupabaseDeTeste();
  const pool = new pg.Pool({ connectionString: cred.dbUrl });
  const { createClient } = await import("@supabase/supabase-js");
  const { createInboundTurnHandler } = await import("@/lib/agent-engine/agent/inbound-turn");
  const { createFakeRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
  const queue = await import("@/lib/agent-engine/queue/queue");
  const { withServiceJob } = await import("@/lib/atendimento/fronteira-server");
  const { createLogger } = await import("@/lib/agent-engine/obs/logger");

  const registry = createFakeRegistry(async (options) => {
    const fim = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: undefined }, usage: USO, warnings: [] });
    if (!options.tools?.length) {
      const texto = JSON.stringify(options.prompt);
      return fim(
        JSON.stringify(
          texto.includes("Turno interno de memória")
            ? { notes: [] }
            : texto.includes("Compacte a conversa")
              ? { commitments: [], objections: [], personal_data: [], stage: null, rolling_summary: "Cobrança pela IA." }
              : { commitments: [], objections: [], next_action: null, rolling_summary: "Cobrança pela IA.", declaracao: { promessas: [] } },
        ),
      );
    }
    const resultados = options.prompt.filter((m) => m.role === "tool").flatMap((m) => m.content) as Array<{ toolName?: string; output?: { value?: unknown } }>;
    const visto = (nome: string) => resultados.find((r) => r.toolName === nome)?.output?.value as Record<string, unknown> | undefined;
    const chamar = (toolName: string, input: object) => ({
      content: [{ type: "tool-call" as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    });
    const consulta = visto("crm_consultar_cliente_erp");
    if (!consulta) return chamar("crm_consultar_cliente_erp", {});
    const envio = visto("crm_enviar_cobranca_erp");
    if (consulta.estado === "identificado" && !envio) return chamar("crm_enviar_cobranca_erp", {});
    if (!visto("send_message")) {
      const corpo =
        envio?.estado === "enviada"
          ? "Prontinho! Te mandei o Pix da fatura."
          : envio?.estado === "encaminhar_para_cobranca"
            ? "Sua fatura foi encaminhada ao nosso setor de cobrança. Já vou te passar para eles."
            : "Vou te passar para uma pessoa da equipe.";
      return chamar("send_message", { body: corpo });
    }
    return fim("fim");
  });

  const { rows: alvo } = await pool.query<{ contact_id: string; channel_session_id: string; msg: string }>(
    `select c.contact_id, c.channel_session_id,
            (select m.id from messages m where m.conversation_id = c.id and m.direction = 'inbound' order by m.sent_at desc limit 1) as msg
       from conversations c where c.id = $1 and c.organization_id = $2`,
    [conversa, org],
  );
  const linha = alvo[0];
  if (!linha) throw new Error("conversa não encontrada");
  const fronteira = (
    await pool.query("select fn_service_boundary($1,$2)-'status'-'demanda_fechada_em'-'service_started_at' as b", [org, conversa])
  ).rows[0].b;

  const handler = createInboundTurnHandler({
    crmCfg: { supabase: createClient(cred.url, cred.serviceRole, { auth: { persistSession: false } }) },
    llmCfg: { anthropicApiKey: "e2e-roteiro" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 4000,
      notesIndexMaxTokens: 500,
      maxSteps: 8,
      queuedRetryDelayMs: 1000,
      breaker: { exactFailureWarn: 2, exactFailureBlock: 5, sameToolFailureWarn: 3, sameToolFailureHalt: 8, noProgressWarn: 3, noProgressBlock: 5 },
    },
    log: createLogger(),
    registry,
    sleep: async () => {},
  });

  const { job } = await queue.enqueueJob(pool, org, {
    kind: "inbound_turn",
    leadId: linha.contact_id,
    payload: {
      conversation_id: conversa,
      contact_id: linha.contact_id,
      channel_session_id: linha.channel_session_id,
      inbound_message_id: linha.msg,
      crm_event_id: randomUUID(),
      service_boundary: fronteira,
    },
    maxAttempts: 1,
  });
  const [claimed] = await queue.claimJobs(pool, { workerId: "e2e-cobranca", maxConcurrency: 1 });
  if (claimed?.id !== job.id) throw new Error("outro job foi reivindicado antes do turno da cobrança");
  await withServiceJob(pool, claimed, () => handler(claimed, pool, { workerId: "e2e-cobranca" }));
  await queue.completeJob(pool, claimed.id, "e2e-cobranca");
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
```

(Se `claimJobs` pegar job pendente de OUTRA spec no mesmo banco, faça antes `update job_queue set status='done' where status='pending' and organization_id = $org` — só da org deste teste.)

- [ ] **Step 2: o IXC falso ganha a cliente da IA** — em `tests/e2e/conector-ixc-no-painel.spec.ts`:
  - acrescente `data_nascimento` às linhas de `TABELAS.cliente` (`"1985-03-12"` para a Maria, `"0000-00-00"` para as outras);
  - acrescente dois cadastros NOVOS, para não interferir no teste existente: `{ id: "60", razao: "Bruna Paga Em Dia", cnpj_cpf: "153.509.460-56", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0600", whatsapp: "", telefone_comercial: "", fone: "", data_nascimento: "1990-05-20", senha: "x" }` e `{ id: "70", razao: "Caio Muito Atrasado", cnpj_cpf: "746.971.314-01", tipo_pessoa: "F", ativo: "S", telefone_celular: "(61) 99304-0700", whatsapp: "", telefone_comercial: "", fone: "", data_nascimento: "1975-11-02", senha: "x" }`;
  - contratos: `{ id: "760", id_cliente: "60", contrato: "Fibra 300 Mega", status: "A", status_internet: "A", data_ativacao: "2025-02-01", num_parcelas_atraso: "0", endereco: "", numero: "", bairro: "", desbloqueio_confianca_ativo: "N" }` e o mesmo para `"770"`/`"70"` com `status_internet: "FA"`;
  - faturas: para o 60, uma vencida há 12 dias SEM `pix_txid` e com boleto (`id: "960"`, `data_vencimento: dia(-12)`, `linha_digitavel` preenchida) e uma a vencer (`"961"`, `dia(18)`); para o 70, uma vencida há 75 dias (`"970"`, `dia(-75)`).
  - Confira os CPFs com `documentoNaMascara` antes de usar (`npx tsx -e 'import {documentoNaMascara} from "./lib/conectores/ixc/mascara"; console.log(documentoNaMascara("15350946056"), documentoNaMascara("74697131401"))'`) — se algum voltar `null`, gere outro válido.

- [ ] **Step 3: o caso novo** — acrescente ao fim do arquivo um segundo `test(...)`, que reusa `subirIxcFalso`, `insert`, `login` e o receiver WAHA do primeiro (extraia a criação do receiver para uma função `subirWahaFalso(enviadas: string[])` usada pelos dois):

```ts
test("a IA identifica o cliente e envia a cobrança — pela tela, com o IXC falso", async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(`${evidence}/ia`, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const password = `Local-${randomUUID()}!`;
  const email = `conector-ia-${randomUUID()}@invariant.test`;
  let org = "";
  let user = "";
  const enviadasAoWaha: string[] = [];
  const ixc = await subirIxcFalso();
  const waha = await subirWahaFalso(enviadasAoWaha);

  try {
    // Organização, admin, canal WAHA — o mesmo cenário do primeiro teste.
    const created = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Paula Admin" } });
    if (created.error || !created.data.user) throw created.error;
    user = created.data.user.id;
    org = await insert("organizations", { display_name: "Provedor da IA", legal_name: "Provedor da IA", slug: `conector-ia-${randomUUID()}`, onboarded_at: new Date().toISOString() });
    const vinculo = await db.from("user_organizations").insert({ organization_id: org, user_id: user, role: "admin", accepted_at: new Date().toISOString() });
    if (vinculo.error) throw vinculo.error;
    const session = await insert("channel_sessions", { organization_id: org, waha_session_name: `conector-ia-${randomUUID()}`, display_name: "Whats Cobrança", phone_number: "+556130004064", status: "WORKING", webhook_secret_encrypted: "\\x00" });
    // Janela anti-ban aberta o dia todo: o CI roda de madrugada (UTC) e o ritmo
    // vetaria por horário — o teste mediria o relógio, não a cobrança.
    await insert("channel_knobs", { organization_id: org, channel_session_id: session, window_start_hour: 0, window_end_hour: 24, allow_sunday: true, throttle_ms: 0, jitter_max_ms: 0 });

    // Agente em RASCUNHO no canal; as capacidades são ligadas PELA TELA.
    const agente = await insert("ai_agents", { organization_id: org, name: "Bia de Teste", system_prompt: "Você é a Bia." });
    const versao = await insert("ai_agent_versions", { organization_id: org, agent_id: agente, version_number: 1, system_prompt: "Você é a Bia.", provider: "anthropic", model: "claude-sonnet-4-6", channel_session_id: session, status: "draft" });

    async function conversaDe(nome: string, telefone: string, texto: string) {
      const contato = await insert("contacts", { organization_id: org, display_name: nome, phone_number: telefone });
      const conversa = await insert("conversations", { organization_id: org, contact_id: contato, channel_session_id: session, status: "ai_handling" });
      const sentAt = new Date().toISOString();
      await insert("messages", { organization_id: org, contact_id: contato, conversation_id: conversa, channel_session_id: session, direction: "inbound", type: "text", status: "received", sent_via: "external_device", body: texto, sent_at: sentAt });
      const marked = await db.rpc("fn_mark_conversation_message", { p_conv: conversa, p_direction: "inbound", p_preview: texto, p_at: sentAt });
      if (marked.error) throw marked.error;
      return { contato, conversa };
    }
    const bruna = await conversaDe("Bruna Whats", "+5561993040600", "Oi, quero pagar minha fatura");
    const caio = await conversaDe("Caio Whats", "+5561993040700", "Me manda o boleto");

    await login(page, email, password);

    // ── 1. SEM conector, o editor do agente NÃO oferece as capacidades ────────
    await page.goto(`/app/ai/agents/${agente}`);
    await page.getByTestId("tool-picker").waitFor({ state: "visible", timeout: 90_000 });
    await page.getByTestId("toggle-avancado").click();
    await expect(page.getByTestId("capacidade-crm_enviar_cobranca_erp")).toHaveCount(0);
    await expect(page.getByTestId("capacidade-crm_consultar_cliente_erp")).toHaveCount(0);

    // ── 2. O admin liga o IXC e ajusta o limite para 70 dias ──────────────────
    await page.goto("/app/settings/conectores");
    const ficha = page.getByTestId("conector-ixc");
    await ficha.getByLabel("Endereço do sistema").fill(`http://127.0.0.1:${PORTA_DO_IXC}`);
    await ficha.getByLabel("Token de acesso").fill(TOKEN_CERTO);
    await ficha.getByRole("button", { name: "Testar e salvar" }).click();
    await expect(ficha).toHaveAttribute("data-estado", "ligado", { timeout: 30_000 });
    const limite = page.getByTestId("limite-cobranca-ixc");
    await expect(limite.getByLabel("Dias de atraso")).toHaveValue("60");
    await limite.getByLabel("Dias de atraso").fill("70");
    await limite.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Limite salvo.")).toBeVisible();
    await page.screenshot({ path: `${evidence}/ia/01-limite-de-dias.png` });
    const { data: conexao } = await db.from("conector_conexoes").select("cobranca_encaminha_apos_dias").eq("organization_id", org).single();
    expect(conexao?.cobranca_encaminha_apos_dias).toBe(70);

    // ── 3. Agora o editor oferece as duas; a cobrança é CRÍTICA (marcação individual) ──
    await page.goto(`/app/ai/agents/${agente}`);
    await page.getByTestId("tool-picker").waitFor({ state: "visible", timeout: 90_000 });
    await page.getByTestId("toggle-avancado").click();
    for (const id of ["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]) {
      const caixa = page.getByTestId(`capacidade-${id}`).first();
      await expect(caixa).toBeVisible();
      await caixa.click();
    }
    await page.screenshot({ path: `${evidence}/ia/02-capacidades-ligadas.png` });
    await page.getByRole("button", { name: /salvar rascunho/i }).click();
    await expect.poll(async () => (await db.from("ai_agent_versions").select("tool_ids").eq("id", versao).single()).data?.tool_ids ?? []).toEqual(
      expect.arrayContaining(["crm_consultar_cliente_erp", "crm_enviar_cobranca_erp"]),
    );
    // Publicar NÃO é o que este teste mede (exige chave de IA): o rascunho salvo pela tela vira a versão no ar.
    await db.from("ai_agent_versions").update({ status: "published" }).eq("id", versao);
    await db.from("ai_agents").update({ published_version_id: versao }).eq("id", agente);

    // ── 4. A IA atende a Bruna: identifica pelo telefone e manda o Pix da vencida ──
    execFileSync("npx", ["tsx", "scripts/e2e-turno-da-ia-cobranca.ts", org, bruna.conversa], { stdio: "inherit" });
    await page.goto("/app/inbox?filter=all");
    await page.locator(`[data-conversation-id="${bruna.conversa}"]`).click();
    await expect(page.getByText("Segue o Pix da sua fatura.", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(COPIA_E_COLA)).toBeVisible();
    await expect(page.getByText("Prontinho! Te mandei o Pix da fatura.")).toBeVisible();
    await page.screenshot({ path: `${evidence}/ia/03-ia-enviou-o-pix.png`, fullPage: true });

    const { data: saidas } = await db.from("messages").select("type, body, media_storage_path, sent_via").eq("conversation_id", bruna.conversa).eq("direction", "outbound").order("created_at");
    expect(saidas?.map((m) => m.type)).toEqual(["image", "text", "text"]);
    expect(String(saidas?.[0]?.media_storage_path)).toMatch(new RegExp(`^${org}/${bruna.conversa}/cobranca-[0-9a-f]{8}/pix-`));
    expect(acoesPedidas.filter((a) => a.startsWith("get_pix"))).toContain("get_pix:960");
    expect(acoesPedidas).not.toContain("get_pix:961"); // nunca duas
    expect(enviadasAoWaha.some((e) => e.includes(COPIA_E_COLA))).toBe(true);
    const { data: trilha } = await db.from("api_audit_log").select("action, metadata").eq("organization_id", org).in("action", ["conector.vinculo_criado", "conector.fatura_enviada"]);
    expect(trilha?.find((t) => t.action === "conector.fatura_enviada")?.metadata).toMatchObject({ fatura: "960", forma: "pix", ator: "ai_agent" });
    expect(trilha?.find((t) => t.action === "conector.vinculo_criado")?.metadata).toMatchObject({ verificado_por: "telefone", ator: "ai_agent" });

    // ── 5. O Caio passa do limite (75 > 70): NADA de cobrança sai ─────────────
    const antes = acoesPedidas.length;
    execFileSync("npx", ["tsx", "scripts/e2e-turno-da-ia-cobranca.ts", org, caio.conversa], { stdio: "inherit" });
    await page.locator(`[data-conversation-id="${caio.conversa}"]`).click();
    await expect(page.getByText("Sua fatura foi encaminhada ao nosso setor de cobrança", { exact: false })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${evidence}/ia/04-acima-do-limite-nao-envia.png`, fullPage: true });
    const { data: doCaio } = await db.from("messages").select("type").eq("conversation_id", caio.conversa).eq("direction", "outbound");
    expect(doCaio?.map((m) => m.type)).toEqual(["text"]);
    expect(acoesPedidas.slice(antes).some((a) => a.startsWith("get_"))).toBe(false);
    const { data: encaminhada } = await db.from("api_audit_log").select("metadata").eq("organization_id", org).eq("action", "conector.cobranca_encaminhada");
    expect(encaminhada?.[0]?.metadata).toMatchObject({ fatura: "970", dias_de_atraso: 75, limite_de_dias: 70 });
  } finally {
    ixc.close();
    waha.close();
    await context.close();
    if (org) await db.from("organizations").delete().eq("id", org);
    if (user) await db.auth.admin.deleteUser(user);
  }
});
```

e acrescente `import { execFileSync } from "node:child_process";` no topo.

Acrescente também ao PRIMEIRO teste, depois do passo em que a Maria é vinculada pelo telefone, o caso do chat do site — mesmo telefone, canal que não o verifica:

```ts
    // ── Chat do site: o telefone foi DIGITADO — o painel não vincula sozinho ──
    const sessaoDoSite = await insert("channel_sessions", {
      organization_id: org,
      provider: "site_widget",
      waha_session_name: `site-${randomUUID()}`,
      display_name: "Chat do site",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    const visitante = await insert("contacts", { organization_id: org, display_name: "Visitante do site", phone_number: "+5561993040271" });
    const conversaDoSite = await insert("conversations", { organization_id: org, contact_id: visitante, channel_session_id: sessaoDoSite, status: "open", channel: "site_chat" });
    await page.goto("/app/inbox?filter=all");
    await page.locator(`[data-conversation-id="${conversaDoSite}"]`).click();
    await page.getByTestId("painel-aba-conector:ixc").click();
    await expect(page.getByTestId("painel-ixc")).toHaveAttribute("data-estado", "escolher", { timeout: 30_000 });
    await page.screenshot({ path: `${evidence}/site-nao-vincula-pelo-telefone-digitado.png` });
    const { data: doVisitante } = await db.from("contato_vinculos_externos").select("external_id").eq("contact_id", visitante);
    expect(doVisitante).toEqual([]);
```

(Se o insert em `channel_sessions` com `provider: "site_widget"` exigir colunas próprias do canal do site, copie-as do cenário de `tests/e2e/chat-do-site.spec.ts`; e se a conversa do site não aparecer na lista do Inbox, abra o painel pela URL da conversa que a spec do chat do site usa.)

- [ ] **Step 4: rodar localmente** — suba o ambiente fresco (receita do CLAUDE.md, seção QA Visual: Supabase local pg15 com o `baseline.sql`, `scripts/gerar-env-e2e.sh`, `pnpm build && pnpm start` na porta do e2e) e rode:

```bash
pnpm exec playwright test tests/e2e/conector-ixc-no-painel.spec.ts --workers=1 --reporter=list
```

Esperado: os 2 testes PASS e as 4 capturas em `.superpowers/evidence/conector-ixc/ia/`. Abra as capturas e confira a olho que o QR, o copia-e-cola e a frase da IA estão na conversa. Se o turno do roteiro não enviar, leia a saída do `execFileSync` (o logger do motor imprime o motivo: veto, elegibilidade, agente não resolvido).

- [ ] **Step 5: sabotagem** — troque temporariamente em `lib/conectores/ixc/agente.ts` `daVez.diasDeAtraso > p.limiteDeDias` por `false`, rode só o teste novo e confirme o passo 5 VERMELHO; restaure.

- [ ] **Step 6: commit** — `git add scripts/e2e-turno-da-ia-cobranca.ts tests/e2e/conector-ixc-no-painel.spec.ts && git commit -m "test(e2e): a IA identifica o cliente e envia a cobrança — pela tela, com o IXC falso" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 16: mapa vivo, jornada, fragmento e verificação final

**Files:**
- Modify: `docs/architecture/conectores.architecture.json`, `docs/testing/user-journey-map.md`
- Create: `.changes/ia-envia-cobranca-ixc.md`

- [ ] **Step 1: mapa vivo** — em `docs/architecture/conectores.architecture.json` (raias `tela`, `api`, `conector`, `banco`, `fora`), acrescente ao array `nodes`:

```json
{ "id": "ia-ferramentas", "lane": "api", "col": 7, "type": "backend", "label": "Turno do agente — ferramentas-do-conector.ts: consultar o cliente e enviar a cobrança; a saída passa pela cadeia before-send (conteudoDoSistema) e pelo ledger (job, seq)" },
{ "id": "ixc-agente", "lane": "conector", "col": 11, "type": "backend", "label": "ixc/agente.ts — identidade (telefone de identidade · CPF entre os do telefone · CPF + nascimento), fatura da vez, limite de dias, Pix com queda para o boleto" }
```

e ao array `edges`:

```json
{ "from": "ia-ferramentas", "to": "registro", "label": "conectorDoAgente — nunca importa ./ixc" },
{ "from": "registro", "to": "ixc-agente", "label": "definição.agente" },
{ "from": "ixc-agente", "to": "identificar", "label": "telefone · CPF + nascimento" },
{ "from": "ixc-agente", "to": "enviar-cobranca", "label": "reusa enviarCobrancaIxc (função única)" },
{ "from": "ia-ferramentas", "to": "tb-conexoes", "label": "limite de dias (0274)" },
{ "from": "ia-ferramentas", "to": "audit", "label": "fatura_enviada · identificacao_recusada · cobranca_encaminhada" },
{ "from": "ia-ferramentas", "to": "conversa", "label": "arquivo + código, pela saída do motor" },
{ "from": "config", "to": "tb-conexoes", "label": "limite de dias da cobrança pela IA" }
```

Confira que `ia-ferramentas`/`api`/`7` e `ixc-agente`/`conector`/`11` não colidem com nó existente (`python3 -c "import json;d=json.load(open('docs/architecture/conectores.architecture.json'));print(sorted((n['lane'],n['col']) for n in d['nodes']))"`). Rode `pnpm exec vitest run tests/unit/mapas-de-arquitetura.test.ts` → PASS.

- [ ] **Step 2: jornada J26** — em `docs/testing/user-journey-map.md`, na J26 (conector IXC), acrescente os casos: "[P1] a IA identifica pelo telefone (WhatsApp) e envia o Pix da fatura mais atrasada — `conector-ixc-no-painel.spec.ts`, teste 2, passo 4"; "[P1] fatura acima do limite de dias: a IA não envia e encaminha — passo 5"; "[P1] o limite de dias em Configurações › Conectores — passo 2"; "[P0] chat do site: o painel não vincula sozinho pelo telefone digitado — teste 1". Marque o achado: "Achado 22/09 — o painel vinculava pelo telefone DIGITADO no chat do site (corrigido nesta entrega)".

- [ ] **Step 3: fragmento** — crie `.changes/ia-envia-cobranca-ixc.md`:

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: A IA identifica o cliente no IXC e envia a cobrança (Pix ou boleto)
---

Com o IXC ligado em **Configurações › Conectores**, o agente de IA ganha duas capacidades
novas, no pacote **Atender e responder**: **Consultar o cliente no sistema de gestão** e
**Enviar a cobrança do cliente (Pix ou boleto)**. A segunda é crítica: precisa ser marcada
uma a uma, no modo avançado.

A IA reconhece o cliente pelo telefone do WhatsApp quando ele bate com um único cadastro. Se o
número estiver em mais de um cadastro, ela pede o CPF; se não estiver em nenhum, pede CPF e
data de nascimento — e nunca diz qual dos dois não conferiu. Depois de três tentativas no
mesmo atendimento, ela passa a conversa para a equipe.

A cobrança é sempre de UMA fatura: a mais atrasada; sem atrasada, a próxima a vencer. Sai por
Pix (QR code + copia e cola); o boleto em PDF sai quando o cliente pede. Fatura com mais dias
de atraso que o limite — **60 por padrão, ajustável na ficha do IXC** — não é enviada: a IA
avisa que ela foi encaminhada ao setor de cobrança e transfere.

Corrigido também: no chat do site, o painel do IXC não vincula mais o contato sozinho pelo
telefone que o visitante digitou — mostra os cadastros para o atendente escolher.

Para usar: ligue as duas capacidades numa versão nova do agente, ajuste o prompt e publique.
```

Confira com `pnpm release:conferir`.

- [ ] **Step 4: verificação completa** (Definition of Done do CLAUDE.md):

```bash
git fetch origin && git merge origin/main
pnpm typecheck
pnpm lint && pnpm lint:channels && pnpm lint:role-rank
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |Errors " /tmp/vt.log | tail -3
pnpm test:db > /tmp/db.log 2>&1; echo "exit=$?"
pnpm build
```

Esperado: exit 0 em tudo, exceto os vermelhos locais conhecidos (listados no topo), que têm de aparecer SÓ eles — compare os nomes com `grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c`.

- [ ] **Step 5: commit e PR**

```bash
git add docs/architecture/conectores.architecture.json docs/testing/user-journey-map.md .changes/ia-envia-cobranca-ixc.md
git commit -m "docs(ixc): mapa vivo, jornada J26 e fragmento da cobrança pela IA

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin claude/bia-ixc-cobranca-tools-32a240
gh pr create --title "A IA identifica o cliente no IXC e envia a cobrança (Pix ou boleto)" --body-file /private/tmp/claude-501/-Volumes-T9-Dyper--claude-worktrees-bia-ixc-cobranca-tools-32a240/88206a6d-3a27-4d98-9dfa-e5ec8f7b3a9e/scratchpad/pr-body.md
```

Antes do `gh pr create`, escreva `scratchpad/pr-body.md` com cinco seções: **O que muda** (as duas capacidades, o limite na tela, o conserto do painel); **Decisões do dono** (D1–D7 da spec, com datas); **Schema** (migration 0274, tripla); **O que foi medido** (arquivos de teste novos, `test:db`, e2e local com as capturas de `.superpowers/evidence/conector-ixc/ia/`, a sonda do nascimento); **O que NÃO foi medido** (envio real pela Meta a partir do motor; a data de pessoa jurídica; a escolha das ferramentas por um modelo de verdade — `gpt-5.6-terra` é o da Bia desde 22/09). Última linha: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

Acompanhe os 4 checks (`verify`, `build-and-size`, `invariants`, `imagens-ok`) pelas ferramentas de PR do app. **Não mesclar, não gerar release e não mexer na VPS** sem o dono pedir (memória `deskcomm-autorizacao-de-deploy-e-por-pedido`).
