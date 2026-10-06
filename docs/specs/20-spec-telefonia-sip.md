---
title: Spec Técnica 20 — Telefonia SIP (PABX no CRM)
parent: 00-prd-master.md
depends_on: 01-spec-platform-base.md, 07-spec-events-workers.md, 18-spec-voice-calls-wacalls.md
version: 0.1
status: em implementação
date: 2026-09-28
owner: Paulo Cesar
related_rules: Linear DYD-10 (requisitos do dono do produto e decisões do §8)
---

# Spec Técnica 20 — Telefonia SIP (PABX no CRM)

> O atendente faz e recebe ligações telefônicas pelo próprio CRM, pelos números SIP que o
> cliente já contratou de uma operadora. Contexto completo, requisitos e o estudo que
> descartou o Zernio: issue **DYD-10** no Linear. Esta spec registra o que foi MEDIDO na
> prova de conceito, as decisões fechadas e o desenho que o código segue.

---

## 1. O que a prova de conceito mediu (F0, 2026-09-28)

Tronco de teste da Totus (`voip.totussistema.com.br`), Asterisk 20.11.1 em contêiner
(Alpine 3.22, `docker/asterisk/`), Docker Desktop num Mac atrás de NAT duplo.

| Medida | Resultado |
|---|---|
| Servidor da operadora | FreeSWITCH. SIP em UDP e TCP 5060 (e 5080). **Sem TLS** (5061 recusa) |
| Registro com usuário/senha | `Registered` na primeira tentativa, expiração 300 s |
| Ligação de saída | `407` → reenvio autenticado → `200 OK` — **mas para o número da PRÓPRIA conta**, dentro da rede da operadora. Não provou a grafia de discagem para fora (linha abaixo) |
| Grafia da discagem de saída (medido depois, em produção, 2026-09-28, para um celular) | `61995140098` (DDD + número, o que o CRM mandava) → `404 Not Found`, `Reason: Q.850;cause=16`, em 0,2 s. `5561995140098` → `480`. `061995140098` (0 + DDD + número) → `183`, tocou, `200 OK`. `995140098` (local) → `183`, tocou. Na Totus a saída precisa do `0`; cada operadora tem a sua regra — daí o prefixo de discagem POR NÚMERO (§6, migration 0287) |
| Codec negociado | **G.711 A-law (PCMA)** e `telephone-event/8000`. A operadora não ofereceu µ-law nem Opus |
| Áudio operadora → nós | Chegou limpo. A transcrição do anúncio da operadora saiu palavra por palavra |
| NAT | Funciona SEM publicar a porta SIP: o `qualify` a cada 25 s mantém o mapeamento do NAT, e a operadora ajusta o RTP para o endereço de onde os pacotes vêm |
| Latência | VPS de produção (HostGator) → operadora: **20 ms**. O Mac de desenvolvimento, em Portugal: 254 ms |
| Configuração em tempo de execução | Pela ARI (`PUT /asterisk/config/dynamic/res_pjsip/{auth,aor,endpoint,registration}/…`), com o `sorcery.conf` mapeando esses tipos para `memory`. O registro de saída criado pela API passa a mandar `REGISTER` sozinho, sem reload |
| Áudio nós → operadora | **Prova indireta:** a operadora passou a mandar RTP para o endereço de origem dos nossos pacotes, o que só acontece se os recebe. A caixa postal não reagiu ao DTMF RFC 4733. A prova direta é o teste de eco (§9) |

**Recursos da VPS de produção:** 2 núcleos, 3,9 GB (2 GB disponíveis), carga ~0. UFW ativo,
permitindo só 22022, 80 e 443. Cada porta publicada pelo Docker custa um `docker-proxy` de 2 a 5 MB,
por isso a faixa de RTP é pequena e só IPv4 (§4.3).

## 2. Decisões fechadas

Recomendações do §8 da DYD-10, aprovadas pelo dono em 2026-09-28, mais o que ele acrescentou.

1. **As credenciais SIP são cadastradas pela tela, e cada organização pode conectar vários
   números.** Nada de `.env` por número. A senha fica cifrada no banco e nunca volta para o
   navegador.
2. **"Menos ligações no dia" conta ligações RECEBIDAS e ATENDIDAS**, no fuso da
   organização — quem liga muito para fora não passa a receber menos por isso. Empate: vai
   para quem está há mais tempo sem atender.
3. **Toque de 20 s por atendente e 2 voltas** pela lista de disponíveis.
4. **Ninguém disponível dentro do horário:** fila com música, conferindo a disponibilidade de
   novo a cada poucos segundos, por até 2 min (o padrão: desde a migration 0295 a espera
   máxima é de cada time, de 30 s a 30 min — §4.2). Esgotado o prazo, a ligação é encerrada e vira
   chamada perdida na Central. A mensagem falada apontando o WhatsApp entra com a URA (F2),
   porque exige áudio em português configurado pela organização.
5. **Uma conversa de telefone por contato e por número.** Cada ligação é um registro dentro
   dela.
6. **Conversa de texto aberta não impede receber ligação.** Só impedem: pausa, offline, fora
   do horário do time e já estar em outra ligação.
7. **Imagem do Asterisk própria, publicada pelo CI** (`deskcomm-asterisk`), a partir do pacote
   do Alpine, que é GPL e tem o código-fonte disponível no próprio Alpine. Nenhum binário
   compilado por nós.

## 3. Vocabulário (doutrina de canal)

| | Valor | Onde |
|---|---|---|
| Provider (transporte) | `sip_trunk` | `channel_sessions.provider`. Só se escreve dentro de `lib/channels/` |
| Meio | `phone` | `conversations.channel`. A feature lê por `meioDoCanal()` |
| Capacidade | `sip_trunk` entra em `PROVIDERS_SEM_MENSAGEM` | `lib/channels/capabilities.ts` |

O `_` no nome do provider segue a regra do chat do site: o guardrail de vocabulário interno
barra todo nome de provider na fala do agente, e "sip" solto barraria uma palavra comum.

## 4. Arquitetura

```
Operadora SIP ◄──SIP/UDP (registro de saída, sem porta aberta)──► Asterisk ◄──ARI (HTTP+WS, rede interna)──► worker do CRM
                ◄──RTP (G.711)───────────────────────────────────►    ▲                                          │
                                                                        │ WSS /telefonia/ws (Caddy → asterisk:8088) │ Supabase (voice_calls,
Navegador do atendente (JsSIP) ─────────────────────────────────────────┘                                          │ conversas, Central)
                ◄──DTLS-SRTP (Opus/G.711), UDP na faixa publicada────► Asterisk                                    ▼
```

### 4.1 Quem manda em quê

- **O CRM é a fonte da verdade da configuração.** Números (troncos) moram em
  `channel_sessions` com a senha cifrada. Três caminhos levam o tronco ao Asterisk, do mais
  rápido ao mais garantido (`lib/channels/telefonia/sincronizacao.ts`): a rota que salva o
  número o empurra pela ARI na mesma requisição (`empurrar.ts`, que nunca lança); o worker
  reconcilia a cada 60 s; e a cada (re)conexão à ARI faz a sincronização completa. Não há
  evento no `event_log` para isso — a primeira versão desta spec previa um
  (`telefonia.tronco_alterado`), e o código não o usa. Editar RECRIA o tronco (apaga e grava):
  um registro de saída que só recebe PUT por cima seguia registrando com a configuração
  antiga. O Asterisk guarda tudo em memória: se ele reinicia, o worker percebe a queda do
  WebSocket e sincroniza de novo, e o navegador, com a credencial do ramal recusada, pede
  outra.
- **O worker não confia na linha do banco.** `channel_sessions` também é gravável pela REST,
  fora do Zod da rota, e o valor vira campo PJSIP cru (o `contact` da AOR é uma lista: uma
  vírgula no servidor injetaria um segundo contato). Antes de empurrar, o tronco passa por
  `problemaDoTronco` (`pjsip.ts`), com a MESMA régua da rota (`conta-sip.ts`); o que não
  passa não vai para o Asterisk, a linha fica `FAILED` / `configuracao_invalida` e, se uma
  versão válida anterior ainda estava registrada, ela é retirada.
- **O CRM decide quem toca.** Distribuição, horário, pausa e registro são do worker, que é
  uma aplicação Stasis (`crm`). O Asterisk só carrega o áudio.
- **O ramal do navegador não disca nada sozinho.** A credencial é temporária, emitida pelo
  CRM a cada sessão do atendente e empurrada pela ARI. O contexto do ramal só entrega a
  ligação ao Stasis, e o worker só liga para fora quando existe uma `voice_calls` de saída
  criada pela API para AQUELE atendente, há menos de 60 s. Isso vale como antifraude: uma
  senha de ramal vazada não disca para número nenhum.

### 4.2 Fluxos

**Recebida**
1. A INVITE da operadora chega no endpoint `tronco-<channel_session_id>`, que tem
   `context=de-tronco` e `Stasis(crm,entrada)`. Ela casa esse endpoint pelo parâmetro `line`
   que o próprio registro anunciou (`line=yes` + `endpoint` na registration), e SÓ por ele: o
   endpoint do tronco tem `identify_by=ip` e nenhum objeto `identify`. Medido em 2026-09-28
   num Asterisk 20 com os objetos de `objetosDoTronco`: com o padrão `identify_by=username,ip`,
   uma INVITE forjada com `From: <sip:tronco-<id>@…>` casava o tronco pelo nome, era atendida
   sem senha e o `P-Asserted-Identity` inventado virava o número do cliente
   (`trust_id_inbound=yes`); com `identify_by=ip`, a mesma INVITE leva 401, e uma recebida
   real da operadora (R-URI `sip:…;line=aqsytoa`) continua caindo em `tronco-<id>`.
2. O worker resolve o tronco, e com ele a organização e o time de destino. Depois acha ou
   cria o contato (`phoneLookupVariants`), acha ou cria a conversa `phone`, e cria a
   `voice_calls` (`provider=sip_trunk`, `direction=inbound`, `status=ringing`).
3. **Escolhe o atendente**, funções puras `ordemDeToque` / `proximoToque` em
   `lib/telefonia/distribuicao.ts`. Candidatos: `disponiveisNoTime`
   (`lib/channels/telefonia/repositorio.ts`), com as mesmas peças do rodízio de conversas —
   membro do time com papel de atendimento, `is_available` (pausa e heartbeat vencido o
   zeram), horário do time e o próprio — menos o teto de conversas (§2.6), menos quem está em
   outra ligação de qualquer canal de voz, e só quem tem o ramal registrado agora. Ordem:
   menos RECEBIDAS atendidas hoje no fuso da organização, e no empate quem está há mais tempo
   sem atender.
4. Toca um ramal por vez (`POST /channels` para `PJSIP/ramal-<userId>`, 20 s). Se o
   atendente atende, entra numa ponte com a perna da operadora. Se não atende, recusa ou cai,
   passa para o próximo. São 2 voltas.
5. Ninguém disponível: `answer` + música em espera, reavaliando a cada 5 s, até a espera
   máxima do time (2 min por padrão; ver "fila visível, entrega 2" abaixo).
6. Fim: `ended`, duração, registro na conversa (na recebida ATENDIDA o registro já nasceu ao
   atender, "em andamento", e o fim o completa — §5), atividade no lead. Perdida vira
   `agent_inbox_items` `voice_call_missed`, cujo texto nomeia o time que ficou com a ligação
   ("Ninguém do time X atendeu. Ligue de volta pela conversa."), no idioma da organização —
   desde a fase 2, para TODA perdida, e não só a que passou por menu.

**Recebida com a fase 2, versão 1 (URA e falas, migration 0288).** O desenho inteiro está em
[`docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`](../superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md)
(§4 e §5); o que muda nos passos acima:
- O número aponta para um time **ou** para um menu (`channel_sessions.sip_menu_id`, CHECK:
  nunca os dois). Com menu, o worker atende e entrega a ligação à URA, uma regra pura
  (`lib/telefonia/ura.ts`): a tecla escolhe o time; o silêncio e a tecla errada repetem o
  menu, que toca no máximo 3 vezes, e depois vai ao time padrão (`default_no_input` ou
  `default_invalid`). A conversa acompanha o time escolhido, salvo se já tem atendente humano.
- Na fila do time, antes do passo 3: fora do horário com a fala pronta → a fala e desliga
  (`end_reason = after_hours`, sem aviso na Central; sem a fala, segue como acima); aviso de
  instabilidade vigente → tocado inteiro. No passo 5, "aguarde" a cada ~40 s entre a música;
  esgotou → "ninguém atendeu" e desliga.
- **Enquanto um ramal toca (passo 4), quem ligou ouve o SOM DE CHAMANDO, nunca o "aguarde"**
  (DYD-52, desde a 1.50.2). Ligação ainda não atendida: o chamar da operadora (o 180 de
  `indicarChamando`). Ligação já atendida — pela URA, pelo aviso, ou pela régua dos 45 s e pela
  2ª volta, que atendem para a rede não derrubar a ligação que só chama —: o tom
  `tone:ring;tonezone=br` em banda no canal do cliente (`tocarTom`, o mesmo da ligação feita,
  item 5 abaixo), UM só do primeiro ramal ao último, sem recomeçar ao trocar de atendente. Ele
  para antes da ponte, do "aguarde" (a lista esvaziou), do "ninguém atendeu" e do fim da
  ligação, e o fim do playback dele nunca é lido como fim de fala. O "aguarde" e a música são só
  de quem não tem ninguém livre; quem já está com música segue com ela quando alguém fica livre,
  e o "aguarde" dos ~40 s não fala enquanto esse ramal toca — rearma e fala no ciclo seguinte,
  se a lista tiver esvaziado. Se o Asterisk não tocar o tom (`failed`, ou o tom que acaba
  sozinho em menos de 2 s três vezes seguidas), entra a música no lugar — nunca o "aguarde". Até a 1.50.1, a
  ligação atendida pela URA ouvia "Todos os nossos atendentes estão ocupados…" com o ramal do
  atendente tocando (medido em produção: o atendente atendeu em 16 s). Prova do som na VPS
  pendente (J36.7 do mapa de jornadas).
- As falas são arquivos μ-law no volume `telefonia-falas` (`/var/lib/telefonia/falas`), que o
  worker copia do Storage e o Asterisk lê só leitura. **A ligação nunca chama a ElevenLabs**:
  só a prévia da tela sintetiza (D15, vigiado por
  `tests/unit/ligacao-nunca-chama-elevenlabs.test.ts`). Fala sem arquivo é pulada e vira
  `phone_prompt_unplayable` na Central.

**Recebida com a fila visível, entrega 2 (migration 0295).** Desenho:
[`docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md`](../superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md)
(§4.2, com as emendas); plano:
`docs/superpowers/plans/2026-10-06-telefonia-fila-visivel-entrega-2.md`. A fila deixa de
viver só na memória do worker: o que a tela precisa ver vai para `voice_calls`, e a fila
passa a seguir a ordem de chegada. O que muda nos passos acima:
- **A ordem de chegada** é `voice_calls.queued_at`: o instante em que a ligação passou a
  esperar por uma PESSOA — a primeira vez que os toques começam (`comecarOsToques`), depois
  do menu, do aviso de instabilidade e do aviso de gravação. `marcarNaFila` usa `coalesce`:
  chamada de novo, não move o instante. O worker guarda o mesmo instante em memória
  (`entrouEm`), e a rota ordena por ele. Gravar não pode parar a fila: se o banco falha, a
  ligação segue e só perde a posição na tela (aviso no log).
- **A vez.** Função pura `eAVezDela(naFrente, livres)` em `lib/telefonia/distribuicao.ts`:
  com `n` atendentes livres, só as `n` ligações mais antigas DO TIME que esperam — sem ramal
  tocando — podem tocar; as outras seguem no ramo `esperar` de `tocarProximo` (música e
  teto). É o bloco "A VEZ" de `tocarProximo`, que conta quem espera por
  `esperandoNoTime`. Antes, quem pegava o atendente que desocupava era a ligação cujo relógio
  de 5 s disparasse primeiro, não a que esperava há mais tempo. A ligação que voltou do ramal
  digitado no menu e ainda ouve o aviso de instabilidade ou o de gravação já tem a hora de
  chegada, mas não conta na vez até a fala acabar (o "aguarde" conta: ela está esperando de
  verdade); sem isso, um atendente livre ficaria parado com outra ligação esperando atrás dela.
- **A reavaliação ao fim de uma ligação.** Quando uma ligação acaba (`finalizar`), quem espera
  na organização é reavaliado 2 s depois (`REAVALIAR_APOS_O_FIM_MS`), da mais antiga para a
  mais nova, em UMA passada por organização — com uma já agendada, o fim de outra ligação
  não agenda outra, e sem ninguém esperando não se agenda nada. O disparo entra pela fila
  serial do laço, como os outros relógios. Não é "na hora" de propósito: 2 s dá tempo de o
  BYE chegar ao navegador do atendente que acabou de desligar (ele recusa com 486 o toque que
  chega com a sessão anterior ainda aberta, e a recusa gasta a vez dele na volta) e junta as
  ligações que acabam em rajada, o pico de uma queda de internet, em vez de reler os
  disponíveis a cada uma delas. Dentro da passada há um corte por time: se a ligação avaliada
  continuou esperando, as mais novas do MESMO time são puladas, porque a lista de livres é a
  mesma. O relógio de 5 s de cada ligação continua, como rede de segurança para o que não
  gera evento (alguém saiu da pausa). E a ligação nunca fica sem relógio: se o Asterisk não
  atender o cliente para segurá-lo na linha, ou não tocar o som de chamando, o worker avisa no
  log e a fila segue — sem isso a ligação ficava parada, só o cliente desligando a tirava da
  memória, e ela seguraria a vez do time.
- **O teto por time.** `attendance_teams.phone_queue_max_wait_seconds` (30 a 1800 s; nulo =
  120 s, o de sempre) é a espera máxima SEM NINGUÉM LIVRE daquele time. É lido na ENTRADA da
  fila (`timeParaAFila` devolve `esperaMaximaS`) e vira `tetoMs` da ligação, por
  `esperaMaximaMs` (que prende o valor aos limites e trata dado ruim como o padrão): mudar a
  configuração vale para a próxima ligação, nunca para quem já espera. Número sem time não
  tem teto configurável: valem os 120 s. A fila da transferência para um time
  (`transferencia.ts`) NÃO mudou: segue com os 120 s fixos (`ESPERA_NA_FILA_MS`).
- **O "cai em".** `marcarPrazoDaFila` grava `voice_calls.queue_deadline_at` quando a espera
  sem ninguém livre começa: o `now()` do BANCO mais o que falta no relógio do worker (o
  desenho da 0294, para a conta não depender de os dois relógios baterem). Só `marcarAtendida`
  o apaga; a rota o devolve (`cai_em`) apenas na fase `aguardando`. Quem derruba a ligação no
  teto é o relógio do worker, não a coluna: ela só alimenta a tela.

**Feita**
1. `POST /api/v1/telefonia/chamadas` com `{ contact_id | numero, numero_da_empresa_id? }`. A
   rota valida papel, número (§6) e tronco, cria a `voice_calls` (`outbound`, `starting`,
   `owner_user_id` = quem ligou), atribui a conversa `phone` a quem ligou e devolve
   `{ id, destino: "c-<id>", contact_id }`.
2. O navegador disca `c-<id>` pelo JsSIP. O endpoint do ramal entra no Stasis com esse
   ramal, e o worker confere dono, idade e estado.
3. O worker cria a perna da operadora (`PJSIP/<prefixo><numero>@tronco-<id>`, bina = número
   do tronco; `<prefixo>` é o `sip_dial_prefix` DESTE tronco, vazio por padrão, e
   `<numero>` é DDD + número já julgado pela política do §6), põe as duas pernas numa ponte
   ANTES de discar (o atendente ouve o chamar e os anúncios da operadora) e disca. O destino
   sai de `enderecoDeSaida` (`pjsip.ts`), que recusa prefixo fora da régua: a ligação acaba
   como `tronco_configuracao_invalida` sem discar.
4. **Fim sem ninguém atender** (`lib/telefonia/fim-da-saida.ts`). Medido num Asterisk
   20.11.1 local, com uma operadora falsa respondendo `100` + `404` com
   `Reason: Q.850;cause=16` (o que a Totus fez): a ARI entrega `ChannelHangupRequest` SEM
   causa, `StasisEnd` (sem causa) e `ChannelDestroyed` com cause 16 "Normal Clearing", e
   nenhum `Dial` com status final. A causa sozinha não separa "a operadora recusou" de "acabou
   normal"; o que separa é a perna nunca ter tocado (nenhum `Dial` RINGING/PROGRESS). Regra:
   cause 17 → `ocupado_17`; nunca tocou, ou causa de recusa (1, 3, 20, 21, 22, 27, 28, 34, 38,
   41, 42, 47, 58, 88, 102, 111, 127) → desfecho `recusada_pela_rede`, motivo
   `nao_completada_<causa>`; tocou e acabou → `sem_resposta_<causa>`. O motivo vai para
   `voice_calls.end_reason`, e a tela do atendente o lê (§7). Até a 1.48.0 o `StasisEnd`, que
   chega primeiro e não tem causa, era lido como se tivesse: a recusa da Totus virou
   `sem_resposta` com motivo `rede_undefined`, e a tela não mostrou nada. Medido de ponta a
   ponta com o `ControladorDeChamadas` de verdade contra esse Asterisk (ARI real, banco em
   memória, um ramal SIP falso discando `c-<id>`): o controlador da 1.48.0 reproduz o log de
   produção inteiro (`sem_resposta`, `rede_undefined` e o `Playback failed` do item 5); o
   novo grava `recusada_pela_rede` / `nao_completada_16`, sem o aviso; e com prefixo `0` no
   tronco a operadora recebe `INVITE sip:061995140098@…`.
5. **O chamar local** (`tone:ring;tonezone=br`, tabela `[br]` do `indications.conf`) toca no
   ramal da ponte até a operadora mandar áudio próprio (PROGRESS) ou atender. Medido no mesmo
   Asterisk local: a URI e a tabela funcionam, dentro e fora da ponte — a gravação do outro lado
   do canal tem 425 Hz por 1 s e 4 s de silêncio. O aviso `Playback failed for
   tone:ring;tonezone=br` do log de produção aparece SÓ quando o canal é derrubado com o tom
   ainda tocando (parado pela ARI, o mesmo tom termina `done`) — era o que acontecia na recusa
   em 0,2 s. O controlador para o tom antes de derrubar os canais. **Não medido:** o chamar
   num ramal de navegador de verdade (WebRTC, Opus, DTLS) — o local usou canal `Local`.
6. **Quanto o telefone do cliente chamou** (migration 0294). A feita que ninguém atendia virava
   o mesmo registro "Ligação sem resposta" para quem deixou chamar até a rede desistir e para
   quem deu um toque e desligou, e o toque servia de "tentei ligar". O controlador guarda o
   instante do PRIMEIRO `Dial` RINGING (180) ou PROGRESS (183) — o repetido não zera — e, no
   fim, entrega "há quanto tempo foi" a `encerrarLigacao`, que grava
   `voice_calls.peer_ringing_at` como o `now()` do banco menos esse tempo, na mesma escrita que
   fecha a ligação: `ended_at - peer_ringing_at` é o que o worker mediu, sem depender de o
   relógio da VPS bater com o do banco. `registrarNaConversa` projeta o tempo no registro
   (`toque_ms`) só da feita NÃO atendida, e o `end_reason` já diz quem encerrou:
   `atendente_desligou` (quem ligou desistiu) ou `sem_resposta_<causa>` (a rede desistiu — a
   operadora, ou o nosso prazo de 60 s). Sem o primeiro toque, a coluna fica nula e o registro
   sai sem tempo de toque: o cartão nunca mostra um tempo que ninguém mediu. O tempo é lido no
   instante em que a ligação acaba, ANTES do desmonte (parar o tom, derrubar os canais e a
   ponte espera a ARI, até 5 s por pedido). O registro leva também `tentativa_ms`, do pedido
   (`started_at`, o clique em "Ligar") ao fim: é o que o cartão conta de quem desligou quando a
   rede não avisou que o telefone chamava — quem esperou 40 s não fica igual a quem desligou em
   1 s. A ligação que cai na caixa postal do cliente é ATENDIDA para a rede (`ANSWER`) e segue
   como "Ligação feita", com gravação — o sistema não separa pessoa de caixa postal.
7. **O pedido que não chegou a ser discado.** Se a ARI ou o banco falham no meio de
   `novaFeita` (depois de o ramal entrar na ponte e antes do `dial`), a ligação fica viva sem
   nunca ter saído, e o atendente espera e desliga. O controlador marca `discou` só depois do
   `dial` aceito; sem a marca, o fim vira desfecho `recusada_pela_rede` com motivo
   `saida_nao_discada` — "Ligação não completada" na conversa e "Não foi possível fazer a
   ligação agora. Tente de novo." para quem ligou —, e não "sem resposta · desligada por quem
   ligou". Derrubar o ramal na hora da falha, em vez de esperar o atendente desligar, segue
   por fazer.

### 4.3 Rede e empacotamento

- Serviço `asterisk` no `docker-compose.prod.yml`, `profiles: ["telefonia"]` (desligado por
  padrão), imagem `ghcr.io/paulocmbcosta/deskcomm-asterisk`, rede `internal`.
- **Ligar numa instalação que já existe:** `telefonia` em `COMPOSE_PROFILES` e
  `TELEFONIA_ARI_URL=http://asterisk:8088` no `.env`, depois `bash hostgator-setup-kit/update.sh`.
  O script sobe o Asterisk **mesmo sem versão nova**: com o profile ligado, `image_desatualizada`
  acusa o `.env` sem `ASTERISK_IMAGE` (ou fixado em outra versão) e o contêiner do Asterisk
  ausente ou em outra versão — este, só com o app no ar, para não subir uma stack parada de
  propósito. A imagem e a senha da ARI vão para o `.env` antes do `pull` e do `up -d`. Vigiado
  por `tests/shell/update-guard.test.sh`, caso 14. **O kit que decide é o da versão instalada:**
  até a 1.48.0 ele respondia "Nada a atualizar" e o Asterisk nunca subia — ali a saída é
  `update.sh --force`. Para saber qual kit está no disco:
  `grep -c conteiner_da_telefonia_fora_do_alvo hostgator-setup-kit/_common.sh` (`0` = anterior à
  correção).
- **Nenhuma porta SIP publicada.** Só troncos com registro, cuja sinalização entra pelo
  mapeamento de NAT do próprio registro. Tronco por IP (sem registro) fica fora desta versão.
- **Faixa RTP publicada**: `TELEFONIA_RTP_INICIO`–`TELEFONIA_RTP_FIM`, padrão
  `20000-20039/udp`, só IPv4. Com rtcp-mux no ramal, dá ~10 ligações simultâneas. A porta
  publicada pelo Docker não passa pelo UFW, como a 7881 do WaCalls.
- ICE do navegador: o `rtp.conf` anuncia o IP público no lugar do IP do contêiner, pelo
  `ice_host_candidates`. O IP vem de `TELEFONIA_IP_PUBLICO` e, vazio, é detectado pelo
  `docker/asterisk/entrypoint.sh` do próprio contêiner (ipify) a cada partida — o kit não
  grava essa variável. Venha de onde vier, o valor tem de ser um IPv4 canônico, ou o contêiner
  não sobe e diz por quê: ele vai cru para o `pjsip.conf` e o `rtp.conf`
  (`tests/shell/asterisk-entrypoint.test.sh`).
- WSS do ramal: o proxy só entrega `/telefonia/ws` a `asterisk:8088/ws` depois de perguntar
  ao app — `forward_auth` no Caddyfile, middleware `forwardAuth` no
  `docker-compose.traefik.yml` — em `GET /api/v1/telefonia/ws/autorizar`. A rota responde 204
  só para sessão de papel `agent` ou acima vinda do próprio site (`Origin`), e 401/403 no
  resto. Antes disso, qualquer anônimo da internet abria um WebSocket SIP com o Asterisk
  (medido com Caddy 2.11.4 e o Caddyfile do repo: sem o `forward_auth`, o anônimo recebia 101;
  com ele, 401, e a sessão válida segue recebendo 101). A ARI (`/ari`) nunca é roteada para
  fora.
- **A rota de autorização NUNCA renova a sessão.** A resposta dela volta para o proxy, que não
  repassa `Set-Cookie` ao navegador: uma renovação ali trocaria o refresh token no GoTrue e
  perderia o novo, e o reúso do velho revogaria a sessão do atendente. Por isso ela não usa
  `requireRole` e está em `PUBLIC_PATHS` (o `proxy.ts` também renovaria): lê o token de acesso
  do cookie como dado, recusa com 401 só a sessão já vencida (o app renova pelo caminho
  normal e o JsSIP reconecta; token perto de vencer é aceito, porque nada ali renova e o GoTrue
  confere o `exp`) e valida o token com `getUser(token)`, num cliente sem
  refresh token. A regra de papel é a de `requireRole` — mesma consulta e ordem de vínculos,
  mesmo cookie `active_org`, `fn_user_role_in_org`, dívida de MFA — e acompanhamento de
  suporte é recusado (`lib/auth/sessao-sem-renovar.ts`). No Traefik o endereço é o domínio
  público, não `app:3000`: em modo host o nome não resolve, e numa rede compartilhada outra
  stack pode ter um serviço `app`.
- Segredo da ARI: `TELEFONIA_ARI_PASSWORD`, gerado pelo kit como os segredos da voz.
  Variável ausente = telefonia desligada, sem erro.

## 5. Dados (migration 0286)

- `channel_sessions`: `provider` aceita `sip_trunk`. Colunas `sip_server`, `sip_port`
  (padrão 5060), `sip_transport` (`udp` | `tcp`), `sip_username`,
  `sip_password_encrypted` (pgcrypto, via `fn_encrypt_oauth`, como o token da Meta) e
  `sip_team_id` (time que recebe as ligações). `provider_ref_check`: `sip_trunk` exige
  servidor e usuário. O número exibido é o `phone_number` de sempre, único por organização
  **entre os troncos ativos** (`channel_sessions_sip_phone_per_org_unique`, migration 0292).
  A trava é por MEIO: o mesmo número pode ser telefone e canal de mensagem ao mesmo tempo —
  o fixo da empresa que atende pelo WhatsApp oficial e é a linha de voz na operadora. Até a
  0292 o tronco dividia a trava dos canais de mensagem, e a tela recusava esse caso como
  número repetido. E `(lower(sip_server), sip_username)` é único entre os ativos da instalação
  inteira: duas linhas registrando a mesma conta disputariam as ligações recebidas.
- `voice_calls`: ganha `provider` (`wacalls` | `sip_trunk`, padrão `wacalls`),
  `sip_call_ref` (id da ligação no Asterisk), `conversation_id`, `team_id` e
  `ringing_user_id` (para quem a recebida está tocando agora). O `wacalls_call_id` passa a
  aceitar nulo, e um CHECK exige a referência certa por provider. Unique
  `(organization_id, sip_call_ref)`.
- `conversations.channel` aceita `phone`.
- O registro da ligação na conversa é uma `messages` `type=system`, `sent_via=system`,
  `direction=outbound`, `status=sent`, `external_id = ligacao:<voice_call_id>` (entra uma
  vez só), com `metadata.voice_call` (`id`, `direcao`, `desfecho`, `duracao_ms`,
  `atendente_id`, `atendente_nome` e, desde a fase 2, `motivo` — o `end_reason`, que com
  `after_hours` muda o cartão —, `menu` e `ouviu_aviso`; desde a 0294, `toque_ms` na feita
  não atendida — por quanto tempo o telefone do cliente chamou, lido por
  `comoAcabouASaidaSemResposta`, em `lib/telefonia/fim-da-saida.ts`, e ausente quando ele não
  chamou —, e `tentativa_ms`, do pedido ao fim). A conversa só desenha o cartão para o REGISTRO
  da ligação (`ligacaoDoRegistro`: o `external_id` tem de ser `ligacao:<id>` do próprio
  metadado, que só o sistema escreve — trigger da 0289): uma mensagem comum com
  `metadata.voice_call` plantado pela REST não vira cartão. `menu` é nulo quando a ligação não
  passou por menu; senão segue o schema `MenuDaLigacao` de `lib/telefonia/vocabulario.ts`:
  `nome` do menu e `time_nome` DAQUELA hora (renomear ou arquivar depois não reescreve a
  história), `desfecho` (`chosen` / `default_no_input` / `default_invalid`, nulo quando a
  URA não decidiu), `tecla` e `desligou` (o cliente desligou no menu). Quem escreve é
  `registrarNaConversa` (`lib/channels/telefonia/repositorio.ts`); quem lê o menu passa
  SEMPRE por `menuDaLigacao`, que devolve `null` para registro malformado em vez de contar
  uma história errada — nunca pelo path cru. Os campos da fase 1 não mudaram. Não é `inbound`
  de propósito: `inbound` emite `message.received`, que acorda o agente de IA e o termômetro
  de espera.
- **O cartão em andamento (fila visível, entrega 1; sem migration).** Na recebida, o registro
  não espera o fim: `abrirCartaoDaLigacao` o cria quando o atendente atende — depois de
  `atribuirConversa`, que reabre a conversa encerrada e abre o atendimento novo —, com
  `metadata.voice_call.em_andamento = true` e `desfecho = "atendida"` (não um desfecho novo: a
  aba que não recarregou leria "não atendida" e mostraria "Ligação perdida" durante a ligação),
  o texto "Ligação em andamento com <nome>" e o `last_message_at` da conversa, a coluna pela
  qual o Inbox ordena — é o que a leva ao topo de Minhas, com um atendimento aberto onde o
  atendente já pode escrever nota interna. A função é idempotente: chamada de novo — a
  transferência passa a ligação a outra pessoa — só troca o nome de quem está com ela. Ela NÃO
  mexe no time da conversa: a de quem já ligou antes segue com o time do atendimento anterior
  (trocá-lo ali gravava "Transferida para a fila do time… Aguardando operador disponível" na
  linha do tempo de uma ligação já atendida; o conserto pede migration). No fim, `registrarNaConversa` COMPLETA a mesma mensagem (mescla
  `metadata.voice_call` no banco e tira `em_andamento`), e o cartão já fechado não é reescrito.
  A passada de 60 s do telefone fecha o cartão que ficou "em andamento" com a ligação já
  encerrada (`consertarCartoesOrfaos`: recebida atendida, encerrada há mais de 1 minuto e há
  menos de 24 h). A perdida não muda — nunca teve cartão aberto, e o registro entra no fim,
  como sempre —, e a feita não ganha cartão em andamento. Desenho:
  `docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md` (§4.1); plano:
  `docs/superpowers/plans/2026-10-06-telefonia-fila-visivel-entrega-1.md`.
- **A fila visível (fila visível, entrega 2; migration 0295).** Três colunas, todas nulas e sem
  default, sem backfill — ligação anterior não tem ordem de chegada, e time sem configuração
  segue no padrão:
  - `voice_calls.queued_at` (`timestamptz`): quando a recebida passou a esperar por uma
    pessoa, a ORDEM DE CHEGADA da fila (§4.2). Nulo no menu e nos avisos.
  - `voice_calls.queue_deadline_at` (`timestamptz`): quando a espera sem ninguém livre
    esgota — o "cai em" da aba —, gravado como o `now()` do banco mais o que falta no relógio
    do worker. Só a tela o lê; quem derruba a ligação é o relógio do worker.
  - `attendance_teams.phone_queue_max_wait_seconds` (`integer`): a espera máxima na fila do
    telefone DESTE time, em segundos. Nulo = o padrão, 120. Quem grava é a rota de
    Configurações › Times, pela conexão do app (a tabela só tem GRANT de leitura para
    `authenticated`); quem lê é o worker, na entrada da fila do time.

  CHECK `voice_calls_fila_so_no_telefone_check`: só a linha `sip_trunk` pode ter as duas
  primeiras (a mesma regra da 0288, da 0289 e da 0294: a linha do WaCalls a REST escreve com
  o JWT do atendente, e ninguém forja por ela uma ligação "na fila"). CHECK
  `attendance_teams_phone_queue_max_wait_check`: nulo ou entre 30 e 1800. Dois índices
  parciais para a leitura da aba: `idx_voice_calls_recebidas_vivas` (`organization_id,
  started_at`, recebida não encerrada) e `idx_voice_calls_perdidas_recentes`
  (`organization_id, ended_at desc`, recebida encerrada sem ser atendida). O bloco do
  `baseline.sql` é idempotente e se cura sozinho (linha do WaCalls com a coluna preenchida e
  tempo fora de 30–1800 são corrigidos ANTES de o CHECK ser criado). Cobrado em
  `tests/invariants/telefonia-fila-visivel-schema.test.ts` (colunas, CHECKs, índices, a REST
  que não escreve, a autocura e a cadeia de migrations),
  `tests/invariants/telefonia-fila-visivel-repositorio.test.ts` (o SQL do worker, com duas
  organizações) e `tests/invariants/telefonia-espera-do-time.test.ts` (o SQL do teto).
- **Fase 2, versão 1 (migration 0288):** `phone_prompts` e `phone_settings` (as falas e a
  voz), `phone_menus` e `phone_menu_options`, `channel_sessions.sip_menu_id`,
  `attendance_teams.phone_emergency_*`, `voice_calls.menu_id` / `menu_digit` / `menu_outcome`
  / `emergency_heard_at`, e o bucket privado `phone-prompts`. RLS `_select` e FK composta
  `(organization_id, coluna)` em toda referência nova. Colunas e razões no §3.1 do desenho.

## 6. Política de número (antifraude)

`lib/telefonia/numero.ts`, função pura e testada:
- Normaliza para E.164 brasileiro (`+55` + DDD + número). Aceita as grafias locais
  (`(61) 3686-1503`, `061…`, `0xx61…`).
- **Bloqueia por padrão:** internacional (tudo que não é `+55`), `0300`, `0500`, `0900`,
  `0800` e `400x` (sem DDD; os dois últimos valem para CADASTRAR o número da empresa, que é
  onde se recebe, mas não para discar), serviços de 3 e 4 dígitos (`190`, `192`, `193`,
  `100`, `102`…) e números com menos de 10 dígitos.
- A regra é conferida duas vezes: na rota que cria o pedido e, de novo, no controlador, antes
  de discar — sempre sobre o número SEM prefixo.
- **Prefixo de discagem, por número SIP** (`channel_sessions.sip_dial_prefix`, migration
  0287): dígitos (1 a 4) que vão ANTES do DDD na saída — `0`, ou `0` + código da operadora
  (`015`). Vazio = DDD + número. Vem do banco, nunca do que o atendente digitou (um `0`
  digitado é tirado antes de julgar e não soma com o do tronco). A régua
  (`PREFIXO_DE_DISCAGEM`, `conta-sip.ts`) é a mesma no Zod da rota, no CHECK do banco e em
  `enderecoDeSaida` — a coluna é gravável pela REST, e o valor vai cru para o destino PJSIP.
  Fica fora de `problemaDoTronco` de propósito: não é empurrado ao Asterisk, e um prefixo
  ruim não pode derrubar o registro que traz as recebidas.
- Limite de ligações de saída simultâneas por organização (padrão 5) e uma por atendente,
  conferidos na rota (`lib/channels/telefonia/saida.ts`). Pedido que o navegador nunca
  discou expira em 60 s e não prende o atendente.

## 7. Telas

- **Conexões › Telefone** (aba nova em `ConexoesShell`): lista de números com status ao vivo
  (Conectando / Conectado / Falhou + motivo), botão "Adicionar número" (servidor, porta,
  transporte, usuário, senha, número, prefixo de discagem opcional, time que recebe), editar e
  remover. O prefixo aparece no cartão do número quando existe; mudar só ele não pede a senha
  (não é a conta). O botão "Testar"
  previsto aqui não existe ainda: o teste é o próprio estado do registro, que aparece em
  segundos. A senha só é escrita, nunca lida — e editar sem digitá-la só vale enquanto a CONTA
  é a mesma: trocar servidor, porta, transporte ou usuário exige a senha de novo (422
  `senha_obrigatoria_na_troca`), senão editar seria o jeito de mandar a senha guardada para
  outro host. O servidor tem de ser o endereço público da operadora: loopback, faixas privadas
  (10/8, 172.16/12, 192.168/16), link-local (169.254/16), `0.0.0.0`, nome sem domínio e IP em
  grafia não canônica são recusados (`lib/channels/telefonia/conta-sip.ts`). Instalação sem
  telefonia: a aba diz que ela está desligada e o que quem administra o servidor precisa
  fazer.
- **Ramal**: `TelefoniaProvider` no layout do app. Registra o JsSIP quando a organização tem
  número conectado e o usuário é agent ou acima. Mostra o banner de chamada recebida e o
  painel de chamada ativa, com as peças visuais de `components/voice/`. Quando a ligação que
  o atendente FEZ acaba sem ninguém atender, o painel dá lugar a um aviso no mesmo canto
  (`avisoDoFimDaSaida`): "A operadora não completou a ligação. Confira o número e o prefixo
  de discagem do número SIP.", "O número chamado está ocupado.", "Ninguém atendeu." ou o
  número da empresa indisponível/mal configurado. O navegador lê o motivo em
  `GET /telefonia/chamadas/[id]` logo depois do fim — o worker derruba o ramal antes de gravar.
- **Botão Ligar** no cabeçalho da conversa (qualquer meio, se o contato tem telefone) e na
  ficha do contato. **Discador** para número avulso.
- **Conversa `phone`** no inbox: ícone de telefone, compositor só em nota interna (a nota é
  onde o atendente registra o que foi falado), faixa "Para falar com o cliente, ligue" com o
  Botão Ligar, e o cartão da ligação (sentido, quem atendeu, duração, desfecho — e, enquanto a
  recebida atendida acontece, "Ligação em andamento · com Ana · desde 14:32"). Uma resposta
  de texto que escape do compositor é recusada pela API com 422 antes de gravar.
- **A feita que ninguém atendeu** (0294): o selo "Ligação sem resposta" diz quem ligou ("por
  Ana"), e a linha de baixo, quanto o telefone chamou e quem encerrou — "Chamou 4 s · desligada
  por quem ligou", "Chamou 38 s · ninguém atendeu" ou "O número estava ocupado". Quando quem
  ligou desligou sem a rede avisar que o telefone chamava, a linha conta a tentativa:
  "Desligada por quem ligou após 40 s". O registro de antes da 0294 não tem tempo nenhum: diz
  só "Desligada por quem ligou", quando foi o caso. A linha é da feita SEM RESPOSTA; a não
  completada, a atendida e a recebida ficam como eram.
- **A aba Telefone do Inbox** (fila visível, entrega 2; migration 0295; J44 do mapa de
  jornadas). Aba nova no trilho, depois de Automático (`phone`, "Telefone", em
  `lib/inbox/abas.ts`), que não lista conversas: lista LIGAÇÕES. Ela só existe quando a rota
  da fila diz `ativa: true` — a instalação tem telefonia E a organização tem número —, e não
  pelo ramal de quem olha: o `viewer` não tem ramal e a vê. Todo membro que entra no Inbox vê a
  fila de TODOS os times (D4 do desenho), só com nome, número, time e espera; abrir a conversa
  segue a visibilidade que já valia (RLS). O selo do trilho conta quem espera por uma pessoa —
  aguardando, tocando e transferida para a fila de um time — e cobra ação, como Fila e Minhas.
  A coluna (`FilaDoTelefone`, em `components/telefonia/fila/`) toma o lugar da lista de
  conversas, da busca e dos filtros de conversa: chips por time (quantas ligações esperam e há
  quanto a mais antiga espera), o seletor de número da empresa (só com mais de um) e quatro
  seções, cada uma só quando tem linha — "Na fila, por ordem de chegada" (aguardando, tocando e
  a transferida), "No menu" (menu e avisos), "Em ligação" e "Perdidas nos últimos 30 minutos".
  A linha diz a posição (`1º`, `2º`…), o nome ou o número, o time, "pelo <número da empresa>" e o
  estado: "Aguardando há 3:42 · cai em 1:18" — em atenção quando passou da metade do teto DO
  TIME, em crítico quando falta menos de 20% —, "Tocando para Ana", "Ouvindo as opções", "Com
  Bruno há 4:12", "Transferida por Ana". Clicar numa linha com conversa a abre à direita, pelo
  caminho de sempre; a perdida traz o motivo, quanto esperou e há quanto tempo, e o botão de
  ligar (`BotaoLigar`, que some para quem não tem ramal). A transferida para a fila de um time
  (v2) aparece na fila do time de DESTINO, com quem transferiu, sem posição e sem ação. A
  leitura é uma só (`useFilaDoTelefone`, chamado uma vez no `InboxLayout`: o selo e a coluna saem
  da mesma resposta): relê quando o Realtime de `voice_calls` avisa — uma rajada vira UMA
  releitura — e, de segurança, a cada 15 s; os relógios andam sozinhos, medidos pelo relógio do
  banco que a resposta traz. A releitura que falha mantém a fila antiga e acende uma faixa "Sem
  atualização no momento", com "Tentar novamente". Telefonia desligada: nada é lido nem assinado,
  e as outras abas ficam como sempre foram.
- **`GET /api/v1/telefonia/fila`** (`viewer`+; a leitura da aba). A organização sai da sessão e
  entra em toda consulta — a conexão é a do app, fora da RLS (`lerFilaDoTelefone`,
  `lib/channels/telefonia/fila-da-tela.ts`). Devolve `ativa`; `agora` (o relógio do banco, para a
  tela medir a defasagem do relógio dela); `times` (id, nome e a espera máxima em vigor, só os
  ativos); `numeros` (os números SIP ativos da organização, para o filtro); `ligacoes` e
  `perdidas`. `ligacoes` são as recebidas pelo telefone ainda vivas (`status <> 'ended'`, iniciadas
  há menos de 4 h): `fase` (`menu`, `avisos`, `aguardando`, `tocando`, `em_ligacao`,
  `transferencia_na_fila`, por `faseDaLigacao`, em `lib/telefonia/fila.ts`), contato, número de
  quem liga, time, número da empresa, conversa, `entrou_em`, `na_fila_desde`, `posicao` (1 = a
  próxima do time; só em `aguardando` e `tocando`), `cai_em` (só em `aguardando`),
  `tocando_para`, `com` (quem atende, ou quem transferiu) e `atendida_em`. `perdidas` são as
  recebidas encerradas sem atender nos últimos 30 minutos (até 100, da mais recente), com o motivo
  — `desligou_no_menu`, `desistiu_na_fila`, `fila_esgotada`, `ninguem_atendeu`,
  `fora_do_horario`, `interrompida` ou `outro` — e quanto esperaram. Sem telefonia na instalação
  (a ARI não configurada) ou sem número SIP ativo na organização: `ativa: false` e listas vazias —
  no primeiro caso sem tocar o banco. A leitura é compartilhada por 1,5 s por organização, em
  memória da instância (vários navegadores que pedem no mesmo instante dividem uma leitura, e a
  que falha não fica guardada: responde 500 e a seguinte tenta de novo). A rota NÃO diz quantos
  atendentes estão livres — isso pede a ARI e o diretório a cada pedido (entrega 3). Leitura não
  audita.
- **Configurações › Times › "Fila do telefone"** (fila visível, entrega 2;
  `EsperaMaximaDoTime.tsx`, depois do aviso de instabilidade): a espera máxima na fila daquele
  time — 2 minutos (o padrão), 5, 10, 15, 20 ou 30. Trocar grava na hora, por
  `PUT /api/v1/telefonia/fila/times/[teamId]` (`manager`+; suporte somente-leitura barrado; Zod
  `.strict()`, então um `organization_id` no corpo é 422; audita `phone.queue_wait_changed` com o
  antes e o depois), e o padrão grava `null`, para o time seguir o padrão do produto se ele mudar.
  O que vale vem de `GET /api/v1/telefonia/fila/times` (`manager`+). O cartão só aparece com
  telefonia na instalação e para o time que veio nessa leitura (os ativos). Vale para a próxima
  ligação: quem já espera não muda.
- **Fase 2, versão 1** (nenhuma rota de tela nova; §6 do desenho): em Conexões › Telefone, as
  sub-abas **Menus** e **Voz e falas** (`?aba=telefone&sub=menus|falas`) e, em Números,
  "Quando ligarem": tocar no time ou tocar o menu; em Credenciais de IA, o cartão
  "ElevenLabs (voz da URA)"; em Configurações › Times, o cartão "Aviso de instabilidade
  (telefone)"; a faixa do aviso no topo de todo o CRM; e o cartão da ligação conta o que a
  URA fez ("No menu X, digitou uma tecla que não existe e foi para o time padrão, Y"), se o
  cliente ouviu o aviso e a ligação fora do horário. As telas da telefonia nunca mostram a
  mensagem crua de um erro sem corpo (504, página HTML do proxy): o `apiClient` o entrega
  como `ApiErrorSemCorpo`, e a frase vem de `mensagemDoServidor`.

## 8. Fases

| Fase | Conteúdo | Estado |
|---|---|---|
| F0 | Prova de conceito | medida (§1) |
| **F1 + distribuição** (release A) | §4–§7 | publicada — para saber em que versão: `awk '/^## \[/{v=$2} /Telefone no CRM — fazer e receber/{print v; exit}' CHANGELOG.md` |
| F2 v1 | URA e falas: menu por tecla com time padrão, "aguarde", "ninguém atendeu", fora do horário pela agenda do time (com um WhatsApp conectado, o texto sugerido traz o número dele), aviso de instabilidade por time. Desenho: `docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`; plano: `docs/superpowers/plans/2026-09-28-telefonia-fase2-v1-ura.md`; migration 0288 | implementada; prova na VPS pendente (J36 do mapa de jornadas) — publicada? `grep -n 'Menu de voz (URA)' CHANGELOG.md` |
| F2 v2 | Transferência direta e consultada para pessoa, direta para time, volta a quem transferiu e fila do time (emenda §12 do mesmo desenho, que prevalece sobre §5.3); plano: `docs/superpowers/plans/2026-09-30-telefonia-v2-v3-transferencia-e-ramais.md`; migration 0290 | implementada; prova na VPS pendente (J38 do mapa de jornadas; roteiro `docs/runbooks/telefonia-transferencia-e-ramais.md`) — publicada? `grep -n 'Transferir uma ligação' CHANGELOG.md` |
| F2 v3 | Ramais automáticos a partir de 201, ligação interna, URA que aceita ramal, aba Ramais (emenda §12, sobre §5.4); mesmo plano; migration 0291 | implementada; prova na VPS pendente (J38) — publicada? `grep -n 'Ramais — cada atendente' CHANGELOG.md` |
| F3 | Gravação com aviso, retenção, cascade LGPD e escuta auditada. Desenho (com as decisões D1–D8, tomadas na ausência do dono): `docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md`; plano: `docs/superpowers/plans/2026-09-29-telefonia-gravacao-das-ligacoes.md`; migration 0289; DYD-53 | implementada — publicada? `grep -n 'Gravação das ligações do telefone' CHANGELOG.md`; prova com ligação real depende de o dono ligar a gravação (J37 do mapa de jornadas) |
| F4 | Transcrição em português dentro da conversa | a fazer |
| F5 | Relatórios por time | a fazer |
| Fila visível, entrega 1 | Conversa viva ao atender: o cartão "Ligação em andamento" entra na conversa quando a recebida é atendida e é completado no fim; a passada de 60 s fecha o órfão. A entrega 2 é a linha seguinte; a 3 (atender e mover pela fila) do mesmo desenho não foi feita. Desenho: `docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md`; plano: `docs/superpowers/plans/2026-10-06-telefonia-fila-visivel-entrega-1.md`; sem migration | implementada, sem prova com ligação real (J43 do mapa de jornadas) — publicada? `grep -n 'a conversa aparece enquanto a ligação acontece' CHANGELOG.md` |
| Fila visível, entrega 2 | Aba Telefone no Inbox (a fila ao vivo por ordem de chegada, o menu, as ligações em curso e as perdidas dos últimos 30 minutos, com filtro por time e por número), a fila do worker passa a atender por ordem de chegada e a espera máxima na fila é de cada time (Configurações › Times; padrão 2 min). Desenho: `docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md`; plano: `docs/superpowers/plans/2026-10-06-telefonia-fila-visivel-entrega-2.md`; migration 0295 | implementada, sem prova com ligação real (J44 do mapa de jornadas) — publicada? `grep -n 'a fila de ligações aparece no Inbox' CHANGELOG.md` |

## 9. O que não foi medido

- ~~Áudio nosso → operadora, de forma direta.~~ Provado em 2026-09-28 pela tela: ligação
  FEITA pelo discador, com áudio nos dois sentidos (jornada J35 de
  `docs/testing/user-journey-map.md`).
- ~~Chamada RECEBIDA de fora (a infraestrutura).~~ Provado em 2026-09-28 na VPS de produção,
  com um Asterisk de teste descartável: a recebida chegou e teve áudio nos dois sentidos (o
  NAT do Docker preserva a 5060 do registro — a operadora vê `rport=5060` —, e a faixa UDP
  20000–20039 passa o firewall). Atrás do NAT duplo do Mac de desenvolvimento a operadora não
  entregava a INVITE.
- **O fluxo do PRODUTO na recebida** — o Stasis escolhe quem toca, o atendente atende no
  navegador — segue sem prova em produção.
- CPU por ligação na VPS (com e sem transcodificação Opus ↔ A-law).
- Ligar a telefonia pelo `update.sh` numa VPS real (§4.3). O que está provado é a DECISÃO do
  script, com `docker` dublado; que o `up -d` cria o Asterisk com o profile ligado é o
  comportamento do docker compose, medido só com `docker compose config --services`.
- Comportamento com mais de um registro da mesma conta ao mesmo tempo (dev + produção).
- **O tempo de toque (0294) numa ligação real.** O controlador e o SQL estão provados
  (`controle.test.ts`, `tests/invariants/telefonia-primeiro-toque-da-saida.test.ts`), mas o
  instante em que a operadora da Totus manda o primeiro 180/183 em relação ao telefone do
  cliente tocar de fato não foi medido. Um 183 com anúncio da operadora ("fora da área de
  cobertura") conta como "chamou": para o worker, é a rede dizendo que a ligação progrediu.
  E os dois instantes (primeiro toque e fim) são os de quando o worker PROCESSOU o evento, numa
  fila que também serve as outras ligações — o desvio disso não foi medido.
- **A ligação recuperada depois de um reinício do worker no meio do toque** fecha como não
  atendida mesmo que o cliente tenha atendido depois (o `ANSWER` da recuperada é ignorado —
  defeito anterior à 0294). O cartão dela sai "Ligação sem resposta · por <quem ligou>", sem a
  linha de como acabou.
- **O cartão "Ligação em andamento" numa ligação real** (fila visível, entrega 1). O SQL está
  provado no Postgres real (`tests/invariants/telefonia-cartao-em-andamento.test.ts`) e o
  controlador com dublês (`controle.test.ts`), mas nenhuma ligação real pelo tronco da operadora
  passou por ele: que o cartão entre na conversa no instante em que o atendente atende, que a
  conversa suba para o topo de Minhas na tela de quem atendeu e que o fim complete o mesmo
  cartão não foi visto assim.
- **A ordem de chegada e o teto por time numa ligação real** (fila visível, entrega 2). O
  controlador está provado com dublês (`controle.test.ts`, bloco "a fila visível (0295)": duas e
  três esperando com um e dois livres, a vez por time, a reavaliação 2 s depois e em uma passada
  só, o teto de 5 minutos) e o SQL no Postgres real (`tests/invariants/telefonia-fila-visivel-*`),
  mas nenhuma ligação real pelo tronco da operadora esperou numa fila: que quem chegou primeiro
  seja de fato quem toca primeiro quando um atendente fica livre, que a ligação caia no teto do
  time e não antes, e que a reavaliação 2 s depois do fim de uma ligação ache o ramal já solto
  (o BYE chegar ao navegador a tempo é leitura do código, não medida) não foram vistos assim.
- **A capacidade de áudio da instalação** (fila visível, entrega 2). Cada ligação esperando na
  fila ocupa uma perna de áudio, e uma em andamento ocupa duas; a faixa publicada
  (`TELEFONIA_RTP_INICIO`–`TELEFONIA_RTP_FIM`, padrão `20000-20039/udp`, 40 portas) dá cerca de 20
  pernas simultâneas — lido na configuração, **não medido**. Com o teto por time chegando a 30
  minutos, a fila de um pico pode bater nesse limite: o que o Asterisk faz com a vigésima primeira
  perna, e o que o cliente ouve, não foi visto. Nada aqui muda a faixa de portas; o ajuste, se
  preciso, é proposta à parte. Para ver a faixa em vigor numa instalação:
  `grep -E '^TELEFONIA_RTP_(INICIO|FIM)=' .env` (ausentes = os padrões).
- **A carga da rota da fila com a fila cheia** (fila visível, entrega 2). A rota é lida por todo
  navegador com o Inbox aberto, a cada aviso do Realtime (juntado em 400 ms, no máximo uma
  releitura a cada 2 s) e a cada 15 s, e a leitura compartilhada por 1,5 s existe para que o pico
  não vire uma consulta por navegador. Nada disso foi medido com dezenas de ligações na fila e
  muitos navegadores abertos: o que está provado é a lógica (um pedido = uma leitura dentro da
  janela, organizações separadas, a que falha não fica presa), não o tempo nem o custo.
- **O aviso do Realtime de `voice_calls` chegando ao navegador de cada papel.** A aba relê quando
  esse aviso chega e, de segurança, a cada 15 s; o teste do hook dubla o canal. Que o aviso chegue
  de fato a um `viewer` ou a um `agent` — a tabela tem RLS — não foi visto; sem ele, a fila se
  atualiza a cada 15 s, não em tempo real.
- **Fase 2, versão 1** (a prova na VPS é a Task 29 do plano; casos na J36 do mapa de
  jornadas): a URA numa ligação real (tecla, repetição, time padrão, desligar no menu); as
  falas tocadas pelo Asterisk de produção a partir do volume; o fim da fala quando o cliente
  desliga chegar como `PlaybackFinished` com `state: "failed"` (lido no código do Asterisk,
  não medido); se a música de espera recomeça do início a cada "aguarde"; a qualidade da voz
  no celular do cliente. **Do som de chamando em banda (1.50.2):** o tom no canal do cliente da
  operadora (a URI foi medida só no ramal da ligação feita, item 5 do §4.2); que ele segue sem
  soluço de um ramal ao próximo; que parar o tom antes da ponte é o que deixa a ponte se formar
  (lido no código do Asterisk: os comandos de um canal na ARI rodam em fila); e o intervalo
  entre o 180 da operadora e o tom quando a régua dos 45 s atende. Medido antes de escrever a URA: a fala toca por caminho absoluto num
  volume só leitura, e as teclas da operadora da Totus chegam por RFC 4733 (§2 do desenho).

## 10. Living System Checklist — F1 + distribuição

Lei em [`docs/doctrine/sistema-vivo.md`](../doctrine/sistema-vivo.md); mapa vivo em
[`docs/architecture/telefonia.architecture.json`](../architecture/telefonia.architecture.json).
Respondido conferindo o código em 2026-09-28, não o desenho acima. Onde a resposta é **não
existe ainda**, é dívida declarada — não ausência de defeito.

**Quem me alimenta?**
- A operadora: a INVITE chega em `tronco-<id>` → `Stasis(crm,entrada)` →
  `ControladorDeChamadas` (`lib/channels/telefonia/controle.ts`), pelo laço do worker
  (`lib/channels/telefonia/laco.ts`, chamado em `workers/agent-worker/main.ts`).
- O atendente: `BotaoLigar` (cabeçalho da conversa, faixa da conversa `phone`, ficha do
  contato) e o discador `BotaoDoTelefone` → `POST /api/v1/telefonia/chamadas` → pedido em
  `voice_calls` → o ramal disca `c-<id>`.
- O admin: Conexões › Telefone (`components/connections/CanalTelefoneClient.tsx`) →
  `/api/v1/telefonia/numeros` → `channel_sessions` com provider `sip_trunk`.
- A disponibilidade: `attendance_team_members`, `attendant_availability.is_available` (pausa
  e heartbeat), horário do time e do atendente — as peças do rodízio de conversas.

**Quem eu alimento?**
- `conversations` (`channel = 'phone'`) e `messages` (o registro da ligação) → Inbox.
- `voice_calls` → o painel do telefone (`GET /api/v1/telefonia/chamadas/[id]`) e a
  distribuição da ligação seguinte (a contagem de atendidas do dia).
- `agent_inbox_items` `voice_call_missed` → Central.
- `crm_lead_activities` (`voice_call`, `voice_call_missed`, `voice_call_unanswered`) → linha do
  tempo do negócio; `voice_call` carimba `last_activity_at` → Radar de Risco.
- `fn_conversation_assign` (`claim`) → a conversa passa a ser de quem atendeu ou de quem ligou.
- `api_audit_log`.
- `event_log` `voice_call.ended` — nasce `done` e **não tem consumidor**: é registro, como na
  ponte do WaCalls.

**Que atividade/log eu emito?**
- Auditoria (`lib/audit/actions.ts`): `channel.phone_trunk_created`, `channel.phone_trunk_updated`
  (com `trocou_senha`, nunca a senha), `channel.phone_trunk_archived`, `phone_call.started` e
  `phone_extension.credential_issued` (a credencial do ramal entregue a um navegador: ramal e
  se foi criado agora ou reaproveitado, nunca a senha).
- `crm_lead_activities` por `emitAgentActivityForContact`; negócio ambíguo ou inexistente vira
  `agent.activity_unrouted` no `event_log`, sem adivinhar.
- `messages` `type=system` com `metadata.voice_call`; `event_log` `voice_call.ended`.
- Log estruturado do worker: ligação recebida / atendida / encerrada, tronco enviado / retirado,
  tronco com configuração inválida não enviado, estado do número mudou, conexão com o Asterisk
  caiu.
- **Não existe ainda:** trilha de auditoria da ligação RECEBIDA e do desfecho de qualquer
  ligação. Da ligação, só o PEDIDO de saída audita (além da entrega da credencial do ramal); o
  resto fica em `voice_calls`, `event_log` e na atividade do negócio.

**Onde eu apareço na tela?**
- Conexões › Telefone: cada número, o time que recebe (ou "Nenhum time recebe as ligações
  deste número") e o estado ao vivo com o motivo da falha.
- Cabeçalho de toda tela: `BotaoDoTelefone` (o ponto diz se o ramal deste navegador está
  pronto) e `PainelDoTelefone` (banner da recebida, ligação ativa com mudo, teclado e desligar).
- Inbox: card com ícone `PhoneCall`, faixa da conversa `phone` e `CartaoDaLigacao` no chat.
- Central (`/app/ai/inbox`): "Alguém ligou e ninguém atendeu", com "Ligar de volta".
- Linha do tempo do negócio e Audit Log (`/app/audit`).
- **Não existe ainda:** o rótulo da linha do tempo ("Chamada de voz", "… perdida", "… sem
  resposta") é o MESMO da voz do WhatsApp — `payload.canal = "telefone"` é gravado e nenhuma
  tela o lê. Não há lista nem relatório de ligações (F5).

**Por qual porta se chega até mim?**
- `/app/connections` (Conexões, no `NAV_CATALOG` de `lib/navigation/catalogo.ts`, admin) → aba
  "Telefone" (`?aba=telefone`). Nenhuma `page.tsx` nova: nada a declarar em
  `tests/unit/navegacao-completude.test.ts`.
- O discador está no cabeçalho de toda tela; o Botão Ligar, na conversa e na ficha; a Central
  leva à ficha pelo "Ligar de volta".
- **Não existe ainda:** a descrição de Conexões no catálogo ("Seus números de WhatsApp…") não
  cita telefone, e a busca ⌘K varre rótulo e descrição — procurar "telefone" não acha a aba.

**Qual meu mecanismo anti-morte?**
- Recebida sem ninguém disponível: fila com música por até a espera máxima do time (2 min por
  padrão; Configurações › Times), reavaliada a cada 5 s e 2 s depois do fim de qualquer outra
  ligação; esgotada (ou esgotadas as 2 voltas), vira `voice_call_missed` na Central, atividade
  `voice_call_missed` no negócio e a conversa `phone` aberta no time do número.
- Worker reiniciado no meio: `recuperar()` retoma a ponte viva e encerra o resto como perdido,
  e a recebida perdida também vira aviso.
- Pedido de saída que o navegador nunca discou expira em 60 s e não prende o atendente.
- **Não existe ainda:** o aviso de perdida não fecha sozinho quando alguém retorna a ligação, e
  nada lembra ninguém se ninguém retornar. Ligação com a bina oculta vira aviso sem contato e
  sem conversa (só o número, ou "desconhecido", no corpo). Número sem time faz toda recebida
  virar perdida depois de 2 min (sem time não há espera máxima a configurar: valem os 2 min do
  padrão) — a aba mostra, nada impede.

**Onde se CONFIGURA o que eu uso?**
- Conexões › Telefone: servidor, porta, transporte, usuário, senha (só escrita), número e time
  que recebe — ver e mudar na mesma tela.
- Times: membros e horário; `StatusDoAtendente`: pausa e disponível; o fuso da organização; e,
  desde a 0295, a espera máxima na fila do telefone de cada time (Configurações › Times › "Fila
  do telefone": 2, 5, 10, 15, 20 ou 30 minutos; o padrão é 2) — ver e mudar na mesma tela.
- Instalação (`.env`, não organização): `COMPOSE_PROFILES=telefonia`, `TELEFONIA_ARI_URL`,
  `TELEFONIA_ARI_PASSWORD` (o kit gera), `TELEFONIA_IP_PUBLICO`, faixa RTP. Desligada, a aba
  Telefone diz como ligar; sem número, o ramal não registra e os botões não aparecem.
- Falta de configuração que vira sinal: registro recusado, operadora sem resposta, senha
  ilegível ou linha com servidor/usuário/porta fora da régua (gravada por fora da tela) →
  `FAILED` + motivo na aba.
- **Não existe ainda:** esse `FAILED` não vira item da Central nem a faixa de conexão caída do
  app — `listarConexoesCaidas` e `sincronizarSaudeDaConexao` (`lib/channels/health.ts`) só olham
  `PROVIDERS_DE_MENSAGEM`. E, pelo código, com a ARI fora do ar o worker para de ler os
  registros: o último estado gravado (inclusive "Conectado") fica na tela. Não medido.
- **Constantes sem tela** (decisões do §2, não estado configurável, mas nenhuma tela as mostra):
  20 s de toque, 2 voltas, reavaliação a cada 5 s (`lib/telefonia/distribuicao.ts`), e a
  reavaliação 2 s depois do fim de uma ligação (`REAVALIAR_APOS_O_FIM_MS`, `controle.ts`). Os 2 min
  de fila deixaram de ser constante da fila de entrada: são o padrão da espera máxima de cada time
  (`ESPERA_NA_FILA_MS`), que a tela mostra e muda; só a fila da transferência para um time segue
  com os 2 min fixos. Atender e passar ao chamar em banda após 45 s, prazo de 60 s da saída
  (`controle.ts`); 5 saídas simultâneas (`saida.ts`); a lista de números bloqueados
  (`lib/telefonia/numero.ts`).

**Qual a continuidade IA↔humano?**
- A IA não participa da ligação: não há agente de voz (transcrição é a F4 — e a gravação da F3
  já é a mídia da mensagem da ligação, então a F4 só emite `media.derive_requested` para ela). O registro da
  ligação é `outbound`/`system` de propósito, para não acordar turno nem termômetro.
- IA → humano: não se aplica.
- Humano → IA: **não existe ainda.** O contexto do agente
  (`lib/agent-engine/edge/crm/get-lead-context.ts`) não lê ligação nem a nota interna da
  conversa `phone`. O único efeito indireto é `last_activity_at`: a ligação atendida tira o
  negócio do "frio", e a IA não propõe retomar contato com quem acabou de falar ao telefone.
- **Resolvido: o rodízio de texto não distribui a conversa de uma ligação.** A conversa `phone`
  nova nasce sem dono e dispara `trg_conversation_routing_requested` (0040); o worker de
  rodízio (`lib/routing/worker.ts`) lê o MEIO da conversa (`conversations.channel` =
  `MEIO_TELEFONE`, nunca o provider) e fecha o evento como `skipped_voice_channel` sem
  atribuir, antes de perguntar pela IA ou pelos elegíveis. Quem recebe a ligação é a
  distribuição da telefonia; a atendida passa a ser de quem atendeu (`claim`), a feita já nasce
  de quem ligou, e a perdida fica sem dono, no time do número. Vigiado por
  `lib/routing/worker-nao-distribui-a-ligacao.test.ts`.

**Qual meu LAÇO DE RETORNO? (invariante 7 — o que muda quando a telefonia erra)**
- **Quem toca.** Cada ligação ATENDIDA entra na contagem do dia (`disponiveisNoTime`) e manda
  aquele atendente para o fim da fila da próxima: o laço fecha dentro do dia. **Não existe
  ainda:** sinal para quem deixa tocar sem atender (não pausa, não conta, não aparece em
  métrica nenhuma) e taxa de perdidas por time (F5).
- **Estado do número.** A AMI lida a cada 15 s volta para `channel_sessions.status` e para a
  aba; o admin corrige senha ou transporte, e a edição RECRIA o tronco. **Não existe ainda:** o
  aviso na Central (acima).
- **Recebida sem atendente.** Volta como `voice_call_missed` na Central e como atividade no
  negócio; o humano liga de volta. **Não existe ainda:** fechar o aviso com o retorno e medir o
  tempo até ele.
- **Autorização da saída (antifraude).** Recusa na rota volta como 422 com o motivo na tela; no
  controlador, como `end_reason` (`pedido_expirado`, `numero_<motivo>`, `tronco_indisponivel`,
  `tronco_configuracao_invalida`) e log `saída recusada`.
- **Saída que a operadora não completa.** Volta ao atendente na hora, como aviso no canto da
  tela, e à conversa como "Ligação não completada" (`recusada_pela_rede`); o motivo
  (`nao_completada_<causa>`) fica em `end_reason`. Quem corrige é o admin, pelo prefixo de
  discagem do número. **Não existe ainda:** nada agrega essas recusas por número — um prefixo
  errado aparece como aviso a cada ligação, não como alerta do número. **Não existe ainda:** nada agrega recusas — sinal de ramal
  comprometido ou de política apertada demais fica no log, que ninguém lê.
- **Asterisk ou worker reiniciado.** A queda do WebSocket dispara a sincronização completa e o
  re-registro (provado na J35); o ramal com credencial recusada pede outra em 1 s;
  `recuperar()` fecha as ligações órfãs.

**Atualizei o mapa vivo?** Sim — `docs/architecture/telefonia.architecture.json`, com os laços
e as não-ligações nos `cards`, e a linha correspondente em `docs/architecture/README.md`.

### 10.1 O que esta revisão corrigiu no corpo da spec (DoD 16)

Afirmações que divergiam do código em 2026-09-28, trocadas pelo que o código faz: a aplicação
Stasis é `crm`, não `deskcomm`; o tronco chega ao Asterisk por empurrão da rota + reconciliação
de 60 s + sincronização na reconexão, sem o evento `telefonia.tronco_alterado`; as funções da
distribuição e a consulta de candidatos têm outros nomes; o corpo e a resposta de
`POST /telefonia/chamadas`; `ringing_user_id` e a forma de `metadata.voice_call`; `0800` e
`400x` também são bloqueados para discar; o IP público é detectado pelo contêiner, não pelo
kit; o botão "Testar" da aba não existe; e o áudio nosso → operadora saiu de "não medido".

### 10.2 Revisão de segurança de 2026-09-28

O que a revisão achou e o que mudou. Cada item tem um teste que, com a correção arrancada, fica
vermelho (provado uma vez para cada).

| Achado | Correção | Teste |
|---|---|---|
| **Alto** — INVITE forjada com `From: tronco-<id>` casava o tronco pelo nome e era atendida sem senha | `identify_by=ip` no endpoint do tronco, sem objeto `identify` (§4.2) | `lib/channels/telefonia/pjsip.test.ts` |
| **Médio** — `/telefonia/ws` entregue ao Asterisk para qualquer anônimo | `forward_auth` / `forwardAuth` para `GET /api/v1/telefonia/ws/autorizar`, que confere `Origin` e papel sem renovar a sessão (§4.3) | `app/api/v1/telefonia/ws/autorizar/route.test.ts`, `lib/auth/sessao-sem-renovar.test.ts`, `tests/unit/portas-do-compose.test.ts`, `lib/auth/public-paths.test.ts` |
| PATCH trocava o servidor mantendo a senha guardada | senha obrigatória ao trocar a conta (§7) | `lib/channels/telefonia/numeros.test.ts` |
| Servidor aceitava host interno | régua de `conta-sip.ts` (§7) | `lib/channels/telefonia/conta-sip.test.ts` |
| A REST contornava o Zod e o worker empurrava o valor cru | `problemaDoTronco` antes de qualquer chamada à ARI (§4.1) | `lib/channels/telefonia/sincronizacao.test.ts` |
| IP do ipify cru no `pjsip.conf` | IPv4 validado no entrypoint (§4.3); a crase num comentário do heredoc, que rodava `line` a cada partida, saiu junto | `tests/shell/asterisk-entrypoint.test.sh` |
| O rodízio de texto atribuía a conversa da ligação | `skipped_voice_channel` (§10) | `lib/routing/worker-nao-distribui-a-ligacao.test.ts` |
| `POST /telefonia/ramal` sem auditoria | `phone_extension.credential_issued` (§10) | `app/api/v1/telefonia/ramal/route.test.ts` |

**Não coberto:** a régua do servidor olha o texto; um nome público que resolve para IP interno
(rebinding de DNS) passa. O `forwardAuth` do Traefik não foi medido — só o Caddy.
