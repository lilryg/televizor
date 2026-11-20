-- Run in the Supabase SQL Editor as postgres. All test data is rolled back.
begin;
set local role authenticated;
do $$
declare
  owner_id uuid := gen_random_uuid();
  guest_id uuid := gen_random_uuid();
  stranger_id uuid := gen_random_uuid();
  wanted_room uuid;
  invitation uuid;
  stream uuid;
  attempt uuid := gen_random_uuid();
  state jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  wanted_room := public.tv_enter('Хост');
  select invite into strict invitation from public.tv_rooms where id = wanted_room and host = owner_id;

  perform set_config('request.jwt.claims', jsonb_build_object('sub',stranger_id,'role','authenticated')::text,true);
  if exists (select from public.tv_rooms where id = wanted_room) then raise exception 'Stranger can read room'; end if;
  begin
    perform public.tv_action(wanted_room,'heartbeat');
    raise exception 'Expected membership rejection';
  exception when raise_exception then
    if sqlerrm <> 'Доступ к комнате закрыт.' then raise; end if;
  end;

  perform set_config('request.jwt.claims', jsonb_build_object('sub',guest_id,'role','authenticated')::text,true);
  if public.tv_enter('Зритель',invitation) <> wanted_room then raise exception 'Join returned a wrong room'; end if;
  if (select count(*) from public.tv_members m where m.room_id = wanted_room) <> 2 then raise exception 'Roster is incomplete'; end if;
  begin
    perform public.tv_action(wanted_room,'start_tab');
    raise exception 'Expected host permission rejection';
  exception when raise_exception then
    if sqlerrm <> 'Это действие доступно только хосту.' then raise; end if;
  end;

  perform set_config('request.jwt.claims', jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  state := public.tv_action(wanted_room,'video','{"url":"https://example.com/test.mp4"}');
  if state->>'mode' <> 'video' then raise exception 'Video did not open'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',guest_id,'role','authenticated')::text,true);
  state := public.tv_action(wanted_room,'play',jsonb_build_object('version',state->'version'));
  if state->>'paused' <> 'false' then raise exception 'Play did not update state'; end if;
  state := public.tv_action(wanted_room,'seek',jsonb_build_object('version',state->'version','position',60));
  if state->>'position' <> '60' then raise exception 'Seek did not update state'; end if;
  begin
    perform public.tv_action(wanted_room,'pause','{"version":0}');
    raise exception 'Expected stale command rejection';
  exception when raise_exception then
    if sqlerrm <> 'Видео уже изменилось. Повтори действие.' then raise; end if;
  end;
  state := public.tv_action(wanted_room,'pause',jsonb_build_object('version',state->'version'));
  if state->>'paused' <> 'true' then raise exception 'Pause did not update state'; end if;

  perform set_config('request.jwt.claims', jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  state := public.tv_action(wanted_room,'start_tab');
  stream := (state->>'stream_id')::uuid;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',guest_id,'role','authenticated')::text,true);
  perform public.tv_action(wanted_room,'signal',jsonb_build_object('target',owner_id,'stream',stream,'attempt',attempt,'kind','ready','data','{}'::jsonb));
  if exists (select from public.tv_signals where stream_id = stream) then raise exception 'Sender can read a private inbox'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  if not exists (select from public.tv_signals where stream_id = stream and kind = 'ready') then raise exception 'Missing signal'; end if;
  state := public.tv_action(wanted_room,'transfer',jsonb_build_object('target',guest_id));
  if state->>'host' <> guest_id::text or state->>'mode' <> 'empty' then raise exception 'Host transfer kept the stream'; end if;

  perform set_config('request.jwt.claims', jsonb_build_object('sub',guest_id,'role','authenticated')::text,true);
  state := public.tv_action(wanted_room,'kick',jsonb_build_object('target',owner_id));
  if state->>'invite' = invitation::text then raise exception 'Invitation did not rotate'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  if exists (select from public.tv_rooms where id = wanted_room) then raise exception 'Kicked member can read room'; end if;
  begin
    perform public.tv_enter('Хост',(state->>'invite')::uuid);
    raise exception 'Expected kicked member rejection';
  exception when raise_exception then
    if sqlerrm <> 'Хост удалил тебя из этой комнаты.' then raise; end if;
  end;
end;
$$;
rollback;
