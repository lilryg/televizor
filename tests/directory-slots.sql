begin;
set local role authenticated;
do $$
declare
  host_id uuid := gen_random_uuid();
  guest_id uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  host_visit uuid := gen_random_uuid();
  guest_visit uuid := gen_random_uuid();
  spin_key uuid := gen_random_uuid();
  open_id uuid;
  closed_id uuid;
  code uuid;
  response jsonb;
  result jsonb;
  before_balance integer;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub',host_id,'role','authenticated')::text,true);
  open_id := (public.tv_join_room('Хост',visit => host_visit,room_name => 'Открытая тестовая')->>'id')::uuid;
  closed_id := (public.tv_join_room('Хост',visit => host_visit,room_name => 'Закрытая тестовая',password => 'пароль')->>'id')::uuid;
  select invite into strict code from public.tv_rooms where id = closed_id;

  perform set_config('request.jwt.claims', jsonb_build_object('sub',guest_id,'role','authenticated')::text,true);
  if not exists (select from public.tv_directory() where id = open_id and not is_locked and title = 'Открытая тестовая')
    or not exists (select from public.tv_directory() where id = closed_id and is_locked and participants = 1) then
    raise exception 'Room directory returned incorrect metadata';
  end if;
  if exists (select from public.tv_rooms where id = closed_id) then raise exception 'Directory revealed the private room row'; end if;
  response := public.tv_join_room('Гость',listed_room => open_id,visit => guest_visit);
  if (response->>'id')::uuid is distinct from open_id then raise exception 'Open room did not accept directory entry'; end if;
  response := public.tv_join_room('Гость',listed_room => closed_id,visit => guest_visit);
  if not response ? 'error' then raise exception 'Protected room accepted an empty password'; end if;
  response := public.tv_join_room('Гость',listed_room => closed_id,visit => guest_visit,password => 'неверный');
  if not response ? 'error' then raise exception 'Protected room accepted an incorrect password'; end if;
  response := public.tv_join_room('Гость',listed_room => closed_id,visit => guest_visit,password => 'пароль');
  if (response->>'id')::uuid is distinct from closed_id then raise exception 'Correct password failed'; end if;

  before_balance := (public.tv_slots(closed_id,guest_visit)->>'balance')::integer;
  if before_balance is distinct from 10000 then raise exception 'Incorrect starting balance'; end if;
  begin
    perform public.tv_slots(closed_id,guest_visit,2,gen_random_uuid());
    raise exception 'Invalid stake was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Выбери ставку 1, 10 или 100.' then raise; end if;
  end;
  result := public.tv_slots(closed_id,guest_visit,100,spin_key);
  if jsonb_array_length(result->'reels') is distinct from 3
    or exists (select from jsonb_array_elements_text(result->'reels') r(symbol) where symbol::integer not between 0 and 5)
    or (result->>'balance')::integer is distinct from before_balance - 100 + (result->>'payout')::integer then
    raise exception 'Invalid spin result';
  end if;
  if public.tv_slots(closed_id,guest_visit,100,spin_key) is distinct from result then
    raise exception 'Retried spin changed its outcome or balance';
  end if;
  perform public.tv_action(closed_id,'leave',jsonb_build_object('visit',guest_visit));
  response := public.tv_join_room('Гость',recent_room => closed_id,visit => guest_visit);
  if not response ? 'error' then raise exception 'Protected room could be opened from history without a password'; end if;
  response := public.tv_join_room('Гость',invitation => code,visit => guest_visit);
  if (response->>'id')::uuid is distinct from closed_id
    or (public.tv_slots(closed_id,guest_visit)->>'balance') is distinct from (result->>'balance') then
    raise exception 'Invitation was rejected or the wallet reset while rejoining';
  end if;

  perform set_config('request.jwt.claims', jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  begin
    perform public.tv_slots(closed_id,guest_visit,1,gen_random_uuid());
    raise exception 'A non-member could play slots';
  exception when raise_exception then
    if sqlerrm <> 'Доступ к комнате закрыт.' then raise; end if;
  end;
end;
$$;

reset role;
do $$
begin
  if (select sum(tv_internal.slot_multiplier(a,b,c)) from generate_series(0,5) a
    cross join generate_series(0,5) b cross join generate_series(0,5) c) <> 208 then
    raise exception 'Slot paytable did not return the documented 208/216';
  end if;
  if has_schema_privilege('authenticated','tv_internal','USAGE') then
    raise exception 'Private tables are visible to clients';
  end if;
end;
$$;
rollback;
