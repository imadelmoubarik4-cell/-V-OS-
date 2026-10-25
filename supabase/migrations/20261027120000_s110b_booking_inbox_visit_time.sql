-- S110b — Booking inbox carries the visit time (KANEL × ALCEDO online bookings).
--
-- A booking notification opened Bookings on TODAY's day view and then looked for
-- the reservation there, so a request for another day (every web request so far)
-- opened nothing and staff never saw the guest's name, time or contact details.
-- The inbox now returns each row's visit start (start_at) and its venue-local date
-- (visit_date, Atlantic/Reykjavik) so the app can open the right day and the
-- reservation itself. Read-only change to one staff RPC: same signature, grants,
-- manager gate, ordering and limit; two keys added. No data is touched.
--
-- Version sits between S110 and S111 so it can be applied while S111 (retention)
-- is still in review.

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
      'read', x.read_at is not null, 'created_at', x.created_at,
      'start_at', r.start_at,
      'visit_date', pg_catalog.to_char(r.start_at at time zone 'Atlantic/Reykjavik', 'YYYY-MM-DD')
    ) order by x.created_at desc), '[]'::jsonb)
  into items
  from (
    select * from atlas_private.booking_notifications
    where audience_user_id = p_actor_id
    order by created_at desc limit n
  ) x
  left join atlas_private.reservations r on r.id = x.reservation_id;
  select pg_catalog.count(*) into unread from atlas_private.booking_notifications
   where audience_user_id = p_actor_id and read_at is null;
  return pg_catalog.jsonb_build_object('items', items, 'unread', unread);
end
$function$;
revoke all on function public.atlas_bookings_notifications(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.atlas_bookings_notifications(uuid, text, integer) to service_role;
