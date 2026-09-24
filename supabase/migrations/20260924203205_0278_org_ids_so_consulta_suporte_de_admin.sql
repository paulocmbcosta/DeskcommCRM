-- 0278 · `fn_user_org_ids` e `fn_user_role_in_org` só consultam o contexto de
-- suporte de quem É administrador da plataforma.
--
-- Incidente de 2026-09-24 (produção fora do ar, 18:57–19:13 UTC): a contagem
-- de uma aba do Inbox levava ~200 ms para 42 conversas com o banco calmo, e
-- ~1,4 s com ele carregado. Medido por função (`track_functions`): 60% do tempo
-- era `fn_support_context()`, chamada DUAS vezes por conversa — o campo
-- calculado `comando_da_conversa` lê `contacts` duas vezes por linha, e a RLS de
-- `contacts` chama `fn_user_org_ids()`, que chamava `fn_support_context()`.
--
-- `fn_support_context()` junta platform_support_sessions + organizations +
-- platform_admins + auth.sessions + auth.mfa_factors. Só que as duas funções
-- daqui usam dela APENAS o status 'active' — e 'active' exige a linha de
-- `platform_admins` não revogada (o `left join ... p` + `p.user_id is null` →
-- 'revoked' no corpo dela). Para quem não é administrador da plataforma, isto é,
-- todo atendente, o resultado era sempre vazio, pago a cada linha.
--
-- O portão (`exists` em platform_admins) é EQUIVALENTE: não muda o que nenhuma
-- das duas devolve para ninguém, só pula a consulta que para não-administrador
-- sempre dava vazio. O `where` de um SELECT sem FROM vira "One-Time Filter": com
-- ele falso, `fn_support_context()` nem é avaliada.
--
-- `fn_support_context()` em si NÃO muda: o app lê dela também o status
-- 'revoked'/'expired' (para encerrar a sessão de suporte na tela), e
-- `fn_support_write_allowed` depende desses estados.
--
-- Idempotente (`create or replace`, mesma assinatura, mesmas permissões:
-- `create or replace` preserva o ACL). Nenhuma tabela, constraint ou grant novo.

create or replace function public.fn_user_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $f$
 select organization_id from public.user_organizations where user_id=auth.uid() and revoked_at is null
 union
 select (s->>'organization_id')::uuid
   from (select public.fn_support_context() s
          where exists (select 1 from public.platform_admins pa
                         where pa.user_id = auth.uid() and pa.revoked_at is null)) c
  where s->>'status'='active';
$f$;

create or replace function public.fn_user_role_in_org(p_org uuid)
returns text language sql stable security definer set search_path = public as $f$
 select coalesce(
   (select case when s->>'access_mode'='full' then 'admin' else 'viewer' end
      from (select public.fn_support_context() s
             where exists (select 1 from public.platform_admins pa
                            where pa.user_id = auth.uid() and pa.revoked_at is null)) c
     where s->>'status'='active' and (s->>'organization_id')::uuid=p_org),
   (select role from public.user_organizations
     where user_id=auth.uid() and organization_id=p_org and revoked_at is null limit 1));
$f$;

revoke execute on function public.fn_user_org_ids() from public, anon;
grant  execute on function public.fn_user_org_ids() to authenticated, service_role;
revoke execute on function public.fn_user_role_in_org(uuid) from public, anon;
grant  execute on function public.fn_user_role_in_org(uuid) to authenticated, service_role;
