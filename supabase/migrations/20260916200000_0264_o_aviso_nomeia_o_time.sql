-- ---- o aviso de roteamento nomeia o time (migration 0264) ----
--
-- Forward-fix da 0263 (já aplicada): o aviso da Central existia e resolvia
-- sozinho, mas mandava o gestor conferir os responsáveis do CANAL — o lugar
-- errado quando a conversa espera na fila de um SETOR.
create or replace function public.fn_routing_unassigned_notice(p_org uuid,p_conversation uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
declare v_time text;
begin
 if not exists(select 1 from public.conversations where organization_id=p_org and id=p_conversation
  and assigned_to_user_id is null and status in('open','pending','claimed','ai_handling')) then return;end if;
 select t.name into v_time from public.conversations c
   join public.attendance_teams t on t.id=c.team_id and t.organization_id=c.organization_id
  where c.organization_id=p_org and c.id=p_conversation;
 insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
 values(p_org,'routing_unassigned','warn',
  case when v_time is null then 'Uma conversa aguarda um responsável'
       else 'Uma conversa aguarda o time ' || v_time end,
  case when p_reason='invalid_channel' then 'Confira o canal de origem desta conversa nas Conexões.'
   when v_time is not null then 'Ninguém do time ' || v_time || ' pode assumir agora. Confira quem está alocado nele e o horário do time em Configurações → Times de atendimento. A distribuição continuará tentando.'
   else 'Confira os responsáveis do canal em Configurações → Atendimento e a disponibilidade da equipe. A distribuição continuará tentando.' end,
  'conversation',p_conversation)
 on conflict(organization_id,ref_id,kind) where kind='routing_unassigned'
 do update set status='open',title=excluded.title,body=excluded.body;
end;
$$;
revoke execute on function public.fn_routing_unassigned_notice(uuid,uuid,text) from public, anon, authenticated;
grant  execute on function public.fn_routing_unassigned_notice(uuid,uuid,text) to service_role;
