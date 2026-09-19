-- ---- conectores de sistema externo — o primeiro é o IXC (migration 0271) ----
--
-- O CRM atende; o ERP do cliente opera. Num provedor de internet o atendente
-- saía do CRM a cada conversa para ver, no IXC, se o cliente está bloqueado, o
-- que deve, se tem OS aberta e como está a conexão. Um CONECTOR traz isso para o
-- painel da conversa — ligado POR ORGANIZAÇÃO, porque o produto é um só e a
-- imobiliária da instalação ao lado não tem IXC.
--
-- Duas tabelas, e o que NÃO está aqui é a decisão principal: nenhum dado do ERP
-- é copiado. Contrato, fatura, OS e conexão são lidos ao vivo — dado financeiro
-- velho cobra quem já pagou (spec docs/superpowers/specs/2026-09-19-conector-ixc-design.md).
--
--   conector_conexoes ........... host + token da organização naquele sistema.
--   contato_vinculos_externos ... o ponteiro contato ↔ cadastro no ERP. Achar o
--                                 cliente pelo telefone custa 4 chamadas; paga-se
--                                 uma vez e grava-se só o id.
--
-- POR QUE NÃO `tenant_integrations`: as colunas são de OAuth, o vocabulário de
-- status é de loja, o `GRANT ALL` dela alcança `authenticated`, e a cifra
-- (`fn_encrypt_oauth`) depende de uma chave mestra que só existe em quem
-- configurou Nuvemshop. Aqui o token é cifrado no Node com `AI_CRED_AES_KEY`,
-- que `lib/env.ts` exige de TODA instalação.
--
-- SERVER-SIDE ONLY, as duas. O `alter default privileges` do topo do baseline
-- concede tabela nova a `anon` e `authenticated`, e o default ACL do Supabase real
-- faz o mesmo: o `revoke` abaixo é o que protege, não a ausência de GRANT. RLS
-- fica ligada SEM policy — o dia em que alguém escrever "só uma policy de
-- leitura", o privilégio continua não existindo. Quem lê e grava é a rota, com o
-- admin client, filtrando `organization_id` resolvido da sessão.
-- Medido por tests/invariants/conectores-sao-server-side.test.ts.

create table if not exists public.conector_conexoes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  conector         text not null,
  base_url         text not null,
  token_encrypted  bytea not null,
  token_iv         bytea not null,
  token_tag        bytea not null,
  token_last4      text not null,
  status           text not null default 'ativa',
  status_detalhe   text,
  verificada_em    timestamptz,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint conector_conexoes_conector_check check (conector in ('ixc')),
  constraint conector_conexoes_status_check check (status in ('ativa', 'erro')),
  constraint conector_conexoes_uma_por_org unique (organization_id, conector)
);

comment on table public.conector_conexoes is
  'A conexão de UMA organização com UM sistema externo (hoje: IXC). Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated. O token é AES-256-GCM (AI_CRED_AES_KEY) e nunca volta em claro — a tela mostra só token_last4.';
comment on column public.conector_conexoes.status is
  'ativa | erro. É o laço de retorno da peça: a chamada que falha por credencial ou host grava erro + status_detalhe, e a tela de Conectores passa a mostrar; teste bem-sucedido devolve a ativa.';

create table if not exists public.contato_vinculos_externos (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  contact_id       uuid not null references public.contacts(id) on delete cascade,
  conector         text not null,
  external_id      text not null,
  verificado_por   text not null,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint contato_vinculos_externos_conector_check check (conector in ('ixc')),
  constraint contato_vinculos_externos_verificado_check
    check (verificado_por in ('telefone', 'documento', 'manual')),
  constraint contato_vinculos_externos_unico
    unique (organization_id, conector, contact_id, external_id)
);

comment on table public.contato_vinculos_externos is
  'Ponteiro contato ↔ cadastro num sistema externo. Guarda SÓ o id de lá (DIRC: referenciar) — nome, contrato e financeiro são lidos ao vivo. Um contato pode ter N vínculos: no IXC da Totus, 10% dos celulares pertencem a 2+ cadastros. Server-side only.';
comment on column public.contato_vinculos_externos.verificado_por is
  'Como o vínculo nasceu: telefone (o número da conversa bateu com UM cadastro), documento (CPF/CNPJ informado) ou manual (o atendente escolheu entre candidatos). É o que a fase da IA vai ler para decidir se pode falar de financeiro.';

create index if not exists contato_vinculos_externos_por_contato
  on public.contato_vinculos_externos (organization_id, contact_id);

alter table public.conector_conexoes          enable row level security;
alter table public.contato_vinculos_externos  enable row level security;

revoke all on public.conector_conexoes, public.contato_vinculos_externos
  from public, anon, authenticated;
grant select, insert, update, delete
  on public.conector_conexoes, public.contato_vinculos_externos
  to service_role;

-- `create or replace trigger` (pg14+; o piso é 15), e não `drop` + `create`: o
-- `update.sh` re-aplica este bloco com o app e o worker DE PÉ, sem ON_ERROR_STOP.
-- `drop trigger` pede ACCESS EXCLUSIVE e já deadlockou com o worker de pé (medido
-- ao atualizar a VPS em 2026-09-18, em `job_queue`); se o `drop` passa e o `create`
-- cai, a catraca some até a próxima atualização. Um comando só não tem esse
-- meio-termo.
create or replace trigger trg_conector_conexoes_updated_at
  before update on public.conector_conexoes
  for each row execute function public.fn_set_updated_at();

-- O vínculo é de UM contato da MESMA organização. `contacts` não tem unique
-- (organization_id, id) para uma FK composta, e quem grava aqui é o service_role
-- — que ignora RLS. Esta é a catraca que sobra quando a rota erra.
create or replace function public.fn_vinculo_externo_confere_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.contacts c
     where c.id = new.contact_id and c.organization_id = new.organization_id
  ) then
    raise exception 'vinculo_externo_de_outra_organizacao' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_vinculo_externo_confere_org() from public, anon, authenticated;

create or replace trigger trg_vinculo_externo_confere_org
  before insert or update on public.contato_vinculos_externos
  for each row execute function public.fn_vinculo_externo_confere_org();

-- LGPD: o `external_id` reidentifica a pessoa pelo ERP. Contato anonimizado que
-- guardasse o vínculo seria "Cliente Anonimizado #N" com o número do cadastro ao
-- lado. Sem `OF is_anonymized` de propósito: `after update of coluna` não dispara
-- quando a coluna muda por trigger BEFORE (medido na 0266), e o `when` já filtra.
-- É DELETE local — trigger não faz HTTP.
create or replace function public.fn_vinculos_externos_somem_com_a_anonimizacao()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.contato_vinculos_externos where contact_id = new.id;
  return null;
end;
$$;
revoke execute on function public.fn_vinculos_externos_somem_com_a_anonimizacao() from public, anon, authenticated;

create or replace trigger trg_vinculos_externos_somem_com_a_anonimizacao
  after update on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_vinculos_externos_somem_com_a_anonimizacao();

notify pgrst, 'reload schema';
