-- Reports receives production source rows as JSON. Some historical inventory
-- package labels use "gr" (for example "250gr"). The private Reports parser
-- expects a canonical gram suffix and previously attempted to cast the
-- remaining "250r" string to numeric. Normalize the JSON copy used for
-- reporting without changing the production inventory record.

create or replace function atlas_private.reports_normalize_package_size(p_value text)
returns text
language plpgsql
immutable
security invoker
set search_path=''
as $$
declare
  normalized text := lower(trim(coalesce(p_value,'')));
  number_text text;
begin
  if normalized='' then return p_value; end if;

  number_text := substring(normalized from '([0-9]+([.,][0-9]+)?)');
  if number_text is null then return p_value; end if;
  number_text := replace(number_text,',','.');

  if normalized ~ '(^|[^a-z])(gr|gram|grams)([^a-z]|$)'
     or normalized ~ '[0-9][[:space:]]*(gr|gram|grams)([^a-z]|$)' then
    return number_text||' g';
  end if;

  return p_value;
end;
$$;

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
as $$
  with normalized_inventory as (
    select coalesce(jsonb_agg(
      case
        when jsonb_typeof(item)='object' and item ? 'package_size'
          then jsonb_set(
            item,
            '{package_size}',
            to_jsonb(atlas_private.reports_normalize_package_size(item->>'package_size')),
            true
          )
        else item
      end
    ),'[]'::jsonb) as payload
    from jsonb_array_elements(coalesce(p_inventory,'[]'::jsonb)) item
  )
  select atlas_private.reports_snapshot_v2(
    normalized_inventory.payload,
    p_recipes,
    p_recipe_ingredients,
    p_suppliers,
    p_movements,
    p_profiles,
    p_tasks,
    p_progress,
    p_actor_id,
    p_actor_role,
    p_period_start,
    p_period_end,
    p_comparison_start,
    p_comparison_end,
    p_comparison_key,
    p_filters
  )
  from normalized_inventory;
$$;

revoke execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.atlas_reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  to service_role;

comment on function atlas_private.reports_normalize_package_size(text) is
  'Normalizes known imported package-size abbreviations before Reports numeric parsing without changing source records.';
