begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.tv_rooms add column title text, add column is_locked boolean not null default false,
  add constraint tv_room_title_length check (char_length(title) between 1 and 48 and title !~ '[[:cntrl:]]');

create table tv_internal.room_passwords (
  room_id uuid primary key references public.tv_rooms on delete cascade,
  password_hash text not null
);
create table tv_internal.slot_wallets (
  room_id uuid,
  user_id uuid,
  balance bigint not null default 10000 check (balance >= 0),
  spin_at timestamptz,
  spin_id uuid,
  result jsonb,
  primary key (room_id, user_id),
  foreign key (room_id,user_id) references public.tv_members on delete cascade
);
alter table tv_internal.room_passwords enable row level security;
alter table tv_internal.slot_wallets enable row level security;
revoke all on tv_internal.room_passwords, tv_internal.slot_wallets from public, anon, authenticated;

create function public.tv_join_room(
  nick text, invitation uuid default null, recent_room uuid default null, visit uuid default null,
  listed_room uuid default null, room_name text default null, password text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  room uuid;
  candidate public.tv_rooms;
  saved_hash text;
  secret text := nullif(password, '');
begin
  if actor is null then raise exception 'Сессия отсутствует. Войди снова.'; end if;
  nick := btrim(nick);
  if nick is null or char_length(nick) not between 2 and 20 or nick ~ '[[:cntrl:]]' then
    raise exception 'Никнейм должен содержать от 2 до 20 символов.';
  end if;
  perform tv_internal.limit_calls(actor,'enter',60,12);
  if num_nonnulls(invitation, recent_room, listed_room) > 1 then
    raise exception 'Выбери один способ входа.';
  end if;
  if octet_length(secret) > 72 then
    raise exception 'Пароль слишком длинный. Используй не больше 72 байт.';
  end if;
  if invitation is null and recent_room is null and listed_room is null then
    perform tv_internal.limit_calls(actor,'create',3600,6);
    room := gen_random_uuid();
    room_name := coalesce(btrim(room_name), 'Кинозал ' || upper(left(room::text, 6)));
    if char_length(room_name) not between 1 and 48 or room_name ~ '[[:cntrl:]]' then
      raise exception 'Название комнаты должно содержать от 1 до 48 символов.';
    end if;
    insert into public.tv_rooms(id,host,title,is_locked) values(room,actor,room_name,secret is not null);
    if secret is not null then
      insert into tv_internal.room_passwords(room_id,password_hash)
        values(room,extensions.crypt(secret,extensions.gen_salt('bf',10)));
    end if;
  else
    select * into candidate from public.tv_rooms r
      where (r.invite = invitation or r.id = listed_room or (r.id = recent_room and exists (
        select from public.tv_members m where m.room_id = r.id and m.user_id = actor
      ))) and not tv_internal.room_expired(r.id, r.empty_since, r.touched_at)
    for update;
    if candidate.id is null then raise exception 'Комната недоступна или уже удалена.'; end if;
    if invitation is null and candidate.is_locked then
      if secret is null then
        return jsonb_build_object('error','Введи пароль комнаты.');
      end if;
      select p.password_hash into saved_hash from tv_internal.room_passwords p where p.room_id = candidate.id;
      if saved_hash is null or extensions.crypt(secret,saved_hash) is distinct from saved_hash then
        -- A JSON result commits the existing attempt counter even when the password is wrong.
        return jsonb_build_object('error','Неверный пароль комнаты.');
      end if;
    end if;
    room := candidate.id;
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
  return jsonb_build_object('id',room);
end;
$$;


create or replace function public.tv_join(nick text, invitation uuid default null, recent_room uuid default null, visit uuid default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare answer jsonb;
begin
  answer := public.tv_join_room(nick,invitation,recent_room,visit);
  if answer ? 'error' then raise exception '%', answer->>'error'; end if;
  return (answer->>'id')::uuid;
end;
$$;

create function public.tv_recent_rooms()
returns table(id uuid, last_visited_at timestamptz, was_host boolean, participants integer, title text, is_locked boolean)
language sql stable security definer set search_path = '' as $$
  select r.id, m.last_visited_at, m.was_host, (
    select count(*)::integer from public.tv_members other where other.room_id = r.id
      and other.status = 'active' and other.seen_at > now() - interval '95 seconds'
  ), coalesce(r.title,'Кинозал ' || upper(left(r.id::text,6))), r.is_locked
  from public.tv_members m join public.tv_rooms r on r.id = m.room_id
  where m.user_id = (select auth.uid())
    and not tv_internal.room_expired(r.id, r.empty_since, r.touched_at)
  order by m.last_visited_at desc, r.id limit 5
$$;


create function public.tv_directory()
returns table(id uuid, title text, is_locked boolean, participants integer)
language sql stable security definer set search_path = '' as $$
  select r.id,coalesce(r.title,'Кинозал ' || upper(left(r.id::text,6))),r.is_locked,active.n
  from public.tv_rooms r
  cross join lateral (
    select count(*)::integer as n from public.tv_members m
    where m.room_id = r.id and m.status = 'active' and m.seen_at > now() - interval '95 seconds'
  ) active
  where (select auth.uid()) is not null
    and not tv_internal.room_expired(r.id,r.empty_since,r.touched_at)
  order by (active.n > 0) desc, r.touched_at desc, r.id
$$;

create function tv_internal.slot_reel() returns integer
language plpgsql volatile set search_path = '' as $$
declare b integer;
begin
  loop
    b := get_byte(extensions.gen_random_bytes(1),0);
    -- 252 is divisible by six, so rejecting the last four bytes removes modulo bias.
    if b < 252 then return b % 6; end if;
  end loop;
end;
$$;

create function tv_internal.slot_multiplier(a integer,b integer,c integer) returns integer
language sql immutable strict set search_path = '' as $$
  select case when a = b and b = c then (array[8,10,12,16,24,48])[a+1]
    when a = b or a = c or b = c then 1 else 0 end
$$;

create function public.tv_slots(room uuid, visit uuid, stake integer default 0, request_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  wallet tv_internal.slot_wallets;
  reels integer[];
  payout integer;
  cash bigint;
  outcome jsonb;
begin
  if actor is null or visit is null then raise exception 'Доступ к комнате закрыт.'; end if;
  perform 1 from public.tv_rooms r where r.id = room for share;
  if not exists (
    select from public.tv_members m where m.room_id = room and m.user_id = actor and m.visit_id = visit
    and m.status = 'active' and m.seen_at > now() - interval '95 seconds'
  ) then raise exception 'Доступ к комнате закрыт.'; end if;

  if stake = 0 and request_id is null then
    select w.balance into cash from tv_internal.slot_wallets w where w.room_id = room and w.user_id = actor;
    return jsonb_build_object('balance',coalesce(cash,10000));
  end if;
  if stake is null or stake not in (1,10,100) or request_id is null then
    raise exception 'Выбери ставку 1, 10 или 100.';
  end if;
  insert into tv_internal.slot_wallets(room_id,user_id) values(room,actor) on conflict do nothing;
  select * into strict wallet from tv_internal.slot_wallets w where w.room_id = room and w.user_id = actor for update;
  if wallet.spin_id = request_id then return wallet.result; end if;
  if wallet.balance < stake then raise exception 'Недостаточно тугриков для этой ставки.'; end if;
  if wallet.spin_at > clock_timestamp() - interval '300 milliseconds' then
    raise exception 'Подожди немного перед следующим вращением.';
  end if;
  reels := array[tv_internal.slot_reel(),tv_internal.slot_reel(),tv_internal.slot_reel()];
  payout := stake * tv_internal.slot_multiplier(reels[1],reels[2],reels[3]);
  cash := wallet.balance - stake + payout;
  outcome := jsonb_build_object('balance',cash,'reels',reels,'payout',payout);
  update tv_internal.slot_wallets w set balance = cash, spin_at = clock_timestamp(),
    spin_id = request_id, result = outcome where w.room_id = room and w.user_id = actor;
  return outcome;
end;
$$;

revoke all on function tv_internal.slot_reel(), tv_internal.slot_multiplier(integer,integer,integer)
  from public, anon, authenticated;
revoke all on function public.tv_join_room(text,uuid,uuid,uuid,uuid,text,text), public.tv_recent_rooms(),
  public.tv_directory(), public.tv_slots(uuid,uuid,integer,uuid) from public, anon, authenticated;
grant execute on function public.tv_join_room(text,uuid,uuid,uuid,uuid,text,text), public.tv_recent_rooms(),
  public.tv_directory(), public.tv_slots(uuid,uuid,integer,uuid) to authenticated;

commit;
