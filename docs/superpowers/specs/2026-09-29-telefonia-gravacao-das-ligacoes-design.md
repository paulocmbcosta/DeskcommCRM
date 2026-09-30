# Telefonia · Gravação das ligações (F3 da spec 20) — desenho

Escrito em 2026-09-29, à noite, numa sessão autônoma: o dono pediu a gravação
("um cartãozinho com a gravação para escutar e, no futuro, transcrever, para
fazer análise de atendimento") e foi dormir dizendo "siga até colocar em
produção". As seis decisões do §4 do contexto
(`~/Documents/deskcomm-clientes/totus/telefonia-gravacao/CONTEXTO.md`) foram
tomadas aqui, na ausência dele, com o critério "o mais conservador que ainda
entrega o pedido" — e todas são reversíveis sem migration destrutiva.

Relacionados: spec 20 (`docs/specs/20-spec-telefonia-sip.md`, F3 e F4),
desenho da fase 2 (`2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`),
spec 18 (voz é dado sensível: consentimento e cascata de anonimização).

## 1. O que muda para quem usa

- **Administrador**, em Conexões › Telefone, sub-aba nova **Gravação**: liga a
  gravação da organização, escolhe por quanto tempo guardar (90 dias por
  padrão) e vê se o **aviso de gravação** está pronto. O aviso é uma fala geral
  nova ("Esta ligação poderá ser gravada…"), gerada como as outras na sub-aba
  Voz e falas. **Sem o aviso pronto, o interruptor não liga.**
- **Atendente** (e acima) que enxerga a conversa: o cartão da ligação ganha a
  linha da gravação — "Preparando a gravação…", depois o botão **Ouvir a
  gravação (m:ss)**, que abre um player ali mesmo. Cada vez que alguém pede
  para ouvir, fica uma linha na auditoria (`phone.recording_listened`).
- **Quem liga** ouve o aviso de gravação logo no início, antes do menu ou da
  fila. **Quem recebe** uma ligação feita pelo atendente ouve o aviso assim que
  atende, junto com o atendente.

## 2. Decisões (§4 do contexto)

| # | Pergunta | Decisão | Por quê |
|---|---|---|---|
| D1 | Gravar sempre, por número ou por time? | **Por organização**, desligada por padrão, valendo para os números dela nos dois sentidos. | A Totus tem um número; por número/time é refinamento sem pedido (YAGNI). O padrão desligado respeita quem instala o produto: gravar é decisão consciente, com aviso. |
| D2 | Só a ponte ou também URA/espera? | **Só a conversa**: começa quando cliente e atendente estão na ponte e termina no fim da ligação. | É o que serve à análise de atendimento; URA e música ocupariam espaço sem informação. |
| D3 | Aviso obrigatório? | **Sim, fala geral nova `recording_notice`.** Ligar a gravação exige o aviso pronto (tela e API recusam). **Recebida:** o aviso toca primeiro, antes do menu/fila; se ele NÃO tocar (arquivo sumiu, Asterisk recusou), aquela ligação **não é gravada** — e a Central recebe o `phone_prompt_unplayable` que já existe. **Feita:** o aviso toca na ponte no instante em que o cliente atende, junto com o início da gravação — o próprio áudio prova o aviso; se não der para tocar, não grava. | Gravar quem não foi avisado é o risco LGPD que o pedido não pode criar. O momento do aviso fica em `voice_calls.recording_notice_at`. |
| D4 | Formato? | O Asterisk grava **WAV 8 kHz** (medido: o Asterisk 20.11.1 do Alpine não tem Opus/Ogg entre os formatos); o worker converte para **MP3 mono 16 kHz, 24 kbps (~180 KB/min)** com ffmpeg — novo na imagem do worker — e apaga o WAV do Asterisk. Teto de 2 h por ligação. | MP3 toca em qualquer navegador (Safari incluso) e em qualquer computador, para quando o cliente pedir a gravação; 16 kHz é o que a transcrição usa. Opus seria ~1/3 menor, mas não abre em todo lugar. |
| D5 | Retenção? | **90 dias por padrão**, escolha na tela (30, 60, 90, 180, 365, 730, 1825). A poda é diária, no cron `data-retention`: apaga o arquivo e o cartão passa a dizer "Gravação apagada". | 90 dias é o mínimo que o Decreto 11.034/2022 pede para gravações de SAC. A cota: 1 GB (Supabase Free) ≈ 5.800 min; a Totus está no Pro (100 GB). |
| D6 | Quem ouve? É auditado? | Quem **vê a conversa** (a visibilidade por time já é RLS) **e** tem papel **atendente ou acima** (`viewer` não ouve). Toda escuta audita. A URL assinada vale 10 min. | O atendente precisa da ligação anterior para dar continuidade; o gestor, para analisar. A auditoria é a "escuta auditada" da F3. |
| D7 | Transcrição já? | **Não** (o dono disse "no futuro"). O caminho fica pronto: a gravação é a **mídia da mensagem da ligação**, e a F4 só precisa emitir o `media.derive_requested` que já transcreve o áudio do WhatsApp. | Custo por minuto da OpenAI e chave obrigatória ficam para quando for pedido. |
| D8 | Número oculto (sem conversa)? | **Não grava.** | Sem conversa não há cartão nem a quem entregar: seria gravação que ninguém ouve e só risco LGPD. Documentado no cartão da spec. |

## 3. Arquitetura

```
Asterisk (ponte p-<vc>)  --POST /bridges/p-<vc>/record name=g-<vc> format=wav-->  /var/spool/asterisk/recording/g-<vc>.wav
      │ fim da ligação: POST /recordings/live/g-<vc>/stop, depois DELETE da ponte
      ▼
worker (laço da telefonia)
  finalizar() → registrarNaConversa(): metadata.voice_call.gravacao = { situacao: "processando" }
  processar(vc) [chute logo após o fim + passada de 60 s]
    GET /recordings/stored/g-<vc>/file  → /tmp/…/g.wav (stream, nunca em memória)
    ffmpeg → g.mp3
    Storage whatsapp-media  <org>/<conversa>/<mensagem>.mp3
    UPDATE messages  media_storage_path, media_mime, media_size_bytes,
                     metadata = jsonb_set(… '{voice_call,gravacao}' …)  (mescla, nunca sobrescreve)
    UPDATE voice_calls recording_status = 'stored'
    DELETE /recordings/stored/g-<vc>
      ▼
tela: CartaoDaLigacao (Realtime de messages já assina UPDATE)
  "Ouvir" → GET /api/v1/telefonia/chamadas/<vc>/gravacao → audita → { url assinada 10 min }
cron data-retention (diário): vencidas → remove do Storage → situacao "expirada", recording_status 'expired'
```

### 3.1 Onde mora cada coisa (DIRC)

- **`voice_calls.recording_status`** (`recording` | `stored` | `failed` |
  `expired`, nulo = não gravada) é a **fonte da verdade** do ciclo da gravação.
  `voice_calls.recording_notice_at` guarda quando o aviso tocou. As duas só
  valem em `provider = 'sip_trunk'` (CHECK, a mesma regra da URA: a linha do
  WaCalls a REST escreve com o JWT do agent).
- **`messages.media_storage_path`** da mensagem da ligação (`external_id =
  ligacao:<id>`) aponta o arquivo — **referência**, não cópia. Por estar ali, a
  gravação entra de graça na **cascata de anonimização** (a 0235 já junta a
  mídia das mensagens do contato na `storage_redaction_queue`) e no caminho da
  transcrição (F4).
- **`messages.metadata.voice_call.gravacao`** é a **projeção** para o cartão
  (situação e duração), escrita só pelas funções deste desenho, sempre por
  `jsonb_set` no banco. Quem lê é `gravacaoDaLigacao()` (schema central em
  `lib/telefonia/gravacao.ts`), nunca o path cru.
- **`phone_settings`** ganha `recording_enabled`, `recording_retention_days` e
  `recording_notice_prompt_id` (FK composta para `phone_prompts`, como as outras
  falas gerais).

### 3.2 O controlador (`controle.ts`) — só ganchos

A branch do som de chamando (1.50.2) mexe no mesmo arquivo; a lógica nova
fica em módulos próprios e o controlador ganha pontos de chamada pequenos:

- **Recebida:** logo depois de criar a `voice_calls`, se a organização grava,
  a ligação tem conversa e há aviso pronto → a fala `gravacao` vai ao ar pela
  mesma mecânica (`FalasNoAr`); no fim dela (`aposFala`) segue o que viria —
  menu ou fila. Tocou → `l.gravar = true` e `recording_notice_at`. Não tocou →
  segue sem gravar.
- **Ponte formada** (`ramalAtendeu`): se `l.gravar`, `POST /bridges/…/record` e
  `recording_status = 'recording'`. Falha aqui nunca derruba a ligação.
- **Feita:** a configuração é lida em `novaFeita`; no `ANSWER`, se grava e o
  aviso está no disco → `POST /bridges/…/play` do aviso + gravação, na mesma
  hora.
- **Fim** (as três: recebida, feita, recuperada): `pararGravacao` antes de
  destruir a ponte; depois de `finalizar`, o chute do processamento.

### 3.3 O processamento (`lib/channels/telefonia/gravacoes.ts`)

Portas (ARI, banco, Storage, ffmpeg, relógio) para o teste trocar por dublês.
Uma ligação por vez (`Set` do que está em curso). Regras:

- Mensagem da ligação ainda não existe (fim não registrado) ou o Asterisk
  responde 404 com menos de 2 min do fim → tenta de novo na passada.
- 30 min depois do fim sem conseguir → `failed`, projeção `falhou` e aviso
  `phone_recording_failed` na Central (laço de retorno: alguém fica sabendo).
- A mensagem foi anonimizada no meio (metadado sem `voice_call`) → apaga o
  arquivo recém-subido e marca `expired`: nada volta a apontar para ele.
- Arquivos `g-*` no Asterisk cuja ligação não está mais `recording` → apagados
  pela passada (órfãos de uma queda no meio).

## 4. Segurança e LGPD

- Rota de escuta: `requireRole('agent')`; a mensagem é lida pelo **cliente de
  sessão** (RLS decide, inclusive a visibilidade por time); o caminho precisa
  começar por `<org>/<conversa>/` (`isMediaPathOwnedBy`); URL assinada de
  10 min; auditoria a cada pedido.
- A rota genérica `/api/v1/messages/[id]/media` passa a **recusar** a mensagem
  de ligação: sem isso, ela serviria a gravação sem auditoria nem piso de papel.
- Anonimizar o contato apaga a gravação (cascata existente) e limpa o
  metadado; a exportação LGPD passa a dizer quais ligações foram gravadas.
- Nenhuma função SQL nova exposta por RPC: a poda usa o pool do servidor.

### 4.1 O que a revisão de segurança achou antes do merge (e o conserto)

Revisão independente em 2026-09-30, antes de sair do rascunho. A raiz das mais
graves é ANTERIOR à feature: qualquer membro da organização, inclusive `viewer`,
insere, altera e apaga linhas de `messages` pela REST (as policies só conferem a
organização), e a gravação passou a depender de três colunas dessa tabela.

| Achado | Conserto |
|---|---|
| Uma mensagem `ligacao:<id>` plantada na conversa de outro time recebia a gravação (fura a visibilidade por time e a anonimização) | Trigger `trg_mensagem_de_ligacao_e_do_sistema` (0289): usuário final não cria `ligacao:*`, não altera as colunas que identificam a ligação e apontam o arquivo, não a apaga, e não põe o arquivo de uma gravação como mídia de outra mensagem. E o worker só anexa à mensagem da CONVERSA DA LIGAÇÃO. |
| A rota genérica de mídia servia a gravação copiada para outra mensagem | O mesmo trigger; e a escuta exige a ligação `stored` na mesma conversa e o caminho EXATO `<org>/<conversa>/<mensagem>.mp3`. |
| A poda (service key) apagaria qualquer caminho que estivesse na linha | Só remove o caminho canônico, da conversa da ligação. |
| Corrida entre a anonimização e o anexar deixava arquivo órfão | O anexar é uma transação com a MESMA trava da cascata (`fn_service_lock`) e confere `contacts.is_anonymized`. |
| O relógio de reserva dava o aviso como ouvido; o aviso da feita que falhasse depois de aceito não era visto | Para o papel `gravacao`, o relógio conta "não tocou" (sem aviso na Central); na feita, o `PlaybackFinished failed` do aviso descarta a gravação. |
| Sem prazo no ffmpeg/upload, N conversões em paralelo, órfãs sem estado nunca apagadas | Prazos (10 min / 5 min), uma conversão por vez, e a órfã de ligação encerrada sem marca é apagada. |
| O cartão montava a URL com um id vindo do metadado | Só uuid vira pedido, codificado. |
| (2ª passada) Preservar coluna por coluna deixava o `id` trocável — reabria o caminho do arquivo e furava a retenção | Alterar a mensagem da ligação pela REST passou a ser IGNORADO por inteiro (nenhum fluxo do produto a altera como usuário). |
| (2ª passada) Apagar a conversa/contato levava a mensagem da ligação pela cascata e o arquivo ficava órfão | Trigger `trg_gravacao_da_mensagem_apagada` põe o arquivo na `storage_redaction_queue` (drenada pelo cron `storage-redaction`). |
| (2ª passada) Upload que termina depois do prazo deixava MP3 sem ponteiro | Ao dar a gravação como perdida, o caminho canônico é apagado do Storage. |
| (2ª passada) A rota genérica assinava qualquer caminho do bucket | Só caminho DESTA organização (o da conversa não: a fusão de contatos move a mensagem sem mudar o caminho). |

Residual aceito: a checagem "este arquivo é de uma gravação" do trigger roda sob a RLS
de quem escreve — só pega gravações que a pessoa enxerga. Explorar exigiria o id de uma
mensagem numa conversa invisível, que nada expõe.

## 5. Fora da v1 (e onde encaixa)

- Transcrição (F4): `media.derive_requested` para a mensagem da ligação.
- Gravação por número/time; canais separados (atendente × cliente) para
  diarização — exigiria gravar cada canal por *snoop*, não a ponte.
- Arquivo da gravação na exportação LGPD (hoje: a lista de ligações gravadas).
- Conserto do kit para a porta 5060 no NAT ao recriar o Asterisk (chip próprio).

## 6. Prova

- Unitários: regra pura (projeção, retenção, duração pelo WAV), controlador
  (aviso antes do menu, sem aviso não grava, ponte grava, feita grava no
  ANSWER, fim para a gravação), processamento (404, 30 min, anonimizada, êxito),
  rotas (papel, RLS, auditoria, 409 sem aviso), cartão (quatro situações).
- `test:db`: vocabulário dos CHECKs novos contra o TypeScript.
- e2e no GitHub Actions: um atendente abre a conversa com gravação pronta,
  clica em Ouvir, o player recebe a URL e a auditoria registra.
- Produção: gravação de uma ponte sintética (sem ligação real) passando pelo
  código do worker até o MP3; a prova com ligação real fica para o dono, que
  liga a gravação e faz uma ligação de teste.
