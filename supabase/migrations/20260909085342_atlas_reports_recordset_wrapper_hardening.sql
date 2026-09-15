-- Harden the isolated Reports RPC boundary before the private parser expands
-- incoming JSON with jsonb_to_recordset. Each recordset is coerced to an
-- array and non-object members are discarded. Production source rows are not
-- changed; this only normalizes the read-only JSON copy used for reporting.

create or replace function public.atlas_reports_snapshot_v2(
  p_inventory jsonb,
  p_recipes jsonb,
  p_recipe_ingredients jsonb,
  p_suppliers jsonb,
  p_movements jsonb,
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text,
  p_period_start date,
  p_period_end date,
  p_comparison_start date,
  p_comparison_end date,
  p_comparison_key text,
  p_filters jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  with normalized_inputs as (
    select
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))='array'
            then coalesce(p_inventory,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as inventory,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_recipes,'[]'::jsonb))='array'
            then coalesce(p_recipes,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as recipes,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_recipe_ingredients,'[]'::jsonb))='array'
            then coalesce(p_recipe_ingredients,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as recipe_ingredients,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_suppliers,'[]'::jsonb))='array'
            then coalesce(p_suppliers,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as suppliers,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_movements,'[]'::jsonb))='array'
            then coalesce(p_movements,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as movements,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_profiles,'[]'::jsonb))='array'
            then coalesce(p_profiles,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as profiles,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_tasks,'[]'::jsonb))='array'
            then coalesce(p_tasks,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as tasks,
      coalesce((
        select jsonb_agg(item)
        from jsonb_array_elements(
          case when jsonb_typeof(coalesce(p_progress,'[]'::jsonb))='array'
            then coalesce(p_progress,'[]'::jsonb) else '[]'::jsonb end
        ) as rows(item)
        where jsonb_typeof(item)='object'
      ),'[]'::jsonb) as progress
  ),
  normalized_inventory as (
    select coalesce(jsonb_agg(
      case
        when item ? 'package_size' then jsonb_set(
          item,
          '{package_size}',
          to_jsonb(atlas_private.reports_normalize_package_size(item->>'package_size')),
          true
        )
        else item
      end
    ),'[]'::jsonb) as payload
    from normalized_inputs
    cross join lateral jsonb_array_elements(normalized_inputs.inventory) as rows(item)
  )
  select atlas_private.reports_snapshot_v2(
    normalized_inventory.payload,
    normalized_inputs.recipes,
    normalized_inputs.recipe_ingredients,
    normalized_inputs.suppliers,
    normalized_inputs.movements,
    normalized_inputs.profiles,
    normalized_inputs.tasks,
    normalized_inputs.progress,
    p_actor_id,
    p_actor_role,
    p_period_start,
    p_period_end,
    p_comparison_start,
    p_comparison_end,
    p_comparison_key,
    p_filters
  )
  from normalized_inputs
  cross join normalized_inventory;
$function$;

revoke execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  to service_role;

comment on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  is 'Service-role-only Reports snapshot wrapper. Coerces all incoming recordsets to arrays of JSON objects before invoking the read-only private parser.';

notify pgrst,'reload schema';

