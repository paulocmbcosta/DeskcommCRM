# Roteiro — provar a fila visível do telefone com ligação de verdade

Para o dono, depois das três releases da fila visível do telefone:

| Entrega | O que trouxe | Migration |
|---|---|---|
| 1 | a conversa aparece para quem atende **durante** a ligação (cartão "Ligação em andamento") | nenhuma |
| 2 | a aba **Telefone** no Inbox, a ordem de chegada e a espera máxima por time | 0295 |
| 3 | **Atender** e **Mover para outro time** direto da fila | 0296 |

Desenho: [`docs/superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md`](../superpowers/specs/2026-10-06-telefonia-fila-visivel-design.md).
Casos: J43, J44 e J45 de [`docs/testing/user-journey-map.md`](../testing/user-journey-map.md).

## O que este roteiro prova, e por que ainda falta

Nada do que está abaixo foi feito por quem escreveu o código. As três entregas foram provadas
com os dublês do controlador e com Postgres de verdade (duas organizações); a tela, num
navegador sobre dados semeados, pela spec `tests/e2e/telefonia-fila.spec.ts`, que só roda no
GitHub Actions — os casos das três entregas passaram lá (para ver as execuções:
`gh run list --workflow e2e.yml --limit 5`). Depois do deploy, uma sonda na VPS mediu o formato
do evento que leva a ordem de "Atender" e "Mover" da tela ao serviço de telefonia (sem ligação
nenhuma). **Nenhuma ligação passou pelo tronco**: no dia
em que o código ficou pronto havia cliente em ligação na instalação, e ligação de teste em
horário de atendimento não é algo que se faz sem o dono.

O que só uma ligação de verdade mede:

- o softphone do navegador atender **sozinho** o toque de quem clicou em "Atender";
- o atendente que acabou de desligar ser chamado de novo 2 segundos depois;
- a ordem de chegada com dois telefones ligando quase juntos;
- a espera longa (5 minutos ou mais) sem a ligação cair antes.

## 0. Preparação (10 min)

1. **Três contas**, cada uma num navegador (ou numa janela anônima) diferente:
   - **A** e **B**, papel `agent`, as duas no mesmo time (chame-o de time 1), com ramal;
   - **G**, papel `manager` ou `admin`.

   Não use a conta do dono no lugar de A ou B. Ela enxerga mais do que um atendente enxerga, e
   foi exatamente assim que um defeito de ramal passou despercebido na fase 2.
2. **Dois times** com o telefone ligado: o time 1 (de A e B) e um time 2 com pelo menos uma
   pessoa disponível, ou vazio — o caso 3.4 usa os dois jeitos.
3. **Dois telefones de fora** (dois celulares) para ligar.
4. Um horário **fora do atendimento**. O número de teste é o mesmo que o cliente usaria; durante
   o expediente uma ligação de teste ocupa atendente de verdade.
5. Confira que a versão instalada traz as três entregas e que os objetos existem no banco:

```bash
psql "$SUPABASE_DB_URL" -c "select column_name from information_schema.columns
  where table_schema='public' and (
        (table_name='voice_calls' and column_name in ('queued_at','queue_deadline_at'))
     or (table_name='attendance_teams' and column_name='phone_queue_max_wait_seconds'))
  order by 1;" -c "select to_regclass('public.voice_call_queue_orders') as ordens_da_fila;"
```

**Esperado:** três colunas e `voice_call_queue_orders` (não `NULL`).

## 1. A conversa viva ao atender (entrega 1)

| # | Faça | Esperado |
|---|---|---|
| 1.1 | A e B ficam **Disponível**. Ligue do celular 1 e escolha a opção do time 1. | Toca no softphone de um dos dois. |
| 1.2 | Quem tocou atende. **Não desligue.** | No Inbox dele, em **Minhas**, a conversa do cliente aparece na hora, com o cartão **"Ligação em andamento · com {nome} · desde HH:mm"**. |
| 1.3 | Com a ligação aberta, escreva uma **nota interna** na conversa. | A nota é gravada e aparece abaixo do cartão. |
| 1.4 | Abra a mesma conversa com a conta G. | G vê o mesmo cartão em andamento e a nota. |
| 1.5 | Desligue. | O **mesmo** cartão vira "Ligação recebida" com a duração. Não nasce um segundo cartão; a nota continua lá. |
| 1.6 | Com a gravação ligada, espere cerca de 1 minuto. | A gravação aparece **no mesmo cartão**. |
| 1.7 | Repita 1.1–1.2 e, com a ligação aberta, **transfira** para o outro atendente. | O cartão troca o nome para quem recebeu; a conversa passa a aparecer nas "Minhas" dele. |

Se o cartão ficar preso em "em andamento" depois de a ligação acabar, ele se fecha sozinho em
até 2 minutos (a passada de conserto do worker roda a cada minuto e só mexe em ligação encerrada
há mais de 1 minuto). Se passar disso, guarde o horário e veja o §5.

## 2. A aba Telefone e a ordem de chegada (entrega 2)

| # | Faça | Esperado |
|---|---|---|
| 2.1 | Abra o Inbox com G. | No trilho de abas há **Telefone**. Sem ligação nenhuma: "Nenhuma ligação agora." |
| 2.2 | A e B ficam **Indisponível**. Ligue do celular 1 e escolha o time 1. | Enquanto o cliente ouve o menu, a linha aparece em **"No menu"** ("Ouvindo as opções"). Depois de escolher, passa para **"Na fila, por ordem de chegada"**, posição 1, com "Aguardando há m:ss · cai em m:ss". O selo da aba mostra **1**. |
| 2.3 | Sem desligar o celular 1, ligue do celular 2 e escolha o time 1. | Segunda linha, posição 2. Selo **2**. O chip do time 1 mostra 2. |
| 2.4 | **Só A** fica Disponível. | Toca para A a ligação do **celular 1** (a mais antiga). A linha dela diz "Tocando para {A}". A do celular 2 **não** toca para ninguém. |
| 2.5 | A atende. | A linha do celular 1 vai para **"Em ligação"** ("Com {A} há m:ss"). A do celular 2 sobe para a posição 1. |
| 2.6 | A desliga. | Cerca de **2 segundos** depois, o softphone de A toca com a ligação do celular 2. É este o caso que os dublês não provam. |
| 2.7 | Com A e B Indisponível, ligue, escolha o time 1 e **desligue o celular** depois de uns 20 s. | A linha sai da fila e aparece em **"Perdidas nos últimos 30 minutos"**, com o motivo, quanto esperou e o botão de ligar de volta. |

### A espera máxima do time

| # | Faça | Esperado |
|---|---|---|
| 2.8 | Com G: **Configurações › Times**, no time 1, cartão **"Fila do telefone"**, escolha **5 minutos**. | Aviso "Espera máxima do telefone salva." |
| 2.9 | A e B Indisponível. Ligue, escolha o time 1 e **espere 3 minutos** na linha. | A ligação **não cai** aos 2 minutos. Na aba, "cai em" conta a partir de 5:00. |
| 2.10 | Continue esperando até passar de 5 minutos. | A ligação cai, com a fala de fila esgotada, e vira "Ligar de volta" na Central. Na aba, vai para as perdidas com o motivo "A fila esgotou". |
| 2.11 | Volte a espera do time 1 para **2 minutos**. | Volta ao padrão. |

O teto vale para quem **entra** na fila depois da mudança: quem já estava esperando continua
com o teto que tinha. E o teto longo só vale com o time **aberto**: fora do horário do time, a
espera é a de sempre.

## 3. Atender e Mover direto da fila (entrega 3)

| # | Faça | Esperado |
|---|---|---|
| 3.1 | A e B **Indisponível**. Ligue do celular 1 e escolha o time 1. Com a conta B (papel `agent`), abra a aba Telefone. | Embaixo do texto da linha da fila há o botão **"Atender"**. **Não** há o botão **"Mover"** (o das duas setas), que é só de gerente e admin. |
| 3.2 | B clica em **"Atender"**. | O softphone de B **atende sozinho**, sem B clicar em nada no telefone, em cerca de 1 segundo: o painel do telefone abre direto em "Conectando…", sem a tela de toque e sem som. A linha vai para "Em ligação", e a conversa ganha o cartão "Ligação em andamento · com {B}". **Depois de desligar**, o mesmo cartão diz **"Puxada da fila por {B}"** (a linha só entra no fim da ligação). |
| 3.3 | Com outra ligação na fila do time 1, **A e B clicam em "Atender" quase juntos**. | Um dos dois atende. O outro vê um aviso — "{nome de quem clicou primeiro} já está atendendo esta ligação." ou, se o primeiro já tinha atendido, "Esta ligação já foi atendida." — e continua livre. A ligação **não cai** e não toca para os dois. |
| 3.4 | Com uma ligação na fila do time 1, G clica em **"Mover"** na linha (o botão das duas setas) e escolhe o time 2 no menu, que mostra quantos estão disponíveis em cada time. | Aviso "Ligação movida para {time 2}.". A linha passa para o time 2 (o chip do time 2 sobe, o do time 1 desce). O cliente **não ouve de novo** a mensagem de fora do horário nem o aviso de instabilidade. Se há alguém disponível no time 2, toca para ele. Quando a ligação acaba, o cartão dela diz **"Movida de {time 1} para {time 2} por {G}"**. |
| 3.5 | G tenta mover para um time **fechado** (fora do horário dele; no menu ele aparece com "Fora do horário", e ainda dá para clicar). | A tela recusa: "O time está fora do horário de atendimento."; a ligação continua onde estava. |
| 3.6 | B está **em outra ligação** e clica em "Atender" numa linha da fila. | Recusa: "Você está em outra ligação." |
| 3.7 | B clica em "Atender" e **fecha a aba** antes de o toque chegar (menos de 1 segundo: é difícil à mão). | Em até cerca de 10 s, a ligação **volta ao rodízio** de onde estava. O cliente não cai. **Cuidado:** se o telefone de B já tinha atendido quando a aba fechou, fechar a aba **desliga a ligação** — é o comportamento de sempre do telefone no navegador, e não o que este caso mede. |
| 3.8 | Uma ligação ainda **no menu** (o cliente ainda não escolheu). | A linha **não** tem "Atender" nem "Mover": só se age sobre quem já espera por uma pessoa. |
| 3.9 | B abre o CRM em **duas abas** do mesmo navegador (as duas com o telefone conectado). Com uma ligação na fila, clica em "Atender" em **uma** delas. | **Nunca foi verificado, e há dois desfechos aceitos:** o telefone atende sozinho na aba em que B clicou; **ou** toca na OUTRA aba como uma ligação comum, e ali pede o clique em "Atender" do aviso de toque — o Asterisk pode chamar só um dos registros do ramal, e pode ser o da aba que não clicou. Em nenhum dos dois o cliente cai: se B não atender, em cerca de 10 s a ligação volta ao rodízio. **Anote qual dos dois aconteceu** (e em qual aba), que é o que falta saber. |

O caso 3.2 é o coração da entrega, e ele e o 3.9 são os que dependem do navegador: o toque chega
com um cabeçalho que só a aba de quem clicou reconhece. Se o softphone **tocar** em vez de
atender sozinho, a ligação ainda pode ser atendida à mão — anote e veja o §5.

## 4. Depois de cada atualização: os troncos

Recriar o contêiner do Asterisk deixa a porta 5060 presa a uma entrada antiga da tabela de
conexões da VPS: o Asterisk novo nasce com outro IP, sai por outra porta e a operadora recusa o
registro. O sintoma: em **Conexões › Telefone** os números ficam "registro recusado", e no
Asterisk os registros aparecem como `Rejected` ou `Unregistered`. Não volta sozinho — quando a
entrada antiga expira, a nova já está de pé na porta errada, e o Asterisk a renova a cada 25 s.

**O `update.sh` conserta isto sozinho**, logo depois de subir a versão nova (bloco "Conferindo a
telefonia"). Ele mede antes de agir: com a porta certa não mexe em nada, e com ligação em curso
— ou sem conseguir saber se há — não reinicia o worker. O que esperar na saída da atualização:

| A saída diz | O que aconteceu |
|---|---|
| `✓ telefonia: a porta 5060 não ficou presa — N de M número(s) registrado(s)` | o Asterisk voltou com o mesmo IP; os números que estavam registrados antes voltaram sozinhos |
| `✓ telefonia: a porta 5060 não ficou presa — nada a corrigir` | idem, e não havia número registrado antes (ou não deu para saber): nada a esperar |
| `✓ telefonia: porta 5060 recuperada — N de M número(s) registrado(s)` | estava presa; foi limpa, o worker reenviou os números e eles registraram |
| `… NÃO reiniciei o worker` (há ligação em curso, ou o Asterisk não respondeu se há) | a porta foi consertada, mas os números só voltam sozinhos em até 5 minutos — ou na hora, com o comando abaixo e `--reenviar`, sem ligação em curso |
| `⚠ … só N de M número(s) registraram` | a porta está certa; o que falta é com a operadora ou a senha (veja o motivo na tela) |
| `⚠ … o Asterisk só recebeu M número(s) do worker … havia A` | a porta está certa, mas o worker não reenviou todos: veja o log dele |

**A primeira atualização que TRAZ este conserto ainda não o usa**: quem roda é o `update.sh` da
versão anterior, que já estava carregado. Nessa, e sempre que o Asterisk for recriado à mão (um
`docker compose up -d` que o inclua, um reinício do Docker), rode:

```bash
bash hostgator-setup-kit/religar-telefonia.sh
```

É a mesma função do `update.sh`. Pode rodar com o CRM no ar e quantas vezes quiser: com tudo
certo ela só confere. Para conferir por conta própria:

```bash
docker exec deskcommcrm-asterisk-1 asterisk -rx "pjsip show registrations"
```

**Não** use `pjsip send register`: sozinho ele registra pela porta errada, a tela passa a dizer
"Conectado" e a ligação recebida não chega. E "Registered" na listagem acima não basta como
prova, pelo mesmo motivo — numa operadora que aceita qualquer porta o número fica registrado
pela porta errada. O que o kit confere é a porta, na tabela de conexões.

Se o script disser que não conseguiu ler a tabela (imagem do Asterisk anterior a este conserto),
o caminho de último recurso é o de antes, à mão:

```bash
docker run --rm --net=host --cap-add=NET_ADMIN alpine:3.22 sh -c \
  "apk add -q --no-cache conntrack-tools; conntrack -D -p udp --orig-port-src 5060"
docker restart deskcommcrm-worker-1
```

Este comando funcionou nas cinco vezes em que foi usado na VPS, mas tem um limite medido em
laboratório: se a operadora mandar um pacote para o servidor entre a limpeza e o registro, é ela
que fica com a 5060 e o Asterisk sai desviado de novo. O script não tem esse limite — ele manda
o Asterisk falar com a operadora logo depois de limpar. O mecanismo inteiro, com as medidas,
está no cabeçalho de `religar_troncos_sip`, em `hostgator-setup-kit/_common.sh`.

## 5. Se algo sair diferente do esperado

Anote o **horário** e o **número de quem ligou**, e colha:

```bash
# o que o worker fez com a ligação
docker logs --since 15m deskcommcrm-worker-1 2>&1 | grep -iE "telefonia|fila|ordem" | tail -80

# a ligação no banco
psql "$SUPABASE_DB_URL" -c "select id, status, team_id, queued_at, queue_deadline_at, answered_at, ended_at
  from public.voice_calls order by created_at desc limit 5;"

# as ordens da fila (Atender / Mover) e como acabaram
psql "$SUPABASE_DB_URL" -c "select kind, status, outcome, reason, created_at, ended_at
  from public.voice_call_queue_orders order by created_at desc limit 10;"
```

Toda ordem termina (`done`, `refused`, `no_answer` ou `cancelled`). A que sobra aberta — o
worker não conseguiu gravar o desfecho, ou nem chegou a lê-la — vale por 30 segundos: passado
isso a aba deixa de mostrá-la (os botões voltam à linha), e o próximo "Atender" ou "Mover"
naquela ligação a fecha como `cancelled` (`ordem_vencida`) antes de gravar o dele. Sem pedido
novo, ela fecha quando a ligação acaba (`ligacao_encerrada`) ou quando o worker reconecta
(`worker_reiniciou`). Ordem `open` numa ligação que já acabou é defeito.

## 6. O que continua em aberto, com ou sem este roteiro

- **Capacidade de áudio.** A instalação publica 40 portas de áudio, cerca de 20 ligações ao
  mesmo tempo (lido na configuração, nunca medido). Com espera de 30 minutos num pico, a fila
  pode bater nesse teto antes de bater no tempo.
- **A conversa não muda de time quando a ligação é atendida** por alguém de outro time: o
  conserto pede mudança num gatilho do banco e ficou fora das três entregas.
- **Ligação que o worker esquece** quando o fim dela falha ao ser gravado: o atendente fica
  "ocupado" até o worker reiniciar. Já era assim antes da fila visível.
- **Os limites conhecidos de "Atender" e "Mover"** (o atendente que atende no mesmo instante em
  que alguém puxa ou move, a reconexão do worker com uma puxada em curso, a ordem que fica aberta
  por até 30 s): no §9 da [spec 20](../specs/20-spec-telefonia-sip.md) e na J45 do mapa de
  jornadas.
