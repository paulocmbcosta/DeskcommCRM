-- 0292 — o número é único por MEIO: mensagem e telefone não disputam o mesmo número
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
-- `channel_sessions_phone_per_org_unique` é do snapshot original, de quando
-- `channel_sessions` só guardava transporte de WhatsApp. "O par (organização,
-- número) é único" queria dizer "um número não entra por dois transportes de
-- mensagem" — e a 0087 registrou exatamente isso: a trava "responde a 'um número
-- vive em UM provider' porque não olha o provider".
--
-- A telefonia (0286) pôs o tronco SIP na mesma tabela e escreveu no cabeçalho
-- que "herda de graça a unicidade (organization_id, phone_number) dos ativos".
-- Herdou — e junto a recusa de um caso legítimo e comum: o número FIXO da
-- empresa é, ao mesmo tempo, o número da API oficial do WhatsApp e a linha de
-- voz na operadora. São dois MEIOS do mesmo número, não repetição.
--
-- Medido em produção em 2026-10-02: cadastrar em Conexões › Telefone um número
-- que já atendia pelo WhatsApp oficial devolvia `numero_ja_existe` ("Esse número
-- já está conectado nesta organização") a quem nunca o tinha ligado na
-- telefonia. O INSERT do tronco estourava 23505 nesta trava, contra a linha do
-- canal oficial.
--
-- ─── O invariante certo ────────────────────────────────────────────────────
-- "Um número vive em UM canal ATIVO por meio." São duas travas:
--
--   1. `channel_sessions_phone_per_org_unique` — o MESMO NOME, agora só entre os
--      canais que NÃO são telefone. O nome fica porque
--      `tests/invariants/channel-provider-schema.test.ts` o cobra dentro do erro
--      do INSERT recusado, e o caso que ele descreve (o mesmo número em dois
--      transportes de mensagem) continua recusado.
--   2. `channel_sessions_sip_phone_per_org_unique` — entre os troncos de
--      telefone. Dois troncos ativos com o mesmo número disputariam a
--      identidade de quem liga para fora; segue recusado, como antes.
--
-- O predicado nomeia o provider por extenso porque o banco não conhece o meio:
-- o mapa provider → meio mora em `lib/channels/capabilities.ts` (`meioDoCanal`).
-- Quem cobra que os dois falam do mesmo recorte é
-- `tests/invariants/numero-unico-por-meio.test.ts` — um segundo provider de
-- telefone que nasça lá reprova aqui, em vez de cair na trava da mensagem.
--
-- ─── Idempotência, e por que o índice não é reconstruído a cada update ──────
-- Trocar o predicado de um índice parcial só se faz derrubando e recriando. O
-- bloco `do` faz os dois NO MESMO comando — e portanto na mesma transação: não
-- há instante em que a tabela fica sem a trava, e um run que morre no meio volta
-- inteiro. Ele só age enquanto a definição em vigor é a antiga (não cita
-- `sip_trunk`): na segunda aplicação não derruba nada, e o `update.sh` não paga
-- a reconstrução do índice a cada versão.
--
-- ─── Backfill: nenhum, por construção ──────────────────────────────────────
-- A trava antiga é ESTRITAMENTE mais forte que as duas novas somadas (ela olha
-- todos os ativos; cada nova olha um subconjunto disjunto deles). Nenhum banco
-- que a satisfazia pode violar qualquer uma das duas — vale para todo clone.

do $$
begin
  if exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where c.relname = 'channel_sessions_phone_per_org_unique'
       and c.relnamespace = 'public'::regnamespace
       and pg_get_indexdef(i.indexrelid) not like '%sip_trunk%'
  ) then
    drop index public.channel_sessions_phone_per_org_unique;
    create unique index channel_sessions_phone_per_org_unique
      on public.channel_sessions (organization_id, phone_number)
      where archived_at is null and provider <> 'sip_trunk';
  end if;
end $$;

-- Banco em que a trava não existe com nome nenhum (não deveria haver): nasce já certa.
create unique index if not exists channel_sessions_phone_per_org_unique
  on public.channel_sessions (organization_id, phone_number)
  where archived_at is null and provider <> 'sip_trunk';

create unique index if not exists channel_sessions_sip_phone_per_org_unique
  on public.channel_sessions (organization_id, phone_number)
  where archived_at is null and provider = 'sip_trunk';

comment on index public.channel_sessions_phone_per_org_unique is
  'Um número vive em UM canal ativo que não é telefone (migration 0292). O tronco SIP tem a trava dele: o mesmo número pode atender pelo WhatsApp e ser linha de voz.';
comment on index public.channel_sessions_sip_phone_per_org_unique is
  'Um número vive em UM tronco de telefone ativo por organização (migration 0292). Par da channel_sessions_phone_per_org_unique, que cobre os demais canais.';
