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
| Ligação de saída | `407` → reenvio autenticado → `200 OK` |
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
2. **"Menos ligações no dia" conta ligações ATENDIDAS**, no fuso da organização. Empate: vai
   para quem está há mais tempo sem atender.
3. **Toque de 20 s por atendente e 2 voltas** pela lista de disponíveis.
4. **Ninguém disponível dentro do horário:** fila com música, conferindo a disponibilidade de
   novo a cada poucos segundos, por até 2 min. Esgotado o prazo, a ligação é encerrada e vira
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
  `channel_sessions` com a senha cifrada. O worker empurra cada tronco para o Asterisk pela
  ARI quando conecta (sincronização completa) e toda vez que um número é criado, editado ou
  removido (evento `telefonia.tronco_alterado` no `event_log`). O Asterisk guarda tudo em
  memória: se ele reinicia, o worker percebe a queda do WebSocket e sincroniza de novo.
- **O CRM decide quem toca.** Distribuição, horário, pausa e registro são do worker, que é
  uma aplicação Stasis (`deskcomm`). O Asterisk só carrega o áudio.
- **O ramal do navegador não disca nada sozinho.** A credencial é temporária, emitida pelo
  CRM a cada sessão do atendente e empurrada pela ARI. O contexto do ramal só entrega a
  ligação ao Stasis, e o worker só liga para fora quando existe uma `voice_calls` de saída
  criada pela API para AQUELE atendente, há menos de 60 s. Isso vale como antifraude: uma
  senha de ramal vazada não disca para número nenhum.

### 4.2 Fluxos

**Recebida**
1. A INVITE da operadora chega no endpoint `tronco-<channel_session_id>`, que tem
   `context=de-tronco` e `Stasis(deskcomm,entrada)`.
2. O worker resolve o tronco, e com ele a organização e o time de destino. Depois acha ou
   cria o contato (`phoneLookupVariants`), acha ou cria a conversa `phone`, e cria a
   `voice_calls` (`provider=sip_trunk`, `direction=inbound`, `status=ringing`).
3. **Escolhe o atendente**, função pura `escolherAtendente` em `lib/telefonia/distribuicao.ts`.
   Candidatos: membros do time com `loadEligibleAttendants`, que já cobre disponível,
   heartbeat, horário do time e papel, menos quem está em outra ligação. Ordem: menos
   atendidas hoje, e no empate quem está há mais tempo sem atender.
4. Toca um ramal por vez (`POST /channels` para `PJSIP/ramal-<userId>`, 20 s). Se o
   atendente atende, entra numa ponte com a perna da operadora. Se não atende, recusa ou cai,
   passa para o próximo. São 2 voltas.
5. Ninguém disponível: `answer` + música em espera, reavaliando a cada 5 s, até 2 min.
6. Fim: `ended`, duração, registro na conversa, atividade no lead. Perdida vira
   `agent_inbox_items` `voice_call_missed`.

**Feita**
1. `POST /api/v1/telefonia/chamadas` com `{ contactId | numero, channelSessionId? }`. A rota
   valida papel, número (§6) e tronco, cria a `voice_calls` (`outbound`, `starting`,
   `owner_user_id` = quem ligou) e devolve `{ id, destino: "sip:c-<id>@deskcomm" }`.
2. O navegador disca `c-<id>` pelo JsSIP. O endpoint do ramal entra no Stasis com esse
   ramal, e o worker confere dono, idade e estado.
3. O worker cria a perna da operadora (`PJSIP/<numero>@tronco-<id>`, bina = número do
   tronco), põe as duas pernas numa ponte ANTES de discar (o atendente ouve o chamar e os
   anúncios da operadora) e disca.

### 4.3 Rede e empacotamento

- Serviço `asterisk` no `docker-compose.prod.yml`, `profiles: ["telefonia"]` (desligado por
  padrão), imagem `ghcr.io/paulocmbcosta/deskcomm-asterisk`, rede `internal`.
- **Nenhuma porta SIP publicada.** Só troncos com registro, cuja sinalização entra pelo
  mapeamento de NAT do próprio registro. Tronco por IP (sem registro) fica fora desta versão.
- **Faixa RTP publicada**: `TELEFONIA_RTP_INICIO`–`TELEFONIA_RTP_FIM`, padrão
  `20000-20039/udp`, só IPv4. Com rtcp-mux no ramal, dá ~10 ligações simultâneas. A porta
  publicada pelo Docker não passa pelo UFW, como a 7881 do WaCalls.
- ICE do navegador: o `rtp.conf` anuncia o IP público (`TELEFONIA_IP_PUBLICO`, detectado
  pelo kit) no lugar do IP do contêiner, pelo `ice_host_candidates`.
- WSS do ramal: Caddy roteia `/telefonia/ws` para `asterisk:8088/ws`. A ARI (`/ari`) nunca é
  roteada para fora.
- Segredo da ARI: `TELEFONIA_ARI_PASSWORD`, gerado pelo kit como os segredos da voz.
  Variável ausente = telefonia desligada, sem erro.

## 5. Dados (migration 0286)

- `channel_sessions`: `provider` aceita `sip_trunk`. Colunas `sip_server`, `sip_port`
  (padrão 5060), `sip_transport` (`udp` | `tcp`), `sip_username`,
  `sip_password_encrypted` (pgcrypto, via `fn_encrypt_oauth`, como o token da Meta) e
  `sip_team_id` (time que recebe as ligações). `provider_ref_check`: `sip_trunk` exige
  servidor e usuário. O número exibido é o `phone_number` de sempre, o que dá unicidade por
  organização.
- `voice_calls`: ganha `provider` (`wacalls` | `sip_trunk`, padrão `wacalls`),
  `sip_call_ref` (id da ligação no Asterisk), `conversation_id`, `team_id`. O
  `wacalls_call_id` passa a aceitar nulo, e um CHECK exige a referência certa por provider.
  Unique `(organization_id, sip_call_ref)`.
- `conversations.channel` aceita `phone`.
- O registro da ligação na conversa é uma `messages` `type=system`, `sent_via=system`,
  `direction=outbound`, `status=sent`, com `metadata.voice_call_id`. Não é `inbound` de
  propósito: `inbound` emite `message.received`, que acorda o agente de IA e o termômetro
  de espera.

## 6. Política de número (antifraude)

`lib/telefonia/numero.ts`, função pura e testada:
- Normaliza para E.164 brasileiro (`+55` + DDD + número). Aceita as grafias locais
  (`(61) 3686-1503`, `061…`, `0xx61…`).
- **Bloqueia por padrão:** internacional (tudo que não é `+55`), `0300`, `0500`, `0900`,
  serviços de 3 e 4 dígitos (`190`, `192`, `193`, `100`, `102`…) e números com menos de 10
  dígitos.
- Limite de ligações de saída simultâneas por organização (padrão 5), conferido na rota.

## 7. Telas

- **Conexões › Telefone** (aba nova em `ConexoesShell`): lista de números com status ao vivo
  (Conectando / Conectado / Falhou + motivo), botão "Adicionar número" (servidor, porta,
  transporte, usuário, senha, número, time que recebe), editar, testar e remover. A senha só
  é escrita, nunca lida.
- **Ramal**: `TelefoniaProvider` no layout do app. Registra o JsSIP quando a organização tem
  número conectado e o usuário é agent ou acima. Mostra o banner de chamada recebida e o
  painel de chamada ativa, com as peças visuais de `components/voice/`.
- **Botão Ligar** no cabeçalho da conversa (qualquer meio, se o contato tem telefone) e na
  ficha do contato. **Discador** para número avulso.
- **Conversa `phone`** no inbox: ícone de telefone, sem compositor de texto, e o cartão da
  ligação (sentido, quem atendeu, duração, desfecho).

## 8. Fases

| Fase | Conteúdo | Estado |
|---|---|---|
| F0 | Prova de conceito | medida (§1) |
| **F1 + distribuição** (release A) | §4–§7 | em implementação |
| F2 | URA configurável, horário do time e mensagem de fora do horário com WhatsApp, anúncio de "ninguém disponível", transferência | a fazer |
| F3 | Gravação com aviso, retenção, cascade LGPD e escuta auditada | a fazer |
| F4 | Transcrição em português dentro da conversa | a fazer |
| F5 | Relatórios por time | a fazer |

## 9. O que não foi medido

- **Áudio nosso → operadora, de forma direta.** Falta o teste de eco com alguém ligando para
  o número.
- Chamada RECEBIDA de fora. A ligação para o próprio número caiu na caixa postal da
  operadora, e não voltou como chamada recebida.
- CPU por ligação na VPS (com e sem transcodificação Opus ↔ A-law).
- Comportamento com mais de um registro da mesma conta ao mesmo tempo (dev + produção).
