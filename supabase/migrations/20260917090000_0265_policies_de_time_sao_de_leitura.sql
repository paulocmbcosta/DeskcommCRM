-- ---- as policies de time são de LEITURA, não ALL (migration 0265) ----
--
-- Forward-fix da 0263 (já aplicada, então não se edita). Ela criou as duas
-- policies como `for all` com predicado só de tenancy, e o invariante
-- `rbac-config-ia-canais` reprova isso para tabela NOVA: policy `ALL` cujo
-- predicado não menciona `role_at_least` é dívida de RBAC, e a dívida não cresce.
--
-- O `for all` nunca foi necessário. A escrita NÃO passa por RLS: ela é feita por
-- `fn_save_attendance_team`, `fn_archive_attendance_team` e
-- `fn_conversation_set_team`, que são `security definer` e rodam como o dono; e
-- o `revoke all` da 0263 tira INSERT/UPDATE/DELETE dos três papéis do PostgREST,
-- medido em produção. Uma policy `ALL` aqui é largura sem consumidor.
--
-- `for select` também é o que as tabelas gêmeas fazem —
-- `tenant_isolation_channel_routing_policies_select` e a de responsáveis — e o
-- nome acompanha, para que as quatro se leiam como uma família só.
--
-- A leitura NÃO ganha `role_at_least` de propósito: o inbox precisa NOMEAR o
-- time de uma conversa, e o selo é visível a `viewer`. Restringir a leitura por
-- papel imprimiria "Sem time" numa conversa que tem time — afirmação falsa onde
-- havia informação.

drop policy if exists tenant_isolation_attendance_teams_all on public.attendance_teams;
drop policy if exists tenant_isolation_attendance_teams_select on public.attendance_teams;
create policy tenant_isolation_attendance_teams_select on public.attendance_teams for select to authenticated
 using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

drop policy if exists tenant_isolation_attendance_team_members_all on public.attendance_team_members;
drop policy if exists tenant_isolation_attendance_team_members_select on public.attendance_team_members;
create policy tenant_isolation_attendance_team_members_select on public.attendance_team_members for select to authenticated
 using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
