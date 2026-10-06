# Telefonia · Fila visível — Entrega 1 (conversa viva ao atender) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** quando o atendente atende uma ligação recebida, o cartão "Ligação em andamento" entra na conversa, a conversa sobe para o topo de Minhas com atendimento aberto, e no fim o MESMO cartão é completado (duração, gravação, transferências).

**Architecture:** o worker (`ControladorDeChamadas`) chama uma função nova do repositório logo depois de atribuir a conversa a quem atendeu; ela insere a mensagem de sistema `ligacao:<voice_call_id>` com `metadata.voice_call.em_andamento = true`. O fim (`registrarNaConversa`) passa a ATUALIZAR essa mensagem, mesclando o metadado no banco. A passada de 60 s do telefone fecha o cartão que ficou órfão. A tela lê o campo novo no leitor central do cartão.

**Tech Stack:** TypeScript estrito, `pg` (pool do worker, fora da RLS — toda escrita filtra `organization_id`), Vitest (unit com dublês; invariantes contra Postgres real via `pnpm test:db`), React 19 + Testing Library, Playwright (só no GitHub Actions).

Desenho: `docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md` (§4.1).

---

## Decisões de implementação (emendas ao desenho, com o porquê)

1. **O campo é `em_andamento: true`, e o `desfecho` do cartão vivo é `"atendida"`** — o desenho dizia `desfecho = "em_andamento"`. Uma aba que não recarregou depois da atualização leria o desfecho desconhecido como "não atendida" e mostraria **"Ligação perdida"** em vermelho durante a ligação. Com o campo à parte, a tela antiga mostra "Ligação recebida · atendida por Ana" (verdade), e a nova mostra "Ligação em andamento".
2. **(REVERTIDA pela revisão independente — a função não mexe mais no time da conversa: a troca gravava "Transferida para a fila do time… Aguardando operador disponível" na linha do tempo de uma ligação já atendida, e o conserto pede migration.)** ~~A conversa passa para o time da ligação AO ATENDER, e só na criação do cartão~~ — o desenho dizia "ao entrar na fila". A conversa encerrada de quem já ligou guarda o dono antigo, e a regra que já existe (`registrarEscolhaDoMenu`) não mexe em conversa com dono. Ao atender, o dono é quem atendeu, e o atendimento novo pertence ao time que recebeu a ligação. Na segunda chamada (troca de atendente por transferência) o time não é tocado: se alguém mudou o setor da conversa pela tela durante a ligação, a escolha fica.
3. **Uma função só, idempotente**: `abrirCartaoDaLigacao` cria o cartão na primeira chamada e, nas seguintes, só troca o nome de quem está com a ligação.

## Regras do repositório que valem para todas as tasks

- Node 22: `source ~/.nvm/nvm.sh && nvm use 22.23.2` antes de qualquer `pnpm`.
- Nunca `console.log`. Comentários em português, no tom dos arquivos vizinhos (dizem o PORQUÊ).
- Toda consulta do worker filtra `organization_id` — vinda do banco (a linha da ligação), nunca de dado do chamador.
- `messages.metadata` é sempre MESCLADO no banco (`||`, `jsonb_set`), nunca sobrescrito.
- Um invariante só: `pnpm test:db tests/invariants/<arquivo>.test.ts` (~40 s, precisa do Docker).
- Unit de um arquivo: `pnpm exec vitest run <caminho>`.
- Commit ao fim de cada task, mensagem em português no padrão `tipo(escopo): frase`, terminando com
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Não rodar e2e, `next build` nem Supabase local nesta máquina.

## Estrutura de arquivos

| Arquivo | O que muda |
|---|---|
| `lib/channels/telefonia/repositorio.ts` | `nomeDoAtendente`, `textoDoCartaoEmAndamento`, `abrirCartaoDaLigacao`, `ligacoesComCartaoOrfao`, `consertarCartoesOrfaos`; `registrarNaConversa` atualiza o cartão em andamento |
| `lib/channels/telefonia/repositorio.test.ts` | caso de `textoDoCartaoEmAndamento` |
| `tests/invariants/telefonia-cartao-em-andamento.test.ts` | NOVO — o SQL contra Postgres real, duas organizações |
| `lib/channels/telefonia/portas.ts` | `PortaBanco.abrirCartaoDaLigacao` |
| `lib/channels/telefonia/laco.ts` | liga a porta; etapa nova na passada de 60 s |
| `lib/channels/telefonia/dubles-de-teste.ts` | `BancoFalso.abrirCartaoDaLigacao`, `falharCartao` |
| `lib/channels/telefonia/controle.ts` | `ramalAtendeu` abre o cartão |
| `lib/channels/telefonia/transferencia.ts` | quem pega a transferência entra no cartão |
| `lib/channels/telefonia/controle.test.ts`, `transferencia.test.ts`, `laco.test.ts` | casos novos |
| `components/telefonia/CartaoDaLigacao.tsx` (+ `.test.tsx`) | estado "Ligação em andamento" |
| `lib/i18n/dicionario.ts` | chaves que faltarem |
| `tests/e2e/telefonia-gravacao.spec.ts` | caso semeado: cartão em andamento que vira recebida sem recarregar |
| `.changes/telefonia-conversa-viva-ao-atender.md` | NOVO — fragmento |
| `docs/specs/20-spec-telefonia-sip.md`, `docs/current-state.md`, `docs/architecture/telefonia.architecture.json`, `docs/testing/user-journey-map.md`, o desenho | documentação |

---

### Task 1: o repositório abre, atualiza e fecha o cartão

**Files:**
- Modify: `lib/channels/telefonia/repositorio.ts` (perto de `registrarNaConversa`, ~linha 1198–1317)
- Modify: `lib/channels/telefonia/repositorio.test.ts`
- Create: `tests/invariants/telefonia-cartao-em-andamento.test.ts`

- [ ] **Step 1: escrever o invariante que falha**

Criar `tests/invariants/telefonia-cartao-em-andamento.test.ts`. O MOLDE do arquivo (cabeçalho, guarda de `TEST_DB_CONTAINER`, `pg.Pool` na porta de `TEST_DB_PORT`, `beforeAll` que semeia usuários em `auth.users`, organizações, `user_organizations`, `channel_sessions` de provider `sip_trunk`, e `afterAll` que fecha o pool) é `tests/invariants/telefonia-primeiro-toque-da-saida.test.ts` — leia-o inteiro e copie a semeadura, trocando o prefixo dos ids para `c0de0295-…`. Acrescente à semeadura: dois times por organização (`attendance_teams`: `SUPORTE`, `FINANCEIRO` na A; um na B), um usuário SEM `full_name` (só e-mail `caio-cartao@invariant.test`), e um contato por organização.

Helpers do arquivo:

```ts
/** Uma ligação recebida já ATENDIDA por `dono`, com conversa. Devolve os ids. */
async function ligacaoAtendida(p: {
  org: string; numero: string; contato: string; time: string | null; dono: string; statusDaConversa?: string;
}): Promise<{ vc: string; conversa: string }> {
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, team_id)
     values ($1, $2, $3, 'phone', 'open', false, 0, $4)
     on conflict (organization_id, contact_id, channel_session_id) where is_group = false
       do update set updated_at = now()
     returning id`,
    [p.org, p.contato, p.numero, p.time],
  );
  const conversa = c[0]!.id;
  const vc = await repo.criarLigacao(pool, {
    organizationId: p.org, troncoId: p.numero, sipCallRef: `canal-${Math.random().toString(36).slice(2)}`,
    direcao: "inbound", numeroDoOutroLado: "+5561988887777", contactId: p.contato, conversationId: conversa,
    teamId: p.time, status: "ringing",
  });
  await repo.marcarAtendida(pool, p.org, vc, p.dono);
  return { vc, conversa };
}

/** A mensagem do registro da ligação `vc` (ou nenhuma). */
async function cartao(org: string, vc: string) {
  const { rows } = await pool.query<{ id: string; body: string; metadata: { voice_call: Record<string, unknown> } & Record<string, unknown>; sent_at: string | null }>(
    "select id, body, metadata, sent_at from public.messages where organization_id = $1 and external_id = $2",
    [org, `ligacao:${vc}`],
  );
  return rows;
}
```

Casos (cada `it` cria a própria ligação com um contato novo, para não depender de ordem):

```ts
describe("o cartão nasce quando a ligação é atendida", () => {
  it("cria a mensagem do registro em andamento, com quem atendeu, e a conversa sobe na lista", async () => {
    const { vc, conversa } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, vc)).toBe(true);
    const [m] = await cartao(ORG, vc);
    expect(m!.body).toBe("Ligação em andamento com Ana do Cartão");
    expect(m!.metadata.voice_call).toMatchObject({
      id: vc, direcao: "inbound", desfecho: "atendida", em_andamento: true, duracao_ms: null,
      atendente_id: ANA, atendente_nome: "Ana do Cartão",
    });
    const { rows } = await pool.query("select last_message_at, last_message_preview from public.conversations where id = $1", [conversa]);
    expect(rows[0].last_message_at).not.toBeNull();
    expect(rows[0].last_message_preview).toBe("Ligação em andamento com Ana do Cartão");
  });

  it("quem não tem nome cadastrado aparece pelo e-mail — nunca vazio", async () => {
    const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: CAIO });
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);
    expect((await cartao(ORG, vc))[0]!.metadata.voice_call.atendente_nome).toBe("caio-cartao@invariant.test");
  });

  it("chamada de novo não duplica; com outro dono (transferência), troca o nome e não mexe no time", async () => {
    const { vc, conversa } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);
    // Alguém mudou o setor da conversa pela tela no meio da ligação: a escolha fica.
    await pool.query("update public.conversations set team_id = $2 where id = $1", [conversa, FINANCEIRO]);
    await repo.passarLigacao(pool, ORG, vc, BRUNO);
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, vc)).toBe(true);
    const linhas = await cartao(ORG, vc);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.metadata.voice_call).toMatchObject({ em_andamento: true, atendente_id: BRUNO, atendente_nome: "Bruno do Cartão" });
    expect(linhas[0]!.body).toBe("Ligação em andamento com Bruno do Cartão");
    const { rows } = await pool.query("select team_id from public.conversations where id = $1", [conversa]);
    expect(rows[0].team_id).toBe(FINANCEIRO);
  });

  it("a conversa que estava em outro time passa para o time da ligação", async () => {
    const c = await contato(ORG);
    const { vc, conversa } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: c, time: SUPORTE, dono: ANA });
    await pool.query("update public.conversations set team_id = $2 where id = $1", [conversa, FINANCEIRO]);
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);
    const { rows } = await pool.query("select team_id from public.conversations where id = $1", [conversa]);
    expect(rows[0].team_id).toBe(SUPORTE);
  });

  it("nada a fazer: outra organização, ligação feita, ainda tocando, sem conversa", async () => {
    const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    expect(await repo.abrirCartaoDaLigacao(pool, OUTRA, vc)).toBe(false);
    expect(await cartao(ORG, vc)).toHaveLength(0);
    expect(await cartao(OUTRA, vc)).toHaveLength(0);

    const tocando = await repo.criarLigacao(pool, {
      organizationId: ORG, troncoId: NUMERO, sipCallRef: "canal-tocando", direcao: "inbound",
      numeroDoOutroLado: "+5561988880001", contactId: await contato(ORG), conversationId: null, teamId: SUPORTE, status: "ringing",
    });
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, tocando)).toBe(false);
  });
});

describe("quem já ligou antes: a conversa encerrada reabre com atendimento novo, e o cartão nasce dentro dele", () => {
  it("atribuir + abrir o cartão: dono é quem atendeu, protocolo novo, cartão depois do início do atendimento", async () => {
    const c = await contato(ORG);
    const { vc: antiga, conversa } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: c, time: FINANCEIRO, dono: BRUNO });
    await repo.atribuirConversa(pool, ORG, conversa, BRUNO);
    await repo.encerrarLigacao(pool, ORG, antiga, "cliente_desligou");
    await pool.query("update public.conversations set status = 'closed' where id = $1", [conversa]);
    const { rows: antes } = await pool.query<{ protocol: string }>("select protocol from public.conversations where id = $1", [conversa]);

    const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: c, time: SUPORTE, dono: ANA });
    await repo.atribuirConversa(pool, ORG, conversa, ANA);
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);

    const { rows } = await pool.query<{ status: string; assigned_to_user_id: string; team_id: string; protocol: string; service_started_at: string }>(
      "select status, assigned_to_user_id, team_id, protocol, service_started_at from public.conversations where id = $1", [conversa]);
    expect(rows[0]).toMatchObject({ status: "claimed", assigned_to_user_id: ANA, team_id: SUPORTE });
    expect(rows[0]!.protocol).not.toBe(antes[0]!.protocol);
    const { rows: abertos } = await pool.query("select id from public.atendimentos where conversation_id = $1 and closed_at is null", [conversa]);
    expect(abertos).toHaveLength(1);
    const [m] = await cartao(ORG, vc);
    expect(new Date(m!.sent_at!).getTime()).toBeGreaterThanOrEqual(new Date(rows[0]!.service_started_at).getTime());
  });
});

describe("o fim completa o MESMO cartão", () => {
  it("atendida: uma mensagem só, sem a marca de andamento, com a duração; e o que outro escritor gravou continua", async () => {
    const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);
    // Outro escritor (reações, gravação) mexeu no metadado no meio da ligação.
    await pool.query(
      `update public.messages set metadata = jsonb_set(metadata || '{"outra_chave":1}'::jsonb, '{voice_call,de_outro}', '"fica"')
        where organization_id = $1 and external_id = $2`, [ORG, `ligacao:${vc}`]);
    const l = await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou");
    await repo.registrarNaConversa(pool, l!, "atendida", 65_000);

    const linhas = await cartao(ORG, vc);
    expect(linhas).toHaveLength(1);
    const v = linhas[0]!.metadata.voice_call;
    expect(v).toMatchObject({ desfecho: "atendida", duracao_ms: 65_000, atendente_nome: "Ana do Cartão", motivo: "cliente_desligou", de_outro: "fica" });
    expect("em_andamento" in v).toBe(false);
    expect(linhas[0]!.metadata.outra_chave).toBe(1);
    expect(linhas[0]!.body).toBe("Ligação recebida, atendida por Ana do Cartão · 1 min 05 s");
  });

  it("o fim reenviado não muda nada (o cartão fechado não é reescrito)", async () => {
    const { vc } = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    await repo.abrirCartaoDaLigacao(pool, ORG, vc);
    const l = await repo.encerrarLigacao(pool, ORG, vc, "cliente_desligou");
    await repo.registrarNaConversa(pool, l!, "atendida", 65_000);
    await repo.registrarNaConversa(pool, l!, "atendida", 999_000);
    expect((await cartao(ORG, vc))[0]!.metadata.voice_call.duracao_ms).toBe(65_000);
    // E abrir depois do fim não ressuscita o andamento.
    expect(await repo.abrirCartaoDaLigacao(pool, ORG, vc)).toBe(false);
    expect("em_andamento" in (await cartao(ORG, vc))[0]!.metadata.voice_call).toBe(false);
  });

  it("a perdida (sem cartão aberto) continua sendo INSERIDA no fim, como sempre", async () => {
    const c = await contato(ORG);
    const { rows: conv } = await pool.query<{ id: string }>(
      `insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, team_id)
       values ($1, $2, $3, 'phone', 'open', false, 0, $4) returning id`, [ORG, c, NUMERO, SUPORTE]);
    const vc = await repo.criarLigacao(pool, {
      organizationId: ORG, troncoId: NUMERO, sipCallRef: "canal-perdida", direcao: "inbound",
      numeroDoOutroLado: "+5561988880002", contactId: c, conversationId: conv[0]!.id, teamId: SUPORTE, status: "ringing",
    });
    const l = await repo.encerrarLigacao(pool, ORG, vc, "ninguem_atendeu");
    await repo.registrarNaConversa(pool, l!, "perdida", null);
    const linhas = await cartao(ORG, vc);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.metadata.voice_call).toMatchObject({ desfecho: "perdida" });
    expect(linhas[0]!.body).toBe("Ligação recebida não atendida");
  });
});

describe("o cartão que ficou em andamento com a ligação já encerrada é fechado pela passada", () => {
  it("fecha o órfão de mais de um minuto, em cada organização; o recém-encerrado fica para o fim normal", async () => {
    const a = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    const b = await ligacaoAtendida({ org: OUTRA, numero: NUMERO_OUTRA, contato: await contato(OUTRA), time: TIME_OUTRA, dono: DANI });
    const recente = await ligacaoAtendida({ org: ORG, numero: NUMERO, contato: await contato(ORG), time: SUPORTE, dono: ANA });
    for (const x of [a, recente]) await repo.abrirCartaoDaLigacao(pool, ORG, x.vc);
    await repo.abrirCartaoDaLigacao(pool, OUTRA, b.vc);
    // A ligação fechou no banco e a escrita do cartão falhou.
    await pool.query(
      `update public.voice_calls set status = 'ended', end_reason = 'cliente_desligou',
              answered_at = now() - interval '5 minutes', ended_at = now() - interval '2 minutes'
        where id = any($1::uuid[])`, [[a.vc, b.vc]]);
    await pool.query(
      `update public.voice_calls set status = 'ended', end_reason = 'cliente_desligou',
              answered_at = now() - interval '40 seconds', ended_at = now() - interval '10 seconds'
        where id = $1`, [recente.vc]);

    expect(await repo.consertarCartoesOrfaos(pool)).toBe(2);
    const va = (await cartao(ORG, a.vc))[0]!.metadata.voice_call;
    expect("em_andamento" in va).toBe(false);
    expect(va).toMatchObject({ desfecho: "atendida", duracao_ms: 180_000, atendente_nome: "Ana do Cartão" });
    expect("em_andamento" in (await cartao(OUTRA, b.vc))[0]!.metadata.voice_call).toBe(false);
    expect((await cartao(ORG, recente.vc))[0]!.metadata.voice_call.em_andamento).toBe(true);
    // Segunda passada: nada a fazer.
    expect(await repo.consertarCartoesOrfaos(pool)).toBe(0);
  });
});
```

`contato(org)` é um helper do arquivo que insere um contato novo (telefone único por chamada) e devolve o id.

- [ ] **Step 2: rodar e ver falhar**

Run: `pnpm test:db tests/invariants/telefonia-cartao-em-andamento.test.ts`
Expected: FAIL — `repo.abrirCartaoDaLigacao is not a function` (e `consertarCartoesOrfaos`).

- [ ] **Step 3: implementar no repositório**

Em `lib/channels/telefonia/repositorio.ts`, logo ACIMA do comentário de `registrarNaConversa`:

```ts
/** O nome de quem atende, como o registro da conversa o escreve: o cadastrado ou, sem ele, o e-mail. */
async function nomeDoAtendente(db: Queryable, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { rows } = await db.query<{ nome: string | null }>(
    "select coalesce(raw_user_meta_data->>'full_name', email) as nome from auth.users where id = $1",
    [userId],
  );
  return rows[0]?.nome ?? null;
}

/** A prévia da conversa enquanto a ligação está em andamento — em português, como todo `body` de registro. */
export function textoDoCartaoEmAndamento(quem: string | null): string {
  return `Ligação em andamento${quem ? ` com ${quem}` : ""}`;
}

/**
 * O CARTÃO "LIGAÇÃO EM ANDAMENTO" (fila visível, entrega 1). Chamado quando a
 * recebida é atendida — DEPOIS de `atribuirConversa`, que reabre a conversa
 * encerrada e abre o atendimento novo: o cartão tem de nascer dentro dele, e é
 * ele que dá posição à conversa na lista (`last_message_at`). O atendente passa
 * a ter onde escrever uma nota interna enquanto fala.
 *
 * É a MESMA mensagem que `registrarNaConversa` completa no fim (`ligacao:<id>`),
 * com `em_andamento: true` e `desfecho: "atendida"` — e não um desfecho novo: a
 * aba que não recarregou depois da atualização leria um desfecho desconhecido
 * como "não atendida" e mostraria "Ligação perdida" durante a ligação.
 *
 * Idempotente. A primeira chamada cria o cartão e leva a conversa ao time da
 * ligação (o atendimento é do time que a recebeu; quem já ligou antes guardava
 * o time do atendimento anterior). As seguintes — a transferência que passa a
 * ligação a outra pessoa — só trocam o nome de quem está com ela: se alguém
 * mudou o setor da conversa pela tela no meio da ligação, a escolha fica.
 *
 * `false` = nada a fazer: ligação de outra organização, feita, ainda não
 * atendida, sem conversa (número oculto) ou já encerrada.
 */
export async function abrirCartaoDaLigacao(db: Queryable, organizationId: string, id: string): Promise<boolean> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `select ${COLUNAS_DA_LIGACAO} from voice_calls
      where id = $1 and organization_id = $2 and provider = $3
        and direction = 'inbound' and status = 'connected'`,
    [id, organizationId, PROVIDER],
  );
  const l = rows[0];
  if (!l || !l.conversation_id || !l.contact_id || !l.owner_user_id) return false;
  const quem = await nomeDoAtendente(db, l.owner_user_id);
  const texto = textoDoCartaoEmAndamento(quem);
  const externalId = `ligacao:${l.id}`;

  const { rows: ja } = await db.query<{ em_andamento: string | null }>(
    "select metadata->'voice_call'->>'em_andamento' as em_andamento from messages where organization_id = $1 and external_id = $2 limit 1",
    [organizationId, externalId],
  );
  if (ja[0]) {
    if (ja[0].em_andamento !== "true") return false;
    await db.query(
      `update messages
          set body = $3,
              metadata = jsonb_set(metadata, '{voice_call}', (metadata->'voice_call') || $4::jsonb)
        where organization_id = $1 and external_id = $2
          and metadata->'voice_call'->>'em_andamento' = 'true'`,
      [organizationId, externalId, texto, JSON.stringify({ atendente_id: l.owner_user_id, atendente_nome: quem })],
    );
    await db.query(
      "update conversations set last_message_preview = left($3, 200), updated_at = now() where id = $1 and organization_id = $2",
      [l.conversation_id, organizationId, texto],
    );
    return true;
  }

  // Direto na coluna, como `registrarEscolhaDoMenu`: `fn_conversation_set_team` é
  // o gesto de uma pessoa (exige sessão e solta o dono). Só time ATIVO desta organização.
  if (l.team_id) {
    await db.query(
      `update conversations c set team_id = $3, updated_at = now()
        where c.id = $1 and c.organization_id = $2 and c.team_id is distinct from $3
          and exists (select 1 from attendance_teams t
                       where t.id = $3 and t.organization_id = $2 and t.archived_at is null)`,
      [l.conversation_id, organizationId, l.team_id],
    );
  }
  const menu = await menuDoRegistro(db, l);
  try {
    await db.query(
      `insert into messages
         (organization_id, conversation_id, contact_id, channel_session_id, external_id,
          direction, type, body, sent_via, status, metadata)
       values ($1, $2, $3, $4, $5, 'outbound', 'system', $6, 'system', 'sent', $7)`,
      [
        organizationId,
        l.conversation_id,
        l.contact_id,
        l.channel_session_id,
        externalId,
        texto,
        JSON.stringify({
          voice_call: {
            id: l.id,
            direcao: "inbound",
            desfecho: "atendida",
            em_andamento: true,
            duracao_ms: null,
            atendente_id: l.owner_user_id,
            atendente_nome: quem,
            motivo: null,
            menu,
            ouviu_aviso: Boolean(l.emergency_heard_at),
          },
        }),
      ],
    );
  } catch (e) {
    // A trava única é DEFERRABLE (ver `registrarNaConversa`): quem perdeu a corrida não tem o que fazer.
    if ((e as { code?: string }).code === "23505") return false;
    throw e;
  }
  await db.query(
    `update conversations
        set last_message_at = now(), last_message_preview = left($3, 200), updated_at = now()
      where id = $1 and organization_id = $2`,
    [l.conversation_id, organizationId, texto],
  );
  return true;
}
```

Em `registrarNaConversa`, trocar o corpo (mantendo o comentário de cabeçalho e acrescentando ao fim dele o parágrafo abaixo) por:

```ts
// (acrescentar ao comentário de cabeçalho)
// Fila visível, entrega 1: a recebida ATENDIDA já tem o cartão — `abrirCartaoDaLigacao`
// o criou "em andamento". Aqui ele é COMPLETADO, mesclando no banco (reações e
// gravação escrevem no mesmo `metadata`); o cartão já fechado não é reescrito.
export async function registrarNaConversa(
  db: Queryable,
  l: LigacaoDoBanco,
  desfecho: DesfechoDaLigacao,
  duracaoMs: number | null,
): Promise<void> {
  // A interna (v3) não tem conversa nem contato: não há onde registrar.
  if (!l.conversation_id || !l.contact_id || l.direction === "internal") return;
  const quem = await nomeDoAtendente(db, l.owner_user_id);
  const texto = textoDoRegistro({ direcao: l.direction, desfecho, duracaoMs, quem, motivo: l.end_reason ?? null });
  // Sem `on conflict`: a trava única de `(organization_id, external_id)` é
  // DEFERRABLE, e o Postgres recusa trava deferível como árbitro ("ON CONFLICT
  // does not support deferrable unique constraints") — medido na prova pela
  // tela, onde isso derrubava o fim da ligação inteiro. Conferir antes e tratar
  // o 23505 do reenvio cobre o mesmo caso.
  const externalId = `ligacao:${l.id}`;
  const { rows: ja } = await db.query<{ em_andamento: string | null }>(
    "select metadata->'voice_call'->>'em_andamento' as em_andamento from messages where organization_id = $1 and external_id = $2 limit 1",
    [l.organization_id, externalId],
  );
  const emAndamento = ja[0]?.em_andamento === "true";
  if (ja.length > 0 && !emAndamento) return;
  const menu = await menuDoRegistro(db, l);
  const transferencias = await transferenciasDoRegistro(db, l);
  const toqueMs = toqueDaSaidaSemResposta(l);
  const tentativaMs = tentativaDaSaidaSemResposta(l);
  const registro = {
    id: l.id,
    direcao: l.direction,
    desfecho,
    duracao_ms: duracaoMs,
    atendente_id: l.owner_user_id,
    atendente_nome: quem,
    motivo: l.end_reason ?? null,
    menu,
    ouviu_aviso: Boolean(l.emergency_heard_at),
    // Feita e não atendida: por quanto tempo o telefone do cliente chamou (0294). Ausente sem a medida.
    ...(toqueMs !== null ? { toque_ms: toqueMs } : {}),
    // E quanto durou a tentativa, do pedido ao fim — o que o cartão conta de quem desligou sem o toque.
    ...(tentativaMs !== null ? { tentativa_ms: tentativaMs } : {}),
    // A corrente de transferências (v2), com os nomes daquela hora. Ausente sem transferência.
    ...(transferencias.length > 0 ? { transferencias } : {}),
    // Gravada: o arquivo ainda vai ser guardado (lib/channels/telefonia/gravacoes.ts),
    // e é o processamento que troca a situação, sempre mesclando no banco.
    ...(l.recording_status === "recording" ? { gravacao: GRAVACAO_EM_PROCESSAMENTO } : {}),
  };
  if (emAndamento) {
    await db.query(
      `update messages
          set body = $3,
              metadata = jsonb_set(metadata, '{voice_call}', ((metadata->'voice_call') - 'em_andamento') || $4::jsonb)
        where organization_id = $1 and external_id = $2
          and metadata->'voice_call'->>'em_andamento' = 'true'`,
      [l.organization_id, externalId, texto, JSON.stringify(registro)],
    );
  } else {
    try {
      await db.query(
        `insert into messages
           (organization_id, conversation_id, contact_id, channel_session_id, external_id,
            direction, type, body, sent_via, status, metadata)
         values ($1, $2, $3, $4, $5, 'outbound', 'system', $6, 'system', 'sent', $7)`,
        [
          l.organization_id,
          l.conversation_id,
          l.contact_id,
          l.channel_session_id,
          externalId,
          texto,
          JSON.stringify({ voice_call: registro }),
        ],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return;
      throw e;
    }
  }
  await db.query(
    `update conversations
        set last_message_at = now(), last_message_preview = left($3, 200), updated_at = now()
      where id = $1 and organization_id = $2`,
    [l.conversation_id, l.organization_id, texto],
  );
}
```

Atenção: `direction` de `LigacaoDoBanco` é `"inbound" | "outbound" | "internal"`; depois do `return` da interna o TypeScript já estreita — se não estreitar, mantenha a forma do código original (`direcao: l.direction` dentro do objeto) e não introduza `as`.

Depois de `registrarFim` (antes da seção "ramais e ligação interna"), acrescentar:

```ts
// ─── o cartão que ficou "em andamento" (fila visível, entrega 1) ──────────

/**
 * Ligações do telefone já ENCERRADAS cujo cartão ficou "em andamento": a
 * ligação fechou no banco e a escrita do cartão falhou (o banco caiu entre uma
 * e outra). Varre a instalação inteira de propósito, como `ligacoesVivas` — e
 * cada conserto escreve na organização da PRÓPRIA linha. Parte de `voice_calls`
 * (pequena) e sonda `messages` pelo índice único de `(organization_id,
 * external_id)`: nunca varre `messages`. O minuto de folga deixa o fim normal
 * (`finalizar`) terminar antes; as 24 h limitam a sonda ao que ainda importa.
 */
export async function ligacoesComCartaoOrfao(db: Queryable, limite = 20): Promise<LigacaoDoBanco[]> {
  const { rows } = await db.query<LigacaoDoBanco>(
    `select ${COLUNAS_DA_LIGACAO} from voice_calls v
      where v.provider = $1 and v.status = 'ended' and v.direction = 'inbound' and v.answered_at is not null
        and v.ended_at > now() - interval '24 hours' and v.ended_at < now() - interval '1 minute'
        and exists (select 1 from messages m
                     where m.organization_id = v.organization_id
                       and m.external_id = 'ligacao:' || v.id::text
                       and m.metadata->'voice_call'->>'em_andamento' = 'true')
      order by v.ended_at
      limit $2`,
    [PROVIDER, limite],
  );
  return rows;
}

/** Fecha os cartões órfãos pelo caminho de sempre (`registrarNaConversa`). Devolve quantos achou. */
export async function consertarCartoesOrfaos(db: Queryable): Promise<number> {
  const orfas = await ligacoesComCartaoOrfao(db);
  for (const l of orfas) {
    const duracao =
      l.answered_at && l.ended_at
        ? Math.max(0, Math.round(new Date(l.ended_at).getTime() - new Date(l.answered_at).getTime()))
        : null;
    await registrarNaConversa(db, l, "atendida", duracao);
  }
  return orfas.length;
}
```

- [ ] **Step 4: caso unitário do texto**

Em `lib/channels/telefonia/repositorio.test.ts`, no molde dos casos de `textoDoRegistro` do arquivo, acrescentar (importando `textoDoCartaoEmAndamento`):

```ts
describe("textoDoCartaoEmAndamento", () => {
  it("diz com quem a ligação está; sem nome, só que está em andamento", () => {
    expect(textoDoCartaoEmAndamento("Ana")).toBe("Ligação em andamento com Ana");
    expect(textoDoCartaoEmAndamento(null)).toBe("Ligação em andamento");
  });
});
```

- [ ] **Step 5: rodar tudo desta task e ver passar**

Run: `pnpm test:db tests/invariants/telefonia-cartao-em-andamento.test.ts`
Expected: PASS em todos os casos.
Run: `pnpm exec vitest run lib/channels/telefonia/repositorio.test.ts`
Expected: PASS.
Run (regressão do SQL do registro, que mudou): `pnpm test:db tests/invariants/telefonia-primeiro-toque-da-saida.test.ts` e `pnpm test:db tests/invariants/telefonia-gravacao.test.ts`
Expected: PASS nos dois.
Run: `pnpm typecheck`
Expected: sem erro.

- [ ] **Step 6: sabotar para provar que o teste vigia**

Troque temporariamente, em `registrarNaConversa`, `((metadata->'voice_call') - 'em_andamento') || $4::jsonb` por `$4::jsonb`. Rode o invariante: o caso "o que outro escritor gravou continua" tem de FALHAR (`de_outro`). Desfaça a sabotagem e rode de novo: PASS. Registre no relatório da task a saída das duas rodadas.

- [ ] **Step 7: commit**

```bash
git add lib/channels/telefonia/repositorio.ts lib/channels/telefonia/repositorio.test.ts tests/invariants/telefonia-cartao-em-andamento.test.ts
git commit -m "feat(telefonia): o cartão da ligação nasce em andamento e é completado no fim"
```

---

### Task 2: o controlador abre o cartão ao atender e na transferência

**Files:**
- Modify: `lib/channels/telefonia/portas.ts` (interface `PortaBanco`, depois de `atribuirConversa`)
- Modify: `lib/channels/telefonia/laco.ts` (`portaBanco`, depois de `atribuirConversa`)
- Modify: `lib/channels/telefonia/dubles-de-teste.ts` (`BancoFalso`, depois de `atribuirConversa`)
- Modify: `lib/channels/telefonia/controle.ts` (`ramalAtendeu`, ~linha 1431)
- Modify: `lib/channels/telefonia/transferencia.ts` (~linha 668)
- Test: `lib/channels/telefonia/controle.test.ts`, `lib/channels/telefonia/transferencia.test.ts`

- [ ] **Step 1: o dublê e a porta**

`portas.ts`, na `PortaBanco`, logo depois de `atribuirConversa`:

```ts
  /**
   * O cartão "Ligação em andamento" na conversa (fila visível, entrega 1): cria
   * ao atender; chamado de novo, troca o nome de quem está com a ligação.
   * `false` = nada a fazer (sem conversa, feita, não atendida, já encerrada).
   */
  abrirCartaoDaLigacao(org: string, id: string): Promise<boolean>;
```

`laco.ts`, em `portaBanco`, depois de `atribuirConversa`:

```ts
    abrirCartaoDaLigacao: (org, id) => repo.abrirCartaoDaLigacao(pool, org, id),
```

`dubles-de-teste.ts`, em `BancoFalso`, depois de `atribuirConversa`:

```ts
  /** `abrirCartaoDaLigacao` lança (o banco caiu logo depois de a ligação ser atendida). */
  falharCartao = false;
  /** O cartão "em andamento": registra com QUEM a ligação está na hora da chamada. */
  abrirCartaoDaLigacao = async (org: string, id: string) => {
    if (!this.daOrg(org, id, "abrirCartaoDaLigacao")) return false;
    if (this.falharCartao) throw new Error("banco fora do ar");
    this.eventos.push(["cartao", id, this.ligacoes.get(id)!.owner_user_id]);
    return true;
  };
```

- [ ] **Step 2: os testes que falham**

Em `controle.test.ts`, um `describe` novo no fim do arquivo:

```ts
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
});
```

Para o número oculto: leia o caso `"número oculto (sem conversa): nem pergunta a política"` (~linha 1897) para ver como o arquivo monta a ligação sem bina, e acrescente ao `describe` novo um caso que usa a MESMA montagem, atende, e afirma `expect(banco.tem("cartao")).toEqual([])` e `expect(banco.tem("atendida")).toHaveLength(1)`.

Em `transferencia.test.ts`: ache o primeiro caso em que uma transferência DIRETA para uma pessoa é atendida (procure por `"transferencia"` com desfecho `"answered"` nos `expect`). Nesse caso, depois da afirmação do desfecho, acrescente:

```ts
    // Quem pegou a transferência entra no cartão em andamento (fila visível, entrega 1).
    expect(banco.tem("cartao").at(-1)).toEqual(["cartao", "vc-1", BIA]);
```

(Use o id da ligação e a pessoa que o caso realmente usa — confira no próprio caso.)

- [ ] **Step 3: rodar e ver falhar**

Run: `pnpm exec vitest run lib/channels/telefonia/controle.test.ts lib/channels/telefonia/transferencia.test.ts`
Expected: FAIL nos casos novos (nenhum evento `cartao`).

- [ ] **Step 4: implementar**

`controle.ts`, em `ramalAtendeu`, trocar o bloco `if (l.conversationId) { … }` por:

```ts
    if (l.conversationId) {
      await this.banco.atribuirConversa(l.org, l.conversationId, l.atendidaPor).catch((e) =>
        this.log.warn("telefonia: conversa não atribuída a quem atendeu", { erro: String(e) }),
      );
      // O cartão "Ligação em andamento" (fila visível, entrega 1) — DEPOIS da
      // atribuição: é ela que reabre a conversa encerrada e abre o atendimento
      // novo, e o cartão tem de nascer dentro dele. Não abrir o cartão não pode
      // derrubar a ligação: o fim o insere, como sempre.
      await this.banco.abrirCartaoDaLigacao(l.org, vcId).catch((e) =>
        this.log.warn("telefonia: cartão da ligação em andamento não aberto — o fim o registra", {
          voice_call: vcId,
          erro: mensagemDe(e, 160),
        }),
      );
    }
```

`transferencia.ts`, dentro do `if (v.conversationId) { … }` que vem depois de `passarLigacao`, logo depois do `atribuirConversa(…, "transfer")`:

```ts
      // Quem pegou a transferência entra no cartão em andamento (fila visível, entrega 1).
      await this.d.banco
        .abrirCartaoDaLigacao(em.org, em.vcId)
        .catch((e) => this.d.log.warn("telefonia: cartão da ligação não atualizado na transferência", { erro: mensagemDe(e) }));
```

- [ ] **Step 5: rodar e ver passar**

Run: `pnpm exec vitest run lib/channels/telefonia`
Expected: PASS em todos os arquivos da pasta (o `afterEach` de `controle.test.ts` reprova `log.error` e `org_errada`).
Run: `pnpm typecheck`
Expected: sem erro.

- [ ] **Step 6: commit**

```bash
git add lib/channels/telefonia/portas.ts lib/channels/telefonia/laco.ts lib/channels/telefonia/dubles-de-teste.ts lib/channels/telefonia/controle.ts lib/channels/telefonia/transferencia.ts lib/channels/telefonia/controle.test.ts lib/channels/telefonia/transferencia.test.ts
git commit -m "feat(telefonia): a ligação atendida abre o cartão em andamento na conversa"
```

---

### Task 3: a passada de 60 s fecha o cartão órfão

**Files:**
- Modify: `lib/channels/telefonia/laco.ts` (`DependenciasDaPassada`, `passadaDoTelefone`, a chamada em `runTelefoniaLoop` ~linha 295)
- Test: `lib/channels/telefonia/laco.test.ts` (`describe("passadaDoTelefone — …")`, ~linha 212)

- [ ] **Step 1: os testes que falham**

Leia o `describe("passadaDoTelefone — as três etapas de 60 s")` para ver os helpers (`falasFalsas()`, o `log` do arquivo). Acrescente dentro dele:

```ts
  it("fecha os cartões de ligação que ficaram em andamento, e diz quantos", async () => {
    const consertar = vi.fn(async () => 2);
    await passadaDoTelefone({ falas: falasFalsas(), desligarAvisosVencidos: async () => [], consertarCartoes: consertar, log })();
    expect(consertar).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "telefonia: cartão de ligação em andamento fechado pela passada",
      { cartoes: 2 },
    );
  });

  it("sem cartão órfão a passada não escreve nada; e a etapa que lança não derruba as outras", async () => {
    const falas = falasFalsas();
    await passadaDoTelefone({ falas, desligarAvisosVencidos: async () => [], consertarCartoes: async () => 0, log })();
    expect(log.info).not.toHaveBeenCalled();
    await passadaDoTelefone({
      falas,
      desligarAvisosVencidos: async () => [],
      consertarCartoes: async () => {
        throw new Error("banco fora do ar");
      },
      log,
    })();
    expect(falas.sincronizar).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
```

Ajuste os nomes ao que o arquivo realmente usa (se `falasFalsas()` não devolve `vi.fn`, afirme pelo contador que o arquivo já usa nos casos vizinhos; se o `log` do arquivo não é zerado entre casos, zere no começo do caso).

- [ ] **Step 2: rodar e ver falhar**

Run: `pnpm exec vitest run lib/channels/telefonia/laco.test.ts`
Expected: FAIL — `consertarCartoes` não existe no tipo e não é chamado.

- [ ] **Step 3: implementar**

`laco.ts`, em `DependenciasDaPassada`, depois de `desligarAvisosVencidos`:

```ts
  /**
   * `repo.consertarCartoesOrfaos` com o pool do worker: fecha o cartão "em
   * andamento" de ligação já encerrada (fila visível, entrega 1). Ausente = nada a fazer.
   */
  consertarCartoes?: () => Promise<number>;
```

Em `passadaDoTelefone`, depois da declaração de `gravacoes`:

```ts
  // O cartão "em andamento" de ligação que já acabou: o fim fechou a ligação no
  // banco e não conseguiu completar o cartão. Sem isto ele diria "em andamento" para sempre.
  const cartoes = semReentrancia(() =>
    etapa("cartões de ligação em andamento", async () => {
      const consertar = d.consertarCartoes;
      if (!consertar) return;
      const n = await consertar();
      if (n > 0) d.log.info("telefonia: cartão de ligação em andamento fechado pela passada", { cartoes: n });
    }),
  );
```

e trocar a última linha da função devolvida por:

```ts
    await Promise.all([avisos(), storage(), gravacoes(), cartoes()]);
```

Atualize o comentário de cabeçalho da passada (ele enumera as etapas) para citar a etapa nova. Em `runTelefoniaLoop`, na chamada `passadaDoTelefone({ … })`, acrescentar:

```ts
    consertarCartoes: () => repo.consertarCartoesOrfaos(opts.pool),
```

Se o título do `describe` diz "as três etapas", troque para "as etapas de 60 s".

- [ ] **Step 4: rodar e ver passar**

Run: `pnpm exec vitest run lib/channels/telefonia/laco.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: sem erro.

- [ ] **Step 5: commit**

```bash
git add lib/channels/telefonia/laco.ts lib/channels/telefonia/laco.test.ts
git commit -m "feat(telefonia): a passada de 60 s fecha o cartão que ficou em andamento"
```

---

### Task 4: a tela mostra "Ligação em andamento"

**Files:**
- Modify: `components/telefonia/CartaoDaLigacao.tsx`
- Modify: `components/telefonia/CartaoDaLigacao.test.tsx`
- Modify: `lib/i18n/dicionario.ts` (só se faltar chave)

- [ ] **Step 1: os testes que falham**

Leia o topo de `CartaoDaLigacao.test.tsx` (os helpers `registro(…)`/`desenhar(…)` e a constante `EM`). Acrescente um `describe`:

```ts
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
```

Se os casos vizinhos embrulham o cartão num provider (um helper `embrulho(…)`), use o mesmo embrulho.

- [ ] **Step 2: rodar e ver falhar**

Run: `pnpm exec vitest run components/telefonia/CartaoDaLigacao.test.tsx`
Expected: FAIL (`data-ligacao` = `atendida`; `em_andamento` indefinido).

- [ ] **Step 3: implementar**

Em `CartaoDaLigacao.tsx`:

1. No comentário de cabeçalho, acrescentar um parágrafo:

```
 * Em andamento (fila visível, entrega 1): o worker cria o registro quando a
 * recebida é ATENDIDA, com `em_andamento: true`, e o completa no fim. Enquanto
 * a marca está lá, o cartão diz com quem a ligação está e desde quando — e o
 * atendente tem a conversa aberta para anotar. O `desfecho` desse registro já
 * é "atendida": a aba que não recarregou mostra "Ligação recebida", nunca "perdida".
```

2. Em `MetadadoDaLigacao`, depois de `duracao_ms`:

```ts
  /** A ligação ainda está acontecendo: o registro foi criado ao atender e será completado no fim. */
  em_andamento?: boolean;
```

3. Em `ligacaoDaMensagem`, no objeto devolvido, depois do spread:

```ts
    em_andamento: v.em_andamento === true,
```

4. Em `CartaoDaLigacao`, depois de `const atendida = …`:

```ts
  const emAndamento = ligacao.em_andamento === true;
```

trocar a definição de `titulo` para começar por `emAndamento ? t("Ligação em andamento") : recebida ? …` (o resto da cascata igual); `const Icone = emAndamento ? PhoneIncoming : !atendida ? PhoneX : recebida ? PhoneIncoming : PhoneOutgoing;`; `const tempo = emAndamento ? null : duracao(ligacao.duracao_ms);`.

No JSX: `data-ligacao={emAndamento ? "em_andamento" : ligacao.desfecho}`; a classe da pílula passa a ser

```tsx
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
          emAndamento
            ? "border-primary/30 bg-primary/5 text-foreground"
            : atendida
              ? "border-border bg-muted/50 text-foreground"
              : "border-destructive/30 bg-destructive/5 text-destructive"
        }`}
```

o trecho do nome passa a ser

```tsx
        {emAndamento ? (
          ligacao.atendente_nome ? (
            <span className="text-muted-foreground">
              · {t("com")} {ligacao.atendente_nome}
            </span>
          ) : null
        ) : ligacao.atendente_nome && (atendida || !recebida) ? (
          <span className="text-muted-foreground">
            · {recebida ? t("atendida por") : t("por")} {ligacao.atendente_nome}
          </span>
        ) : null}
```

e a hora:

```tsx
        <span className="tabular-nums text-muted-foreground">
          · {emAndamento ? `${t("desde")} ${hora}` : hora}
        </span>
```

5. `lib/i18n/dicionario.ts`: `"Ligação em andamento"` e `"com"` já existem. Confira `"desde"` com `grep -n '"desde":' lib/i18n/dicionario.ts`; se faltar, acrescente perto das chaves do cartão da ligação (linha do comentário "Telefonia, fase 2 — o cartão da ligação"):

```ts
  "desde": { es: "desde" },
```

- [ ] **Step 4: rodar e ver passar**

Run: `pnpm exec vitest run components/telefonia/CartaoDaLigacao.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/traducao-nao-defasa.test.ts`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint`
Expected: sem erro.

- [ ] **Step 5: commit**

```bash
git add components/telefonia/CartaoDaLigacao.tsx components/telefonia/CartaoDaLigacao.test.tsx lib/i18n/dicionario.ts
git commit -m "feat(telefonia): o cartão da conversa mostra a ligação em andamento"
```

---

### Task 5: a prova pela tela (e2e semeado, roda no GitHub Actions)

**Files:**
- Modify: `tests/e2e/telefonia-gravacao.spec.ts`

- [ ] **Step 1: escrever o caso**

Leia a spec inteira: ela semeia `voice_calls` e a mensagem `ligacao:<id>` por SQL (`sql(…)`), cria usuários e entra pela tela (`entrar(page, …)`). Acrescente um `test` no mesmo `describe`, no molde do caso `"a ligação feita que ninguém atendeu diz quem ligou, quanto chamou e quem encerrou"`:

- semeie uma ligação recebida `connected` com dono (o atendente da spec), numa conversa de telefone dele, e a mensagem `ligacao:<id>` com `metadata.voice_call = { id, direcao: "inbound", desfecho: "atendida", em_andamento: true, duracao_ms: null, atendente_nome }`, e `last_message_at = now()` na conversa;
- entre como o atendente, abra a conversa e afirme: `[data-ligacao="em_andamento"]` visível, com o texto "Ligação em andamento" e o nome do atendente;
- escreva uma NOTA INTERNA pela tela (do jeito que a spec `tests/e2e` de notas faz — procure por "nota interna" em `tests/e2e/` e reuse os seletores) e afirme que ela aparece na conversa, abaixo do cartão;
- SEM recarregar a página, feche o cartão por SQL (o mesmo `update` que `registrarNaConversa` faz: tirar `em_andamento`, pôr `duracao_ms: 65000`) e afirme com `expect(...).toBeVisible({ timeout: 20_000 })` que `[data-ligacao="atendida"]` aparece com "Ligação recebida" e que `[data-ligacao="em_andamento"]` sumiu;
- a nota continua lá.

Nome do caso: `"a ligação atendida aparece na conversa enquanto acontece, aceita nota interna, e vira 'Ligação recebida' no fim sem recarregar"`.

- [ ] **Step 2: conferir o que dá para conferir sem rodar**

Run: `pnpm typecheck && pnpm lint`
Expected: sem erro. (A spec roda no GitHub Actions, na Task 7.)

- [ ] **Step 3: commit**

```bash
git add tests/e2e/telefonia-gravacao.spec.ts
git commit -m "test(e2e): a ligação em andamento aparece na conversa e aceita nota interna"
```

---

### Task 6: documentação, mapa e fragmento

**Files:**
- Create: `.changes/telefonia-conversa-viva-ao-atender.md`
- Modify: `docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md` (§4.1 e D3: as três emendas do topo deste plano)
- Modify: `docs/specs/20-spec-telefonia-sip.md`, `docs/current-state.md`, `docs/architecture/telefonia.architecture.json`, `docs/testing/user-journey-map.md`

- [ ] **Step 1: o fragmento**

```md
---
impacto: capacidade_nova
secao: adicionado
titulo: Telefone — a conversa aparece enquanto a ligação acontece
---

Quando o atendente atendia uma ligação, a conversa do cliente só ganhava o registro da ligação
depois de desligar — durante a chamada não havia onde anotar. Agora, no instante em que ele
atende, a conversa sobe para o topo de Minhas com o cartão "Ligação em andamento · com Ana ·
desde 14:32" e um atendimento aberto: dá para escrever nota interna enquanto fala. Quando a
ligação acaba, o mesmo cartão vira "Ligação recebida", com a duração e a gravação.

A conversa de quem já tinha ligado antes passa para o time que recebeu esta ligação.

A ligação que ninguém atende continua como era: o registro entra no fim, com o aviso de
"Ligar de volta" na Central. Nada muda nas ligações feitas.

Nada a fazer na atualização. Quem estiver com o CRM aberto precisa recarregar a página para
ver o cartão novo; até lá, a ligação em curso aparece como "Ligação recebida".
```

Run: `pnpm release:conferir`
Expected: aceita o fragmento e calcula a próxima versão (minor).

- [ ] **Step 2: o desenho**

No desenho, em D3 e §4.1: trocar `desfecho = "em_andamento"` por `em_andamento: true` com `desfecho: "atendida"`, e "Ao entrar na fila do time, a conversa passa para o time da fila" por "Ao atender, na criação do cartão, a conversa passa para o time da ligação" — com o porquê de cada uma (as "Decisões de implementação" deste plano).

- [ ] **Step 3: spec 20, estado atual, mapa e jornada**

- `docs/specs/20-spec-telefonia-sip.md`: na seção que descreve o registro da ligação na conversa (§2.4 — procure por "registro" e "cartão"), acrescentar o parágrafo do cartão em andamento (quando nasce, quando é completado, o órfão e a passada).
- `docs/current-state.md`: na linha da Telefonia SIP, acrescentar a frase da entrega, com o que NÃO foi provado (ligação real).
- `docs/architecture/telefonia.architecture.json`: no rótulo do nó `repositorio` (e do nó da tela que desenha o cartão, se existir), citar o cartão em andamento; acrescentar a aresta `controle → repositorio` com rótulo "abre o cartão ao atender" se as arestas tiverem rótulo. Depois: `pnpm exec vitest run tests/unit/mapas-de-arquitetura.test.ts` → PASS.
- `docs/testing/user-journey-map.md`: jornada nova `## J43 — A conversa aparece enquanto a ligação acontece `[P0]` (2026-10-06)`, no molde da J42 (casos: atende → cartão; nota durante a ligação; fim completa; quem já ligou antes ganha atendimento novo; perdida igual; órfão fechado pela passada; **não provado: ligação real pelo tronco**). Confira antes que 43 é o próximo número livre (`grep -n "^## J[0-9]" docs/testing/user-journey-map.md | tail -3`) e rode `pnpm exec vitest run tests/unit -t "jornada"` se houver teste de número único.

- [ ] **Step 4: commit**

```bash
git add .changes docs
git commit -m "docs(telefonia): a conversa viva ao atender entra na spec, no mapa, no estado atual e na jornada"
```

---

### Task 7: verificação completa, revisão independente e PR

- [ ] **Step 1: a suíte inteira, com o log guardado**

```bash
source ~/.nvm/nvm.sh && nvm use 22.23.2
pnpm typecheck && pnpm lint
pnpm test:unit > /tmp/vt-entrega1.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |^ *Errors " /tmp/vt-entrega1.log | tail -3
grep -aE "^ *FAIL " /tmp/vt-entrega1.log | sed 's/ > .*//' | sort | uniq -c
```

Expected: `exit=0`. Vermelho que também é vermelho na `origin/main` limpa nesta máquina (ver a memória "vermelhos locais") é declarado no PR como artefato local, não consertado.

- [ ] **Step 2: os invariantes desta entrega e os vizinhos**

Run: `pnpm test:db tests/invariants/telefonia-cartao-em-andamento.test.ts tests/invariants/telefonia-primeiro-toque-da-saida.test.ts tests/invariants/telefonia-gravacao.test.ts tests/invariants/telefonia-repositorio-da-transferencia.test.ts`
Expected: PASS.

- [ ] **Step 3: revisão independente** (subagente sem o contexto desta sessão, com o diff e o desenho) — corrigir o que ela achar, com teste que falha antes.

- [ ] **Step 4: push, e2e no Actions e PR**

```bash
git push -u origin claude/phone-queue-visibility-0c7367
gh workflow run e2e.yml --ref claude/phone-queue-visibility-0c7367
gh pr create --title "feat(telefonia): a conversa aparece enquanto a ligação acontece" --body-file <arquivo com o corpo>
```

O corpo do PR diz: o que muda, as três emendas ao desenho, o que foi medido (com as saídas) e o **NÃO MEDIDO** (ligação real pelo tronco; a imagem da tela). Os quatro checks obrigatórios (`verify`, `build-and-size`, `invariants`, `imagens-ok`) têm de ficar verdes; o e2e é comparado com o último da `main`.
