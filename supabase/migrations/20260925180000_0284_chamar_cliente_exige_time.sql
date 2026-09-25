-- 0284_chamar_cliente_exige_time — quem chama o cliente escolhe o time da
-- conversa e fica como dono dela.
--
-- Pedido do dono (2026-09-25). "Chamar no WhatsApp" (`POST
-- /api/v1/conversations/iniciar`) abria a conversa por `fn_service_begin`, que
-- insere a linha SEM time e SEM dono. Duas consequências medidas no código:
--
--   1. a conversa ficava "sem time" para sempre, a menos que alguém a
--      transferisse — e nos modos de visibilidade por time (0281) ela some da
--      vista do próprio time que a iniciou;
--   2. sem dono, a RESPOSTA do cliente caía no roteamento do canal: o rodízio
--      entregava a outra pessoa, ou a IA do canal respondia no lugar de quem
--      chamou.
--
-- `fn_conversation_iniciar_no_time` fecha as duas na mesma transação:
--   * grava o time escolhido;
--   * atribui a conversa a quem chamou, por `fn_conversation_assign` (motivo
--     `claim`) — a mesma função do botão "Assumir", que também cala a IA
--     (`bot_silenced_until = infinity`) e grava o evento de atribuição com
--     `changed_by = auth.uid()`. Não é reimplementada aqui.
--
-- Regras (as mesmas que a tela aplica, repetidas no banco porque a rota é só a
-- primeira barreira):
--   * a organização tem time ativo → o time é OBRIGATÓRIO; sem time nenhum
--     cadastrado, não há o que escolher e a conversa segue só com o dono;
--   * papel `agent` que é membro de algum time → só pode escolher um dos SEUS
--     times; `agent` sem time nenhum, `manager` e `admin` → qualquer time ativo;
--   * a conversa já tem OUTRO dono → recusa (`conversation_owned`). Fechar
--     limpa o dono (`fn_service_status`), então dono presente aqui é dono de
--     um atendimento vivo — tomar a conversa em silêncio seria o takeover que
--     o "Assumir" só faz com `expected_assignee` explícito.
--
-- Client do USUÁRIO, não service_role: `auth.uid()` é quem chamou. Receber o
-- usuário por parâmetro deixaria qualquer chamador escolher o dono.
--
-- Idempotente: `create or replace`, grants reaplicáveis.

create or replace function public.fn_conversation_iniciar_no_time(
  p_org uuid,
  p_conversation uuid,
  p_team uuid
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_role     text;
  v_owner    uuid;
  v_nome     text;
  v_assumiu  boolean := false;
begin
  if v_uid is null
     or not public.fn_role_at_least(p_org, 'agent')
     or not public.fn_support_write_allowed(p_org)
  then
    raise exception 'iniciar_forbidden' using errcode = '42501';
  end if;

  select role into v_role
    from public.user_organizations
   where organization_id = p_org and user_id = v_uid and revoked_at is null;

  if p_team is null then
    if exists (select 1 from public.attendance_teams
                where organization_id = p_org and archived_at is null) then
      raise exception 'team_required' using errcode = '22023';
    end if;
  else
    if not exists (select 1 from public.attendance_teams
                    where organization_id = p_org and id = p_team and archived_at is null) then
      raise exception 'team_not_found' using errcode = 'P0002';
    end if;
    if v_role = 'agent'
       and exists (select 1 from public.attendance_team_members m
                     join public.attendance_teams t
                       on t.organization_id = m.organization_id and t.id = m.team_id
                    where m.organization_id = p_org and m.user_id = v_uid
                      and t.archived_at is null)
       and not exists (select 1 from public.attendance_team_members
                        where organization_id = p_org and team_id = p_team and user_id = v_uid)
    then
      raise exception 'team_not_member' using errcode = '42501';
    end if;
  end if;

  select assigned_to_user_id, assigned_to_user_name into v_owner, v_nome
    from public.conversations
   where organization_id = p_org and id = p_conversation
   for no key update;
  if not found then
    raise exception 'conversation_not_found' using errcode = 'P0002';
  end if;

  if v_owner is not null and v_owner <> v_uid then
    raise exception 'conversation_owned' using errcode = 'P0001', detail = coalesce(v_nome, '');
  end if;

  update public.conversations
     set team_id = p_team, updated_at = now()
   where organization_id = p_org and id = p_conversation
     and team_id is distinct from p_team;

  -- Só membro agent+ pode ser dono (`fn_conversation_assign` recusa os outros).
  -- Quem opera em modo de suporte não é membro: a conversa fica no time e vai
  -- para o roteamento, como numa transferência.
  if v_owner is null then
    if v_role in ('agent', 'manager', 'admin') then
      perform public.fn_conversation_assign(p_org, p_conversation, v_uid, 'claim', null, true);
      v_assumiu := true;
    else
      perform public.fn_request_channel_routing(p_org, p_conversation);
    end if;
  end if;

  return jsonb_build_object(
    'conversation_id', p_conversation,
    'team_id', p_team,
    'assigned_to_user_id', case when v_assumiu or v_owner = v_uid then v_uid end
  );
end;
$$;

revoke execute on function public.fn_conversation_iniciar_no_time(uuid, uuid, uuid) from public, anon;
grant  execute on function public.fn_conversation_iniciar_no_time(uuid, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
