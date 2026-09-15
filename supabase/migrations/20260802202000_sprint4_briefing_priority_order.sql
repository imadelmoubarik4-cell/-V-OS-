-- Sprint 4 - deterministic signal ordering.
-- Preserve the Phase 1 briefing contract as the raw source and expose a wrapper
-- that always orders evidence cards by their numeric priority.

do $migration$
begin
  if to_regprocedure('public.atlas_sprint4_daily_briefing_raw()') is null then
    alter function public.atlas_sprint4_daily_briefing()
      rename to atlas_sprint4_daily_briefing_raw;
  end if;
end
$migration$;

revoke execute on function public.atlas_sprint4_daily_briefing_raw()
  from public, anon, authenticated;
grant execute on function public.atlas_sprint4_daily_briefing_raw()
  to service_role;

create or replace function public.atlas_sprint4_daily_briefing()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with source_payload as (
    select public.atlas_sprint4_daily_briefing_raw() as payload
  ),
  ordered_signals as (
    select coalesce(
      jsonb_agg(signal order by
        case
          when coalesce(signal ->> 'priority', '') ~ '^\d+$'
            then (signal ->> 'priority')::integer
          else 9999
        end,
        signal ->> 'key'
      ),
      '[]'::jsonb
    ) as signals
    from source_payload
    cross join lateral jsonb_array_elements(
      coalesce(source_payload.payload -> 'signals', '[]'::jsonb)
    ) as signal
  )
  select jsonb_set(
    source_payload.payload,
    '{signals}',
    ordered_signals.signals,
    true
  )
  from source_payload
  cross join ordered_signals;
$function$;

revoke execute on function public.atlas_sprint4_daily_briefing()
  from public, anon, authenticated;
grant execute on function public.atlas_sprint4_daily_briefing()
  to service_role;

comment on function public.atlas_sprint4_daily_briefing() is
  'Service-role-only deterministic Daily Atlas Briefing with evidence cards ordered by numeric priority.';
comment on function public.atlas_sprint4_daily_briefing_raw() is
  'Underlying read-only Sprint 4 briefing payload. Use atlas_sprint4_daily_briefing() for ordered output.';
