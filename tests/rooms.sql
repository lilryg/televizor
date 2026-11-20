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
  if state->>'invite' <> invitation::text then raise exception 'Kick changed the invitation'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  if exists (select from public.tv_rooms where id = wanted_room) then raise exception 'Kicked member can read room'; end if;
  if public.tv_enter('Хост',invitation) <> wanted_room then raise exception 'Kicked member could not rejoin'; end if;
end;
$$;

reset role;
do $$
declare
  actor uuid := gen_random_uuid();
  old_visit uuid := gen_random_uuid();
  new_visit uuid := gen_random_uuid();
  wanted_room uuid;
  abandoned uuid;
  expires_at timestamptz;
  i integer;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  wanted_room := public.tv_join('Хост',visit => old_visit);
  perform public.tv_join('Хост',recent_room => wanted_room,visit => new_visit);
  perform public.tv_action(wanted_room,'leave',jsonb_build_object('visit',old_visit));
  if (select participants from public.tv_recent() where id = wanted_room) is distinct from 1 then
    raise exception 'A delayed page close removed the new visit';
  end if;
  perform public.tv_action(wanted_room,'leave',jsonb_build_object('visit',new_visit));
  if not exists (select from public.tv_recent() where id = wanted_room and was_host and participants = 0) then
    raise exception 'Empty room missing from recent list';
  end if;
  select empty_since into expires_at from public.tv_rooms where id = wanted_room;
  if expires_at is null then raise exception 'Last exit did not start the timer'; end if;
  update public.tv_rooms set empty_since = now() - interval '9 minutes 59 seconds' where id = wanted_room;
  if not exists (select from public.tv_recent() where id = wanted_room) then raise exception 'Room expired early'; end if;
  update public.tv_rooms set empty_since = now() - interval '10 minutes' where id = wanted_room;
  if exists (select from public.tv_recent() where id = wanted_room) then raise exception 'Recent list contains expired room'; end if;
  begin
    perform public.tv_join('Хост',recent_room => wanted_room,visit => gen_random_uuid());
    raise exception 'An expired room was reopened';
  exception when raise_exception then
    if sqlerrm <> 'Комната недоступна или уже удалена.' then raise; end if;
  end;

  abandoned := public.tv_join('Хост',visit => gen_random_uuid());
  update public.tv_rooms set touched_at = now() - interval '11 minutes' where id = abandoned;
  update public.tv_members set seen_at = now() - interval '11 minutes' where room_id = abandoned;
  if not exists (select from public.tv_recent() where id = abandoned and participants = 0) then
    raise exception 'Presence expiration incorrectly removed an abandoned room before ten empty minutes';
  end if;
  update public.tv_rooms set touched_at = now() - interval '12 minutes' where id = abandoned;
  update public.tv_members set seen_at = now() - interval '12 minutes' where room_id = abandoned;
  if exists (select from public.tv_recent() where id = abandoned) then raise exception 'Abandoned room did not expire'; end if;

  for i in 1..4 loop
    perform public.tv_join('Хост');
  end loop;
  update public.tv_rooms set empty_since = now() where id in (wanted_room, abandoned);
  if (select count(*) from public.tv_recent()) <> 5 then raise exception 'Recent limit did not return five rooms'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
  if exists (select from public.tv_recent()) then raise exception 'History disclosed another user’s rooms'; end if;
  begin
    perform public.tv_join('Незнакомец',recent_room => wanted_room,visit => gen_random_uuid());
    raise exception 'A stranger joined by internal ID';
  exception when raise_exception then
    if sqlerrm <> 'Комната недоступна или уже удалена.' then raise; end if;
  end;
end;
$$;
rollback;
