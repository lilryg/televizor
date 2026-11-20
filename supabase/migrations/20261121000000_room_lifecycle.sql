begin;

alter table public.tv_rooms add column empty_since timestamptz;
alter table public.tv_members add column visit_id uuid,
  add column last_visited_at timestamptz not null default clock_timestamp(),
  add column was_host boolean not null default false;
update public.tv_members m set last_visited_at = m.seen_at, was_host = (m.user_id = r.host)
  from public.tv_rooms r where r.id = m.room_id;
create index tv_members_recent on public.tv_members(user_id, last_visited_at desc);

create function tv_internal.room_expired(room uuid, empty_at timestamptz, touched timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select case
    when empty_at is not null then empty_at <= now() - interval '10 minutes'
    when touched > now() - interval '10 minutes' then false
    else greatest(touched, (
      select max(m.seen_at) + interval '95 seconds' from public.tv_members m
      where m.room_id = room and m.status = 'active'
    )) <= now() - interval '10 minutes'
  end
$$;

create function tv_internal.record_host() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.tv_members set was_host = true
    where room_id = new.id and user_id = new.host and not was_host;
  return new;
end;
$$;
create trigger tv_record_host after update of host on public.tv_rooms
  for each row when (old.host is distinct from new.host) execute function tv_internal.record_host();

revoke all on function tv_internal.room_expired(uuid,timestamptz,timestamptz), tv_internal.record_host() from public, anon, authenticated;

create function public.tv_join(nick text, invitation uuid default null, recent_room uuid default null, visit uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); room uuid;
begin
  if actor is null then raise exception 'Сессия отсутствует. Войди снова.'; end if;
  nick := btrim(nick);
  if nick is null or char_length(nick) not between 2 and 20 or nick ~ '[[:cntrl:]]' then
    raise exception 'Никнейм должен содержать от 2 до 20 символов.';
  end if;
  perform tv_internal.limit_calls(actor,'enter',60,12);
  if invitation is null and recent_room is null then
    perform tv_internal.limit_calls(actor,'create',3600,6);
    insert into public.tv_rooms(host) values(actor) returning id into room;
  else
    select r.id into room from public.tv_rooms r
    where (case when invitation is not null then r.invite = invitation
      else r.id = recent_room and exists (
        select from public.tv_members m where m.room_id = r.id and m.user_id = actor
      ) end)
      and not tv_internal.room_expired(r.id, r.empty_since, r.touched_at)
    for update;
    if room is null then raise exception 'Комната недоступна или уже удалена.'; end if;
  end if;
  if not public.tv_is_member(room) and 10 <= (
    select count(*) from public.tv_members where room_id = room and status = 'active'
      and seen_at > now() - interval '95 seconds'
  ) then raise exception 'В комнате уже 10 участников.'; end if;
  update public.tv_rooms r set mode = 'empty', stream_id = null where r.id = room and r.host = actor
    and r.mode = 'tab' and not public.tv_is_member(room);
  insert into public.tv_members(room_id,user_id,nickname,visit_id,was_host)
  values(room,actor,nick,visit,exists(select from public.tv_rooms r where r.id = room and r.host = actor))
  on conflict (room_id,user_id) do update set nickname = excluded.nickname, status = 'active',
    seen_at = clock_timestamp(), last_visited_at = clock_timestamp(), visit_id = excluded.visit_id,
    was_host = public.tv_members.was_host or excluded.was_host;
  if not exists (
    select from public.tv_rooms r join public.tv_members m on m.room_id = r.id and m.user_id = r.host
      where r.id = room and m.status = 'active' and m.seen_at > now() - interval '95 seconds'
  ) then perform tv_internal.elect(room); end if;
  update public.tv_rooms set touched_at = clock_timestamp(), empty_since = null where id = room;
  return room;
end;
$$;

create or replace function public.tv_action(room uuid, action text, args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  r public.tv_rooms;
  m public.tv_members;
  target uuid;
  next_position double precision;
  next_source text;
  signal_kind text;
begin
  if actor is null then raise exception 'Сессия отсутствует. Войди снова.'; end if;
  select * into r from public.tv_rooms where id = room
    and not tv_internal.room_expired(id, empty_since, touched_at) for update;
  select * into m from public.tv_members where room_id = room and user_id = actor;
  if action = 'leave' and (r.id is null or m.status is distinct from 'active'
    or (args ? 'visit' and m.visit_id is distinct from (args->>'visit')::uuid)) then
    return '{}'::jsonb;
  end if;
  if r.id is null or m.status is distinct from 'active' then raise exception 'Доступ к комнате закрыт.'; end if;
  if args ? 'visit' and m.visit_id is distinct from (args->>'visit')::uuid then
    raise exception 'Комната уже открыта в другой вкладке.';
  end if;
  if action = 'signal' then
    perform tv_internal.limit_calls(actor,'signal',10,260);
  else
    perform tv_internal.limit_calls(actor,'control',10,35);
  end if;

  if action = 'heartbeat' then
    if m.seen_at <= now() - interval '95 seconds' and 10 <= (
      select count(*) from public.tv_members where room_id = room and status = 'active'
        and seen_at > now() - interval '95 seconds'
    ) then raise exception 'В комнате уже 10 участников.'; end if;
    if m.seen_at < now() - interval '15 seconds' then
      -- End an orphaned capture even when its former host is the first to return.
      if r.host = actor and m.seen_at <= now() - interval '95 seconds' and r.mode = 'tab' then
        update public.tv_rooms set mode = 'empty', stream_id = null where id = room;
      end if;
      update public.tv_members set seen_at = clock_timestamp() where room_id = room and user_id = actor;
      update public.tv_rooms set touched_at = clock_timestamp(), empty_since = null where id = room;
    end if;
    if not exists (select from public.tv_members where room_id = room and user_id = r.host
        and status = 'active' and seen_at > now() - interval '95 seconds') then
      perform tv_internal.elect(room);
    end if;
    return jsonb_build_object('now',clock_timestamp());
  end if;

  if action <> 'leave' and m.seen_at <= now() - interval '95 seconds' then raise exception 'Связь потеряна. Переподключись к комнате.'; end if;
  if action in ('transfer','kick','video','start_tab','stop_tab') and actor <> r.host then
    raise exception 'Это действие доступно только хосту.';
  end if;
  if action in ('transfer','kick','signal') then
    target := (args->>'target')::uuid;
    if target is null or target = actor or not exists (
      select from public.tv_members where room_id = room and user_id = target and status = 'active'
        and (action = 'kick' or seen_at > now() - interval '95 seconds')
    ) then raise exception 'Участник недоступен.'; end if;
  end if;

  case action
    when 'leave' then
      update public.tv_members set status = 'left' where room_id = room and user_id = actor;
      if r.host = actor then perform tv_internal.elect(room); end if;
      if not exists (
        select from public.tv_members where room_id = room and status = 'active'
          and seen_at > now() - interval '95 seconds'
      ) then
        update public.tv_rooms set empty_since = coalesce(r.empty_since, case
          when m.seen_at > now() - interval '95 seconds' then clock_timestamp()
          else greatest(r.touched_at, m.seen_at + interval '95 seconds')
        end) where id = room;
      end if;
    when 'transfer' then
      update public.tv_rooms set host = target, mode = case when mode = 'tab' then 'empty' else mode end,
        stream_id = null where id = room;
    when 'kick' then
      update public.tv_members set status = 'kicked' where room_id = room and user_id = target;
    when 'nick' then
      next_source := btrim(args->>'nickname');
      if next_source is null or char_length(next_source) not between 2 and 20 or next_source ~ '[[:cntrl:]]' then
        raise exception 'Никнейм должен содержать от 2 до 20 символов.';
      end if;
      update public.tv_members set nickname = next_source where room_id = room and user_id = actor;
    when 'video' then
      next_source := args->>'url';
      if next_source is null or length(next_source) > 4096 or next_source !~ '^https://[^/@?#[:space:]]+([/?#][^[:space:]]*)?$' then
        raise exception 'Вставь прямую HTTPS-ссылку на видео.';
      end if;
      update public.tv_rooms set mode = 'video', source = next_source, stream_id = null,
        paused = true, position = 0, version = version + 1, changed_at = clock_timestamp() where id = room;
    when 'start_tab' then
      update public.tv_rooms set mode = 'tab', source = null, stream_id = gen_random_uuid(),
        paused = true, position = 0, version = version + 1, changed_at = clock_timestamp() where id = room;
    when 'stop_tab' then
      update public.tv_rooms set mode = 'empty', stream_id = null, version = version + 1
        where id = room and stream_id = (args->>'stream')::uuid;
    when 'play', 'pause', 'seek' then
      if r.mode <> 'video' or r.version is distinct from (args->>'version')::integer then
        raise exception 'Видео уже изменилось. Повтори действие.';
      end if;
      next_position := case when action = 'seek' then (args->>'position')::double precision
        when action = 'play' and r.paused and args->'restart' = 'true'::jsonb then 0
        else r.position + case when r.paused then 0 else extract(epoch from clock_timestamp()-r.changed_at) end end;
      if next_position is null or not (next_position between 0 and 604800) then
        raise exception 'Недопустимая позиция видео.';
      end if;
      update public.tv_rooms set position = next_position,
        paused = case action when 'pause' then true when 'play' then false else paused end,
        version = version + 1, changed_at = clock_timestamp() where id = room;
    when 'signal' then
      signal_kind := args->>'kind';
      if r.mode <> 'tab' or r.stream_id is distinct from (args->>'stream')::uuid
        or signal_kind is null or signal_kind not in ('ready','offer','answer','ice')
        or (actor <> r.host and target <> r.host)
        or (signal_kind = 'offer' and actor <> r.host)
        or (signal_kind in ('ready','answer') and target <> r.host)
        or coalesce(jsonb_typeof(args->'data'),'') <> 'object'
        or octet_length((args->'data')::text) > 24576 then
        raise exception 'Недопустимый сигнал WebRTC.';
      end if;
      insert into public.tv_signals(room_id,stream_id,sender,recipient,attempt,kind,data)
      values(room,r.stream_id,actor,target,(args->>'attempt')::uuid,signal_kind,args->'data');
      return '{}'::jsonb;
    else raise exception 'Неизвестная команда.';
  end case;
  update public.tv_rooms set touched_at = clock_timestamp() where id = room returning * into r;
  return to_jsonb(r);
end;
$$;

create or replace function public.tv_enter(nick text, invitation uuid default null)
returns uuid language sql security invoker set search_path = '' as $$
  select public.tv_join(nick, invitation)
$$;

create function public.tv_recent()
returns table(id uuid, last_visited_at timestamptz, was_host boolean, participants integer)
language sql stable security definer set search_path = '' as $$
  select r.id, m.last_visited_at, m.was_host, (
    select count(*)::integer from public.tv_members other where other.room_id = r.id
      and other.status = 'active' and other.seen_at > now() - interval '95 seconds'
  )
  from public.tv_members m join public.tv_rooms r on r.id = m.room_id
  where m.user_id = (select auth.uid())
    and not tv_internal.room_expired(r.id, r.empty_since, r.touched_at)
  order by m.last_visited_at desc, r.id limit 5
$$;

revoke all on function public.tv_join(text,uuid,uuid,uuid), public.tv_recent() from public, anon, authenticated;
grant execute on function public.tv_join(text,uuid,uuid,uuid), public.tv_recent() to authenticated;

create function tv_internal.purge_empty_rooms() returns void
language sql set search_path = '' as $$
  delete from public.tv_rooms where id in (
    select r.id from public.tv_rooms r where r.touched_at <= now() - interval '10 minutes'
      and tv_internal.room_expired(r.id, r.empty_since, r.touched_at)
    for update skip locked
  )
$$;
revoke all on function tv_internal.purge_empty_rooms() from public, anon, authenticated;

select cron.schedule('tv-cleanup','30 seconds', $job$
  delete from public.tv_signals where created_at < now() - interval '2 minutes';
  delete from tv_internal.rate where started < now() - interval '2 hours';
  select tv_internal.purge_empty_rooms();
$job$);

commit;
