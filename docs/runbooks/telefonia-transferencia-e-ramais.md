# Roteiro — provar a transferência (v2) e os ramais (v3) na VPS

Para o dono, depois do merge e da release que traz as migrations **0290** e **0291**.
Desenho: emenda §12 de
[`docs/superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md`](../superpowers/specs/2026-09-28-telefonia-fase2-ura-transferencia-ramais-design.md).
Casos: J38 de [`docs/testing/user-journey-map.md`](../testing/user-journey-map.md).

O que a sessão que escreveu isto **não** conseguiu fazer (ela rodou num contêiner na nuvem,
sem acesso à VPS): medir o formato do evento de usuário da ARI, fazer o deploy e ligar. Tudo
abaixo é para ser feito na ordem.

## 1. Antes do deploy: a sonda do evento de usuário (5 min)

A transferência depende de a ordem da tela chegar ao worker como `ChannelUserevent`, com as
variáveis em `userevent` (plano, I5). O parser está num lugar só
(`lerOrdemDaTransferencia`, `lib/channels/telefonia/transferencia.ts`). A sonda usa uma
aplicação Stasis de OUTRO nome (`sonda`) — nunca uma segunda conexão ao app `crm`.

Dentro do contêiner do worker (ele tem `TELEFONIA_ARI_URL` e `TELEFONIA_ARI_PASSWORD`):

```bash
docker exec -i deskcommcrm-worker-1 node -e '
const base = process.env.TELEFONIA_ARI_URL.replace(/\/+$/, "");
const auth = "Basic " + Buffer.from("crm:" + process.env.TELEFONIA_ARI_PASSWORD).toString("base64");
const u = new URL(base + "/ari/events"); u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
u.searchParams.set("app", "sonda"); u.searchParams.set("subscribeAll", "false");
const ws = new WebSocket(u, { headers: { Authorization: auth } });
ws.onopen = async () => {
  const r = await fetch(base + "/ari/events/user/telefonia_transferencia?application=sonda", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ variables: { acao: "transferir", transferencia_id: "00000000-0000-4000-8000-000000000000", voice_call_id: "sonda" } }),
  });
  console.log("POST", r.status);
};
ws.onmessage = (m) => { console.log(String(m.data)); ws.close(); };
setTimeout(() => process.exit(0), 5000);
'
```

**Esperado:** `POST 204` e uma linha JSON com `"type":"ChannelUserevent"`,
`"eventname":"telefonia_transferencia"` e `"userevent":{"acao":"transferir",…}`.
Se o formato for outro, a transferência não anda: pare aqui e ajuste só
`lerOrdemDaTransferencia` (e o teste dele) antes do deploy.

## 2. Deploy

Siga o §1 de [`docs/runbooks/deploy.md`](deploy.md): a versão mexe no **worker**, então
`update.sh`, ou `up -d app worker` com os DOIS arquivos de compose:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app worker
```

O Asterisk não muda nesta versão. Depois:

- o domínio responde **307** (não 404);
- `/api/v1/health` verde;
- em Conexões › Telefone, o número segue **Conectado**;
- os objetos no banco:

```bash
psql "$SUPABASE_DB_URL" -c "select to_regclass('public.voice_call_transfers'), to_regclass('public.phone_extensions');"
psql "$SUPABASE_DB_URL" -c "select o.display_name, e.\"number\", coalesce(u.raw_user_meta_data->>'full_name', u.email)
  from phone_extensions e join organizations o on o.id = e.organization_id join auth.users u on u.id = e.user_id
  order by o.display_name, e.\"number\";"
```

Os ramais de quem já atende foram criados pela migration (a partir de 201, na ordem de
entrada na organização).

## 3. A prova, com duas contas `agent` em dois navegadores

Use **duas contas de atendente** (não a sua de dono: ela é platform admin) — A e B — em dois
navegadores diferentes (ou um normal e um anônimo), as duas **disponíveis** e no mesmo time.
O cliente é o seu celular ligando para o **(61) 3686-1503**.

| # | O que fazer | O que tem de acontecer |
|---|---|---|
| 1 | Nos dois navegadores, abra o telefone do cabeçalho | Cada um mostra "Seu ramal: 20x" |
| 2 | Ligue do celular; A atende | Ligação normal |
| 3 | A: Transferir → B → **Transferir** | O celular passa a ouvir música; o painel de A some; o de B toca com "Transferida por A"; B atende e fala com o celular |
| 4 | De novo, com B deixando tocar sem atender | Depois de ~20 s, o de A toca com "B não atendeu, o cliente voltou"; A atende e o celular volta a falar com A |
| 5 | De novo, B e A deixando tocar | A ligação vai para a fila do time (sem A no rodízio); ninguém atendendo, o celular ouve "ninguém atendeu" e a Central ganha "Ligar de volta" |
| 6 | A: Transferir → B → **Falar antes** | O celular ouve música; A ouve chamando e depois fala com B; o painel de A mostra "Falando com B · cliente em espera" |
| 7 | A: **Completar transferência** | B fica com o celular; A cai |
| 8 | Repita 6 e use **Voltar ao cliente** | B cai; A volta a falar com o celular |
| 9 | Transferir para um **time** | A cai; toca quem está livre no time |
| 10 | A disca **o ramal de B** (ou o nome) no telefone do cabeçalho | B vê "Ligação interna · A (20x)"; atendendo, os dois conversam |
| 11 | Em Conexões › Telefone › Menus, ligue "O cliente pode digitar o ramal" no menu e salve; ligue do celular **…9197** (o único que manda tecla) e digite o ramal de B | Toca direto em B |
| 12 | Conexões › Telefone › Ramais: troque o ramal de B; tente pôr o de A | Salva; o de A é recusado com "Esse ramal já é de outra pessoa." |

Depois de cada ligação, o cartão da ligação na conversa conta a corrente
("A transferiu para B · B atendeu").

## 4. Se algo não andar

- **Transferir não faz nada / recusa com "A telefonia não respondeu":** a ordem não chegou ao
  Asterisk. `docker logs deskcommcrm-app-1 --since 5m | grep 'ordem de transferência'`.
- **O painel mostra "O serviço de telefonia não encontrou a ligação":** o worker não conhecia
  a ligação (reiniciou). `docker logs deskcommcrm-worker-1 --since 5m | grep 'telefonia: '`.
- **Nada no log do worker ao transferir:** o formato do evento não é o esperado — volte ao §1.
- Os motivos de cada recusa ficam em `voice_call_transfers.reason`:

```bash
psql "$SUPABASE_DB_URL" -c "select created_at, kind, status, outcome, reason from voice_call_transfers order by created_at desc limit 10;"
```
