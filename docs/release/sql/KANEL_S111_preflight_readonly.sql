-- KANEL × ALCEDO bookings — S111 PREFLIGHT (READ-ONLY). Run immediately before the S111
-- apply bundle; keep the output. One SELECT; writes nothing.
-- Go only if there is no FAIL row. The 'impact' rows show what the FIRST nightly run
-- would remove (90 days after the visit); review them before applying.
select section, "check", status, detail from (
select 1 as ord, 'ledger' as section, 'production is at S110' as "check",
  case when (select max(version) from supabase_migrations.schema_migrations) = '20261027090000' then 'PASS' else 'FAIL' end as status,
  'last migration ' || coalesce((select max(version) from supabase_migrations.schema_migrations), 'none') as detail
union all select 2, 'ledger', 'no S111 row yet',
  case when not exists (select 1 from supabase_migrations.schema_migrations where version = '20261028090000') then 'PASS' else 'FAIL' end, ''
union all select 3, 'scheduler', 'pg_cron can be enabled (nightly clean-up)',
  case when exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then 'PASS' else 'FAIL' end,
  coalesce((select 'available ' || default_version || coalesce(', installed ' || installed_version, ', not yet installed')
              from pg_catalog.pg_available_extensions where name = 'pg_cron'), 'not available')
union all select 4, 'not yet released', 'booking_purge_personal_data absent',
  case when not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'atlas_private' and p.proname = 'booking_purge_personal_data') then 'PASS' else 'FAIL' end, ''
union all select 10, 'impact', 'bookings whose visit ended > 90 days ago and still hold guest details (anonymised on the first run)', 'INFO',
  (select pg_catalog.count(*)::text from atlas_private.reservations r
    where r.end_at < pg_catalog.now() - interval '90 days'
      and (r.guest_name is not null or r.guest_phone is not null or r.guest_email is not null or r.guest_requests is not null
           or r.staff_notes is not null or r.public_token is not null or r.idempotency_key is not null or r.provider_ref is not null))
union all select 11, 'impact', 'oldest booking visit on record', 'INFO',
  coalesce((select pg_catalog.to_char(pg_catalog.min(end_at) at time zone 'Atlantic/Reykjavik', 'YYYY-MM-DD') from atlas_private.reservations), 'none')
union all select 12, 'impact', 'inbox / email outbox rows older than 90 days (deleted on the first run)', 'INFO',
  (select pg_catalog.count(*) from atlas_private.booking_notifications where created_at < pg_catalog.now() - interval '90 days')::text
  || ' / ' || (select pg_catalog.count(*) from atlas_private.booking_email_outbox where created_at < pg_catalog.now() - interval '90 days')::text
union all select 13, 'impact', 'booking push rows older than 90 days / status-history notes on bookings older than 90 days', 'INFO',
  (select pg_catalog.count(*) from atlas_private.push_notification_queue q
    where (q.event_type = 'booking_request' or q.route = 'bookings') and q.created_at < pg_catalog.now() - interval '90 days')::text
  || ' / ' || (select pg_catalog.count(*) from atlas_private.reservation_status_history h join atlas_private.reservations r on r.id = h.reservation_id
    where r.end_at < pg_catalog.now() - interval '90 days' and h.note is not null)::text
union all select 14, 'impact', 'expected first dry run: every impact count above is 0', 
  case when not exists (select 1 from atlas_private.reservations where end_at < pg_catalog.now() - interval '90 days')
        and not exists (select 1 from atlas_private.booking_notifications where created_at < pg_catalog.now() - interval '90 days')
        and not exists (select 1 from atlas_private.booking_email_outbox where created_at < pg_catalog.now() - interval '90 days')
        and not exists (select 1 from atlas_private.push_notification_queue q where (q.event_type = 'booking_request' or q.route = 'bookings')
                          and q.created_at < pg_catalog.now() - interval '90 days')
       then 'PASS' else 'INFO' end, 'PASS = the first nightly run removes nothing'
) checks order by ord, "check";
