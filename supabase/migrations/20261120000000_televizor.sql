begin;

create schema if not exists tv_internal;
revoke all on schema tv_internal from public, anon, authenticated;

create table public.tv_rooms (
  id uuid primary key default gen_random_uuid(),
  invite uuid not null unique default gen_random_uuid(),
  host uuid not null,
  mode text not null default 'empty' check (mode in ('empty','video','tab')),
  source text,
  stream_id uuid,
  paused boolean not null default true,
  position double precision not null default 0,
  version integer not null default 0,
  changed_at timestamptz not null default clock_timestamp(),
  touched_at timestamptz not null default clock_timestamp()
);

create table public.tv_members (
  room_id uuid references public.tv_rooms on delete cascade,
  user_id uuid,
  nickname text not null check (char_length(nickname) between 2 and 20),
  status text not null default 'active' check (status in ('active','left','kicked')),
  seen_at timestamptz not null default clock_timestamp(),
  joined_at timestamptz not null default clock_timestamp(),
  primary key (room_id,user_id)
);

create table public.tv_signals (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.tv_rooms on delete cascade,
  stream_id uuid not null,
  sender uuid not null,
  recipient uuid not null,
  attempt uuid not null,
  kind text not null check (kind in ('ready','offer','answer','ice')),
  data jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index tv_signals_inbox on public.tv_signals(room_id,stream_id,recipient,id);
create index tv_signals_expiry on public.tv_signals(created_at);
create index tv_rooms_expiry on public.tv_rooms(touched_at);

create table tv_internal.rate (
  user_id uuid,
  bucket text,
  started timestamptz not null,
  hits integer not null,
  primary key (user_id,bucket)
);

create function tv_internal.limit_calls(actor uuid, bucket_name text, seconds integer, maximum integer)
returns void language plpgsql set search_path = '' as $$
declare counter integer;
begin
  insert into tv_internal.rate as r values (actor,bucket_name,clock_timestamp(),1)
  on conflict (user_id,bucket) do update set
    hits = case when r.started < clock_timestamp() - make_interval(secs => seconds) then 1 else r.hits + 1 end,
    started = case when r.started < clock_timestamp() - make_interval(secs => seconds) then clock_timestamp() else r.started end
  returning hits into counter;
  if counter > maximum then raise exception 'Слишком много действий. Подожди немного.'; end if;
end;
$$;

create function public.tv_is_member(room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select from public.tv_members m where m.room_id = room and m.user_id = auth.uid()
      and m.status = 'active' and m.seen_at > now() - interval '95 seconds'
  )
$$;

alter table public.tv_rooms enable row level security;
alter table public.tv_members enable row level security;
alter table public.tv_signals enable row level security;
revoke all on public.tv_rooms, public.tv_members, public.tv_signals from public, anon, authenticated;
grant select on public.tv_rooms, public.tv_members, public.tv_signals to authenticated;
revoke all on function public.tv_is_member(uuid) from public, anon;
grant execute on function public.tv_is_member(uuid) to authenticated;

create policy tv_read_room on public.tv_rooms for select to authenticated
  using (public.tv_is_member(id));
create policy tv_read_members on public.tv_members for select to authenticated
  using (user_id = (select auth.uid()) or (status = 'active' and public.tv_is_member(room_id)));
create policy tv_read_signals on public.tv_signals for select to authenticated
  using (recipient = (select auth.uid()) and public.tv_is_member(room_id)
    and exists (select from public.tv_rooms r where r.id = room_id and r.stream_id = tv_signals.stream_id));

-- All callers hold the room lock before changing its host.
create function tv_internal.elect(room uuid) returns void
language plpgsql set search_path = '' as $$
declare successor uuid;
begin
  select m.user_id into successor from public.tv_members m
    where m.room_id = room and m.status = 'active' and m.seen_at > now() - interval '95 seconds'
    order by m.joined_at, m.user_id limit 1;
  if successor is null then
    update public.tv_rooms set mode = 'empty', stream_id = null, source = null,
      paused = true, position = 0, version = version + 1, changed_at = clock_timestamp()
      where id = room and mode <> 'empty';
  else
    update public.tv_rooms set host = successor,
      mode = case when mode = 'tab' then 'empty' else mode end,
      stream_id = null where id = room and host <> successor;
  end if;
end;
$$;

create function public.tv_enter(nick text, invitation uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); room uuid; is_blocked boolean;
begin
  if actor is null then raise exception 'Сессия отсутствует. Войди снова.'; end if;
  nick := btrim(nick);
  if nick is null or char_length(nick) not between 2 and 20 or nick ~ '[[:cntrl:]]' then
    raise exception 'Никнейм должен содержать от 2 до 20 символов.';
  end if;
  perform tv_internal.limit_calls(actor,'enter',60,12);
  if invitation is null then
    perform tv_internal.limit_calls(actor,'create',3600,6);
    insert into public.tv_rooms(host) values(actor) returning id into room;
  else
    select id into room from public.tv_rooms where invite = invitation
      and touched_at > now() - interval '24 hours' for update;
    if room is null then raise exception 'Приглашение недействительно или устарело.'; end if;
  end if;
  select status = 'kicked' into is_blocked from public.tv_members where room_id = room and user_id = actor;
  if is_blocked then raise exception 'Хост удалил тебя из этой комнаты.'; end if;
  if not public.tv_is_member(room) and 10 <= (
    select count(*) from public.tv_members where room_id = room and status = 'active'
      and seen_at > now() - interval '95 seconds'
  ) then raise exception 'В комнате уже 10 участников.'; end if;
  update public.tv_rooms r set mode = 'empty', stream_id = null where r.id = room and r.host = actor
    and r.mode = 'tab' and not public.tv_is_member(room);
  insert into public.tv_members(room_id,user_id,nickname) values(room,actor,nick)
  on conflict (room_id,user_id) do update set nickname = excluded.nickname, status = 'active', seen_at = clock_timestamp();
  if not exists (
    select from public.tv_rooms r join public.tv_members m on m.room_id = r.id and m.user_id = r.host
      where r.id = room and m.status = 'active' and m.seen_at > now() - interval '95 seconds'
  ) then perform tv_internal.elect(room); end if;
  update public.tv_rooms set touched_at = clock_timestamp() where id = room;
  return room;
end;
$$;

create function public.tv_action(room uuid, action text, args jsonb default '{}')
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
  select * into r from public.tv_rooms where id = room and touched_at > now() - interval '24 hours' for update;
  select * into m from public.tv_members where room_id = room and user_id = actor;
  if r.id is null or m.status is distinct from 'active' then raise exception 'Доступ к комнате закрыт.'; end if;
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
      update public.tv_rooms set touched_at = clock_timestamp() where id = room;
    end if;
    if not exists (select from public.tv_members where room_id = room and user_id = r.host
        and status = 'active' and seen_at > now() - interval '95 seconds') then
      perform tv_internal.elect(room);
    end if;
    return jsonb_build_object('now',clock_timestamp());
  end if;

  if m.seen_at <= now() - interval '95 seconds' then raise exception 'Связь потеряна. Переподключись к комнате.'; end if;
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
    when 'transfer' then
      update public.tv_rooms set host = target, mode = case when mode = 'tab' then 'empty' else mode end,
        stream_id = null where id = room;
    when 'kick' then
      update public.tv_members set status = 'kicked' where room_id = room and user_id = target;
      update public.tv_rooms set invite = gen_random_uuid() where id = room;
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

revoke all on function public.tv_enter(text,uuid), public.tv_action(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.tv_enter(text,uuid), public.tv_action(uuid,text,jsonb) to authenticated;

alter publication supabase_realtime add table public.tv_rooms, public.tv_members, public.tv_signals;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('tv-cleanup','* * * * *', $job$
  delete from public.tv_signals where created_at < now() - interval '2 minutes';
  delete from tv_internal.rate where started < now() - interval '2 hours';
  delete from public.tv_rooms where id in (
    select id from public.tv_rooms where touched_at < now() - interval '24 hours' for update skip locked
  );
$job$);

commit;
