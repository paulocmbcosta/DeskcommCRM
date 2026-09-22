# Conectores de sistema externo — o primeiro é o IXC (provedor de internet)

**Data:** 2026-09-19 · **Estado:** aprovado pelo dono em conversa ("pode seguir, mandar bala") · **Migration:** 0271

## 1. O problema

A Totus (provedor de internet) atende pelo CRM e opera pelo IXC — o ERP onde vivem
contrato, financeiro, OS e conexão. Hoje o atendente sai do CRM e consulta o IXC a cada
conversa. O pedido: uma aba nova no painel direito da conversa com **tudo o que o
atendente precisa para atender sem abrir o IXC** — quem é o cliente, se está bloqueado,
o que deve, OS e atendimentos abertos, conexão e sinal da ONU — e um botão que manda a
fatura no chat.

A restrição que molda o desenho: **o produto é um só para todo cliente.** Amanhã a mesma
imagem Docker atende uma imobiliária, que não tem IXC. A integração precisa ser um bloco
ligável por organização, e o núcleo não pode saber o que é IXC.

## 2. Decisões

### 2.1 Conector = módulo no produto, ligado por organização
Recusados: **fork por cliente** (uma imagem serve todos; fork para de receber update) e
**serviço externo** (não entrega a aba nem o contexto da IA, e é mais uma peça para
instalar em cada VPS). O molde é `lib/channels/` + `docs/doctrine/restricao-de-canal.md`.

- `lib/conectores/registro.ts` é o ÚNICO arquivo do núcleo que importa `lib/conectores/ixc/`.
  Vigiado por `tests/unit/conectores-cerca.test.ts`.
- Conector desligado = nenhuma aba, nenhuma chamada externa, nenhuma linha no banco.
  Instalação que nunca abrir a tela de Conectores não muda em nada.

### 2.2 Dados: identidade referenciada, estado ao vivo (DIRC)
| Dado | Onde vive | Por quê |
|---|---|---|
| Vínculo contato ↔ cliente IXC | `contato_vinculos_externos` (só o id) | **R**eferenciar. Buscar por telefone custa 4 chamadas; paga-se uma vez |
| Contrato, bloqueio, faturas, OS, conexão, sinal | **nada gravado** — API ao vivo | **C**alcular. Dado velho aqui cobra quem já pagou. `fn_areceber` tem 303 mil linhas: nunca espelhar |

Sem cache no servidor nesta entrega: o React Query segura 60 s no cliente. Cache
compartilhado entra junto com a IA (fase seguinte), que é quem cria o segundo leitor.

### 2.3 Credencial só no servidor
Host + token por organização em `conector_conexoes`, token cifrado AES-256-GCM com
`AI_CRED_AES_KEY` (obrigatória em toda instalação — `lib/env.ts`; o `pgcrypto` do
`tenant_integrations` depende de chave que só existe em quem configurou Nuvemshop).
As duas tabelas novas são **server-side only**: RLS ligada, `revoke all` de
`public, anon, authenticated`, acesso só por rota com admin client filtrando
`organization_id` da sessão. Por que não reaproveitar `tenant_integrations`: colunas de
OAuth, vocabulário de status de loja, e `GRANT ALL` a `authenticated`.

### 2.4 Lista branca na borda
As tabelas do IXC devolvem **senhas em claro** (`cliente.senha`, `radusuarios.senha`,
`senha_rede_sem_fio`, `senha_onu_cliente`) e a API não tem projeção de campos. O cliente
HTTP do conector recebe a lista de campos permitidos por tabela e descarta o resto
**antes de devolver** — nada fora dela chega a log, resposta HTTP ou (depois) à IA.

## 3. Fatos medidos no IXC da Totus (2026-09-19)

- `POST {host}/webservice/v1/{tabela}`, header `ixcsoft: listar`, `Authorization: Basic base64(token)`.
  GET com corpo também funciona, mas o `fetch` do Node recusa — usamos POST.
- **Erro vem com HTTP 200.** Recurso inexistente: `text/html` com JSON `{type,message}`.
  Token errado: corpo que nem é JSON. Sucesso: `text/x-json` com `{total, registros}`,
  tudo string. Detecta-se erro **pelo corpo**, nunca por status ou content-type.
- ~1,4 s por chamada pequena. O painel paraleliza: onda 1 (6 chamadas) + onda 2 (sinal, por login).
- Telefones em 4 campos (`whatsapp`, `telefone_celular`, `telefone_comercial`, `fone`),
  mascarados `(99) 99999-9999`; só 64% têm `whatsapp`. LIKE é `oper: "L"`. Busca pelos
  **últimos 8 dígitos com a máscara** (`9999-9999`) — cobre o nono dígito; o DDD é
  conferido depois, no nosso lado. **10% dos celulares pertencem a 2+ clientes.**
- CPF/CNPJ é `cnpj_cpf`, sempre mascarado; busca só casa com a máscara.
- Fatura "aberta" (`status=A`) ≠ vencida: a maioria é parcela futura. 91% das vencidas
  já trazem `linha_digitavel` e `gateway_link` (PDF na Efí) na listagem — **enviar
  fatura é leitura pura**.
- OS = `su_oss_chamado` (aberta = status ≠ `F`). Atendimento = `su_ticket` (aberto =
  `su_status` ≠ `S`). Conexão = `radusuarios`. Sinal = `radpop_radio_cliente_fibra`
  (`sinal_rx/tx` + `data_sinal` — leitura guardada, não medição ao vivo).

## 4. Schema (migration 0271 + apêndice no baseline + MANIFEST)

```sql
conector_conexoes (id, organization_id → organizations cascade, conector check in ('ixc'),
  base_url, token_encrypted/iv/tag bytea, token_last4, status check in ('ativa','erro'),
  status_detalhe, verificada_em, created_by, created_at, updated_at,
  unique (organization_id, conector))

contato_vinculos_externos (id, organization_id, contact_id → contacts cascade,
  conector check in ('ixc'), external_id text, verificado_por check in
  ('telefone','documento','manual'), created_by, created_at,
  unique (organization_id, conector, contact_id, external_id))
```
- Um contato pode ter N vínculos (10% de telefones compartilhados; quem cuida da conta da mãe).
- LGPD: `external_id` reidentifica a pessoa via ERP. Trigger `after update` em `contacts`
  apaga os vínculos quando `is_anonymized` vira `true` (DELETE local — trigger não faz HTTP).
- Junção de contatos: `fn_mesclar_contatos` reponta FKs pelo catálogo e já tolera
  `unique_violation` linha a linha.

## 5. Peças

```
lib/conectores/
  tipos.ts · registro.ts · conexao.ts (cifra, ler, salvar, remover) · vinculos.ts
  ixc/http.ts        POST listar; erro pelo corpo; timeout 12 s; anti-SSRF; lista branca
  ixc/campos.ts      campos permitidos por tabela
  ixc/mascara.ts     telefone/CPF ↔ máscara do IXC; "últimos 8"
  ixc/identificar.ts por telefone (4 campos em paralelo, confere DDD) · por documento
  ixc/vocabulario.ts códigos (status, status_internet, OS, ticket, sinal) → rótulo + tom
  ixc/faturas.ts     TODAS as vencidas + as 2 próximas a vencer; o resto vira contagem
  ixc/resumo.ts      monta o painel; falha é POR SEÇÃO (ERP fora não apaga o que veio)
  ixc/mensagem-fatura.ts  texto da fatura (o servidor compõe; o cliente nunca manda texto)
```

Rotas (`/api/v1`): `GET conectores` (admin — catálogo + estado da conexão) ·
`PUT|DELETE conectores/[c]/conexao` (admin; salvar TESTA antes de gravar) ·
`POST conectores/[c]/conexao/testar` · `GET conectores/ativos` (agent — alimenta o trilho) ·
`GET contacts/[id]/conectores/[c]` (agent — máquina de estados abaixo) ·
`POST|DELETE contacts/[id]/conectores/[c]/vinculo` ·
`POST contacts/[id]/conectores/[c]/faturas/[faturaId]/enviar`.

Estados do painel: `vinculado` (resumo) · `escolher` (2+ candidatos pelo telefone — o
atendente escolhe) · `nao_encontrado` (campo de CPF/CNPJ) · `erro` (ERP fora / token).
Um candidato só → vincula sozinho (`verificado_por='telefone'`).

Regra das faturas (pedido do dono): **todas as vencidas + a próxima a vencer + mais uma.**
Doze parcelas futuras confundem atendente e IA; quem quer o carnê inteiro abre o IXC.

Tela: aba no trilho do `PainelDaConversa` (uma por conector ativo, vinda de
`GET conectores/ativos`) → `components/conectores/ixc/PainelIxc.tsx`. Configuração em
`/app/settings/conectores` (admin), com porta no `NAV_CATALOG`.

## 6. Segurança

- `base_url` passa por `assertSafeOutboundUrl` + `assertDestinoResolvidoSeguro` (anti-SSRF,
  https obrigatório em produção) — o admin do tenant escolhe um host que o SERVIDOR chama.
- Enviar fatura: o servidor relê a fatura no IXC, confere que ela é de um cliente
  VINCULADO àquele contato, e só então compõe o texto. `gateway_link` só sai se for https.
- Auditoria: `conector.conexao_salva`, `conector.conexao_removida`,
  `conector.vinculo_criado`, `conector.vinculo_removido`, `conector.fatura_enviada`.
- Token nunca volta: a tela mostra só `token_last4`.

## 7. Living System Checklist

1. **Quem me alimenta:** API do IXC (estado) e `contacts.phone_number` (identidade).
2. **Quem eu alimento:** o atendente, em `PainelIxc`; a conversa, via `sendMessageHandler` (fatura).
3. **Registro:** `api_audit_log` nas 5 ações acima; a fatura enviada é uma `messages` comum.
4. **Tela:** aba do conector no painel da conversa; `/app/settings/conectores`.
5. **Porta:** `NAV_CATALOG` (Conectores, grupo Organização) + trilho do painel.
6. **Anti-morte:** nenhum — peça de leitura sob demanda; a conversa que a hospeda já tem o seu.
7. **Configuração:** `/app/settings/conectores` — ver estado, trocar token, testar, desligar;
   falha aparece como estado `erro` na tela E como faixa no painel do atendente.
8. **Continuidade IA↔humano:** fora desta entrega (fase IA). O vínculo gravado é o insumo dela.
9. **Laço de retorno:** conexão que falha grava `status='erro'` + detalhe, e a tela de
   configuração passa a mostrar o erro; teste bem-sucedido limpa.
10. **Mapa:** `docs/architecture/conectores.architecture.json`.

## 8. Fora desta entrega (fases seguintes, cada uma com spec própria)

IA (bloco de contexto na abertura + tools) · índice da base para iniciar conversa e
campanhas · escrita no IXC (desbloqueio de confiança, abrir OS — exige token dedicado de
escrita; o IXC não tem sandbox) · PIX copia-e-cola (`pix_txid` existe, o payload não vem
na listagem) · PDF como anexo.

## 9. Não medido

Latência a partir da VPS (medi do Mac do dono) · instância IXC on-premise com
certificado próprio · comportamento com token de escopo mínimo (o token de teste lia tudo).

## 10. Revisão de 2026-09-21 — a cobrança sai como BOLETO EM PDF ou como PIX

Pedido do dono, depois de usar em produção: o que ia no chat era o `gateway_link` (o
boleto no site do banco), e não é esse o documento que o cliente reconhece. O que se
envia é **o PDF que o próprio IXC emite**, e o atendente **escolhe a forma** — boleto
ou Pix. Substitui o §5 no que diz "texto da fatura" e o §8 no que adiava o Pix.

**Medido na instância real (só forma, tamanhos e conferências; nenhum conteúdo):**

| Ação | Pedido | Resposta |
|---|---|---|
| `POST /webservice/v1/get_boleto` | `{boletos, juro:"N", multa:"N", atualiza_boleto:"N", tipo_boleto:"arquivo", base64:"S"}` | o PDF em base64 como **texto puro** (`text/html`, sem JSON em volta); ~45 KB. Fatura inexistente → **corpo vazio**, HTTP 200 |
| `POST /webservice/v1/get_pix` | `{id_areceber}` | `{type, gateway, pix:{dadosPix, qrCode}}`. `qrCode.qrcode` = `dadosPix.pixCopiaECola` (BR Code de 194 chars, CRC16 confere); `dadosPix.status = "ATIVA"`; `valor.original` = `valor_aberto` da fatura. Fatura inexistente → **HTTP 500** |

`juro`, `multa` e `atualiza_boleto` vão `N` de propósito: `S` recalcula e regrava a
cobrança, e este conector só lê. **Não medido:** o que `get_boleto`/`get_pix` fazem com
fatura SEM registro no gateway (parcela futura) — a suspeita é que registrem a
cobrança. Por isso a tela só oferece a forma que o IXC JÁ registrou
(`linha_digitavel` → boleto; `pix_txid` → Pix), e a função recusa
(`forma_indisponivel`) antes de pedir.

**Desenho.** `lib/conectores/ixc/enviar-cobranca.ts` — `enviarCobrancaIxc()` — é a
ÚNICA função que envia cobrança, sem HTTP e sem sessão: recebe a credencial, os
cadastros vinculados, o id da fatura, a forma e duas portas (guardar arquivo, enviar
mensagem). Hoje quem a chama é a rota do botão; **a ferramenta da IA vai chamar a
mesma**, com o ator dela. O que ela garante, venha o pedido de quem vier: fatura relida
e de cadastro vinculado; em aberto; forma registrada; PDF começa com `%PDF`;
copia-e-cola fecha o CRC16 e o Pix está `ATIVA`. Cada cobrança são duas mensagens — o
arquivo com a legenda (documento PDF ou imagem do QR code), e o código SOZINHO (linha
digitável ou copia-e-cola), para copiar com um toque.

- **QR code gerado aqui** (`lib/conectores/ixc/pix.ts`, lib `qrcode`, 600px, margem 4),
  a partir do copia-e-cola CONFERIDO — a câmera e o copiar-e-colar pagam a mesma coisa.
  A imagem que o IXC devolve é pequena e é um segundo dado.
- **Lista branca também na ação:** de `get_pix` saem três campos (copia-e-cola, status,
  valor). CPF e nome do devedor, chave e txid ficam na borda.
- **Storage-first:** o arquivo sobe em `whatsapp-media/<org>/<conversa>/boleto-DD-MM-AAAA-<8hex>.pdf`
  — o último segmento é o nome que o cliente vê no WhatsApp.
- `gateway_link` saiu da lista branca; `pix_txid` entrou (só para saber SE há Pix).
- Tela: "Enviar" abre a escolha [Boleto] [Pix]; escolher é o segundo toque (envio é
  irreversível). Forma não registrada fica desligada, com o porquê no `title`.

### 10.1 Correção de 2026-09-22 — o Pix é gerado SOB DEMANDA

O §10 dizia "a tela só oferece a forma que o IXC JÁ registrou (`pix_txid` → Pix)". Para
o Pix isso estava **errado**, e o dono achou em produção no primeiro teste: um cadastro
ativo com quatro faturas abertas — duas com boleto registrado e **nenhuma com
`pix_txid`** — ficava com o botão de Pix desligado em todas. (A amostra que sustentou a
regra eram 200 faturas VENCIDAS, e nelas 164 tinham os dois: fatura vencida já passou
pelo momento em que o IXC gera o Pix; fatura a vencer, não.)

O IXC gera o Pix quando alguém pede — é o que `get_pix` faz, e é o que a central do
assinante faz no "pagar com Pix". **Escolher Pix É pedir que ele seja gerado.** Então:

- **Pix:** oferecido em toda fatura em aberto. Sem `pix_txid`, o botão avisa no `title`
  que o Pix será gerado agora. O resultado carrega `pixGeradoAgora`, e a auditoria grava
  `pix_gerado_agora` — é o ÚNICO efeito deste conector no ERP, e fica na trilha de quem pediu.
- **Boleto:** continua exigindo registro (`linha_digitavel`). Sem registro não há PDF, e
  pedir `get_boleto` faria o IXC registrar um boleto que ninguém pediu.
- **Recusa com motivo:** quando `get_pix` não devolve o código, a frase do próprio IXC
  (`message`, sem marcação, uma linha, ≤200 chars) vai até o atendente — carteira sem
  Pix e usuário do token sem permissão são consertos de quem administra o IXC, e só o
  IXC sabe dizer qual é.
- **Segunda chamada, uma só:** resposta de SUCESSO que ainda não traz o código ganha
  uma repetição depois de 1,5 s.

**Não medido:** a resposta real de `get_pix` para fatura sem `pix_txid` — chamá-lo gera
uma cobrança no gateway do cliente, e isso é ato do operador, não de sonda. A forma
medida (fatura que já tinha Pix) é a que o código espera; o que vier diferente cai na
recusa com a frase do IXC.

