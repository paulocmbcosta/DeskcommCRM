-- 0287 — telefonia SIP: prefixo de discagem por número.
--
-- Spec: docs/specs/20-spec-telefonia-sip.md §6. Medido em produção em
-- 2026-09-28, operadora Totus (FreeSWITCH), ligação de SAÍDA para o mesmo
-- celular:
--
--   61995140098   (DDD + número, o que o CRM mandava) → 404 Not Found
--   5561995140098                                      → 480
--   061995140098  (0 + DDD + número)                   → 183, tocou, 200 OK
--   995140098     (local, sem DDD)                     → 183, tocou
--
-- A "ligação feita" da prova anterior só completou porque discou o número da
-- própria conta, dentro da rede da operadora. Cada operadora tem a sua regra
-- (0 + DDD; 0 + código da operadora + DDD, como `015…`; DDD puro), então o
-- prefixo é do NÚMERO, não da instalação: `channel_sessions.sip_dial_prefix`.
--
-- Só dígitos, de 1 a 4. O valor é colado na frente do número DENTRO do destino
-- PJSIP (`PJSIP/<prefixo><número>@tronco-<id>`); qualquer outro caractere
-- mudaria para onde o Asterisk disca. O CHECK é a mesma régua do Zod da rota e
-- do worker (`PREFIXO_DE_DISCAGEM`, lib/channels/telefonia/conta-sip.ts) — a
-- coluna é gravável pela REST, fora do Zod. NULL = sem prefixo (o
-- comportamento de antes). O antifraude (`lib/telefonia/numero.ts`) continua
-- julgando o número SEM o prefixo: ele vem do banco, nunca do que o atendente
-- digitou.
--
-- Idempotente e auto-curativa: coluna com `if not exists`; um valor fora da
-- régua (só possível com o CHECK derrubado à mão) vira NULL ANTES de o CHECK
-- ser recriado — sem isto o `add constraint` falharia e o `update.sh`, que roda
-- sem ON_ERROR_STOP, seguiria com a coluna sem CHECK. NULL é o lado seguro: um
-- prefixo desses nunca discaria (o worker recusa), e sem ele a saída volta a
-- ser DDD + número. Nenhuma função, GRANT ou policy nova.

alter table public.channel_sessions
  add column if not exists sip_dial_prefix text;

update public.channel_sessions
   set sip_dial_prefix = null
 where sip_dial_prefix is not null
   and sip_dial_prefix !~ '^[0-9]{1,4}$';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_sip_dial_prefix_check;
alter table public.channel_sessions
  add constraint channel_sessions_sip_dial_prefix_check
  check (sip_dial_prefix is null or sip_dial_prefix ~ '^[0-9]{1,4}$');

comment on column public.channel_sessions.sip_dial_prefix is
  'Prefixo de discagem do número SIP: dígitos (1 a 4) que o worker põe ANTES do DDD na ligação de saída — ex.: 0, ou 0 + código da operadora (015). NULL = DDD + número. Por número porque cada operadora tem a sua regra (medido na Totus: sem o 0, 404). Lido por lib/channels/telefonia/repositorio.ts; colado no destino por enderecoDeSaida (pjsip.ts), que confere a régua de novo.';

notify pgrst, 'reload schema';
