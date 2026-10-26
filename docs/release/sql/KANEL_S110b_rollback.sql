-- KANEL × ALCEDO bookings — ROLLBACK of S110b (booking inbox carries the visit time).
-- OWNER-APPROVED USE ONLY. One transaction, idempotent.
--
-- Restores public.atlas_bookings_notifications to its exact S109 definition (the inbox
-- rows lose start_at / visit_date; the app then falls back to opening today's day)
-- and clears the S110b ledger row. Refuses while S111 is recorded (roll S111 back
-- first). No data is touched.

begin;

do $guard$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version >= '20261028000000') then
    raise exception 'KANEL S110b rollback refused: a later migration (S111+) is recorded — roll it back first';
  end if;
end
$guard$;

create or replace function public.atlas_bookings_notifications(
  p_actor_id uuid, p_actor_role text, p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  n integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  items jsonb;
  unread integer;
begin
  perform atlas_private.booking_require_manager(p_actor_id, p_actor_role);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', x.id, 'reservation_id', x.reservation_id, 'kind', x.kind,
      'title', x.title, 'body', x.body, 'route', x.route,
      'read', x.read_at is not null, 'created_at', x.created_at
    ) order by x.created_at desc), '[]'::jsonb)
  into items
  from (
    select * from atlas_private.booking_notifications
    where audience_user_id = p_actor_id
    order by created_at desc limit n
  ) x;
  select pg_catalog.count(*) into unread from atlas_private.booking_notifications
   where audience_user_id = p_actor_id and read_at is null;
  return pg_catalog.jsonb_build_object('items', items, 'unread', unread);
end
$function$;
revoke all on function public.atlas_bookings_notifications(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.atlas_bookings_notifications(uuid, text, integer) to service_role;

delete from supabase_migrations.schema_migrations where version = '20261027120000';

commit;
