-- S113 Guest booking emails — database acceptance on a replayed DB (KANEL × ALCEDO
-- online bookings). Proves at the database boundary:
--   1. the new functions are sealed from browser roles; the worker RPCs are service_role-only;
--   2. the owner switch guest_email_enabled defaults OFF; while off, guest emails stay
--      queued, are never claimed, and the website is not promised an email;
--   3. the site language is stored (en / is; anything else = none);
--   4. a test email to the sender address is claimable while the switch is off;
--   5. switching on stamps guest_email_since; emails queued before it are discarded;
--   6. after that: confirmation_email is true only with a deliverable address; claimed
--      emails are rendered in the guest's language with date, time, guests and stools;
--   7. complete(): sent once (a second report changes nothing); retry backs off and
--      gives up after 5 attempts; failed is final;
--   8. never sent: older than 24 hours, an undeliverable address, an interrupted send
--      (marked failed, not repeated); a declined request gets the 'declined' text;
--   9. without pg_net / Vault the tick and the secret lookup return null quietly.
-- Fixtures are created in one transaction and rolled back. Loopback only.
begin;

-- 1. Sealed --------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'atlas_private.booking_email_render(uuid)',
    'atlas_private.booking_email_address_ok(text)',
    'atlas_private.booking_email_queue_test()',
    'atlas_private.booking_email_tick()',
    'atlas_private.booking_settings_guest_email_since()',
    'public.atlas_booking_email_claim(integer)',
    'public.atlas_booking_email_complete(uuid,text,text)',
    'public.atlas_booking_email_worker_secret()',
    'public.atlas_public_booking_request(jsonb)'] loop
    if has_function_privilege('anon', fn, 'EXECUTE') or has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 's113: % is executable by a browser role', fn;
    end if;
  end loop;
  foreach fn in array array[
    'public.atlas_booking_email_claim(integer)',
    'public.atlas_booking_email_complete(uuid,text,text)',
    'public.atlas_booking_email_worker_secret()'] loop
    if not has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception 's113: service_role must execute %', fn;
    end if;
  end loop;
end $$;

-- Test setup: online booking on, every day open 17:00-23:00 (synthetic test hours).
update atlas_private.booking_settings set public_online_enabled = true where id = true;
insert into atlas_private.settings_business_hours(weekday, day_label, is_open, open_time, close_time, close_next_day)
select g, 'Day '||g, true, time '17:00', time '23:00', false from generate_series(0,6) g
on conflict (weekday) do update set is_open=true, open_time=time '17:00', close_time=time '23:00', close_next_day=false;

do $t$
declare
  tz text := 'Atlantic/Reykjavik';
  d date := ((now() at time zone 'Atlantic/Reykjavik')::date + 3);
  s18 timestamptz;
  s20 timestamptz;
  s21 timestamptz;
  r jsonb;
  c jsonb;
  e jsonb;
  n integer;
  old_id uuid;
  test_id uuid;
  is_id uuid;
  en_id uuid;
  rid uuid;
  body text;
  day_is text;
begin
  s18 := (d::text || ' 18:00')::timestamp at time zone tz;
  s20 := (d::text || ' 20:00')::timestamp at time zone tz;
  s21 := (d::text || ' 21:00')::timestamp at time zone tz;

  -- 2. Switch off by default; guest emails queue but are never claimed or promised.
  if (select guest_email_enabled or guest_email_since is not null from atlas_private.booking_settings where id = true) then
    raise exception 's113: guest_email_enabled must default to false with no since stamp';
  end if;
  r := public.atlas_public_booking_request(jsonb_build_object('party_size',2,'start_at',s18,
    'guest_name','Before Switch','guest_email','before@example.com','language','is',
    'seats',jsonb_build_array(1,2),'fingerprint','fp-113','idempotency_key','s113-before'));
  if (r->>'confirmation_email')::boolean then raise exception 's113: no email may be promised while the switch is off'; end if;
  select o.id into old_id from atlas_private.booking_email_outbox o join atlas_private.reservations rr on rr.id = o.reservation_id
   where rr.public_token = r->>'public_token' and o.kind = 'request_received' and o.status = 'queued';
  if old_id is null then raise exception 's113: the request must queue a request_received email'; end if;

  -- 3. Site language stored; anything else is none.
  if (select guest_language from atlas_private.reservations where public_token = r->>'public_token') <> 'is' then
    raise exception 's113: guest_language must be stored';
  end if;
  r := public.atlas_public_booking_request(jsonb_build_object('party_size',1,'start_at',s18,
    'guest_name','Odd Language','language','de','fingerprint','fp-113','idempotency_key','s113-de'));
  if (select guest_language from atlas_private.reservations where public_token = r->>'public_token') is not null then
    raise exception 's113: an unknown language must be stored as none';
  end if;

  -- 4. A test email is claimable while the switch is off; guest emails are not.
  test_id := atlas_private.booking_email_queue_test();
  c := public.atlas_booking_email_claim(10);
  if (c->>'enabled')::boolean then raise exception 's113: claim must report the switch off'; end if;
  if jsonb_array_length(c->'emails') <> 1 or c->'emails'->0->>'id' <> test_id::text then
    raise exception 's113: only the test email may be claimed while the switch is off, got %', c->'emails';
  end if;
  e := c->'emails'->0;
  if e->>'to' <> 'kanel@kanel.is' or e->>'from' <> 'kanel@kanel.is' or e->>'subject' <> 'KANEL booking email test'
     or position('are working' in e->>'body') = 0 then
    raise exception 's113: the test email goes to the sender only, got %', e;
  end if;
  if (select status from atlas_private.booking_email_outbox where id = old_id) <> 'queued' then
    raise exception 's113: a guest email must stay queued while the switch is off';
  end if;
  if (public.atlas_booking_email_complete(test_id, 'sent')->>'status') is distinct from 'sent' then raise exception 's113: test email not marked sent'; end if;

  -- 5. Switching on stamps since; the earlier guest email is discarded at the next claim.
  update atlas_private.booking_settings set guest_email_enabled = true where id = true;
  if (select guest_email_since is null from atlas_private.booking_settings where id = true) then
    raise exception 's113: switching on must stamp guest_email_since';
  end if;
  -- (same transaction: now() is constant, so age the earlier row by a second)
  update atlas_private.booking_email_outbox set created_at = created_at - interval '1 second' where id = old_id;
  c := public.atlas_booking_email_claim(10);
  if jsonb_array_length(c->'emails') <> 0 then raise exception 's113: nothing new should be due, got %', c->'emails'; end if;
  if (select status || ':' || error from atlas_private.booking_email_outbox where id = old_id)
       <> 'suppressed:Queued before guest emails were switched on; not sent.' then
    raise exception 's113: an email queued before the switch must be discarded, got %',
      (select status || ':' || coalesce(error,'') from atlas_private.booking_email_outbox where id = old_id);
  end if;
  update atlas_private.booking_settings set guest_email_since = now() - interval '1 minute' where id = true;

  -- 6. Promised only with a deliverable address; rendered in the guest's language.
  r := public.atlas_public_booking_request(jsonb_build_object('party_size',2,'start_at',s20,
    'guest_name','Jón','guest_email','jon@example.is','language','is',
    'seats',jsonb_build_array(7,8),'fingerprint','fp-113','idempotency_key','s113-is'));
  if not (r->>'confirmation_email')::boolean then raise exception 's113: an email must be promised once the switch is on'; end if;
  select o.id into is_id from atlas_private.booking_email_outbox o join atlas_private.reservations rr on rr.id = o.reservation_id
   where rr.public_token = r->>'public_token' and o.kind = 'request_received';
  if (public.atlas_public_booking_request(jsonb_build_object('party_size',1,'start_at',s21,'guest_name','No Mail',
        'fingerprint','fp-113','idempotency_key','s113-nomail'))->>'confirmation_email')::boolean
     or (public.atlas_public_booking_request(jsonb_build_object('party_size',1,'start_at',s21,'guest_name','Bad Mail',
        'guest_email','not an address','fingerprint','fp-113','idempotency_key','s113-badmail'))->>'confirmation_email')::boolean then
    raise exception 's113: no email may be promised without a deliverable address';
  end if;
  -- Idempotent replay answers the same.
  if not (public.atlas_public_booking_request(jsonb_build_object('party_size',2,'start_at',s20,
        'guest_name','Jón','guest_email','jon@example.is','language','is','seats',jsonb_build_array(7,8),
        'fingerprint','fp-113','idempotency_key','s113-is'))->>'confirmation_email')::boolean then
    raise exception 's113: an idempotent replay must give the same confirmation_email';
  end if;

  update atlas_private.booking_settings set public_instant_confirm = true where id = true;
  r := public.atlas_public_booking_request(jsonb_build_object('booking_mode','direct','party_size',3,'start_at',s20,
    'guest_name','Ada','guest_email','ada@example.com','language','en',
    'seats',jsonb_build_array(13,14,15),'fingerprint','fp-113','idempotency_key','s113-en'));
  if r->>'status' <> 'confirmed' then raise exception 's113: setup: direct booking must confirm'; end if;
  select o.id into en_id from atlas_private.booking_email_outbox o join atlas_private.reservations rr on rr.id = o.reservation_id
   where rr.public_token = r->>'public_token' and o.kind = 'confirmed';

  c := public.atlas_booking_email_claim(10);
  if not (c->>'enabled')::boolean then raise exception 's113: claim must report the switch on'; end if;
  -- The no-address request queued nothing; the bad address is discarded, not claimed.
  if jsonb_array_length(c->'emails') <> 2 then raise exception 's113: expected the IS request + EN confirmation, got %', c->'emails'; end if;
  if (select count(*) from atlas_private.booking_email_outbox where to_email = 'not an address' and status = 'suppressed'
        and error = 'Not a deliverable address.') <> 1 then
    raise exception 's113: an undeliverable address must be discarded';
  end if;

  select x into e from jsonb_array_elements(c->'emails') x where x->>'id' = is_id::text;
  day_is := (array['sunnudagur','mánudagur','þriðjudagur','miðvikudagur','fimmtudagur','föstudagur','laugardagur'])[extract(dow from d)::int + 1]
    || ' ' || extract(day from d)::int || '. '
    || (array['janúar','febrúar','mars','apríl','maí','júní','júlí','ágúst','september','október','nóvember','desember'])[extract(month from d)::int]
    || ' ' || extract(year from d)::int;
  body := e->>'body';
  if is_id is null or en_id is null then raise exception 's113: setup: both emails must be queued'; end if;
  if e is null or e->>'to' <> 'jon@example.is' or e->>'subject' not like 'Bókunarbeiðni móttekin · KA-%'
     or body not like 'Halló Jón,%' or position('Dagsetning: ' || day_is in body) = 0
     or position('Tími: 20:00' in body) = 0 or position('Gestir: 2' in body) = 0 or position('Sæti: 7–8' in body) = 0
     or position('Hafnartorg Gallery, Geirsgata 17, 101 Reykjavík' in body) = 0 then
    raise exception 's113: the Icelandic request email is wrong: % / %', e->>'subject', body;
  end if;
  select x into e from jsonb_array_elements(c->'emails') x where x->>'id' = en_id::text;
  body := e->>'body';
  if e is null or e->>'subject' not like 'Your booking is confirmed · KA-%' or body not like 'Hello Ada,%'
     or position('Date: ' || to_char(d, 'FMDay FMDD FMMonth YYYY') in body) = 0
     or position('Time: 20:00' in body) = 0 or position('Stools: 13–15' in body) = 0
     or position('To change or cancel, reply to this email or call +354 692 0528.' in body) = 0 then
    raise exception 's113: the English confirmation is wrong: % / %', e->>'subject', body;
  end if;
  if (select status || ':' || attempts from atlas_private.booking_email_outbox where id = en_id) <> 'sending:1' then
    raise exception 's113: a claimed email must be sending with one attempt';
  end if;
  if jsonb_array_length(public.atlas_booking_email_claim(10)->'emails') <> 0 then
    raise exception 's113: an email being sent must not be claimed twice';
  end if;

  -- 7. Outcomes.
  -- (separate statements: a check in the same statement would not see the update)
  if (public.atlas_booking_email_complete(is_id, 'sent')->>'ok')::boolean is not true then
    raise exception 's113: complete(sent) must succeed';
  end if;
  if (select status from atlas_private.booking_email_outbox where id = is_id) <> 'sent'
     or (select sent_at is null from atlas_private.booking_email_outbox where id = is_id) then
    raise exception 's113: sent must be recorded';
  end if;
  if (public.atlas_booking_email_complete(is_id, 'retry', 'late report')->>'ok')::boolean then
    raise exception 's113: a second report must change nothing';
  end if;
  perform public.atlas_booking_email_complete(en_id, 'retry', 'smtp 451 at rcpt');
  if (select status || ':' || (next_attempt_at > now()) from atlas_private.booking_email_outbox where id = en_id) <> 'queued:true' then
    raise exception 's113: retry must back off';
  end if;
  if jsonb_array_length(public.atlas_booking_email_claim(10)->'emails') <> 0 then
    raise exception 's113: a backed-off email must wait';
  end if;
  update atlas_private.booking_email_outbox set attempts = 5, status = 'sending' where id = en_id;
  perform public.atlas_booking_email_complete(en_id, 'retry', 'smtp 451 at rcpt');
  if (select status from atlas_private.booking_email_outbox where id = en_id) <> 'failed' then
    raise exception 's113: retry must give up after 5 attempts';
  end if;
  begin
    perform public.atlas_booking_email_complete(en_id, 'maybe');
    raise exception 's113: an unknown outcome must be refused';
  exception when sqlstate '22023' then null;
  end;

  -- 8. Never sent: too old, interrupted. A declined request gets the declined text.
  update atlas_private.booking_email_outbox set status = 'queued', created_at = now() - interval '25 hours',
    next_attempt_at = now() - interval '1 minute' where id = en_id;
  perform public.atlas_booking_email_claim(10);
  if (select status || ':' || error from atlas_private.booking_email_outbox where id = en_id) <> 'suppressed:Older than 24 hours; not sent.' then
    raise exception 's113: an email older than 24 hours must not be sent';
  end if;
  update atlas_private.booking_email_outbox set status = 'sending', claimed_at = now() - interval '11 minutes' where id = is_id;
  perform public.atlas_booking_email_claim(10);
  if (select status || ':' || error from atlas_private.booking_email_outbox where id = is_id) <> 'failed:Interrupted while sending; not repeated.' then
    raise exception 's113: an interrupted send must be failed, never repeated';
  end if;

  select rr.id into rid from atlas_private.reservations rr join atlas_private.booking_email_outbox o on o.reservation_id = rr.id
   where o.id = is_id;
  update atlas_private.reservations set status = 'cancelled' where id = rid;  -- staff turned the request down
  c := public.atlas_booking_email_claim(10);
  select x into e from jsonb_array_elements(c->'emails') x where x->>'to' = 'jon@example.is';
  if e is null or e->>'subject' not like 'Varðandi bókunarbeiðnina þína · KA-%'
     or position('kanel.is/is/bokanir' in e->>'body') = 0 or position('Til að breyta' in e->>'body') > 0 then
    raise exception 's113: a declined request must get the Icelandic declined email, got %', e;
  end if;

  -- 9. Without pg_net / Vault: quiet nulls.
  if to_regclass('vault.decrypted_secrets') is null and public.atlas_booking_email_worker_secret() is not null then
    raise exception 's113: no secret without Vault';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') and atlas_private.booking_email_tick() is not null then
    raise exception 's113: the tick must skip without pg_net';
  end if;

  raise notice 's113 booking guest email: all checks passed';
end
$t$;

rollback;
