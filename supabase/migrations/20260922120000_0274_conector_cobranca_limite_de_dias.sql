-- 0274 · O limite de dias para a IA encaminhar a fatura à Cobrança.
--
-- Fase 4 do conector IXC: a IA identifica o cliente e envia a cobrança da fatura
-- da vez (spec docs/superpowers/specs/2026-09-22-ia-envia-cobranca-ixc-design.md).
-- Regra do dono do produto (22/09): fatura com MAIS de N dias de atraso não é
-- enviada — a IA diz que ela foi encaminhada ao setor de cobrança e transfere a
-- conversa. N é configuração da TELA (Configurações › Conectores), padrão 60.
--
-- Mora em `conector_conexoes` porque é política de cobrança DAQUELA conexão com o
-- sistema de gestão, e a tabela já é server-side only (0271): nenhum GRANT novo.
-- Coluna tipada, não jsonb: é um número com faixa, e o CHECK é quem a guarda.
--
-- Idempotente: `add column if not exists` com default (preenche as linhas que já
-- existem) e o CHECK criado só se faltar. O `update` normalizador roda ANTES do
-- `add constraint` (doutrina de migrations, item 8): sem ele, um clone com linha
-- fora da faixa (NULL de um `update.sh` antigo, ou um valor herdado de bug) faz
-- o `add constraint` falhar — e como o `update.sh` roda SEM `ON_ERROR_STOP`, ele
-- segue em frente com a coluna sem CHECK nenhum, e nenhum sintoma visível.

alter table public.conector_conexoes
  add column if not exists cobranca_encaminha_apos_dias integer not null default 60;

update public.conector_conexoes
   set cobranca_encaminha_apos_dias = 60
 where cobranca_encaminha_apos_dias is null
    or cobranca_encaminha_apos_dias not between 1 and 3650;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'conector_conexoes_cobranca_encaminha_apos_dias_check'
       and conrelid = 'public.conector_conexoes'::regclass
  ) then
    alter table public.conector_conexoes
      add constraint conector_conexoes_cobranca_encaminha_apos_dias_check
      check (cobranca_encaminha_apos_dias between 1 and 3650);
  end if;
end $$;

comment on column public.conector_conexoes.cobranca_encaminha_apos_dias is
  'Fatura com mais dias de atraso que isto a IA NÃO envia: encaminha à Cobrança (migration 0274).';

notify pgrst, 'reload schema';
