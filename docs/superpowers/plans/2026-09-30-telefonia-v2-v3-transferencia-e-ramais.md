# Plano — telefonia v2 (transferência) e v3 (ramais)

- **Data:** 2026-09-30
- **Desenho:** [`docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`](../specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md), **§12 (emenda de 2026-09-30)**, que prevalece sobre §3.2, §3.3, §5.3, §5.4 e §6.5/§6.7.
- **Base:** `main` em `e44a199` (1.51.1 + gravação corrigida, #105). A branch é `claude/telefonia-transferencia-ramais-*`.
- **Onde foi escrito:** sessão na nuvem (container efêmero), sem acesso à VPS nem ao Asterisk real. O que depende da VPS — a sonda do evento de usuário da ARI, o deploy e a prova com ligação — fica no roteiro do dono (§6).

## 1. Decisões de implementação (o que o desenho deixou aberto)

| # | Ponto | Escolha | Por quê |
|---|---|---|---|
| I1 | Onde mora a mecânica | `lib/channels/telefonia/transferencia.ts`, classe `Transferencias`, no molde de `FalasNoAr`: estado por ligação, relógios próprios, **ganchos** para o controlador | O controlador (1.600 linhas) só roteia eventos; a transferência se prova num arquivo de teste próprio |
| I2 | A forma comum da ligação atendida | Uma interface `LigacaoEmConversa` (`vcId`, `org`, `ponte`, `canalDoCliente`, `atendente {canal,userId}`, `numeroExibido`, `teamId`, `conversationId`, `fim`) que recebida e feita expõem por um adaptador no controlador | Recebida e feita guardam os mesmos fatos com nomes diferentes (`fila.ramal`/`atendidaPor` × `ramal`/`userId`); o adaptador evita reescrever as duas |
| I3 | "Tocando para P" durante a transferência | `ringing_user_id = P`, **sem** mexer em `status` (continua `connected`) — função nova `marcarTocandoNaTransferencia` | `marcarTocando` põe `status = 'ringing'`, o que faria o painel e o `recuperar()` lerem a ligação como não atendida. O `ringing_user_id` já é o "ocupado" que o distribuidor lê |
| I4 | A ordem da tela | `POST /events/user/telefonia_transferencia?application=crm` com `variables: { acao, transferencia_id, voice_call_id }`. O worker relê a transferência **pelo id, com a organização da ligação em memória e o `voice_call_id` junto**; a variável é ponteiro | D13/§12.2. `completar`/`voltar` não gravam linha nova: o worker confere que a transferência aberta é consultada e está na fase certa |
| I5 | O evento na WebSocket | Lido de forma defensiva: `ChannelUserevent` com `eventname` e `userevent` (objeto das variáveis). Qualquer outra forma é ignorada com log | O formato não foi medido nesta sessão (sem VPS); a sonda fica no roteiro. O parser está num lugar só (`lerOrdemDaTransferencia`) |
| I6 | Cliente ouve o quê | `POST /bridges/p-<id>/moh` (música na PONTE) do começo ao fim da transferência; parada quando alguém entra | D19. A gravação (F3) segue gravando a ponte |
| I7 | Fim sem ninguém (D20) | Toca `ninguem` no canal do cliente (a música da ponte para antes), espera o `PlaybackFinished` (com relógio de folga) e desliga. Sem a fala, desliga direto | D20. A mecânica é a da fala da fila, mas a ligação feita não tem `FalasNoAr` — um mapa pequeno próprio |
| I8 | Registro da ligação transferida que ninguém pegou | A ligação **foi atendida** (A falou com o cliente): o registro na conversa continua "atendida" com a duração, e o "Ligar de volta" é aberto à parte, com o time da transferência | Dizer "não atendida" seria falso; perder o retorno também |
| I9 | Recuperação | `recuperar()` fecha como `cancelled` (motivo `worker_reiniciou`) toda transferência aberta | §12.2 |
| I10 | Ramal (v3) no navegador | O ramal SIP continua `ramal-<user_id>`. O número (201…) é só **endereço** para humanos: o worker traduz número → user_id pelo banco | Trocar a identidade SIP quebraria o registro de todo navegador aberto no deploy |
| I11 | URA com ramal (v3) | A regra pura ganha o evento `digitos` e o prazo de 2 s entre dígitos; 1 dígito continua opção | §12.2 |

## 2. Dados

### 0290 — `voice_call_transfers` (v2)
- Tabela com `organization_id`, `voice_call_id`, `requested_by`, `from_user_id`, `to_user_id` **ou** `to_team_id`, `kind` (`blind`/`attended`), `status` (`open`/`ended`), `outcome` (`answered`, `returned`, `queue_answered`, `missed`, `refused`, `cancelled`), `reason`, `answered_by`, `created_at`, `ended_at`.
- `unique (organization_id, id)` nova em `voice_calls` (alvo das FKs compostas).
- FKs compostas `(organization_id, voice_call_id)` → `voice_calls`, `(organization_id, to_team_id)` → `attendance_teams`.
- Índice único parcial `(voice_call_id) where status = 'open'`: uma por vez, também no banco.
- CHECKs: alvo exatamente um; `outcome` nulo ⇔ `status = 'open'`; consultada só para pessoa.
- RLS só de leitura (`tenant_isolation_voice_call_transfers_select`), GRANT só de SELECT.

### 0291 — `phone_extensions` (v3)
- `organization_id`, `user_id`, `number` (CHECK `^[1-9][0-9]{1,3}$`), `updated_by`, `created_at`, `updated_at`; `unique (organization_id, number)`, `unique (organization_id, user_id)`.
- `fn_proximo_ramal(org)` — menor número livre a partir de 201 (revogada de `public, anon`).
- Gatilho em `user_organizations` (`security definer`, `pg_advisory_xact_lock` por organização): dá ramal a quem ganha papel de atendimento e tira de quem perde (`viewer` ou `revoked_at`).
- Backfill de quem já existe.
- `voice_calls`: `direction` aceita `internal`; `channel_session_id` perde o `not null` com CHECK `direction = 'internal' or channel_session_id is not null`; `peer_user_id` novo.

## 3. Worker (v2)

1. `portas.ts`: `PortaAri`, `PortaBanco`, `Registro`, `EventoAri` saem de `controle.ts` (fecha o ciclo de tipos `controle` ↔ `fala-no-ar`); `controle.ts` reexporta.
2. `PortaAri` ganha `musicaNaPonte`, `pararMusicaNaPonte`, `tirarDaPonte`; `ari.ts` ganha os três e `emitirEvento` (lado da API).
3. `transferencia.ts` — os caminhos de §12.2: direta para pessoa (toca P → volta a A → fila do time), direta para time (fila D20), consultada (ponte `k-`, completar, voltar, P não atende, A desliga com P na linha / tocando), cliente desliga (`cancelled`), revalidação (`refused`), `recuperar()`.
4. Papéis de canal novos: `transf`, `volta`, `consulta`, `fila` (v2) e `interna` (v3).

## 4. API

- `POST /api/v1/telefonia/chamadas/[id]/transferir` (agent+; dono ou gerente+).
- `POST /api/v1/telefonia/chamadas/[id]/transferencia` `{ acao: completar|voltar }`.
- `GET /api/v1/telefonia/chamadas/[id]` + `transferencia` e `transferida_por`.
- `GET /api/v1/telefonia/diretorio` (pessoas com situação, times com disponíveis).
- v3: `GET /api/v1/telefonia/ramais` (admin), `PATCH /api/v1/telefonia/ramais/[userId]`, `POST /chamadas` com `{ ramal }`, `POST /ramal` devolve `numero`.

## 5. Telas

- Painel: [Transferir] com busca (pessoas e times), [Falar antes], situação da transferência, [Completar transferência]/[Voltar ao cliente], "Transferida por…", "…não atendeu, o cliente voltou".
- Cabeçalho: "Seu ramal: 201"; discador aceita ramal.
- Conexões › Telefone › **Ramais** (admin).
- Menus: interruptor "O cliente pode digitar o ramal".
- Cartão da ligação: a corrente de transferências.

## 6. Prova

- **Nesta sessão:** `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (inteiro), `pnpm test:db` (Postgres efêmero, baseline install + update, invariantes novos).
- **Na VPS (dono):** sonda do evento de usuário, deploy com os dois `-f`, 307, tronco `Registered`; duas contas `agent` em dois navegadores: direta, consultada, não atendeu e volta, para time; ramal para ramal; ramal digitado na URA. Roteiro em `docs/runbooks/telefonia-transferencia-e-ramais.md`.
