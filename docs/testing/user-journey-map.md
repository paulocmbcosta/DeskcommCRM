# Mapa de Jornadas & Testes E2E — Experiência do usuário em VPS fresca

> Fonte da verdade do QA de produto do DeskcommCRM open-source. Cada caso aqui é
> exercitado **pelo frontend real** (Playwright), com contas de teste reais e
> recursos reais (banco fresco do `baseline.sql`, WAHA local, receiver de webhook
> real). Curl/API só como diagnóstico, nunca como prova de UX.
>
> Persona: **usuário leigo** que rodou o `install.sh` numa VPS e abriu o navegador.
> Ambiente de referência: banco 100% zerado + `bootstrap-owner.ts` (o que o kit faz).

## Convenções

- `[P0]` primeira impressão — bug aqui é vergonha pública; prioridade máxima.
- `[P1]` rotina diária do operador/atendente.
- `[P2]` exploração/edge.
- Resultado: `PASS` / `FAIL(bug#)` / `WARN` (funciona mas UX ruim).
- Evidência: screenshot/trace em `.superpowers/evidence/vps-qa/`.

---

## J1 — Onboarding do primeiro usuário `[P0]`

Contexto do código: primeiro usuário nasce do `scripts/bootstrap-owner.ts`
(install.sh); quem é convidado e ainda não tem conta entra por `/signup?invite=`.
Wizard: welcome → whatsapp → (nuvemshop se `NUVEMSHOP_ENABLED`) → setup-ai →
**testar** → invite-team → done. A ordem, os rótulos e o resumo final saem de uma
fonte só (`lib/onboarding/passos.ts`) — eram três listas que discordavam. Gate:
`organizations.onboarded_at`. MFA obrigatório pra admin logo após o wizard.

| # | Caso | Expectativa |
|---|------|-------------|
| J1.1 | Login com credenciais do bootstrap | entra e é redirecionado pro `/onboarding` (org sem `onboarded_at`) |
| J1.2 | Login com senha errada | mensagem clara "Email ou senha incorretos", sem stack |
| J1.3 | Welcome: termos não aceitos | botão avança desabilitado |
| J1.4 | Welcome: nome da org + timezone salvos | grava `display_name`/`timezone`, avança pro WhatsApp |
| J1.5 | Connect WhatsApp: WAHA ativo → QR aparece | sessão criada, QR renderiza via proxy, poll de status roda |
| J1.6 | Connect WhatsApp: "Pular por enquanto" | avança pro step correto (setup-ai quando Nuvemshop off) |
| J1.7 | Setup IA: criar agente default | `ai_agents` criado **e a versão publicada aponta para o provedor que a instalação escolheu**, com o modelo curado DAQUELE provedor; avança |
| J1.8 | Invite team: enviar convite SEM Resend configurado (realidade da VPS fresca) | UI **não mente**: mostra que email não saiu + oferece `accept_url` copiável |
| J1.9 | Done: "Ir para o Inbox" | seta `onboarded_at`, cai no `/app/inbox` |
| J1.10 | Gate MFA pós-onboarding | blocker aparece; enrolar TOTP + ver/salvar recovery codes funciona de ponta a ponta |
| J1.11 | Abandonar no meio e voltar (fecha browser no step 3) | retoma exatamente no step pendente |
| J1.12 | Tentar `/app/inbox` antes de concluir | redirect pro onboarding, sem loop |
| J1.13 | Reabrir `/onboarding` depois de concluído | redirect pro app (wizard não reabre) |
| J1.14 | Stepper com Nuvemshop desabilitado | numeração/etapas não quebram visualmente |
| J1.15 | Setup IA: erro de banco ao listar os números (a publicação não pode ser decidida) | UI **não mente**: agente criado como rascunho, causa técnica na tela e saída pro próximo passo; clicar de novo NÃO cria um 2º agente · **PASS** (`tests/unit/onboarding-agente-nao-publicado.test.ts`, `tests/unit/onboarding-setup-ai-aviso.test.tsx`) |
| J1.16 | Instalação escolheu OpenRouter (opção [1] do instalador) | o agente publicado usa `openrouter`, nunca `anthropic` — o provider da versão vence o da organização em runtime, então publicar o provedor errado entrega um "Publicado" que morre em toda mensagem · **PASS** (`tests/unit/onboarding-agente-nao-publicado.test.ts`) |
| J1.17 | Instalação em provedor cujo catálogo ainda não sincronizou (estado real de uma VPS nova: o baseline semeia ZERO modelos OpenRouter) | não publica e **diz a causa certa**: rascunho por falta de modelo, sem acusar o WhatsApp; oferece saída pro próximo passo · **PASS** (`tests/unit/onboarding-agente-nao-publicado.test.ts`, `tests/unit/onboarding-setup-ai-aviso.test.tsx`) |
| J1.18 | Não dá para ler qual provedor a instalação escolheu (erro no `select` de `organizations`) | não publica com chute — publicar "anthropic" quando não se sabe é o defeito de origem em roupa nova · **PASS** (`tests/unit/onboarding-agente-nao-publicado.test.ts`) |
| J1.19 | O agente entregue consegue mexer no CRM | nasce com as capacidades do pacote "Vender e mover o funil" ligadas e o funil de entrada no escopo — antes vinha com `tool_ids` e `pipeline_ids` vazios, isto é: conversava e não criava lead nem movia card · **PASS** (`tests/unit/onboarding-agente-nao-publicado.test.ts`, `tests/unit/capacidades-padrao-do-onboarding.test.ts`) |
| J1.20 | O escopo de funil chega ao turno REAL (agent-engine) | a ponte que monta as ferramentas do turno passa `pipeline_ids`; sem isso o campo era decorativo e toda escrita de lead era recusada, com a capacidade ligada na tela · **PASS** (`tests/unit/ponte-do-agente-passa-o-escopo.test.ts`) |

| J1.22 | Convidado que **ainda não tem conta** | a tela de aceite oferece "Ainda não tenho conta", o signup recebe o convite, não pede nome de empresa e trava o e-mail; ao confirmar, a pessoa vai para o aceite em vez de ganhar uma organização própria — antes ela virava **admin de uma empresa fantasma**, com wizard alheio e MFA de administrador · **PASS** (`lib/auth/convite-no-signup.test.ts`, `tests/e2e/invite-lifecycle.spec.ts` casos 10–12) |
| J1.23 | Convite expirado ou emitido para outro e-mail, no signup | falha FECHADA: não provisiona organização nenhuma e explica no login. Cair no provisionamento aqui devolveria o defeito de J1.22 para quem demorasse entre criar a conta e confirmar o e-mail · **PASS** (`lib/auth/convite-no-signup.test.ts`) |

| J1.24 | Ver o funcionário atender antes de terminar | passo novo entre treinar e chamar o time: ensaio com o runtime real (`is_dry_run`), nada enviado pelo WhatsApp. Trata os três estados — sem agente, agente em rascunho, e o caso normal — e o erro aparece aqui, não com o primeiro cliente de verdade · **PASS** (`tests/e2e/vps-fresh-onboarding.spec.ts`, `lib/onboarding/passos.test.ts`) |
| J1.25 | O passo 1 mostra o que a instalação já trouxe | provedor contratado, WhatsApp pronto, funil criado — cada linha MEDIDA. E o campo de nome vem vazio quando a organização ainda está com o "Minha Empresa" do instalador, em vez de obrigar a pessoa a apagá-lo · **PASS** (`lib/instalacao/ambiente.test.ts`) |
| J1.26 | O quadro de clientes deixa de nascer de e-commerce | passo novo entre treinar e ver ele atender. `trg_seed_default_pipeline_for_org` semeia "Carrinho abandonado / Em separação / Enviado" em TODA organização, e a clínica abria o quadro dela e lia isso. A sugestão sai do MESMO modelo que vai atender — se ela falha, o dono descobre agora e não com o primeiro cliente · **PASS** (`tests/e2e/wizard-do-funcionario.spec.ts`, `lib/onboarding/proposta-de-funil.test.ts`) |
| J1.27 | O quadro **ensina o funcionário a percorrê-lo** | MEDIDO em 2026-08-13: **312 etapas em 43 funis, 4 com `agent_stage_hint`** — e as 4 de organizações de teste. Toda instalação real nascia com `coberturaDoFunil()` devolvendo `mudo: true`: o assistente tinha o funil no escopo (J1.20) e não sabia o que significava nenhuma coluna. Aqui uma coluna é NOME + DESTINO indissociáveis · **PASS** (`tests/invariants/quadro-do-onboarding.test.ts`, 7 casos contra o Postgres do baseline) |
| J1.28 | Sem chave de IA, o passo ainda entrega quadro | falha ABERTA na informação, FECHADA na ação: seis quadros prontos por ramo, escolhidos pelo que o dono escreveu no passo 1, e a tela DIZ que a sugestão não veio. Devolver erro deixaria a pessoa com o funil de e-commerce, que é o defeito que o passo existe para consertar · **PASS** (`lib/onboarding/sugerir-funil.test.ts`, `tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.29 | O passo 1 pergunta **o que o negócio faz** | era o dado que faltava no produto inteiro: sem ele os três modelos de prompt diziam "loja online" e o quadro nascia de e-commerce — os dois defeitos vinham da mesma origem, uma instalação que nunca pergunta em que ramo entrou · **PASS** (`tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.30 | Sem chave da IA, o passo de treinar PEDE a chave | o passo 1 media e escrevia "Falta a chave da inteligência artificial" — diagnóstico certo, saída nenhuma: a pessoa teria de descobrir sozinha que existe uma tela de credenciais, e onde. Agora ela cola a chave no passo em que a chave passa a importar, um clique antes de o funcionário nascer com ela · **PASS** (`tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.31 | A chave é testada com uma GERAÇÃO, não com uma listagem | "Validada" nunca significou "funciona": o validador bate em `GET /v1/models`, que responde 200 com a conta zerada. `provarSaldo` existia e **nenhuma tela a chamava** (evento sem consumer, anti-pattern nº 3 do CLAUDE.md). Agora o passo de treinar confere e diz o resultado — e distingue "sem crédito" de "não consegui conferir", que pedem conselhos opostos · **PASS** (`lib/instalacao/prova-de-credito.test.ts`, `tests/e2e/wizard-do-funcionario.spec.ts`) |
| J1.32 | A janela entre cadastrar a chave e ela ser confirmada | MEDIDO percorrendo o wizard: quem colava a chave lia "Não consegui testar o crédito" e "Falta a chave da inteligência artificial" no mesmo segundo — as duas frases mandam cadastrar de novo o que já está lá. A validação roda em SEGUNDO PLANO, então a janela existe sempre; o retrato passou a distinguir confirmada de em-verificação, e a tela espera em vez de acusar · **PASS** (`lib/instalacao/retrato.test.ts` — o arquivo não tinha teste nenhum antes) |
| J1.33 | A verificação em duas etapas deixa de ser imposta | MEDIDO percorrendo o wizard: "Começar a usar" entregava o dono num bloqueador de tela cheia pedindo um aplicativo autenticador — um sétimo passo que a barra de progresso nunca anunciou, e que TODA instalação self-host recebia, porque o `install.sh` cria o dono como platform admin. Agora é escolha: `platform_admins.mfa_required` (que existia e **nunca era lido** — controle decorativo) e `organizations.settings.security.mfa_required`, ambos com padrão não-exigir · **PASS** (`tests/e2e/mfa-opcional.spec.ts`, `lib/auth/politica-mfa.test.ts`) |
| J1.34 | Ligar e desligar a verificação, pela tela | o único ponto de cadastro do produto era o próprio bloqueador — sem um botão em Configurações › Segurança, tornar o cadastro opcional deixaria a proteção INALCANÇÁVEL. E desligar não existia em lugar nenhum: `enrollMfa` só apaga fator não verificado. Desligar o próprio fator exige sessão `aal2`, senão uma sessão roubada desliga a proteção com um clique · **PASS** (`tests/e2e/mfa-opcional.spec.ts`) |
| J1.35 | Cadastrar e PROVAR são perguntas diferentes | `mfaEmDivida()` começava consultando a política, então quem ativasse a verificação por vontade própria teria o fator ignorado na sessão — o mesmo que não ter. Com o cadastro opcional isso viraria o buraco central da mudança. Agora quem TEM fator prova, sempre, qualquer que seja o papel · **PASS** (`tests/unit/require-role-mfa.test.ts` — o caso do manager INVERTEU, e a inversão aperta) |

> **Cobertura em camadas (J1.22/J1.23):** a decisão de *não provisionar* é provada por unitário, porque é uma função pura e roda no gate obrigatório. O caso de tela cobre o caminho visível (CTA → signup com o token → campos certos). O que **não** está coberto ponta a ponta é a volta do link de confirmação de e-mail: exigiria caixa de e-mail no e2e, e a spec que faria isso é a de instalação fresca, que está fora do CI.

> **A jornada J1 passou a ter GATE.** `tests/e2e/wizard-do-funcionario.spec.ts` roda no CI (SPECS_PARTE_1) e cobre o wizard inteiro pela tela — do login ao "Começar a usar" — criando a PRÓPRIA organização, porque o seed compartilhado entrega uma já onboardada e zerá-la mandaria as specs seguintes para dentro do onboarding. Fica de fora só o ensaio com resposta real, que exige chave de IA com saldo. `vps-fresh-onboarding.spec.ts` continua fora do gate (depende de WAHA, Redis, Resend e Nuvemshop) e segue sendo a prova mais completa, para rodar à mão.

> **Achado ABERTO (não é regressão, é primeira impressão):** percorrendo o wizard inteiro num tenant fresco, o botão "Começar a usar" entrega o dono no Inbox e a PRIMEIRA coisa que ele vê é um modal bloqueante de verificação em duas etapas — um sétimo passo que a barra de progresso do wizard nunca anunciou. O MFA obrigatório para `admin` é decisão de produto e está correto; o que está errado é ele aparecer como surpresa depois de seis passos que se apresentaram como o caminho completo. Conserto natural: virar passo do wizard, ou ao menos ser anunciado na tela final. Fora do escopo da frente do quadro de clientes.

> **J1.21 — FECHADA.** O agente do onboarding nascia `kind='rag_bot'` (o default do banco, de quando o produto só tinha o formato antigo), abria no editor legado — Temperature, Top K, Similarity threshold — e as capacidades que ele recebia ligadas ficavam **invisíveis** para o dono: funcionavam no runtime e não tinham superfície de configuração, que é o invariante 6 do Sistema Vivo quebrado.
>
> O que travava a virada era o editor novo exigir `credential_id`, enquanto instalação pelo kit funciona com a chave de plataforma do `.env` e não tem nenhuma linha em `ai_provider_credentials` — o dono cairia numa tela onde não consegue salvar nada. Resolvido nas duas pontas: `versionShapeSchema` aceita `credential_id: null` (= a chave da instalação), o seletor oferece essa opção, e a rota de versões **recusa** o nulo quando o ambiente não tem chave daquele provedor (falha fechada — senão publicaria um agente que morre em toda mensagem).
>
> MEDIDO na tela, num tenant fresco: o funcionário criado no wizard abre no editor atual, com "Chave de acesso: A chave desta instalação (anthropic)", o pacote "Vender e mover o funil" ativo, e a contagem de capacidades que ele traz. (O número saiu daqui: já dizia 12 quando eram 16, e o teto foi de 20 para 25. Para o valor de hoje: `pnpm exec tsx -e 'import("@/lib/ai/agents/capacidades-padrao").then(m => console.log(m.capacidadesPadraoDoOnboarding().length))'`.)

## J2 — Conectar WhatsApp e Central de Conexões `[P0]`

| # | Caso | Expectativa |
|---|------|-------------|
| J2.1 | Central lista a sessão criada no onboarding | card com status coerente |
| J2.2 | Conectar novo WhatsApp (admin) | sessão STARTING → SCAN_QR, QR visível no dialog |
| J2.3 | QR escaneado com celular real (**precisa do Rafael**) | status WORKING, card "Conectado" |
| J2.4 | Reconectar sessão | volta a SCAN_QR/WORKING sem duplicar sessão |
| J2.5 | WAHA derrubado (docker stop) | banner claro, botões desabilitados, 503 amigável |
| J2.6 | Atendente (role agent) não vê botão de conectar | gate admin respeitado na UI |
| J2.7 | AntiBanSheet: editar ritmo/janela/teto | salva, persiste em `channel_knobs`, validação de janela |

## J3 — Agentes de IA `[P0]` (criação) / `[P1]` (rotina)

| # | Caso | Expectativa |
|---|------|-------------|
| J3.1 | Agente default do onboarding aparece em `/app/ai/agents` | lista consistente |
| J3.2 | Criar agente novo pelo builder: draft → publicar | bloqueios de publish EXPLICADOS (credencial, número) |
| J3.3 | Knowledge sources: 4 slots visíveis, status honesto | sem "Em breve" enganoso no caminho principal |
| J3.4 | Mensagem inbound → bot responde (WAHA + AI key real) | resposta chega na conversa, `sent_via='bot'` |
| J3.5 | Bot NÃO responde quando humano assumiu (claim) | guard `assignee_kind='user'` |
| J3.6 | Handoff G1 ("quero falar com humano") | conversa vai pra fila humana, aviso visível |
| J3.7 | AI Gateway key ausente | feedback visível (hoje: skip silencioso — candidato a bug de UX) |
| J3.8 | Central de avisos do agente (sino) | eventos aparecem com copy leiga |
| J3.9 | Propostas do flywheel: aplicar bullet | nova versão publicada, badge atualiza |
| J3.10 | Escolher o que o agente pode fazer, por jornada de trabalho | 6 pacotes em português, com explicação e contagem — não uma lista de `crm_*` monoespaçado · **PASS** (`tests/e2e/capacidades-do-agente.spec.ts`) |
| J3.11 | Ligar "Atender e responder" NÃO dá direito de mandar WhatsApp | a capacidade de risco crítico fica destacada, exigindo marcação individual; desligar a jornada leva ela junto · **PASS** |
| J3.12 | Modo avançado: ficha por capacidade + nome técnico | o `name` técnico só aparece aqui; fora dele o leigo lê rótulo, o que toca e risco · **PASS** |
| J3.13 | A escolha sobrevive ao salvar e recarregar | o servidor aceita a lista (o mesmo teto da tela, `TETO_TOOLS_POR_AGENTE`, fonte única) e o estado volta igual · **PASS** |
| J3.14 | Ver se o que está ligado está funcionando (aba Capacidades) | usos, falhas, quantos vieram de teste, última vez — e o que fazer com cada número · **PASS** (números escritos pelo emissor real de audit) |
| J3.15 | O teto recusa a passagem, explicando em português | **PASS** — exercitável desde que o catálogo cresceu (57 capacidades). `capacidades-do-agente.spec.ts` liga "Atender" sobre as 8 do seed e prova a recusa por 1 vaga. A afirmação "não exercitável hoje, com 16 capacidades no catálogo" VENCEU |

## Chaves de acesso à IA `[P0]`

- `[P0]` Colar chave inválida e entender o motivo — `tests/e2e/credenciais-de-ia.spec.ts`. Achados corrigidos em 2026-09-02: lista de modelos colada por vírgula no card; "Validando…" eterno após restart; erro em código (`auth_failed_401`, no card e no toast); diálogo sem dizer quando usar cada provedor nem onde pegar a chave; contagem "em uso" divergente do DELETE. **PASS** — executada de verdade contra browser real (Supabase local pg17 + baseline + Chromium) em 2026-09-02, depois que o Docker da máquina (antes indisponível) voltou. A própria execução achou um SEXTO defeito que a leitura de código não tinha achado: `descreverErroDeValidacao` não classificava `TypeError` (o nome que o `fetch()` do Node usa para falha de rede/DNS) como erro de rede, e o card mostrava "Falha na validação (TypeError)." cru em vez da frase amigável — corrigido em `lib/ai/credenciais/erro-de-validacao.ts`, com caso de teste. Evidência em `.superpowers/evidence/credenciais-de-ia.png`.

## J4 — CRM e Pipelines `[P1]`

| # | Caso | Expectativa |
|---|------|-------------|
| J4.1 | Pipeline default existe pra org nova | Kanban abre com 8 colunas |
| J4.2 | Criar lead manual pelo dialog | card aparece na coluna certa |
| J4.3 | Drag-and-drop entre colunas | posição persiste após reload |
| J4.4 | Ganhar lead (mover pra "Pago") | status won + `closed_at` |
| J4.5 | Perder lead exige motivo | sem motivo → validação clara |
| J4.6 | Filtro por owner | leads coerentes com filtro |
| J4.7 | Bulk: mover/taguear 2+ leads | funciona; automações disparam por lead |
| J4.8 | Timeline do contato mostra atividades do lead | merge contato+leads correto |
| J4.9 | Vocabulário customizado (Pedido/Pago/Cancelado) | UI reflete em todo o kanban |
| J4.10 | Editar config de pipeline como agent | 403 amigável |
| J4.11 | Painel de Evolução → CTA da lacuna de funil | leva a Configurações › Funis, não ao quadro (executado 2026-07-27, manager) |
| J4.12 | Mapear passo do agente → etapa e salvar | persiste no reload e em `crm_stages.agent_stage_hint` (executado 2026-07-27) |
| J4.13 | Etapa já usada por outro passo | some das demais listas; volta ao desfazer (executado 2026-07-27) |
| J4.14 | «Ganho»/«Perdido» num funil sem etapa de fechamento | explica o motivo, não mostra lista vazia (executado 2026-07-27) |
| J4.15 | Lista de funis com o usuário em DUAS organizações | mostra só a org ativa — nunca funis homônimos de outra (executado 2026-08-03; **defeito encontrado e corrigido**) |
| J4.16 | Criar funil pela tela do Kanban | nasce com Novo · Em andamento · Ganho · Perdido, e o quadro abre com as 4 colunas (executado 2026-08-03) |
| J4.17 | Renomear, reordenar (↑↓) e eleger padrão | persiste; o padrão anterior é liberado antes do novo (executado 2026-08-03) |
| J4.18 | Arquivar o funil PADRÃO | recusa explicada: "marque OUTRO funil como padrão antes" (executado 2026-08-03) |
| J4.19 | Arquivar o ÚLTIMO funil ativo | recusa explicada: sem funil não há quadro (executado 2026-08-03) |
| J4.20 | Arquivar funil que é destino de formulário/automação | recusa NOMEANDO a fonte ou a regra (coberto por unit; `webhook_sources` cascateia) |
| J4.21 | Lista de funis como `agent` | vê a lista e abre o quadro, sem nenhum controle de escrita (executado 2026-08-03) |
| J4.22 | **Mensagem de contato desconhecido chega pelo webhook do WAHA** | card nasce no funil de entrada (`is_default`), na primeira etapa aberta, com o NOME de quem escreveu — nunca `@c.us`/`@lid` (executado 2026-08-06 · `conversa-vira-lead.spec.ts`) |
| J4.23 | Timeline do card recém-nascido | diz **"Entrou pelo WhatsApp"** — card que aparece sem explicação destrói a confiança no automatismo (executado 2026-08-06) |
| J4.24 | Segunda mensagem do MESMO contato | **não** abre um segundo card: um lead por demanda, não um por mensagem (executado 2026-08-06) |
| J4.31 | **Marcar em que funis o assistente pode mexer** | nasce FECHADO (a tela explica: "conversa normalmente, mas não mexe em negócio"); a marcação sobrevive ao salvar E RECARREGAR — o defeito do campo que "se desmarca sozinho" (`escopo-de-funil-do-agente.spec.ts`, 2026-08-07) |
| J4.32 | Funil marcado que o assistente não sabe percorrer | a lacuna de tradução aparece AO LADO da marcação, e só no funil marcado — fora do escopo ela não custa nada |
| J4.33 | Funil de ENTRADA fora da marcação | avisa que as conversas novas viram negócio ali e vão se acumular sem que o assistente possa organizá-los |
| J4.34 | O assistente tenta mover card de funil que não é dele | não move, e abre aviso PRÓPRIO na Central ("quis organizar um negócio de um funil que não é dele") — não o aviso de falha, porque nada falhou |
| J4.35 | Uma pessoa desfaz uma movimentação do assistente | vira atividade na timeline com a etapa que a IA escolheu; agregado por etapa responde "onde ele mais erra" |
| J4.28 | **A IA ouve um dado na conversa e o propõe** | a pendência aparece na ficha do contato COM o trecho que a pessoa escreveu; nada é gravado até alguém decidir (`confirmar-dado-do-contato.spec.ts`, executado 2026-08-07) |
| J4.29 | Confirmar a sugestão | o dado entra na ficha, sobrevive ao reload, e a pendência some — não fica botão para o que já foi decidido |
| J4.30 | Descartar a sugestão | some da tela **sem gravar**; a recusa é auditada, porque "vi e decidi não gravar" é sinal de onde a IA erra |
| J4.26 | **Salvar o e-mail de um contato pela tela** | fica salvo, aparece na ficha e sobrevive ao reload. Era **500** até 2026-08-06: o handler escrevia em `email_normalized`, coluna GERADA, e o Postgres abortava o UPDATE inteiro (`contato-salva-email.spec.ts`) |
| J4.27 | Anonimizar um contato (LGPD) | mesma causa da J4.26 na rota `/api/v1/lgpd/anonymize` — **a anonimização não acontecia**. Corrigido; guardado pelo invariante de colunas geradas, ainda **sem prova de tela** |
| J4.25 | ⚠️ O funil de entrada de uma org nova é de **e-commerce** | `fn_seed_default_pipeline_for_org` semeia "Pedidos" com *Carrinho abandonado · Pago · Em separação…*. Numa clínica ou imobiliária, o lead nasce em **"Carrinho abandonado"**. Achado em 2026-08-06 ao provar J4.22; conserto é decisão de produto (spec 17 passo 4) |
| J4.36 | **Editar campos do funil pela barra da conversa** | só os customizados (`settings.fields`) aparecem como inputs; título/valor ficam no dossiê. Salvar grava `custom_fields` no mesmo PATCH do quadro e a seção relê · `tests/unit/inbox-campos-lead.test.tsx` |
| J4.37 `[P1]` | **Só conversas comerciais** (CRM › Etapas do funil › Quando o card nasce, plano 2026-09-22) | com a regra ligada, mensagem de suporte NÃO abre card; mensagem de contratação/mudança de plano abre, com a razão na linha do tempo; a mensagem seguinte do mesmo contato não chama o classificador; o gerente vê a regra em vigor (selo "Em vigor") sem botão Salvar — `tests/e2e/card-pelo-classificador.spec.ts` (Jev falso local). Evidência: `evidence/card-pelo-classificador/regra-ligada.png` (admin liga pela tela), `evidence/card-pelo-classificador/card-nascido-comercial.png` (razão no dossiê) e `evidence/card-pelo-classificador/regra-vista-pelo-gerente.png` (visão do gerente) |

## J5 — Time: convites e atuação de atendentes `[P0]` (convite) / `[P1]` (rotina)

| # | Caso | Expectativa |
|---|------|-------------|
| J5.1 | Admin convida atendente pela UI (sem Resend) | UI diz a verdade + accept_url copiável |
| J5.2 | Convidado abre link, cria sessão, aceita | vira membro agent, cai no inbox |
| J5.3 | Atendente vê APENAS fila + suas conversas | escopo RLS na prática |
| J5.4 | Atendente dá claim numa conversa da fila | claim ok; 2º atendente levando 409 amigável |
| J5.5 | Transferir conversa pra colega | imediata, contador de não-lidas zera pro novo dono |
| J5.6 | Atendente tenta ver billing/api-tokens | 403 página amigável |
| J5.7 | Revogar atendente | perde acesso na hora (próxima navegação) |
| J5.8 | Revogar último admin | bloqueado com explicação |
| J5.9 | Link de convite expirado/adulterado | tela clara, sem stack |
| J5.10 `[P0]` | Convite pendente aparece na aba **Membros** | seção "Convites" lista e-mail, papel, interface, status (Pendente/Aceito/Expirado/Revogado), data de envio e de expiração, quem convidou · antes só existia numa lista efêmera dentro do modal "Convidar membros" · `lib/team/convite-status.test.ts` + `tests/e2e/invite-lifecycle.spec.ts` casos 13–16 |
| J5.11 `[P0]` | E-mail do convite **não saiu** (VPS sem Resend) | a linha mostra "Não saiu" + botão **Copiar link** ali mesmo (usa `team_invites.email_dispatched`, antes só legível no `api_audit_log`) — o admin não fica achando que enviou |
| J5.12 | Admin **revoga** um convite pendente | `POST /api/v1/team/invites/[id]/revoke` marca `revoked_at`; o aceite passa a recusar o token mesmo dentro da validade; audita `member.invite_revoked` |
| J5.13 | Admin **reenvia** um convite | `POST /api/v1/team/invites/[id]/resend` re-assina o mesmo `invite_id`, renova 24h, audita `member.invited`; reconvidar o mesmo e-mail pendente pela tela de convite RENOVA a linha (índice único parcial) |
| J5.14 | Manager vê a lista, mas não as ações | leitura é `team_invites_select` (manager+); reenviar/revogar são admin-only (403) |

## J6 — Webhooks: receber, automatizar, provar `[P0]`

| # | Caso | Expectativa |
|---|------|-------------|
| J6.1 | Criar fonte de dados pela UI | URL pública + snippets exibidos |
| J6.2 | "Enviar lead de teste" | toast de sucesso + lead visível no Kanban + feed atualiza |
| J6.3 | POST externo real (curl de "Zapier") | lead entra; feed mostra recebimento; idempotência por external_id |
| J6.4 | HMAC: fonte com secret + assinatura errada | 401; feed marca inválido |
| J6.5 | Criar regra: lead com utm instagram → tag | regra nasce pausada; ativar pelo switch |
| J6.6 | Drain roda → regra executa | tag aplicada; aba Atividade mostra run Sucesso |
| J6.7 | Ação call_webhook → receiver local REAL | payload chega no receiver; envelope sem org_id/cpf |
| J6.8 | call_webhook com URL interna (SSRF) | bloqueado com erro claro |
| J6.9 | Run falho → botão Reenviar | novo run; sucesso após receiver voltar |
| J6.10 | Automação SEM cron configurado | hoje: morre em silêncio — **candidato a bug de produto** |
| J6.11 | **Automação com envio que FALHA** (WhatsApp fora do ar) | aba Atividade diz **Falhou**, com a frase que explica o que conferir — nunca "Sucesso". Achado do relato de 2026-08-24: dizia Sucesso com a mensagem em `failed` (`automacao-diz-a-verdade.spec.ts`) |
| J6.12 | Automação adiada pela janela de envio do número | aba Atividade mostra **Aguardando horário** com o instante da nova tentativa — antes não gravava linha nenhuma e a tela ficava vazia |
| J6.13 | Formulário preenchido entra | aba **Leads recebidos** mostra a linha com quem/contato/fonte/quando/origem; o painel traz TODOS os campos, IP, página e UTM (`historico-de-captacao.spec.ts`) |
| J6.14 | **Formulário com campos que o mapeamento não reconhece** | a captação aparece como **Não entrou**, com o motivo em português e os campos crus — antes o site recebia 400 e não sobrava rastro nenhum na tela |
| J6.15 | `viewer` tenta abrir o histórico | redirecionado; a RLS de `webhook_lead_captures` exige `manager` (o formulário é PII) |
| J6.16 | Ação **"Mensagem escrita pela IA"** no ENTÃO | pede agente publicado + número + o contexto do que fazer com os dados; o agente sabe que é abordagem pós-formulário |

## J8 — O cliente não morre por falta de resposta `[P1]`

Contexto do código: pacote `reter` do catálogo (IA 360 · wave 2). A demanda esfria, o
agente marca o retorno pela capacidade que o dono ligou na tela, o humano vê e pode
desmarcar, e o agente descobre que desmarcaram. Spec: `tests/e2e/retorno-anti-morte.spec.ts`
(seed pela capacidade REAL — `scripts/seed-e2e-retorno.ts`, nunca INSERT à mão).

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J8.1 | Negócio 5 dias sem movimento com retorno marcado pelo agente | Radar mostra **"Em voo"** e "Assistente retorna em 2d" — não "crítico" | PASS |
| J8.2 | Linha do tempo do negócio após o agendamento | entrada `Retorno agendado — <motivo>`, com o agente nomeado | PASS |
| J8.3 | Fila de acompanhamento mostra a promessa | linha "Promessa" com status **Agendada** e botão Cancelar | PASS |
| J8.4 | Humano desmarca pela fila | diálogo diz o que acontece; status vira **Cancelada** (não "Concluída") | PASS |
| J8.5 | O agente consulta os retornos depois do cancelamento | vê `situacao: cancelado` **com o motivo** — é o que o impede de reagendar | PASS |
| J8.6 | Repetir a jornada | seed reseta o retorno; o teste roda de novo sem intervenção | PASS |

Evidência: `.superpowers/evidence/w2-retorno-{no-radar,na-fila-agendada,dialogo-de-cancelamento,na-fila-cancelada}.png`.

**Sabotagem que confirma que o caso não passa por acaso:** devolvendo `podeCancelar` ao
estado anterior à wave (promessa não cancelável), J8.4 reprova com timeout no clique —
1 failed / 1 passed. Restaurado, 2 passed.
## J8 — Passar o atendimento para uma pessoa, e receber de volta `[P1]`

Contexto do código: o agente abre um chamado (`agent_cases`) quando esbarra num
bloqueio; a passagem em si (`performHumanHandoff` / `triggerHandoff`) liga **três**
travas — `contacts.force_human`, `conversations.bot_silenced_until` e
`assignee_kind='user'`. A volta é `POST /conversations/[id]/reactivate-bot`, hoje
atrás do botão "Devolver ao automático" no cabeçalho da conversa.

Spec: `tests/e2e/escalacao-ciclo.spec.ts`. Seed: `scripts/seed-e2e-escalacao.ts`
(chama as funções REAIS `openCase` e `performHumanHandoff` — um seed que ligasse
as travas com `UPDATE` próprio provaria o teste contra uma cópia da regra).
Evidência: `.superpowers/evidence/ia-360-w3/`.

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J8.1 | O chamado aberto pelo agente aparece em `/app/ai/cases` | linha na fila com o título e o bloqueio | PASS |
| J8.2 | A pessoa escolhe "Concluí" e escreve o que combinou | o chamado fecha (`resolved`) e o texto fica registrado | PASS |
| J8.3 | A conversa DIZ que o automático está pausado | aviso visível no cabeçalho — conversa com o robô calado não pode ter a cara de uma conversa normal | FAIL(BUG-04) → PASS |
| J8.4 | Existe caminho de volta pela tela | botão "Devolver ao automático" | FAIL(BUG-04) → PASS |
| J8.5 | Devolver solta as **três** travas | `force_human=false`, silêncio nulo, dono nulo, `assignee_kind='ai'` | FAIL(BUG-01) → PASS |
| J8.6 | A volta aparece na linha do tempo do negócio | atividade "Voltou para o atendimento automático" | FAIL(BUG-02) → PASS |
| J8.7 | A **ida** aparece na linha do tempo | atividade "Passou para humano" também pelo caminho do harness/casos | FAIL(BUG-05) → PASS |
| J8.8 | O agente retoma **sabendo** o que a pessoa fez | a abertura do turno (`ritualBlocks`) cita a decisão dela, sem apagar o acumulado anterior | PASS |
| J8.9 | Status da conversa escalada em português | o cabeçalho mostrava `pending` cru | FAIL → PASS |
| J8.10 | **O cliente é AVISADO antes de a IA sair de campo** | mensagem ao lead dizendo que uma pessoa vai assumir, ANTES do silêncio | FAIL(BUG-06) → PASS |
| J8.11 | O aviso respeita o motivo | quem pediu para PARAR recebe confirmação da parada, não oferta de atendente | FAIL(BUG-06) → PASS |
| J8.12 | O aviso respeita a equipe real | conta sem ninguém configurado não recebe promessa de contato | FAIL(BUG-06) → PASS |
| J8.13 | A passagem por SENTIMENTO abre item na Central | `triggerHandoff` não abria nenhum — cliente sem resposta E time sem sinal | FAIL(BUG-07) → PASS |

Bugs desta jornada estão detalhados em `HANDOFF-ia-360.md` (BUG-01 a BUG-05) e em
`HANDOFF-handoff-avisa-o-lead.md` (BUG-06, BUG-07).

### BUG-06 — a passagem para humano era MUDA (2026-08-26)

Achado pelo dono do produto, em duas conversas reais na mesma hora, e a medição
no banco de produção mostrou que **são dois motores, não um**:

```
status  | bot_silenced_until | last_handoff_reason | force_human
open    | infinity           | requested_human     | t     <- performHumanHandoff (motor, pg)
pending | infinity           | low_sentiment       | f     <- triggerHandoff (CRM, supabase-js)
```

O pior caso não foi o pedido explícito: foi o do sentimento. Às 14:50:32 o agente
PERGUNTOU o e-mail do cliente; às 14:51:01 o worker de sentimento disparou o
handoff; às 14:51:27 o e-mail chegou e o turno foi pulado. Ele respondeu uma
pergunta da própria IA para o vazio.

**A ordem é obrigatória:** `performHumanHandoff` grava `force_human`, e o gate 1
da cadeia de envio o relê a cada tentativa — avisar depois é avisar ninguém.
Provado por sabotagem em `evidence/handoff-avisa-antes/sabotagem-ordem-invertida.txt`.

Guardas: `tests/invariants/handoff-avisa-o-lead.test.ts` (turno real contra
Postgres do baseline), `tests/unit/handoff-avisa-o-lead.test.ts` (varredura AST
dos dois motores) e `tests/unit/aviso-ao-lead.test.ts` (o texto).

---

## J11 — Saber quem está no comando da conversa `[P0]`

**Por que P0:** é a leitura que o atendente faz ANTES de qualquer ação, em toda
conversa que abre. J5.5 cobre transferir e J8 cobre a passagem IA↔humano; nenhuma
das duas cobria *ler o estado* — e foi exatamente aí que o dono do produto
relatou as quatro confusões.

**A causa não era de tela.** Medido no HEAD 927dfa51: `lib/agent-engine/` nunca
lê `assignee_kind` nem `assigned_to_user_id` (`grep -rn` → rc=1) e
`fn_conversation_assign` nunca tocava `bot_silenced_until`. Um atendente clicava
"Assumir" e o atendimento automático continuava respondendo o MESMO cliente — ele
só calava por 5 minutos deslizantes quando a pessoa ENVIAVA (`extendBotSilence`).
Nenhum selo de "você está no comando" podia ser verdade enquanto isso valesse.

Spec: `tests/e2e/inbox-quem-manda.spec.ts` (seed próprio, conversa nova a cada
execução). Evidência: `.superpowers/evidence/inbox-quem-manda/`.
Regra na tela: `lib/inbox/comando-da-conversa.ts` (+ 17 casos unitários).
Regra no banco: `tests/invariants/comando-cala-o-automatico.test.ts` (6 casos).

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J11.1 | Conversa normal diz quem manda | selo de comando mostra o automático — não a mesma cara de uma conversa largada na fila | PASS |
| J11.2 | Assumir muda o selo para a PESSOA, com nome | `OwnerBadge` com as iniciais e o nome do atendente | PASS |
| J11.3 | Assumir **para** o automático de verdade | `bot_silenced_until='infinity'` no banco — a tela mudar de cor não prova que o motor parou | PASS |
| J11.4 | O selo diz o PORQUÊ, não só que está pausado | "alguém assumiu" / "pausado para este cliente" / "volta em instantes" pedem ações diferentes e tinham a mesma frase | PASS |
| J11.5 | Existe caminho para DESLIGAR pela tela | botão "Pausar o automático" — antes só existia o de ligar | PASS |
| J11.6 | A volta existe e limpa o silêncio | "Devolver ao automático" → `bot_silenced_until` nulo | PASS |
| J11.7 | A troca de comando aparece na linha do tempo | "Assumiu a conversa" com o NOME de quem agiu, não "Você/time" | PASS |
| J11.8 | O rodízio NÃO cala o automático | o rodízio não ENTREGA a ninguém a conversa que a IA automática do canal vai atender — senão uma org em round_robin perde a IA inteira | FAIL → PASS (`lib/routing/worker-respeita-a-ia.test.ts` + invariante `rodizio-respeita-a-ia`) |
| J11.8b | A conversa que SAI da IA entra no rodízio do time | a transferência grava o time e só depois pede o rodízio; o drain devolve à fila a conversa que a IA recusa (agente pausado, fora da lista de teste) | PASS (`human-handoff.test.ts`, `drain.test.ts`) |
| J11.9 | Fechar devolve o comando | o silêncio é limpo ao fechar, senão vaza para o próximo episódio (a ingestão reusa a MESMA linha de conversa) | PASS (invariante) |

| J11.10 | A conversa que o automático ESCALOU aparece na Fila | `status='pending'` sem dono entra na aba e é contada pelo badge | FAIL → PASS |
| J11.11 | O número da fila é o MESMO para o cliente e para a equipe | `getQueuePosition` (o "você é o 5º" que o cliente ouve) e `getQueuePositions` (o "3º" da tela) contam os mesmos estados | FAIL → PASS |

**J11.8 estava PASS medindo a coluna errada (2026-09-21).** O caso só conferia que
`reason='routing'` não mexe em `bot_silenced_until` — e não mexe. Mas o rodízio grava
`assignee_kind='user'`, e a trava de elegibilidade que entrou em 27/08 (`gate.ts`) veta
conversa com dono humano. Medido em produção (v1.34.1, org em `round_robin`, agente no
canal oficial): o cliente escreveu, o cron entregou a conversa ao atendente online em 2 s,
o motor pulou o turno por `conversa_de_humano`; soltar a conversa não adiantou, o rodízio
reatribuiu em menos de um minuto. A IA não respondia ninguém enquanto houvesse alguém
online — com o teste verde. O conserto (migration 0273) não mexe na trava: o rodízio passa
a PERGUNTAR se a IA vai atender (`fn_ia_automatica_no_canal` + a mesma trava do motor)
antes de distribuir, e quem tira a conversa da IA pede o rodízio de novo. A régua agora
mede o comportamento (houve atribuição?), não a coluna.

**O achado que esta jornada abriu, e como ele cresceu.** A primeira rodada
registrou aqui "a conversa escalada não aparece em aba nenhuma" como pendência de
PR próprio. Ao medir, o defeito era maior e mais barato: a definição de "está na
fila" estava copiada em SEIS sítios que **não concordavam entre si** — o trigger
de roteamento do banco e a função que responde ao cliente contavam `open+pending`;
a aba, o badge, o painel do gerente e a posição mostrada na tela contavam só
`open`. Daí as duas consequências: a conversa que mais precisa de uma pessoa era a
única invisível, e o número de fila prometido ao cliente pelo WhatsApp não batia
com o que a equipe via.

Conserto: `CONVERSATION_QUEUE_STATUSES` (uma definição, quatro consumidores) +
separação entre o vocabulário de LEITURA (7 valores, o do banco) e o de ESCRITA
(5 — quem grava `pending` é o motor, e um cliente REST não pode fingir uma
escalação). Guardado por `tests/unit/fila-tem-uma-definicao-so.test.ts`, que varre
o fonte dos quatro sítios e compara o CONJUNTO do trigger com o da constante.

---

## J24 — Atender com protocolo: fechar, o cliente voltar, achar pelo número `[P1]`

**Quem:** atendente e gestor de uma operação regulada (telecom) — cada atendimento
precisa de NÚMERO DE PROTOCOLO, e o cliente liga dizendo o número.

**Spec:** `tests/e2e/inbox-protocolo-e-historico.spec.ts` · evidência em
`.superpowers/evidence/inbox-protocolo/` · banco fresco do `baseline.sql`, `next build` +
`next start`, mensagem do cliente entrando por INSERT em `messages` (o caminho da ingestão),
nunca por `update` de status.

| # | Caso | Como se prova | Estado |
|---|---|---|---|
| 1 | As abas ficam num TRILHO em pé, e o nome da aba está escrito no topo da lista | `getByRole("tab")` + largura do trilho ≤ 48px medida | ✅ |
| 2 | Os filtros ficam recolhidos: abrem no funil, fecham no funil; filtro ligado aparece como número no funil | `inbox-filtros-auxiliares` some/volta; `tests/unit/inbox-filters-scope.test.tsx` | ✅ |
| 3 | A primeira conversa começa alto na coluna (o ganho de altura é medido) | `boundingBox` do card − topo da coluna < 140px | ✅ |
| 4 | O card diz o TIME e o CANAL antes de abrir, sem reticências, e há quanto tempo o cliente espera | `rodape-da-conversa`, `scrollWidth ≤ clientWidth`, `espera-da-conversa` | ✅ |
| 5 | O painel mostra o protocolo (copiável), o canal e o time | `protocolo-do-atendimento`, `ficha-da-conversa` | ✅ |
| 6 | Fechar o painel devolve largura à conversa | largura do `chat-thread` cresce > 200px | ✅ |
| 7 | A linha do tempo conta aberta → fila do time → assumida → encerrada, COM autor | aba Linha do tempo, textos por extenso | ✅ |
| 8 | Fechada, a conversa some de "Minhas" | `data-conversation-id` com contagem 0 | ✅ |
| 9 | O cliente volta: protocolo NOVO, e a conversa mostra só o atendimento de agora | protocolo ≠ anterior; mensagem antiga ausente do thread | ✅ |
| 10 | O histórico lista os dois atendimentos; abrir o antigo recorta a conversa, some com as ações e trava o composer; "voltar ao atual" desfaz | `aviso-atendimento-antigo`, `acoes-da-conversa` oculto | ✅ |
| 11 | A busca pelo protocolo ANTIGO acha o atendimento estando em outra aba | `resultado-por-protocolo` na aba Minhas | ✅ |
| 12 | O atendimento novo começa do ZERO: sem o time nem o dono do anterior, IA religada (migration 0269) | `conversations` com `team_id`/dono/silêncio/passagem nulos; card "Sem time"; linha do tempo só com "Novo atendimento aberto" | ✅ |
| 13 | A aba Fechadas lista ATENDIMENTOS: o encerrado continua lá com a conversa ABERTA de novo, marcado "o cliente voltou", com quem encerrou (sem reticências), o time do FECHAMENTO e o canal; o badge conta a mesma unidade | `lista-de-atendimentos-fechados`, `cliente-voltou`, `quem-encerrou` medido por `scrollWidth`, badge `1` | ✅ |
| 14 | Na aba Fechadas a busca acha pelo protocolo e pelo nome, e os filtros valem contra o PostgREST de verdade (time do fechamento, número, etiqueta); o badge acompanha a busca com e sem resultado | `GET /atendimentos?status=closed&…` e `GET /conversations/counts?tag=`/`?search=` pela sessão logada | ✅ |
| 15 | Clicar num atendimento encerrado abre AQUELE atendimento (recortado, composer travado) e a ficha mostra o time que o encerrou, não "Sem time" | `aviso-atendimento-antigo`, `ficha-da-conversa` com "Cobrança" | ✅ |
| 16 | A NOTA INTERNA pertence ao atendimento em que foi escrita: a do primeiro não aparece no atendimento novo, a do novo não aparece ao abrir o antigo (pelo histórico e pela aba Fechadas), e "voltar ao atual" desfaz | duas notas escritas PELO COMPOSER; `chat-thread` com/sem o texto de cada uma | ✅ |
| 17 | A aba Todas mostra só conversas abertas, agrupadas por Cobrança, Suporte e Sem time; cada cabeçalho e o badge mostram a contagem exata e mudam ao encerrar uma conversa | `inbox-protocolo-e-historico.spec.ts`: três grupos com 1 conversa cada; após Fechar, Cobrança some de Todas e o total cai de 3 para 2; `tests/unit/inbox-todas-contagem-por-time.test.ts` cobre 60 conversas além da primeira página; `.superpowers/evidence/inbox-protocolo/02b-todas-por-time.png` | ✅ |

**Limite preexistente da busca:** termos que casam muitos contatos continuam sujeitos
ao teto de 120 IDs na busca por nome/telefone. Os contadores são exatos para o
mesmo predicado que a lista aplica; ampliar a busca além desse teto é uma frente
separada.

**Achados desta rodada, consertados na causa:**

- **A regra de 1400px da grade nunca valia.** `xl:… min-[1400px]:…` em cascata: o Tailwind 4
  emitiu o breakpoint arbitrário ANTES do `xl` no CSS, então em 1440px o `xl` vencia e a lista
  ficava em 248px com time e canal cortados. Medido no bundle (`.next/static/chunks/*.css`).
  Conserto: três faixas mutuamente exclusivas. A spec mede a largura do card em 1440px.
- **Data inválida derrubava o painel inteiro.** `format()` do date-fns LANÇA; um carimbo
  ausente virava tela em branco na coluna. Agora o rótulo cai em "—".
- **A contagem com etiqueta derrubava o número de TODAS as abas** (achado em 2026-09-19, ao
  levar a contagem da aba Fechadas para `atendimentos`). A fábrica de
  `conversations/counts` aplicava todo filtro auxiliar como igualdade, e a etiqueta saía como
  `.eq("tag", …)` — coluna que não existe (`tags` é array). Com uma etiqueta escolhida a rota
  respondia erro e os badges sumiam. Agora é `contains`, como a lista sempre fez; o caso 14 mede
  o 200 pela sessão logada e `tests/unit/badge-espelha-o-filtro.test.ts` proíbe a igualdade crua.
- **Reabrir por mensagem do cliente herdava o roteamento do atendimento anterior.** Medido no
  corpo de `fn_service_inbound` (0222): o ramo `reopened` zerava dono e agente de IA e não tocava
  `team_id`, `bot_silenced_until`, `last_handoff_at` nem `contacts.force_human`. Quem falou com o
  Financeiro na segunda e voltava pedindo suporte na quarta caía na fila do Financeiro, com a IA
  muda. Migration 0269; gate em `tests/invariants/atendimentos-protocolo-e-linha-do-tempo.test.ts`.
- **"Fechada" sem dizer por quem — achado em PRODUÇÃO, não no teste** (2026-09-19, logo depois
  de subir a 1.31.0). Quatro atendimentos encerrados pela tela tinham `actor_kind='user'` e
  `actor_name` nulo: o trigger da 0266 lia o nome só de `full_name`, e os dois usuários da
  instalação não têm essa chave. A spec e os invariantes criavam TODO usuário com `full_name` —
  mediam o caminho feliz, que não é o de quem instalou cedo. Migration 0270: régua única
  `fn_nome_do_usuario` (nome; na falta, o início do e-mail) + backfill idempotente. O invariante
  novo cria o usuário que faltava: sem `full_name`.
- **A nota interna atravessava os atendimentos — relatado pelo dono do produto** (2026-09-19).
  As mensagens eram recortadas pela janela do episódio e as notas, que entram no MESMO thread,
  vinham da conversa inteira: `useConversationNotes(conversationId)` nunca recebeu o atendimento.
  A nota do Financeiro aparecia no atendimento novo do Suporte, e a de hoje dentro do encerrado.
  A regra da janela saiu do handler de mensagens para `lib/atendimento/janela-do-atendimento.ts`,
  e as duas rotas a chamam; `tests/unit/notas-internas-por-atendimento.test.ts` proíbe reescrevê-la
  por fora e foi sabotado (a linha antiga no thread → vermelho). A spec escrevia ZERO notas: o
  recorte era medido só com mensagens, que é a metade que funcionava.

**NÃO medido:** telefone de verdade (a spec não conecta WAHA); o trilho em tela de toque
(a dica de mouse não existe lá — o nome da aba escrito no topo é a resposta, e está medido
só em desktop); ordem dos eventos quando dois chegam no mesmo milissegundo; a aba Fechadas com
milhares de atendimentos (a paginação por `(closed_at, id)` é medida em unidade, não em volume);
o agente de IA de verdade respondendo no atendimento novo (a spec prova o ESTADO que o religa —
silêncio, passagem e `force_human` limpos —, não a resposta dele).

## J25 — Entrar em pausa com motivo, o gestor ver, e o time ter teto `[P1]`

**Quem:** o atendente (sai para o almoço, não pode receber conversa) e o gestor (precisa saber
quem está em pausa, por quê, e limitar quantas conversas cada um pega no time).

**Spec:** `tests/e2e/pausa-do-atendente.spec.ts` · evidência em
`.superpowers/evidence/pausa-do-atendente/` · dois navegadores (atendente e gestor) no mesmo
banco fresco. A DISTRIBUIÇÃO em si — quem recebe, quem espera — é provada no banco
(`tests/invariants/pausa-do-atendente-e-limite-por-time.test.ts`): o claim é uma transação.

| # | Caso | Como se prova | Estado |
|---|---|---|---|
| 1 | O status está na barra de cima de QUALQUER tela (usado aqui no Funil) | `status-do-atendente` visível em `/app/kanban` | ✅ |
| 2 | Ficar online grava disponibilidade e o SINAL DE VIDA sai sozinho | `is_available` e `last_heartbeat_at` lidos no banco | ✅ |
| 3 | Entrar em pausa exige motivo (o botão nasce desabilitado) | `confirmar-pausa` disabled até escolher | ✅ |
| 4 | O motivo escolhido se distingue dos outros — medido por cor computada | `getComputedStyle`, com `poll` por causa da transição | ✅ |
| 5 | A pausa da tela é a do banco: histórico aberto com motivo e observação, e `is_available=false` | `attendant_pause_log` + `attendant_availability` | ✅ |
| 6 | O gestor vê "Em pausa · Almoço · há N" em Equipe › Atendimento | `atendente-em-pausa` | ✅ |
| 7 | Voltar encerra a pausa no histórico, com `ended_by=self` | `attendant_pause_log` | ✅ |
| 8 | O limite do time, salvo pela tela, volta do banco depois do reload — e aparece no cartão | `teto-do-time`, `resumo-do-teto`, `max_concurrent` no banco | ✅ |

**No banco (invariante):** em pausa o claim devolve `capacity_changed`; teto 1 → a segunda conversa
espera com capacidade pessoal sobrando; fechar adianta quem esperava **sem criar evento novo**;
voltar pelo PATCH da tela de Equipe também fecha a pausa (o caso que quebrou na primeira versão:
`update of paused_at` não dispara quando quem escreve é `is_available`).

**Achado desta rodada:** nenhuma tela emitia o sinal de vida — o cron `attendant-heartbeat`
derrubava todo atendente 15 minutos depois de ficar disponível, e o rodízio parava sem nada na
tela dizendo por quê. O `useStatusDoAtendente` é o outro lado daquele cron.

**NÃO medido:** o worker de roteamento rodando de ponta a ponta com duas pessoas reais (a spec
prova a tela e o invariante prova o claim, mas o caminho cron → worker → claim não foi dirigido
num só teste); pausa que atravessa o fim do expediente (não há encerramento automático — a
pausa fica aberta até a pessoa voltar, e o relatório futuro vai precisar tratar isso).

## J26 — O provedor liga o IXC, e o atendente atende sem abrir o ERP `[P1]` (2026-09-19)

Pedido do dono (provedor de internet que opera pelo IXC): uma aba no painel da
conversa com o que o atendente abriria o ERP para ver — cliente, bloqueio,
contrato, faturas, OS, atendimentos, conexão e sinal da ONU — e um botão que manda
a fatura no chat. Desenho e fatos medidos na instância real:
`docs/superpowers/specs/2026-09-19-conector-ixc-design.md`; migration 0271.

Spec: `tests/e2e/conector-ixc-no-painel.spec.ts` (organização e admin próprios). O
"IXC" é um servidor HTTP de verdade na mesma máquina, falando o dialeto medido —
rota por tabela, erro com HTTP 200, 401 em HTML para token errado — e devolvendo a
LINHA INTEIRA, com `senha` em claro, como o IXC devolve. O WAHA do rig (porta 3999)
ganha um receiver para provar o que saiu. Banco:
`tests/invariants/conectores-sao-server-side.test.ts`.

| Caso | Prioridade | Resultado |
|---|---|---|
| J26.0 SEM conector ligado, o painel da conversa não tem aba a mais (`painel-aba-conector:ixc` = 0) — a organização que não usa IXC não vê nada | `[P1]` | **PASS** |
| J26.1 Configurações › Conectores: token errado → "O sistema recusou o token." e a ficha continua DESLIGADA (salvar testa antes de gravar) | `[P1]` | **PASS** — `evidence/conector-ixc/01-token-errado-recusado.png` |
| J26.2 Token certo → "Ligado", a tela mostra só `••••` + 4 finais, o token não aparece em lugar nenhum do texto da página, e no banco está cifrado | `[P1]` | **PASS** — `evidence/conector-ixc/02-conector-ligado.png` |
| J26.3 Inbox: a aba IXC aparece; o telefone da conversa identifica UM cadastro (o homônimo de outro DDD é descartado) e o vínculo é gravado como `telefone` | `[P1]` | **PASS** — `evidence/conector-ixc/03-painel-vinculado.png` |
| J26.4 O painel mostra nome, CPF, selo "Bloqueado" numa linha só (altura ≤ 24px, medida) com "Motivo: financeiro em atraso", contrato com endereço, **3 vencidas + 2 a vencer + "Mais 3 parcelas futuras"** (a regra do dono), total vencido R$ 389,70, conexão Online com IP, sinal "No limite" −26.10 dBm, 1 OS agendada, 1 atendimento em progresso | `[P1]` | **PASS** — `evidence/conector-ixc/03-painel-vinculado.png`, `evidence/conector-ixc/04-painel-conexao-e-os.png` |
| J26.5 **Nenhuma das 4 senhas que o IXC falso devolve (central, PPPoE, Wi-Fi, ONU) nem o token do gateway está no HTML da página** | `[P0]` | **PASS** |
| J26.6 O painel não rola para o lado (`scrollWidth − clientWidth ≤ 1`, medido) | `[P1]` | **PASS** |
| J26.7 Enviar a cobrança — **Boleto**: "Enviar" só ABRE a escolha [Boleto] [Pix] (nada sai e nada é pedido ao IXC); escolher Boleto manda o **PDF que o IXC devolve em `get_boleto`** como documento, com valor e vencimento na legenda, e a linha digitável sozinha em seguida. O PDF guardado no Storage é o do IXC **byte a byte**; nenhum link sai; o conector pediu `get_boleto` e NÃO `get_pix` | `[P1]` | **PASS** — `evidence/conector-ixc/05-escolher-boleto-ou-pix.png`, `evidence/conector-ixc/06-boleto-em-pdf-enviado.png` |
| J26.7b **Pix**: manda o **QR code** (PNG gerado aqui a partir do copia-e-cola de `get_pix`, CRC conferido) como imagem, e o copia-e-cola sozinho em seguida; a imagem aparece carregada na conversa | `[P1]` | **PASS** — `evidence/conector-ixc/07-pix-com-qr-code-enviado.png`, `evidence/conector-ixc/07b-qr-code-que-foi-para-o-cliente.png` |
| J26.7c **Pix ainda NÃO gerado no IXC** (o caso achado em produção): o botão Pix está LIGADO, o `title` avisa "O IXC vai gerar o Pix desta fatura agora.", e o envio sai inteiro (QR code + copia-e-cola); a auditoria marca `pix_gerado_agora: true` só nesse envio | `[P1]` | **PASS** — `evidence/conector-ixc/07c-pix-ainda-nao-gerado-botao-ligado.png` |
| J26.7d Parcela futura SEM boleto registrado: diz "boleto ainda não gerado", o Boleto fica desligado, o Pix é tentado — o IXC recusa, e **a frase dele chega ao atendente**; nada é enviado. O canal (receiver real na porta do WAHA) recebeu os três arquivos; nome e CPF do devedor que `get_pix` devolve não chegam à página | `[P1]` | **PASS** — `evidence/conector-ixc/07d-o-ixc-recusou-e-disse-por-que.png` |
| J26.8 Telefone que não está no IXC → "Não achei este telefone…", busca por CPF vincula e mostra "Liberado" e "Nenhuma fatura vencida." | `[P1]` | **PASS** — `evidence/conector-ixc/08-nao-encontrado-busca-cpf.png` |
| J26.9 Celular de DOIS cadastros → a tela lista os dois com documento PARCIAL (`***.995.350-**`), ninguém é vinculado sozinho; "É este" vincula | `[P1]` | **PASS** — `evidence/conector-ixc/09-escolher-entre-dois.png` |
| J26.10 ERP fora do ar: o painel diz o erro com "Tentar de novo", e Configurações › Conectores passa a mostrar "Com problema" — o admin vê o que o atendente viu | `[P1]` | **PASS** — `evidence/conector-ixc/10-erp-fora-do-ar.png`, `evidence/conector-ixc/11-admin-ve-o-erro.png` |
| J26.11 Auditoria: `conector.conexao_salva`, `conector.vinculo_criado`, e TRÊS `conector.fatura_enviada` (um boleto e dois Pix, só um com `pix_gerado_agora`) — sem a linha digitável e sem o copia-e-cola no metadata | `[P1]` | **PASS** |
| J26.12 **Título que o IXC NÃO liberou** (`status = A`, `liberado = N` — financeiro de venda aberta e nunca finalizada; achado em produção em 2026-10-07): o IXC falso devolve um, de R$ 159,80 e 900 dias, para a Maria e outro para a Bruna. O painel continua com 3 vencidas e R$ 389,70 e não mostra "159,80" em lugar nenhum; a IA continua enviando à Bruna a fatura de 12 dias, em vez de encaminhá-la à cobrança | `[P1]` | **PASS** — e2e no GitHub Actions (execução 37681061560, parte 2, a spec inteira passou); também por unitário (`lib/conectores/ixc/{faturas,enviar-cobranca,agente}.test.ts`, com sabotagem das duas catracas), pelo filtro medido no IXC real (4 → 3 linhas para o cadastro do caso) e, depois do deploy da 1.57.1, pelo código em produção (`montarResumo` do cadastro do caso: 0 vencidas). Sem captura de tela: o CI só guarda imagem quando falha |

Execução (2026-09-19): `pnpm e2e:build` (produção) + `next start`, Supabase local
próprio com o `baseline.sql` aplicado (`ON_ERROR_STOP=1`, 0 erros), Chromium real.
1 passed (12,9 s).

**Revisão de 2026-09-21 (pedido do dono, depois de usar em produção):** o que ia no
chat era o link do boleto no site do banco; passou a ir **o PDF do próprio IXC**, e o
atendente **escolhe Boleto ou Pix**. Os casos J26.7–J26.7c substituem o antigo J26.7, e as
evidências 05–11 foram refeitas. `get_boleto` e `get_pix` foram medidos na instância real
(só forma, tamanhos e conferências): PDF de ~45 KB que começa com `%PDF`; copia-e-cola de
194 caracteres com **CRC16 conferido**, Pix `ATIVA`, valor igual ao `valor_aberto`.
Execução: build de produção + `next start`, Supabase local com o `baseline.sql` de
2026-09-21 (`ON_ERROR_STOP=1`, 0 erros), Chromium real — 1 passed.

**Fase 4 — a IA identifica o cliente e envia a cobrança (2026-09-23).** O segundo teste do
mesmo arquivo prova, pela tela, o que o agente de IA faz quando o conector está ligado. O turno
roda com o MOTOR REAL (fila, cadeia de envio, ledger, Storage, canal) e só o modelo é roteirizado
(`scripts/e2e-turno-da-ia-cobranca.ts`) — sem isso não haveria como exercitar a IA no CI.

| Caso | Prioridade | Estado |
|---|---|---|
| J26.12 SEM conector ligado, o editor do agente NÃO oferece as duas capacidades novas | `[P1]` | **PASS** |
| J26.13 O admin ajusta "Faturas com mais de N dias de atraso vão para a Cobrança" (60 → 70) e o valor persiste | `[P1]` | **PASS** — `evidence/conector-ixc/ia/01-limite-de-dias.png` |
| J26.14 Com o conector ligado, as duas capacidades aparecem no editor; **Enviar a cobrança é crítica** (o pacote "Atender e responder" não a liga sozinha) e é marcada uma a uma | `[P1]` | **PASS** — `evidence/conector-ixc/ia/02-capacidades-ligadas.png` |
| J26.15 Turno real: a IA identifica a cliente pelo telefone, envia o **QR code do Pix** (imagem medida com `naturalWidth > 0`, não a olho) + o copia-e-cola, e escreve uma frase curta; o receiver do WhatsApp prova o que saiu | `[P1]` | **PASS** — `evidence/conector-ixc/ia/03-ia-enviou-o-pix.png` |
| J26.16 Fatura 74 dias em atraso (acima do limite de 70): **nada sai**; a IA diz que a fatura foi encaminhada ao setor de cobrança, e a auditoria grava `conector.cobranca_encaminhada` | `[P1]` | **PASS** — `evidence/conector-ixc/ia/04-acima-do-limite-nao-envia.png` |
| J26.17 Chat do site com telefone DIGITADO que bate no IXC: o painel mostra "escolher" (motivo `telefone_digitado`) e **nenhum vínculo é gravado** — o telefone só prova quem é onde ele é o transporte | `[P0]` | **PASS** — `evidence/conector-ixc/site-nao-vincula-pelo-telefone-digitado.png` |

Sabotagem que prova a régua: com `diasDeAtraso > limiteDeDias` trocado por `false`, o caso
J26.16 fica VERMELHO (a frase de encaminhamento nunca aparece). Execução: build de produção +
`next start`, Supabase local pg15 com o `baseline.sql` (inclusive a migration 0274), Chromium
real — 2 passed.

Armadilhas pagas nesta jornada, para quem for estender o rig: `execFileSync` **trava** o
processo do Playwright, que é quem hospeda os servidores falsos — o script filho espera uma
resposta que nunca vem (use `spawn`); porta fixa colide entre os dois testes do arquivo (porta
efêmera + `closeAllConnections()` antes do `close()`); e, sem worker de pé, ninguém semeia a
camada `platform` do playbook nem a credencial de IA — o rig precisa fazer isso à mão.

**Achado do DONO em produção, 2026-09-22 (v1.35.0), consertado:** com um cadastro real, a
opção Pix ficava desligada em todas as faturas — o IXC ainda não tinha gerado o Pix delas
(`pix_txid` vazio em 4 de 4 abertas), e a regra só oferecia Pix já gerado. A regra veio de
uma amostra de faturas VENCIDAS, onde 164 de 200 já tinham Pix; fatura a vencer não tem.
O IXC gera o Pix sob demanda: escolher Pix passou a pedi-lo (J26.7c), e a recusa traz a
frase do IXC (J26.7d). **A spec antiga AFIRMAVA o defeito** ("o Pix fica DESLIGADO") — o
teste estava verde porque media a regra errada, não o que o atendente precisa.

**Achado da execução, consertado:** o selo "Bloqueado — financeiro em atraso"
quebrava em DUAS linhas dentro de um selo redondo e espremia o nome do cliente na
coluna de 264px. Virou selo curto ("Bloqueado") + "Motivo: …" em linha própria, e
a spec mede a altura do selo.

**Medido contra o IXC REAL da Totus** (só leitura, só agregados — nenhum dado
pessoal impresso): os filtros que o painel usa (`L` nos 4 campos de telefone,
`cnpj_cpf` mascarado, `status=A` ordenado por vencimento, `status != F`,
`su_status != S`, fibra por `id_login`), o 401 em HTML e o erro com HTTP 200.

**Não medido:** o ENVIO de boleto/Pix contra o IXC real numa conversa de verdade (em tela, só com o IXC falso); o que `get_boleto`/`get_pix` fazem com fatura SEM registro no gateway (por isso a tela não oferece); a TELA contra o IXC real (a prova em tela é com o IXC falso; o
token real foi só de sondagem e será trocado); latência a partir da VPS (medi
~1,4 s por chamada do Mac do dono); IXC on-premise com certificado próprio; token
de escopo mínimo (o de sondagem lia todas as tabelas); celular (o painel deslizante
herda o mesmo componente, não foi aberto em viewport de telefone).


## J27 — Chamar o cliente primeiro, com modelo aprovado `[P0]` (2026-09-19)

Pedido do dono: cadastrar um cliente (à mão ou pela importação do IXC) e
**chamá-lo no WhatsApp** antes de ele escrever — pelo modelo da Meta no canal
oficial, e por texto livre na API não-oficial. Desenho e as cinco lacunas
medidas: `docs/superpowers/specs/2026-09-19-chamar-o-cliente-design.md`. Sem
migration: tudo compõe peças que já existiam.

Spec: `tests/e2e/chamar-o-cliente-primeiro.spec.ts`, em `SPECS_PARTE_3`. Quantos casos ela tem
hoje — este parágrafo dizia "8" e a spec já tinha 10 antes de ganhar os da J40:

```bash
grep -cE "^\s*test\(" tests/e2e/chamar-o-cliente-primeiro.spec.ts
```

### Execução (2026-09-19): **PASS nos 8 casos**

`e2e` no CI (`Run workflow` na branch, run 35442960641), Chromium real, Supabase
local com o `baseline.sql` aplicado, app em produção (`next build` + `next start`).
Parte 3: **89 passed (21,1 min)**; as três partes verdes.

Não rodou na máquina do autor: o daemon do Docker parou de baixar imagens no meio
da sessão — medido com controle, `docker pull hello-world` (13 KB) também não
completou em 25 s, então não era o Supabase nem a rede do host. O CI tem Docker
funcional, e é por isso que o `workflow_dispatch` existe.

| Caso | Prioridade | Resultado |
|---|---|---|
| J27.1 Contato sem conversa mostra **Chamar no WhatsApp** na lista, e o diálogo abre com o nome de quem se vai chamar | `[P0]` | **PASS** (5,3 s) |
| J27.2 O diálogo diz o que o canal permite **antes** de escrever — campo de texto OU aviso de modelo obrigatório, nunca os dois | `[P0]` | **PASS** (12,3 s) |
| J27.3 O botão de enviar fica travado sem conteúdo, destrava ao preencher e **volta a travar** ao apagar (controle positivo) | `[P0]` | **PASS** (29,2 s) |
| J27.4 O dossiê do contato oferece começar quando não há conversa (antes devolvia nada) | `[P1]` | **PASS** (30,9 s) |
| J27.5 A conversa nasce e o operador cai nela **mesmo se o envio não completar**; o motivo real volta em `erro_envio` | `[P0]` | **PASS** (30,4 s) |
| J27.6 Chamar duas vezes reaproveita a MESMA conversa (o índice 1-para-1 não tem filtro de status; um insert daria 23505) | `[P0]` | **PASS** (27,9 s) |
| J27.7 A rota de modelos responde com `exige_modelo` e a **chave pronta** de cada parâmetro | `[P1]` | **PASS** (28,5 s) |
| J27.8 Conexão de outra organização devolve 404 (a rota usa service role e filtra o tenant à mão) | `[P0]` | **PASS** (29,4 s) |
| J27.9 (2026-09-25, migration 0284) Com time cadastrado, o diálogo pede **Time da conversa**; com vários times começa vazio e o envio fica **travado** até escolher | `[P0]` | **PASS** (30,5 s) |
| J27.10 (2026-09-25, migration 0284) Sem `team_id` a rota recusa com 422 `team_required`; com time, a conversa volta com `team_id` gravado e **dono = quem chamou** | `[P0]` | **PASS** (29,2 s) |

**2026-09-25 — Devolver a conversa à fila do próprio time (troca de turno)** — `tests/e2e/devolver-ao-proprio-time.spec.ts`

| Caso | Prioridade | Estado |
|---|---|---|
| Atendente responsável abre **Transferir → Fila do time**; o diálogo diz a consequência antes do clique; a conversa volta **sem dono, no mesmo time, com o automático parado** (`bot_silenced_until = infinity`) | `[P1]` | **PASS** (4,3 s) |
| O rodízio não devolve a conversa a quem a devolveu (se só ele está elegível, ela espera) | `[P1]` | unidade: `lib/routing/worker-nao-devolve-a-quem-devolveu.test.ts` (sabotado: 2 vermelhos) |

**A primeira execução reprovou 6 dos 8, e o defeito era do TESTE** — vale registrar
porque é o argumento inteiro da doutrina em miniatura. `createContactHandler`
devolve `{ contact, action }`, o helper lia `data.id`, e o `undefined` chegava ao
`PATCH` seguinte como `invalid input syntax for type uuid` — um erro de banco, três
camadas longe da causa. Os 2 casos que não usam o helper passaram já naquela
rodada, e são justamente os que medem a rota nova e o isolamento entre
organizações.

Se a spec tivesse sido mesclada com o rótulo "não executada", ela entraria no
repositório **quebrada**, e o próximo push na `main` acusaria um vermelho que se
leria como regressão da feature.

**Não medido:** envio real contra uma WABA (não há credencial neste ambiente, e o
que a jornada prova é a decisão do operador, não o transporte); a tela em viewport
de telefone; e o canal com hetero-restrição em tela — o ambiente E2E usa o canal de
texto livre, então J27.2 exercitou o ramo livre e a exclusividade dos dois ramos,
não o formulário de parâmetros renderizado. Esse formulário está preso por
unidade (`tests/unit/chamar-o-cliente-primeiro.test.ts`, incluindo a derivação
compartilhada com o montador do payload).

### Um fato do produto que a spec teve de contornar — e que vale saber

**`POST /api/v1/contacts` abre a conversa sozinho** quando o corpo traz telefone e
a organização tem um canal vivo (`_handler.ts`, o `ensureConversation` best-effort
logo depois do insert). O `PATCH` não faz isso: só o create tem esse ramo.

Consequência para o produto, não só para o teste: o contato criado **pela tela**,
com telefone, em geral já nasce com conversa — então o botão "Chamar no WhatsApp"
aparece pouco nesse caminho. **Quem veio da importação é outra história**, e é o
caso que originou esta feature: o importador não chama `ensureConversation` em
lugar nenhum, então todo contato importado nasce sem conversa e o botão aparece.

A spec cria o contato em dois passos (sem telefone, depois `PATCH`) justamente para
reproduzir o estado do importado. Criar num `POST` só daria um contato que já tem
conversa, e os casos mediriam a tela errada — a lista mostraria "Abrir conversa"
onde a spec procura "Chamar no WhatsApp".

### O que FOI medido, e como

- **`pnpm test:unit`**: 929 de 930 arquivos verdes. 21 casos novos em
  `tests/unit/chamar-o-cliente-primeiro.test.ts`. O único vermelho é
  `leads-import-route` (11 casos), confirmado pré-existente rodando a suíte com
  as mudanças removidas — é o vermelho local de macOS já conhecido.
- **Os testes vigiam de verdade, provado por sabotagem** (não por eles
  passarem): fazer `slotKey` prefixar o corpo, zerar os valores do seletor da
  janela fechada e trocar o filtro de conexão por `.eq()` puro reprovam,
  respectivamente, 1, 1 e 1 caso; reverter devolve o verde.
- **`pnpm typecheck`**, **`pnpm lint`** (0 erros), **`pnpm lint:channels`**
  (nenhum provider nomeado fora de `lib/channels/`) e **`pnpm build`** (compilou
  em 41 s).

### Três defeitos achados na revisão, antes de sair — e o que eles ensinam

Nenhum dos três aparecia em typecheck, lint ou unitário de lógica. Os três
teriam ido para produção com o gate verde.

1. **`.omit()` em schema com `.refine()`** compila e falha ao importar, no Zod 4.
   Derrubou 184 arquivos de teste em cascata — só apareceu porque a suíte
   inteira foi rodada, e não os gates lembrados.
2. **Client de sessão numa rota que chama `fn_service_begin`**, que o baseline
   revoga de `authenticated`. Teria falhado em **100%** das chamadas.
3. **Filtro `.eq("channel_session_id", …)`** escondendo todos os modelos do canal
   oficial, porque o `syncTemplates` grava a coluna NULL — o defeito que este
   trabalho conserta, invertido e apontado justamente para o canal do pedido.

A lição comum: **os três só eram alcançáveis executando o caminho inteiro.** É
exatamente o argumento da doutrina de QA Visual, e é por isso que a ausência da
execução da spec acima é uma lacuna real, não uma formalidade.


## J28 — Chat do site: o dono cola um código, o visitante escreve, o atendente responde `[P0]` (2026-09-20)

Pedido do dono: uma **caixa de entrada nova**, além do WhatsApp — um widget de chat
para colocar no site (no dele e no de qualquer cliente), com **cores e textos
configuráveis**, que gere um **código para colar** e faça a conversa do visitante
nascer no atendimento. É o primeiro canal do produto que não é WhatsApp (migration
0272); mapa em `docs/architecture/chat-do-site.architecture.json`.

`[P0]` porque é primeira impressão **duas vezes**: a do dono, que cola o código e
espera ver um balão; e a do visitante do site do cliente dele, que é o público
final de todo mundo.

Spec: `tests/e2e/chat-do-site.spec.ts` (9 casos, em `SPECS_PARTE_3`), em **dois
navegadores** — o do dono e o do visitante, sem cookie compartilhado — e com o site
do cliente numa **origem diferente de verdade** (`http://site-do-cliente.test`),
para o `fetch` do widget atravessar CORS real contra o servidor real.

### Execução (2026-09-20): **PASS nos 9 casos**, na máquina do autor

Chromium real, Supabase local **pg15** com o `baseline.sql` aplicado em modo install
**e** update (as duas passadas com `ON_ERROR_STOP=1`, zero erro), Realtime reiniciado
depois do baseline, app em produção (`next build` + `next start`). **Sem Redis** — o
env opcional ausente, que é o estado de um primeiro deploy: o rate limit caiu no
contador em memória e a jornada inteira passou assim.

| Caso | Prioridade | Resultado |
|---|---|---|
| J28.1 O dono cria o chat, troca a cor e **vê a cor na prévia antes de salvar** (`background-color` medido por `getComputedStyle`); o código nasce com o endereço do servidor, nunca o placeholder do build | `[P0]` | **PASS** (1,2 s) |
| J28.2 Num site de **outra origem**, o balão aparece com a cor configurada — 56×56 px, a 20 px da borda direita (medido por `boundingBox`) | `[P0]` | **PASS** (0,1 s) |
| J28.3 O formulário **inteiro** cabe no painel sem rolar; enviar sem o nome obrigatório NÃO abre conversa; preenchido, a mensagem sai e o token fica no `localStorage` do site | `[P0]` | **PASS** (0,4 s) |
| J28.4 A conversa nasce no Inbox **marcada como vinda do site** (`data-meio="site_chat"`, ícone de globo) e o atendente responde pelo composer | `[P0]` | **PASS** (1,1 s) |
| J28.5 A resposta chega ao balão do visitante — e a mensagem vira **`delivered`** no CRM (o laço de retorno: foi o navegador buscar que a promoveu) | `[P0]` | **PASS** (0,9 s) |
| J28.6 Recarregar o site **não perde** a conversa, e quem já conversou não vê o formulário de novo | `[P0]` | **PASS** (0,1 s) |
| J28.7 Conexões passa a dizer **onde** o chat está instalado: `Instalado · site-do-cliente.test` | `[P1]` | **PASS** (0,3 s) |
| J28.8 Site fora da lista do dono: o balão **não aparece** e o site do cliente segue intacto (com controle positivo: o script CARREGOU) | `[P1]` | **PASS** (2,6 s) |
| J28.9 Excluir pede confirmação **nomeando o chat**; Cancelar não exclui; confirmado, o balão sai do ar na hora com o código ainda colado — e a conversa recebida continua no Inbox | `[P0]` | **PASS** (3,6 s) |

Evidência visual em `.superpowers/evidence/chat-do-site/` (9 imagens: a tela vazia, a
tela com prévia, o balão, o formulário, a conversa, o Inbox, "Instalado", telefone
390 px e notebook de 640 px de altura).

### O defeito que SÓ a imagem pegou — e que a spec deixou passar verde

Na primeira execução completa a spec deu **9/9**, e o produto estava quebrado na
primeira tela do visitante: no formulário, **telefone, mensagem e o botão "Iniciar
conversa" ficavam fora da vista**. A causa: a área de conversa "escondida" (`hidden`)
tinha `display:flex` no CSS do widget, e `display:flex` **vence** o atributo `hidden`
— ela seguia ocupando metade do painel e espremia o formulário, que rolava por dentro.

A spec passava porque **o Playwright rola até o elemento antes de clicar**. Uma pessoa
não sabe que há o que rolar. Quem achou foi abrir o PNG do formulário e ver meio
painel em branco.

Conserto na causa: uma regra só, `[hidden]{display:none !important}`, em vez de um
`[hidden]` por classe — a lista por classe é justamente a que alguém esquece de
completar (eu esqueci a `.corpo`). Junto: painel de 600 px, formulário mais compacto e
o botão **grudado no pé** (`position: sticky`), para que em tela baixa o formulário
role mas a única ação da tela nunca saia da vista. Medido depois:

| Viewport | Painel | Botão inteiro na vista |
|---|---|---|
| 1280×720 (spec) | 380×600 | sim — `toBeInViewport({ ratio: 1 })`, que considera o recorte dos ancestrais com rolagem |
| 1366×640 (notebook com barra de favoritos) | 380×528 | sim |
| 390×844 (telefone) | tela cheia, 390×844 | sim |

**A spec agora prende isso**, e a guarda foi sabotada para provar que morde: devolvendo
o CSS antigo, o J28.3 reprova em 136 ms.

### O CI reprovou duas vezes — e as duas causas eram minhas, não do produto

**1. A spec presumia a ABA.** Na primeira rodada do `e2e` no CI (run 35528903796) o
J28.4 reprovou: o card do visitante não apareceu no Inbox em 30 s. O produto estava
certo — o J28.3 tinha passado (o POST de outra origem deu 201) e a sondagem seguia com
o token. O screenshot da falha explicou: o Inbox abriu na aba **Fila** com 2 conversas,
e as outras abas mostravam 7, 1 e 4. No CI o banco é compartilhado com ~38 specs que
rodam antes e deixam rodízio e times configurados; a conversa nova é **atribuída** a
alguém e sai da Fila. Na minha máquina o banco era fresco e ela ficava lá.

Presumir a aba era medir o ambiente. A spec agora acha a conversa pela **busca da API**
(alcança o nome do contato, não depende de aba), confere o **meio** (`channel =
site_chat`) no mesmo payload que o card lê, e abre por link direto. O desenho do ícone
foi para `tests/unit/inbox-por-onde-entrou.test.tsx`, que não depende de banco nenhum —
com o controle: conversa de WhatsApp continua com telefone.

**2. `verify` reprovou com a suíte VERDE na minha máquina.**
`tests/unit/rotulo-do-contato.test.ts` proíbe remontar à mão a cadeia
`display_name || …`, e `canal.ts` tinha duas. Não apareceu local porque a varredura
lista arquivos com **`git ls-files`** — e eu rodei a suíte com os arquivos novos ainda
**não rastreados**: para ela, eles não existiam. Vale como regra de método: *arquivo
novo só é medido por esse tipo de varredura depois do `git add`*. O conserto foi usar a
regra única de nome de canal (`nomeDoCanal`, de `lib/channels/estado.ts`) — que é
também o certo por produto: a tela de Conexões e o Inbox chamam o canal do mesmo jeito.

### Endurecimento da rota pública, depois de uma revisão de segurança feita à mão

(A revisão por agente independente foi disparada duas vezes e morreu nas duas por limite
de uso, sem produzir achado — então a passada foi minha, e o que ela NÃO cobre está em
"Não medido".) Três mudanças, todas com teste em
`tests/unit/chat-do-site-rota-publica.test.ts`:

- **URL da página só `http(s)`.** Ela vem de um anônimo e é gravada em `metadata`; um
  `javascript:` guardado ali seria XSS armazenado esperando o primeiro `<a href>` de uma
  tela futura. Descartada na entrada — sem perder a mensagem.
- **Corpo acima de 32 KB: 413 antes de parsear.**
- **Teto por widget de 60 → 30 conversas novas / 10 min.** O balde por IP sai de
  `x-forwarded-for`, que quem não é navegador escreve como quiser; o que segura de
  verdade é o balde por widget.

### O que o laboratório exigiu, e que NÃO é do produto

O Chromium barra pedido de uma origem "pública" para `localhost` (*Local Network
Access*), e o ambiente E2E é exatamente isso. Medido pelo console da página antes de
mexer: *"The request client is not a secure context and the resource is in
more-private address space `local`"*. A spec desliga essa checagem (`test.use`, com o
motivo escrito); o CORS continua de pé — o preflight do POST acontece contra o servidor
real. Em produção o CRM está num domínio público com https, e de público para público a
regra não se aplica.

### Não medido

- **O agente de IA respondendo um visitante.** O canal nasce com a IA em modo de teste
  e o ambiente não tem credencial de modelo; o que está provado é que a entrada emite
  `ai_agent.dispatch_requested` pelo MESMO passo dos outros canais
  (`tests/unit/chat-do-site-entrada.test.ts`) e que o envio passa pelo MESMO handler.
- **Mídia** do atendente para o visitante (imagem, áudio, arquivo): a leitura assina o
  link do nosso bucket e o widget sabe desenhar — preso por unidade, não por tela.
- **Um site de verdade com CSP restritiva**: o dono desse site precisa liberar o domínio
  do CRM em `script-src` e `connect-src`. Não há o que o widget faça por ele.
- **Safari/Firefox**: a spec roda em Chromium.
- **Carga**: os limites de `lib/channels/chat-do-site/http.ts` estão presos por valor no
  teste da rota, mas ninguém martelou a rota de verdade.
- **Revisão de segurança por um segundo par de olhos.** A superfície pública foi revisada
  só por quem a escreveu. É o item desta lista que mais merece ser refeito.

---

## J29 — Cadastrar um membro já com senha, e ele entrar sem e-mail `[P0]` (2026-09-22)

Pedido do dono: *"cadastrar um membro da equipe e, ao invés de receber o convite, eu já
cadastrasse a senha dele aqui dentro e já ficasse tudo resolvido"*. O convite dependia de
e-mail, e numa instalação sem envio configurado — toda VPS recém-instalada, e a produção do
dono nesse dia — virava um link copiado de uma tela marcada "(DEV)". Desenho em
`docs/superpowers/specs/2026-09-22-cadastrar-membro-com-senha-design.md`; mapa em
`docs/architecture/equipe-cadastro-com-senha.architecture.json`.

`[P0]` porque o primeiro convite é primeira impressão (está na lista da doutrina de QA
Visual), e porque a porta anterior simplesmente não funcionava sem e-mail.

Spec: `tests/e2e/equipe-cadastro-com-senha.spec.ts` (em `SPECS_PARTE_3`), com **dois
navegadores** — o do admin e o do membro, sem cookie compartilhado.

### Execução (2026-09-22): **PASS**, na máquina do autor

Chromium real, Supabase local **pg15** com o `baseline.sql` aplicado em banco novo
(`ON_ERROR_STOP=1`, zero erro), Realtime reiniciado depois do baseline, app em produção
(`next build` + `next start`). **Sem `RESEND_API_KEY` e sem Redis** — os envs opcionais
ausentes, que é o estado de um primeiro deploy.

| Caso | Prioridade | Resultado |
|---|---|---|
| J29.1 De **Equipe**, o botão **Adicionar membros** leva ao cadastro, e **Cadastrar com senha** é a aba aberta (`aria-selected=true`) | `[P0]` | **PASS** |
| J29.2 **Gerar senha** preenche **e mostra** (o campo vira `type=text`), no formato de três blocos de quatro sem 0/O/1/l/I | `[P0]` | **PASS** |
| J29.3 Depois de cadastrar, o cartão **Dados de acesso** mostra endereço (`…/login`), e-mail e a senha digitada; o formulário limpa | `[P0]` | **PASS** |
| J29.3b O cartão **vem para a vista** e recebe o foco: o botão fica no fim de um formulário longo e o cartão nasce no topo da coluna ao lado. Medido por `elementFromPoint` logo abaixo do topo do cartão (dentro da janela, não coberto pelo cabeçalho fixo). **Achado pela evidência desta própria jornada** — na primeira execução, a senha ficava fora da tela numa janela de 1280×720; a medida reprovou o build antigo e aprovou o consertado | `[P0]` | **PASS** |
| J29.4 Banco: conta com e-mail **já confirmado** e `full_name`; vínculo `agent` aceito; `app_metadata.senha_definida_por_admin` = a org do admin; **uma** `member.created` na auditoria, **sem a senha** | `[P0]` | **PASS** |
| J29.5 A pessoa entra com a senha num navegador limpo e cai no app com o menu do papel dela (avatar com as iniciais do nome cadastrado) | `[P0]` | **PASS** |
| J29.5a Com a senha que o admin escolheu, o convite de **outra organização** é recusado na tela de aceite, com a saída escrita ("troque-a… em Configurações › Perfil › Trocar senha"); o banco confirma que não virou vínculo | `[P0]` | **PASS** |
| J29.5b **Configurações › Perfil › Trocar senha**: senha atual errada → "A senha atual não confere."; certa → "Senha trocada."; a marca some do banco e a sessão continua de pé | `[P0]` | **PASS** |
| J29.5c Depois de trocar, o **mesmo** convite de fora entra (vínculo ativo na outra org) | `[P0]` | **PASS** |
| J29.6 Recadastrar o mesmo e-mail responde, ao lado do formulário, **"Esta pessoa já faz parte da equipe."** | `[P1]` | **PASS** |
| J29.7a **Membros › ⋯ › Definir nova senha** para quem **também responde à outra org** → recusado dentro do diálogo ("só ela pode trocar a própria senha") | `[P0]` | **PASS** |
| J29.7b Sem o vínculo de fora, o diálogo gera, salva e avisa; a marca volta ao banco | `[P0]` | **PASS** |
| J29.8 A senha **anterior** (a que a própria pessoa escolheu) passa a dar "Email ou senha incorretos."; a **nova** entra | `[P0]` | **PASS** |
| J29.9 Em 390 px de largura, **Adicionar membros** não rola para o lado (`scrollWidth ≤ clientWidth + 1`, medido) e as duas abas cabem | `[P1]` | **PASS** |

Evidência visual em `.superpowers/evidence/equipe-cadastro-com-senha/` (9 imagens: o
cartão de acesso, o membro dentro do app, o convite de fora recusado, a troca da própria
senha, a recusa de recadastro, a recusa de "Definir nova senha" para quem responde a outra
org, o diálogo de nova senha, a entrada com a senha nova e a tela em 390 px).

### A revisão de segurança que mudou esta jornada

Uma revisão adversarial independente do PR (antes do merge) achou dois caminhos graves, os
dois consertados na causa e agora medidos acima:

1. **A senha que o admin escolhe atravessava para outra organização.** O admin da org A
   conhece a senha; se a pessoa depois aceitasse convite da org B, o admin A entraria em B
   como ela. Agora a conta carrega `app_metadata.senha_definida_por_admin` (só a chave de
   serviço escreve ali), `aplicarConvite` recusa convite de outra org enquanto a marca
   existir, e ela cai quando a pessoa troca a própria senha (J29.5a–c). Para isso nasceu
   **Configurações › Perfil › Trocar senha**, que não existia.
2. **A entrega do criador provisório virava fachada.** Quem abriu a org para outra pessoa
   poderia cadastrar o dono como admin com uma senha que ele mesmo escolheu. Agora é
   recusado: o dono entra por convite. Preso por unidade (a instalação do e2e não tem
   criador provisório).

E mais: leitura com erro abre a guarda (agora fecha), o próprio id em maiúsculas contornava
"a própria senha" (agora UUID canônico — e o teste que dizia medir isso era VAZIO, porque o
id de teste só tinha dígitos), corpo `text/plain` aceito (agora 415), acompanhamento podia
criar credencial (agora 403), e o campo `type="password"` levava a senha do membro ao cofre
do navegador do admin (agora é texto visível).

Rodadas junto, sem regressão: `interface-por-vinculo` (o convite pela tela agora abre por
`/app/team/invite?modo=convite`), `invite-lifecycle` (os 9 casos do ciclo do convite),
`qa-equipe-pinta-na-hora` e `qa-titulos-das-telas` — **20 passed**.

### O que NÃO foi medido

- **"Definir nova senha" recusando admin de plataforma e membro revogado**: preso por
  unidade contra o handler real (`tests/unit/team-definir-senha.test.ts`), não pela tela. A
  recusa por outra organização, essa sim, foi pela tela (J29.7a).
- **Criador provisório tentando cadastrar um `admin`**: preso por unidade
  (`tests/unit/team-cadastro-com-senha.test.ts`); a instalação do e2e não tem criador
  provisório.
- **Troca da própria senha numa conta com segundo fator**: preso por unidade
  (`app/actions/settings/trocarMinhaSenha.test.ts`); o membro do e2e não tem TOTP.
- **Sessões abertas do membro depois de "Definir nova senha"**: não se mediu se o provedor
  de auth as encerra. A rota não encerra nada por conta própria — a API de admin do cliente
  JS não oferece encerrar sessão por id. Quem precisa tirar alguém de dentro na hora usa
  "Revogar acesso".
- **Telemetria**: a redação do corpo da requisição está presa por unidade
  (`lib/sentry/scrub.test.ts`); nenhum evento real foi enviado a um Sentry.

---

## J9 — Ver o que o follow-up já fez, e intervir sem matá-lo `[P1]`

Contexto do código: o dossiê do enrollment (`/app/ai/followups/enrollments/[id]`,
wave FV-W1-FILA). `followup_enrollment_events` gravava cada passo do motor desde a
0054 e **nenhuma tela lia a tabela**; a única intervenção possível era cancelar.
Spec: `tests/e2e/followup-dossie.spec.ts` — os eventos da timeline são REAIS (o
setup publica um fluxo, cria o enrollment pela API e chama o cron
`followup-flow-worker`, o mesmo caminho de produção; nada de `INSERT` à mão).

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J9.1 | Clicar no contato na aba Fila | abre o dossiê daquele follow-up (rota própria, sobrevive ao F5) | PASS |
| J9.2 | Ler a história depois de dois ticks do motor | "Seguiu em frente" e "Começou a esperar"; **nenhum** `node_advanced` nem `wait-1` na tela | PASS |
| J9.3 | Onde está agora | "Deixa esfriar (Espera — espera 4 horas)" + quando volta a andar | PASS |
| J9.4 | Pausar | status vira "Pausado por uma pessoa"; próximo passo vira "Parado até alguém retomar" | PASS |
| J9.5 | Pausado não oferece adiar/pular | botão que só sabe recusar não aparece | PASS |
| J9.6 | Retomar | volta a andar pelo tempo que FALTAVA (não dispara na hora) | PASS |
| J9.7 | Adiar para uma data escolhida | o próximo disparo passa a ser a data do diálogo | PASS |
| J9.8 | Pular o passo | o follow-up anda para o passo seguinte; com mais de um caminho, a tela PERGUNTA por onde | PASS |
| J9.9 | A intervenção aparece na timeline do NEGÓCIO | as **quatro** linhas no card, com autor humano nomeado ("E2E Manager") e sem colapsar apesar de terem acontecido no mesmo minuto | PASS |
| J9.10 | Viewer | lê o dossiê inteiro, sem coluna de ações; as 4 rotas devolvem 403 `forbidden_role` | PASS |
| J9.11 | O tempo que a IA escolheu, com plano REAL | "esperar 12 horas" + "bateu no seu limite" + **"a IA pediu 3 dias"** + o motivo e a faixa configurada | PASS |
| J9.12 | A história do planejamento em português | "O agente decidiu quanto esperar em cada passo" e "Pediu ao agente para planejar os tempos de espera" — sem `timing_plan_decidido` na tela | FAIL → PASS |

Evidência (uma por passo, na ordem da jornada):
`evidence/followup-dossie/01-dossie-timeline.png` ·
`evidence/followup-dossie/02-pausado.png` ·
`evidence/followup-dossie/03-adiado.png` ·
`evidence/followup-dossie/04-pulado.png` ·
`evidence/followup-dossie/05-timeline-do-negocio.png` ·
`evidence/followup-dossie/06-viewer-so-leitura.png` ·
`evidence/followup-dossie/07-plano-de-tempo.png`.

**J9.11/J9.12 usam plano REAL, não `INSERT` à mão:** o modelo "responde" pelo
seam `completeTurnForEnrollment` — a mesma função que o worker chama depois da
chamada de LLM —, então o clamp, a gravação e o `proposto_ms` são os de
produção. Um jsonb escrito na mão provaria que a tela desenha o que eu inventei.

**O J9.12 nasceu FAIL e é por isso que ele existe:** abrindo o dossiê, a
história mostrava `código: timing_plan_decidido` e anunciava o turno de
planejamento como "escrever a mensagem". Nenhum unitário pegaria — os dois
eventos são do motor novo, e a tela foi o único instrumento que os viu.

**O que o J9.9 mediu e quase passou batido:** as quatro intervenções acontecem
no mesmo minuto e pelo mesmo ator, e a timeline do negócio COLAPSA blocos assim
(`agrupaTimeline`, janela de 60s). Escondidas atrás de um "+", o próximo
atendente abriria o card e não veria que uma pessoa segurou o fluxo — que é a
única razão de a linha existir. Os quatro tipos entraram em `NUNCA_COLAPSA`
pelo critério que já estava escrito lá: decisão humana não colapsa.

---

## J10 — Marca própria: o revendedor põe a cara dele no sistema `[P0]`

Contexto do código: o épico de marca própria (PR #248 e a continuação). São
**duas camadas** que nunca se misturam — a da INSTALAÇÃO, que o dono do servidor
define e vale para todo mundo, inclusive nas telas de acesso de quem ainda não
entrou; e a da ORGANIZAÇÃO, que o admin do tenant define e vale só dentro dela.
Specs: `tests/e2e/marca-logo.spec.ts`; invariantes de banco em
`tests/invariants/marca-{logo,da-instalacao,da-organizacao}.test.ts`.

`[P0]` porque é primeira impressão em dois sentidos: é o que o revendedor mostra
ao cliente dele, e a tela de acesso é a primeira coisa que qualquer usuário vê.

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J10.1 | O dono do servidor sobe o logo da instalação | aparece na barra lateral dele, e a prévia mostra sobre fundo claro E escuro | **NÃO EXECUTADO** |
| J10.2 | Quem NÃO entrou vê o logo do dono na tela de acesso | as 6 telas públicas mostram a marca da instalação, sem sessão | **NÃO EXECUTADO** |
| J10.3 | O logo da EMPRESA troca a barra dela e não vaza | a camada da organização não alcança a tela de acesso, que é da instalação | **NÃO EXECUTADO** |
| J10.4 | SVG renomeado com extensão de imagem comum | recusado **pelos bytes**, não pela extensão, com a razão dita em português — SVG executa código quando aberto direto pelo endereço | **NÃO EXECUTADO** |
| J10.5 | Remover o logo da empresa | devolve o da camada de baixo (a instalação), não "nenhum" | **NÃO EXECUTADO** |
| J10.6 | O instalador pergunta a cor da marca | `APP_ACCENT_HEX` no `install.sh`, com validação — o revendedor não recebe o verde do produto | PASS (`tests/shell/`) |
| J10.7 | Nome com apóstrofo (`Sant'Ana Odontologia`) | o `.env` sobrevive: 18/18 nos três consumidores de compose | PASS |
| J10.8 | Cor escura de marca não quebra o contraste | o anel de foco respeita o piso de 3:1 em ambos os temas | PASS (unit) |

**Bug de produto achado ao executar (2026-08-14), e é o que justifica esta jornada
existir.** O caso J10.1 reprovou no CI, e não por defeito do teste: quem sobe o
logo lia `"Logo atualizado."` e **a tela não mudava**, por até 30 segundos.

A causa não era a que qualquer um chutaria. `lib/branding/instalacao.ts` é
instanciado **duas vezes dentro do mesmo processo** — o Turbopack emite um runtime
de servidor para as 206 rotas de API e outro para as 98 páginas, cada um com o
próprio cache de módulos. A rota de upload invalidava um memo que **nenhuma tela
lê**; a troca só aparecia quando o TTL expirasse sozinho.

O que fecha o diagnóstico é o controle: a server action que troca nome e cor
chama a MESMA função e sempre funcionou, porque é compilada no runtime das
páginas. Mesma função, mesmo processo, resultados opostos — a variável era o
runtime.

Isto é exatamente o que a doutrina de QA Visual existe para pegar: nenhum teste
unitário veria, porque a lógica está certa; o defeito mora em como o bundler
divide o servidor. Só aparece exercitando o produto pela tela.

> ⚠️ **Os cinco `NÃO EXECUTADO` são honestos, não pendências esquecidas.** A spec
> existe, tem 6 casos e está na `SPECS_PARTE_2` do CI — mas nunca rodou: o Docker
> da máquina de desenvolvimento está com o disco da VM corrompido, e o `e2e` do
> CI é a primeira execução dela na vida. Um revisor cético mediu a spec na fonte
> do Playwright e achou 3 defeitos que a reprovariam (testes sem login, e a
> restauração feita como `test` num `describe` serial — que é justamente o que
> não roda quando um caso falha). Corrigidos antes da primeira execução; o
> resultado real entra aqui quando o CI disser.

## J12 — A tela diz o que ESTA instalação consegue fazer `[P0]`

**Por que P0:** é primeira impressão pura. **Nenhuma instalação nasce com o par
VAPID** — o `.env.hostgator.example` grava as duas linhas vazias e gerar o par é
um passo opcional que ninguém é obrigado a dar. Ou seja, o estado testado aqui é
o estado em que 100% das instalações começam, e a tela de Notificações tem porta
na navegação (`lib/navigation/registry.ts:470`), então qualquer pessoa chega nela
no primeiro dia.

**O defeito era de tela, e o backend estava certo o tempo todo.**
`GET /api/v1/notifications/push` já devolvia `enabled:false` sem as chaves, e o
`PUT` já recusava com 503 «Web Push não configurado nesta instalação». Quem nunca
perguntou foi `app/app/settings/notifications/page.tsx`, que afirmava «In-app
(toast) e Push (Chrome) já funcionam para as cinco categorias» de forma
incondicional. A sequência que a pessoa vivia:

1. a tela promete Push;
2. ela liga o interruptor e o navegador pede permissão — incômodo real, cobrado dela;
3. ela concede, e `syncPushSubscription()` faz `return` em silêncio
   (`if (!cfg?.data?.enabled || !publicKey) return`);
4. o interruptor fica ligado prometendo o que a instalação não entrega, e **nada
   no produto** conta que faltam duas variáveis no `.env`, nem como consegui-las.

Informação que existe no servidor e não chega a quem decide é o mesmo que
informação ausente.

**O conserto exagerado, recusado de propósito:** desabilitar o interruptor sem
VAPID. Sem as chaves o aviso na bandeja **ainda funciona com a aba aberta** —
é `new Notification()` em `lib/notifications/emit.ts`, que não depende de
inscrição nenhuma. Desabilitar trocaria prometer demais por entregar de menos, e
o segundo não deixa rastro. **J12.5** existe para impedir esse conserto (era
J12.3, no `e2e`, até a medição mostrar que ali ela não era observável — ver
abaixo).

Spec: `tests/e2e/notificacoes-diz-o-que-falta.spec.ts` (estado SEM as chaves —
o do `.env.e2e` e o do primeiro deploy).
Evidência: `.superpowers/evidence/notificacoes-sem-chaves/`.
Os DOIS estados: `tests/unit/notificacoes-tela-diz-o-que-falta.test.tsx` — o
servidor lê `vapidPronto()` uma vez por processo, então provar o estado COM as
chaves pela tela exigiria um segundo `next start` só para trocar duas variáveis,
num job que já leva meia hora.

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J12.1 | Sem VAPID, a tela não fica muda | aviso `push-status-faltando-chaves` visível, e o de «pronto» ausente | PASS |
| J12.2 | Ela diz o que FAZER, não só o que falta | o comando `npx web-push generate-vapid-keys` e as duas chaves, nominalmente | PASS |
| J12.3 | O controle de Push não some, e a tela diz por que está travado | interruptor visível + «o navegador bloqueou as notificações» | PASS |
| J12.5 | VAPID ausente NÃO desabilita o Push | com `granted` e sem chaves, nasce habilitado | PASS (unit) |
| J12.4 | Com VAPID, anuncia a aba fechada | e para de mandar gerar o par que já existe | PASS (unit) |

**Por que J12.5 não é `e2e`, medido e não suposto.** Ela nasceu como asserção
`toBeEnabled()` na spec, e não podia viver lá. Medido no Chromium do Playwright,
contra um servidor HTTP local:

    baseline headless                              -> denied
    grantPermissions(["notifications"]) sem origin -> denied
    grant com origin explícito                     -> denied
    headless:false + grant                         -> granted

`Notification.permission` é **`denied` em headless, sempre**, e o CI roda
headless. Como `_client.tsx` desabilita por `denied || unsupported`, o controle
está travado ali por um motivo que nada tem a ver com VAPID — e nenhuma
permissão concedida muda isso. A asserção passou uma vez só porque ganhava a
corrida contra a hidratação; fechada a janela (`useSyncExternalStore` no hook),
ela passaria a falhar sempre, e com razão.

**NÃO COBERTO, declarado:** a notificação chegando na bandeja do sistema com a
aba fechada. Depende do serviço de push do navegador (FCM), de rede externa e de
um par VAPID real — não é reproduzível num runner, e fingir com mock seria pior
que a ausência declarada. O que está provado é o contrato entre a TELA e o
SERVIDOR. Continua aberto na issue #366.

## J13 — A Agenda como o dono do produto a usou na VPS `[P0]`

**Por que P0:** é a primeira impressão de um módulo que acabou de sair (v1.7.0).
O dono instalou na VPS dele, usou como um cliente usaria, e achou **seis defeitos
em quinze minutos**. Um sétimo aparecia no log de produção a cada cinco minutos e
ninguém tinha visto; um oitavo saiu de varredura. Todo módulo novo tem uma janela
em que ninguém o usou de verdade — esta jornada existe porque ela custou oito.

**O que a suíte não conseguia enxergar, e por quê.** Toda spec até aqui roda com
usuário de UMA organização. O defeito de escopo (D4) é invisível nesse cenário
por construção: sem duas organizações, a RLS e o filtro explícito devolvem
exatamente o mesmo conjunto. `scripts/seed-e2e-duas-organizacoes.ts` monta o
cenário que faltava — o MESMO usuário em duas orgs, com um tipo exclusivo em cada
uma, para a asserção poder ser sobre o CONJUNTO DE NOMES e não sobre a contagem.

| # | Caso | Resultado |
|---|---|---|
| J13.1 | Membro de duas organizações abre a Agenda e vê só os tipos da org ativa; trocar de organização troca a lista | **PASS** — `agenda-escopo-da-organizacao.spec.ts`, contra o app real. Evidência: `evidence/calendario/d4-agenda-escopo-org-b.png` |
| J13.2 | O aviso "você ainda não publicou seus horários" LEVA até onde se publica, e a aba de Atendimento se anuncia como o lugar dos horários | **PASS** — `agenda-caminho-ate-os-horarios.spec.ts`. Evidência: `evidence/calendario/d1-aba-atendimento.png` |
| J13.3 | Endereço de aba desconhecido cai na aba padrão, não numa tela sem conteúdo | **PASS** — mesma spec |
| J13.4 | O tipo de agendamento NASCE com responsável; quem escolhe "Definir depois" é avisado e o aviso ABRE o seletor | **PASS** — `agenda-tipos-de-agendamento.spec.ts`. Evidência: `evidence/calendario/d6-tipo-com-responsavel.png` |
| J13.5 | O dia apagado diz POR QUÊ, e o rótulo genérico antigo não volta | **PASS** — `agenda-kit-visual.spec.ts` |
| J13.6 | O teto de capacidades recusa a passagem explicando quantas vagas faltam | **PASS** — `capacidades-do-agente.spec.ts`, com o teto em 25 |
| J13.7 | A ida ao Google seleciona os pendentes (o filtro antigo devolvia HTTP 400) | **PASS** — medido contra o PostgREST real do ambiente e2e: filtro antigo `400 / 22007`, filtro novo `200` com as linhas pendentes |
| J13.8 | Sincronizar tira a linha da fila, e editar recoloca (o laço dos dois relógios) | **PASS** — medido no Postgres real: `true` → `false` com delta `00:00:00` → `true` |
| J13.9 | A credencial do Google não é servida pelo PostgREST | **PASS** — `anon` recebe `42501 permission denied`; `service_role` recebe 200 (controle positivo) |
| J13.10 | Cadastrar a credencial do Google pela tela do admin | **NÃO EXERCITADO** — a tela e a server action existem e o `next build` passa, mas o ambiente e2e não tem a chave mestra de cifra semeada (`fn_encrypt_oauth` levanta `NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente`), que é justamente o caminho em que a action RECUSA gravar. Falta o caso pela tela com a chave presente |

**Registro honesto do que NÃO foi exercitado:** `pnpm test:db` não rodou nesta
máquina — o daemon do Docker travou depois de o disco encher, e o harness de
invariantes exige contêiner. Os dois invariantes novos
(`agenda-ida-ao-google-termina`, `credencial-do-google-e-server-side`) estão
escritos e a SUBSTÂNCIA deles foi medida à mão contra o Postgres real do
ambiente e2e; falta a passada do harness no CI.

---

## J14 — Marcar um horário, na tela em que o dono marcou `[P0]`

**Por que P0:** os dois defeitos aqui impedem a ação central do módulo — escolher
um horário e chegar até ele. O dono achou os dois usando a v1.8.0 na VPS.

**A crítica que originou esta jornada, e ela é justa:** havia 20 casos Playwright
sobre esta tela (a J13) e nenhum pegou. Todos assertam PRESENÇA (`toBeVisible`,
`toHaveCount`), e **elemento cortado continua presente** — está no DOM, tem
tamanho, e o Playwright o considera visível. A borda que o corta é do PAI.
Presença nunca vai medir isto; só geometria mede.

| # | Caso | Resultado |
|---|---|---|
| J14.1 | A coluna de horários cabe no painel, e o painel no Sheet que o hospeda | **PASS** — `agenda-painel-cabe-na-tela.spec.ts`, por `boundingBox` em cinco larguras. Antes: painel de 982px num Sheet de 768, transbordando 239px |
| J14.2 | A coluna de horários fica dentro da VIEWPORT | **PASS** — antes, só 42 dos 280px apareciam, em 1280, 1440 e 1920 |
| J14.3 | Dá para CLICAR num horário | **PASS** — a geometria é o diagnóstico; a ação é o desfecho. Evidência: `evidence/calendario/d1-painel-cabe-1280.png` |
| J14.4 | Abaixo de `lg` os horários empilham sob o calendário | **PASS** — caso de 900px |
| J14.5 | O limiar de 1024px, onde as 3 colunas passam a valer com 44px de folga | **PASS** — é onde um ajuste de padding estoura primeiro |
| J14.6 | "Ver na agenda" leva até o compromisso, inclusive em outra semana | **PASS** — `agenda-ver-na-agenda.spec.ts`. O botão não tinha `onClick` nenhum. Evidência: `evidence/calendario/d2-ver-na-agenda.png` |

**Duas correções ao diagnóstico inicial, ambas medidas:**
1. O defeito de largura **não sumia em tela grande** — em 1920 o transbordo era
   idêntico, porque o Sheet é fixo em 768px e ancorado à direita.
2. A primeira versão da asserção de geometria media "coluna contra painel" e
   ficava vermelha — mas por medir no meio da transição de `width`. No estado
   estável ela PASSA. Falso vermelho hoje é falso verde amanhã; a spec passou a
   esperar a largura estabilizar, e a régua certa é o painel contra o Sheet.

**Sobre um diagnóstico que a medição derrubou:** ao ver 4 falhas num run de 5
specs juntas, atribuí ao `AUTH_RATE_LIMIT_LOGIN_IP` que o CI define e o ensaio
local não. **Estava errado** — o run seguinte passou 30/30 sem essa variável, e o
seguinte também. A diferença era tempo: 51s contra 11,2min, com um `next build`
disputando CPU. A diferença de ambiente entre ensaio e CI é real e vale saber,
mas não era a causa desta falha.

## J15 — A grade da Agenda como agenda de verdade `[P0]`

**Por que P0:** é a tela que quem atende deixa aberta o dia inteiro, e ela era
**desenho**. Sete colunas, faixas de hora, cards — e nenhum gesto: clicar num
espaço vazio não fazia nada, arrastar um compromisso não fazia nada. Marcar
exigia sair da grade, abrir "Novo agendamento" e reescolher no mini-calendário a
data que a pessoa acabara de apontar com o dedo. Nenhuma spec reprovava, porque
nenhuma spec tentava: as irmãs entram pelo botão e pelo histórico, que são
caminhos que já existiam.

**O jeito errado de consertar, e o que o vigia.** Calcular o horário a partir do
pixel clicado. A tela passaria a oferecer instantes que a disponibilidade
publicada não tem — 422 `agenda_disponibilidade_invalida` na cara de quem
clicou, e a agenda discordando do agente sobre o que está livre. A defesa é de
construção: a grade **pergunta** a `GET /api/v1/agenda/horarios-livres` (a mesma
rota do painel e do agente) e um bloco só é clicável quando existe horário
publicado ali. Ela não tem de onde tirar um instante que a regra não deu.

| # | Caso | Resultado |
|---|---|---|
| J15.1 | Clicar num bloco livre abre a marcação **naquele horário** — a asserção é o horário exibido, não que "algo abriu" | **PASS** — `agenda-grade-interativa.spec.ts`. Evidência: `evidence/calendario/grade-clique-abre-no-horario.png` |
| J15.2 | Bloco fora da disponibilidade não é clicável **e diz por quê** (`disabled` + razão no `aria-label` e no `title`) | **PASS** — mesma spec. Evidência: `evidence/calendario/grade-bloco-recusado-diz-por-que.png` |
| J15.3 | Arrastar um card remarca, e o horário novo é conferido **na API depois do reload** — não só na tela | **PASS** — mesma spec. Evidência: `evidence/calendario/grade-arraste-fantasma.png` e `evidence/calendario/grade-confirma-antes-de-remarcar.png` |
| J15.4 | Arrastar para fora da disponibilidade é recusado com o motivo, **nenhum PATCH sai**, e o card volta ao lugar (medido por `boundingBox`) | **PASS** — mesma spec. Evidência: `evidence/calendario/grade-arraste-recusado.png` |
| J15.5 | Geometria por ferramenta: o topo do card remarcado contra o topo da faixa daquela hora, tolerância de 2px | **PASS** — mesma spec |
| J15.6 | Remarcar pelo **teclado** (`Alt+↑/↓` salta de vaga em vaga, `Enter` confirma, `Esc` desfaz) pelo mesmo mecanismo do arraste | **PASS** — `tests/unit/agenda-grade-aceita-clique.test.tsx` (jsdom — o arraste por ponteiro precisa de geometria real e fica no Playwright) |

**As asserções foram provadas vermelhas antes**, e não só escritas depois:

| Sabotagem | Previsão | Medido |
|---|---|---|
| A camada de blocos vazios volta a não existir (a grade de antes) | 4 vermelhas | **4 vermelhas**, todas em "nenhum bloco livre na semana desenhada" |
| A recusa vira pergunta **e** o destino válido remarca sem confirmar | J15.3 e J15.4 vermelhos, J15.1 e J15.2 verdes | **exatamente isso** — "soltar remarcou sem perguntar" e `remarcacao-recusada` não encontrado |

**Dois defeitos que só apareceram executando** (nenhum apareceria lendo o código):

1. A grade oferecia a disponibilidade de `tiposIniciais[0]` — o primeiro tipo em
   **ordem alfabética**, escolhido por ninguém e sem seletor fora do painel de
   marcação. Numa organização com quatro tipos e jornada publicada em um só, a
   grade inteira travava com "não consegui carregar os horários" **enquanto
   havia vaga**. O tipo ganhou superfície na tela.
2. Card de compromisso **cancelado** cobria o bloco vazio e comia o clique — e
   cancelar é justamente o que devolve o horário (`cancelled` está em
   `SITUACOES_QUE_LIBERAM`). Numa clínica com uma semana de cancelamentos, todo
   horário reaberto ficaria inalcançável pela grade. O card perdeu o ponteiro e
   manteve a presença: é registro, não ação.

---

## J16 — Conectar o Google, e conseguir enxergar que conectou `[P0]`

**Por que P0:** o dono instalou a v1.9.0 e relatou quatro sintomas numa frase só
— "conecto, ELE DESLOGA DA MINHA CONTA, quando logo de novo diz que conectou, mas
nada funciona e o botão Conectar continua lá". Três defeitos independentes, e o
mais humilhante é que **a conexão sempre funcionou**: ninguém conseguia ver.

| # | Caso | Resultado |
|---|---|---|
| J16.1 | Voltar do consentimento não cai no `/login` | **PASS** — `agenda-google-volta-nao-desloga.spec.ts`. Sem o conserto, o usuário logado para em `/login?next=%2Fapp%2Fagenda%3Ferro%3D...`, medido em Chromium |
| J16.2 | O CHECK do banco proíbe o valor que três consultas procuravam | **PASS** — invariante `agenda-conexao-do-google-e-encontrada`, contra Postgres real |
| J16.3 | A conexão que o callback grava é encontrada pelo predicado do worker | **PASS** — mesmo invariante: 1 achada com o valor certo, 0 com o antigo |
| J16.4 | Nenhuma consulta filtra por valor que a coluna proíbe | **PASS** — varredura `consulta-usa-o-vocabulario-do-banco`; previ 3 achados antes de rodar e vieram os 3 |
| J16.5 | A lista de horários rola, e o último horário é clicável | **PASS** — `agenda-painel-cabe-na-tela.spec.ts`, viewport 1280×700. Evidência: `evidence/calendario/d4-lista-rola-1280x700.png` |

**Três correções ao briefing, todas medidas:**
1. A retenção do cookie no segundo salto era **dedução** marcada NÃO MEDIDA. Foi
   observada em navegador: é real, em Chromium. (Firefox não foi medido.)
2. A régua anti-regressão proposta (`body.scrollHeight - innerHeight <= 1`) vinha
   com a nota "já passa hoje". **Não passa** — e o crescimento é idêntico com e
   sem o conserto (1566px nos dois), portanto pré-existente. A régua passou a
   medir o que queria proteger: que o Sheet continua `position: fixed`.
3. A pré-condição de suficiência da lista comparava o conteúdo com a altura da
   JANELA; a régua certa é o espaço abaixo do topo da lista. Da primeira forma
   ela reprovou um cenário suficiente.

**Dívida declarada, não consertada aqui:** com o painel aberto em 1280×700 o body
vai a 1566px contra 700 de janela. É anterior a este PR e misturá-la esconderia
as duas.

---

## J22 — Cadastrar o App da Meta pela tela, e colar na Meta o token que vale `[P0]`

**Por que P0:** é a primeira coisa que o dono faz para receber pelo número
oficial. Até a tela `/admin/meta` existir, isso exigia editar o `.env` na VPS
(issue #850); a migration 0257 (PR #861) guardou a credencial no banco, mas
nenhuma tela a gravava.

| # | Caso | Resultado |
|---|---|---|
| J22.1 | Admin Plataforma › API Oficial (Meta) aparece no menu e abre a tela | **PROVADO EM TELA** (2026-09-15, `33ece762a`) — pelo seletor de organização › Gerenciar organizações › menu, sem digitar URL. Evidência: `evidence/triagem-15set-l8/861-02-menu-admin-api-oficial.png` |
| J22.2 | Primeiro save com a chave secreta mostra o token gerado, com Copiar | **PROVADO EM TELA** — campo esvazia, placeholder "(já cadastrada)", Copiar põe o token na área de transferência (lido de volta). `evidence/triagem-15set-l8/861-04-token-gerado-copie-agora.png` |
| J22.3 | Recarregar a página: o token some, a tela diz "Gerado em …" | **PROVADO EM TELA** — o token não está nem no HTML servido. `evidence/triagem-15set-l8/861-07-recarregado-token-some.png` |
| J22.4 | Gerar novo token pede confirmação com o efeito, e mostra o novo | **PROVADO EM TELA** — cancelar não muda `verify_token_created_at`; confirmar mostra token diferente. `evidence/triagem-15set-l8/861-08-confirmacao-novo-token.png`, `evidence/triagem-15set-l8/861-09-novo-token-diferente.png` |
| J22.5 | Handshake da Meta (`GET …/webhooks/meta/<token>?hub.verify_token=`) passa com o token da tela e recusa o antigo | **PROVADO POR CURL** (diagnóstico) — sessão `meta_cloud` inserida por SQL (conectar exige Graph real): token da tela `200 x`, anterior `403`, inclusive 99 ms após a rotação |
| J22.6 | Conexões › API Oficial (Meta) não mostra token do `.env` quando vale o da instalação, e oferece o link da tela ao platform admin | **PROVADO EM TELA** — dono vê "Já cadastrado…" e o link (leva a `/admin/meta`); admin de tenant vê o aviso sem o link. `evidence/triagem-15set-l8/861-13-400px-escuro-conexoes-token-na-instalacao.png`, `evidence/triagem-15set-l8/861-15-admin-de-tenant-conexoes-sem-link.png` |
| J22.7 | Instalação sem `.env` de Meta (estado real de VPS nova): nenhuma tela manda "configurar no servidor" | **PROVADO EM TELA** — `/admin/meta` abre "Nunca configurado por aqui." sem aviso de `.env`; Conexões com canal não tem "defina no servidor" (contagem 0). `evidence/triagem-15set-l8/861-03-tela-nunca-configurada.png` |
| J22.8 | Admin de organização que não é platform admin não abre `/admin/meta` | **PROVADO EM TELA** — termina em `/admin/forbidden`, formulário não renderiza, o seletor não oferece "Gerenciar organizações". `evidence/triagem-15set-l8/861-14-admin-de-tenant-nao-abre-admin-meta.png` |
| J22.9 | 400px e tema escuro | **PROVADO POR MEDIDA** — `scrollWidth` 400 = `clientWidth` 400 em repouso, na confirmação e com o token; o token de 43 caracteres rola dentro do campo (342px em 201px). `evidence/triagem-15set-l8/861-10-400px-escuro-repouso.png`, `evidence/triagem-15set-l8/861-11-400px-escuro-confirmacao.png`, `evidence/triagem-15set-l8/861-12-400px-escuro-token-gerado.png` |
| J22.10 | Instalação sem a chave de cifra no banco | **Recusa com motivo, nada gravado** — o texto é técnico ("GUC app.nuvemshop_oauth_key ausente"). O `install.sh` sempre semeia a chave; o prelúdio do e2e não. `evidence/triagem-15set-l8/861-extra-sem-chave-de-cifra-recusa-com-motivo.png` |

**Dois defeitos achados ao ligar a tela, corrigidos antes dela:**
1. O primeiro save sem chave secreta gravava um token SOZINHO e o devolvia para
   copiar. O resolvedor serve o par inteiro ou cai para o `.env`, então o token
   nunca valia e a Meta receberia 403. A action recusa com
   `app_secret_obrigatorio` (a rotação também).
2. `GET /api/v1/channels/official` lia o token do `.env` direto: com o App
   cadastrado pela tela, Conexões mostrava o token errado (ou "defina no
   servidor"). Passou a perguntar ao resolvedor.

---

## Lote 8 da triagem — Agenda e Contatos provados em tela (2026-09-15)

Integração `integracao/triagem-15set-l8` no SHA `33ece762a`, banco do
`baseline.sql` em pg17, dono do `bootstrap-owner.ts`, `next build` + `next start`,
sem Google, sem IA, sem Resend. Evidência e régua de cada caso em
`evidence/triagem-15set-l8/README.md`.

| # | Caso | Resultado |
|---|---|---|
| L8.1 | #860 — Confirmar na aba "Aguardando confirmação" | **PROVADO EM TELA** — a linha sai da aba (2→1), aparece em Próximos, banco `confirmed`. "Exige aprovação" não tem tela: ligado por `PATCH /api/v1/agenda/tipos` com a sessão do dono. `evidence/triagem-15set-l8/860-03-linha-saiu-da-aba-aguardando.png` |
| L8.2 | #860 — Confirmar horário no painel do compromisso | **PROVADO EM TELA** — o pendente vira "Agendado" e o botão some. `evidence/triagem-15set-l8/860-07-painel-confirmou-vira-agendado.png` |
| L8.3 | #858 — Pessoa marca 10:30 numa grade de hora cheia | **PROVADO EM TELA** na porta entregue depois da QA (`triagem/lote-8-encaixe-na-tela`, SHA `0c71973d4`, ambiente fresco próprio): Novo agendamento › segunda › "Outro horário" › 10:30 › Confirmar → `201`, banco `10:30-11:30` `user/ui`, e o card na grade na altura do bloco das 10:30. A grade e o arrastar seguem só com horário publicado, de propósito. **Antes:** FALHOU EM TELA — o painel só listava horas cheias e a rota só era alcançável chamando a API com a sessão (`evidence/triagem-15set-l8/858-02-painel-oferece-so-hora-cheia.png`). `evidence/triagem-15set-l8-encaixe/03-outro-horario-1030-confirmando.png`, `evidence/triagem-15set-l8-encaixe/05-grade-mostra-o-encaixe-1030.png` |
| L8.3a | #858 — Encaixe por cima de outro encaixe | **PROVADO EM TELA** — 10:45 sobre o das 10:30: `422`, a frase da rota acima do Confirmar, painel aberto, campo com 10:45, um compromisso só no banco. `evidence/triagem-15set-l8-encaixe/06-recusa-por-cima-do-encaixe.png` |
| L8.3b | #858 — Encaixe num dia sem horário publicado, e remarcar para fora da grade | **PROVADO EM TELA** — domingo abre direto no campo (`201`, `09:15`); Remarcar abre o mesmo painel (`PATCH` `200`, `11:15`). `evidence/triagem-15set-l8-encaixe/07-domingo-sem-grade-encaixe-0915.png`, `evidence/triagem-15set-l8-encaixe/09-grade-mostra-remarcado-1115.png` |
| L8.3c | #858 — "Outro horário" a 400px no escuro, e escondido de quem só lê | **PROVADO EM TELA** — 400/400 sem elemento fora da tela; papel `viewer` não vê a opção (contagem 0). `evidence/triagem-15set-l8-encaixe/10-400px-escuro-outro-horario.png`, `evidence/triagem-15set-l8-encaixe/12-somente-leitura-sem-outro-horario.png` |
| L8.4 | #858 — Marcar por cima de compromisso existente | **PROVADO EM TELA** — duas abas disputam 17:00; a segunda recebe `422` e o aviso "Este horário já está ocupado na agenda de quem atende — por outro compromisso ou pelo Google Agenda." `evidence/triagem-15set-l8/858-04-recusa-por-cima-de-compromisso-mensagem.png` |
| L8.5 | #858 — Evento do Google Agenda ocupando o encaixe | **NÃO MEDIDO** — sem Google real |
| L8.6 | #859 — Contato com telefone já usado | **PROVADO EM TELA** — `409 contact_exists`, aviso "Já existe um contato com este telefone.", diálogo aberto. `evidence/triagem-15set-l8/859-02-telefone-repetido-diz-o-motivo.png` |
| L8.7 | #859 — O mesmo número sem o nono dígito | **PROVADO EM TELA** — mesmo `409` e mesma frase; uma linha no banco. `evidence/triagem-15set-l8/859-03-mesmo-numero-sem-nono-digito.png` |

**Achado na prova do encaixe, consertado:** o botão Confirmar do painel de marcar
ficava inteiro fora da caixa em 1280×800 e 1366×768, e cortado em 1440×900 — o
painel tem a altura do Sheet, que não rola, e o `overflow-hidden` cortava sem barra.
Valia para toda marcação, não só o encaixe. O corpo do painel passou a rolar a partir
de `lg`; medido depois em seis larguras em
`evidence/triagem-15set-l8-encaixe/README.md`.

**Achado fora do lote:** marcar ou confirmar pela tela não emite o gatilho de
automação da Agenda — o INSERT em `event_log` sai com o cliente da sessão e bate
na RLS (`new row violates row-level security policy`). Toda automação por
`appointment.created`/`appointment.confirmed` fica muda para o que a equipe faz
pela tela. O trecho é igual na `main`. → Consertado no lote 9 (#877), provado abaixo.

---

## Lote 9 da triagem — automações da Agenda, avisos na Central e o seed de demonstração (2026-09-15)

Integração `integracao/triagem-15set-l9` no SHA `cfdb43575`, banco do
`baseline.sql` em pg17, dona do `bootstrap-owner.ts`, chave de cifra semeada como o
`install.sh`, `next build` (exit 0) + `next start`, cron imitado chamando
`/api/v1/cron/event-log-drain` com o `INTERNAL_SECRET` 1×/min. Sem IA, sem Resend,
sem Google, sem Meta. Evidência, régua e o que foi SQL em
`evidence/triagem-15set-l9/README.md`.

| # | Caso | Resultado |
|---|---|---|
| L9.1 | #877 — Regra "Quando um horário for marcado" → "Adicionar tag" dispara quando a dona marca pela Agenda | **PROVADO EM TELA** — `201`, o cron drena no tick seguinte, Atividade "Sucesso · Adicionar tag" e a etiqueta no contato; zero "gatilho de automação não foi emitido" no log do servidor. `evidence/triagem-15set-l9/877-05-atividade-regra-executou-sucesso.png`, `evidence/triagem-15set-l9/877-06-contato-com-a-tag-da-regra.png` |
| L9.1a | #877 — Controle positivo na `main` (`b9bc24cf4`), mesmo banco e mesma regra | **NÃO EXECUTAVA** — `201` e "Marcado.", mas o servidor registra `new row violates row-level security policy for table "event_log"`, nenhum evento nasce, a Atividade fica com a execução anterior e o contato sem etiqueta. `evidence/triagem-15set-l9/877-controle-main-03-atividade-so-a-execucao-da-marina.png`, `evidence/triagem-15set-l9/877-controle-main-04-rui-sem-tag.png` |
| L9.2 | #871 — Evento com handler que esgota as 5 tentativas no dreno do cron abre aviso | **PROVADO EM TELA** — mídia recebida por webhook WAHA assinado, download para um WAHA fora do ar, backoff real (≈30 min): "Um processamento parou de tentar (media.persist_requested)", só "Marcar resolvido", sem "reprocessar". Canal WAHA inserido por SQL. `evidence/triagem-15set-l9/871-01-central-aviso-generico-evento-morto.png` |
| L9.3 | #871/#872 — Com o genérico aberto, o despacho da IA que morre também avisa | **PROVADO EM TELA** — "A IA deixou de responder uma mensagem de cliente" ao lado do genérico ("Abertos (2)"); mais três mortes não abrem outro; resolvido, a próxima morte reabre. Despachos com contato inexistente preparados por SQL; a morte é do worker real. `evidence/triagem-15set-l9/871-02-central-aviso-da-ia-e-generico-coexistem.png`, `evidence/triagem-15set-l9/871-04-depois-de-resolvido-a-proxima-morte-reabre-o-aviso-da-ia.png` |
| L9.3a | #872 — `midia_nao_lida` quando a derivação estoura por exceção | **NÃO MEDIDO** — exige mídia persistida e chamada ao provedor de IA falhando; sem WAHA servindo arquivo e sem IA, sem caminho |
| L9.3b | #871/#872 — Corpo dos avisos legível para quem não programa (`d9a81523e`) | **PROVADO POR TESTE, NÃO EM TELA** — o corpo do `event_dead` (genérico e da IA) e do `midia_nao_lida` da falha permanente começa pelo que aconteceu e pelo que fazer; evento, tentativas e motivo cru vão no fim, depois de "Detalhe técnico, para quem der suporte:". O título genérico ainda leva o nome do evento (um invariante congelado conta avisos por ele). `tests/unit/aviso-de-evento-morto-le-para-leigo.test.ts`, `tests/unit/media-derive-worker.test.ts` |
| L9.4 | #875 — Seed contra URL não-local | **PROVADO POR SONDA** — exit 2 e nenhuma requisição (sonda de `fetch`/`http`/`net`/`dns` no processo); com `--permitir-remoto` a mesma sonda registra `GET` e `POST` para o host `.invalid` |
| L9.5 | #875 — Regras e histórico de demonstração na tela | **PROVADO EM TELA** — três regras ativas; Sucesso, Parcial (`user_not_in_org`) e Falhou (`TypeError: fetch failed`), cada execução com as ações da própria regra; a regra VIP abre no editor com a condição no seletor. `evidence/triagem-15set-l9/875-02-seed-historico-sucesso-parcial-falha.png`, `evidence/triagem-15set-l9/875-03-seed-regra-vip-no-editor.png` |
| L9.6 | #875 — Follow-ups de demonstração | **VISÍVEIS, TRILHA INCOERENTE** — fluxo ativo e as quatro inscrições na Fila; o dossiê diz "Começou 15/09" com passos de 12/09 e 13/09, os passos saem como "código: enrolled"/"código: node_entered" (este último nenhum código emite) e "Aguardando resposta" sem passo de envio. Medido em `cfdb43575`; consertado em L9.6a. `evidence/triagem-15set-l9/875-05-seed-followups-fila-com-as-inscricoes.png`, `evidence/triagem-15set-l9/875-06-seed-followup-dossie-com-trilha.png` |
| L9.6a | #875 — Trilha dos follow-ups de demonstração depois do conserto (`5a83d292a`) | **PROVADO EM TELA** — mesmo dossiê, antes (seed de `e0b68b70f`: "código: enrolled"/"código: node_entered", passos antes do início) e depois: "Começou 13/09 22:28" e seis passos do motor em ordem até "Espera a resposta"; os outros três dossiês lidos pela mesma sonda. A trilha é reencenada com o motor real em `tests/unit/followups-de-demonstracao-sao-possiveis.test.ts`. `evidence/triagem-15set-l9/875-07-dossie-antes-trilha-impossivel.png`, `evidence/triagem-15set-l9/875-08-dossie-depois-trilha-do-motor.png` |
| L9.6b | #875 — Resumo do seed numa rodada repetida | **PROVADO POR SAÍDA** — com 3 regras, 3 execuções e 4 inscrições no banco, diz "3 execuções no histórico (0 criadas nesta rodada)", "4 inscrições (0 criadas nesta rodada)" e manda olhar "Webhooks › abas Automações e Atividade". `evidence/triagem-15set-l9/875-09-seed-resumo-duas-rodadas.txt` |
| L9.7 | Regressão do lote 8 na árvore combinada | **PROVADO EM TELA** — Agenda abre; "Outro horário" 10:45 chega à confirmação com o Confirmar dentro do painel (843–875 em 0–900); `/admin/meta` `200`. `evidence/triagem-15set-l9/l8-regressao-02-outro-horario-1045-confirmando.png`, `evidence/triagem-15set-l9/l8-regressao-03-admin-meta-carrega.png` |

**Ressalva de leitura:** os dois avisos da Central levam no corpo o nome técnico do
evento e o motivo cru (`media_persist_v1: fetch failed`; a frase inglesa da FK do
Postgres no da IA).

---

## Lote 10 da triagem — folga à noite e o Google da dona visto pela Atendente (2026-09-15)

Integração `integracao/triagem-15set-l10` no SHA `ca13073ea`, controle na `main`
`a0c88136a`; banco do `baseline.sql` em pg17, dona do `bootstrap-owner.ts`,
Atendente criada pela tela (convite › criar conta › confirmação por e-mail),
`next build` (exit 0 nas duas árvores) + `next start`, sem Google real, sem IA,
sem Resend. O Google da dona foi semeado por SQL, versionado ao lado das imagens.
Régua e medida de cada caso em `evidence/triagem-15set-l10/README.md`.

| # | Caso | Resultado |
|---|---|---|
| L10.1 | #882 — dia de folga (jornada até 23:00, São Paulo) não oferece horário no painel; o dia seguinte oferece 21:00 | **PROVADO EM TELA** — quinta 17: 0 horários, "Outro horário" aberto (encaixe por desenho); sexta 18: 30 horários com 21:00. **Não discrimina:** a `main` mostra o mesmo, porque o painel pede o mês a partir de agora e a data UTC de `de` já alcança a exceção. `evidence/triagem-15set-l10/882-02-quinta-17-folga-sem-horario.png`, `evidence/triagem-15set-l10/882-03-sexta-18-controle-oferece-21h.png` |
| L10.1a | #882 — a dona abre o painel às 21:05 do próprio dia de folga (o caso que discrimina) | **PROVADO EM TELA** — `main`: 21:30, 22:00 e 22:30 oferecidos na quinta fechada; lote: 0. Relógio do navegador em 17/09 21:05 −03:00, GET com `de=2026-09-18T00:05Z`. `evidence/triagem-15set-l10/main-882-04-quinta-17-folga-aberto-as-2105.png`, `evidence/triagem-15set-l10/882-04-lote-quinta-17-folga-aberto-as-2105.png` |
| L10.2 | #883 — Atendente, na agenda da dona com evento do Google 10:00–11:00: 10:00 não é oferecido | **PROVADO EM TELA** — 10:00 e 10:30 fora da lista (contagem 0). Na `main`, a Atendente via os dois. `evidence/triagem-15set-l10/883-02-atendente-segunda-21-sem-10h.png`, `evidence/triagem-15set-l10/main-883-atendente-segunda-21-oferece-10h.png` |
| L10.2a | #883 — Atendente tenta "Outro horário" às 10:15 | **PROVADO EM TELA** — `422 agenda_horario_indisponivel`, frase legível acima do Confirmar, sem o título do evento. Na `main`: `201` e um compromisso nasce por cima do Google da dona. `evidence/triagem-15set-l10/883-02-atendente-encaixe-1015-recusado.png`, `evidence/triagem-15set-l10/main-883-atendente-encaixe-1015-marcado.png` |
| L10.2b | #883 — a dona recebe a mesma resposta | **PROVADO EM TELA** — 10:00 fora, encaixe 10:15 com o mesmo `422`. `evidence/triagem-15set-l10/883-03-dona-encaixe-1015-recusado.png` |
| L10.3 | #892 — nenhum título do Google da dona aparece nas telas de agenda da Atendente | **PROVADO EM TELA** (texto e HTML, visões Semana, Dia e Mês). Mas a grade dela também não desenha "Ocupado" e explica o bloco travado com "fora dos horários que você publicou". **Diagnóstico por API:** a REST entrega o título a qualquer membro da organização. `evidence/triagem-15set-l10/892-01-atendente-semana-20-26.png`, `evidence/triagem-15set-l10/892-03-atendente-grade-segunda-21-10h.png` |
| L10.4 | Regressão — encaixe livre como dona, e `/admin/meta` | **PROVADO EM TELA** — 11:15 → `201`, `user/ui`; `/admin/meta` `200` sem 5xx (aberta pela URL). `evidence/triagem-15set-l10/regr-01-dona-encaixe-1115-marcado.png`, `evidence/triagem-15set-l10/regr-02-admin-meta-carrega.png` |
| L10.5 | #883 — Google real (OAuth e sincronização), gerente, agente de IA | **NÃO MEDIDO** |

**Achados fora do lote, reportados e não consertados:** (1) para o papel `agent`,
`GET /api/v1/team` responde `403`: ao abrir a Agenda aparece "Você não tem
permissão para esta ação." e o painel diz que o compromisso é com "Você" enquanto
marca na agenda da dona — igual na `main`; (2) a semente da Agenda e `GET
/api/v1/agenda/agendamentos` ainda leem o Google pelo embed
`calendar_connections!inner`, que a RLS esconde da Atendente — a mesma causa do
#879 em leitores que o lote não tocou, e consertar é decidir o que ela pode ver
(#892).

---

## J17 — Trocar de organização, incluindo a que não foi configurada `[P0]`

**Por que P0:** o seletor de organização fica no topo de toda tela do produto e
é uma das ações mais banais do cabeçalho — e ela podia terminar num beco sem
saída. `app/app/layout.tsx:51` manda para `/onboarding` toda organização ativa
sem `onboarded_at`; o layout de `/app` sai inteiro da árvore e leva o
`TenantSwitcher` junto. Quem foi convidado para uma organização nova e trocou
para ver o que era **perdia o caminho de volta**: no wizard sobravam "Termos de
Uso", "Política de Privacidade" e um "Continuar" desabilitado — medido no
snapshot de uma falha do CI (run 33164258175), não deduzido. A saída real era
limpar os dados do site.

**Como o defeito apareceu, e por que ele estava escondido:** ele não foi
reportado por ninguém — saiu de uma `main` vermelha. Dois seeds
(`seed-e2e-funis` e `seed-e2e-duas-organizacoes`) inseriam em `organizations`
com o mesmo slug e colunas diferentes, e quem rodasse primeiro vencia. Com a org
de teste chegando sem `onboarded_at`, `agenda-escopo-da-organizacao` reprovava
com `element(s) not found` no seletor. O conserto do harness devolveu o CI ao
verde; o defeito de produto que ele expôs sobrevive a esse conserto, e é o que
esta jornada prende.

| # | Caso | Resultado |
|---|---|---|
| J17.1 | Trocar para uma organização não configurada leva ao wizard — o destino está certo, a organização não foi configurada mesmo | **PASS** — `troca-de-organizacao-tem-volta.spec.ts` |
| J17.2 | O seletor de organização **não** sobrevive ao redirect (é a razão de o wizard precisar de saída própria) | **PASS** — mesma spec, `toHaveCount(0)` |
| J17.3 | O wizard oferece o caminho de volta, e voltar traz para a organização de ANTES (conferido pelo nome, não por "saiu de lá") | **PASS** — mesma spec. Evidência: `evidence/onboarding/troca-de-org-tem-volta.png` |
| J17.4 | Sem outra organização, o controle não existe — prometer ação vazia é o controle decorativo | **PASS** — `tests/unit/onboarding-tem-saida.test.tsx` |
| J17.5 | Trocar **navega**: `setActiveOrg` revalida `/app`, não `/onboarding`, e sem o `replace` o clique pareceria não fazer nada | **PASS** — mesma unit |
| J17.6 | Dois seeds não criam a mesma organização (a classe, não a instância) | **PASS** — `tests/unit/seeds-nao-disputam-organizacao.test.ts`, com controle positivo contra a regex cegar |

**As asserções foram provadas vermelhas antes:**

| Sabotagem | Previsão | Medido |
|---|---|---|
| O layout volta a não montar a saída (o estado de antes) | J17.3 vermelho, `agenda-escopo` verde ao lado | **exatamente isso** — a cerca discrimina, não reage a qualquer estrago |
| A saída nunca renderiza | 3 unit vermelhos | **3** |
| Troca sem navegar | 1 unit vermelho | **1** |
| O slug compartilhado volta ao seed | o gate de seeds reprova nomeando os dois arquivos | **reprovou**, com `e2e-segunda-org ← seed-e2e-duas-organizacoes.ts + seed-e2e-funis.ts` |
| Seed antigo restaurado (`git show HEAD~1`) e re-semeado | `agenda-escopo` reprova como no CI | **reprovou** com `não terminou` + `element(s) not found`, literal |
## J18 — O follow-up anda em hospedagem sem agendador `[P0]`

**Por que P0:** para quem **não tem** o `scheduler` da VPS — o plano gratuito da
Vercel é o caso comum, e é o cenário inteiro do runbook
[`vercel-hobby-relogio.md`](../runbooks/vercel-hobby-relogio.md) — o relógio
externo não é conveniência: é o **único** motor do follow-up. E a falha dele é
silenciosa: os follow-ups não andam, ninguém recebe erro, e a instalação parece
saudável.

**O que existia media TEXTO.** `tests/unit/relogio-hobby-workflow.test.ts`
confere que o `.yml` cita o caminho do tick, a variável e o `exit 1` — ancora o
contrato do arquivo, não prova que uma batida faz alguma coisa. Nenhum teste, em
lugar nenhum, chegava a bater na rota. Era o item 2 da issue #366.

**O emissor é externo de propósito.** `execFileSync("curl", …)` — outro
processo, sem contexto de browser, sem cookie: é literalmente o comando que
`comandoCurlDoRelogio()` gera e que o runbook manda colar no cron-job.org.
`page.request` compartilharia o contexto do teste e provaria menos, já que a
rota está em `PUBLIC_PATHS` justamente porque quem a chama não tem sessão.

Spec: `tests/e2e/relogio-http-cron-externo.spec.ts` (`SPECS_PARTE_1`).

| # | Caso | Expectativa | Resultado |
|---|------|-------------|-----------|
| J18.1 | Segredo errado é recusado | 403 **e** o enrollment não se move | PASS |
| J18.2 | 1ª batida executa o `wait` | agenda a espera para o futuro, `steps_taken` sobe | PASS |
| J18.3 | 2ª batida, vencido o prazo, avança | `current_node_id` chega ao nó final | PASS |

**Duas batidas, e não uma — medido.** A primeira versão do caso esperava avanço
numa batida só, e o run devolveu `{claimed:1, advanced:0, scheduled:1}`: um
enrollment vencido *parado* num nó `wait` significa "chegou a hora de EXECUTAR o
wait", e executar um wait é **agendar** a espera. O avanço só vem na batida
depois do prazo — que é exatamente o que um cron externo faz, batendo de poucos
em poucos minutos. O relógio do fixture é adiantado entre as duas porque o
mínimo do `wait` é 5 min por regra de produto (`graph-schema.ts` recusa
`duration_ms` abaixo de `300000`; com `1` o tick devolve `failed: 1`).

**Sabotado, com a previsão declarada antes de rodar:**

    auth aceita qualquer segredo   -> caso 1 vermelho, casos 2/3 verdes
    tick responde 200 e não acha
      o que avançar (claim vazio)  -> caso 1 verde, casos 2/3 vermelhos
    restaurado                     -> 2 de 2

**NÃO COBERTO, declarado:** o `.github/workflows/relogio.yml` em si — ele nasce
desligado (`RELOGIO_LIGADO`) e quem o exercitaria é o Actions de um fork, não
este job. O que está provado é que **a batida faz efeito**; que o agendador do
GitHub dispara no horário é do GitHub.

---

## J20 — A IA só atende quem tem origem elegível (gate opt-in por canal) `[P0]`

**Por que P0:** achado pelo dono do produto num número que é também o WhatsApp
pessoal/comercial dele — a IA respondeu automaticamente para cliente atual, dono
de incorporadora, contato pessoal, fornecedor e conversa antiga. O
DeskcommCRM responde `allow by default` (publicou agente para a sessão → atende
todo inbound); num número compartilhado com gente isso é a IA assumindo conversa
que não era dela.

**Contexto do código:** gate OPT-IN por canal —
`channel_sessions.metadata.ai_gate = 'allowlist'` (ausente / `'open'` =
comportamento de hoje). Com o gate, a IA só responde quando
`contacts.ai_authorized_at` está setado (por uma origem elegível) e dentro da
janela `AI_ALLOWLIST_TTL_DAYS`. A decisão é `lib/ai/elegibilidade/gate.ts`
(pura), consultada pelo drain (`lib/agent-engine/edge/crm/drain.ts`, decide
enfileirar) e pelo turno (`lib/agent-engine/agent/inbound-turn.ts`, decide
rodar). Origens que autorizam: webhook do Respondi
(`app/api/v1/webhooks/in/[token]`), match de campanha na ingestão
(`lib/channels/pos-entrada.ts` × `organizations.settings.campanhas_whatsapp`),
ação `send_ai_message`, retomada manual (`lib/escalacao/retomada.ts`).

| # | Caso | Expectativa | Cobertura |
|---|---|---|---|
| J20.1 | Cliente atual manda "boa noite" (gate allowlist, contato não autorizado) | IA NÃO responde; conversa fica humana | **UNIT** — `gate.test.ts` "teste 1/3/4/9", `drain.test.ts` "gate allowlist + contato NÃO autorizado" |
| J20.2 | Cliente atual com conversa aberta, não autorizado | IA NÃO responde (estado da conversa não pesa) | **UNIT** — `gate.test.ts` "teste 2" |
| J20.3 | Contato pessoal manda mensagem | IA NÃO responde | **UNIT** — coberto por J20.1 (mesma regra) |
| J20.4 | Fornecedor manda proposta comercial | IA NÃO responde automaticamente | **UNIT** — coberto por J20.1 |
| J20.5 | Conversa antiga de 3 dias; publicar agente | publicar NÃO dispara nada (`ai_agent.published` não tem consumidor) + o drain pula evento superado por inbound mais recente | **UNIT** — `drain.test.ts` "evento superado por inbound mais recente"; **CÓDIGO** — grep: zero consumidor de `ai_agent.published` |
| J20.6 | Nova submissão Respondi → o contato fica elegível | IA pode responder o retorno do lead | **UNIT** — webhook seta `ai_authorized_reason='respondi:<form>:<sub>'`; **E2E** — `tests/e2e/j20-elegibilidade-respondi.spec.ts` (submissão real na URL da fonte → `ai_authorized_at` carimbado → o retorno pelo WhatsApp gera `job_queue` `inbound_turn`; CONTROLE: número sem Respondi no mesmo canal → evento `done` sem job) |
| J20.7 | Segundo turno do Respondi (dias depois, conversa viva) | IA continua atendendo (keep-alive renova o carimbo) | **UNIT** — `gate.test.ts` "teste 6/7"; keep-alive em `inbound-turn.ts` |
| J20.8 | Nova mensagem de campanha com identificador autorizado | IA pode assumir | **UNIT** — `campanha.test.ts` "teste 8" |
| J20.9 | Nova mensagem genérica "oi" | IA NÃO responde | **UNIT** — `campanha.test.ts` "teste 9" + `gate.test.ts` |
| J20.10 | Conversa marcada human_only (`force_human`) | IA nunca responde até reativação explícita | **UNIT** — `gate.test.ts` "teste 10", `drain.test.ts` "force_human" |
| J20.11 | Follow-up em lead Respondi elegível | funciona | **CÓDIGO** — silence-sweep só barra quem o gate barra |
| J20.12 | Follow-up em cliente atual (não autorizado, gate allowlist) | NÃO enrola | **CÓDIGO** — `silence-sweep.ts` `loadSilentContactIds` consulta a regra compartilhada e pula `!permitidoPeloGate`; **E2E** — `tests/e2e/j20-elegibilidade-followup.spec.ts` (fluxo de silêncio publicado pela API + cron real: silencioso autorizado → nasce `followup_enrollments`; silencioso NÃO autorizado, mesmo canal → nenhum enrollment) |
| J20.13 | Reinício do worker com backlog de eventos pending | zero disparos: cada evento cujo inbound já foi superado vira `done` sem job | **UNIT** — `drain.test.ts` "evento superado por inbound mais recente" |
| J20.14 | Submissão antiga (fora do TTL) | NÃO reativa a IA sozinha | **UNIT** — `gate.test.ts` "submissão antiga (fora da janela)", `drain.test.ts` "autorização EXPIRADA" |
| J20.15 | Org SEM versão de agente publicada (caminho legado `ai-response-worker`), gate allowlist, contato não autorizado | IA NÃO responde por este caminho tampouco | **UNIT** — `ai-response-worker-elegibilidade.test.ts` (skip `nao_elegivel_para_ia` antes de ler mensagem/agente; fail-closed em erro de leitura) |
| J20.16 | Follow-up de TEXTO FIXO drenado inline (`enviarTextoFixoPendente`, sem worker), contato não autorizado | NÃO envia; job vira `done` | **UNIT** — `enviar-texto-fixo.test.ts` "conversa NÃO elegível" (+ fail-closed volta pra `pending`) |
| J20.17 | Cliente antigo irritado (gate allowlist, não autorizado) → worker de sentimento dispara `low_sentiment` | `triggerHandoff` NÃO dispara: sem "um humano vai te atender", sem mexer no estado da conversa | **UNIT** — `handoff-orchestrator-elegibilidade.test.ts` (`bloqueioPorAllowlist` e `conversa_silenciada` barram; fail-closed em erro) |
| J20.18 | Eu respondo o cliente à mão pelo meu WhatsApp numa conversa autorizada | IA para naquela conversa por um PRAZO (`PRAZO_DO_SILENCIO_MS`, 60 min) renovado a cada nova fala humana, SEM apagar `ai_authorized_at`; volta sozinha quando o prazo vence, ou antes por "devolver ao automático" | **UNIT** — `atendimento-manual.test.ts` (as duas pontas do prazo medidas pelo motor real `decidirElegibilidade`, renovação, e o que NUNCA encurta: `'infinity'` do handoff formal e janela mais longa) + `waha-ingest-atendimento-manual.test.ts` (via `dispatchWahaEvent` real; eco do próprio envio NÃO pausa) + guarda de fonte no Zernio + fiação em `handoff-fernando-fiacao.test.ts`; **E2E** — `tests/e2e/j20-elegibilidade-atendimento-manual.spec.ts` (webhook `fromMe` genuíno → `bot_silenced_until` finito e futuro, nunca `'infinity'`, + rastro; `ai_authorized_at` intacto; 2ª mensagem RENOVA o prazo; tela mostra o selo; "devolver ao automático" solta a trava e a autorização continua) |
| J20.19 | Worker parado acorda com backlog; dois inbound antigos com o MESMO `sent_at` | a "última inbound" é a mais RECENTE (por `created_at`), nunca a de maior uuid — o evento antigo é pulado | **INVARIANTE** — `tests/invariants/drain-recencia-inbound.test.ts` (Postgres real) + `drain.test.ts` guarda a cláusula `coalesce(sent_at, created_at)` |

**Sabotagem que confirma:** removendo o veto `sem_autorizacao` de
`decidirElegibilidade`, `gate.test.ts` e `drain.test.ts` reprovam; restaurado,
verde. Para J20.19: `order by id desc` sozinho elege a mensagem ANTIGA — o
próprio invariante prova isso na asserção de sanidade.

**Cobertura de caminhos de envio (R1 — nenhum atalho):** o gate
(`lib/ai/elegibilidade/gate.ts`, regra pura) é consultado por TODOS os produtores
de resposta automática: drain + turno do agent-engine (`consulta-pg.ts`),
`ai-response-worker` legado, `enviarTextoFixoPendente`, `runAgent` legado
(`lib/ai/runtime/agent.ts`), `triggerHandoff` e o worker de sentimento
(`consulta-supabase.ts`). `send_ai_message` é origem elegível (autoriza e então
envia). Todos fail-closed: erro de leitura da elegibilidade → não responde.

**E2E (ambiente fresco estilo VPS):** J20.6, J20.12 e J20.18 têm spec própria
(`tests/e2e/j20-elegibilidade-*.spec.ts`), rodando no job `e2e` do CI. Seed
compartilhado `scripts/seed-e2e-elegibilidade.ts` (canal com `ai_gate='allowlist'`
+ credencial validada + fonte de captação); helpers de SQL cru
`scripts/e2e-elegibilidade-helpers.ts` (roda 1 tick do `drainTick` real — a suíte
não sobe worker —, lê `job_queue`/`event_log`/`followup_enrollments`, semeia os
dois estados de partida do gate). A submissão do Respondi e as mensagens do WAHA
entram pelas rotas REAIS do app (`/api/v1/webhooks/in/:token`,
`/api/v1/webhooks/waha/:token`). O agente publicado é SETUP via helper porque
`POST /api/v1/ai/agents` exige role `admin`/MFA e o agente não é o que está sob
teste.

**Modo de teste do canal (issue #573):** Conexões › Configurar acesso da IA
agora expõe pré-go-live por lista de telefones e abertura ao público com
confirmação. Novos canais nascem em teste com lista vazia; os anteriores
preservam o gate. O pré-go-live NÃO aceita autorizações por origem como
substitutas da lista. Contrato em [pre-go-live-whatsapp](../specs/pre-go-live-whatsapp.md).

| # | Caso | Expectativa | Cobertura |
|---|---|---|---|
| J20.20 | Cadastrar testadores antes do primeiro contato | Só o telefone listado é elegível, mesmo que outro contato tenha autorização por origem | `tests/invariants/pre-go-live-canal.test.ts`, `gate.test.ts`, `consulta-supabase.test.ts`, `drain.test.ts` |
| J20.21 | Administrador salva, recarrega, remove, abre e volta ao teste | Lista persistente por canal, lista vazia bloqueia todos, abrir exige confirmação | `tests/e2e/pre-go-live-whatsapp.spec.ts`, auth e banco reais, desktop e móvel |
| J20.22 | Fechar o canal durante geração da resposta | Sink não envia automaticamente; resposta humana continua permitida | `tests/unit/messages-handler-desfechos.test.ts` |
| J20.23 | Remover testador com resposta pendente de reenvio | Watchdog relê a lista e falha a mensagem sem alcançar o transporte; erro de leitura também não envia | `tests/invariants/agent-watchdog.test.ts` com banco e receiver HTTP reais; `session-reconciler.test.ts` |

**Dívida restante:** o editor de `campanhas_whatsapp` e a ativação do allowlist
POR ORIGEM continuam por script/SQL (`scripts/ativar-gate-elegibilidade-ia.ts`).
O painel não converte silenciosamente esse modo legado em teste ou aberto.

**Dívida no `campanhas_whatsapp`:** o campo `agent_id` de uma campanha é aceito
no schema mas **NÃO é roteado** — o match só torna o contato elegível
(`ai_authorized_reason = campanha:<id>`); quem assume o turno é sempre o
roteador / agente publicado da sessão. Encaminhar por campanha exige levar
`agent_id` no payload de `ai_agent.dispatch_requested` e o `resolve-turn-agent`
respeitá-lo. `label`/`segmento` são display-only (dependem da tela).

---

## J7 — Exploração completa `[P2]`

Andar por TODAS as rotas navegáveis logado como admin e como agent: settings, contacts,
LGPD anonymize, /admin (platform), error pages (403/503/not-found), estados vazios.
Critério: nenhuma tela quebra, nenhum stack trace, nenhum texto de erro cru.

---

## Achados do mapeamento (pré-execução) — candidatos a correção

| ID | Achado | Origem | Severidade |
|----|--------|--------|-----------|
| M1 | `supabase/config.toml` trava `major_version = 15`, mas `baseline.sql` exige PG17 (`GRANT MAINTAIN`) — contribuidor open-source não sobe ambiente local | reproduzido | Alta (DX) |
| M2 | Trilha manual do `docs/deploy-selfhost/README.md` não configura o cron do drain → automações mortas em silêncio | explorer webhooks | Alta |
| M3 | ~~README self-host aponta repo/imagem `deskcommcrm/*`; kit usa `melgarafael/*`~~ **CORRIGIDO 2026-08-13** — era um `git clone` de uma org que não existe (404) em `docs/deploy-selfhost/README.md:26`. Uma consultoria externa leu essa string e concluiu que o compose apontava para uma org desvinculada; o compose sempre apontou para `melgarafael`. | explorer webhooks | — |
| M4 | `INVITE_TOKEN_SECRET` ausente → fallback `"dev-fallback"` → convite forjável em VPS mal configurada | explorer CRM/time | Alta (segurança) |
| M5 | AI Gateway key ausente → bot mudo sem NENHUM feedback na UI | explorer IA | Média |
| M6 | Knowledge sources: botões de upload/configurar são stubs "Em breve" | explorer IA | Média |
| M7 | Enviar mensagem com canal não-WORKING fica `queued` silencioso | explorer WhatsApp | Média |
| M8 | Kanban: colisão de fractional index aborta drag sem feedback | explorer CRM | Baixa |
| M9 | Toasts com códigos crus (`db_error`, `invalid_input`) no onboarding | explorer onboarding | Baixa |
| M10 | Onboarding: pular WhatsApp redirecionava hardcoded pro connect-nuvemshop (step oculto quando Nuvemshop off) | execução J1.6 | Alta (travava wizard) |
| M11 | Onboarding: convite sem Resend redirecionava em silêncio, sem dar o accept_url | execução J1.8 | Alta |
| M12 | MFA gate: revalidação do Server Action desmontava o modal e o usuário nunca via os recovery codes | execução J1.10 | Crítica |

## Ordem de execução

1. **Fase A `[P0]` primeira impressão:** J1 completo → J2.1-2.2/2.5-2.6 → J5.1-5.2 → J6.1-6.3.
2. **Fase B rotina:** J4, J5.3-5.9, J6.4-6.9, J3.1-3.3.
3. **Fase C IA viva + WhatsApp real:** J3.4-3.9, J2.3-2.4 (com Rafael no QR).
4. **Fase D exploração:** J7 + edge cases restantes.

## Bugs corrigidos nesta rodada de QA

| Bug | Arquivo | Correção |
|-----|---------|----------|
| M10 | `app/actions/onboarding/skipWhatsapp.ts` | `skipWhatsapp`/`markWhatsappConfigured` redirecionam pro roteador `/onboarding`, não pro step fixo |
| M11 | `app/actions/onboarding/sendOnboardingInvites.ts` + `invite-team/_form.tsx` | retorna `undelivered[]` com accept_url; UI mostra links copiáveis quando email falha |
| M12 | `components/auth/MfaEnrollGate.tsx` + `app/app/layout.tsx` | gate latcha a decisão client-side; revalidação não derruba mais a tela de recovery codes |

---

# Sessão 2026-07-29/30 — instalação do zero na VPS + jornada completa

Ambiente: VPS HostGator (143.95.209.17), domínio `test-crm.vidagamificada.com.br`,
projeto Supabase **novo e virgem** (0 tabelas / 0 usuários / 0 buckets antes de cada
instalação), cache de build do Docker zerado (a VPS realmente compila o worker),
imagem `ghcr.io/melgarafael/deskcommcrm:latest` — a mesma que o comprador recebe.

Duas instalações completas do zero: a primeira para achar defeitos, a segunda
(após todas as correções publicadas na `main`) como prova. Entre elas, o banco
voltou ao estado virgem — correção não foi validada em cima de instalação remendada.

Nome da organização na instalação final: **"Loja do João QA"** — de propósito com
espaço e acento, que era o gatilho do defeito #6.

## Defeitos encontrados e corrigidos

| # | Onde | Defeito | Como foi provado |
|---|---|---|---|
| 1 | `install.sh` | Morria em **silêncio** (exit 2) com connection string errada: o `psql` falhava dentro de `$( )` sob `set -e`+`pipefail` e o `2>/dev/null` engolia a causa | reproduzido colando a senha sem URL-encoding; log terminava num aviso amarelo e o prompt voltava |
| 2 | `install.sh` | Nenhuma validação de URL/anon/service_role/connection string | validadores novos + `test-validators.sh` (19 casos, cada rejeição assere o MOTIVO) |
| 3 | `install.sh` | Impossível corrigir uma resposta errada | `voltar` em qualquer pergunta + tela de conferência editável por número |
| 4 | `install.sh` | `OPENAI_API_KEY` nunca perguntada → RAG e transcrição de áudio desligados em silêncio | `lib/env.ts:181` consome a variável; o `.env` gerado não a tinha |
| 5 | `README` | Nenhum comando de instalação de VPS; o único bloco era o Quickstart de dev | leitura do README publicado |
| 6 | `_common.sh` | Nome com espaço quebrava **os 4 scripts de socorro** (`.env` lido com `source`) | `reset-mfa/reset-password/healthcheck/backup` morriam com `QA: command not found`; após o conserto, exit 0 com o **mesmo** `.env` |
| 7 | `install.sh` | `SENTRY_DSN` documentado mas nunca escrito no `.env`; telemetria sem aviso | grep no `.env` gerado |
| 8 | onboarding WhatsApp | QR expirado = beco sem saída apontando `http://localhost:3030` (inexistente numa VPS), sem retry | sessão foi a `FAILED` ("QR refs attempts ended") e a tela ofereceu só "Pular"/"Já configurei" |
| 9 | `Stepper` | Congelado no passo 1 nas 6 telas: lia `x-pathname`, header que **nada** no projeto escreve (não existe middleware) | após o conserto: `1 Boas-vindas → 2 WhatsApp → 4 IA → 5 Time → 6 Concluído` |
| 10 | 3 formulários de lead | `249.90` gravava **2.499.000 centavos** (R$ 24.990,00), sem aviso | `value_cents` no banco; parser único em `lib/money.ts` + eco na tela |
| 11 | onboarding IA | Agente criado **nunca responderia** (sem versão publicada) e a lista dizia "Publicado" | o JOIN que os dois runtimes usam devolvia 0 linhas; hoje devolve o agente |
| 12 | seed do funil | Etapas "Em separacao" e "Pos-venda" sem acento no quadro principal | migration 0092 + apêndice do baseline |
| 13 | `update.sh` | Atualização interrompida após o `git pull` prendia o CRM na imagem antiga **para sempre** ("já está na versão mais recente") | digest local `273079c8` ≠ remoto `bb402c13` com o git em dia |
| 14 | API Tokens | Impossível emitir token que use **MCP**: faltavam `mcp:read`/`mcp:write`/`role:manager` no catálogo da tela | toda tool respondia "Token missing required scope 'mcp:read'"; hoje token criado pela tela chama as tools |
| 15 | `lib/mcp/audit.ts` | **Nenhuma** ação via MCP era auditada: nome da tool ia para `resource_id` (uuid) e id do token para `actor_user_id` (FK) | log do contêiner + `select count(*) where action='mcp.tool_called'` = 0; hoje grava |
| 16 | `lib/audit/index.ts` | Falha de audit só fazia `console.error` — foi o que manteve #15 invisível | doutrina exige alerta no Sentry |
| 17 | crons de follow-up/snooze | **95% do audit log** era batida de cron vazia (1.175 de 1.236 linhas em ~9h paradas) numa tabela append-only com retenção de 5 anos | contagem por `action` |

## Jornadas exercitadas (instalação final, virgem)

| Jornada | Resultado |
|---|---|
| Instalação `install.sh` do zero, 3 erros propositais + `voltar` + correção pela tela | PASS — cada erro barrado com motivo e receita |
| Instalação limpa do zero (respostas certas) | PASS — ~6 min, exit 0, 7 contêineres, 94 tabelas, 8 modelos de IA, SSL válido |
| Scripts do kit com nome acentuado e com espaço | PASS |
| Login + onboarding 6 passos + MFA (TOTP) | PASS — zero erro de console/HTTP na jornada inteira |
| Varredura de 33 telas autenticadas | PASS — todas com conteúdo, sem 4xx/5xx nem erro de JS |
| Criar lead pela tela, ver no quadro e no banco | PASS |
| Captação por webhook → lead + contato + `event_log` drenado pelo cron | PASS |
| Criar fluxo de follow-up e tentar publicar incompleto | PASS — publicação **recusada** com os nós inalcançáveis destacados |
| MCP: `tools/list` (16 tools), leitura, escrita, RBAC por papel | PASS |
| Auditoria das ações MCP | PASS (após #15/#16) |
| `update.sh` com imagem atrasada | PASS (após #13) |
| **Conectar WhatsApp por QR code** | **PENDENTE** — depende de escanear com o celular do dono |

## Aberto para decisão do dono

- `channel_session.status_changed` é emitido por trigger e **não tem consumidor**
  (anti-pattern nº 3 do `CLAUDE.md`): as linhas ficam `pending` para sempre. Ou
  alguém passa a escutar, ou o trigger sai. Não inventei consumidor.
- Tela de Conexões diz "1 número conectado" mesmo com o número **caído** (conta
  sessões, não conectados).
- ~~O autenticador registra o nome fixo "DeskcommCRM", ignorando o `APP_NAME` que o
  instalador vende como marca de toda a interface.~~ **RESOLVIDO em 2026-08-14** — virou o
  caso `M4` da jornada de marca própria (no fim deste arquivo). E a justificativa que estava
  aqui era **falsa em duas metades**: o problema não era "o nome fixo aparece no celular do
  usuário", porque o `friendlyName` **não entra na URI `otpauth://`** (medido contra GoTrue
  v2.188.1, e nenhuma tela do produto renderiza `friendly_name`). O campo que de fato grava no
  aparelho é o `issuer`, que simplesmente **não era passado**. Este item ficou aqui semanas
  descrevendo o defeito certo pelo mecanismo errado — e, enquanto isso, a mesma coisa constava
  como dívida da fase 4 na guarda de marca. O mesmo defeito com duas biografias é como uma
  correção acaba consertando a metade que não importa.
- `CLAUDE.md` documenta bearer `tok_...`; o token real nasce com prefixo `dsk_`.

## Segurança — achados após conectar o WhatsApp real (2026-07-30)

| # | Defeito | Como foi provado | Correção |
|---|---|---|---|
| 18 | 🔴 **Webhook do WAHA aceitava qualquer um.** `POST /api/v1/webhooks/waha` sem assinatura e com HMAC de zeros → `200 {"accepted":true}`, mensagem gravada no banco, contato criado e **o agente respondeu para o número escolhido pelo atacante** | `curl` de fora, e `select` no banco mostrando `external_id` "falso"/"falso2" | fail-closed em `lib/waha/webhook-auth.ts` (as duas rotas) + Caddy deixa de publicar a rota global |
| 18b | 🔴 Causa: **fail-open por construção** — `hmacSkipped = true` quando o segredo não podia ser obtido. E as duas rotas que criam sessão gravam `webhook_secret_encrypted: Buffer.from([0])`, então era o estado **permanente** de toda instalação | leitura das duas rotas + `WAHA_HMAC_SECRET` ausente de `lib/env.ts` | segredo declarado no env; sem segredo para conferir, assinatura presente é rejeitada |
| 18c | 🟠 **O log mentia sobre a própria verificação**: `valid_signature: validSignature \|\| hmacSkipped` gravava "assinatura válida" em evento sem assinatura nenhuma | todos os eventos reais no banco com `valid_signature = t` e `signature_header` nulo | grava a verdade; hoje `f` com header nulo |
| 18d | 🟡 Auditoria da rejeição usava `nuvemshop.webhook_invalid_signature` para evento do WAHA | leitura do código | usa `webhook.hmac_invalid`, que já existia |
| 19 | 🟠 **A regra de bloqueio no Caddy não valia**: fora de um bloco `route`, o Caddy reordena e `respond` vem depois de `reverse_proxy` — o catch-all atendia primeiro | após o deploy, o POST sem assinatura ainda respondia 200 | `route { }` para valer a ordem escrita |
| 20 | 🔴 **Mudança no Caddyfile nunca chegava em quem já instalou.** Bind mount de um arquivo fica preso ao inode; `git pull` cria inode novo e o contêiner segue lendo o antigo | inode 3283869 no host x 3271833 no contêiner, com conteúdo velho, depois de um `update.sh` que disse "concluída" | `update.sh` recria o contêiner do proxy |

**Nota de método:** medi o que o WAHA realmente envia **antes** de escrever o conserto. Os eventos reais chegam **sem assinatura** (2026.7.2 CORE não assina, mesmo com `WHATSAPP_HOOK_HMAC` no contêiner) — o único evento com header no log era a minha própria injeção. Passar a exigir assinatura por padrão derrubaria a ingestão de mensagens de todo mundo: por isso a defesa padrão é de rede, e a exigência de assinatura fica atrás de `WAHA_WEBHOOK_REQUIRE_SIGNATURE` para quem roda WAHA Plus.

**Efeito colateral no mundo real, registrado:** ao conectar o WhatsApp **pessoal** do dono, o agente começou a responder contatos reais (4 respostas automáticas para 2 pessoas) assinando "assistente virtual da loja". O agente foi despublicado. Recomendação: testar agente com número descartável, e avaliar um modo "só observa" para primeira conexão.

## IA com WhatsApp real conectado (2026-07-30)

**O que ficou provado funcionando:** mensagem real chega → conversa e contato criados → agente responde no WhatsApp. Sete conversas reais ingeridas; o agente respondeu a duas pessoas com texto contextual e coerente. A ingestão e o ciclo responder-no-WhatsApp **funcionam**.

| # | Achado | Estado |
|---|---|---|
| 21 | 🔴 **RAG do tenant não existe na prática.** O botão "Configurar" das 4 fontes é stub `disabled` com um toast "Em breve" que, por estar desabilitado, nunca aparece. Criando a fonte pela API (que funciona, 201), o "Re-indexar" não produz nada: o handler de `knowledge_source.updated` é stub declarado (S-06.05/06/07); só `nuvemshop.product_synced` indexa de verdade — e a Nuvemshop vem desligada no kit | tela passa a dizer a verdade; **indexação não implementada de propósito** (multi-fonte exige decisão de arquitetura: o agente busca por UMA versão ativa) |
| 22 | 🟠 **Agente pausado continua gastando.** Despublicar não impede o motor de enfileirar e executar turnos: ele chama o LLM, descobre depois que não há agente publicado e falha, retentando. Medido: **90 chamadas ao LLM e 65 turnos falhos** | **corrigido** (achado 24) — a causa não era o pause — o modelo é resolvido em vários pontos do turno e um palpite no caminho que gasta dinheiro é pior que o defeito |
| 23 | 🟡 `ai_agent_runs` e `ai_invocations` **vazias** apesar de respostas reais terem saído — as telas de Uso e Evolução da IA não têm dado para mostrar | aberto |

**Correção de rumo registrada:** as falhas "modelo LLM não definido" das 17:03 foram **consequência do meu pause**, não defeito do produto — a cadeia de fallback do modelo depende do agente publicado (`inbound-turn.ts:686`). Quase reportei como P0 de instalação nova; a leitura do código desmentiu. O que sobrou de verdadeiro é o achado 22, que é outro e menor.

**Efeito colateral no mundo real:** o agente respondeu contatos pessoais do dono assinando "assistente virtual da loja". Testar agente em número pessoal precisa de um aviso explícito no produto, ou de um modo "só observa" na primeira conexão.

## Correções de rumo desta sessão (registradas de propósito)

| O que eu afirmei | O que era verdade |
|---|---|
| "As falhas do turno são consequência do meu pause do agente" | **Errado.** Com o agente publicado o turno falhava igual. A causa era outra: roteador sem membros → caminho genérico → `organizations.settings.llm.default_model` que ninguém preenche (achado 24) |
| "Nada na interface avisava que o agente parou" | **Errado.** O Inbox da IA mostrava **16 alertas críticos** "Job descartado após esgotar tentativas" — o mecanismo anti-morte funcionou. O que faltava era o alerta dizer o MOTIVO, que ele descartava (achado 25) |

| # | Achado | Estado |
|---|---|---|
| 24 | 🔴 **Roteador de intenção sem membros derrubava TODAS as respostas.** A tela permite criar; o turno cai no caminho genérico (decisão de produto: "não é silêncio") e o genérico não tem modelo, porque `settings.llm.default_model` não é preenchido por ninguém e não tem tela. Medido: 80 chamadas de classificador em retry, zero respostas | corrigido — migration 0096 semeia o modelo em toda org, nova e existente. Provado com o MESMO job que falhava: passou a concluir e entregou a resposta |
| 25 | 🟠 O alerta de job morto trazia só `kind=...; attempts=5` e **descartava o erro** que o causou | corrigido — o motivo vai no corpo do alerta |
| 26 | 🟡 Custo de IA: a tela lia `ai_invocations` (workers legados) e o runtime grava em `llm_calls` — mostrava R$ 0,00 com dinheiro saindo | corrigido |
| 27 | 🟠 O gatilho do orçamento só existia em `ai_invocations`: alarme de 80% e pausa em 100% nunca disparariam | corrigido — migration 0095 |

## Jornadas concluídas nesta rodada autônoma

| Jornada | Resultado |
|---|---|
| **Handoff IA→humano** (via MCP) | PASS — conversa vai a `pending`, **bot silenciado**, motivo gravado, fila com posição, `ai.handoff_triggered` no audit E no event_log (consumido) |
| **Follow-up: criar, montar grafo e publicar** | PASS — e a validação **recusou** o grafo inválido com a regra de negócio certa: *"nó acumula ≥24h de espera e precisa de fallback_template_id"* (política de 24h do WhatsApp). Com o template ligado, publicou: fluxo `active` com versão ativa |
| **Contatos e Templates (criar pela tela)** | PASS — persistem e aparecem sem recarregar |
| **Equipe, LGPD, Radar, Desempenho, Casos, Memória, Skills** | PASS — renderizam com conteúdo, sem 4xx/5xx nem erro de JS |
| **Turno completo do agente** | PASS após o achado 24 — as 6 etapas do pipeline rodam (`intent_router`, `agent_turn`, `stage_classifier`, `jailbreak_detect`, `promise_semantic`, `checkpoint`) e a resposta é entregue |
| **Transcrição de áudio** | **PENDENTE** — exige alguém enviar um áudio ao número; é a única coisa que não consigo produzir sozinho |

| # | Achado | Estado |
|---|---|---|
| 28 | 🟠 **CI vermelho por lentidão, não por defeito.** O teste que abre processo filho (`npx tsx`) leva ~5s e o timeout padrão do vitest é 5s — derrubou a `main` num PR que só mexia em documentação | corrigido — timeout explícito de 60s; 3 rodadas seguidas verdes. O controle positivo continua provando o aparato |

**Nota de ambiente:** o `.env` da VPS foi apontado para `ghcr.io/...:latest` durante o QA, porque o fluxo de release novo fixa a imagem numa tag (`1.1.0`) e as correções desta sessão estão à frente dela. Para voltar ao comportamento de release, basta repor `APP_IMAGE` com a tag desejada.

## Acervo de conhecimento — o acervo é da organização (2026-08-26)

> **O que o CI NÃO prova aqui.** `tests/e2e/acervo-de-conhecimento.spec.ts` tem 6
> casos, e **4 deles pulam no CI** por falta de `OPENAI_API_KEY_E2E` — chave paga,
> que não vai para segredo de repositório público. Medido, não suposto: a parte 2
> do `e2e` era `73 passed / 0 skipped` na main sem a spec e virou `75 passed /
> 4 skipped` com ela. O CI prova que a tela DIZ que falta chave e que o material
> sem chave fica esperando; **que o material vira trecho buscável — o produto — só
> é provado rodando a spec com a chave**, e essa rodada está em
> `evidence/acervo-de-conhecimento/`. Mesmo formato do aviso que a doutrina já dá
> sobre `vps-fresh-onboarding`: um `skip` silencioso é indistinguível de um `pass`
> no placar agregado.

**A afirmação de 2026-07-30 abaixo ("implementado e provado") era verdadeira para
UM caminho e falsa para o produto.** O que estava provado era: FAQ colada, pelo
agente padrão, numa organização com a chave no `.env`. Fora disso, medido agora:

| # | Achado | O que a pessoa via |
|---|---|---|
| 1 | 🔴 **O indexador resolvia o agente pela ORGANIZAÇÃO** (`resolveAgent(organizationId)` → `is_default desc, created_at asc, limit 1`) e ignorava o `agent_id` que os três emissores mandavam no payload | com dois assistentes, o material do segundo nunca virava trecho. Sem erro, sem estado, sem nada na tela |
| 2 | 🔴 **A tela de conhecimento era presa a `is_default = true`** — e todo agente criado pela interface nasce `is_default: false` | o acervo de qualquer assistente que você criasse era inalcançável |
| 3 | 🔴 **Cadastrar a chave da OpenAI pela tela não habilitava nada.** `lib/ai/embed.ts` lia só `process.env`, enquanto `lib/ai/pontos/provedores.ts` promete na tela que a OpenAI é "necessária para indexar o seu material" | a pessoa cadastrava a chave em IA › Credenciais e o material continuava parado |
| 4 | 🔴 **Sem chave, o evento era consumido para sempre.** O worker devolvia `skipped`, e `drain.ts` conta `skipped` como sucesso | cadastrar a chave depois não recuperava o que ficou para trás |
| 5 | 🔴 **Upload de arquivo extraía o texto e DESCARTAVA** (`ingestPolicyFile` devolvia `{ chunkCount }` sem persistir), e a rota não tinha chamador nenhum na interface | o PDF subia e o agente nunca sabia o que estava nele |
| 6 | 🔴 **Preparar um material derrubava o outro**: a ingestão de conversas e a de FAQ competiam pelo único `active_kb_version_id` do agente | quem indexasse por último apagava o acervo do outro |
| 7 | 🔴 **Debounce sem timeout travava o evento para SEMPRE.** Com o Redis configurado e inalcançável — VPS com o contêiner caído —, `redis.set()` não voltava; `drainEventLog` marca `processing` ANTES do handler e **nada devolvia a linha** (o `job_queue` tem reaper, o `event_log` não tinha) | material cadastrado, nada acontece, e nem tentar de novo resolve |
| 8 | 🟠 **Arquivar não liberava o espaço** — nenhuma linha do repo jamais escreveu `is_active = false` | não dava para criar outro material do mesmo tipo, nunca mais |
| 9 | 🟠 **O limiar do código (0.72) vencia o calibrado (0.40)** em três sítios | paráfrase descartada: "posso trocar se não servir?" não achava a resposta escrita |
| 10 | 🟠 **Duplicar assistente perdia `pipeline_ids`**, e três INSERTs aceitavam `operator_*`/`pipeline_ids` no corpo e os descartavam | a cópia nascia sem escopo, com 201 dizendo que deu certo |
| 11 | 🔴 **Segurança**: as 4 tabelas do acervo aceitavam escrita de `viewer` pelo PostgREST | qualquer membro apagava a base de conhecimento da organização |
| 12 | 🟠 **O diálogo de cadastro não cabia na tela** — o botão "Adicionar ao acervo" ficava fora da viewport em 720px | o formulário existia e não se enviava (achado pela prova de tela) |

**Prova**: `tests/e2e/acervo-de-conhecimento.spec.ts` (6 casos, jornada inteira
pela tela) + `tests/invariants/rag-acervo-da-organizacao.test.ts` (recorte da
busca, versões legadas, imutabilidade do escopo, RBAC das 4 tabelas) +
`tests/unit/dreno-nao-perde-evento.test.ts`.

**NÃO MEDIDO**: o comportamento com acervo grande (milhares de trechos). O índice
vetorial `ivfflat` existe e o planner não o escolhe com o recorte de tenant — a
busca é exata e linear, correta e sem teto de recall. Vira issue.

---

## RAG do tenant — implementado e provado (2026-07-30)

Autorizado pelo dono, o RAG saiu do stub. **Cinco defeitos encadeados**: cada
conserto revelava o próximo, e nenhum aparecia sem rodar de verdade.

| # | Defeito | Como apareceu |
|---|---|---|
| 29 | Handler de `knowledge_source.updated` era stub declarado | só `nuvemshop.product_synced` indexava — e a Nuvemshop vem desligada |
| 30 | `ON CONFLICT` apontava para constraint **inexistente** | *"there is no unique or exclusion constraint matching"* — TODO chunk falhava. **O mesmo alvo errado estava no caminho de produto**: o RAG nunca gravou um chunk, para nenhuma fonte |
| 31 | `token_count` é NOT NULL e ninguém preenchia | *"null value in column token_count"* |
| 32 | 🔴 Versão **vazia** era marcada `ready` e **ativada** | numa instalação com base funcionando, uma indexação com problema trocaria a base boa por uma vazia — o agente perderia o RAG em silêncio |
| 33 | Fonte tipo `policy` era criada **vazia**, conteúdo descartado | a rota só tratava `source_type === "faq"`; política enviada com markdown voltava 201 com o conteúdo no lixo |
| 34 | 🔴 Limiar padrão **0.72** descartava toda paráfrase | medido: relevante 0.49–0.85, irrelevante 0.27. Só a pergunta **literal** passava — o RAG parecia quebrado funcionando bem |

**Decisão de arquitetura tomada** (a que faltava para destravar): a reindexação
**reconstrói UMA versão com TODAS as fontes**, em vez de uma versão por fonte —
a busca recebe um único `kb_version_id` e o agente aponta para uma única versão
ativa; uma versão por fonte faria o FAQ desativar o catálogo e vice-versa.

**Prova final, medida:** FAQ (4 itens) + Política (2 itens) → versão 5 com 6
chunks, ativa. Busca atravessando as duas fontes:

| Pergunta | Acerto | Semelhança |
|---|---|---|
| "quanto tempo demora pra chegar em BH?" | FAQ — prazo BH | 0.653 |
| "e se eu quiser devolver o produto?" | Política — devolução | 0.649 |
| "tem garantia?" | Política — garantia | 0.690 |
| "aceita pix?" | FAQ — pagamento | 0.490 |

E a tela ganhou o cadastro que faltava: o botão "Configurar" era stub `disabled`
com um toast que nunca aparecia.

## Áudio do WhatsApp

| # | Defeito | Estado |
|---|---|---|
| 35 | 🔴 **A transcrição mandava a chave da Anthropic para a OpenAI.** O Whisper é da OpenAI, mas recebia `llm.apiKey` (provedor de chat da org) → `transcription_401` em toda tentativa, com a `OPENAI_API_KEY` certa no `.env` | corrigido — fallback de ambiente para OpenAI, simétrico ao que a Anthropic já tinha |
| 36 | 🟠 **O agente responde ANTES de a mídia ser derivada** — dispatch às 20:24:22, derivação pedida às 20:25:03 | **aberto**: é ordenação de pipeline, não conserto pontual |

Prova: áudio real recebido (`type: audio`), agente respondeu *"não consigo ouvi-lo"*.
Com o 35 corrigido a transcrição passa a rodar; o 36 faz a PRIMEIRA resposta
ainda sair antes dela.

## Áudio: cadeia fechada (2026-07-31)

| # | Defeito | Prova |
|---|---|---|
| 35 | A transcrição mandava a **chave da Anthropic para a OpenAI** (`transcription_401`) | mesmo áudio: antes *"não consigo ouvi-lo"*; depois transcrito (`"Oi!"`) e o agente respondeu ao conteúdo |
| 36 | O turno era despachado **antes** de a mídia virar texto | log ao vivo: `drain: mídia ainda sendo transcrita — turno adiado (tipo: audio, esperando_ha_ms: 708)` |
| 37 | 🔴 **Regressão minha**: o alerta de job morto referenciava `last_error` numa CTE que não o devolvia — e como esse reap roda no BOOT, **o worker parou de subir** | worker em loop de reinício; corrigido e validado executando a query INTEIRA contra o banco (em transação com rollback) |
| 38 | Timeout padrão de 5s por teste reprovava teste saudável em máquina carregada | 3 falsos vermelhos locais em testes diferentes + 1 CI vermelho num PR de documentação; com 15s, 1473 testes verdes sob a mesma carga |

**Erro de método registrado (nº 37):** validei a expressão SQL nova contra linhas
reais, mas **isolada** — não dentro da CTE onde ela ia viver. Testei a peça, não
a montagem, e a peça passou. Mudança dentro de string SQL agora se prova
executando a query inteira.

## Agente pausado que continuava gastando (2026-07-31)

**Achado nº 39 — dinheiro indo pro ralo com o agente desligado.** Pausar o agente
pela tela tirava a resposta do lead, mas **não** tirava o gasto: o drain
enfileirava o turno assim mesmo, o worker resolvia credencial, chamava o LLM e só
então descobria que não havia ninguém publicado para atender. O usuário via
"pausado" e continuava pagando por token.

**A guarda.** `lib/agent-engine/edge/crm/drain.ts` agora pergunta ao banco, **antes
de enfileirar** (portanto antes de qualquer gasto), se existe alguém que pode
atender aquela sessão: agente com versão `published` ligada à sessão, **ou**
roteador ativo com fallback/membros. Não havendo nenhum dos dois, o turno é
pulado com log explícito (`nenhum agente publicado para a sessão — turno pulado
(sem gasto)`) e o evento fecha como processado — não fica reciclando na fila.

**Medida na VPS, com contador de chamadas de LLM (`llm_calls`).** Primeira
tentativa foi **teste confundido**: caiu na conversa que eu mesmo havia posto em
atendimento humano, e o log disse "turno pulado — lead em handoff humano", que é
outra guarda. Refiz com um contato sintético (`QA Sintetico`, número inexistente,
para o envio falhar sem incomodar ninguém):

| Estado do agente | `llm_calls` antes → depois | Resposta ao lead |
|---|---|---|
| pausado | 221 → **221** | nenhuma |
| republicado | 221 → **227** | respondeu |

Mesma mensagem, mesmo contato, só o estado do agente mudando — a diferença é do
efeito, não do cenário.

**Cobertura.** `drain.test.ts` ganhou 3 casos de capacidade (nenhum dos dois →
pula; agente publicado → despacha; roteador com membro → despacha). Sabotada a
guarda, ficam vermelhos.

**Custo colateral, e a lição.** A guarda deixou vermelho o invariante
`agent-dispatch-single-consumer`: o fixture dele nunca teve agente publicado,
então o drain passou a pular — corretamente. O CI pegou, que é o trabalho dele. O
fixture passou a criar o agente publicado: a premissa "existe alguém que pode
atender" sempre esteve implícita ali, e a guarda apenas a tornou observável. A
edição de invariante é congelada por hook; usei a válvula
`DESKCOMM_GOV_INVARIANTS_EDIT=1` **declarando o uso no commit** (`685d6e7`) em vez
de contornar em silêncio. CI verde em `2c045c4` (invariants, verify, e2e,
build-and-size, build-and-push).

---

## A atualização alcança o worker? (2026-08-13)

**Jornada nova, e ela nasceu de um defeito que nenhuma jornada existente cobria.** Todas as
jornadas do mapa exercitam o produto DEPOIS de instalado; nenhuma perguntava se uma correção
entregue numa versão nova chega mesmo a cada peça da VPS.

O serviço `worker` — o runtime do agente de IA — não tinha `image:` no `docker-compose.prod.yml`,
só `build:`. Isso o tornava invisível para `docker compose pull` ("Skipped — No image to be
pulled") e imune a `up -d` sem `--build`. Ele era construído na VPS no dia da instalação e
**nenhum `update.sh` jamais o reconstruiu**. Correções do agente não chegavam a instalação
nenhuma, e nada na tela nem no log dizia isso.

O dossiê desta suíte já tinha registrado o sintoma sem tirar a conclusão: a linha 295 anota,
do QA de instalação real, *"cache de build do Docker zerado (a VPS realmente compila o
worker)"*. O fato estava medido; a pergunta é que faltava.

**Casos desta jornada** (`[P0]` = primeira impressão / parque instalado):

| # | Caso | Estado |
|---|---|---|
| U1 `[P0]` | Instalação nova nasce pinada numa VERSÃO, não em canal móvel | coberto — `hostgator-setup-kit/test-validators.sh` roda o `install.sh` contra um remoto local com tags e cobra o `.env` |
| U2 `[P0]` | `update.sh` grava as TRÊS imagens na mesma versão | coberto — `tests/shell/update-guard.test.sh` §4b |
| U3 `[P0]` | Nenhum serviço de produção fica `build:`-only | coberto — `tests/unit/packaging-artefato-do-cliente.test.ts` |
| U4 | O crontab do scheduler não perde rota ao mudar de arquivo | coberto — `tests/shell/scheduler-entrypoint.test.sh` + `tests/unit/cron-routes-scheduled.test.ts` |
| U5 | `/api/v1/health` responde a versão real da imagem | coberto — medido no app real: com `APP_VERSION=9.9.9-teste` responde `9.9.9-teste`; sem ela, `desconhecido` |
| U6 `[P0]` | **Ensaio de atualização numa VPS real, de uma versão anterior para a nova, e o worker passa a rodar o código novo** | **EXECUTADO 2026-08-13** (U6-b, U6-c e **aplicado em produção**) — estado legado reproduzido do commit `ee520110`, worker migrou para a imagem publicada, nada perdido. **Com ressalva:** a 1ª execução do `update.sh` não conserta enquanto o canal `stable` não existir; a 2ª conserta. Evidência e limites em [`../runbooks/remediar-worker-congelado.md`](../runbooks/remediar-worker-congelado.md) §6 |
| U7 `[P0]` | Código **já** na tag nova + `.env` fixado na versão anterior: o `update.sh` atualiza, em vez de responder "Nada a atualizar" | coberto — `tests/shell/update-guard.test.sh` caso 12. **Defeito medido em produção em 2026-09-19** (deploy da v1.32.0): código em `v1.32.0`, `.env` em `:1.31.1`, resposta "Você já está na versão mais recente", exit 0, três contêineres na 1.31.1; só `--to v1.32.0 --force` atualizou. A sonda comparava o digest da imagem fixada com o **da mesma referência** — cega para tag imutável, que é como toda instalação fica desde U1. O caso carrega o próprio controle (12b), porque o dublê de `docker` calado faria a prova passar por vacuidade, e cinco sabotagens com previsão, uma por linha da regra. **NÃO medido:** o kit corrigido numa VPS real — a prova é com `docker` dublado, e o que ela garante é a DECISÃO do script, não que a máquina mudou de estado |
| U8 `[P0]` | Atualização com a **telefonia ligada**: os números de telefone voltam a registrar na operadora sozinhos, pela porta 5060 | **defeito medido na VPS em cinco atualizações** (1.52.2, 1.52.6, 1.55.0, 1.56.0, 1.57.0): o Asterisk recriado nasce com outro IP, a porta 5060 fica presa ao antigo na tabela de conexões, o novo sai por outra (60039) e a operadora recusa — sem voltar sozinho. **Conserto no kit** (`religar_troncos_sip`, chamada pelo `update.sh` depois do `up -d`; à mão, `religar-telefonia.sh`). **Coberto** por `tests/shell/telefonia-porta-sip.test.sh` (a regra, com 54 sabotagens, nenhuma verde) e `tests/shell/update-guard.test.sh` caso 16 (o encaixe, com o `update.sh` inteiro). **Provado em laboratório em 2026-10-07** com NAT e Asterisk de verdade — uma "VPS" em Docker-in-Docker (dockerd 29.8.0) registrando numa "operadora" Asterisk 20.11: o defeito reproduzido como na VPS (antiga na 5060, nova na 64466); dez ciclos de quebrar e consertar com a operadora disputando a porta a cada 3 s, dez registros pela 5060 em 14 a 25 s, um reinício do worker cada; com ligação em curso — ou com o Asterisk sem responder se há — o worker não é reiniciado; servidor com e sem `conntrack`; o Asterisk em duas redes, como no override do Traefik, saindo pela segunda da lista; imagem antiga sem `conntrack` cai na mensagem com o comando manual. **Medido na VPS de produção em 2026-10-07, no deploy da 1.57.2** (a atualização que TRAZ o conserto, então quem rodou foi o `update.sh` anterior, e o `religar-telefonia.sh` foi chamado à mão logo em seguida): o script leu a tabela de conexões do servidor pelo `conntrack` embutido na imagem do Asterisk (contêiner efêmero, `conntrack v1.4.8`), julgou certa a linha real (`src=172.19.0.2 … dport=5060`), leu os 4 números com nome de produção, viu 0 canais, reiniciou o worker DE VERDADE e só declarou "voltou" depois de achar, no log dele, a linha `telefonia: tronco enviado ao Asterisk` posterior ao reinício — `4 de 4`, em 14 s, com a operadora real. Nesse deploy o Asterisk renasceu com o MESMO IP, então a porta não ficou presa. **NÃO provado:** o caso da porta presa na VPS, com a operadora real (ela RECUSA o registro pela porta errada; a do laboratório aceita — o estado "recusado" foi exercitado só com senha errada); e o passo AUTOMÁTICO dentro do `update.sh`, que roda pela primeira vez na atualização seguinte à 1.57.2. **Achado do mesmo deploy:** rodado 5 s depois de o worker enviar os números, o modo manual viu três deles ainda no meio do registro (`Unregistered (exp. 1s)`) e reiniciou o worker sem precisar — o passo automático só espera, não reinicia. Uma revisão independente do conserto achou três defeitos antes do PR fechar (a guarda de ligação falhava aberta com o Asterisk mudo; a prova de "o worker reenviou" não conferia o *depois do reinício*; à mão, sem número nenhum, o worker era reiniciado) — os três consertados e presos por teste |

U6 deixou de ser buraco em 2026-08-13, e o ensaio pagou o próprio custo: revelou que a
primeira execução do `update.sh` não conserta o worker enquanto o canal `stable` não
existir — coisa que nenhum teste do CI podia mostrar, porque não é sobre o que os scripts
fazem, e sim sobre a ORDEM em que o parque encontra as peças.

O que continua fora: o app contra um Supabase real (o ensaio usou Postgres em contêiner),
uma sessão de WhatsApp pareada de verdade (foi um marcador no volume), e o `install.sh`
completo da época (exige projeto Supabase). Segue valendo a régua de `vps-fresh-onboarding`:
o CI prova que os scripts fazem o que dizem, não que a máquina de alguém mudou de estado.

---

## O cliente do revendedor vê a marca de quem o atende? (2026-08-14)

**Jornada nova, e ela cobre a persona que nenhuma outra cobre: o REVENDEDOR.** Todas as
jornadas acima olham a instalação pelos olhos de quem a usa. Esta olha pelos olhos de quem a
**vende** — a agência que instala numa VPS, põe a própria marca e cobra por isso, que é o
modelo de monetização declarado do produto (`docs/white-label.md`).

Ela nasceu de uma frase falsa em documento público. O `white-label.md` prometia, em texto de
venda, que "cores, fontes e tema não são configuráveis" e que "a marca é por instalação, não
por organização" — as duas coisas deixaram de ser verdade no épico de marca própria, e o
documento seguiu vendendo o limite antigo. O oposto também apareceu: o autenticador registrava
o nome fixo do nosso produto, e isso morava numa lista de "aberto para decisão do dono" há
semanas, sem dono.

**Por que quase toda a régua aqui é `[P0]`:** um vazamento de marca não parece um bug para
quem o comete — a tela funciona, o e-mail chega, o teste passa. Ele só existe aos olhos de um
terceiro (o cliente do revendedor) que descobre, no meio de uma conversa de venda, o nome de um
software que ele não contratou. Não há gravidade média nisso.

**Onde o código vive:** `lib/branding/` (resolvedor, rampa, contraste, saída sem DOM),
`app/admin/(protected)/marca/` e `app/app/settings/marca/` (as duas telas),
`hostgator-setup-kit/marca-emails.sh` (os e-mails de acesso) e o mapa
[`../architecture/marca-propria.architecture.json`](../architecture/marca-propria.architecture.json).

| # | Caso | Estado |
|---|---|---|
| `M1` `[P0]` | Instalação com a marca do revendedor: a **aba** mostra o nome dele e o **ícone** carrega **deslogado** | **PASS por comportamento** (2026-08-13, build de produção): com `app_name='Vendas Turbo'` e `accent_hex='#f2c94c'` gravados, o ícone virou **V sobre `#6e5c28`** — o accent DERIVADO, não a semente crua — e o título trocou. Spec `tests/e2e/icone-da-marca.spec.ts` no disco **e inscrita** em `SPECS_PARTE_1` (`.github/workflows/e2e.yml:106`). **NÃO medido: a primeira execução dela no CI** |
| `M2` `[P0]` | O **e-mail de confirmação de conta** chega com a marca do revendedor — ou, sem `SUPABASE_ACCESS_TOKEN`, o passo manual é impresso e a instalação segue | **PARCIAL.** O mecanismo foi medido contra a API real num projeto descartável: `PATCH /v1/projects/{ref}/config/auth` com `mailer_templates_*` **é aceito e PERSISTE sem SMTP customizado** (releitura por `GET`, estado restaurado). Achado do rig: **projeto pausado responde 400 "Project is paused."** — modo de falha que um script confiando em 2xx reportaria como sucesso, e por isso `marca-emails.sh` relê o que gravou. **NÃO medido: um e-mail efetivamente entregue numa caixa de entrada** |
| `M3` `[P0]` | **Convite de time**: assunto e corpo com a marca; sem `RESEND_*`, a tela mostra o `accept_url` em vez de falhar calada | **COBERTO POR TESTE, NÃO PROVADO NA TELA.** `tests/unit/email-marca-e-remetente.test.ts` e `tests/unit/branding-saida.test.ts` guardam a resolução e o remetente; `RESEND_FROM_EMAIL` vazio passa a significar `not_configured`, que cai no caminho que já existia (`accept_url` na tela, `pending_review` no worker de LGPD). Falta dirigir o browser num ambiente fresco **sem** `RESEND_API_KEY` |
| `M4` `[P1]` | **Cadastro de MFA**: o app autenticador registra a marca da instalação | **ENTREGUE, PROVA CONTRA GoTrue REAL NÃO LOCALIZADA.** `app/actions/auth/enrollMfa.ts:59` passa `issuer: marca.nome` — o campo que de fato grava no celular (`friendlyName` **não** entra na URI `otpauth://`, medido contra GoTrue v2.188.1). O plano exigia repetir o rig de enroll real antes de fechar; não achei registro dessa execução. **Vale só para quem enrolar depois: trocar o `issuer` não reescreve fator já cadastrado** |
| `M5` `[P1]` | **Export de LGPD**: o PDF nomeia o **controlador** (`legal_name`) e o DPO — **nunca** a marca do revendedor | **COBERTO POR TESTE.** O teste isola o rodapé e exige que o texto entre `Controlador:` e `· Relatório LGPD` seja **exatamente** o `legal_name` (a primeira versão só checava `/deskcomm/i` e teria deixado passar a marca de um revendedor). Vigiado também no mapa de arquitetura, que reprova quem ligar o PDF ao resolvedor de marca. **Armadilha viva:** `legal_name` nasce igual ao nome fantasia — o caso ruim é o valor plausível e errado, e quem resolve é a tela `/app/settings/tenant` |
| `M6` `[P1]` | **Marca por organização**: a cor da org pinta `/app` e **não** vaza para o `/login` | **PASS na tela** (2026-08-13), com admin de tenant PURO — a precondição falhou primeiro e era a armadilha prevista (`e2e-admin` **era** `platform_admin`; medi `count=1`, revoguei, reafirmei `count=0`, só então testei). `#b3261e` no claro, `#f16051` no escuro, persistido no reload, e **ausente** em `/login` sem sessão. Evidência: `evidence/org-1-tela.png`, `evidence/org-2-digitado.png`, `evidence/org-3-salvo.png`, `evidence/org-4-recarregado.png`, `evidence/org-5-login.png` |
| `M7` `[P2]` | Cor inválida: cai para o padrão, o estado fica gravado e a tela **mostra** por quê | **PASS na tela** para a recusa (hex inválido → **Salvar desabilitado**, evidência `evidence/marca-3-invalido.png`). `fallback_at`/`fallback_reason` são gravados por `registrarEstadoDaMarca()` e lidos por `/admin/marca`. **Corrigido em 2026-08-14 (`214f47f0`) o que esta célula dizia:** ela afirmava que o estado "só aparece para quem editar o banco à mão ou vier de um clone com valor legado" — e nenhuma das duas é possível, porque o CHECK `^#[0-9a-f]{6}$` entrou na `create table` da migration 0155 e a coluna nunca existiu sem ele. O caminho que **existe** é o `.env`: `lib/env.ts:201` não valida formato (`z.string().optional().default("")`, e o docblock explica por quê), então `APP_ACCENT_HEX=verde` acende `semente_invalida`. Coberto por `tests/unit/branding-fallback-alcancavel.test.ts`. **NÃO medido pela tela:** forçar esse caminho no browser exigiria subir a stack com `.env` hostil — o teste roda o código real de resolução, não o render |
| `M8` `[P0]` | O revendedor **descobre** que dá para trocar a marca | **PASS estrutural.** `/app/settings/marca` está declarada em `lib/navigation/registry.ts` (grupo Configurações, `sidebar:false` — tarefa de uma vez, o hub e o ⌘K garantem a descoberta), e `tests/unit/navegacao-completude.test.ts` reprova tela sem porta. `/admin/marca` é de platform admin e fica fora dessa varredura por construção |
| `M9` `[P0]` | **Logo por arquivo**: o dono do servidor sobe um PNG e ele aparece na barra lateral E no `/login` **deslogado**; a empresa sobe o dela e a fachada NÃO muda; SVG renomeado é recusado com a razão; remover devolve o logo da camada de baixo | **SPEC ESCRITA, EXECUÇÃO PENDENTE POR INFRA.** `tests/e2e/marca-logo.spec.ts` no disco e inscrita em `SPECS_PARTE_2` (`.github/workflows/e2e.yml:148`, como ÚLTIMA da lista — se a restauração dela falhar, o alcance da contaminação é zero spec), com os 6 casos e as medições por ferramenta (`src` + `naturalWidth`). ⚠️ **A régua desta linha já esteve errada:** ela dizia `getBoundingClientRect().height`, "porque `src` certo com altura 0 é o sintoma de bucket privado". É falso — os `<img>` de marca têm altura fixada por CSS (`h-7`, `h-10`), e o medido em chromium é `boa={"nat":1,"altura":28}` contra `quebrada={"nat":0,"altura":28}`: a altura passava nos dois. Quem prova o download é `naturalWidth`. **NÃO MEDIDO: nenhuma execução da spec.** O daemon do Docker está fora do ar nesta janela (`docker info` pendura >60s), e sem ele não há Supabase local, nem `pnpm test:db`, nem Playwright contra um banco fresco. Prova pendente por infra **não é prova feita**. O que ESTÁ medido é o lado unitário (`tests/unit/branding-logo-arquivo.test.ts`, 19 casos, com 3 sabotagens de contagem prevista) e a estrutura do banco (`tests/invariants/marca-logo.test.ts`, escrito e **não executado**) |

**O que esta jornada ainda NÃO cobre, e é onde eu apostaria o próximo defeito:** a instalação
fresca ponta a ponta com a marca de um revendedor — `install.sh` numa VPS, respondendo
`APP_NAME` com um nome de verdade, e conferindo os **cinco** artefatos que saem dali (aba,
ícone, e-mail de acesso, convite, endereço de suporte). É a mesma lacuna de
`vps-fresh-onboarding`: os testes provam que cada peça faz o que diz, não que a jornada de
quem compra funciona inteira. Os defeitos de marca que mais custam caro moram exatamente aí,
porque são vistos primeiro por um terceiro. **A receita para fechá-la está em J10, abaixo.**

## J10 — Instalação fresca com a marca do revendedor `[P0]` (receita manual)

**Por que isto é receita escrita e não spec.** O lugar natural desses casos seria
`tests/e2e/vps-fresh-onboarding.spec.ts`, e ela é a **única** spec do repo fora do CI —
`.github/workflows/e2e.yml`, bloco `FORA_DO_CI`. Nenhum job a invoca. Acrescentar dois
`expect()` ali produziria asserção que nunca executa, com a aparência de cobertura: pior que
a ausência, porque a ausência pelo menos se vê. Enquanto a spec não tiver quem a rode, o
artefato honesto é o procedimento — com os comandos exatos, para que a execução seja
repetível por outra pessoa e o resultado seja comparável.

**Estado:** `NÃO EXECUTADA`. Quem executar, troque por `PASS`/`FAIL` com data, SHA e as
evidências, e mova os achados para a tabela de defeitos.

**Pré-condição:** VPS limpa com acesso SSH, um domínio apontado para ela, um projeto
Supabase novo (ou `SUPABASE_ACCESS_TOKEN` exportado, para o `install.sh` criar), e uma chave
da Anthropic. **Deliberadamente SEM `RESEND_API_KEY`** — é o estado do primeiro deploy, e é
onde moram os piores defeitos de primeira impressão (`lib/email/resend.ts:94-108` devolve
`{ok:false,"not_configured"}` **em silêncio**).

```bash
# 1. Na VPS, com o kit na pasta corrente
bash install.sh
#    Responda com uma marca que NÃO seja a nossa — é o ponto do teste:
#      APP_NAME        → Vendas Turbo
#      APP_ACCENT_HEX  → #f2c94c   (o instalador valida a forma: # + 6 dígitos)
#      SUPPORT_EMAIL   → suporte@vendasturbo.exemplo
#      RESEND_API_KEY  → (Enter, pule)
#    ⚠️ Até `c8fc877d` o instalador NÃO perguntava a cor (`grep -c APP_ACCENT_HEX
#       install.sh` → 0), e todo revendedor recebia o verde do produto nos e-mails
#       de acesso. Se a pergunta não aparecer na sua execução, é regressão — o
#       caso da VPS limpa em `test-validators.sh` a vigia.

# 2. Confira que o domínio responde 307 (redirect para o login), não 404
curl -s -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/

# 3. Logue como o admin criado pelo install, abra /admin/marca e grave a cor
#    (`#f2c94c` serve). Depois SAIA da sessão.
```

| # | Caso | O que conferir | Como |
|---|---|---|---|
| `J10.1` | **Aba** — quem abre o domínio vê o nome do revendedor | O `<title>` contém `Vendas Turbo` e **não** contém `Deskcomm` | `curl -s https://<DOMAIN>/login \| grep -o '<title>[^<]*</title>'` |
| `J10.2` | **Ícone** — o favicon carrega **deslogado**, na cor do revendedor | `/icon` responde 200 e o SVG tem o accent DERIVADO (não a semente crua) | `curl -s -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/icon` e abrir a aba no browser |
| `J10.3` | **E-mail de acesso** — o "confirme sua conta" do GoTrue chega com a marca | Rodar `bash marca-emails.sh` e conferir na caixa real. **Sem `SUPABASE_ACCESS_TOKEN`, o script imprime o passo manual e a instalação segue** — esse ramo também é PASS, e é o caminho da maioria | caixa de entrada de verdade, não log |
| `J10.4` | **Convite** — sem `RESEND_API_KEY`, a tela mostra o `accept_url` em vez de falhar calada | `/app/team/invite` → convidar → a tela exibe o link | pela tela |
| `J10.5` | **Endereço de suporte** — o cliente do revendedor nunca vê o nosso | `SUPPORT_EMAIL` (resolvido em `lib/branding/saida.ts:238`) aparece em `/app/settings/billing` e em `/account-suspended`; sem ele, o parágrafo some em vez de mostrar um endereço nosso | pela tela, nas duas rotas |

**Armadilha conhecida (mede-se antes de concluir):** o bloco que escreve o `.env` é
truncante (`} > .env`) e reescreve o arquivo a partir de uma **lista fechada de `envq`**.
Chave que o kit não conhece é preservada no fim do arquivo (`PRESERVADAS`, `install.sh:1251`);
chave que a entrevista **pergunta e a lista de `envq` não tem** é respondida e perdida, sem
erro. É por isso que perguntar sem gravar é pior que não perguntar. Antes de dar `FAIL` em
qualquer caso acima, rode `source .env && echo "$APP_NAME|$SUPPORT_EMAIL"` e confirme que o
que você digitou está no arquivo — sintoma de marca ausente costuma ser isto, não o
resolvedor.

---

## Por que uma IA publicada não responde — seis causas medidas numa VPS real (2026-08-18/19)

Investigação dirigida pela tela numa instalação EasyPanel com WhatsApp real,
agente publicado e o dono relatando "a IA não responde". Nenhuma das seis causas
aparecia como erro para quem operava: a conversa mostrava **"IA atendendo"** o
tempo todo. É a jornada `J3`/`J8` vista de perto, e o padrão é sempre o mesmo —
**um lugar que engole a resposta e devolve sucesso**.

| # | Onde | Defeito | Como foi provado | Correção |
|---|---|---|---|---|
| 1 | `edge/crm/session-watchdog.ts` | Hold `go_live` (número novo) mandava **todo `inbound_turn`** para `run_after='infinity'` — não só o disparo proativo. O único sinal era um item de Central `info` falando de "outbound" | item aberto na Central + zero `llm_calls` para a conversa | hold reason-aware: `go_live` retém só `followup_turn` |
| 2 | `resolve-turn-agent.ts` | Roteador **ativo com zero membros e sem fallback** derrubava a sessão inteira no agente genérico, que caía em `settings.llm` sem credencial → `LlmNotConfiguredError` → 5 tentativas → job morto | `GET /api/v1/ai/routers` (`member_count: 0`) + aviso `Job descartado após esgotar tentativas` | sem fallback, atende o agente publicado da sessão |
| 3 | `agent/inbound-turn.ts` | Fora da **janela anti-ban** (7h–22h) o veto do `pacingGate` virava erro de ensino ao modelo: turno terminava `ok`, sem envio e sem reagendamento | run `agent_turn` `ok` às 22:56 e **zero outbound** na conversa | reagenda o job para a abertura (doutrina `restricao-de-canal.md` §2) |
| 4 | `agent/agent-config.ts` | **Horário de funcionamento** da versão publicada (08:00–18:00 seg–sex) não era lido por ninguém vivo — só pelo dispatcher legado, hoje NO-OP | agente respondendo 21:55 de uma terça | janela lida no turno; fora dela, adia |
| 5 | `followup/node-handlers.ts` | Enrollment morria com `action_turn_never_completed` em ~25 min esperando a janela abrir | enrollment `dead` no nó de abertura com o worker vivo | backoff + orçamento de ~11h |
| 6 | `ai/log-invocation.ts` + card do agente | Duas telas mentindo: `erro_legado` no lugar de `limite_ou_saldo` (chave sem saldo), e o card anunciando o modelo da **criação** (`claude-sonnet-5`) enquanto o motor rodava o da **versão publicada** (`nvidia/nemotron-…:free`) | `/app/ai/runs` + `GET /versions` | `normalizarErro` no caminho legado; card lê a versão publicada |

**Lição para o mapa:** nenhum desses casos falha com tela vermelha. Todos falham
com **status verde e mensagem ausente**. Um caso de jornada que só verifica "a
tela não deu erro" passa em todos os seis — a prova precisa ser sempre *a
mensagem chegou no WhatsApp do lead*.
## O sistema cabe num telefone de 390px? (2026-08-20)

Origem: issue #203 — em 390px o shell reservava a faixa do sidebar de desktop
(`ml-60`/`ml-16`) e o header vazava para fora, medido `scrollWidth=462` contra
`clientWidth=390`. O usuário leigo abre o CRM no celular; barra horizontal na
primeira tela é a primeira impressão.

| caso | prioridade | estado |
|---|---|---|
| Em 390×844, o sidebar de desktop sai da árvore acessível e a navegação vira gaveta | `[P1]` | **PASS**, medido por ferramenta em `tests/e2e/navegacao.spec.ts` (bloco `mobile`): `documentElement.scrollWidth <= clientWidth + 1` depois do login, com a gaveta aberta, e depois de navegar por ela. Evidência em `.superpowers/evidence/nav-mobile-390-drawer-aberta.png` — a captura é apoio, quem afirma é a medida |
| `/admin` em 390px | — | **NÃO COBERTO.** `components/admin/AdminSidebar.tsx:58` é `w-60` sem prefixo responsivo: o mesmo defeito da #203, instância não consertada. Público é só platform admin, por isso ficou como issue e não como bloqueio |
| Estouro DENTRO do `<main>` | — | **NÃO COBERTO.** `AppShell.tsx` dá `overflow-auto` ao `<main>`, que é contêiner de rolagem próprio: conteúdo largo rola lá dentro sem aumentar `documentElement.scrollWidth`. A sonda é fiel ao sintoma da #203 e não prova que as telas densas (Kanban, Inbox) são usáveis em 390px |

**Armadilha que custou dois testes verdes:** `loginComoAdmin` espera a virada da
janela TOTP entre logins consecutivos (o servidor recusa código repetido), e
essa espera sozinha estoura o teto global de 30 s do `playwright.config.ts`.
Toda spec que usa o helper sobe o teto (240 s em quatro delas, 90 s em uma) —
isso não está escrito em lugar nenhum, e quem adota o helper sem subir o teto vê
dois testes alheios estourarem sem call log de locator. Se você for adotar o
helper numa spec nova: `test.describe.configure({ timeout: 120_000 })`.

## O menu inteiro cabe na dobra de um notebook? (2026-09-04)

Origem: PR #546 pôs a tela de **Tarefas** no grupo CRM e o menu passou a rolar.
Medido pela tela, 1280×900, logado como admin: `nav.scrollHeight` **776** contra
**763** de altura útil — **13px** de excesso, 19 links, 5 grupos. Nenhum título
de grupo caía fora da dobra; o que quebrava era o `rola`.

A resposta NÃO foi raspar densidade: o comentário de `components/shell/Sidebar.tsx`
já dizia, desde a vez em que Produtos estourou a dobra por uma linha, que "quando
o quinto destino de CRM aparecer, é hub que se cria, não mais 4px que se raspa".
Tarefas foi o quinto. Criou-se `/app/crm` — o mesmo mecanismo (`group.hub`) que o
grupo IA já usava.

| caso | prioridade | estado |
|---|---|---|
| Em 1280×900 o menu inteiro cabe sem rolar | `[P1]` | **PASS**, medido por ferramenta em `tests/e2e/navegacao.spec.ts`: `scrollHeight` **763** = altura **763**, excesso **0**, 18 links. A folga real — distância entre o fim do último grupo e o fim da caixa de conteúdo da `<nav>`, que o `scrollHeight` grampeado NÃO revela — é **19px** |
| Etapas do funil continua alcançável pelo CRM, não por Configurações | `[P1]` | **PASS**, e o caminho é percorrido inteiro: sidebar → "Ver tudo em CRM" → `/app/crm` → card → `settings/tenant/pipelines`. Evidência em `.superpowers/evidence/nav-hub-crm.png` |
| Produtos, que saiu do menu, continua tendo porta (DoD 14) | `[P1]` | **PASS**, caso próprio na mesma spec: o link não existe no sidebar (`toHaveCount(0)`) e existe no hub |
| A folga de 19px é real | — | **PROVADO POR SABOTAGEM.** Um sexto destino de CRM com `sidebar: true` devolve o excesso a exatamente **+13px** e reprova o mesmo caso — previsto antes de rodar, e batido |
| 19px é menos de uma linha (28px + 4px de intervalo = 32px) | — | **ACEITO, com a saída declarada.** O próximo item de sidebar volta a estourar. Só que CRM, IA e Organização têm hub: tela nova em qualquer um dos três não pressiona mais o menu. Quem ainda pressiona é grupo SEM hub — Atendimento (4), Canais (3), Análise (3) —, e para eles a resposta escrita é a mesma: cria-se o hub |

**O que a medição do `scrollHeight` NÃO responde:** quando o conteúdo cabe, ele é
grampeado no `clientHeight`, então "excesso 0" e "sobra 200px" dão o MESMO número.
Quem quiser saber quanta folga restou tem de medir o `bottom` do último filho
contra a caixa de conteúdo da `<nav>` — foi assim que os 19px saíram.

## O Inbox usa a tela inteira, e a barra lateral nasce recolhida (2026-09-21)

Origem: pedido do dono, olhando o Inbox em produção — o chat perdia um respiro à
esquerda (junto da barra), à direita e em cima (junto da linha do cabeçalho); a barra
lateral ocupava 240px de uma tela em que lista, conversa e ficha disputam largura; e
os três "Ver tudo em …" desenhavam a mesma seta. Fragmento de release:
`.changes/inbox-de-borda-a-borda-e-barra-recolhida.md`.

Medido em Chromium, banco fresco do `baseline.sql`, `next build` + `next start`, com uma
conversa de cinco mensagens aberta, 1440×900 — `getBoundingClientRect`, não a olho:

| caso | prioridade | estado |
|---|---|---|
| Sem nenhum cookie, a barra vem recolhida (64px), sem títulos de grupo | `[P0]` primeira impressão | **PASS**, `tests/e2e/barra-lateral-recolhida-por-padrao.spec.ts`. O padrão vem do cookie **ausente**: `lib/navigation/barra-lateral.ts`. A forma antiga (`=== "1"`) o deixava cair na barra aberta |
| O Inbox encosta nas quatro bordas: barra, linha do cabeçalho, borda direita e borda de baixo | `[P0]` | **PASS.** Antes **24 / 24 / 24 / 24px**, depois **0 / 0 / 0 / 0px**. A coluna da conversa foi de **500px para 724px** (+224px) com a barra recolhida e para **548px** com a barra aberta por escolha (+48px). Antes = build atual com a geometria antiga emulada por estilo, na mesma página — a comparação não mistura builds |
| A grade não obriga a página a rolar (o composer não nasce abaixo da borda) | `[P0]` | **PASS**, `scrollHeight - innerHeight = 0` em 390×844, 768×1024, 1024×768, 1280×800, 1440×900 e 1920×1080. **`overflowX` = 0** nas seis — a margem negativa não vaza no celular |
| Expandir a barra persiste ao F5, e recolher também | `[P1]` | **PASS**, mesma spec: 64px → 240px → F5 → 240px → 64px → F5 → 64px |
| Os três "Ver tudo em CRM / IA / Análise" têm ícones diferentes, com a barra recolhida e com ela aberta | `[P1]` | **PASS**, três `<svg>` distintos nos dois estados. Aperto de mão, brilho, fatia de gráfico. A propriedade geral — nenhum ícone se repete no menu, em nenhum papel — é `tests/unit/sidebar-icones-distintos.test.ts` |
| Os e2e que medem a barra ABERTA continuam medindo-a | — | **PASS**: `playwright.config.ts` planta o cookie `sidebar_collapsed=0` em todo contexto; só a spec acima o desliga. 39 casos passaram (2 pulados, ver abaixo) em `navegacao`, `interface-por-vinculo`, `central-avisos-destino`, `logo-moldura-no-tema-escuro` e sete das oito `inbox-*` — a que ficou de fora, `inbox-tempo-real`, o CI também não roda |
| Provado por sabotagem | — | Voltar a regra para `=== "1"` reprova 3 casos (inclusive o do layout executado); zerar os ícones dos hubs reprova os 6 casos de ícone, citando "Ver tudo em CRM = Ver tudo em IA = Ver tudo em Análise" |

**Não medido:** `inbox-responder-citando.spec.ts` **pula** os dois casos nesta máquina e
já pulava — o helper `abrirConversaComMensagens` clica no primeiro `li` da página, que é o
do menu lateral, e nunca chega a uma conversa. Independe desta mudança, e por isso a
spec segue sem provar o que promete. Radar (`ClockCountdown`) e Atividades
(`ClockCounterClockwise`) são dois relógios parecidos, mas não são o mesmo ícone, e ficaram.

## O inbox em tempo real — o defeito que veio de fora (2026-08-24)

**Sintoma relatado pelo dono:** *"Recebemos mensagem e só reflete no inbox (na
UI) se atualizarmos a página."*

**Causa raiz, medida no socket — não estava em nenhuma linha nossa.** O cookie
de sessão é httpOnly, então o supabase-js do browser não enxerga a sessão. Nesse
caso a callback `accessToken` PADRÃO do `SupabaseClient` termina em
`?? this.supabaseKey`: **o socket do Realtime assinava com a anon key**. Canal
anônimo responde `SUBSCRIBED`, a RLS filtra do outro lado, e ele nunca entrega
nada — em silêncio, com todo sinal disponível dizendo "saudável".

O repo já corrigia isto chamando `supabase.realtime.setAuth(token)`. **Aquilo
parou de funcionar num bump de dependência**, sem uma linha nossa mudar: a
partir do realtime-js 2.112.x a callback vence o token manual, o que a própria
biblioteca documenta em `setAuth` — *"the callback is the source of truth (…)
even after a bootstrap/override `setAuth(token)` call"*.

**Como foi medido** (ligando o `logger` do realtime-js e instrumentando
`setAuth`, com dois canais no mesmo socket — que é o que o inbox faz, lista +
conversa aberta):

| Sonda | O que assinou | Entregas |
|---|---|---|
| tabela de controle sozinha, policy `using(true)` | 1 canal | **entregou** |
| `conversations` sozinha | 1 canal | **entregou** |
| controle **+** `conversations` no mesmo socket | 2 canais | 1º entregou, **2º zero** |

O `phx_join` do 1º levava `{"iss":"…/auth/v1"}` (JWT do usuário); o do 2º levava
`{"iss":"supabase-demo","role":"anon"}`. Instrumentando `setAuth`: o token do
usuário durava ~2ms antes de `_setAuthSafely` o trocar, e o heartbeat (~30s)
refazia a troca para sempre.

**O que a tabela de controle provou, e por que ela importa.** Sem ela, "zero
entregas" seria indistinguível de instrumento quebrado — que devolve zero do
mesmo jeito. Ela é o controle positivo que valida a sonda.

**Conserto:** fonte ÚNICA de token, na callback `realtime.accessToken` de
`lib/supabase/browser.ts`. Ela é melhor que o `setAuth` por uma razão que
independe do bug: o socket a chama de novo a cada heartbeat e em cada reconexão,
então o token de 1h deixa de ser bomba-relógio para quem fica com o inbox
aberto. Sai do `useRealtimeChannel` toda a dança de auth — mantê-la seria manter
duas fontes, que era o defeito.

**Complemento medido na Task2 (2026-09-05):** no SDK 2.112.4, o primeiro
subscribe pode emitir join antes de resolver a callback. O hook agora aguarda
o bootstrap da MESMA fonte e setAuth antes de criar o canal; a callback segue
renovando. Epoch/cancelamento impedem resposta tardia de contexto anterior.
A jornada de suporte em múltiplas abas exige todos os joins authenticated e
evento postgres_changes real antes de aceitar a atualização B. Nenhum EXECUTE
foi concedido a anon.

**Segundo achado, do mesmo puxão:** o inbox era **a única tela viva sem rede de
segurança**. Board (`useBoard`) e linha do tempo (`useLeadTimeline`) já usavam
`useRefetchDeSeguranca`; o inbox tinha só `refetchOnWindowFocus`, que exige
TROCAR DE ABA. E o inbox é a tela em que se fica parado olhando: com o canal
morto e a aba em foco, a lista ficava congelada indefinidamente num passado que
parece presente. Agora as duas pontas (lista e conversa) têm a rede.

**Por que os testes estavam verdes o tempo todo** — a lição que vale além deste
bug: eles exercitavam `authenticateRealtime` contra um cliente FAKE
(`{ realtime: { setAuth: vi.fn() } }`) e afirmavam que `setAuth` fora CHAMADO. O
que quebrou foi o EFEITO de chamá-lo. **Teste que guarda a chamada em vez do
comportamento não vermelhece quando o comportamento morre.**

| # | Caso | Prova |
|---|------|-------|
| JR.1 | Mensagem chega na conversa ABERTA, sem reload | `tests/e2e/inbox-tempo-real.spec.ts` (dirige a tela; nenhum `reload()` depois de abrir o inbox) |
| JR.2 | A LISTA reage à mesma mensagem | mesmo spec — é o 2º canal do socket, o que ficava anônimo |
| JR.3 | A callback é a fonte do token, e nunca a anon key | `tests/unit/realtime-token-do-socket.test.ts` |
| JR.4 | O hook não autentica por conta própria (fonte única) | idem |
| JR.5 | Token perto de vencer é renovado; token válido vem do cache | idem |
| JR.6 | As duas pontas do inbox têm rede de segurança | `tests/unit/realtime-reconecta.test.ts` |

**Sabotagens que confirmam que os testes vigiam** (rodadas em 2026-08-24, com o
conserto já commitado):

| Sabotagem | Reprovações |
|---|---|
| remover a callback de `browser.ts` | 6 de 7 |
| a callback devolve a anon key (o que a PADRÃO fazia) | 3, incluindo *"devolve o token da sessão — NUNCA a anon key"* |
| tirar a rede de segurança da lista de conversas | 1, apontando a lista |

**A prova que fecha o caso — o mesmo teste dos dois lados** (2026-08-24, build de
produção contra o Supabase local, banco semeado pelos scripts do repo):

| Código sob teste | Resultado |
|---|---|
| com o conserto | `1 passed` — a mensagem apareceu na tela sem reload |
| revertido ao da `main` (`git checkout main -- lib/supabase/browser.ts hooks/realtime/useRealtimeChannel.ts`) | `1 failed` — *element(s) not found*, 25 s |

Reverter **só o fonte**, mantendo o teste, é o que separa "o teste vigia" de "o
teste passa". Um verde sozinho não distingue as duas coisas.

⚠️ **Achado de ambiente, não do repo:** o build morria com
`'node_modules/node_modules' is a symlink causes that causes an infinite loop!` —
um symlink auto-referente de 2026-08-13, resíduo de sessão anterior (nenhum
script do repo o cria). E o primeiro build parecia ter passado porque
`pnpm e2e:build 2>&1 | tail -20` devolve o exit do `tail`, não o do build
([[feedback-pipe-tail-mascara-exit]]). Confira `.next/BUILD_ID`, nunca o exit de
um pipe.

### Vai escrever uma spec que depende de tempo real? Leia isto primeiro

**No CI, o Realtime sobe ANTES de as tabelas entrarem na publication.** O `e2e.yml` faz
`supabase start` (que sobe o Realtime) e só depois aplica o `baseline.sql`, que é quem
adiciona `messages`, `conversations`, `crm_leads` e as demais à publication
`supabase_realtime`. O Realtime já subiu sem elas e não as reconhece depois: **assina,
responde `SUBSCRIBED` e nunca entrega**.

Custou três rodadas de CI de 15 minutos para achar, porque o sintoma é idêntico ao do canal
anônimo — os dois respondem `SUBSCRIBED` e calam. O que separou os dois foi cruzar o log do
script (`[e2e-chega-mensagem] entregue em 6f5fd1f2…`) com o snapshot da página no mesmo
instante (`"Nenhuma mensagem nesta conversa."`): gravado no banco, nunca entregue à tela.

Há um passo no `e2e.yml` que reinicia o Realtime depois do baseline e resolve isso. **Ele
existe desde o PR #327 — confira que continua lá antes de culpar o seu código:**

```bash
grep -c "Reiniciar o Realtime" .github/workflows/e2e.yml   # 1 = está lá
```

Na VPS o problema não existe: o `install.sh` aplica o baseline e só então o compose sobe os
serviços. É o CI que inverte a ordem.

⚠️ **Uma spec que navega com `page.goto()` antes de cada asserção NÃO exercita o canal** —
ela refaz o fetch e passaria mesmo com o tempo real morto. `inbox-quem-manda.spec.ts` é assim
(medido: `goto` nas linhas 174 e 272, asserções depois), e por isso ela não foi afetada pelo
defeito acima. Se a sua spec existe para provar tempo real, ela não pode recarregar depois de
abrir a tela — e vale afirmar `data-realtime-status="subscribed"` **antes** de provocar o
evento, senão um canal que suba tarde passa igual.

**A `degradacao-silenciosa.spec.ts` provavelmente está reprovando em silêncio hoje — e é
uma PREDIÇÃO, não uma medição.** Achado do QA nesta revisão, verificado por mim na fonte:

- Ela mata o socket de propósito (`routeWebSocket`, linha 113) e tem uma **pré-condição**
  antes da asserção que interessa (linhas 156-164): `expect(engolidos).toBeGreaterThan(0)`,
  cuja razão escrita é "se nenhum quadro de dados foi engolido, a entrega não foi morta e o
  teste não mediu degradação nenhuma".
- Mas ela é `test.fail()`, e o próprio arquivo avisa (linhas 89-92) que isso **esconde QUAL
  asserção falhou**: "uma cerca que falha na PRÉ-CONDIÇÃO parece idêntica a uma que falha no
  ponto certo". O escape é `CERCA_CRUA=1`.

Junte as duas com o defeito da publication: se o canal já não entrega nada, não há quadro de
entrega para engolir → `engolidos` fica 0 → a pré-condição reprova → e o `test.fail()` diz
"falhou como esperado". **A cerca estaria quebrada sem sinal.**

**O mecanismo foi FECHADO por leitura (QA, 2026-08-25) — cada elo é uma linha, nenhum é
inferência.** Verificado na fonte por mim:

```
ehEntrega()                        → só true se q[3] === "postgres_changes"
if (ehEntrega(...)) { engolidos++ }  ← é o ÚNICO lugar que incrementa
expect(engolidos).toBeGreaterThan(0) ← a pré-condição, antes da asserção que interessa
```

⚠️ **Sem número de linha, de propósito.** A primeira versão deste bloco citava `:105`, `:149`
e `:159` — e estava certa na branch onde foi escrita e errada na `main`, porque o próprio
cabeçalho que documenta isto empurrou o arquivo 31 linhas. O registro mudou o objeto que ele
descreve. Ache por `grep -n "function ehEntrega" tests/e2e/degradacao-silenciosa.spec.ts`.

Com a publication sem as tabelas, o servidor **nunca emite** quadro `postgres_changes` — emite
`join`, `phx_reply` e `heartbeat`, que são justamente os que o proxy deixa passar de propósito.
Logo `ehEntrega` nunca devolve true, `engolidos` fica 0, a pré-condição reprova, e o
`test.fail()` mostra "falhou como esperado".

**E a consequência é mais interessante que o bug** (formulação do QA): se a predição se
confirmar, aquela cerca esteve quebrada desde que o defeito da publication existe, e ninguém
podia ver — não por descuido, mas porque **o mecanismo que a protege de virar teatro (o
`test.fail()`) é o mesmo que escondeu que ela virou**. É uma cerca cujo desenho de segurança
criou o próprio ponto cego.

Como confirmar (ninguém mediu ainda): rodar `CERCA_CRUA=1 pnpm exec playwright test
degradacao-silenciosa.spec.ts` no CI antes e depois do passo de restart. Se antes ela falha na
pré-condição e depois no ponto certo, a predição se confirma — e o conserto do CI terá tirado
essa spec de um estado em que ela não provava nada.

**O que continua faltando nela, e não é o mesmo que a pré-condição:** não há controle
positivo estrito — nenhum caso com o canal VIVO afirmando que a tela **não** mostra o aviso.
A pré-condição garante que a sabotagem funcionou; ela não garante que o aviso é consequência
da sabotagem. Se o aviso fosse incondicional, a spec passaria idêntica. O QA estimou cinco
linhas para fechar isso, e a dívida é dele por escrito — não foi feita aqui porque a spec não
é deste PR.

**Registro de dívida, apontado pelo QA na revisão desta entrega:** enquanto o passo do
restart estiver só na branch do #327 e não na `main`, toda spec nova de tempo real nasce
quebrada no CI pelo motivo acima — e quem a escrever vai perder as mesmas horas.

**Evidência visual:** `evidence/inbox-tempo-real/mensagem-sem-reload.png` — a
conversa aberta com as mensagens das rodadas, cada uma entregue sem recarregar.

## O gate de CHANGELOG que falta — desenho combinado (2026-08-25)

**Nada no repo cobra que mudança de comportamento tenha entrada no CHANGELOG.** Esquecer é de
graça, e aconteceu duas vezes num dia: o PR #326 entrou na `main` sem linha nenhuma (a
normalização do Respondi altera dado do cliente em silêncio — telefone sem DDI vira
brasileiro), e o conserto do tempo real do inbox só não saiu pelo mesmo buraco porque o dono
mandou reconciliar com o time.

O QA (`Assistente e Testes`) vai escrever o gate. Desenho combinado numa revisão cruzada, com
as armadilhas já medidas — está aqui porque a conversa bateu no teto anti-loop do Espaço antes
do último ponto ser entregue.

**A armadilha que matou o primeiro desenho:** um teste em `tests/unit` que faça
`git diff origin/main...HEAD` **nasce cego**. O `actions/checkout` do `ci.yml` não tem
`fetch-depth`, então o clone traz UM commit e não há `origin/main` contra o que comparar — o
gate passaria vazio, verde sempre. *Gate que nasce cego é pior que gate ausente, porque
ninguém procura o que já tem cerca.*

**Forma acordada:**

| peça | o quê |
|---|---|
| `scripts/gate-changelog.ts` | a lógica; recebe a lista de arquivos tocados como argumento |
| `pnpm gate:changelog` | uso local, alimentado por `git diff --name-only origin/main...HEAD` (local TEM o histórico) |
| passo no workflow | alimentado por `github.event.pull_request.base.sha`, que o Actions dá de graça |
| o que cobra | **entrada em `[Não lançado]`**, nunca "o arquivo foi tocado" — um cobra o efeito, o outro o gesto |
| allowlist | **nomeada e travada por `toEqual([...])`**, como `tests/unit/branding.test.ts` — travar por contagem deixa trocar uma dívida por outra em silêncio |

**O ponto que ficou sem resposta, e a proposta:** como separar "mudou comportamento" de
"refactor puro" sem virar imposto. A ideia de cobrar só de quem toca `app/api` ou `app/app`
**falha no primeiro caso real** — medido: o PR #327 não toca nenhum dos dois (mexe em `lib/`,
`hooks/inbox`, `components/inbox`) e é a mudança mais visível ao usuário daquele dia. Falso
negativo silencioso.

Proposta alternativa: **inverter o ônus em vez de adivinhar**. Todo PR que toca código de
produto exige entrada; quem acha que não precisa **declara** (uma linha no corpo do PR ou no
commit, com o motivo) e o gate lê a declaração. Três ganhos: não há falso negativo silencioso
(não ter entrada passa a exigir ato consciente); a decisão fica **escrita e auditável**; e não
vira imposto, porque uma linha de declaração custa menos que uma linha vazia de changelog —
que é o risco real, já que ela polui a tela de produto do operador. Não é convenção nova: o
`tests/unit/navegacao-completude.test.ts` já aceita exceção **com justificativa escrita**.

## J19 — Quem instala em espanhol usa o sistema em espanhol? `[P0]` (2026-08-27)

Primeira impressão de quem instala fora do Brasil, que é o público do
espanhol: a pessoa escolhe o idioma na instalação e abre o produto. Se a tela
vier em português, ela conclui que a opção não funciona — e ela teria razão,
porque até este passe o seletor da organização era gravado no banco e **não era
lido por ninguém**.

**Como foi provado.** Supabase local pg17 com o `baseline.sql` (o que o
`install.sh` aplica, não a cadeia de migrations, que não sobe do zero), `next
build` + `next start` de produção, login com conta de teste real, cinco telas
percorridas pelo browser. Spec: `tests/e2e/i18n-espanhol-na-tela.spec.ts`.
Evidência: `evidence/i18n-es/01-inbox-em-espanhol.png` e
`evidence/i18n-es/02-inbox-de-volta-em-portugues.png`.

**Achados, todos consertados neste mesmo passe:**

1. **A troca se desfazia sozinha na primeira navegação.** O `revalidatePath`
   invalida o cache do servidor; o Router Cache do cliente guarda o layout de
   `/app`, que é quem monta o provider de idioma. Logo após o clique a tela
   mostrava o idioma novo, ao navegar voltava ao antigo, e só um reload
   acertava. `router.refresh()` melhora e não resolve — medido: a primeira
   navegação ainda vinha antiga, só a segunda vinha certa.
2. **Os rótulos do Índice de Atrito** (`lib/metrics/atrito.ts`) chegavam à tela
   sem passar por `t()`. São montados em lógica pura, e o guarda estático não
   os alcança porque `{par.titulo}` é expressão, não literal.
3. **"Atendente" e "Funil" crus** em `/app/metrics` — o guarda estático não os
   viu porque a régua dele é ortográfica (ç, ã, õ, lh/nh) e nenhuma das duas
   palavras tem acento. É o falso negativo assumido dele, e é a razão de os
   dois guardas existirem: o estático alcança todo arquivo, o e2e alcança o que
   a régua do estático não distingue.

**A data, que a primeira versão desta jornada declarava como não coberta,
passou a ser medida aqui.** Existe `lib/i18n/datas.ts`, e a spec reprova se
achar mês ou dia da semana em português com a interface em espanhol.

⚠️ Essa asserção nasceu VACUOSA, e o registro do porquê vale mais que ela: as
telas percorridas não imprimiam data por extenso naquele banco, então a régua
não tinha o que achar — sabotei a camada de idioma e o teste passou VERDE.
Hoje ela tem um **controle positivo** (exige achar data em português no retrato
inicial, senão falha dizendo que o problema é o teste) e uma **fixture** que
garante o dado: `ContactsTable` só escreve a data por extenso quando é de hoje
ou ontem, e fora disso imprime `dd/MM/yyyy` — idêntico nos dois idiomas.

**O que segue fora:** e-mail e o PDF de LGPD, com o motivo escrito em
`tests/unit/i18n-a-data-segue-o-idioma.test.ts`.

## A migração para o Tailwind 4 mudou 252 classes que ninguém sabia estarem mortas (2026-08-26)

Origem: subir `tailwindcss` de 3.4 para 4, com o config saindo do
`tailwind.config.ts` (deletado) para um `@theme inline` em `app/globals.css`.

**O achado que a migração destapou.** No v3, um modificador de opacidade sobre
cor declarada como `var(--…)` sem o marcador `<alpha-value>` fazia o Tailwind
**não emitir a regra** — a classe simplesmente não existia no CSS, em silêncio.
Todo token deste produto é `var(--color-*)`, então **62 classes distintas em 252
usos** eram letra morta: `bg-destructive/10` num aviso de erro não pintava fundo
nenhum, `border-destructive/30` caía na cor neutra da regra global de borda,
`text-muted-foreground/60` herdava a cor do pai. O v4 resolve opacidade por
`color-mix()`, que funciona com qualquer cor — então **as 252 passaram a pintar
o que quem escreveu queria desde o começo**.

Medido com o v3 real, e não deduzido: um `tailwindcss@3.4.19` de descarte,
alimentado com 7 classes, emitiu **4** — nenhuma das 3 com barra.

| caso | prioridade | estado |
|---|---|---|
| Tokens resolvem em claro e escuro depois do `@theme inline` | `[P0]` | **PASS**, medido por `getComputedStyle` em `tests/sonda-tailwind-4.ts`: `--color-bg` = `#faf9f6` claro / `#161510` escuro, e `body` acompanha |
| A auto-referência do `@theme inline` (`--color-bg: var(--color-bg)`) não vence o `:root` autoral | `[P0]` | **PASS.** A teoria é de cascata (sem layer vence layer); a medida é a linha acima. Congelado em `tests/unit/tailwind-tokens.test.ts`, que reprova se alguém embrulhar `:root` num `@layer` |
| `class="border"` sem cor continua na cor de borda do produto, e não em `currentColor` | `[P0]` | **PASS**: `rgb(231,227,218)` (claro) e `rgb(51,49,42)` (escuro) — os dois são o `--color-border` do tema |
| As classes de opacidade revividas pintam de verdade | `[P1]` | **PASS parcial**: `bg-muted/40` medido em elemento real do onboarding, com alfa `0.4` nos dois temas. O antes/depois confirma 25 bordas e 8 fundos que passaram de cor chapada / transparente para cor com alfa. As demais estão no CSS construído, mas **não foram medidas uma a uma na tela** |
| Onboarding completo (6 passos) em claro e escuro, instalação fresca | `[P0]` | **PASS**, 0 erro de console. Capturas em `evidence/tailwind-4/` |
| **ANTES/DEPOIS**: as duas versões contra o MESMO banco, comparadas elemento a elemento | `[P0]` | **PASS**. `tests/sonda-tailwind-4-antes-depois.ts` sobe v3 em `:3002` e v4 em `:3001`, casa cada elemento pelo **caminho estrutural no DOM** (não pelo `className`, que a migração renomeou) e reporta todo estilo computado que divergiu, mais o diff de pixel. Pares em `evidence/tailwind-4/{antes,depois}/`, números em `antes-depois.json` |
| Telas internas (`/app`, kanban, inbox, contatos) | — | **NÃO COBERTO.** Numa instalação fresca todas redirecionam para `/onboarding/welcome`; alcançá-las pede concluir o onboarding, o que pede WAHA e chave de IA. A sonda registra o redirecionamento em vez de fingir cobertura |
| O efeito visual das 252 revividas foi *revisto por um designer* | — | **NÃO MEDIDO.** A migração provou que passaram a pintar; não provou que cada uma pinta o que a tela precisa. Onde a intenção original estava errada, o erro agora está visível |

### O que a linha "NÃO COBERTO" acima custou: `text-accent-fg` (2026-09-10)

A tabela acima declara, desde 2026-08-26, que as telas internas de `/app` não
foram medidas — porque numa instalação fresca elas redirecionam para o
onboarding, e alcançá-las pede WAHA e chave de IA. **Um defeito morou exatamente
ali por duas semanas, e quem o encontrou foi uma clínica em produção.**

A classe `text-accent-fg` **nunca existiu**. O `@theme inline` faz a ponte com o
nome `--color-accent-foreground`; `--color-accent-fg` é o token do `:root`, e
token do `:root` não vira utilitário sozinho. Escrever `text-accent-fg` não é
erro — é NADA: a regra não é emitida, o elemento não recebe `color`, e o texto
herda a cor da página. Como a mesma `className` trazia `bg-accent`, que existe, o
resultado era fundo da marca com letra da página.

Medido no CSS que o dev server servia: `bg-accent` 24 vezes, `text-accent-fg`
**zero**. Numa instalação com marca escura (`#062b46`, cliente real) isso deu
escuro sobre escuro em 9 lugares de 6 arquivos — aba do histórico, dia de hoje na
grade, dia e horário escolhidos na marcação. Com a paleta Sage padrão o defeito
existia igual, só menos gritante, e por isso ninguém viu.

| caso | prioridade | estado |
|---|---|---|
| Toda classe de cor usada em componente corresponde a chave do `@theme inline` | `[P0]` | **PASS**, congelado em `tests/unit/tailwind-tokens.test.ts`. A guarda deriva a lista de proibidos do próprio CSS (token do `:root` sem ponte), não de lista digitada — no nascimento o conjunto era exatamente um: `accent-fg`. Sabotagem provada nas duas direções |
| A letra sobre `bg-accent` passa no contraste, nos dois temas, com marca de cliente | `[P0]` | **PASS** por medição de token: `#062b46` dá 14.57 no claro e 6.97 no escuro; a auditoria completa da marca deu **0 reprovas** em 18 + 26 pares |
| As telas internas de `/app` medidas na tela, em instalação com marca | `[P0]` | **CONTINUA NÃO COBERTO.** Este defeito foi achado por leitura de CSS e por print de usuário, não por sonda. A lacuna que o produziu segue aberta |

### O defeito que só o antes/depois encontrou: o rótulo colado no campo

O `space-*` inverteu o lado da margem — e isso não é cosmético:

```
v3:  .space-y-2 > :not([hidden]) ~ :not([hidden])   { margin-top }      ← filho SEGUINTE
v4:  :where(.space-y-2 > :not(:last-child))         { margin-block-end } ← filho ANTERIOR
```

Num grupo `<Label>` + campo, o filho anterior é o **rótulo**. E `<label>` nasce
`display: inline`, que **ignora margem vertical** — a margem do grupo evaporava.
Medido: todo grupo de formulário perdia exatamente um `--space-N`, e a tela de
boas-vindas ficava 24px mais curta, com rótulo colado no campo. Zero erro, zero
teste vermelho, no meio de 91 arquivos alterados.

Conserto em `components/ui/label.tsx`: `inline-block` na classe base. Não é
`block` porque medi os dois — `inline-block` preserva a largura shrink-to-fit que
o `inline` dava e fica a **4px** do que o v3 rendia, contra 10px do `block`.

| caso | prioridade | estado |
|---|---|---|
| O respiro entre rótulo e campo sobrevive à migração | `[P0]` | **PASS**, medido: 8px nos dois lados |
| Rótulo inline não volta | `[P0]` | **PASS**, `tests/unit/tailwind-tokens.test.ts` — e provado por sabotagem: revertendo a classe, o teste reprova |
| O `<label>` CRU tem o mesmo defeito, e o componente consertado não o alcança | `[P0]` | **PASS.** A sonda achou 1 na tela; a varredura estática achou **10** em 3 arquivos (`app/app/audit`, `webhooks/CapturasTab`, `onboarding/funil`), todos primeiro filho de `space-y-*`. Corrigidos, e a varredura virou teste — também provado por sabotagem. Confirmado depois na tela: **zero** filhos inline em container `space-*` nas 7 telas provadas |
| Diferença residual de 4px por grupo | — | **CONHECIDA e não fechada.** É o `leading-none` da própria classe do rótulo finalmente valendo — enquanto ele era `inline`, quem mandava na altura da linha era o strut do pai. Fechar exige tirar o `leading-none`: decisão de design, não de migração |
| `<option>` de `<select>` nativo perde 2px de `padding-left` e o fundo branco do popup | — | **MEDIDO, impacto visual NÃO PROVADO.** O preflight do v4 zera `padding` em `*` (o v3 não zerava). São 10 `<select>` no produto; o popup é desenhado pelo SO, então o Playwright não o captura |
| `outline-none` → `outline-hidden` muda `outlineStyle` de `solid` para `none` em 2 campos | — | **ESPERADO, não é regressão.** O v3 punha contorno transparente SEMPRE; o v4 só sob `forced-colors`. O indicador de foco visível sempre foi o `ring`, e a regra `forced-colors` do `globals.css` cobre o resto |
| Paleta default (amber, emerald) muda de sRGB para oklch | — | **NÃO MEDIDO** se o desvio é perceptível. São ~20 elementos, todos de aviso/estado |
| Telas internas (`/app`, kanban, inbox, contatos) | — | **NÃO COBERTO**, mesmo motivo de antes: instalação fresca redireciona para o onboarding |

### O risco que o dono do projeto nomeou antes da migração, medido

Na issue #239 o mantenedor deixou um aviso específico: uma varredura de "tokens
sem consumidor" apontaria `duration-fast/base/slow` como mortos, e deletar o
bloco `transitionDuration` **apagaria a transição de todo botão, input, textarea
e badge do produto** — em silêncio, com `typecheck`, `lint`, `test:unit`,
`invariants` e `build-and-size` verdes, porque `grep -rn toHaveScreenshot tests/`
devolve zero.

No Tailwind 4 o risco é maior que no 3, e por um motivo novo: **não existe espaço
de tema `--duration-*`**. Um `@theme inline` não tem onde declará-los, e a
tradução ingênua do config os perderia sem erro nenhum. Aqui eles viraram
`@utility` explícito em `app/globals.css`.

| caso | prioridade | estado |
|---|---|---|
| Botão e campo mantêm a duração de transição | `[P0]` | **PASS**, medido em elemento real nas duas versões ao mesmo tempo: `transitionDuration` = `0.12s` no `<button type="submit">` e no `<input type="email">` do login, idêntico em v3 e v4 |
| `duration-base` / `duration-slow` não aparecem no CSS construído | — | **ESPERADO, não é regressão.** Nenhum arquivo os usa, e o Tailwind só emite classe usada — no v3 era igual. O `--duration-slow` que o `.card-pulse` consome é a **variável**, não a classe, e continua no `:root` |

### As provas versionadas

Só os quatro pares que sustentam uma afirmação — o resto das capturas é artefato
de execução e não entra no repositório (a regra é de
`tests/unit/evidencia-citada.test.ts`, e ela reprovou esta entrega antes de eu
podar). Para regerar todas: suba as duas versões e rode
`tests/sonda-tailwind-4-antes-depois.ts`.

| par | o que ele prova |
|---|---|
| `tailwind-4/antes/02-onboarding-welcome-claro.png` → `tailwind-4/depois/02-onboarding-welcome-claro.png` | O respiro entre rótulo e campo. É aqui que o defeito do `<label>` inline aparecia: a página inteira 24px mais curta, três grupos colados |
| `tailwind-4/antes/02-onboarding-welcome-escuro.png` → `tailwind-4/depois/02-onboarding-welcome-escuro.png` | O tema escuro sobrevive à troca do `@theme inline` — mesma tela, tokens escuros resolvendo |
| `tailwind-4/antes/05-onboarding-ia-escuro.png` → `tailwind-4/depois/05-onboarding-ia-escuro.png` | O cartão de aviso âmbar, que concentra as classes de opacidade revividas e a paleta default que passou a oklch |
| `tailwind-4/antes/01-login-claro.png` → `tailwind-4/depois/01-login-claro.png` | A tela mais simples do produto, com borda, foco e anel — o controle: se algo básico tivesse quebrado, quebraria aqui |

**Armadilha que custou duas medições falsas.** Sonda que injeta `<div
class="p-7">` por JavaScript não mede nada: a classe nunca esteve na fonte, o
scanner nunca a viu, e o zero medido é artefato da sonda. Pelo mesmo motivo, o
primeiro elemento com `class="border"` da tela de login é o `<input>`
autofocado — ele casa `focus-visible:border-accent-500` e devolve a cor do
foco. A sonda só mede elemento real, e pula elemento em foco e elemento que já
traga classe de cor própria.

---

## O campo que oferecia hoje e o servidor recusava (2026-09-03)

Achado de varredura adversarial contra o PR #496, no SHA `f700f3e1`. Mesma tela
do #496 — **Conexões › Proteção de envio** —, campo ao lado do que ele acabara
de consertar, e o mesmo desfecho para quem opera: a ficha inteira deixa de
salvar.

`<input type="date">` fala em dia LOCAL; `AntiBanSheet` encaixa o dia escolhido
às 12h UTC (meia-noite viraria o dia anterior a oeste); e a guarda do schema
comparava esse encaixe com `Date.now()` — um DIA contra um RELÓGIO.

| régua | recusa começa | recusa para | quem sente |
|---|---|---|---|
| dia que a tela mostra (`America/Sao_Paulo`, UTC−3) | 03:00 UTC | 12:00 UTC | 00:00 às 09:00 no relógio de quem opera |
| dia UTC (o que o `max` do campo oferecia, vindo de `toISOString()`) | 00:00 UTC | 12:00 UTC | as primeiras 12 horas UTC do dia |

Medido varrendo as 48 meias-horas do dia com relógio falso, chamando o schema
real com a carga exata que a tela monta — não pela tela: **NÃO MEDIDO** pelo
browser num ambiente fresco estilo VPS. O que a varredura de horas prova é a
fronteira; o que ela não prova é o que o operador vê quando ela dispara.

**A lição, e ela não é sobre fusos.** O produto oferece o dia num campo e o
recusa no servidor: a mesma classe do controle decorativo, ao contrário — não é
o controle que não faz nada, é o limite do campo que promete o que a outra ponta
nega. Toda validação de data merece a pergunta *"as duas pontas falam do mesmo
dia, ou uma delas fala de instante?"*.

**Onde mais essa pergunta cabe** (levantado, **não medido**, e fora do escopo do
conserto): `lib/kanban/filters.ts` e `lib/automation/throttle.ts` derivam "hoje"
de `toISOString().slice(0, 10)`, que é o dia UTC. Se algum deles compara com dia
local, é a mesma classe.
## J21 — Uma loja no México escolhe sua moeda `[P0]` (2026-09-04)

Migration 0208 dá a `organizations` uma coluna `currency`; o resto do frente
(seletor, herança no catálogo, formatação) não valia nada sem provar pela tela
que a escolha sobrevive e que o preço sai do jeito certo — a mesma armadilha
que o seletor de idioma do perfil já teve antes desta feature: campo que
aceita clique e não muda nada.

Banco: `supabase/baseline.sql` reaplicado no Supabase local (idempotente —
`add column if not exists`, confirmado sem perda de dado na única organização
que já existia). `pnpm e2e:build && pnpm test:e2e -- moeda-da-organizacao`,
Chromium real, login com MFA real.

| Caso | Prioridade | Resultado |
|---|---|---|
| Trocar para peso mexicano em Configurações › Organização e RECARREGAR a página | `[P0]` | **PASS.** `#currency` mostra `MXN` depois do `page.reload()` — não só depois de salvar. Evidência: `evidence/moeda-da-organizacao/moeda-01-antes.png`, `evidence/moeda-da-organizacao/moeda-02-mxn-salvo.png`, `evidence/moeda-da-organizacao/moeda-03-mxn-apos-reload.png` |
| Produto cadastrado com a organização em MXN mostra o preço na convenção mexicana | `[P0]` | **PASS.** `$249.90` — ponto decimal, cifrão na frente. **Não** `MXN 249,90`, que era o que `comoMoeda()` (removida neste PR) mostrava: a asserção nega esse texto explicitamente, porque uma spec que só checasse "o preço apareceu" teria passado verde com o defeito antigo. Evidência: `evidence/moeda-da-organizacao/moeda-04-produto-mxn.png` |

**Achado de infraestrutura, não desta feature:** `pnpm e2e:build` falhou na
primeira tentativa com `Cannot find module '@tailwindcss/postcss'` — o merge de
`upstream/main` trouxe a migração para Tailwind 4 (`package.json` já
declarava a dependência), mas `pnpm install` não tinha rodado depois. `pnpm
install` + `pnpm build` (exit 0) resolveram antes de tentar o e2e de novo.

**Achado de doutrina, não desta feature:** o piso de Postgres mudou de pg17
para pg15 no mesmo merge (PR #422, `tests/unit/baseline-no-piso-do-postgres.test.ts`
novo). Conferido: a migration 0208 não usa nada exclusivo de pg17 (só `ADD
COLUMN`, `UPDATE`, `ALTER COLUMN`, um bloco `DO` com `pg_constraint`), e
`scripts/test-db.sh` já sobe `pgvector/pgvector:pg15` — os `pnpm test:db`
anteriores desta sessão já corriam contra o piso certo, mesmo antes deste
achado.

### [P0] Organizações: criar, convidar e alternar (comunidade 360)

- Porta: `TenantSwitcher` → **Gerenciar organizações**, inclusive com uma membership, somente platform admin.
- `organizacoes-criacao-convite-e-cache.spec.ts`: organização A única → formulário cria B e vínculo do criador → link copiável e validade sem Resend → inbox A→B→A com contatos distinguíveis e novo documento → responsável aceita convite e chega a B. Seeds exclusivos locais; nenhuma pessoa real recebe mensagem.
- Rodada de correção 1: navegador em produção verde; contatos verificados dentro de `[data-conversation-id]` (o banner de canal não vale como prova da lista). Evidência adicional da falha de troca registrada no relatório local da Task1.
- Recuperação após resposta perdida: três respostas reais pós-commit abortadas, novo clique conserva chave, ID e link; recibo legado forjado é ignorado pelo handler. Falha de rede na troca libera a guarda e mantém cookie, organização e inbox. Proteção do recibo (INSERT/UPDATE/DELETE/TRUNCATE e namespaces LGPD/MCP) coberta em `organizacoes-recibo-confiavel.test.ts`.
- Aceite preserva `invited_by`; replay não regrava papel ativo e convite anterior/legado não desfaz revogação. Prova no banco em `organizacoes-criacao-e-convite.test.ts`; resposta antiga em voo e troca de usuário cobertas em `organizacoes-cache-por-contexto.test.tsx`.
- Recuperação: falha de entrega mantém link; convite vencido pode ser reemitido em Equipe. Troca recusada mostra erro e mantém organização anterior. Onboarding conserva saída para outra organização (spec existente).
- Execução local em produção passou no commit `815f59ea`: criação, cópia real do link, aceite e A→B→A. Guarda de transição medida com `getBoundingClientRect`/`getComputedStyle`; sentinela confirma novo documento. Screenshots em `.superpowers/evidence/comunidade-360/` (`criacao-convite`, `transicao-para-A/B`, `inbox-volta-a`, `aceite-na-org-b`); comandos e limites em `.superpowers/sdd/comunidade-360/task-1-report.md`.


## Acompanhamento administrativo por sessão (Task2, 2026-09-05)

- [P0] Administração → organização B → acompanhamento full → dados B → editar contato → audit do ator real → sair → A sem cache antigo.
- [P0] Somente leitura B, inclusive administrador físico B: inbox navega sem marcar lida/enviar; API comum e administração recusam escrita.
- [P0] Expiração/revogação: nenhuma volta silenciosa a A; saída continua disponível após perder plataforma.
- Duas abas da mesma sessão acompanham início/fim e dados B/A; sessão distinta da mesma pessoa não recebe grant/contexto da observadora.
- [P0] B com onboarding incompleto abre shell com banner/saída em ambos os modos; acesso direto ao wizard retorna ao app, sem concluir setup.
- Receiver HTTP do transporte configurado confirma reconexão full (stop/create/start), readonly sem recepção e outra sessão operando A. Não é prova de envio de mensagem WhatsApp.
- Fonte de prova: `tests/e2e/suporte-temporario.spec.ts`, produção local: jornada ampliada passou em produção local (21,2 s), incluindo zero403 espontâneo, banner medido e screenshot sem toast residual.
- Achado visual: consulta auxiliar de automático exigia agent e gerava toast403 para viewer; hook passou a respeitar permissão efetiva e mantém dado desconhecido, sem ampliar RBAC.
- DB: `tests/invariants/suporte-temporario.test.ts` prova grant,TTL,MFA,restrições DML/RPC e callbacks; não confundir com a jornada frontend.


## Interface por membro e convite — comunidade 360

- [P0] Convite emitido pela tela com interface selecionada antes do aceite; sem serviço de e-mail o link permite entrar na home calculada. Replay do convite preserva ajuste posterior do administrador.
- [P1] Dois membros com mesmo papel veem apresentações diferentes. Outro administrador edita pela Equipe; evento real de Realtime atualiza a navegação sem logout nem perda de formulário aberto.
- [P1] Seleção apenas de destino hub-only mantém porta no desktop/mobile e resultados úteis no ⌘K; sino oculto não monta consulta. URL autorizada oculta continua acessível; endpoint privilegiado continua 403.
- Spec: `tests/e2e/interface-por-vinculo.spec.ts`; imagens/trace locais em `.superpowers/evidence/comunidade-360/`. Resultado executado e limitações ficam no report da Task3.


## Comunidade 360 — encerramento e memória (Task4)

Spec: `tests/e2e/encerramento-atendimento.spec.ts`. Banco Supabase aplicado pelo baseline, frontend de produção e receiver HTTP local. Execução final FIX3-r1: **2 casos passaram em 20,7s**, com traces persistentes em `.superpowers/evidence/comunidade-360/task4-browser-fix3-r1/` e screenshots carregadas inspecionadas.

| Caso | Prioridade | Prova |
|---|---|---|
| Fechar conversa preserva demanda e outro canal | P0 | UI Fechar, consulta estado e screenshot carregada |
| Registrar desfecho explicitamente | P0 | Formulário no painel vigente, revisão CAS |
| Novo inbound volta à fila com demanda nova | P0 | Ingestão persistida, fila, assumir e responder pelo composer |
| Memória mantém fatos e rotula histórico | P1 | Notas duráveis no painel; checkpoint/mensagens antigas fora do contexto corrente em teste DB |
| Trabalho antigo não envia após close/reopen | P0 | Tool e sink canônico contra receiver HTTP real; controle positivo do transporte |
| Concorrência e tenant | P0 | Invariantes DB: inbound simultâneo, CAS, dois tenants e merge com duas conexões |

Limite operacional: a revalidação acontece imediatamente antes do efeito. Um transporte que já aceitou a mensagem não é desfeito pelo encerramento posterior.


Task4 fix1 — `encerramento-atendimento.spec.ts` amplia a prova: formulário conserva seleção durante refetch; histórico de desfecho em ES; resposta a caso antigo registra aviso e referência preservados na Central, sem link cru e com zero envio extra (projeção autorizada de navegação pertence à Task5); silêncio usa mensagem persistida pelo PostgREST (legado/reabertura não autorizam, entrada nova vigente autoriza). Execução final passou; logs/evidência no relatório Task4. A corrida real close/refetch → conversa null → perda do formulário foi corrigida preservando draft e CAS capturada no painel. Troca real de contato/conversa descarta o draft; conflito exige Cancelar/reabrir. Browser aguarda atribuição efetiva (Atendente/Liberar, sem Sem responsável) antes de responder e também prova reabertura/fechamento manual.

Capturas selecionadas: `evidence/comunidade-360/task4-conversa-fechada-demanda-aberta.png`, `evidence/comunidade-360/task4-reaberto-respondido.png`, `evidence/comunidade-360/task4-caso-obsoleto-aviso.png` e `evidence/comunidade-360/task4-historico-es.png`.

### Comunidade 360 — Central de avisos com contexto (Task 5)

[P1] `tests/e2e/central-avisos-destino.spec.ts`: aviso de conversa → contexto real → F5 → Back ainda aberto → resolver → Resolvidos → reabrir; contato e referência removida; links sob RLS em `own`/`own_and_unassigned`, outro responsável e outro tenant; manager/admin/viewer e bearer sem sessão; destino autorizado mesmo oculto no menu; desktop/mobile com medidas e screenshot carregado. Executado em 2026-09-06: quatro cenários passaram no build de produção do QA isolado, incluindo clique que abre o dossiê do negócio no funil certo e mobile em espanhol. Provas selecionadas: `evidence/comunidade-360/task5-desktop.png` e `evidence/comunidade-360/task5-mobile.png`, com medidas JSON ao lado. Comandos, logs e limites em `.superpowers/sdd/comunidade-360/task-5-report.md`.

O link vem da projeção autenticada `lib/ai/inbox-destino.ts`; não muda o status do aviso. Modelos de canal abrem a área de templates de Conexões/Parceiro, e referências técnicas sem tela recebem orientação. O recorte humano do Radar passa a usar a RLS de lead/conversa na Task6, conforme contrato em `docs/architecture/ponte-agendamento-followup.md`.

## Comunidade 360 — Agenda, presença e recuperação (Task6)

Executado em 2026-09-06 no QA isolado, build de produção do produto `bfa2ab2f`, baseline fresco preservado e migrations até0224: **7 casos passaram em1,2min**, um worker e nenhum retry, na spec `tests/e2e/agenda-presenca-recuperacao.spec.ts` (basename registrado no CI). Originais e sete traces permanecem em `.superpowers/evidence/comunidade-360/task6-browser-r3/`; as duas rodadas anteriores não foram sobrescritas.

| Jornada | Prioridade | Prova executada |
|---|---|---|
| Inbox → compromisso → Central → detalhe antigo | P0 | Contato/conversa vinculados pela tela; cron abre aviso; snooze e presença humana com mensagem/ator persistidos |
| Datas PT/ES em navegador inglês/Honolulu | P1 | GET traz São Paulo; intervalo29/08 23h30→30/08 00h30 contrasta com29/08 16h30→17h30 do browser; seletor real troca idioma sem mudar instantes/autoria/revisão |
| Gestão configura prazos e falta recuperável | P0 | Configuração persistida; Faltou → evento pending → cron drain → done/recibo started → UI; replay conserva inscrição e inbound interrompe |
| Ausência de configuração e outro fluxo ativo | P0 | Impedimento terminal legível, sem começar recuperação tardia quando a vaga abre |
| Receiver com inline/daemon e interrupção no preparo | P0 | Nos dois sentidos, um recebimento e um avanço por intenção mesmo após callback indisponível; aquisição antiga não envia;1001 pendências antes do protetor não escondem proteção; PG/Supabase concordam e nenhum envio novo ocorre |
| Radar com RLS real | P0 | Lead fora do pool frio, demanda sem lead com conversa visível, own/own_and_unassigned e gestão/suporte; contagens respeitam acesso |
| Duas sessões e rascunho antigo | P0 | Outra sessão remarca; polling bloqueia cancelamento até descarte/revisão; confirmação atual cancela; cleanup termina sem erro |

Achado visual da primeira rodada: detalhe PT usava idioma/fuso do navegador. FIX4 usa idioma canônico e fuso existente do compromisso, incluindo dia final; três controles de draft/CAS permanecem. As seis capturas carregadas finais foram abertas pelo autor/controlador, e o controlador confirmou ausência de novo defeito no recorte. Painel desktop:384px dentro de viewport1280, scrollWidth=clientWidth=383; mobile:292,5px dentro de390, scrollWidth=clientWidth=292; visibility=visible em todas.

Evidências selecionadas, copiadas sem edição dos originais:

- Presença: `evidence/comunidade-360/task6-presenca-desktop.png` e `evidence/comunidade-360/task6-presenca-mobile.png`.
- Datas em português: `evidence/comunidade-360/task6-datas-pt-BR-desktop.png` e `evidence/comunidade-360/task6-datas-pt-BR-mobile.png`.
- Datas em espanhol: `evidence/comunidade-360/task6-datas-es-desktop.png` e `evidence/comunidade-360/task6-datas-es-mobile.png`.
- Medidas, origem e SHA256 das seis capturas: `evidence/comunidade-360/task6-medidas.json`.

Prova DB integral preservada:166 arquivos/1310 casos passaram, mais1expected fail/1skip, com INSTALL/UPDATE PG15 e teardown. Cobre desfecho/CAS/recibo privado, inbound fora de ordem, transação anterior à confirmação, loop/callback velho, retenção, lease/retry/aviso e isolamento/ACL. Nenhum SQL mudou no FIX4. Receiver HTTP é real e local; não prova pareamento/entrega de WhatsApp real, consentimento Google ou convite entregue. Logs e reconciliação em `.superpowers/sdd/comunidade-360/task-6-report.md`.

## Comunidade 360 — Seleção de agendas e reconciliação Google (Task7)

**Jornada executada:2casos PASS em25,0s,exit0**, output local `task7-browser-r2`, build de produção6726941e e Supabase55431/55432. `tests/e2e/agenda-google-sync.spec.ts` está registrada no CI. Usa sessão real do produto e receiver HTTP controlado, sem conta Google externa. O controlador abriu as nove capturas finais e medidas, sem novo achado visual; validação concluída, aguardando re-review FIX4/aprovação da Task7.

| Jornada | Prioridade | Resultado observado |
|---|---|---|
| Selecionar fontes e destino entre contas | P0 | PASS — salva pela tela e espera PATCH200/refetch; um destino na segunda conta, reader sem escrita. Cartão/10h bloqueados e12h disponível → fonte desmarcada → cartão some,10h abre confirmação e12h/cache permanecem; desktop/mobile medidos |
| Retentar publicação indisponível | P0 | PASS — botão do detalhe → RPC autenticada → mesma consulta de candidatos do cron contra PostgREST, após50 vínculos anonimizados → executor com receiver HTTP → sucesso visível |
| Horários divergentes | P0 | PASS — intenção local usa slot oferecido pela rota canônica; mudança remota gera comparação → escolha pela tela aplica horário Google e conserva título e tupla original, apesar da troca de destino; sem PATCH remoto adicional |

Capturas versionadas, sem edição e idênticas aos originais:

- Fonte ocupada: `evidence/comunidade-360/task7-fonte-ocupada-grade.png` e `evidence/comunidade-360/task7-fonte-ocupada-horarios.png` —12h enquadrado no painel.
- Seleção salva: `evidence/comunidade-360/task7-selecao.png` e `evidence/comunidade-360/task7-selecao-mobile.png`.
- Fonte retirada: `evidence/comunidade-360/task7-fonte-retirada-grade.png` e `evidence/comunidade-360/task7-fonte-retirada-horarios.png` —10h selecionado e12h preservado.
- Publicação e decisão: `evidence/comunidade-360/task7-publicado.png`, `evidence/comunidade-360/task7-conflito.png` e `evidence/comunidade-360/task7-resolvido-mobile.png`.

`evidence/comunidade-360/task7-medidas.json` registra origem, SHA256 e medidas das nove capturas, sem overflow horizontal. O controle12h tem altura44 e interseção integral com a viewport nos dois painéis. A r1 e seus dois diagnósticos de fixture/espera foram preservados, com reconciliação em `.superpowers/sdd/comunidade-360/task-7-report.md`; nenhuma assertion ou regra de produto foi relaxada para fechar a r2.

Gates de produto preservados: unit integral706arquivos/7622PASS+1expected fail; DB integral169arquivos/1348PASS+1expected fail+1skip, INSTALL/UPDATE PG15; typecheck/lint/cercas/build verdes. Claims, callbacks tardios, escrita aceita sem resposta, edição local concorrente, RSVP/412, cursor e redação são exercitados contra banco e receiver. FIX4 passou typecheck/lint da spec e browser no mesmo build. AfterAll e sonda0|0 confirmaram limpeza; app/receiver efêmeros encerrados.0224/0225 aplicadas e imutáveis no QA. Receiver local comprova transporte/estados; não comprova consentimento Google real, pareamento WhatsApp ou convite entregue.

## Comunidade 360 — Google Meet e entrega transacional (Task8)

Browser r3 passou **2 jornadas/30,0s**, appprodução3013, sessão e PostgREST reais no QA55431/55432, com receivers HTTP locais. Produto8539a815 e spec b73cc573. Root abriu e aprovou as nove capturas e suas medidas; os defeitos de consulta de telefone e destino da Central encontrados em r2 foram corrigidos e receberam regressões. Não se alega conta Google real, OAuth, convite externo ou entrega na rede WhatsApp.

| Caminho | Prioridade | Prova atual |
| --- | --- | --- |
| Link pendente, pronto, copiar/abrir e falha/retry | P0 | UI cria por slot oferecido, mostra pending sem URL, recebe ready do executor, expõe href válido e copia para clipboard real; failure/retry chega pela Central e preserva identidade Google |
| Autorização de entrega com destino visível | P0 | UI mostra Maria Meet antes do clique; consumer real entrega ao chat e à sessão da fixture, revision/request observados conferidos. SQL prova owner/ator/org/suporte/MFA negativos, sem ampliar o browser |
| Canal indisponível e replay | P0 | Consumer/gates/ledger/handler/adapter reais com SQL e receiver HTTP local; queued não significa sent; aceite anterior reconcilia mesmo após expirar/remover autorização de IA, sem HTTP novo, enquanto ausência de aceite continua bloqueada |
| Atendimento encerra/reabre | P0 | UI fecha; inbound canônico reabre MESMO UUID; novo clique cria outra intenção/job e segundo POST. Ledger accepted real e job done antigos permanecem byte-equivalentes em seus snapshots; fronteira original preserva no-op |
| Link solicitado por humano em conversa sob controle humano | P0 | UI autoriza e HTTP chega com assignee user, silêncio, force_human e allowlist preservados. Dois payloads medem texto, destinatário e sessão. Booking automático bloqueado e demais negativos seguem medidos em DB |
| Aquisição antiga/cancelamento/redação concorrente | P0 | Reclaim e cancelamento antes do sink barram POST; redação durante POST aceito impede callback reidratar link/prévia |
| Solicitação Google incerta | P0 | POST aceito sem resposta conserva requestId; GET reconhece recibo sem reconhecer remarcação ainda não enviada |
| Acesso LGPD aos novos dados | P0 | Coletor paginado com tenant/titular/referência validada; testes renderizam PDF real, extraem entregas/avisos em múltiplas páginas e preservam controlador/DPO, sem payload/claim/marca |

| Captura inspecionada | Evidência |
| --- | --- |
| Pending desktop | `evidence/comunidade-360/task8-pending-desktop.png` |
| Pending mobile | `evidence/comunidade-360/task8-pending-mobile.png` |
| Ready/copiar desktop | `evidence/comunidade-360/task8-ready-desktop.png` |
| Ready mobile | `evidence/comunidade-360/task8-ready-mobile.png` |
| Envio concluído | `evidence/comunidade-360/task8-sent-desktop.png` |
| Nova autorização após reabrir | `evidence/comunidade-360/task8-reopened-mobile.png` |
| Falha desktop | `evidence/comunidade-360/task8-failure-desktop.png` |
| Falha mobile | `evidence/comunidade-360/task8-failure-mobile.png` |
| Retry concluído mobile | `evidence/comunidade-360/task8-retry-ready-mobile.png` |
| Prévia do PDF LGPD | `evidence/comunidade-360/task8-lgpd-export-preview.png` |

`evidence/comunidade-360/task8-medidas.json` contém origem, hashes e medidas reais. Seção Meet com335px no desktop1440 e243,5px no mobile390; sem overflow horizontal, controles na viewport. A aquisição do job no browser é SQL manual restrita à fixture: prova consumer/ledger/HTTP, não o scheduler completo. Incerteza, opt-out, revogação, claim antigo, cancelamento e redação durante HTTP permanecem nas provas DB/receiver; não são atribuídos às duas jornadas UI.

Testes: `tests/e2e/agenda-google-meet.spec.ts`, `tests/invariants/agenda-meet.test.ts`, `tests/invariants/agenda-meet-export.test.ts`, `tests/unit/agenda-meet*.test.ts*` e `tests/unit/lgpd-pdf-meet.test.ts`. Unit integral710arquivos/7671PASS+1expectedfail; DB integral171arquivos/1386PASS+1expectedfail+1skip, INSTALL/UPDATE PG15. Após o reparo runtime,75casos focados/type/lint e novo build/browser passaram; sem repetição do DB sem delta SQL.0226 aplicada/imutável no QA, junto com0224/0225. Limpeza0organizações/0usuários meet-ui, app/receivers/pools encerrados e namespace demo preservado. Histórico e limites completos em `.superpowers/sdd/comunidade-360/task-8-report.md`.

### Autonomia e revisão de respostas (Task9)

- [P0] Agente sem publicação: salvar versão, testar cenário e ver candidata/propostas sem mensagem operacional. Mesmo ritual de abertura, compactação e fechamento; provedor controlado deve ser identificado como tal.
- [P0] Recuperação do agente legado: escolher canal/modelo/credencial explicitamente; preservar prompt/RAG e qualquer versão humana existente. Falta de configuração mostra reparo, nunca “no ar”.
- [P1] Assistido: inbound gera sugestão; editar/aprovar/rejeitar na conversa. Aprovação autoriza só texto e preserva autonomia/assignment/silêncio; mudanças de contexto tornam a sugestão obsoleta.
- [P1] Pausar e retomar: ponteiro publicado permanece; assistência manual continua. Troca de modo em voo impede efeitos automáticos obsoletos.
- Provas Task9 em preparação: `tests/invariants/autonomia-replies.test.ts`, `lib/agent-engine/agent/preview.test.ts`. Evidência browser será registrada após revisão e aplicação da migration0227 no QA.


## Comunidade 360 — aceite integrado de 2026-09-06

Produto `7f1d0f3e`, integrado à main `ca895850`: as dez specs de organizações, suporte, interface por vínculo, encerramento, Central, presença/recuperação, Calendar, Meet, autonomia assistida e roteamento passaram juntas: **22 casos em 3,7 minutos**. A execução usa build de produção `F0cVqvOg8JuwVlWss4ijk`, banco QA local e receivers HTTP controlados; não comprova OAuth externo, WhatsApp pareado ou qualidade de modelo externo.

Evidência local preservada em `.superpowers/evidence/comunidade-360/final-qa-targeted-r4/` e log `.superpowers/sdd/comunidade-360/final-qa-targeted-r4.log`. A rodada inclui atualização concorrente da interface sem perder formulário, sugestão obsoleta sem confirmação antiga de sucesso e encerramento de suporte com retorno ao contexto original.

Validação integral do mesmo produto: 733 arquivos unitários / 7.911 casos aprovados + 1 falha esperada; 184 arquivos de banco / 1.466 casos aprovados + 1 falha esperada e 1 ignorado, com INSTALL e UPDATE; tipos, lint (0 erros, 344 avisos) e build aprovados. `lint:channels`, validadores shell e conferência de release também passaram. Os checks remotos continuam sendo condição do merge pelo revisor da PR #613.

## J23 — Clientes pela agenda: o administrador liga, e quem tem horário vira cliente `[P1]` (2026-09-15)

Contribuição de @423313 (PR #867), com a decisão do dono: a regra nasce
**desligada** em toda organização, e só um administrador a liga, em
Configurações › Tipos de agendamento (migration 0262). A porta secundária é o
rodapé da tela de Funis, que diz onde ligar enquanto estiver desligada.

Spec: `tests/e2e/cliente-pela-agenda.spec.ts` (organização e admin próprios,
criados e apagados pela spec — ligar a regra na organização compartilhada do CI
etiquetaria os contatos das outras specs). Banco: `tests/invariants/cliente-nasce-do-agendamento.test.ts`.

| Caso | Prioridade | Resultado |
|---|---|---|
| J23.1 Marcar horário para um contato PELA AGENDA com a regra desligada: a lista de Contatos não mostra selo "Cliente", a célula Tags da linha não tem "cliente" e a ficha não tem o chip nem "Cliente desde" | `[P1]` | **PASS** — `evidence/cliente-pela-agenda/1-contatos-regra-desligada.png` |
| J23.2 Configurações › Tipos de agendamento (pelo hub) mostra "Desligado: …"; ligar abre a confirmação que diz que religar tira a etiqueta de quem ficou sem horário e que desligar não tira a etiqueta | `[P1]` | **PASS** — `evidence/cliente-pela-agenda/2-regra-desligada.png`, `evidence/cliente-pela-agenda/3-confirmacao.png` |
| J23.3 Confirmar: "1 contato ganhou a etiqueta “cliente”."; o interruptor fica `aria-checked=true`, habilitado e com opacidade 1 (medido por `getComputedStyle`) | `[P1]` | **PASS** — `evidence/cliente-pela-agenda/4-regra-ligada.png` |
| J23.4 Ligada: selo "Cliente" na lista, filtro "cliente" acha o contato, ficha mostra "Cliente desde" com a data do primeiro horário que conta — o dia em que se combinou, ou o dia do atendimento quando ele for mais antigo —, nunca uma data futura, Funis oferece "Funil de clientes" | `[P1]` | **PASS** — `evidence/cliente-pela-agenda/5-contatos-filtro-cliente.png`, `evidence/cliente-pela-agenda/6-ficha-cliente-desde.png` |
| J23.5 Marcar o funil de clientes, RECARREGAR: o selo "Clientes" e o botão "Deixar de ser funil de clientes" continuam | `[P1]` | **PASS** — `evidence/cliente-pela-agenda/7-funis-com-funil-de-clientes.png` |

Execução (2026-09-15): build de produção (`pnpm e2e:build`) da árvore
`f1fa08a19` + a spec, Supabase local próprio com o `baseline.sql` aplicado
(`ON_ERROR_STOP=1`, 0 erros), Chromium real, `next start`. 1 passed.

**Controle da spec:** com o trigger sabotado para ignorar o interruptor (no
banco do teste, restaurado depois), a spec reprova — em J23.3, e não em J23.1
como eu previra: o selo da lista é escondido pela própria regra desligada
(`ActiveOrg.cliente_pela_agenda`), então o contato etiquetado indevidamente só
aparece quando ligar diz "Nenhum contato tinha horário marcado ainda".

**Achado da própria spec, não do produto:** a primeira versão conferia o botão
de Funis com `toContainText`, que não exige visibilidade — passou com a tela
ainda no esqueleto do `loading.tsx` (o conteúdo chega num `<div hidden>` do
streaming), e a evidência capturada era o esqueleto. Agora a spec espera
`toBeVisible` antes do texto. Uma rodada caiu por 504 do GoTrue local sob carga
da máquina (`AuthRetryableFetchError`, média de carga 24); a seguinte passou sem
nenhum 504.

O que a tela NÃO prova, e onde está provado: cancelado e falta não contam, a
etiqueta tirada à mão não volta, o `contact.tag_added` no formato do app, a
classificação do histórico só da organização que liga e sem evento, e quem pode
ligar (admin, MFA, suporte) — todos no invariante acima, contra Postgres real.

**Rodada 2 (2026-09-15), sobre os achados da revisão.** Execução: build de
produção da árvore `88461bda5`, Supabase local próprio (project `fx867-e2e`,
portas 556xx) com o `baseline.sql` aplicado (`ON_ERROR_STOP=1`, 0 erros),
Chromium real, `next start` na 3867. 1 passed (23s). A evidência 6 agora mostra
"Criado em 15/09/2026 · Cliente desde 15/09/2026" — a da rodada 1 mostrava
"Cliente desde 21/09/2026", o dia do horário, que ainda não tinha chegado.

Controles, cada um com a previsão escrita antes:

- **E2E-S1** (o trigger ignora o interruptor, no banco do teste, restaurado
  depois): reprova no **J23.1**, na célula Tags (`toHaveCount(0)`, recebido 1).
  Na rodada 1 esse passo não reprovava, porque só olhava o selo que a tela
  esconde por `ActiveOrg`.
- **E2E-S2** (`/app/kanban` sem `is_client_pipeline` no select, build
  refeito): reprova no **J23.5**, depois do reload ("Funil de clientes" onde
  devia estar "Deixar de ser funil de clientes"). Sem o reload, passava.

Duas rodadas caíram antes da verde por carga da máquina (média 25–42, de outras
sessões): um 502 do Kong em `fn_support_context` (`recv() failed (104:
Connection reset by peer)` do PostgREST), que a rota do funil devolve como 503
`upstream_unavailable`, e 504 do GoTrue em `/auth/v1/user`. Nenhuma das duas
falhas tocou código desta feature; a terceira rodada, com a carga em 12, passou.

**Rodada 3 (2026-09-15), sobre os achados da segunda revisão.** Três defeitos
achados executando, nenhum deles alcançável pela spec atual — e é isso que os
torna interessantes de registrar aqui:

- **A frase da tela sobre a agenda que só tem cancelamento.** Organização cujo
  único contato TEM horário marcado, todos cancelados: o corpo da RPC era
  `{ganharam: 0, perderam: 0, clientes: 0}` — três números idênticos aos de uma
  agenda vazia — e a tela dizia "Nenhum contato tinha horário marcado ainda".
  Numa clínica com cancelamentos é a primeira frase depois de ligar. Provado e
  guardado em `components/agenda/ClientePelaAgenda.test.tsx` (o corpo agora tem
  um quarto número) e no invariante I38. **A spec não alcança**: ela monta uma
  organização com um horário que CONTA, e montar a agenda só de cancelamento
  seria uma segunda organização inteira pela tela.
- **A etiqueta que a equipe repõe à mão.** O sistema a tirava no cancelamento
  seguinte, porque o dono só era reconciliado quando a data mudava. Invariante
  I34 (e I34b, o par). **A spec não alcança**: são quatro edições de etiqueta
  pela tela de Contatos, com um cancelamento no meio.
- **As três colunas gravadas por sessão.** Um `viewer` da própria organização
  gravava `first_service_at = '2019-01-01'` com `UPDATE 1`. Invariante I36 (e
  I37, o par). **A spec não alcança**: nenhuma tela oferece essa escrita — o
  caminho é a API/PostgREST, e o que a fecha é um trigger.

Não houve rodada nova de Playwright nesta rodada 3: nenhuma das três mudanças de
comportamento é alcançável pela jornada da spec, e a única mudança de TEXTO na
tela (a frase nova e a das automações) é medida pelo teste de componente. O que
a rodada 2 provou pela tela continua valendo — a árvore mudou o corpo da RPC,
não o caminho que a spec percorre.

## Lote 11 da triagem, em ambiente fresco estilo VPS (2026-09-15)

QA visual da integração `integracao/triagem-15set-l11` no SHA `d82366250`: os PRs
**#867** ("clientes pela agenda", @423313) e **#897** (o título do compromisso
pessoal do Google sai do alcance do colega, @webtecnica — issue #892). Provas e
receita completa do ambiente em `evidence/triagem-15set-l11/README.md`.

Ambiente: Supabase local pg **17.6** próprio (`qa-l11`, portas 6132x) montado **só
pelo `supabase/baseline.sql`** (`ON_ERROR_STOP=1`, exit 0), chave de cifra semeada
como o kit faz, dona por `scripts/bootstrap-owner.ts`, **onboarding concluído pela
tela**, `pnpm e2e:build` exit 0 (399 s) + `next start`, e **os envs opcionais
ausentes** — sem Resend, sem Google, sem chave de IA, sem Redis. Chromium real em
`America/Sao_Paulo`/`pt-BR`.

Esta rodada é complementar à J23 acima, que exercita a spec `cliente-pela-agenda`
numa organização própria: aqui o banco é o de uma **instalação recém-feita**, e o
que se mede é o que a spec não alcança — o caminho pela navegação, o ciclo
completo da automação com drenagem de cron de verdade, o papel `agent`, 400 px e
tema escuro, e a privacidade do #897 com dois logins distintos.

| Caso | Prioridade | Resultado |
|---|---|---|
| L11.1 O banco recém-instalado pelo baseline já traz as três colunas da 0262, os quatro gatilhos, as três funções, a view **sem** `title` e `has_column_privilege(authenticated, …, title, SELECT) = false` | `[P0]` | **PASS** — tabela no README |
| L11.2 `organizations.settings` de uma organização nova **não tem** `crm.cliente_pela_agenda`: a regra nasce desligada | `[P0]` | **PASS** |
| L11.3 Com a regra desligada, marcar horário pela Agenda para um contato não dá etiqueta, não dá "Cliente desde" e não escreve `first_service_at` | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-01-marcado-com-a-regra-desligada.png`, `evidence/triagem-15set-l11/867-02-ficha-sem-etiqueta-regra-desligada.png` |
| L11.4 Chegar ao interruptor **pela navegação**: barra lateral › Configurações › SUA EMPRESA › Tipos de agendamento | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-04-hub-de-configuracoes-tipos-de-agendamento.png`, `evidence/triagem-15set-l11/867-05-interruptor-nasce-desligado.png` |
| L11.5 Ligar como admin: confirmação antes, "2 contatos ganharam a etiqueta"; quem tinha horário que conta ganha etiqueta e "Cliente desde"; **quem só tinha horário cancelado não ganha** | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-06-confirmacao-antes-de-ligar.png`, `evidence/triagem-15set-l11/867-07-ligado-com-o-resultado.png`, `evidence/triagem-15set-l11/867-08-ficha-marina-cliente-desde.png`, `evidence/triagem-15set-l11/867-09-ficha-bruno-so-cancelado-sem-etiqueta.png` |
| L11.6 A equipe tira a etiqueta à mão e marca **outro** horário: a etiqueta não volta (`client_tag_by_system` vai a `null` e fica) | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-21-tirando-a-etiqueta-a-mao.png`, `evidence/triagem-15set-l11/867-22-helena-sem-a-etiqueta.png`, `evidence/triagem-15set-l11/867-23-a-etiqueta-nao-volta.png` |
| L11.7 Automação criada **pela tela** ("quando um contato ganhar a tag `cliente`, adicionar `recepcao-de-cliente`"), primeiro horário de um contato novo, **drenagem pelo endpoint de cron com o segredo** (`scanned 7, done 7`): a automação executa, aparece no histórico e o efeito chega à ficha | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-14-automacao-quando-ganhar-a-etiqueta.png`, `evidence/triagem-15set-l11/867-16-automacao-ligada.png`, `evidence/triagem-15set-l11/867-19-historico-da-automacao.png`, `evidence/triagem-15set-l11/867-18-diego-com-a-etiqueta-da-automacao.png` |
| L11.8 Desligar não tira etiqueta de ninguém (tabela idêntica antes/depois, sem diálogo); religar não repõe a que a equipe tirou | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-27-desligado-ninguem-perde-a-etiqueta.png`, `evidence/triagem-15set-l11/867-28-religado-a-etiqueta-tirada-a-mao-nao-volta.png` |
| L11.9 `agent` vê a seção mas o interruptor está **desabilitado**, com "Só um administrador pode mudar essa regra."; clique forçado não muda o banco | `[P1]` | **PASS** — `evidence/triagem-15set-l11/867-25-atendente-nao-liga-o-interruptor.png` |
| L11.10 A tela do interruptor em **400 px, tema escuro**: `scrollWidth` 400 = `clientWidth` 400, 0 elementos fora da tela | `[P2]` | **PASS** — `evidence/triagem-15set-l11/867-26-interruptor-400px-tema-escuro.png` |
| L11.11 **#897** Atendente criada 100% pela tela (convite › link copiável sem Resend › criar conta › confirmação na caixa local › Inbox) | `[P0]` | **PASS** — `evidence/triagem-15set-l11/897-02-link-do-convite-na-tela.png`, `evidence/triagem-15set-l11/897-06-atendente-dentro-do-sistema.png` |
| L11.12 **#897** Nenhuma tela da Atendente mostra o título do compromisso pessoal da dona — varrido em `innerText` **e** no `outerHTML` inteiro, nas visões Semana, Dia, Mês, na semana do evento e no painel de marcar | `[P0]` | **PASS** — `evidence/triagem-15set-l11/897-07-atendente-agenda-semana.png`, `evidence/triagem-15set-l11/897-08-atendente-semana-do-evento.png`, `evidence/triagem-15set-l11/897-09-atendente-segunda-21-sem-as-10h.png` |
| L11.13 **#897** Pela REST com o token de sessão da Atendente: `title` na tabela → `42501`; `title` na view → `42703`; `select=*` na view → a linha sem título. **Controle positivo**: a chave de serviço lê o título | `[P0]` | **PASS** — tabela no README |
| L11.14 **#897** Para a dona nada quebrou: 1 bloco "Ocupado" na semana, GET com `titulo: "Ocupado"`, painel sem 10:00/10:30 — e ela também não alcança o `title` | `[P1]` | **PASS** — `evidence/triagem-15set-l11/897-11-dona-semana-do-evento.png`, `evidence/triagem-15set-l11/897-12-dona-segunda-21-sem-as-10h.png` |
| L11.15 Regressão do lote 10: a Atendente não recebe 10:00/10:30 e o encaixe 10:15 é recusado com `422 agenda_horario_indisponivel`, sem citar o título | `[P1]` | **PASS** — `evidence/triagem-15set-l11/897-10-atendente-encaixe-1015-recusado.png` |
| L11.16 Regressão: "Outro horário" num encaixe livre (`201`, "Marcado.") e `/admin/meta` abre (`200`) | `[P2]` | **PASS** — `evidence/triagem-15set-l11/regr-01-encaixe-1515-marcado.png`, `evidence/triagem-15set-l11/regr-02-admin-meta-carrega.png` |

**Nenhum defeito no código do lote.** Dois achados anteriores a ele, com o detalhe
e as medidas no README:

1. O contato criado de dentro do painel de marcar leva alguns segundos para
   aparecer em "Quem será atendido", e nesse intervalo a tela exibe
   "Compromisso pessoal, sem cliente" **sem indicação de carregamento** — uma
   escolha de negócio legítima, mostrada como se fosse a escolhida. Medido: ~4 s
   com a máquina carregada, menos de 1,5 s com ela saudável, e **não consegui
   produzir um agendamento sem cliente** quando o ambiente estava saudável. O que
   está medido é o estado EXIBIDO, não um desfecho errado.
   `components/agenda/VinculoDaMarcacao.tsx`, não tocado pelo lote.
2. Todo agendamento emite `crm.activity_write_failed` com
   `origem: "agenda (sem negócio aberto para ancorar)"` — contato criado direto na
   Agenda não tem negócio para ancorar a atividade de timeline. Aparece também com
   a regra desligada, então é independente do #867.

**Duas armadilhas de ambiente**, para quem repetir: `supabase start` derruba o
stack inteiro (exit **137**, que lê como OOM e não é) quando um contêiner falha o
healthcheck, levando junto o `psql` do baseline — o log do CLI é que diz
`container is not ready: unhealthy`; e um Realtime unhealthy varrendo o WAL levou o
Postgres a `57014 statement timeout` e o GoTrue a `504`. **O Realtime não foi
exercitado nesta rodada.**

## J30 — Um segundo número da API Oficial na mesma organização `[P1]` (2026-09-23)

A primeira organização com dois números oficiais, em **contas (WABAs) e apps da Meta
diferentes**. Antes, a porta de entrada conhecia um canal oficial por organização:
conectar o segundo número **sobrescrevia** o primeiro (as conversas dele passavam a
apontar para outro número), e a tela, com duas linhas, dizia "não conectado".

| Caso | O que prova | Onde | Estado |
|---|---|---|---|
| J30.1 | Dois números aparecem os dois, cada um com a SUA URL de webhook | `tests/e2e/canal-oficial-varios-numeros.spec.ts` | FAIL → PASS |
| J30.2 | Número novo é canal novo; o mesmo número é troca de credencial | unidade da rota (`canal-arquivado-caminho-de-volta.test.ts`) | FAIL → PASS |
| J30.3 | "Trocar credencial" trava o ID do número (mudá-lo criaria outro canal) | e2e acima | PASS |
| J30.4 | Credencial ruim para um terceiro número é recusada pela Meta real e não toca os outros | e2e acima | PASS |
| J30.5 | O número de outro app da Meta é aceito com a chave secreta DELE (0275) | `webhook-meta-le-do-banco.test.ts` | FAIL → PASS |
| J30.6 | Cada número só oferece e só envia os modelos da sua conta | `modelos-por-conta-oficial.test.ts` | FAIL → PASS |

**Não medido aqui:** conectar pela tela com credencial VÁLIDA (o ambiente local não tem
token da Meta) e uma mensagem real chegando pelo segundo número. Isso é a virada, feita
em produção.

## J31 — O balão do canal oficial diz o que aconteceu: checks, reação e quem respondeu `[P1]` (2026-09-23)

Três pedidos do Linear (DYD-15, DYD-16, DYD-13). **Medido em produção antes:** 300 de 300
mensagens enviadas pelo número oficial em 3 dias ficaram em UM check — o webhook gravava
`delivered`/`read` como `sent`; a reação do cliente virava mensagem vazia `[reaction]` que
acordava a IA; e toda resposta de colega aparecia como "Atendente".

| Caso | O que prova | Onde | Estado |
|---|---|---|---|
| J31.1 | Um check (enviada), dois (entregue), dois azuis (lida — `#53bdeb` medido por `getComputedStyle`) | `tests/e2e/inbox-checks-reacoes-e-nome.spec.ts` | FAIL → PASS |
| J31.2 | Status só sobe; falha guarda `meta_<código>` e o motivo; status antes do wamid re-tenta | `tests/unit/meta-status-e-reacao.test.ts` | FAIL → PASS |
| J31.3 | A mensagem do colega traz o NOME dele; a minha segue "Você" | e2e acima + `MessageBubble.test.tsx` | FAIL → PASS |
| J31.4 | A reação do cliente aparece colada ao balão (medido: ≤ 24 px da borda de baixo) | e2e acima | FAIL → PASS |
| J31.5 | O botão de ações abre Responder e Reagir; Reagir mostra os seis emojis e o "+" (grade + colar) | e2e acima | FAIL → PASS |
| J31.6 | Reação que não sai não fica no balão, e a tela diz o porquê | e2e acima | PASS |
| J31.7 | Gravar/substituir/remover, reação mais velha não vale, não cruza organização, grants | `tests/invariants/reacao-na-mensagem.test.ts` | FAIL → PASS |

**Não medido aqui:** a reação saindo de verdade para um celular (sem token da Meta local) e
se a reação do cliente abre a janela de 24h (por conservadorismo, não mexe em
`last_inbound_at`). WAHA e o canal intermediado declaram `reacoes: false`.

## J32 — Desbloquear um contato bloqueado por opt-out `[P1]` (2026-09-25)

Até aqui `contacts.is_blocked` só ia para `true`: a reversão do falso positivo de
2026-09-25 (corrigido na v1.42.1) foi SQL à mão. A porta é `POST
/api/v1/contacts/[id]/unblock` (manager+, motivo obrigatório, audit `contact.unblocked`),
aberta por duas telas: o botão **Desbloquear** da ficha e o selo "Cliente pediu para não
receber mensagens" do Inbox, que vira botão para manager+.

| Caso | O que prova | Onde | Estado |
|---|---|---|---|
| J32.1 | O bloqueio nasce pelo caminho real (`aplicarEfeitosPosEntrada` com "SAIR") | `tests/e2e/desbloquear-contato.spec.ts` | PASS |
| J32.2 | `agent` vê o selo e o "Bloqueado", sem porta; a API devolve 403 e o banco não muda | e2e acima | PASS |
| J32.3 | O gerente só confirma com motivo ≥ 10 caracteres E a marcação de que conferiu | e2e acima | PASS |
| J32.4 | Desbloquear zera as três colunas e audita quem, motivo e o bloqueio desfeito | e2e acima + `lib/contacts/desbloquear.test.ts` | PASS |
| J32.5 | Pedir para sair de novo bloqueia de novo; a ficha desbloqueia e cita a data do bloqueio | e2e acima | PASS |
| J32.6 | Filtra `organization_id` nas duas queries; anonimizado é 403; corrida perdida é 409 sem auditoria | `lib/contacts/desbloquear.test.ts` | PASS |

**Não medido aqui:** o próximo envio real (WAHA/Meta) depois do desbloqueio — o motor lê
`is_blocked` direto da fonte a cada turno, então não há cache a limpar, mas o envio não foi
exercitado. A RLS de `contacts` deixa qualquer membro fazer UPDATE, então a régua manager+
vale para esta rota e para a tela, não para quem escrever direto no PostgREST com a própria
sessão.

## J33 — O aviso de mensagem diz de quem é `[P0]` (2026-09-25)

Pedido do dono: o aviso chegava só com o texto do cliente, e o atendente com várias
conversas abertas não sabia de quem era. **A causa não era de apresentação:** o aviso
com a aba aberta lia contato e conversa pelo supabase-js do navegador, que não enxerga o
cookie httpOnly — a consulta saía ANÔNIMA, a RLS devolvia vazio, e o título caía para
"Nova mensagem". Com "só as minhas" (padrão do atendente desde a 0281) a conversa voltava
nula e o aviso **nem aparecia**. Medido: 401 `42501` na primeira execução da spec.

O contexto agora vem de `GET /api/v1/conversations/[id]/aviso` (sessão + RLS, uma leitura
com contato e time embutidos, foto já assinada, "quem está no comando" pela régua do Inbox),
guardado 15 s por conversa na aba — o pedido em voo e a falha também. O push
do servidor ganhou o time no título sem consulta a mais (a leitura do contato virou a da
conversa com o contato embutido).

| Caso | O que prova | Onde | Estado |
|---|---|---|---|
| J33.1 | Fora do Inbox, o aviso mostra nome, "Financeiro · com você" e a prévia | `tests/e2e/aviso-de-mensagem-diz-de-quem-e.spec.ts` | FAIL → PASS |
| J33.2 | A rajada atualiza o MESMO aviso ("2 mensagens"); áudio chega como "🎤 Áudio" | e2e acima | PASS |
| J33.3 | A rajada pede o contexto uma vez só, e nenhuma consulta REST direta sai do navegador | e2e acima | PASS |
| J33.4 | O cartão abre a conversa | e2e acima | PASS |
| J33.5 | Conversa que a RLS esconde é 404; anonimizado não devolve foto; o caminho do arquivo não vaza | `app/api/v1/conversations/[id]/aviso/route.test.ts` | PASS |
| J33.6 | Conversa com o automático sai "no automático", não "na fila" (régua `comandoDaConversa` do Inbox); nome técnico do WhatsApp nunca vira título | `lib/notifications/aviso-de-mensagem.test.ts` | PASS |

**Não medido aqui:** a notificação na bandeja do sistema e o push com a aba fechada
(headless nega `Notification`; push depende de FCM — ver J12). O título da bandeja e do
push ("Maria Souza · Financeiro") está coberto em unidade (`push_payload.test.ts`,
`deliver.test.ts`), não na tela.

## J34 — Espera dispensada pela Assistente e religada pelo atendente `[P1]` (2026-09-26)

O termômetro do card contava o "ok, obrigado" do cliente como espera, e a conversa
ficava laranja/vermelha sem ninguém ter o que responder. Agora a Assistente (o Jev, pela
chave OpenRouter da organização) pergunta se a fala sem resposta pede resposta; com
P ≤ 0,15 ela DISPENSA a espera (`fn_dispensar_espera`, migration 0285): o card troca o
termômetro pelo selo **Não pede resposta** e o chat mostra por quê, com o único gesto
humano — **Contar mesmo assim**, que devolve a espera com a hora ORIGINAL e trava a
Assistente até a empresa responder.

| Caso | O que prova | Onde | Estado |
|---|---|---|---|
| J34.1 | Conversa com a atendente, entrada há 6 min: card `data-nivel="laranja"`, title "Cliente sem resposta desde HH:mm", faixa do chat laranja | `tests/e2e/espera-que-pede-resposta.spec.ts` (teste 1) | PASS |
| J34.2 | A dispensa pela MESMA RPC do worker chega à tela pelo realtime, sem recarregar: selo "Não pede resposta", termômetro some, faixa dispensada, e a linha do tempo diz "Assistente: a mensagem do cliente não pede resposta" | e2e acima | PASS |
| J34.3 | "Contar mesmo assim" devolve o termômetro com a hora ORIGINAL (title e `espera_desde` iguais aos de antes), grava `espera_mantida_em`, e a linha do tempo mostra "Espera contada mesmo assim — Por Ana Atendente." | e2e acima | PASS |
| J34.4 | Worker de verdade: mensagens pelo webhook WAHA (inclusive a resposta da atendente pelo celular, `fromMe`), o dreno da requisição ADIA a Assistente (15 s) e o dreno de cron a roda; o Jev falso (`noul` 0,05) recebe a chave decifrada da organização, o modelo fixo e "ok obrigado" em `sem_resposta`; o card vira "Não pede resposta" | e2e acima (teste 2) | PASS |
| J34.5 | O cliente pergunta "e o horário de sábado?" (Jev falso a 0,9): a dispensa se desfaz e a espera conta DESTA mensagem — `espera_desde` = carimbo da mensagem nova, maior que o do "ok obrigado"; 2 linhas `llm_calls` com `purpose = 'wait_classify'` | e2e acima | PASS |

Evidência: `.superpowers/evidence/espera-que-pede-resposta/01…06-*.png` (local, fora do git).
Rodado em 2026-09-26 contra o Supabase local pg15 (baseline até a 0284 + a 0285 aplicada
por cima, como o `update.sh` faria), `next build` + `next start`, sem `OPENROUTER_API_KEY`
nem Redis — a chave é a credencial da organização, cifrada como o produto cifra.

**Achados desta execução (nenhum defeito da feature):**
- A ingestão marca a saída digitada no celular (`fromMe`) com a hora de CHEGADA do webhook,
  e a entrada com o carimbo do WhatsApp (`lib/waha/ingest.ts`, `markConversation`). Uma
  entrada que chegue atrasada, com carimbo anterior a uma saída recém-ingerida, não abre
  espera. Anterior a esta feature; a spec usa carimbos atuais por isso.
- O dreno reagenda o evento pelo PRIMEIRO `retry` da lista de handlers
  (`lib/event-log/drain.ts`), não pelo mais cedo. Quando o sentimento (registrado antes)
  pede `retry` por falha temporária do Jev (+60 s), o adiamento da Assistente (+15 s)
  vira 60 s. Medido com o Jev falso respondendo 503 ao sentimento; a spec responde 400 às
  perguntas que não são dela.

**Não medido aqui:** o Jev real (calibração em português com conversas reais), mensagem
de áudio aguardando transcrição, e a corrida "o cliente escreve enquanto o Jev pensa"
(coberta em `tests/invariants/espera-dispensada-pela-assistente.test.ts` e nos testes do
worker, não na tela). Também não medida: a corrida estreita entre o INSERT de `messages`
(que emite `message.received` no MESMO trigger) e `fn_mark_conversation_message`, que só
carimba `espera_desde` depois — se o dreno pegar o evento nesse intervalo, o worker lê
`espera_desde` nulo e termina `sem_espera` sem nunca chamar o Jev, e aquela mensagem do
cliente nunca é julgada pela Assistente. O lado seguro: a espera continua contando (o
termômetro não pára por causa disso), só a dispensa é que não acontece para essa mensagem.

## J35 — Telefone no CRM: cadastrar o número da operadora, ligar e atender pelo navegador `[P0]` (2026-09-28)

Pedido do dono (DYD-10): o atendente faz e recebe ligação pelo próprio CRM, pelos números SIP
que a empresa já contratou, com os números cadastrados **pela tela** e vários por organização.
Spec `docs/specs/20-spec-telefonia-sip.md` (o checklist do sistema vivo está no §10); mapa em
`docs/architecture/telefonia.architecture.json`; migration 0286.

`[P0]` porque é primeira impressão duas vezes: a do admin, que cola usuário e senha da
operadora e espera ver "Conectado"; e a de quem liga para a empresa, que é o cliente final.

**Como foi provado — e o que isso NÃO é.** Pela tela, à mão, com a operadora real (o tronco de
teste da Totus, FreeSWITCH, G.711), no Mac de desenvolvimento atrás de NAT duplo, Asterisk em
contêiner. **Não existe spec Playwright desta jornada** em `tests/e2e/`: nenhum caso abaixo é
repetível pelo CI, e a prova depende de uma conta SIP real que o CI não tem. O que é
automatizado é unidade: `lib/channels/telefonia/controle.test.ts` (a máquina de estados da
recebida e da feita, com dublês da ARI e do banco), `lib/telefonia/distribuicao.test.ts` (a
ordem do toque) e `lib/telefonia/numero.test.ts` (a política de número).

| Caso | Prioridade | Resultado |
|---|---|---|
| J35.1 O admin cadastra o número em Conexões › Telefone (nome, número, servidor, porta, transporte, usuário, senha, time que recebe) e a linha passa de "Conectando" a **Conectado** | `[P0]` | **PASS** (pela tela, operadora real) |
| J35.2 Ligação FEITA pelo discador do cabeçalho: a operadora chama, a pessoa atende, **áudio nos dois sentidos**, desliga — e o **cartão da ligação** aparece na conversa de telefone do contato | `[P0]` | **PASS** (pela tela, operadora real) |
| J35.3 Reiniciar o contêiner do Asterisk: o worker reconecta, sincroniza de novo e o número **volta a registrar** sozinho | `[P1]` | **PASS** (pela tela, operadora real) — **mas não era garantido: ver J35.18**, o mesmo gesto falhou em produção |
| J35.4 Editar o número de UDP para **TCP**: o tronco é recriado e passa a registrar por TCP | `[P1]` | **PASS** (pela tela, operadora real) — ver o defeito 1 abaixo |
| J35.5 Ligação RECEBIDA: toca no navegador de um atendente disponível do time, ele atende, áudio nos dois sentidos, cartão na conversa, e a conversa passa a ser dele | `[P0]` | **infra PROVADA, produto pendente.** Ligação RECEBIDA chega à VPS de produção com áudio nos 2 sentidos — PROVADO em 2026-09-28 com Asterisk de teste descartável (infra: NAT do Docker preserva a 5060, faixa UDP 20000–20039 passa o firewall). O fluxo do PRODUTO (Stasis escolhe quem toca, atendente atende no navegador) segue pendente de prova em produção. Atrás do NAT duplo do Mac a operadora não entregava a INVITE |
| J35.14 Só o registro identifica o tronco: com `identify_by=ip` no endpoint (sem objeto `identify`), uma INVITE forjada com `From: tronco-<id>` é recusada, e a recebida real continua casando pelo `line` do registro | `[P0]` | **PASS (medido, 2026-09-28)** — Asterisk 20 com os objetos de `objetosDoTronco`: forjada → "No matching endpoint found" / 401 (antes: atendida sem senha, com o `P-Asserted-Identity` falso virando o número do cliente); real da operadora, R-URI `sip:…;line=aqsytoa` → `tronco-<id>`. Vigiado por `lib/channels/telefonia/pjsip.test.ts` |
| J35.15 O WebSocket do ramal só abre para atendente com sessão do próprio site | `[P0]` | **PASS no proxy (Caddy 2.11.4 real, Caddyfile do repo, app e Asterisk dublados)** — anônimo 401, sessão válida 101; sem o `forward_auth`, o anônimo recebia 101. Rota em `app/api/v1/telefonia/ws/autorizar/route.test.ts`, que também prova que ela não renova a sessão. **Não medido:** o `forwardAuth` do Traefik; pela tela, com o app de verdade |
| J35.6 Recebida sem ninguém disponível: quem liga ouve música; em 2 min a ligação cai e vira "Ligar de volta" na Central | `[P0]` | pendente de prova (máquina de estados em unidade) |
| J35.7 Recebida com mais de um atendente: um por vez, 20 s cada, duas voltas, quem atendeu menos RECEBIDAS hoje primeiro | `[P1]` | pendente de prova (ordem em unidade) |
| J35.8 Ligar pelo botão **Ligar** do cabeçalho da conversa e da ficha do contato | `[P0]` | pendente de prova |
| J35.9 Número fora da política (internacional, 0800, 190, sem DDD) é recusado **na tela**, com o motivo, antes de discar | `[P1]` | pendente de prova pela tela (regra em unidade) |
| J35.10 Senha errada ou operadora muda: a linha mostra **Falhou** com o motivo ("recusou o usuário ou a senha" / sem resposta) | `[P0]` | pendente de prova |
| J35.11 A conversa de telefone só aceita nota interna; uma resposta de texto é recusada (422) antes de gravar | `[P1]` | pendente de prova |
| J35.12 Instalação com a telefonia DESLIGADA (o estado de toda VPS nova): a aba Telefone diz que está desligada e como ligar, e nenhum botão de ligar aparece em lugar nenhum | `[P0]` | pendente de prova |
| J35.13 Remover o número: some da lista, o registro na operadora é solto, e as conversas e ligações antigas continuam no Inbox | `[P1]` | pendente de prova |
| J35.16 Ligar a telefonia numa instalação JÁ na última versão (`telefonia` em `COMPOSE_PROFILES`, `TELEFONIA_ARI_URL`, `bash hostgator-setup-kit/update.sh`): o script sobe o Asterisk em vez de responder "Nada a atualizar" | `[P0]` | **decisão do script coberta** — `tests/shell/update-guard.test.sh` caso 14, com controles (tudo no alvo, profile desligado, stack parada) e seis sabotagens. **Defeito lido no código em 2026-09-28, não medido em VPS:** os critérios de `image_desatualizada` só olhavam app, worker e scheduler; e quem chegou à 1.48.0 pelo `update.sh` da 1.47.0 ficava sem `ASTERISK_IMAGE` e sem `TELEFONIA_ARI_PASSWORD`. **NÃO medido:** numa VPS real, nem pela tela — a prova é com `docker` dublado |
| J35.17 O número que já atende pelo **WhatsApp** da organização entra em Conexões › Telefone: o mesmo número em dois meios (o fixo da empresa na API oficial e na operadora) não é repetição, e a tela não recusa | `[P0]` | **PASS em produção, pela tela (2026-10-05); spec ainda sem execução verde** — o dono cadastrou em Conexões › Telefone o número que já era o WhatsApp oficial da organização: a tela aceitou, o tronco registrou na operadora e a linha passou de "Conectando" a "Conectado" em 63 s (as duas linhas ativas com o mesmo número conferidas no banco). Automatizado: `tests/invariants/numero-unico-por-meio.test.ts` (os dois sentidos, a cura do banco antigo) e `telefonia-menus-no-banco.test.ts` (o `criarNumero` de verdade); em produção (1.52.2, 2026-10-02) os dois índices estão no banco. Pela tela, o caso "o mesmo número, dois meios" de `tests/e2e/telefonia-ura-e-falas.spec.ts` (parte 3 do CI): a primeira execução falhou por um motivo do AMBIENTE — o banco do e2e não tem a chave de cifra da instalação, e cadastrar número cifra a senha SIP (500 antes de chegar à trava); o caso passou a pôr e tirar a chave. Ver o defeito 7 abaixo |
| J35.18 O Asterisk cai e volta sozinho (crash com `restart: unless-stopped`, ou só o contêiner dele recriado): o worker **reconecta sem ninguém reiniciá-lo** — e o desligamento do worker não fica preso numa conexão que não abriu | `[P0]` | **FALHOU em produção (2026-09-30, ~19:33 UTC); consertado, prova com o Asterisk real pendente.** Recriado só o contêiner do Asterisk (`up -d --no-deps asterisk`), o worker registrou UMA vez "conexão com o Asterisk caiu" (`fechou (1006)`, `em_ms` 1000) e nunca mais nada: `ari show apps` vazio, nenhum registro na operadora, telefone mudo até um `docker restart` do worker. **Causa (medida na imagem do worker, `node:22-alpine`, Node 22.23.3, undici 6.28.1):** o laço só saía de uma conexão pelo `close`, e o WebSocket do Node 22 não o dispara quando a ABERTURA falha — porta fechada, nome que não resolve, resposta 404/503/401 e conexão derrubada dão só `error` (no Node 24 vem `close(1006)` em seguida); servidor que aceita o TCP e não responde não dá sinal nenhum por 302 s. A tentativa de 1 s depois da queda pega o Asterisk ainda subindo, e ali o laço parava para sempre. Pelo mesmo motivo o SIGTERM não encerrava o laço, e o worker saía pelo SIGKILL do Docker. **Prova do conserto:** `lib/channels/telefonia/laco.test.ts` (§5: a abertura que falha sem `close`, a que não dá sinal em 10 s, os eventos tardios do socket largado, nunca duas conexões ao mesmo tempo, e o desligamento), com nove sabotagens, cada uma vermelha; e um ensaio com o laço e o `ClienteAri` reais e o WebSocket real do Node 22 contra um servidor que morre, volta mudo e volta de verdade — antes: uma linha de log e silêncio, sem reconectar nem encerrar; depois: reconecta, uma sessão por vez, e encerra 1 ms após o sinal. **Não medido:** com o Asterisk de verdade e a operadora real, na VPS — recriar o contêiner e ver "conectada ao Asterisk", o app `crm` em `ari show apps` e o número de volta a "Conectado" na tela |

**Defeitos que a prova pela tela achou, e que já estão consertados no código** (cada um está
anotado "medido na prova pela tela" no arquivo do conserto):

1. Editar o número para TCP seguia mandando REGISTER por UDP — o PUT por cima troca a
   configuração e o registro continua com a antiga. Agora editar RECRIA o tronco
   (`lib/channels/telefonia/sincronizacao.ts`, `empurrarTronco`).
2. O fim da ligação caía inteiro: `ON CONFLICT` não aceita a trava única deferível de
   `messages (organization_id, external_id)`. Agora confere antes e trata o 23505
   (`lib/channels/telefonia/repositorio.ts`, `registrarNaConversa`).
3. A conversa de uma ligação FEITA nascia na fila como "aguardando", com cara de cliente
   esperando atendimento. Agora fica com quem ligou (`lib/channels/telefonia/saida.ts`).
4. O painel da voz do WhatsApp adotava a ligação de telefone, abria o "Ouvir aqui" por cima do
   painel do telefone e disputava o microfone. Agora filtra `provider = wacalls`
   (`hooks/voice/useVoiceCallSession.ts`).
5. Aba fechada no meio da ligação deixou o cliente 4 min pendurado numa ponte com ninguém.
   Agora o ramal tem `rtp_timeout` de 30 s (`lib/channels/telefonia/pjsip.ts`).
6. Quem estava com o app aberto quando o primeiro número foi conectado ficava sem telefone até
   recarregar a página. Agora o navegador pergunta de novo a cada minuto e quando a aba volta
   ao foco (`components/telefonia/TelefoniaContext.tsx`).
7. **Achado em produção em 2026-10-02, não na prova pela tela:** cadastrar em Conexões ›
   Telefone o número que a organização já usava no WhatsApp oficial respondia "Esse número já
   está conectado nesta organização" a quem nunca o tinha ligado na telefonia. A trava de número
   único de `channel_sessions` é do tempo em que a tabela só tinha WhatsApp e não olha o
   provider; a 0286 a herdou. Agora a trava é por MEIO — mensagem e telefone não disputam o
   número (migration 0292). A prova da fase 1 usou um número só de telefone e não passou por aqui.

**Revisão de segurança de 2026-09-28** (lista completa e testes no §10.2 da spec): tronco
identificado só pelo registro (J35.14); `/telefonia/ws` atrás de autorização que não renova a
sessão (J35.15); trocar a conta SIP exige a senha de novo; servidor interno recusado; o worker
não empurra linha fora da régua; IP público validado no entrypoint; credencial do ramal
auditada; e a conversa de telefone deixou de entrar no rodízio de conversas — o worker de
rodízio a fecha como `skipped_voice_channel` sem atribuir
(`lib/routing/worker-nao-distribui-a-ligacao.test.ts`).

**Não medido:** CPU por ligação na VPS; mais de um registro da mesma conta ao mesmo tempo
(desenvolvimento e produção); o estado do número com o Asterisk fora do ar (pelo código, o
último estado gravado fica na tela); outros navegadores além do usado na prova (o ramal é
WebRTC pelo JsSIP).

## J36 — URA e falas do telefone: o cliente escolhe o time pela tecla `[P0]` (2026-09-29)

Pedido do dono (DYD-10, fase 2, versão 1): quem liga para a empresa ouve um menu gravado com a
voz escolhida e vai para o time certo; enquanto o ramal de um atendente toca, ouve o som de
chamando, e só quem não tem ninguém livre ouve "aguarde" (DYD-52, 1.50.2); fora do horário e em
instabilidade, ouve o aviso certo. Desenho em
`docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`; plano em
`docs/superpowers/plans/2026-09-28-telefonia-fase2-v1-ura.md`; mapa em
`docs/architecture/telefonia.architecture.json`; migration 0288.

`[P0]` porque a URA é a PRIMEIRA coisa que o cliente final ouve da empresa — antes de qualquer
atendente.

**Como é provado.** As telas, por `tests/e2e/telefonia-ura-e-falas.spec.ts` (parte 3 do CI, a
única com a telefonia oferecida: `E2E_TELEFONIA=1`), com um receptor HTTP que faz o papel da
ElevenLabs — a URL base só muda em teste (`ELEVENLABS_API_BASE_URL` no `.env.e2e`). A spec cria a
própria organização e não liga ligação nenhuma: nada escuta a porta da ARI. A ligação de verdade
— tecla, fala tocada do volume, fila — só se prova na VPS, com a operadora real e o dono ligando
do celular para o (61) 3686-1503 (Task 29 do plano). A máquina da URA e as falas na fila estão
em unidade (`lib/telefonia/ura.test.ts`, `lib/channels/telefonia/controle.test.ts`), e o SQL do
worker contra Postgres real (`tests/invariants/telefonia-repositorio-da-ura.test.ts`).

**Estado da spec:** **PASSOU** na execução 36576512233 do `e2e.yml` (`workflow_dispatch` na
branch da fase 2, commit `0fba1433`), job `e2e-parte (3)`, com `E2E_TELEFONIA=1`. Para conferir
na fonte a linha da spec no log desse job: `gh api repos/paulocmbcosta/DeskcommCRM/actions/jobs/109450910362/logs | grep -a '✓.*telefonia-ura-e-falas'`. A spec é um teste só, com oito passos; os casos J36.1 a
J36.6 são os passos dela, e PASS aqui vale só para eles. O job terminou vermelho por UMA outra
spec, `inbox-rotulo-de-origem.spec.ts:224`, que também falha no último e2e da `main`
(execução 36439395747, o merge do PR #93) — herdada, não desta versão. Nenhum caso a partir do
J36.7 é coberto por ela.

| Caso | Prioridade | Resultado |
|---|---|---|
| J36.1 O admin cola a chave em Credenciais de IA › "ElevenLabs (voz da URA)": a errada volta ao lado do campo ("A ElevenLabs recusou a chave, e ela não foi salva…"); a certa é guardada e a tela mostra só os 4 últimos dígitos; a chave não aparece em URL nenhuma | `[P0]` | **PASS** (e2e, execução 36576512233, passo 1; toda URL pedida pelo navegador é conferida) |
| J36.2 Voz escolhida numa lista vinda da conta; "Gerar prévia" da fala de aguarde toca no navegador SEM criar fala; "Salvar e usar" a cria; a mesma prévia de novo não chama a ElevenLabs | `[P0]` | **PASS** (e2e, execução 36576512233, passo 2; duração ~1 s medida no `<audio>`, sínteses contadas no receptor falso, linhas contadas no banco) |
| J36.3 Menu novo: a fala é montada das opções ("Para X, digite 1. Para Y, digite 2.") e o menu só salva com a prévia dela; o cartão lista `1 → X` e `2 → Y` | `[P0]` | **PASS** (e2e, execução 36576512233, passo 3) |
| J36.4 Em Números, "Quando ligarem" → "Tocar o menu": o cartão diz "Quando ligarem: menu <nome>", e o banco guarda só o menu (`sip_team_id` nulo) | `[P0]` | **PASS** (e2e, execução 36576512233, passo 4) |
| J36.5 Aviso de instabilidade com texto novo: "Ligar" só destrava depois de "Gerar prévia" e "Ouvir"; ligado por 1 hora, o cartão diz "Ligado às …" e a faixa "Aviso de instabilidade ligado no telefone do <time>" aparece para o atendente, em outra tela, sem o botão; o gerente desliga pela faixa e ela some sem recarregar | `[P0]` | **PASS** (e2e, execução 36576512233, passos 5, 7 e 8; o prazo escolhido e as auditorias conferidos no banco) |
| J36.6 Com a faixa à vista, a TopBar gruda logo abaixo das faixas ao rolar, e o composer da Inbox fica inteiro na janela | `[P0]` | **PASS** (e2e, execução 36576512233, passos 6 e 7, medido por `getBoundingClientRect` com a faixa visível). A barra lateral, que também desconta as faixas, só em jsdom (`components/shell/Sidebar.faixas.test.tsx`) |
| J36.7 Ligação real, opção 1: o cliente ouve o menu, digita 1 e toca no time da opção 1 — com atendente livre, **ouve o som de chamando ("tu… tu…") enquanto o ramal toca, sem "aguarde" nem música**; o cartão diz "No menu X, digitou 1 e foi para o time Y" | `[P0]` | **FAIL medido em produção na 1.50.1** (menu → tecla 2 → Suporte Técnico: o atendente atendeu em 16 s, mas o cliente ouviu "Todos os nossos atendentes estão ocupados…" enquanto o ramal tocava) → consertado na 1.50.2 (DYD-52), em unidade (`lib/channels/telefonia/controle.test.ts`, bloco "o som de chamando na fila"); o SOM, pendente — prova na VPS depois do deploy |
| J36.8 Ligação real, opção 2: toca no time da opção 2, e a conversa passa a esse time — quem é só dele a enxerga | `[P0]` | pendente — prova na VPS; a conversa no time escolhido está provada no Postgres real, com o JWT de uma atendente só do time 2 (`tests/invariants/telefonia-repositorio-da-ura.test.ts`) |
| J36.9 Tecla errada: ouve a fala de tecla inválida (se houver) e o menu de novo; depois do terceiro toque do menu, o time padrão; o cartão diz "No menu X, digitou uma tecla que não existe e foi para o time padrão, Y" | `[P0]` | pendente — prova na VPS; a regra em `lib/telefonia/ura.test.ts`, o texto em `components/telefonia/CartaoDaLigacao.test.tsx` |
| J36.10 Sem tecla: o menu repete e a ligação vai ao time padrão; o cartão diz "No menu X, não digitou nada e foi para o time padrão, Y" | `[P0]` | pendente — prova na VPS |
| J36.11 Desligar no menu: vira perdida no time padrão; a Central diz "O cliente desligou no menu do telefone. Ligue de volta pela conversa." e o cartão, "Desligou no menu X, antes de escolher" | `[P1]` | pendente — prova na VPS |
| J36.12 Aviso de instabilidade ligado: o cliente ouve o aviso inteiro (tecla não interrompe) e segue para a fila; o cartão diz "Ouviu o aviso de instabilidade"; desligado, não ouve | `[P0]` | pendente — prova na VPS |
| J36.13 Fora do horário do time, com a fala pronta: ouve a fala e a ligação cai; o cartão diz "Ligação fora do horário", e a Central não recebe aviso. Sem a fala, a fila da fase 1 | `[P0]` | pendente — prova na VPS |
| J36.14 Ninguém livre: "aguarde" a cada ~40 s entre a música; em 2 min, "ninguém atendeu", e a Central diz "Ninguém do time X atendeu. Ligue de volta pela conversa." Com atendente livre que não atende: o som de chamando nas duas voltas e então "ninguém atendeu" — nunca o "aguarde" | `[P1]` | pendente — prova na VPS |
| J36.15 O "fora do horário" sugerido já traz o número do WhatsApp conectado da organização, e segue editável | `[P1]` | em unidade (`components/connections/telefone/VozEFalas.test.tsx`); pela tela, pendente |
| J36.16 Fala que não toca (sem arquivo no disco nem no Storage): a ligação segue sem ela, o menu que não toca vai ao time padrão, e a Central recebe "Uma fala do telefone não tocou", com "Revisar as falas do telefone" | `[P1]` | em unidade (`lib/channels/telefonia/controle.test.ts`) e no Postgres real; pela tela, pendente |
| J36.17 O aviso vence no prazo: desliga sozinho na passada de 60 s, audita `phone.emergency_expired`, e a Central diz "O aviso de instabilidade do telefone desligou sozinho", com "Abrir os times" | `[P1]` | no Postgres real (`tests/invariants/telefonia-repositorio-da-ura.test.ts`) e em `lib/channels/telefonia/laco.test.ts`; pela tela, pendente |
| J36.18 Menu cujo time padrão foi arquivado: quem cai nele segue a fila e acaba perdido, e a Central diz "Menu do telefone manda para time arquivado", com "Revisar os menus do telefone" | `[P1]` | em unidade (`lib/channels/telefonia/controle.test.ts`); pela tela, pendente |

**Achados desta execução, já consertados** (cada um no commit citado):

1. **`tests/unit/branding.test.ts` ficou vermelho das Tasks 12/13 à revisão da 20.** O caminho
   das falas era `/var/lib/deskcomm/falas` — o nome do produto no código, no `docker inspect` e
   no endereço que a ARI manda tocar numa instalação de marca própria — e nenhum gate escolhido
   pelas tasks rodava essa cerca; só a suíte inteira a pegou. Passou a `/var/lib/telefonia/falas`
   nos quatro lugares juntos (`1f848e4d`), e `tests/unit/telefonia-falas-no-volume.test.ts`
   reprova trocar de um lado só. É o "gate escolhido não é suíte" do `CLAUDE.md`, pago de novo.
2. **A faixa do aviso não se recuperava quando a primeira leitura falhava**: o relógio de 60 s
   dependia do dado lido e o `apiClient` não repete 500/504 — o atendente com a aba em foco o
   dia inteiro nunca via a faixa (`6709c5c3`). E um 401 passageiro da Auth a apagava em toda aba
   até recarregar (`98226eb6`).
3. **O custo da leitura por minuto.** A faixa roda em toda tela e relê a cada minuto em cada
   aba; para gerente e admin, cada leitura montava a lista completa (duas consultas) e pedia à
   Auth o nome de quem ligou — centenas de chamadas por hora justamente durante uma
   instabilidade. A faixa passou a ler `?so=ligados` (`281ab3a3`).
4. **As faixas do topo cobriam a TopBar ao rolar e empurravam o composer da Inbox para fora da
   dobra**; a barra lateral nascia com o rodapé cortado. A altura agora é publicada em
   `--altura-das-faixas` e descontada por quem gruda ou mede a janela (`ba1d3a22`, `1733fd4f`).
5. **Todo replay de `Idempotency-Key` virava 409 `idempotency_conflict`**, em toda rota que usa
   `comIdempotencia` (modelos de mensagem, menus e números do telefone): o hash gravado em
   `bytea` voltava do PostgREST em outro formato e nunca casava. Pego pela prova no Postgres real
   (`5726bb56`; `tests/invariants/idempotencia-recibo-no-banco.test.ts`).
6. **O `apiClient` dormia o `Retry-After` inteiro antes de repetir** — com o limite de prévias,
   até uma hora com o botão girando. Acima de 10 s ele não espera nem repete (`9b7c481a`).
7. **"Falhou: HTTP 504", ou uma página HTML, diante do usuário**: o erro sem corpo estruturado
   virava frase. Sai como `ApiErrorSemCorpo`, e as telas da telefonia usam
   `mensagemDoServidor` (`218e29f8`).
8. **A conversa nascia no time padrão e ficava lá**: com a visibilidade por time (0281), o time
   escolhido no menu não enxergava a conversa do "Ligar de volta" (`16bc1cf1`).
9. **Quem desligou no menu recebia "Ninguém do time X atendeu"** — ninguém chegou a tocar
   (`e6fddb63`).

**Achado em produção, depois da 1.50.1 (DYD-52):**

10. **Com atendente livre, o cliente ouvia "todos ocupados" enquanto o ramal tocava.** Ligação
    real, menu → tecla 2 → Suporte Técnico: o atendente atendeu em 16 s, e o cliente ouviu o
    "aguarde" ("Todos os nossos atendentes estão ocupados…") e a música durante o toque. A fila
    segurava na linha toda ligação já atendida pela rede — e a URA sempre atende —, com gente
    livre ou não. Consertado na 1.50.2: com atendente sendo chamado, o som de chamando (o tom
    `ring` da zona `br`, em banda); o "aguarde" só sem ninguém livre. O teste do controlador que
    dizia "depois do aviso, quem espera o ramal ouve o 'aguarde'" afirmava o defeito e mudou junto.

**Não medido:** a qualidade da voz no celular do cliente (G.711 da operadora); a tecla em
outras operadoras além da da Totus (RFC 4733, medido no passo zero B do plano); o cliente que
digita durante o aviso em aparelho que manda a tecla dentro do áudio; o fim da fala quando o
cliente desliga chegar como `PlaybackFinished` `failed` (lido no código do Asterisk); se a
música de espera recomeça do início a cada "aguarde"; a limpeza do Storage numa VPS real. Do
som de chamando (1.50.2), tudo o que é áudio: o tom no canal do cliente da operadora, sem
soluço de um ramal ao próximo, e a ponte se formando depois de ele parar — só na VPS.

## J37 — Gravação das ligações: o aviso, o cartão com a gravação e a escuta auditada `[P0]` (2026-09-29)

Pedido do dono (DYD-53, F3 da spec 20): toda ligação atendida pode ser gravada e ouvida pelo
cartão da ligação, dentro da conversa, para análise de atendimento — e transcrita no futuro
(F4). Desenho, com as decisões D1–D8 tomadas numa sessão autônoma (o dono dormindo), em
`docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md`; plano em
`docs/superpowers/plans/2026-09-29-telefonia-gravacao-das-ligacoes.md`; mapa em
`docs/architecture/telefonia.architecture.json` (peças `gravacoes`, `rota_escuta`,
`poda_gravacoes`…); migration 0289.

`[P0]` porque gravar é dado sensível (LGPD) e porque o primeiro contato de quem liga passa a
ser o aviso de gravação.

**Como é provado.** A máquina (aviso depois do menu e antes dos toques, ponte gravada só com o aviso ouvido,
feita gravando no ANSWER, parar no fim) em `lib/channels/telefonia/controle.test.ts` (bloco
"gravação das ligações"); o processamento (ARI → ffmpeg → Storage → anexar → apagar, e cada
falha) em `lib/channels/telefonia/gravacoes.test.ts`; o SQL no Postgres real em
`tests/invariants/telefonia-gravacao.test.ts` (projeção mesclada, anonimização apagando o
arquivo, retenção); as rotas e a tela em unidade. A API da ARI usada para gravar foi MEDIDA na
VPS de produção em 2026-09-29, numa ponte de sonda sem ligação (gravar → parar → baixar o WAV
→ apagar). A ligação real depende de o dono gerar o aviso e ligar a gravação.

| Caso | Prioridade | Resultado |
|---|---|---|
| J37.1 Conexões › Telefone › Gravação sem o aviso pronto: diz o porquê, aponta Voz e falas, e o interruptor não liga; a rota recusa com 409 do mesmo jeito | `[P0]` | em unidade (`components/connections/telefone/GravacaoDasLigacoes.test.tsx`, `app/api/v1/telefonia/gravacao/route.test.ts`); pela tela, pendente (e2e) |
| J37.2 O admin gera e salva o "Aviso de gravação" em Voz e falas; a aba Gravação passa a mostrá-lo com "Ouvir" e liga; a auditoria registra `phone.recording_settings_changed` | `[P0]` | em unidade; pela tela, pendente |
| J37.3 Ligação real recebida com a gravação ligada: o cliente escolhe no menu e ouve o aviso logo antes de o atendente ser chamado (até 30/09/2026 era antes do menu); o atendente atende; ao desligar, o cartão diz "Preparando a gravação…" e, em segundos, "Ouvir a gravação (m:ss)" | `[P0]` | provada em 30/09/2026 com o aviso ainda ANTES do menu (ligação do dono, atendida às 19:40 UTC, MP3 de 129 KB guardado 2 s após o fim); a nova ordem falta provar na VPS |
| J37.4 O atendente (papel agent, que enxerga a conversa) clica em Ouvir: o player toca; a auditoria ganha UMA linha `phone.recording_listened` | `[P0]` | em unidade (rota e cartão); pela tela, pendente |
| J37.5 Ligação feita pelo atendente: os dois ouvem o aviso quando o cliente atende, e a gravação começa com ele | `[P0]` | pendente — prova na VPS |
| J37.6 Aviso sem arquivo: a ligação segue sem gravar, e a Central recebe "Uma fala do telefone não tocou" | `[P1]` | em unidade (`controle.test.ts`) |
| J37.7 Número oculto (sem conversa): nem toca o aviso nem grava | `[P1]` | em unidade (`controle.test.ts`) |
| J37.8 Gravação que não chega ao Storage em 30 min: o cartão diz "não foi salva" e a Central abre "A gravação de uma ligação não foi salva", com "Abrir a gravação do telefone" | `[P1]` | em unidade (`gravacoes.test.ts`) e no Postgres real |
| J37.9 A rota genérica de mídia não serve a gravação (sem auditoria) | `[P0]` | em unidade (`app/api/v1/messages/[id]/media/route.test.ts`) |
| J37.10 Viewer, ou quem não enxerga a conversa (outro time), não ouve: sem botão, e a rota responde 403/404 | `[P0]` | em unidade (rota com RLS dublada; `CartaoDaLigacao.test.tsx`); a RLS de verdade é a das mensagens, já provada no Postgres real (0281/0283) |
| J37.11 Anonimizar o contato apaga a gravação (fila de remoção do Storage) e limpa o cartão | `[P0]` | no Postgres real (`tests/invariants/telefonia-gravacao.test.ts`) |
| J37.12 Passada a retenção, a poda diária apaga o arquivo e o cartão diz "Gravação apagada pelo prazo de guarda"; Storage fora não marca nada | `[P1]` | no Postgres real e em `lib/telefonia/poda-das-gravacoes.test.ts` |

## J38 — Transferência de ligação e ramais `[P0]` (2026-09-30)

Pedido do dono (DYD-10, fase 2, versões 2 e 3): transferir a ligação para um colega ou para
um time, direto ou "falando antes", e ramais para os atendentes ligarem entre si e para o
cliente digitar na URA. Decisões D9–D11 e D16–D23 na emenda §12 de
`docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`; plano
em `docs/superpowers/plans/2026-09-30-telefonia-v2-v3-transferencia-e-ramais.md`; mapa em
`docs/architecture/telefonia.architecture.json` (peças `transferencia`, `rota_transferir`,
`rota_diretorio`, `aba_ramais`…); migrations 0290 e 0291.

`[P0]` porque é o cliente no meio: uma transferência que se perde é um cliente que desliga sem
atendimento.

**Como é provado.** A máquina da transferência (todos os caminhos de §12.2) em
`lib/channels/telefonia/transferencia.test.ts`; a interna e a URA com ramal em
`lib/channels/telefonia/ramais.test.ts`; a regra da URA em `lib/telefonia/ura.test.ts`; o que o
painel diz em `lib/telefonia/texto-da-transferencia.test.ts`; o SQL no Postgres real em
`tests/invariants/telefonia-transferencia.test.ts`, `telefonia-ramais.test.ts`,
`telefonia-repositorio-da-transferencia.test.ts`, `telefonia-pedido-de-transferencia.test.ts`
e `telefonia-ligacao-interna.test.ts`. **Nada disso passou pela VPS**: o formato do evento de
usuário da ARI não foi medido (sessão sem acesso à VPS), e nenhuma ligação real foi transferida.
O roteiro da prova é `docs/runbooks/telefonia-transferencia-e-ramais.md`.

| Caso | Prioridade | Resultado |
|---|---|---|
| J38.1 A atende uma recebida e clica Transferir: a busca mostra colegas com a situação (só disponível clicável) e times com os livres ou "fora do horário" | `[P0]` | em unidade (regras e rota); pela tela, pendente |
| J38.2 Direta para B: o cliente ouve música, B toca e vê "Transferida por A", atende e fica com a ligação e a conversa | `[P0]` | em unidade (`transferencia.test.ts`); na VPS, pendente |
| J38.3 B não atende: o cliente volta para A ("B não atendeu, o cliente voltou"); A também não → a fila do time, sem A no rodízio | `[P0]` | em unidade; na VPS, pendente |
| J38.4 Ninguém do time pega: "ninguém atendeu" e "Ligar de volta" na Central para o time; o cartão diz que a ligação foi atendida | `[P0]` | em unidade; na VPS, pendente |
| J38.5 Falar antes: A fala com B com o cliente em espera; Completar passa o cliente a B; Voltar ao cliente devolve a A | `[P0]` | em unidade; na VPS, pendente |
| J38.6 A desliga no meio da consulta: com B na linha completa; com B tocando vira direta | `[P1]` | em unidade |
| J38.7 O cliente desliga no meio: tudo encerra, `cancelled` | `[P1]` | em unidade |
| J38.8 Destino que ficou indisponível entre a tela e o worker: recusa com o motivo no painel | `[P1]` | em unidade e no Postgres real |
| J38.9 Ligação feita também é transferida | `[P1]` | em unidade |
| J38.10 Todo atendente ganha ramal a partir de 201; quem vira viewer ou é removido libera o número | `[P0]` | no Postgres real (gatilho, backfill, corrida de duas admissões) |
| J38.11 "Seu ramal: 201" no discador; digitar 202 ou o nome liga para o colega (ligação interna, sem operadora, sem conversa) | `[P0]` | em unidade (discador, rota e worker); na VPS, pendente |
| J38.12 Admin troca o ramal em Conexões › Telefone › Ramais; número de outra pessoa → "Esse ramal já é de outra pessoa." | `[P1]` | no Postgres real; pela tela, pendente |
| J38.13 Menu com "O cliente pode digitar o ramal": digitar 202 toca direto em B; B não atende → a fila do time padrão; ramal inexistente → tecla inválida | `[P0]` | em unidade; na VPS, pendente (só o …9197 manda tecla) |


## J39 — Quem pede um atendente entra na fila do setor certo `[P0]` (2026-10-02)

Achado em produção (protocolo 20261002000072): um lead chegou do site de comparação de planos com
o texto pronto "…quero falar com um atendente…", plano e endereço já escolhidos, e foi entregue a
um atendente do Suporte. O desvio determinístico de pedido de humano passava a conversa **sem
time**, e o rodízio a entregava a qualquer atendente disponível. Medido em 7 dias: 20 passagens
por esse desvio, 16 com troca manual de time (contra 29 em 116 quando quem passa é a IA). Desenho
em `docs/superpowers/specs/2026-10-02-pedido-de-humano-escolhe-o-setor-design.md`; peça
`setorDoPedido` em `docs/architecture/escalacao-ciclo-humano.architecture.json`.

`[P0]` porque é a primeira mensagem de um interessado em contratar: cair no setor errado é esperar
uma transferência antes de ser atendido.

**Como é provado.** As duas vias do classificador (o Jev e o modelo de reserva) em
`lib/agent-engine/agent/setor-do-pedido.test.ts`; a passagem em
`lib/agent-engine/agent/human-handoff.test.ts`; o turno inteiro no Postgres real em
`tests/invariants/pedido-de-humano-escolhe-o-setor.test.ts`. A qualidade da escolha foi medida com
conversas **sintéticas**: o Jev na VPS de produção e três modelos de reserva (tabela na spec).
**Não passou pela tela nem por uma conversa real**: o chip do time na conversa e o aviso da Central
com "Setor escolhido automaticamente" só foram conferidos no banco.

| Caso | Prioridade | Resultado |
|---|---|---|
| J39.1 Texto pronto com plano e endereço + "quero falar com um atendente" → conversa na fila do Comercial | `[P0]` | no Postgres real (Jev e modelo de mentira); 8/8 no Jev real e em cada modelo de reserva; pela tela, pendente |
| J39.2 O setor é escolhido ANTES de a passagem começar — nenhuma chamada de IA com a conversa fora da IA e sem time | `[P0]` | no Postgres real |
| J39.3 Jev fora do ar → o modelo de reserva escolhe; os dois fora do ar → a passagem acontece inteira, na fila geral | `[P0]` | no Postgres real e em unidade |
| J39.4 "Quero falar com um atendente" sem pista do assunto → fila geral | `[P1]` | no Jev real e nos modelos reais (sintético) |
| J39.5 Organização sem times → nenhuma chamada, nem ao Jev | `[P1]` | no Postgres real |
| J39.6 A Central diz "Setor escolhido automaticamente: <time>" | `[P1]` | no Postgres real; pela tela, pendente |
| J39.7 Suspeita de opt-out não escolhe setor | `[P1]` | no Postgres real |
| J39.8 A chamada aparece em IA › Execuções (`llm_calls`, ponto `handoff_team_classify`) | `[P1]` | no Postgres real; pela tela, pendente |

## J40 — Chamar de novo quem teve o atendimento encerrado `[P0]` (2026-10-05)

Relato de uma atendente: chamou um cliente em 25/09, encerrou, e em 01/10 quis chamá-lo de novo.
"Abriu no mesmo atendimento do dia 25/09 já finalizado. Não iniciou um novo atendimento."

`[P0]` porque a operação é de telecom, onde **cada atendimento precisa do seu protocolo**: o contato
de 01/10 ficou registrado com o protocolo de 25/09.

### O que foi medido, em produção, só leitura (2026-10-05)

A conversa do relato: **um** atendimento (`20260925000092`) cobrindo os dois dias. Em 01/10 saiu um
modelo com a conversa **encerrada** (09:15), e três minutos depois veio um "Reabrir" — que, por
desenho, continua o mesmo atendimento.

A causa não era o banco. A tela decidia entre "Abrir conversa no Inbox" e "Chamar no WhatsApp" pela
**existência** da conversa, e a conversa é permanente (uma por contato × número; o que abre e fecha
é o atendimento, desde a 0266). Para quem já tinha sido atendido, o diálogo de chamar simplesmente
não aparecia, e a conversa encerrada só oferecia gestos que escrevem no atendimento antigo.

| Medida | Valor |
|---|---|
| Contatos com conversa cuja mais recente está encerrada (o ícone só levava para ela) | 692 de 741 |
| Mensagens enviadas por pessoa com a conversa encerrada, desde 19/09 | 53, em 48 conversas |
| …seguidas de "Reabrir" (mesmo protocolo de dias atrás) | 32 |
| …que ficaram dentro do atendimento encerrado, com a conversa ainda "Fechada" | 13 |
| …em que o cliente respondeu e a resposta abriu atendimento sem time e sem dono | 8 |

**A primeira hipótese estava errada, e foi um teste que disse.** Lendo `fn_conversation_iniciar_no_time`
parecia que o dono gravado na conversa encerrada (502 das 735 guardam) barraria quem chamasse de
novo. O invariante escrito para reproduzir isso ficou **verde na primeira corrida**:
`fn_service_stamp_status`, um gatilho BEFORE que a leitura não tinha alcançado, solta o dono ao sair
do estado encerrado. O servidor sempre fez o certo — atendimento novo, protocolo novo, dono = quem
chamou. Nenhuma migration; o conserto é levar a tela até lá.

### O conserto

`lib/atendimento/conversa-do-contato.ts` (`portaDaConversa`): a conversa anexada ao contato passa a
levar o **estado**, e três telas leem a mesma régua —

- **Contatos**: atendimento encerrado → o ícone abre "Chamar no WhatsApp";
- **ficha do contato e do negócio**: oferece chamar **e** mantém o caminho para o histórico;
- **Inbox, conversa encerrada**: no lugar do seletor de modelo, o pé oferece o atendimento novo
  (`NovoAtendimentoAviso`). "Reabrir" segue existindo, e agora diz que mantém o protocolo.

O diálogo ganhou três coisas: sai por padrão pelo **número da conversa anterior**, avisa que vai
nascer um atendimento novo, e, de dentro do Inbox, devolve a conversa para a tela em vez de navegar.

### Casos

Spec: `tests/e2e/chamar-o-cliente-primeiro.spec.ts` (bloco "chamar DE NOVO…"), em `SPECS_PARTE_3`.

### Execução (2026-10-05): **PASS nos 4 casos de tela**

`e2e` no CI por `Run workflow` na branch (run 37300989838), Chromium real, Supabase local com o
`baseline.sql`, app em produção (`next build` + `next start`). Parte 3: **119 passed, 1 failed
(30,0 min)**; os 14 casos desta spec, verdes.

As duas falhas da execução **não são desta mudança** — são as mesmas da `main` no commit anterior
(run 37298729122, 749af777): `card-pelo-classificador.spec.ts:354` na parte 1 e
`inbox-rotulo-de-origem.spec.ts:224` na parte 3. A parte 3 tinha 115 verdes na `main`; aqui tem
119, que são os 4 casos novos.

| Caso | Prioridade | Resultado |
|---|---|---|
| J40.1 Contato com atendimento encerrado: na lista, o ícone é **Chamar no WhatsApp** (não há link para a conversa antiga); o diálogo avisa do atendimento novo; enviado, a MESMA conversa sai do encerrado com **protocolo diferente** e dono = quem chamou | `[P0]` | **PASS** (34,1 s) |
| J40.2 Dentro da conversa encerrada, o pé diz que o atendimento acabou e oferece chamar; enviado, a tela sai do "Fechada" **sem recarregar** e o protocolo muda | `[P0]` | **PASS** (30,7 s) |
| J40.3 A ficha do contato oferece começar de novo e mantém "Ver a conversa no Inbox" | `[P1]` | **PASS** (27,2 s) |
| J40.4 Controle: com o atendimento **em andamento**, a lista continua levando para a conversa e não oferece chamar | `[P0]` | **PASS** (29,8 s) |
| J40.5 No banco: outra pessoa chama → atendimento novo, protocolo novo, ela fica dona, e o encerrado guarda quem o atendeu; a mesma pessoa chama → `claimed` com o automático calado; em andamento com outra pessoa → recusado; "Reabrir" → mesmo protocolo | `[P0]` | **PASS** no Postgres real (`tests/invariants/chamar-de-novo-abre-atendimento-novo.test.ts`, 4 casos) |

**Os testes vigiam de verdade, provado por sabotagem.** No banco: fazer o gatilho deixar de soltar o
dono, e fazer a saída do encerrado continuar o atendimento, reprovam cada um os 2 casos de
"atendimento novo" e deixam os 2 controles verdes. Na tela: os casos de "encerrado" foram escritos
antes do conserto e reprovaram contra o código antigo (5 vermelhos), com os controles de "em
andamento" verdes.

**Uma fraqueza da spec, declarada.** J40.1 e J40.2 só exercitam o envio pelo diálogo quando o canal
aceita texto livre; num canal que só aceita modelo elas anotam `nao-medido` e terminam **verdes**, e
o relator do CI não imprime a anotação. Que o envio rodou nesta execução é **inferência**, não
observação: a rota lista as conexões por `created_at`, e a primeira do ambiente é a do seed do
workflow, de texto livre. Trocar a anotação por `test.skip` faria a diferença aparecer no relatório.

**Não medido.** Envio real pela plataforma oficial (a spec usa o canal de texto livre do ambiente);
o caso de **dois números** pela tela — o número padrão do diálogo está preso só em unidade
(`components/contacts/ChamarNoWhatsAppDialog.de-novo.test.tsx`); e o quadro (Kanban), cujo card
continua levando para a conversa — o caminho de chamar ali é a ficha do negócio.

**O que NÃO mudou, de propósito.** `POST /api/v1/messages` segue aceitando envio para conversa
encerrada: é a porta de integrações por token, e recusar ali mudaria contrato de API. Quem deixou
de oferecer esse envio foi a tela.

## J41 — Encerrar o atendimento com assunto e resumo `[P0]` (2026-10-05)

Pedido do dono do produto: encerrar uma conversa era um `confirm()` do navegador, e o atendimento
fechava sem dizer do que tratou. Faltavam os números ("quais assuntos geram mais atendimento, no
dia e no mês") e o histórico do cliente listava protocolos mudos.

`[P0]` porque fechar é o gesto que todo atendente faz dezenas de vezes por dia: uma janela que
trava, que perde o texto ou que cobra o que já foi registrado é atrito em toda a operação.

### O que foi medido, em produção, só leitura (2026-10-05, 14 dias)

| Medida | Valor |
|---|---|
| Atendimentos encerrados | 1.063 — entre 110 e 165 por dia útil |
| Encerrados por pessoa (e não pelo sistema) | 1.063, por 15 pessoas |
| Encerrados **sem time** | 336 (32%) |
| Times ativos | 6 |

O terço sem time decidiu o desenho: o assunto é cadastrado **por time**, mas a janela deixa escolher
o **setor do assunto** na hora — e essa escolha não transfere a conversa.

### O desenho, em quatro linhas

- o registro mora no **atendimento** (`atendimentos.assunto_id` e `closure_summary`), não na conversa;
- a regra ("exigir o assunto", "exigir o resumo") é **da organização** e é aplicada no **banco**,
  por `fn_atendimento_encerrar` — a mesma função para o botão, o atalho e a API;
- os dois interruptores **nascem desligados**: quem atualiza ganha a janela e nenhum bloqueio;
- o resumo é texto sobre o cliente: não vai para evento nem para auditoria, e é zerado na anonimização.

Desenho completo: `docs/superpowers/specs/2026-10-05-janela-de-encerramento-design.md`.

### Casos

Spec: `tests/e2e/encerrar-com-assunto-e-resumo.spec.ts`, em `SPECS_PARTE_3`.

| Caso | Prioridade | Onde está provado |
|---|---|---|
| J41.1 Gerente cadastra assuntos por time; nome repetido é recusado com frase; arquivar tira da lista e deixa à vista | `[P0]` | pela tela (spec) e no Postgres real |
| J41.2 Ligar os dois interruptores e recarregar: continuam ligados | `[P0]` | pela tela (spec) |
| J41.3 "Fechar" abre a janela — nenhum diálogo nativo do navegador em toda a jornada | `[P0]` | pela tela (spec) |
| J41.4 Em branco, com a exigência ligada: a janela marca os dois campos e o atendimento **segue aberto** | `[P0]` | pela tela (spec) e no Postgres real |
| J41.5 Conversa sem time: escolhe o setor, o assunto arquivado não é oferecido, e a conversa **não** muda de time | `[P0]` | pela tela (spec) e no Postgres real |
| J41.6 O registro aparece na ficha, na linha do tempo (sem o resumo), em "Atendimentos anteriores" e na aba Fechadas | `[P0]` | pela tela (spec) |
| J41.7 "Reabrir" e "Fechar" de novo: a janela volta preenchida | `[P0]` | pela tela (spec), em componente e no Postgres real |
| J41.8 Métricas conta o assunto no setor dele | `[P1]` | pela tela (spec), em unidade e no Postgres real |
| J41.9 Assunto de outra organização, arquivado ou de time arquivado é recusado | `[P0]` | no Postgres real |
| J41.10 "Exigir o assunto" sem nenhum assunto cadastrado não trava o encerramento | `[P0]` | no Postgres real e em componente |
| J41.11 Quem chega depois de a conversa já estar fechada não sobrescreve o registro | `[P1]` | no Postgres real |
| J41.12 Anonimizar o contato zera o resumo e preserva o assunto | `[P0]` | no Postgres real |
| J41.13 Conversa de grupo (sem atendimento) fecha só com a confirmação | `[P1]` | no Postgres real e em componente |
| J41.14 A janela cabe na tela em 1440×1000, medido por `boundingBox` | `[P1]` | pela tela (spec) |

"No Postgres real" = `tests/invariants/encerramento-com-assunto-e-resumo.test.ts`, que roda no job
`invariants` contra o `baseline.sql`.

### Execução (2026-10-05): **PASS na jornada pela tela**

`e2e` no CI por `Run workflow` na branch, Chromium real, Supabase local com o `baseline.sql`, app em
produção (`next build` + `next start`). Três execuções, porque a entrega mudou duas vezes depois da
primeira:

| Execução | Commit | Esta spec | Parte 3 |
|---|---|---|---|
| 37352262599 | `b388043e` (antes da revisão) | verde, 24,3 s | 119 passaram, 2 falharam |
| 37356123390 | `fdd13cad` (com as correções da revisão) | verde, 33,1 s | 119 passaram, 2 falharam |
| 37362113350 | `26263afc` (versão final) | verde, 30,4 s | **120 passaram, 1 falhou** |

A falha a mais das duas primeiras era **desta mudança**: `encerramento-atendimento.spec.ts` fecha a
conversa uma terceira vez com a tela em espanhol (botão "Cerrar"), e esse clique dependia do
handler de diálogo nativo que saiu junto com o `confirm()`. A troca que adaptou as specs antigas
procurou só por "Fechar". Corrigida no `26263afc`, que também confere o título traduzido da janela.

As falhas que sobram na versão final **não são desta mudança** — são as mesmas do último `e2e` da
`main` (run 37306934272, `33b8595d`): `card-pelo-classificador.spec.ts:354` na parte 1 e
`inbox-rotulo-de-origem.spec.ts:224` na parte 3. A parte 2 passou inteira (103).

No job `invariants` (Postgres real, `baseline.sql` em modo install e update):
`tests/invariants/encerramento-com-assunto-e-resumo.test.ts` verde — 29 casos na primeira execução,
e os três acrescentados pela revisão (quebra de linha não conta como letra, resumo em branco apaga,
contato anonimizado não ganha resumo) na seguinte.

**O que a revisão independente achou e os testes não tinham pegado.** Um subagente leu o diff sem as
conclusões de quem escreveu. Com typecheck, lint, 681 arquivos de unidade e os 29 invariantes verdes,
ele apontou que a janela não fixava o atendimento em que foi aberta: o `confirm()` era síncrono, a
janela fica aberta enquanto alguém escreve, e se nesse intervalo um colega encerrasse e o cliente
voltasse, o clique gravaria o resumo do atendimento antigo no novo. Hoje a janela guarda o
protocolo da abertura e não envia se o vigente mudou (`EncerrarAtendimentoDialog.test.tsx`, bloco
"a janela fecha o atendimento em que foi aberta, ou nenhum").

### O que NÃO foi provado

- A corrida "outro atendente encerra e o cliente volta com a janela aberta" está presa em teste de
  componente, não em navegador com duas sessões.
- Com uma pessoa logada na instalação de produção: pendente (depende de atualizar a VPS, cadastrar
  os assuntos e ligar os interruptores).
- A troca de setor pelo seletor, em componente: o `Select` não abre de forma confiável no jsdom. Está
  coberta pela spec, no navegador de verdade.

## J42 — A ligação feita sem resposta diz quanto chamou e quem encerrou `[P1]` (2026-10-06)

Pedido do dono: quando o atendente liga e ninguém atende, a conversa ganhava o selo vermelho
"Ligação sem resposta" — o mesmo para quem deixou o telefone do cliente chamar até a rede
desistir e para quem deu um toque e desligou. O toque servia de "tentei ligar". A saída que ele
tinha achado era mandar a equipe deixar chamar até cair na caixa postal, que vira "Ligação feita"
com gravação; ela depende de o cliente ter caixa postal, custa uma ligação completada na operadora
e conta como ligação atendida.

O selo passa a dizer quem ligou, e a linha de baixo, quanto o telefone chamou e quem encerrou.
Migration 0294 (`voice_calls.peer_ringing_at`); spec 20 §4.2 item 6; mapa em
`docs/architecture/telefonia.architecture.json` (aresta `fim_da_saida → inbox`).

**Como é provado.** A regra pura (motivo + tempo → o que o cartão conta) em
`lib/telefonia/fim-da-saida.test.ts`; a medida do tempo pelo controlador, com relógio de mentira,
em `lib/channels/telefonia/controle.test.ts` (bloco "o tempo que o telefone do cliente chamou"); o
SQL no Postgres real, com duas organizações, em
`tests/invariants/telefonia-primeiro-toque-da-saida.test.ts`; o texto do cartão, em português e
espanhol, em `components/telefonia/CartaoDaLigacao.test.tsx`; e a tela, com as duas ligações
semeadas como o worker as deixa, em `tests/e2e/telefonia-gravacao.spec.ts`.

| Caso | Prioridade | Resultado |
|---|---|---|
| J42.1 O atendente liga, o telefone chama 4 s e ele desliga: na conversa, "Ligação sem resposta · por Bruno" e, embaixo, "Chamou 4 s · desligada por quem ligou" | `[P1]` | em unidade, no Postgres real e pela tela (e2e, ligação semeada) |
| J42.2 O atendente deixa chamar até a rede desistir: "Chamou 38 s · ninguém atendeu" | `[P1]` | em unidade, no Postgres real e pela tela (e2e, ligação semeada) |
| J42.3 A rede repete o 180 e manda 183 depois: o tempo conta do PRIMEIRO toque | `[P1]` | em unidade (`controle.test.ts`) |
| J42.4 O atendente desliga sem a rede avisar que o telefone chamava: "Desligada por quem ligou após 40 s" (a tentativa, do clique ao fim) — nunca um tempo de toque que ninguém mediu | `[P1]` | em unidade, no Postgres real e pela tela (e2e, ligação semeada) |
| J42.5 Número ocupado: "O número estava ocupado" | `[P2]` | em unidade |
| J42.6 Ligação de antes da 0294 (sem o tempo no registro): o selo ganha o nome de quem ligou e a linha diz só quem encerrou | `[P1]` | em unidade (`CartaoDaLigacao.test.tsx`) |
| J42.7 A não completada, a atendida e a recebida ficam como eram | `[P1]` | em unidade e pela tela (a atendida, no mesmo e2e) |
| J42.8 O agent não forja o toque pela REST: a linha do telefone é só-leitura, e a do WaCalls recusa o instante (CHECK) | `[P0]` | no Postgres real, com o JWT do agent |
| J42.9 Ligação real pelo tronco da operadora: o tempo do cartão bate com o que o atendente ouviu chamar | `[P1]` | pendente — prova na VPS |
| J42.10 Uma mensagem comum com o metadado de ligação plantado pela REST não vira cartão: só o registro `ligacao:<id>`, que só o sistema escreve | `[P0]` | em unidade (`ligacaoDoRegistro`) e pela tela (e2e) |
| J42.11 O sistema falha antes de discar e o atendente desliga: "Ligação não completada", e não "desligada por quem ligou" | `[P1]` | em unidade (`controle.test.ts`) |
| J42.12 A ARI lenta no desmonte da ligação não infla o tempo de toque | `[P1]` | em unidade (`controle.test.ts`) |
| J42.13 A linha do WaCalls criada pela REST não serve de pedido de saída, e não quebra o fechamento | `[P0]` | no Postgres real |

### O que NÃO foi provado

- **Ligação real.** Em que instante a operadora manda o primeiro 180/183 em relação ao telefone
  do cliente tocar de fato não foi medido. Um 183 com anúncio da operadora ("fora da área de
  cobertura") conta como "chamou".
- **Caixa postal.** Para a rede ela é uma ligação atendida: segue virando "Ligação feita", com
  gravação. O sistema não separa pessoa de caixa postal.
- **A imagem da tela.** O e2e mede o texto e a altura de cada frase no navegador, mas o CI só guarda
  capturas quando falha.
- **A ligação recuperada depois de um reinício do worker no meio do toque** fecha como não atendida
  mesmo que o cliente tenha atendido depois (defeito anterior a esta mudança): o cartão sai
  "Ligação sem resposta · por <quem ligou>", sem a linha.

### O que a revisão independente achou

Um subagente leu o diff sem as conclusões de quem escreveu, com a suíte verde, e rodou o
controlador de verdade em cenários que os testes não tinham: (1) o tempo de toque era lido DEPOIS
do desmonte da ligação, e a ARI lenta o inflava (5 s viravam 21 s); (2) quando o próprio worker
falhava antes de discar, o registro saía "sem resposta · desligada por quem ligou"; (3) sem sinal
de toque da rede, quem esperou 40 s ficava igual a quem desligou em 1 s; (4) qualquer membro
plantava um cartão de ligação com uma mensagem comum pela REST (brecha anterior, que passou a
importar); (5) uma linha do WaCalls criada pela REST servia de pedido de saída, e o CHECK novo
quebraria o fechamento dela. Os cinco foram corrigidos antes do merge (casos J42.4 e J42.10–13).

## J43 — A conversa aparece enquanto a ligação acontece `[P0]` (2026-10-06)

Pedido do dono, na mesma conversa em que descreveu a fila do telefone: quando o atendente atende
uma ligação recebida, a conversa do cliente só ganhava o registro da ligação depois de desligar.
Durante a chamada ela não subia na lista (o desenho leu no código que a de cliente novo ficava no
fim; não foi medido na tela) e não havia onde escrever uma nota interna.

`[P0]` porque atender é o gesto central do telefone: o cartão que não entra, ou que entra duas
vezes, ou que fica "em andamento" para sempre, aparece na tela de todo atendente em toda ligação.

Quando o atendente atende, a conversa ganha o cartão "Ligação em andamento · com Ana · desde
14:32", sobe para o topo de Minhas e abre um atendimento onde cabe nota interna. Quando a ligação
acaba, o MESMO cartão vira "Ligação recebida", com a duração. Sem migration (`desfecho` e
`em_andamento` são texto dentro de `messages.metadata`). Desenho:
`docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md` (§4.1, com as emendas do
plano); plano: `docs/superpowers/plans/2026-10-06-telefonia-fila-visivel-entrega-1.md`; spec 20 §5;
mapa em `docs/architecture/telefonia.architecture.json` (arestas `controle → repositorio` e
`repositorio → t_messages`).

**Como é provado, e com que alcance.** São quatro camadas, e cada caso abaixo diz em quais está:

- **unit (dublês):** o controlador com o banco de mentira em `lib/channels/telefonia/controle.test.ts`
  (bloco "o cartão 'Ligação em andamento'") e `transferencia.test.ts`; a passada de 60 s em
  `laco.test.ts`; o texto em `lib/channels/telefonia/repositorio.test.ts`; a tela em
  `components/telefonia/CartaoDaLigacao.test.tsx`. Provam a ORDEM das chamadas e o texto, nunca o SQL.
- **invariante contra Postgres real:** `tests/invariants/telefonia-cartao-em-andamento.test.ts`
  (`pnpm test:db`, roda no job `invariants`), sempre com duas organizações e com os gatilhos de
  verdade da conversa e do atendimento. É onde está provado o SQL.
- **e2e semeado:** um caso novo em `tests/e2e/telefonia-gravacao.spec.ts`. A ligação e o cartão são
  semeados por SQL, como o worker os deixaria — o e2e prova a TELA (cartão, nota, troca no fim sem
  recarregar), não que o worker o escreva. Roda só no GitHub Actions (`Run workflow` na branch).
  **Executado em 2026-10-06 e verde** (run 37535999166, parte 3: o caso passou em 7,4 s; as duas
  falhas daquela execução — `card-pelo-classificador.spec.ts:354` e
  `inbox-rotulo-de-origem.spec.ts:224` — são as que já falham na `main`).
- **ligação real pelo tronco:** **NÃO PROVADO** em nenhum caso.

| Caso | Prioridade | Resultado |
|---|---|---|
| J43.1 O atendente atende a recebida: a conversa ganha o cartão "Ligação em andamento · com Ana · desde 14:32", com a prévia "Ligação em andamento com Ana" e a posição que a lista usa | `[P0]` | unit (dublês): o cartão entra DEPOIS da atribuição e com quem atendeu; o texto e o desenho do cartão, sem cor de perdida e sem duração. Invariante contra Postgres real: a mensagem, `last_message_at` e a prévia. e2e semeado (verde no GitHub Actions em 2026-10-06, run 37535999166). **O topo de Minhas não é assertado por teste nenhum** — é a ordenação por `last_message_at`, que já existia. **NÃO PROVADO: ligação real pelo tronco** |
| J43.2 Durante a ligação o atendente escreve uma nota interna e ela aparece na conversa, abaixo do cartão | `[P0]` | e2e semeado (verde no GitHub Actions em 2026-10-06, run 37535999166). Invariante contra Postgres real: no caso de quem já ligou antes, o cartão nasce depois do início do atendimento novo (`service_started_at`). **NÃO PROVADO: ligação real pelo tronco** |
| J43.3 A ligação acaba: o MESMO cartão (uma mensagem só) vira "Ligação recebida · atendida por Ana", com a duração, sem recarregar a página | `[P0]` | Invariante contra Postgres real: uma mensagem só, sem `em_andamento`, duração gravada, o que outro escritor pôs no metadado continua, o fim reenviado não reescreve. unit (dublês): o mesmo registro desenhado como "Ligação recebida" com `1:05`. e2e semeado (a troca sem recarregar, pelo Realtime; verde no GitHub Actions em 2026-10-06, run 37535999166). **NÃO PROVADO: ligação real pelo tronco** |
| J43.4 Quem já ligou antes e teve a conversa encerrada: ao atender, a conversa reabre com atendimento e protocolo novos, o dono é quem atendeu, e o cartão nasce dentro do atendimento novo. O time da conversa NÃO muda (fica o do atendimento anterior), e nenhum evento de troca de time é gravado | `[P0]` | Invariante contra Postgres real (a atribuição e a abertura do cartão chamadas na ordem do controlador). unit (dublês): a ordem das duas chamadas. **NÃO PROVADO: ligação real pelo tronco** |
| J43.5 A ligação que ninguém atende continua como era: nenhum cartão em andamento, o registro "não atendida" entra no fim | `[P0]` | unit (dublês): sem cartão enquanto ninguém atende, e só o registro de perdida. Invariante contra Postgres real: a perdida é INSERIDA no fim. O aviso "Ligar de volta" na Central não foi tocado e não ganhou caso novo |
| J43.6 O cartão que ficou "em andamento" com a ligação já encerrada (o banco falhou entre fechar a ligação e completar o cartão) é fechado pela passada de 60 s | `[P1]` | Invariante contra Postgres real: fecha o de mais de um minuto em cada organização, deixa o recém-encerrado para o fim normal, e a segunda passada não acha nada. unit (dublês): a etapa roda e diz quantos; a que lança não derruba as outras |
| J43.7 Transferência: quem pega a ligação entra no cartão — o nome de quem está com ela troca, sem duplicar o cartão, e o setor que alguém mudou pela tela no meio da ligação fica | `[P1]` | unit (dublês): `transferencia.test.ts`. Invariante contra Postgres real: chamar de novo troca o nome, mantém uma mensagem e não mexe no time. **NÃO PROVADO: transferência real pelo tronco** |
| J43.8 Falhar ao abrir o cartão não derruba a ligação: a ponte se forma, a ligação segue e o fim registra como sempre | `[P0]` | unit (dublês) |
| J43.9 Número oculto (sem conversa) e ligação feita: atendem normalmente e não ganham cartão em andamento | `[P1]` | unit (dublês): o número oculto. Invariante contra Postgres real: o número oculto e a feita |
| J43.10 O cartão e o conserto respeitam a organização: pedir o cartão de outra organização não escreve nada em nenhuma | `[P0]` | Invariante contra Postgres real, com duas organizações |
| J43.11 A aba que não recarregou depois da atualização, com a ligação em curso, mostra "Ligação recebida" e nunca "Ligação perdida" em vermelho | `[P1]` | por construção (o `desfecho` do cartão em andamento já é `atendida`); **nenhum teste roda a tela de antes** |
| J43.12 Ligação real pelo tronco da operadora, com a conversa aberta na tela do atendente | `[P0]` | **NÃO PROVADO** — pendente, prova na VPS |

### O que NÃO foi provado

- **Ligação real pelo tronco.** Que o cartão entre no instante em que o atendente atende, que a
  conversa suba na lista de quem atendeu e que o fim complete o mesmo cartão não foi visto numa
  chamada de verdade, com contas `agent` (nunca só a do dono). Esta entrega ainda não está na `main`
nem foi publicada.
- **O worker pela tela.** O e2e (`telefonia-gravacao.spec.ts`) passou, mas ele semeia o cartão por
  SQL: prova a tela, não o worker.
- **A imagem da tela.** Nenhuma captura foi vista; o que se mediu foi texto, atributo e classe.
- **O topo de Minhas.** Nenhum teste olha a posição da conversa na lista com uma ligação em curso.
- **Ligação gravada.** O fim completa o cartão pelo mesmo `registrarNaConversa` que põe a projeção
  da gravação (J37), mas nenhum caso desta entrega cobre a combinação; os invariantes de gravação
  são a regressão do SQL do registro, a rodar no job `invariants`.
- **Dois consertos sem teste próprio.** O conserto do cartão órfão que não para no primeiro erro
  (uma ligação que não fecha não segura as outras) e a troca de atendente que não pisa uma prévia
  mais nova na conversa (só reescreve a prévia enquanto ela ainda é a do cartão) estão no código
  (`consertarCartoesOrfaos` e `abrirCartaoDaLigacao`, em `lib/channels/telefonia/repositorio.ts`),
  mas nenhum caso os exercita.

## J44 — A fila do telefone aparece no Inbox `[P0]` (2026-10-06)

Pedido do dono, na mesma conversa em que descreveu a fila do telefone: numa queda de internet muita
gente liga ao mesmo tempo, e quem coordena o atendimento não via quantos clientes esperavam, de que
time, nem por qual número — a fila só existia na memória do worker. A espera tinha um teto fixo de
2 minutos para todos os times, e a fila não seguia a ordem de chegada: quem pegava o atendente que
desocupava era a ligação cujo relógio de 5 s disparasse primeiro, não a que esperava há mais tempo
(o desenho leu isso no código; não foi medido numa ligação real).

`[P0]` porque a aba é a única janela para a fila do telefone e o teto é o que decide quem cai: uma
fila que a tela mostra errada, um "cai em" que mente, ou uma ligação mais nova passando na frente de
uma mais antiga aparece para todo atendente e para todo cliente que liga, no pico.

A aba "Telefone" entra no trilho do Inbox quando o telefone está ligado e a organização tem número:
quem espera (por ordem de chegada, com a posição e o "cai em"), quem ouve o menu, quem está em
ligação e as perdidas dos últimos 30 minutos. A fila do worker passa a atender por ordem de chegada,
e cada time ganha a sua espera máxima em Configurações › Times (padrão 2 minutos). Migration 0295
(`voice_calls.queued_at`, `voice_calls.queue_deadline_at`, `attendance_teams.phone_queue_max_wait_seconds`).
Desenho: `docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md` (§4.2, com as emendas);
plano: `docs/superpowers/plans/2026-10-06-telefonia-fila-visivel-entrega-2.md`; spec 20 §4.2, §5, §7 e §9;
mapa em `docs/architecture/telefonia.architecture.json` (nós `rota_fila`, `aba_telefone`, `rota_espera` e
`cartao_espera`; arestas `t_voice_calls → rota_fila → aba_telefone` e `rota_espera → t_times`).

**Como é provado, e com que alcance.** São cinco camadas, e cada caso abaixo diz em quais está:

- **unit (dublês):** o controlador com o banco e a ARI de mentira, em
  `lib/channels/telefonia/controle.test.ts` (bloco "a fila visível (0295)"); as funções puras em
  `lib/telefonia/distribuicao.test.ts` (`esperaMaximaMs`, `eAVezDela`) e `lib/telefonia/fila.test.ts`
  (fase, motivo, posição, resumo, relógio, urgência). Provam a ORDEM das chamadas e as regras, nunca o SQL
  nem o tempo real.
- **teste de rota:** `app/api/v1/telefonia/fila/route.test.ts` (papel, telefonia desligada, organização da
  sessão, a leitura compartilhada em voo único — quem chega durante uma leitura recebe a próxima —, a que falha) e
  `app/api/v1/telefonia/fila/times/route.test.ts` e `app/api/v1/telefonia/fila/times/[teamId]/route.test.ts`
  (papel `manager`, suporte somente-leitura, cada recusa, a auditoria). O banco e a sessão são dublês.
- **teste de componente:** `components/telefonia/fila/FilaDoTelefone.test.tsx`, `LinhaDaFila.test.tsx` e
  `ChipsDaFila.test.tsx`; `components/inbox/InboxLayout.telefone.test.tsx`;
  `tests/unit/inbox-filters-scope.test.tsx` (o trilho e `visibleInboxTabs`);
  `hooks/telefonia/useFilaDoTelefone.test.tsx` (o canal do Realtime é dublê);
  `components/telefonia/EsperaMaximaDoTime.test.tsx`. Medem texto, atributo e classe, com relógio falso.
- **invariante contra Postgres real:** `tests/invariants/telefonia-fila-visivel-schema.test.ts` (colunas,
  CHECKs, índices, a REST que não escreve, a autocura do bloco do baseline e a cadeia de migrations),
  `tests/invariants/telefonia-fila-visivel-repositorio.test.ts` (o SQL do worker),
  `tests/invariants/telefonia-fila-da-tela.test.ts` (a leitura da aba) e
  `tests/invariants/telefonia-espera-do-time.test.ts` (o SQL do teto), sempre com duas organizações
  (`pnpm test:db`, roda no job `invariants`). É onde está provado o SQL.
- **e2e semeado:** `tests/e2e/telefonia-fila.spec.ts` (três casos: a aba com a fila cheia, por ordem
  de chegada, que anda sem recarregar; o gerente trocando a espera máxima do time; a organização sem
  número, sem a aba). As ligações são semeadas por SQL, como o worker as deixaria — prova a TELA e a
  rota, não o worker. Roda só no GitHub Actions (parte 3), e as capturas sobem no artefato
  `evidencia-telefonia-fila`. Para saber se já rodou e como terminou:
  `gh run list --workflow e2e.yml --branch main --limit 3`.
- **ligação real pelo tronco:** **NÃO PROVADO** em nenhum caso.

| Caso | Prioridade | Resultado |
|---|---|---|
| J44.1 A aba "Telefone" aparece no trilho quando o telefone está ligado e a organização tem número — para `viewer`, `agent`, `manager` e `admin`, inclusive quem não tem ramal — e some sem telefone | `[P0]` | teste de componente: `visibleInboxTabs` por papel, com e sem `telefone`, e o trilho com e sem a prop; `?filter=phone` numa organização sem telefone diz o porquê e o trilho não tem a aba. teste de rota: instalação sem telefonia → `ativa: false`, sem ler o banco. Invariante contra Postgres real: organização sem número SIP ativo (arquivado ou de outro provider não conta) → `ativa: false`. **NÃO PROVADO: a aba na tela de uma instalação real** |
| J44.2 O selo da aba conta quem ESPERA por uma pessoa (aguardando, tocando e transferida para a fila de um time) — e não conta quem ouve o menu nem quem está em ligação | `[P0]` | unit: `quantasEsperam`. teste de componente: o trilho com o selo 3 e sem selo com 0; no `InboxLayout`, quem está em ligação não entra na conta |
| J44.3 A aba tem quatro seções — "Na fila, por ordem de chegada", "No menu", "Em ligação" e "Perdidas nos últimos 30 minutos" — e só desenha a que tem linha | `[P0]` | teste de componente: as quatro seções, a seção sem linha sem título, a coluna vazia. Invariante contra Postgres real: cada fase com a ligação certa; a recebida viva há 5 h, a FEITA e a do WaCalls não entram |
| J44.4 A ordem de chegada na TELA: a que espera há mais tempo fica em cima, com a posição `1º`, `2º`…; só quem espera por uma pessoa tem posição | `[P0]` | unit: `posicoesNaFila` (por time, empate pelo id, menu e em ligação de fora). teste de componente: a fila por ordem de chegada. Invariante contra Postgres real: posições 1, 2 e 3 pela ordem de `queued_at`, `null` nas outras |
| J44.5 A ordem de chegada no WORKER: com um atendente livre toca a ligação que chegou primeiro, e não a cujo relógio de 5 s disparou antes; com dois livres, as duas mais antigas; a vez é por time | `[P0]` | unit (dublês): `controle.test.ts` (duas e três esperando, um e dois livres, a fila de outro time não segura esta) e `eAVezDela`. Invariante contra Postgres real: `queued_at` gravado com o `now()` do banco, uma vez só — a segunda chamada não o move —, e nada gravado com a organização errada ou na ligação encerrada. **NÃO PROVADO: ligação real pelo tronco** |
| J44.6 Quando uma ligação acaba, quem espera é reavaliado 2 s depois — numa passada só por organização, da mais antiga para a mais nova, pulando as mais novas do time que continuou sem ninguém livre — e o relógio de 5 s segue como rede de segurança | `[P1]` | unit (dublês): `controle.test.ts` (2 s depois e não na hora; três ligações que acabam em 1 s = uma passada; sem ninguém esperando não agenda nada; 5 esperando e ninguém livre = uma leitura dos disponíveis; o corte por time; a que esgotou durante a passada encerra uma vez). **NÃO PROVADO: que o BYE chegue ao navegador do atendente antes dos 2 s, numa ligação real** |
| J44.7 A linha diz "Aguardando há 3:42 · cai em 1:18"; passada a metade do teto DO TIME fica em atenção, faltando menos de 20% fica crítica, e o prazo vencido não vira contagem negativa | `[P0]` | unit: `urgenciaDaEspera` e `relogio`. teste de componente: a linha e o peso pelo teto do time (os mesmos 78 s são normais num time de 2 minutos); o relógio anda sozinho a cada segundo e mede pelo relógio do banco. Invariante contra Postgres real: `cai_em` só na fase `aguardando`; `queue_deadline_at` é o `now()` do banco mais o que falta no relógio do worker, e atender o apaga |
| J44.8 Filtro por time (chips com quantas esperam e há quanto a mais antiga espera) e por número da empresa (só com mais de um): vale para as quatro seções e para as contagens dos chips | `[P1]` | teste de componente: `FilaDoTelefone.test.tsx` e `ChipsDaFila.test.tsx` (escolher, desfazer, o filtro que esvazia tudo mantém o chip para desfazê-lo) |
| J44.9 Clicar numa ligação com conversa a abre à direita, pelo caminho de sempre; a de número oculto (sem conversa) não é botão | `[P0]` | teste de componente: `LinhaDaFila.test.tsx`, `FilaDoTelefone.test.tsx` e `InboxLayout.telefone.test.tsx`. **NÃO PROVADO: o painel de conversa quando quem clica não tem acesso a ela pela visibilidade (o desenho manda mostrar o estado de "conversa não encontrada"); nenhum caso o exercita** |
| J44.10 As perdidas dos últimos 30 minutos dizem quem, de qual time, o motivo, quanto esperou e há quanto tempo, e trazem o botão de ligar de volta onde há contato | `[P0]` | unit: `motivoDaPerdida` (os sete motivos). teste de componente: a linha da perdida, e o botão só com contato — o `BotaoLigar` é dublê. Invariante contra Postgres real: as de 40 min e a atendida ficam fora, da mais recente para a mais antiga, com o motivo certo e `esperou_s` batendo (±1). **NÃO PROVADO: o botão numa tela real (ele some sozinho para quem não tem ramal)** |
| J44.11 Configurações › Times › "Fila do telefone": 2 minutos (padrão), 5, 10, 15, 20 ou 30; trocar grava na hora, escolher o padrão grava `null`, só gerente e admin, e a mudança é auditada com o antes e o depois | `[P0]` | teste de componente: `EsperaMaximaDoTime.test.tsx` (o valor em vigor, o `PUT` com 600 e com `null`, sem telefonia nada na tela). teste de rota: papel abaixo de gerente barrado, suporte somente-leitura barrado, 404, 409 (arquivado, telefonia desligada), 422 (fora de 30–1800 e `organization_id` no corpo), auditoria só no sucesso. Invariante contra Postgres real: gravar 600 e `null`, o antes devolvido; CHECK que aceita 30, 120, 1800 e nulo e recusa 29, 1801, 0 e -5 |
| J44.12 A mudança do teto vale para a PRÓXIMA ligação: quem já espera cai no teto que valia quando entrou | `[P0]` | unit (dublês): `controle.test.ts` (o teto é lido na entrada da fila; com 5 minutos a ligação não cai aos 2 e cai aos 5). Invariante contra Postgres real: `timeParaAFila` devolve o teto do time (e `null` para time de outra organização). **NÃO PROVADO: ligação real pelo tronco** |
| J44.13 Quem não mexe em nada continua com os 2 minutos de antes | `[P0]` | unit: `esperaMaximaMs(null)` e os casos antigos dos 2 minutos, que seguem verdes; `controle.test.ts` (sem configuração, o prazo é gravado com o teto padrão e a fila esgota nele). Invariante contra Postgres real: a linha nova nasce sem teto, sem ordem e sem prazo |
| J44.14 Uma organização nunca vê a fila da outra: a leitura, a escrita do worker e o `PUT` do teto só alcançam a organização da sessão ou da ligação | `[P0]` | Invariantes contra Postgres real, com duas organizações: a fila (ligações, perdidas, números e times), a escrita de `queued_at` e do prazo com a organização errada, e o teto de time de OUTRA organização. teste de rota: a organização da sessão é a que chega ao banco, e a leitura compartilhada por 1,5 s é separada por organização |
| J44.15 A ligação transferida para a fila de um time (fase 2, v2) aparece na fila do time de DESTINO, com "Transferida por Ana" e sem posição; a aba desta entrega não tinha ação nenhuma, e as da entrega 3 (J45) não alcançam a transferida | `[P1]` | Invariante contra Postgres real: o time de destino, desde o pedido e quem transferiu. unit: ela conta no selo e não ocupa lugar na posição. teste de componente: a linha |
| J44.16 A releitura falha: a fila de antes fica na tela e uma faixa diz "Sem atualização no momento", com "Tentar novamente"; sem o Realtime, a releitura de 15 s segue | `[P1]` | teste de componente: a faixa, a fila mantida e o botão. `useFilaDoTelefone.test.tsx`: relê a cada 15 s, uma rajada de avisos vira UMA releitura, sem telefonia não assina nada. **O canal do Realtime é dublê** |
| J44.17 O banco falha ao gravar a ordem de chegada ou o prazo, ou o Asterisk não segura o cliente na linha: a ligação segue, é atendida, e nunca fica sem relógio | `[P0]` | unit (dublês): `controle.test.ts` (o banco fora na fila e no prazo; o `atender` da ARI que lança) |
| J44.18 A migration 0295 chega a quem já instalou: o bloco do baseline cria colunas, CHECKs e índices e se cura sozinho (linha do WaCalls com a coluna preenchida, tempo fora de 30–1800), e a REST não escreve nenhuma das três | `[P0]` | Invariante contra Postgres real: `telefonia-fila-visivel-schema.test.ts` (reaplicar o bloco, a cadeia de migrations, o `agent` pela REST). `pnpm test:db` aplica o baseline em install e em update |
| J44.19 Ligação real pelo tronco da operadora: duas ou três ligações esperando, com contas `agent` (nunca só a do dono) — a ordem na tela é a ordem em que tocam, o "cai em" bate com a hora em que a ligação cai, e o teto do time vale | `[P0]` | **NÃO PROVADO** — pendente, prova na VPS |

### O que NÃO foi provado

- **Ligação real pelo tronco.** A ordem de chegada no worker, o teto por time, o "cai em" e a
  reavaliação 2 s depois do fim de uma ligação não foram vistos numa chamada de verdade. O que está
  provado é o controlador com dublês e o SQL no Postgres real. Esta entrega ainda não está na `main`
  nem foi publicada.
- **O worker pela tela.** O e2e (`telefonia-fila.spec.ts`) abre a aba num navegador com as ligações
  SEMEADAS por SQL: prova a tela, a rota e o Realtime, não que o worker grave a fila assim numa ligação
  de verdade.
- **A capacidade de áudio da instalação.** Cada ligação na fila ocupa uma perna de áudio, e uma em
  andamento ocupa duas; a faixa publicada (`20000-20039/udp`, 40 portas) dá cerca de 20 pernas
  simultâneas — lido na configuração, não medido. Com o teto chegando a 30 minutos, a fila de um pico
  pode bater nesse limite, e o que o cliente ouve então não foi visto.
- **A carga da rota com a fila cheia.** Dezenas de ligações na fila e muitos navegadores abertos não
  foram medidos; o que está provado é a lógica da leitura compartilhada (uma em curso e uma na fila), não o tempo nem o
  custo de cada consulta.
- **O Realtime de `voice_calls` chegando ao navegador de cada papel.** A tabela tem RLS, e o teste do
  hook dubla o canal. Se o aviso não chegar a um `viewer` ou a um `agent`, a fila se atualiza a cada 15 s,
  não em tempo real — e isso ninguém viu.
- **O BYE antes dos 2 s.** Que o navegador do atendente que acabou de desligar já tenha fechado a sessão
  quando a reavaliação o chama é leitura do código, não medida.
- **O acesso pela visibilidade.** Clicar numa linha cuja conversa o membro não pode abrir (J44.9).

## J45 — Atender e mover direto da fila do telefone `[P0]` (2026-10-07)

A aba Telefone (J44) mostrava a fila, e quem coordena o atendimento ainda não fazia nada com ela: a
ligação só chegava a alguém quando o rodízio escolhia. O pedido do dono, na mesma conversa da J44
(como o desenho o registra): numa queda de internet, conseguir pôr mais gente para atender e mandar
a ligação para outro setor.

`[P0]` porque o gesto mexe na ligação de um cliente que está esperando na linha: um "Atender" que
derruba a ligação, toca para duas pessoas ou abre o microfone de quem não pediu; um "Mover" que tira
o cliente do lugar dele na fila ou o pendura sem ninguém tocando — qualquer um deles acontece na
frente do cliente, no pico.

Na ligação que espera por uma pessoa, a linha da fila ganha **Atender** — para quem tem ramal no
navegador: o worker toca só o ramal de quem pediu, por 10 s, e o navegador que clicou atende sozinho
— e o **botão de mover** — para gerente e admin: a ligação vai para a fila de outro time, sem perder
a ordem de chegada. O pedido vira uma ORDEM em `voice_call_queue_orders` (migration 0296), que a rota
grava e o worker relê e revalida; enquanto a ordem está aberta a linha diz quem está cuidando, e o
cartão da ligação conta quem a puxou e quem a moveu. Desenho:
`docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md` (§4.3 e a subseção "Emendas da
implementação"); plano: `docs/superpowers/plans/2026-10-06-telefonia-fila-visivel-entrega-3.md`; spec
20 §4.2, §5, §7 e §9; mapa em `docs/architecture/telefonia.architecture.json` (nós `rota_atender`,
`rota_mover`, `rota_ordem` e `t_ordens_da_fila`; arestas `aba_telefone → ramal_nav → rota_atender →
t_ordens_da_fila`, `controle → t_ordens_da_fila` e `t_ordens_da_fila → inbox`); roteiro da prova com
ligação real em `docs/runbooks/telefonia-fila-visivel.md` (§3).

**Como é provado, e com que alcance.** As mesmas camadas da J44, e cada caso diz em quais está:

- **unit (dublês):** o controlador com o banco e a ARI de mentira, em
  `lib/channels/telefonia/controle.test.ts` (bloco "as ordens da fila (0296)"), e a leitura do evento em
  `lib/channels/telefonia/ordens-da-fila.test.ts`. Provam a ORDEM das chamadas e as regras, nunca o SQL,
  o Asterisk nem o tempo real.
- **teste de rota:** `app/api/v1/telefonia/chamadas/[id]/atender/route.test.ts`,
  `app/api/v1/telefonia/chamadas/[id]/mover/route.test.ts` e
  `app/api/v1/telefonia/fila/ordens/[id]/route.test.ts`. O banco, a sessão e a ARI são dublês.
- **teste de componente:** `components/telefonia/fila/LinhaDaFila.test.tsx`, `FilaDoTelefone.test.tsx` e
  `useAcoesDaFila.test.tsx`; `components/telefonia/TelefoniaContext.fila.test.tsx` (o atendimento
  automático — o JsSIP é dublê); `components/telefonia/CartaoDaLigacao.test.tsx`.
- **invariante contra Postgres real:** `tests/invariants/telefonia-ordens-da-fila-schema.test.ts` (a
  tabela, os CHECKs, as FKs, a RLS com JWT de membro, a REST, o default ACL, a autocura do baseline e a
  cadeia de migrations), `tests/invariants/telefonia-pedido-da-fila.test.ts` (o SQL das rotas),
  `tests/invariants/telefonia-ordens-da-fila-repositorio.test.ts` (o SQL do worker e o registro da
  ligação) e `tests/invariants/telefonia-fila-da-tela.test.ts` (a ordem aberta na leitura da aba), sempre
  com duas organizações (`pnpm test:db`, roda no job `invariants`). É onde está provado o SQL.
- **e2e semeado:** `tests/e2e/telefonia-fila.spec.ts`, três casos novos (quem vê o quê; a ordem aberta
  na linha; o cartão). As ligações, as ordens e o cartão são semeados por SQL — prova a TELA e a rota
  da fila, não as rotas de atender e mover nem o worker. **Escrito e não executado por quem o
  escreveu**: roda só no GitHub Actions (parte 3), e as capturas sobem no artefato
  `evidencia-telefonia-fila`. Para saber se já rodou e como terminou:
  `gh run list --workflow e2e.yml --limit 5`. Enquanto a resposta não for uma execução verde com
  estes casos, leia "e2e semeado" na tabela abaixo como "há um caso escrito", não como "passou".
- **ligação real pelo tronco:** **NÃO PROVADO** em nenhum caso.

Quando esta jornada foi escrita, os testes de unidade, de rota e de componente acima foram rodados e
passaram. Os invariantes NÃO foram rodados nessa hora — dependem do Postgres do `pnpm test:db` —, e
o que vale para eles é o job `invariants` do PR (`gh pr checks`).

| Caso | Prioridade | Resultado |
|---|---|---|
| J45.1 Os botões só existem na ligação que espera por uma pessoa (`aguardando` ou `tocando`) — nunca no menu, nos avisos, em ligação ou na transferida para a fila de um time. "Atender" é de quem tem ramal neste navegador; o de mover, de gerente e admin, e só havendo outro time ativo | `[P0]` | teste de componente: as fases, "quem vê o quê" (atendente com e sem ramal, gerente sem ramal, um time só). e2e semeado: a gerente tem o mover na que espera e na que toca, a que ouve os avisos não tem nada, o atendente não tem o mover. **NÃO PROVADO: o botão "Atender" numa tela de verdade — no e2e a rota do ramal não entrega credencial (nada escuta a ARI), e o caso mede a AUSÊNCIA dele nesse estado** |
| J45.2 A ligação que toca para quem olha diz "Tocando para você" e não oferece "Atender" (ela se atende pelo aviso de toque); para os outros, o nome de quem toca | `[P1]` | teste de componente. e2e semeado: "Tocando para você" para a gerente e "Tocando para Carla Gerente" para o atendente, na mesma ligação |
| J45.3 Pedir para atender: a rota confere a ligação (recebida, do telefone, viva, não atendida, já na fila), o ramal de quem pede registrado e a pessoa fora de outra ligação; grava a ordem, emite o evento e responde 202 com o id dela | `[P0]` | teste de rota: 202, o evento com a ação e os ids, a organização e a pessoa da SESSÃO, `viewer` barrado, suporte somente-leitura barrado, 404 e 409 de cada recusa, a frase em espanhol. Invariante contra Postgres real: `pedirAtender` (a que espera e a que toca para outro; offline; em outra ligação; ligação de OUTRA organização → inexistente, nada gravado) |
| J45.4 Dois cliques em "Atender" na mesma ligação: uma ordem só; o segundo lê "{nome} já está atendendo esta ligação." | `[P0]` | Invariante contra Postgres real: a corrida de dois pedidos ao mesmo tempo (uma entra, a outra é `ja_ha_ordem`, fica UMA aberta), o índice único parcial, e o nome pela régua da fila (nunca o e-mail inteiro). teste de rota: a frase com o nome, e a geral sem ele |
| J45.5 O worker puxa a ligação: toca SÓ o ramal de quem pediu, por 10 s, com o cabeçalho `X-Fila-Atender: <ordem>`; atendeu → ponte, ordem `done`, a conversa de quem puxou | `[P0]` | unit (dublês): atender uma que espera. **NÃO PROVADO: ligação real — o cabeçalho num INVITE de verdade nunca foi visto** |
| J45.6 Puxar a ligação que tocava para outra pessoa: o toque dela é derrubado SEM contar como recusa — o fim daquele canal não origina toque novo, não gasta a vez de ninguém e não conta volta. Quem pede e já é quem toca por essa ligação é recusado sem perder o próprio toque | `[P0]` | unit (dublês): atender uma que toca para outro; o fim do toque derrubado chegando antes de a ARI responder; o relógio de 5 s e a passada que esperam atrás da ordem não tocam outro ramal por cima de quem puxou; quem já toca e pede para atender |
| J45.7 A puxada que não dá certo DEVOLVE A VEZ: quem puxou não atende em 10 s (ordem `no_answer`) ou o toque dele nem sai (`destino_offline`), e a ligação volta ao ponto em que estava — a volta não andou nem recomeçou, o teto e a música são os que ela tinha, e quem tocava quando a ordem chegou toca de novo, com o toque inteiro (o ramal digitado no menu, sozinho, antes da fila do time padrão). No último toque da última volta a ligação NÃO é encerrada por causa da puxada. Quem pediu lê "Seu telefone não atendeu. A ligação voltou para a fila." | `[P0]` | unit (dublês): quem foi derrubado toca de novo na mesma volta; o último toque da última volta, com quem puxou não atendendo e com o toque dele não saindo; a vez devolvida é UMA (a fila ainda desiste depois); duas puxadas que não dão certo em pontos diferentes do rodízio; ninguém tocava → nenhuma vez devolvida; o ramal digitado no menu. teste de componente: o aviso. **Antes do conserto (`git log --grep 'devolve a vez'`), a revisão independente reproduziu a ligação do cliente sendo encerrada nesse caso** |
| J45.8 O navegador de quem clicou atende sozinho, sem tela de toque e sem som — e NENHUM outro toque é atendido sem clique: o cabeçalho de outra ordem, o toque sem cabeçalho, o pedido vencido (15 s do clique), o recusado, a mesma ordem pela segunda vez, o clique feito em outra aba, e o toque que chega com a pessoa já em ligação (recusado com 486) | `[P0]` | teste de componente: `TelefoniaContext.fila.test.tsx`, nos dois sentidos — inclusive o toque que chega ANTES de a rota responder (vale a ligação clicada, com o cabeçalho presente) e o pedido novo que substitui o anterior. **O JsSIP é dublê. NÃO PROVADO: o JsSIP de verdade atendendo de dentro do `newRTCSession`, e o cabeçalho chegando a `request.getHeader`** |
| J45.9 Mover: a ligação e a conversa vão para o time novo; o toque em curso cai sem contar como recusa; as voltas zeram; o teto é o do time novo, contado de quando ela chega; a ORDEM DE CHEGADA não muda; toca quem está livre lá; o cliente não ouve de novo "fora do horário" nem o aviso de instabilidade | `[P0]` | unit (dublês): mover uma que toca, uma que espera, a ordem de chegada no time novo (a movida que chegou antes toca antes), a que tocava no ramal digitado. teste de rota: 202, o evento, a auditoria de/para. Invariante contra Postgres real: `pedirMover` (a ordem leva de onde e para onde; a ligação sem time). **NÃO PROVADO: ligação real** |
| J45.10 Mover para onde não dá: time fora do horário, arquivado, de outra organização ou o mesmo time → recusado com o motivo, e nada muda na ligação; o worker confere de novo (o expediente pode acabar entre o clique e a ordem) | `[P0]` | teste de rota: 409 e 422 de cada um, e o corpo que não leva a outra organização a lugar nenhum. Invariante contra Postgres real: o time de B pedido por A, o horário pelo relógio de quem chama. unit (dublês): o worker recusa time fechado, o mesmo time e o time que não pôde ser lido |
| J45.11 Ordem para ligação que não espera por uma pessoa — no menu, no silêncio do menu, ouvindo o aviso de instabilidade, já atendida, se despedindo ("ninguém atendeu" no ar), ou que o worker não acompanha — é recusada, e a ligação nem percebe: o menu segue valendo, o aviso toca inteiro, a despedida não é cortada | `[P0]` | unit (dublês): um caso para cada. Invariante contra Postgres real: as recusas de estado na rota |
| J45.12 O evento é ponteiro, não autoridade: sem ordem aberta no banco — id que não existe, de outra ligação ou de outra organização — nada acontece; a ação que vale é a GRAVADA na ordem, não a do evento; o mesmo evento duas vezes não toca de novo nem fecha a puxada em curso; evento ilegível é ignorado | `[P0]` | unit: `ordens-da-fila.test.ts` (o leitor do evento) e `controle.test.ts`. Invariante contra Postgres real: a ordem aberta só volta com a organização e a ligação certas; a órfã exige o par (ordem, ligação). **NÃO PROVADO: o formato do `ChannelUserevent` deste evento na ARI de verdade — o leitor o assume igual ao da transferência** |
| J45.13 Enquanto a ordem está aberta, a linha diz quem está cuidando — "Ana está atendendo…", "Movendo para Financeiro…" — no lugar dos botões, para todo mundo que olha; quando ela acaba sem a ligação mudar de mãos, os botões voltam | `[P1]` | teste de componente: as duas frases, "alguém" e "outro time" quando falta o nome. Invariante contra Postgres real: a ordem aberta vem na leitura da aba. e2e semeado: as duas frases, o controle (a ligação sem ordem tem o botão) e a volta dos botões sem recarregar |
| J45.14 Depois do 202 a tela acompanha a ordem — a cada 1 s, por até 15 s — e avisa o que houve: a frase do motivo, ou "Ligação movida para {time}."; sem resposta no prazo não afirma nada, só relê a fila. Pela rota, só quem pediu a ordem (ou gerente e admin) a lê — conveniência da tela, não segredo: pela REST, todo membro lê as ordens da própria organização | `[P1]` | teste de componente: `useAcoesDaFila.test.tsx` (o intervalo e o prazo, a leitura que falha, a tela que saiu no meio ainda avisa, um clique = um pedido, só se puxa uma por vez). teste de rota: `GET …/fila/ordens/[id]` (quem pediu, outro atendente → 404, gerente e admin, outra organização → 404, `viewer` → 403, sem auditoria) |
| J45.15 O cartão da ligação conta o que se fez com ela na fila, uma linha por ação que ACONTECEU, antes da corrente de transferências: "Puxada da fila por Ana", "Movida de Suporte para Financeiro por Carla" — com os nomes daquela hora (o nome cadastrado ou o começo do e-mail, nunca o endereço inteiro), gravadas no fim da ligação; a recusada, a que ninguém atendeu e a cancelada ficam de fora | `[P1]` | teste de componente: as duas linhas, "alguém" e "outro time", o que o registro não sustenta é descartado, em espanhol. Invariante contra Postgres real: o registro leva só as ordens `done`, na ordem dos pedidos, com o nome pela régua `fn_nome_do_usuario`; a ligação perdida também as leva; a leitura que falha não impede o registro. e2e semeado: as duas linhas no cartão, e o cartão da ligação comum sem linha nenhuma |
| J45.16 Nada do que a ordem faz derruba ou pendura a ligação: o banco que cai ao conferir quem puxa, ao mover ou ao gravar o desfecho; o toque de quem puxou que não sai; o cliente que desliga com o ramal de quem puxou tocando, ou enquanto o toque é originado; e o fim do canal que se perde (a rede de segurança do toque segue sozinha, sem esperar o evento) | `[P0]` | unit (dublês): um caso para cada — a conferência que falha RECUSA a ordem em vez de seguir (`falha_ao_conferir`), mover grava o banco antes de derrubar o toque (`falha_ao_mover`: a ligação segue no time em que estava), a ligação nunca fica sem ramal e sem relógio (no rodízio e na puxada, com o fim do canal perdido, chegando logo depois ou no meio), e mover a que tocava no ramal digitado lê as falas gerais (o "aguarde" e o "ninguém atendeu" valem no time novo) |
| J45.17 Ordem aberta não fica para sempre nem trava a ligação: ela VENCE em 30 s — a aba deixa de mostrá-la, o pedido seguinte a fecha (`ordem_vencida`) antes de gravar o dele, e o worker cancela sem agir a que chega a ele já vencida —; a ligação que acaba a cancela (`ligacao_encerrada`); a reconexão do worker cancela todas (`worker_reiniciou`); e a que não chega ao worker (ARI fora) é fechada pela rota, que responde 503 | `[P0]` | unit: a validade é de 30 s e tem folga sobre os 10 s do toque de quem puxou (`lib/telefonia/fila.test.ts`). unit (dublês): o cliente que desliga, a ordem cujo evento nunca chegou, o reinício, a ordem que chega vencida (cancelada, não recusada; a ligação não muda) e o evento repetido de uma puxada em curso (ignorado, não cancelado). Invariante contra Postgres real: a aberta há mais de 30 s não vem na linha (e a de 5 s vem); aberta há 31 s + pedido novo de atender ou de mover → a velha fecha e a nova entra; a recente não é tocada; só a vencida DAQUELA ligação fecha; dois cliques sobre uma vencida → uma ordem nova; o fim da ligação cancela só as dela e libera a próxima; o reinício cancela as das duas organizações sem reescrever as encerradas; `recusarOrdemSemWorker`. teste de rota: 503, a linha fechada, sem auditoria. e2e semeado: a linha com uma ordem aberta há 40 s tem o botão, e não a frase |
| J45.18 Uma organização nunca vê nem alcança a ordem da outra, e a REST só lê: `authenticated` e `service_role` não inserem, não alteram, não apagam e não truncam; `anon` não lê | `[P0]` | Invariante contra Postgres real: a RLS com JWT de membro das duas organizações, as FKs compostas (a ordem de A não aponta para a ligação nem para o time de B), o default ACL de tabelas do Supabase com controle (sem o `revoke`, a service key gravaria e apagaria a ordem de qualquer organização), e os pedidos de A sobre a ligação de B |
| J45.19 A migration 0296 chega a quem já instalou: o bloco do baseline cria a tabela, os CHECKs, os índices e a policy, e se cura sozinho; num banco na 0295, a migration chega ao mesmo lugar | `[P0]` | Invariante contra Postgres real: `telefonia-ordens-da-fila-schema.test.ts` (reaplicar não reconstrói nada; derrubados os CHECKs, os índices, a policy, a RLS e o `revoke`, tudo volta; linha fora da regra vira aviso, não erro). `pnpm test:db` aplica o baseline em install e em update |
| J45.20 O pedido é auditado — `phone.queue_call_pulled`, `phone.queue_call_moved` (de e para que time) — só quando aceito; a recusa e o 503 não auditam | `[P1]` | teste de rota |
| J45.21 A faixa das ações fica EMBAIXO do texto da linha (a coluna é estreita, e botão dentro de botão não existe): a área principal segue abrindo a conversa, a linha cresce em vez de vazar, e a coluna não rola para o lado | `[P1]` | teste de componente: o clique no botão não abre a conversa, e não há botão dentro de botão. e2e semeado: medido por `getBoundingClientRect` — a faixa abaixo da área principal, a linha com ações mais alta que a sem, `scrollWidth <= clientWidth` na coluna (as medidas vão no artefato, em `medidas-das-acoes.json`) |
| J45.22 Ligação real pelo tronco da operadora, com duas contas `agent` e uma `manager` (nunca só a do dono): os nove casos do §3 do roteiro — atender com um clique, dois clicando juntos, mover, mover para time fechado, em outra ligação, fechar a aba, a que ainda está no menu, e o mesmo atendente com duas abas | `[P0]` | **NÃO PROVADO** — pendente, prova na VPS (`docs/runbooks/telefonia-fila-visivel.md`) |

### O que NÃO foi provado

- **Ligação real pelo tronco.** Nenhuma ligação foi puxada nem movida de verdade. O que está provado é
  o controlador com dublês, o SQL no Postgres real e a tela em teste de componente.
- **O atendimento automático de ponta a ponta.** Três elos nunca foram medidos: que o Asterisk ponha o
  cabeçalho `X-Fila-Atender` no INVITE do ramal WebRTC (ele é pedido por `PJSIP_HEADER(add,…)` no
  `originate`); que o JsSIP o entregue em `request.getHeader`; e que `answer()` chamado de dentro do
  `newRTCSession` atenda de fato. Se algum falhar, o telefone TOCA em vez de atender sozinho — a
  ligação ainda pode ser atendida à mão —, e é o caso 3.2 do roteiro que mostra.
- **O formato do evento: MEDIDO depois do deploy** (2026-10-07, sonda na VPS com um aplicativo Stasis de
  outro nome, sem ligação nenhuma): `POST /ari/events/user/telefonia_fila` responde `204` e o Asterisk
  entrega `ChannelUserevent` com `eventname` e as variáveis em `userevent` — o que `lerOrdemDaFila` lê.
  O que segue sem prova é o caminho inteiro: a rota de verdade emitindo e o worker agindo numa ligação.
- **O botão "Atender" na tela.** Fora dos testes de componente, ninguém o viu: ele depende da
  credencial do ramal, que a rota só entrega com o Asterisk respondendo, e o e2e mede a ausência dele.
- **O e2e desta entrega.** Executado no GitHub Actions e verde (os três casos novos, runs 37556283135 e
  37560031052). Ele prova a tela sobre dados SEMEADOS: o clique em "Atender" e num time do menu de mover não entra — a rota entregaria a
  ordem a um worker que no CI não existe.
- **Os 10 s e os 15 s numa rede de verdade.** O toque de quem puxou dura 10 s e o navegador reconhece
  o pedido por 15 s do clique; quanto passa entre o clique e a ligação conectada, com um navegador
  lento ou uma rede ruim, não foi medido.
- **O mesmo atendente com duas abas.** O ramal é um só, registrado pelas duas: o Asterisk pode fazer
  tocar só um dos registros, e pode ser o da aba que NÃO clicou — onde o toque é o de sempre e pede o
  clique. Em nenhum dos dois o cliente cai (se ninguém atender, a ligação volta ao rodízio em 10 s),
  mas qual dos dois acontece ninguém viu: é o caso 3.9 do roteiro.

### Limites conhecidos, não consertados

Lidos no código (e, onde há teste, provados com dublês). Nenhum foi visto numa ligação real.

- **Quem atende no mesmo instante em que alguém puxa ou move perde a ligação.** O ramal que tocava sai
  da ligação antes de ser desligado; se o atendente atendeu nessa janela de milissegundos, o worker
  não reconhece mais o canal e o larga. O cliente segue com quem puxou, ou na fila do time novo.
- **Reconexão da ARI com uma puxada em curso.** A reconexão cancela no banco toda ordem aberta. Se
  quem puxou atende depois, a ligação conecta, mas o cartão não diz "Puxada da fila por".
- **A ordem que fica aberta sem ninguém para fechá-la** (a escrita do desfecho falhou, ou o worker
  nem chegou a lê-la) segura a ligação por até 30 s: nesse intervalo a linha diz quem "está cuidando"
  e um novo "Atender" ou "Mover" é recusado. Depois ela vence (J45.17). Não há passada que feche
  ordem aberta: sem pedido novo, a linha do banco fica `open` até o fim da ligação.
- **Com a ARI fora do ar, um clique em "mover" pode gravar até três ordens recusadas**: o cliente HTTP
  do navegador repete o 503 até três vezes, e cada repetição é um pedido novo. Nenhuma fica aberta.
  Lido no código (`lib/api/client.ts`), não medido.

## J46 — O atendente lê o áudio do cliente sem ouvir `[P1]` (2026-10-08)

Pedido do dono: o sistema já transcreve o áudio que o cliente manda (é como o agente de IA o
entende), mas o texto não aparecia na conversa — o atendente via só o player e tinha de escutar.
O balão do áudio passa a mostrar o começo da transcrição logo abaixo do player, com "Ler mais"
para abrir o texto inteiro ali mesmo.

Sem migration: o texto é `messages.media_derived_text` (0058), que `workers/media-derive-worker.ts`
já gravava. Medido em produção antes de escrever (2026-10-08, só contagens, 14 dias): 320 áudios
recebidos, 320 com transcrição pronta; metade com até 132 caracteres, 90% com até 450, o maior com
3.917; pronta 8 s depois do áudio na mediana, 27 s no pior caso. Mapa em
`docs/architecture/transcricao-do-audio.architecture.json`.

**Como é provado.** A regra pura (o que a listagem entrega, o que o balão mostra, onde o trecho
corta) em `tests/unit/transcricao-do-audio.test.ts`; o balão montado pelo `MessageBubble`, com
relógio de mentira para o prazo do "Transcrevendo…", em
`tests/unit/inbox-transcricao-do-audio.test.tsx`; a rota contra o Postgres real em
`tests/invariants/messages-list-paginacao.test.ts` (bloco "a transcrição do áudio"), que anonimiza
de verdade pelos dois caminhos e mede antes e depois; e a tela, com os áudios semeados como o worker
os deixa, em `tests/e2e/inbox-transcricao-do-audio.spec.ts`.

A spec de tela passou inteira no GitHub Actions, na execução 37798949042 do `e2e.yml` (o commit de
merge na `main`). As imagens e o `medidas.json` sobem como artefato
`evidencia-inbox-transcricao-do-audio`: caixa de 282 px num balão de 306 px, abaixo do player; trecho
de 72 px (4 linhas de 13 px); aberta, 256 px visíveis de 501 px de texto; no celular (390 px), caixa de
245 px. As falhas das outras specs dessa execução são herdadas (`card-pelo-classificador`,
`inbox-rotulo-de-origem`, 1ª tentativa de `degradacao-silenciosa`).

O invariante foi sabotado de três jeitos e reprovou nos três: sem a regra no caminho da listagem
(os casos de imagem, apagada e sem arquivo); sem as colunas no `select` (todos os do bloco); e sem
a conferência do contato (o caso do botão de anonimizar).

| Caso | Prioridade | Resultado |
|---|---|---|
| J46.1 Áudio do cliente já transcrito: abaixo do player aparece o começo do que ele falou, com o rótulo "Transcrição automática" | `[P1]` | **PASS** (pela tela, e2e — execução 37798949042 na `main`) |
| J46.2 "Ler mais" abre o texto inteiro ali mesmo, e "Ler menos" recolhe; áudio comprido rola por dentro da caixa (teto de 256 px medido no navegador) | `[P1]` | **PASS** (pela tela, e2e — execução 37798949042 na `main`) |
| J46.3 Transcrição curta aparece inteira e sem botão | `[P1]` | **PASS** (pela tela, e2e — execução 37798949042 na `main`) |
| J46.4 Áudio que acabou de chegar diz "Transcrevendo…", e o texto entra sozinho quando fica pronto, sem recarregar a página | `[P1]` | **PASS** (pela tela, e2e — execução 37798949042 na `main`) |
| J46.5 Quem está no fim da conversa vê a transcrição chegar inteira (o balão cresce e a conversa acompanha); quem subiu para ler o histórico não é levado ao fim | `[P1]` | **PASS** (pela tela, e2e — execução 37798949042 na `main`) |
| J46.6 O "Transcrevendo…" tem prazo (3 min): passou, a tela para de prometer. Navegador com o relógio alguns segundos atrasado ainda vê o aviso | `[P2]` | em unidade (relógio de mentira) |
| J46.7 Áudio gravado pelo atendente no CRM, e áudio antigo sem transcrição: só o player, como era | `[P1]` | **PASS** (pela tela, e2e — execução 37798949042 na `main`) |
| J46.8 A transcrição falhou, ou falta a chave da OpenAI: "Transcrição indisponível" — o recado interno do agente nunca aparece como fala do cliente | `[P1]` | em unidade |
| J46.9 Descrição de imagem e texto de PDF (que o sistema também gera para o agente) não são entregues pela listagem | `[P1]` | no Postgres real |
| J46.10 Mensagem apagada pelo cliente: a listagem não entrega a transcrição, e o balão não a mostra | `[P0]` | no Postgres real e em unidade |
| J46.11 Contato anonimizado pelo BOTÃO da ficha (o contato muda, as mensagens ficam com o áudio): a listagem deixa de entregar a transcrição | `[P0]` | no Postgres real (antes e depois) |
| J46.12 Contato anonimizado pela CASCATA de LGPD (`fn_lgpd_cascade_redact_contact`, a de verdade): a listagem deixa de entregar a transcrição | `[P0]` | no Postgres real (antes e depois) |
| J46.13 Anonimizar um contato não cala a transcrição dos outros | `[P1]` | no Postgres real |
| J46.14 Transcrição que bateu no teto do sistema (8.000 caracteres) avisa que o áudio continua | `[P2]` | em unidade |
| J46.15 A conversa vista pelo super-admin (leitura que não traz a transcrição): só o player, sem "Transcrevendo…" | `[P2]` | em unidade |
| J46.16 No celular (390 px), a caixa não passa da borda da tela | `[P2]` | **PASS** (pela tela, e2e — execução 37798949042 na `main`) |
| J46.17 Áudio real de um cliente em produção: o texto do balão é o que ele falou | `[P1]` | pendente — prova do dono |

### O que NÃO foi provado

- **Áudio real.** O e2e semeia o texto que o worker gravaria; nenhum áudio de cliente foi enviado
  nem transcrito para esta prova. A cadeia que produz o texto não mudou e roda em produção. A
  feature está em produção desde a 1.58.0 (2026-10-08); a conferência na tela real é do dono.
- **A qualidade da transcrição.** O Whisper erra nome, valor e número de documento. O rótulo
  "Transcrição automática" avisa; nada confere o texto contra o áudio.
- **O texto continua no banco depois da anonimização**, pelos dois caminhos: nenhuma das duas
  rotinas zera `media_derived_text`, e a do botão da ficha nem toca em `messages` (corpo e áudio
  também ficam). Esta entrega só garante que a LISTAGEM não entrega a transcrição (J46.11 e J46.12);
  apagar é mudança de banco, registrada à parte. Em produção, na data da medição, nenhum contato
  tinha sido anonimizado.
- **O que o Realtime carrega.** O aviso de mudança do Supabase leva a linha inteira da mensagem ao
  navegador, e isso é anterior a esta entrega; a tela só o usa para recarregar. Não foi medido num
  Supabase real quais colunas chegam.
- **A rolagem com mais de 50 mensagens no atendimento.** A conversa só acompanha a chegada quando a
  contagem de itens muda; com a página cheia entra uma e sai outra, e ela não muda. É anterior a
  esta entrega e vale para toda mensagem nova. Lido no código, não reproduzido na tela.
- **Tema escuro e leitor de tela.** O botão tem `aria-expanded` e `aria-controls`, conferidos em
  unidade; ninguém ouviu a tela. O aviso "pode conter erros" só existe como dica ao passar o mouse.

### O que a revisão independente achou

Um subagente leu o commit sem as conclusões de quem escreveu. Quatro achados mudaram o código antes
do PR: (1) a proteção do contato anonimizado se apoiava em "mensagem sem arquivo", e o botão
"Anonimizar" da ficha não mexe nas mensagens — a transcrição seguiria na tela; a listagem passou a
conferir `contacts.is_anonymized`, falhando fechada (J46.11); (2) a conversa media "o leitor está no
fim?" DEPOIS de o balão crescer, e a transcrição que chega passa dos 120 px de tolerância — nasceria
abaixo da dobra; a anotação passou a ser feita antes (J46.5); (3) com o relógio do navegador
atrasado, "Transcrevendo…" não aparecia; (4) na conversa vista pelo super-admin, "Transcrevendo…"
aparecia e o texto nunca vinha (J46.15). Também vieram dele o aviso da transcrição cortada no teto
(J46.14) e o texto curto com muitas quebras de linha, que ocuparia a tela.

## J47 — Filtrar o Inbox por atendente, caixa de entrada, período e assunto `[P1]` (2026-10-08)

Pedido de quem atende, na Totus: "todas as conversas que vemos aqui são todas misturadas de todos os
atendentes", com a comparação de que a ferramenta anterior tinha "minhas conversas finalizadas". O dono
acrescentou: os filtros têm de valer em todas as abas, inclusive nas finalizadas, e incluir a caixa de
entrada (só WhatsApp, só telefone).

`[P1]` porque é uso de todo dia de quem já atende, e não primeira impressão: o Inbox funciona sem os
filtros, só custa mais achar o que é seu.

O funil do Inbox ganha quatro seletores — atendente (Todas e Fechadas), caixa de entrada (o meio ou um
número; substitui "Todos os números" e passa a listar o telefone), período e assunto (só Fechadas) —, a
aba Fechadas ganha o botão "Só as minhas", e os filtros passam a morar no endereço da página (a busca
não). Migration 0297 (um índice em `atendimentos`). Desenho:
`docs/superpowers/specs/2026-10-08-inbox-filtros-por-atendente-e-caixa-design.md`; plano:
`docs/superpowers/plans/2026-10-08-inbox-filtros-por-atendente-e-caixa.md`; mapa em
`docs/architecture/inbox-filtros.architecture.json`.

**Como é provado, e com que alcance.**

- **unit (regra pura):** `lib/inbox/filtros-de-tela.test.ts` (em que aba cada filtro vale, o que vai a
  cada rota, e a cerca "todo filtro aplicado é nomeado no vazio"), `lib/inbox/filtros-na-url.test.ts`
  (ida e volta, link quebrado) e `lib/inbox/periodo.test.ts` (o dia de quem olha, a virada do dia).
- **unit (servidor, banco de mentira):** `tests/unit/inbox-filtro-de-meio.test.ts`,
  `tests/unit/aba-fechadas-lista-atendimentos.test.ts` (os filtros novos viram predicado),
  `tests/unit/contagem-aplica-os-filtros-novos.test.ts` (a que selo cada filtro chega) e
  `app/api/v1/conversations/filtros/_handler.test.ts` (organização da sessão em toda leitura; quem não vê
  colegas não recebe nomes). Provam o predicado montado, não o SQL que o PostgREST gera.
- **teste de componente:** `components/inbox/InboxFilters.novos.test.tsx` (em que aba cada seletor
  existe, o que cada escolha propaga, os órfãos) e `tests/unit/inbox-filtros-no-endereco.test.tsx` (o
  Inbox inteiro sobre um roteador de mentira: do endereço ao pedido de cada rota).
- **banco de verdade:** o baseline com a 0297 em instalação e atualização (`pnpm test:db`), e a medição
  do plano com e sem o índice, no cabeçalho da migration.
- **ponta a ponta:** `tests/e2e/inbox-filtros-por-atendente-e-caixa.spec.ts`, no GitHub Actions.

| # | Caso | Onde é provado |
|---|---|---|
| J47.1 | Em Fechadas, "Só as minhas" deixa só o que estava comigo no encerramento, e o selo da aba acompanha | e2e; unit |
| J47.2 | Recarregar a página e abrir o endereço copiado em outra janela devolvem a mesma lista filtrada | e2e (a única prova de que o `history.replaceState` conversa com o roteador do Next de verdade) |
| J47.3 | Quem coordena escolhe um atendente pelo nome, em Fechadas e em Todas | e2e (Fechadas); componente e unit (Todas) |
| J47.12 | "Sem atendente" em Todas é filtro, não a Fila: a ordem é a de Todas e nenhuma linha ganha "1º" | e2e; unit (`sem-atendente-nao-e-a-fila`) |
| J47.13 | A leitura das opções falhou: o funil diz e oferece tentar de novo | componente |
| J47.4 | Período "Hoje" e "Ontem" recortam as Fechadas pelo dia do encerramento | e2e; unit |
| J47.5 | Assunto recorta as Fechadas | e2e; unit |
| J47.6 | Filtro sem resultado cita os filtros ligados; "Limpar filtros" devolve a lista e limpa o endereço | e2e; componente |
| J47.7 | Caixa de entrada "Telefone" deixa só a conversa de telefone; "WhatsApp" não a traz | e2e; unit |
| J47.8 | Trocar de aba mantém os filtros no endereço; filtro que não vale na aba não é aplicado nem contado | componente; e2e (Minhas) |
| J47.9 | O selo de uma aba diz o que o clique nela vai mostrar, mesmo com um filtro que só vale nela | componente (o pedido de contagem leva todos os filtros); unit (o servidor decide o alcance) |
| J47.10 | Quem só vê as próprias conversas não recebe nomes de colegas | unit da rota |
| J47.11 | O texto da busca não vai para o endereço | componente |

**O que NÃO foi provado.**

- **Com gente de verdade.** Nenhum atendente usou os filtros; a prova real é na produção, depois de
  publicado.
- **Datas pelo campo de data, no navegador.** "Escolher datas…" e os dois campos são provados no teste de
  componente; o e2e usa "Hoje" e "Ontem".
- **Fuso.** "Hoje" é o dia de quem olha a tela. O CI roda em UTC; um observador em outro fuso que o
  atendente vê outro recorte, e isso não tem teste — é limite declarado no desenho (D7).
- **Gestos rápidos, no navegador.** O endereço chega à tela por uma transição do React; a regra que
  impede um gesto de desfazer o anterior (`enderecoDepoisDoGesto`) é provada como função pura, com a
  tela atrasada montada à mão. A corrida de verdade — digitar na busca e clicar num filtro em menos de
  250 ms — não foi reproduzida num navegador.
- **Digitar a data pelo teclado.** Os campos guardam o que foi digitado enquanto o valor não volta de
  fora (teste de componente); não foi provado num navegador que o trecho em edição não é zerado.
- **O plano das consultas pelo PostgREST.** O `EXPLAIN` do cabeçalho da 0297 foi sobre SQL escrito à
  mão, equivalente ao que o PostgREST monta; a consulta real não foi capturada.
- **O limite de visibilidade.** Em instalação onde o atendente só vê as próprias conversas, um
  atendimento que ele encerrou some das Fechadas dele quando o cliente volta e outro atende — a regra é
  da policy de `atendimentos`, que esta entrega não tocou. Tem tarefa própria.

## J48 — Ler a ligação em vez de ouvir: transcrição e resumo no cartão `[P0]` (2026-10-09)

Pedido do dono: a ligação gravada só podia ser ouvida, e ouvir custa o tempo da ligação inteira
(medido na Totus, 30/09 a 09/10: 180 gravações, 98 escutas por 13 pessoas). O cartão da ligação
passa a mostrar um **resumo** e o botão **"Ver transcrição"**, que abre a conversa com a indicação
de quem falou. Desligado por padrão; liga em Conexões › Telefone › Gravação, e vale só para as
ligações gravadas daí para frente.

Migration 0298 (`voice_call_transcripts`, a política em `phone_settings`). Desenho, com a sonda
de qualidade feita em gravações reais e as decisões tomadas na ausência do dono:
`docs/superpowers/specs/2026-10-09-telefonia-transcricao-das-ligacoes-design.md`. Mapa:
`docs/architecture/telefonia.architecture.json` (peças `transcricoes`, `t_transcricoes`,
`rota_transcricao`, `listagem_transcricao`, `cartao_transcricao`).

**Como é provado.** O serviço do worker (pedir, baixar, transcrever, resumir, cada falha, a
ligação longa em blocos) com dublês em `lib/channels/telefonia/transcricoes.test.ts`; o SQL no
Postgres real em `tests/invariants/telefonia-transcricao.test.ts` (com duas organizações); as
rotas, a listagem, o cartão e a aba em unidade; e a tela em
`tests/e2e/telefonia-transcricao.spec.ts`, que semeia a ligação gravada e escreve a transcrição
com as MESMAS funções de banco que o worker chama — nada vai ao provedor de IA no teste.

| Caso | Prioridade | Resultado |
|---|---|---|
| J48.1 Instalação sem chave da OpenAI (primeiro deploy): o interruptor "Transcrever as ligações gravadas" não liga, a tela aponta onde cadastrar, e a rota recusa com 409 do mesmo jeito | `[P0]` | e2e; unidade (`GravacaoDasLigacoes.test.tsx`, `gravacao/route.test.ts`) |
| J48.2 Com a chave: o admin liga e salva; o banco guarda a política com o instante de agora; a auditoria registra o antes e o depois | `[P0]` | e2e; Postgres real |
| J48.3 Só daqui para frente: a ligação gravada antes de ligar não vira pedido — nem pela passada que repõe pedido perdido | `[P0]` | e2e; Postgres real |
| J48.4 Ligação gravada com a transcrição ligada: o cartão diz "Transcrevendo a ligação…" | `[P0]` | e2e |
| J48.5 A transcrição fica pronta: o MESMO cartão mostra o resumo ("feito por IA") e "Ver transcrição", sem recarregar a página | `[P0]` | e2e |
| J48.6 "Ver transcrição": a janela lista quem falou, quando e o quê; avisa que é texto de máquina e que quem falou é estimativa; cabe na tela e rola por dentro (medido) | `[P0]` | e2e (1440 px e 390 px); `CartaoDaLigacao.test.tsx` |
| J48.7 Cada abertura da janela é uma linha `phone.transcript_read`; abrir a conversa, nenhuma; a auditoria não guarda o texto | `[P0]` | e2e; unidade da rota |
| J48.8 Leitor (viewer) do mesmo time: vê a ligação e nada da transcrição — nem na tela, nem na listagem, nem pela rota (403) | `[P0]` | e2e; unidade (`transcricao-da-ligacao.test.ts`) |
| J48.9 A tabela não sai pela REST do Supabase: nem para o leitor, nem para o atendente, nem sem login | `[P0]` | e2e (Supabase de verdade, com o default ACL dele); Postgres real |
| J48.10 O texto nunca entra na linha de `messages` (que o Realtime leva inteira ao navegador): só a situação | `[P0]` | e2e; Postgres real |
| J48.11 Gravação sem fala: "A gravação não tem fala para transcrever." | `[P1]` | e2e; unidade |
| J48.12 A transcrição falha em todas as tentativas: o cartão diz, e a Central abre o aviso com "Abrir a gravação do telefone" | `[P1]` | e2e; unidade |
| J48.13 Sem chave no meio do caminho: a Central avisa já na primeira ligação, e as tentativas seguem com espera crescente | `[P1]` | unidade (`transcricoes.test.ts`) |
| J48.14 O resumo que falha não derruba a transcrição: o texto fica, sem resumo e sem quem falou | `[P1]` | unidade |
| J48.15 Ligação longa (mais de 400 trechos): vai em blocos; resumo parcial nunca é mostrado como o da ligação | `[P1]` | unidade |
| J48.16 Transcrever nunca custa a gravação: o gancho que lança não muda o desfecho dela | `[P0]` | unidade (`gravacoes.test.ts`) |
| J48.17 Anonimizar o contato apaga a transcrição, pelo botão da ficha e pela cascata; a exportação de dados do titular a inclui | `[P0]` | Postgres real (a exportação: só a leitura do código — sem teste próprio) |
| J48.18 Passado o prazo de guarda, a transcrição é apagada junto com a gravação | `[P1]` | Postgres real |
| J48.19 Organização que desliga a transcrição: o pedido pendente é descartado e nada vai ao provedor | `[P0]` | unidade; Postgres real |

**O que NÃO foi provado.**

- **Uma ligação de verdade, do fim da chamada ao texto no cartão.** O caminho inteiro — o Asterisk
  grava, o worker guarda, baixa do Storage, manda à OpenAI, resume e grava — só roda numa instalação
  com telefonia, chave e a transcrição ligada. Depende de release e de o dono ligar o interruptor.
  As duas metades foram medidas em separado: a OpenAI com gravações reais (a sonda do desenho, §2.3),
  e o resto com dublês e no Postgres.
- **A qualidade no dia a dia.** A sonda leu 10 gravações. Não há taxa de erro por palavra (ninguém
  comparou com a escuta), nem medida de quantas vezes "quem falou" erra.
- **O custo cobrado.** O valor por minuto que vai para a tela de Execuções é o preço público do
  transcritor; a fatura da OpenAI não foi conferida contra ele.
- **Espanhol.** O idioma da organização vai ao transcritor e ao pedido do resumo; nenhuma ligação em
  espanhol foi transcrita.
- **Ligação com transferência** (três vozes) e **ligação de 2 h** (o teto da gravação).
- **O worker caindo no meio de uma transcrição.** A reserva de 45 min e a retomada são lidas no
  código e provadas por partes (a reserva, no Postgres); a queda de verdade não foi provocada.
