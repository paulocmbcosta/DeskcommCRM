# Runbook — Deploy em produção (VPS)

O caminho normal de deploy **não constrói nada na VPS**: o CI publica a imagem no
GHCR e a VPS só puxa. Construir localmente é exceção de emergência, e tem custo —
está documentado no fim.

---

## 1. O comando

O caminho normal é o kit, e ele recria tudo o que a versão nova mexeu:

```bash
cd /var/www/crm
bash hostgator-setup-kit/update.sh
```

O `dc up -d` dele não nomeia serviço: sobe **todos** os que mudaram — `app`, `worker`,
`scheduler` e, com a telefonia ligada, o `asterisk` —, cria volume novo sozinho e usa os
arquivos de compose que a instalação tem (`dc_files`, em `hostgator-setup-kit/_common.sh`).

À mão, só o `app`, quando a versão não mexeu em mais nada:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

### `up -d app` sozinho não basta quando a versão mexe no worker ou no Asterisk

Foi o caso da URA do telefone (migration 0288): o volume `telefonia-falas` passou a ser
montado no `worker` (escrita) e no `asterisk` (só leitura), em `/var/lib/telefonia/falas`.
Um `up -d app` deixa o `worker` na versão antiga e o `asterisk` **sem o volume** — a
ligação segue, mas toda fala (menu, aguarde, aviso) é pulada e vira aviso na Central. À mão,
recrie os três, com os mesmos dois `-f`:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app worker asterisk
```

**Só nomeie `asterisk` se a telefonia estiver ligada** (`grep -E '^COMPOSE_PROFILES=' .env`
cita `telefonia`). Serviço de profile nomeado no comando SOBE mesmo com o profile desligado:
numa instalação sem telefonia, o comando acima ligaria um Asterisk que ninguém configurou.
Sem telefonia, é `up -d app worker`.

**Recriou o Asterisk à mão? Religue os números em seguida.** O contêiner novo costuma nascer
com outro IP, a porta 5060 fica presa ao antigo na tabela de conexões da VPS e a operadora
passa a recusar o registro — sem voltar sozinho. O `update.sh` cuida disso depois do `up -d`
dele; um `up -d` seu, não:

```bash
bash hostgator-setup-kit/religar-telefonia.sh
```

Ele mede antes de agir (com a porta certa só confere) e não reinicia o worker com ligação em
curso. O que cada saída quer dizer está em
[`telefonia-fila-visivel.md` §4](telefonia-fila-visivel.md#4-depois-de-cada-atualização-os-troncos).

Na dúvida sobre o que a versão mexe, use o `update.sh`.

### Os DOIS `-f` são obrigatórios. Sempre.

Esta é a pegadinha que já derrubou o site inteiro em produção (2026-08-05).

A VPS (Hostinger) vem com um **Traefik próprio** ocupando as portas 80/443.
`docker-compose.traefik.yml` é o ÚNICO lugar que:

- coloca no contêiner `app` as labels de roteamento
  (`traefik.http.routers.deskcomm.rule=Host(...)`);
- associa o contêiner à rede que o Traefik enxerga (`TRAEFIK_DOCKER_NETWORK`);
- desliga o `caddy` do compose base por profile (senão dois processos brigam
  pela mesma porta).

Rodar só com `-f docker-compose.prod.yml` recria o contêiner **sem labels
nenhuma**. O Traefik deixa de enxergá-lo e o domínio inteiro passa a responder
`404 page not found` — não é erro do Next, é o 404 genérico do Traefik. A app
está no ar, saudável, e inalcançável.

---

## 2. Verificação pós-deploy (não pule)

`healthy` no `docker ps` **não prova que o site está acessível** — o healthcheck
é um probe TCP interno e passa mesmo com o roteamento quebrado. Verifique o
roteamento sempre e, com a telefonia ligada, também o volume das falas:

```bash
# 1) as labels do Traefik existem?
#    O nome do contêiner é <pasta-do-projeto>-app-1, então pergunte ao compose
#    em vez de chutar. Aqui um -f só basta: o `ps -q` resolve pelo nome do
#    projeto + serviço, não pelo conteúdo do arquivo (medido: com um -f ou com
#    os dois, devolve o MESMO contêiner). Quem precisa dos dois é o `up -d`.
docker inspect "$(docker compose -f docker-compose.prod.yml ps -q app)" \
  --format '{{.Config.Labels}}' | grep -o 'traefik.enable:[^ ]*'
# esperado: traefik.enable:true   (vazio = roteamento quebrado)

# 2) o domínio responde?
curl -s -o /dev/null -w "%{http_code}\n" https://<DOMAIN>/
# esperado: 307 (redireciona pro login)
# 404      = labels perdidas, refaça o deploy com os dois -f
```

Com a telefonia ligada, confira também que o Asterisk enxerga as falas, e só para leitura:

```bash
# 3) o volume das falas está no Asterisk?
docker exec "$(docker compose -f docker-compose.prod.yml ps -q asterisk)" ls -la /var/lib/telefonia/falas
# esperado: a listagem (vazia numa instalação sem fala salva). "No such file" = o asterisk
# não foi recriado; refaça o up -d nomeando-o (§1)
docker inspect "$(docker compose -f docker-compose.prod.yml ps -q asterisk)" \
  --format '{{range .Mounts}}{{.Destination}} rw={{.RW}}{{"\n"}}{{end}}' | grep telefonia
# esperado: /var/lib/telefonia/falas rw=false
```

---

## 3. Fluxo completo (do código à produção)

```
commit → push → PR → merge na main → CI publica imagem → VPS puxa
```

1. **Commit + push** numa branch de feature. Trabalho que fica só no disco da
   VPS não existe: o CI não o vê, some se a VPS for reconstruída, e é invisível
   pra qualquer outra pessoa.
2. **PR e merge na `main`.** `publish-image.yml` dispara em push na `main` (ou
   tag `v*`) e publica as imagens da matriz — todas na mesma versão; quais são:
   `grep -n 'name: deskcomm' .github/workflows/publish-image.yml`. O build pesado
   roda nos runners do GitHub, nunca na VPS do usuário.
3. **Deploy na VPS.** Numa instalação real isto é `bash hostgator-setup-kit/update.sh`,
   não um `up -d` na mão: ele puxa a tag publicada, re-aplica o `baseline.sql`,
   faz backup antes, grava no `.env` a imagem de cada serviço nosso — a do Asterisk
   mesmo com a telefonia desligada; quais são:
   `grep -nE 'set_env_var "\$envfile" [A-Z]+_IMAGE ' hostgator-setup-kit/_common.sh` —
   e recria todos os serviços que mudaram (§1).

> **`latest` não é a última release.** Ele é publicado a partir da branch default, então
> segue o **topo da `main`** — código ainda não lançado. Quem quer a última release usa
> `stable`; quem opera um cliente usa o número da versão. Ver
> [`../doctrine/packaging.md`](../doctrine/packaging.md).

---

## 4. Exceção: imagem construída na VPS

Só quando é preciso validar algo em produção **antes** de a imagem oficial
existir (ex.: CI ainda rodando e um bug bloqueando o usuário).

```bash
APP_IMAGE=deskcomm-app:local docker compose \
  -f docker-compose.prod.yml -f docker-compose.build.yml --env-file .env build app

APP_IMAGE=deskcomm-app:local APP_PULL_POLICY=never docker compose \
  -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

Isto sobe só o `app`. Se a versão que você está validando mexe no worker ou no
Asterisk (como o volume `telefonia-falas`), o `app` novo passa a conviver com o
`worker` antigo e com o `asterisk` sem o volume — veja §1; o jeito de fechar é o
`update.sh` da versão publicada.

O `docker-compose.build.yml` também cobre `worker` e `scheduler` — troque
`app` pelo serviço que você precisa construir. Eles têm `build:` no próprio
compose de produção (é o escape que faz a instalação sobreviver a um registry
fora do ar), mas é o override que traz o `pull_policy: never`; sem ele o
`up -d` volta a buscar a imagem publicada.

**Isto é dívida, não um caminho paralelo.** A imagem existe só no disco daquela
VPS: não está no registry, não está no git, e qualquer `docker compose up -d`
sem `APP_PULL_POLICY=never` a substitui pela do GHCR — silenciosamente, sem erro
nenhum, revertendo o que você acabou de subir.

Requisitos: >= 4 GB de RAM **ou** swap (medido: ~4min num VPS de 3.8 GB com 4 GB
de swap) — e isto é o requisito **deste caminho de exceção**, não da operação
normal. A régua de operação é outra, e não mudou. Ela tem três parcelas, e **duas
são medidas e uma é herdada** — a distinção importa porque a herdada é a que
costuma ser citada como se fosse nossa:

| parcela | estado | como conferir |
|---|---|---|
| 7 contêineres | **medido** | `docker compose -f docker-compose.prod.yml config --services \| wc -l` |
| `mem_limit` somando 2560m (app 768 + worker 512 + waha 1280) | **medido** | `grep -n 'mem_limit' docker-compose.prod.yml` |
| ~150 MB por número de WhatsApp | **herdado do upstream WAHA**, nunca medido neste projeto | `docker stats --no-stream` na sua VPS |

O terceiro número vem de `docs/research/reference-synthesis.md` (síntese do curso
WAHA, 2026-05), não de uma medição nossa — e circula em sete documentos que se
citam entre si. Uma medição pontual na produção do projeto (2026-08-14, **uma**
sessão pareada, VPS compartilhada com outras stacks) deu **304,5 MiB no contêiner
`waha` inteiro**, contra o `mem_limit` de 1280 MiB. Um ponto não decompõe baseline
e sessão: para isso seriam necessários dois números pareados, e não é ensaio que
se faça numa instalação viva.

**Nada disso mexe no tier recomendado.** A régua que sustenta os 4 GB é a soma da
stack em operação, não o WAHA isolado — e a folga existe justamente porque a
parcela por sessão não é conhecida com precisão.

Ao terminar, feche o ciclo — merge na `main` e volte a VPS pra imagem oficial.
