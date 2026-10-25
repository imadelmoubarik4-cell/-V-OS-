-- S110b acceptance — the booking inbox carries each row's visit start and venue date.
-- Runs on a replayed database at S110b+. Seeds in ONE transaction and rolls back.
begin;

insert into auth.users(id, email, raw_user_meta_data) values
  ('a8000000-0000-4000-8000-0000000000b1', 's110b-manager@example.invalid', '{}');
update public.profiles set role = 'manager', active = true, display_name = 'S110b Manager'
  where id = 'a8000000-0000-4000-8000-0000000000b1';

do $t$
declare
  mgr uuid := 'a8000000-0000-4000-8000-0000000000b1';
  bar uuid := 'ba000000-0000-4000-8000-000000000001';
  web uuid := gen_random_uuid();
  -- 23:30 UTC on a winter day is the same date in Reykjavik (UTC+0 all year).
  visit timestamptz := date_trunc('day', now()) + interval '3 days 23 hours 30 minutes';
  listing jsonb; item jsonb;
begin
  insert into atlas_private.reservations (id, area_id, source, status, start_at, end_at, party_size, guest_name, booking_reference)
  values (web, bar, 'web', 'requested', visit, visit + interval '2 hours', 2, 'S110b Guest', 'KA-S110B');
  insert into atlas_private.booking_notifications (audience_user_id, reservation_id, kind, title, body, route)
  values (mgr, web, 'request', 'New booking request', 'S110b Guest · party of 2', 'bookings'),
         (mgr, null, 'request', 'Unlinked row', 'no reservation', 'bookings');

  listing := public.atlas_bookings_notifications(mgr, 'manager', 30);
  select x into item from jsonb_array_elements(listing->'items') x where x->>'reservation_id' = web::text;
  if item is null then raise exception 's110b: the linked row is missing: %', listing; end if;
  if (item->>'start_at')::timestamptz <> visit then
    raise exception 's110b: start_at % is not the visit start %', item->>'start_at', visit;
  end if;
  if item->>'visit_date' <> to_char(visit at time zone 'Atlantic/Reykjavik', 'YYYY-MM-DD') then
    raise exception 's110b: visit_date % is not the venue-local visit date', item->>'visit_date';
  end if;
  -- Existing keys are unchanged.
  if not (item ? 'id' and item ? 'kind' and item ? 'title' and item ? 'body' and item ? 'route' and item ? 'read' and item ? 'created_at') then
    raise exception 's110b: an S109 key went missing: %', item;
  end if;
  -- A row with no reservation still lists, with null visit keys.
  select x into item from jsonb_array_elements(listing->'items') x where x->>'title' = 'Unlinked row';
  if item is null or item->'start_at' <> 'null'::jsonb or item->'visit_date' <> 'null'::jsonb then
    raise exception 's110b: the unlinked row is wrong: %', item;
  end if;

  -- Still manager/admin only, and sealed from browser roles.
  begin
    perform public.atlas_bookings_notifications(mgr, 'bartender', 30);
    raise exception 's110b: a bartender read the inbox';
  exception when others then
    if sqlerrm like 's110b:%' then raise; end if;
  end;
  if has_function_privilege('anon', 'public.atlas_bookings_notifications(uuid,text,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.atlas_bookings_notifications(uuid,text,integer)', 'EXECUTE') then
    raise exception 's110b: the inbox RPC is reachable by a browser role';
  end if;

  raise notice 's110b booking inbox visit time: all checks passed';
end $t$;

rollback;
