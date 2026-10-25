-- S111 acceptance — booking personal-data retention.
-- Runs on a replayed database at S111. Seeds bookings in ONE transaction and rolls back.
begin;

-- A manager profile to receive the seeded inbox / push rows (created by the auth trigger).
insert into auth.users(id, email, raw_user_meta_data) values
  ('a8000000-0000-4000-8000-0000000000a1', 's111-manager@example.invalid', '{}');
update public.profiles set role = 'manager', active = true, display_name = 'S111 Manager'
  where id = 'a8000000-0000-4000-8000-0000000000a1';

do $t$
declare
  bar uuid := 'ba000000-0000-4000-8000-000000000001';
  old_web uuid := gen_random_uuid();      -- web request, visit 100 days ago
  old_phone uuid := gen_random_uuid();    -- staff booking, visit 91 days ago, staff notes
  recent uuid := gen_random_uuid();       -- visit 89 days ago: must be kept
  future uuid := gen_random_uuid();       -- upcoming booking: must be kept
  r jsonb; dry jsonb;
  n integer; n_runs_before integer; n_inbox_before integer; n_outbox_before integer;
begin
  -- 0. Sealed: no browser role can run the purge or read its log.
  if has_function_privilege('anon', 'atlas_private.booking_purge_personal_data(integer,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'atlas_private.booking_purge_personal_data(integer,boolean)', 'EXECUTE')
     or has_table_privilege('authenticated', 'atlas_private.booking_retention_runs', 'SELECT')
     or has_table_privilege('anon', 'atlas_private.booking_retention_runs', 'SELECT') then
    raise exception 's111: the retention purge or its log is reachable by a browser role';
  end if;

  -- Seed: four bookings with full guest details (public_token marks web rows).
  insert into atlas_private.reservations (id, area_id, source, status, start_at, end_at, party_size,
      guest_name, guest_phone, guest_email, guest_requests, staff_notes, booking_reference, idempotency_key, public_token, provider_ref)
  values
    (old_web, bar, 'web', 'cancelled', now() - interval '100 days' - interval '2 hours', now() - interval '100 days', 2,
      'Old Web Guest', '+354 555 0001', 'old.web@example.invalid', 'window please', null, 'KA-S111A', 'idem-s111-a', 's111tokenaaaaaaaaaaaaaaaaaaaaaaa', null),
    (old_phone, bar, 'phone', 'completed', now() - interval '91 days' - interval '2 hours', now() - interval '91 days', 3,
      'Old Phone Guest', '+354 555 0002', null, null, 'nut allergy', 'KA-S111B', null, null, 'ext-1'),
    (recent, bar, 'phone', 'completed', now() - interval '89 days' - interval '2 hours', now() - interval '89 days', 2,
      'Recent Guest', '+354 555 0003', 'recent@example.invalid', null, 'regular', 'KA-S111C', null, null, null),
    (future, bar, 'phone', 'confirmed', now() + interval '3 days', now() + interval '3 days' + interval '2 hours', 4,
      'Future Guest', '+354 555 0004', 'future@example.invalid', 'birthday', null, 'KA-S111D', null, null, null);

  -- Messages that repeat guest details. Linked to the old and the recent bookings;
  -- plus one orphan inbox row older than the window.
  select count(*) into n_inbox_before from atlas_private.booking_notifications;
  select count(*) into n_outbox_before from atlas_private.booking_email_outbox;
  insert into atlas_private.booking_notifications (audience_user_id, reservation_id, kind, title, body, route, created_at)
  select p.id, x.rid, 'request', 'New booking request', x.body, 'bookings', x.at
  from (select 'a8000000-0000-4000-8000-0000000000a1'::uuid as id) p,
       (values (old_web, 'Old Web Guest · party of 2', now() - interval '101 days'),
               (recent, 'Recent Guest · party of 2', now() - interval '90 days'),
               (null::uuid, 'Orphan old guest', now() - interval '120 days')) x(rid, body, at);
  insert into atlas_private.booking_email_outbox (reservation_id, kind, to_email, from_email, subject, body, status, created_at, dedupe_key)
  values (old_web, 'request_received', 'old.web@example.invalid', 'kanel@kanel.is', 'Request received', 'Thank you, Old Web Guest', 'queued', now() - interval '101 days', 's111-old-web'),
         (recent, 'request_received', 'recent@example.invalid', 'kanel@kanel.is', 'Request received', 'Thank you, Recent Guest', 'queued', now() - interval '90 days', 's111-recent');
  insert into atlas_private.push_notification_queue (audience_user_id, event_type, title, body, route, object_id, status, created_at)
  select p.id, 'booking_request', 'New booking request', 'Old Web Guest · party of 2', 'bookings', old_web, 'pending', now() - interval '101 days'
  from (select 'a8000000-0000-4000-8000-0000000000a1'::uuid as id) p;

  -- 1. Guard: a window shorter than 30 days is refused.
  begin
    perform atlas_private.booking_purge_personal_data(7, false);
    raise exception 's111: a 7-day retention window was accepted';
  exception when invalid_parameter_value then null; end;

  -- 2. Dry run reports and changes nothing.
  select count(*) into n_runs_before from atlas_private.booking_retention_runs;
  dry := atlas_private.booking_purge_personal_data(90, true);
  if (dry->>'reservations_anonymised')::int <> 2 then raise exception 's111: dry run should find 2 reservations, got %', dry; end if;
  if (select guest_name from atlas_private.reservations where id = old_web) is null then
    raise exception 's111: the dry run changed data';
  end if;

  -- 3. Purge.
  r := atlas_private.booking_purge_personal_data(90, false);
  if (r->>'reservations_anonymised')::int <> 2 then raise exception 's111: expected 2 anonymised, got %', r; end if;
  if (r->>'outbox_deleted')::int < 1 or (r->>'inbox_deleted')::int < 2 or (r->>'push_deleted')::int < 1 then
    raise exception 's111: linked messages were not all deleted: %', r;
  end if;

  -- Old bookings: every personal field cleared; business facts kept.
  select count(*) into n from atlas_private.reservations
   where id in (old_web, old_phone)
     and guest_name is null and guest_phone is null and guest_email is null and guest_requests is null
     and staff_notes is null and public_token is null and idempotency_key is null and provider_ref is null
     and booking_reference in ('KA-S111A', 'KA-S111B') and party_size in (2, 3) and status in ('cancelled', 'completed');
  if n <> 2 then raise exception 's111: old bookings were not anonymised correctly'; end if;

  -- Recent and future bookings untouched.
  select count(*) into n from atlas_private.reservations
   where (id = recent and guest_name = 'Recent Guest' and staff_notes = 'regular' and guest_email = 'recent@example.invalid')
      or (id = future and guest_name = 'Future Guest' and guest_requests = 'birthday');
  if n <> 2 then raise exception 's111: a booking inside the 90-day window was changed'; end if;

  -- Messages: old and orphan-old gone; the recent booking's (90 days old, created
  -- after the cutoff) kept.
  if exists (select 1 from atlas_private.booking_notifications where reservation_id = old_web or body = 'Orphan old guest')
     or exists (select 1 from atlas_private.booking_email_outbox where reservation_id = old_web)
     or exists (select 1 from atlas_private.push_notification_queue where object_id = old_web) then
    raise exception 's111: an old message with guest details survived';
  end if;
  if not exists (select 1 from atlas_private.booking_notifications where reservation_id = recent)
     or not exists (select 1 from atlas_private.booking_email_outbox where reservation_id = recent) then
    raise exception 's111: a recent booking''s messages were deleted';
  end if;

  -- Anonymising fired no new notifications or emails.
  if (select count(*) from atlas_private.booking_notifications) <> n_inbox_before + 1
     or (select count(*) from atlas_private.booking_email_outbox) <> n_outbox_before + 1 then
    raise exception 's111: anonymising created notifications or emails';
  end if;

  -- 4. Idempotent: a second run finds nothing.
  r := atlas_private.booking_purge_personal_data(90, false);
  if (r->>'reservations_anonymised')::int <> 0 or (r->>'outbox_deleted')::int <> 0 then
    raise exception 's111: a repeat run changed data again: %', r;
  end if;

  -- 5. Every run (dry, real, repeat) is logged with counts only.
  if (select count(*) from atlas_private.booking_retention_runs) <> n_runs_before + 3 then
    raise exception 's111: retention runs were not logged';
  end if;
  if exists (select 1 from atlas_private.booking_retention_runs where counts::text ~* 'guest|@|\+354') then
    raise exception 's111: the run log contains guest details';
  end if;

  raise notice 's111 booking personal-data retention: all checks passed';
end $t$;

rollback;
