-- S88 owner-data workflows: live Data review issues, par evidence and a bulk
-- par editor.
--
--   * public.atlas_data_review_summary()      issue codes with counts
--   * public.atlas_data_review_rows(...)      rows for one issue code
--   * public.atlas_par_level_evidence(...)    stock evidence per item and,
--     only when the evidence rule holds, a suggestion (never saved)
--   * public.atlas_apply_par_levels(...)      atomic bulk par save with an
--     optimistic check per item; any conflict aborts the whole batch
--
-- Browser -> PostgREST RPC (Path A): invoker wrappers call manager-gated
-- security definer bodies; definer is needed because the rules read
-- atlas_private (scan aliases, count evidence, the S86.1 package parser).
-- Only par_level is ever written; quantity, movements and counts are never
-- touched. Single venue: no tenancy column.

-- par_levels_updated joins the Item Master audit type list. The list is
-- rebuilt from the installed constraint so types added by other migrations
-- are kept whichever lands first.
do $migration$
declare
  definition text;
  kinds text[];
begin
  select pg_catalog.pg_get_constraintdef(c.oid) into definition
  from pg_catalog.pg_constraint c
  where c.conrelid = 'atlas_private.item_master_events'::regclass
    and c.conname = 'item_master_events_event_type_check';
  if definition is null then
    raise exception 'item_master_events_event_type_check is missing';
  end if;
  select array_agg(distinct m[1] order by m[1]) into kinds
  from regexp_matches(definition, '''([a-z_]+)''', 'g') as m;
  if not 'par_levels_updated' = any(kinds) then
    kinds := kinds || array['par_levels_updated'];
    alter table atlas_private.item_master_events drop constraint item_master_events_event_type_check;
    execute format(
      'alter table atlas_private.item_master_events add constraint item_master_events_event_type_check check (event_type = any (%L::text[]))',
      kinds);
  end if;
end
$migration$;

-- Idempotency ledger for bulk par saves (service-role-only pattern).
create table if not exists atlas_private.par_level_requests (
  request_id text primary key check (length(request_id) between 1 and 200),
  actor_id uuid not null,
  request_hash text not null,
  applied jsonb not null check (jsonb_typeof(applied) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists par_level_requests_actor_idx on atlas_private.par_level_requests(actor_id, created_at desc);
alter table atlas_private.par_level_requests enable row level security;
revoke all on atlas_private.par_level_requests from public, anon, authenticated;
grant all on atlas_private.par_level_requests to service_role;
drop policy if exists par_level_requests_service_only on atlas_private.par_level_requests;
create policy par_level_requests_service_only on atlas_private.par_level_requests
  for all to service_role using (true) with check (true);

-- Issue catalogue (codes are the API contract). Order = display order.
create or replace function private.data_review_catalogue()
returns table (code text, entity_type text, label text, sort_order integer)
language sql
immutable
set search_path = ''
as $function$
  select * from (values
    ('inventory.missing_supplier','inventory_item','No supplier linked',1),
    ('inventory.supplier_text_unlinked','inventory_item','Supplier name typed but not linked',2),
    ('inventory.missing_cost','inventory_item','No unit or case cost',3),
    ('inventory.missing_reference','inventory_item','No SKU, barcode or supplier reference',4),
    ('inventory.package_missing','inventory_item','No package size',5),
    ('inventory.package_unreadable','inventory_item','Package size cannot be read',6),
    ('inventory.missing_par','inventory_item','No par level',7),
    ('inventory.flagged_needs_review','inventory_item','Flagged for review',8),
    ('recipe.missing_price','recipe','Recipe has no menu price',9),
    ('recipe.no_ingredients','recipe','Recipe has no ingredients',10),
    ('recipe.ingredient_unlinked','recipe_ingredient','Ingredient not linked to stock',11),
    ('recipe.ingredient_inactive_item','recipe_ingredient','Ingredient uses an inactive item',12)
  ) as catalogue(code, entity_type, label, sort_order);
$function$;
revoke all on function private.data_review_catalogue() from public, anon, authenticated;

-- Every open issue as one row. Active items and active recipes only.
create or replace function private.data_review_issue_rows()
returns table (code text, entity_type text, entity_id uuid, name text, category text, detail jsonb, fix text)
language sql
stable
security definer
set search_path = ''
as $function$
  with items as (
    select i.*,
      nullif(pg_catalog.btrim(coalesce(i.package_size,'')),'') as package_text,
      exists (select 1 from atlas_private.inventory_scan_aliases a
              where a.external_item_id = i.id and a.active) as has_alias
    from public.inventory_items i
    where i.active
  ), item_issues as (
    select 'inventory.missing_supplier' as code, i.id, i.name, i.category,
           jsonb_build_object('supplier_text', nullif(pg_catalog.btrim(coalesce(i.supplier,'')),'')) as detail, 'item_master' as fix
    from items i where i.supplier_id is null
    union all
    select 'inventory.supplier_text_unlinked', i.id, i.name, i.category,
           jsonb_build_object('supplier_text', pg_catalog.btrim(i.supplier)), 'item_master'
    from items i where i.supplier_id is null and nullif(pg_catalog.btrim(coalesce(i.supplier,'')),'') is not null
    union all
    select 'inventory.missing_cost', i.id, i.name, i.category,
           jsonb_build_object('case_cost', i.case_cost, 'units_per_case', i.units_per_case), 'item_master'
    from items i where i.cost_price is null and not (i.case_cost is not null and coalesce(i.units_per_case,0) > 0)
    union all
    select 'inventory.missing_reference', i.id, i.name, i.category, '{}'::jsonb, 'item_master'
    from items i
    where nullif(pg_catalog.btrim(coalesce(i.sku,'')),'') is null
      and nullif(pg_catalog.btrim(coalesce(i.barcode,'')),'') is null
      and nullif(pg_catalog.btrim(coalesce(i.supplier_product_reference,'')),'') is null
      and not i.has_alias
    union all
    select 'inventory.package_missing', i.id, i.name, i.category, '{}'::jsonb, 'item_master'
    from items i where i.size_ml is null and i.package_weight_g is null and i.package_text is null
    union all
    select 'inventory.package_unreadable', i.id, i.name, i.category,
           jsonb_build_object('package_size', i.package_text), 'item_master'
    from items i
    where i.size_ml is null and i.package_weight_g is null and i.package_text is not null
      and (select p.measure_quantity from atlas_private.reports_parse_pack_measure(i.package_text) p limit 1) is null
    union all
    select 'inventory.missing_par', i.id, i.name, i.category,
           jsonb_build_object('unit', i.unit, 'critical_minimum', i.critical_minimum), 'par_levels'
    from items i where i.par_level is null
    union all
    select 'inventory.flagged_needs_review', i.id, i.name, i.category,
           jsonb_build_object('source_type', i.source_type, 'source_confidence', i.source_confidence), 'item_master'
    from items i where i.needs_review
  ), recipe_issues as (
    select 'recipe.missing_price' as code, 'recipe' as entity_type, r.id, r.name, r.type as category,
           '{}'::jsonb as detail, 'recipe' as fix
    from public.recipes r where r.active and r.menu_price is null
    union all
    select 'recipe.no_ingredients', 'recipe', r.id, r.name, r.type, '{}'::jsonb, 'recipe'
    from public.recipes r
    where r.active and not exists (select 1 from public.recipe_ingredients ri where ri.recipe_id = r.id)
    union all
    select 'recipe.ingredient_unlinked', 'recipe_ingredient', ri.id, r.name, r.type,
           jsonb_build_object('recipe_id', r.id, 'ingredient_name', ri.item_name), 'recipe'
    from public.recipe_ingredients ri join public.recipes r on r.id = ri.recipe_id
    where r.active and ri.item_id is null
    union all
    select 'recipe.ingredient_inactive_item', 'recipe_ingredient', ri.id, r.name, r.type,
           jsonb_build_object('recipe_id', r.id, 'ingredient_name', ri.item_name, 'item_id', i.id, 'item_name', i.name), 'recipe'
    from public.recipe_ingredients ri
    join public.recipes r on r.id = ri.recipe_id
    join public.inventory_items i on i.id = ri.item_id
    where r.active and i.active is not true
  )
  select ii.code, 'inventory_item', ii.id, ii.name, ii.category, ii.detail, ii.fix from item_issues ii
  union all
  select ri.code, ri.entity_type, ri.id, ri.name, ri.category, ri.detail, ri.fix from recipe_issues ri;
$function$;
revoke all on function private.data_review_issue_rows() from public, anon, authenticated;

create or replace function private.data_review_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Active manager access required' using errcode='42501';
  end if;
  return jsonb_build_object(
    'generated_at', pg_catalog.now(),
    'issues', (
      select jsonb_agg(jsonb_build_object('code', c.code, 'entity_type', c.entity_type, 'label', c.label,
               'count', coalesce(n.total, 0)) order by c.sort_order)
      from private.data_review_catalogue() c
      left join (select r.code, count(*) as total from private.data_review_issue_rows() r group by r.code) n
        on n.code = c.code));
end
$function$;
revoke all on function private.data_review_summary() from public, anon;
grant execute on function private.data_review_summary() to authenticated;

create or replace function private.data_review_rows(p_issue text, p_limit integer, p_offset integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  catalogue_row record;
  row_limit integer := coalesce(p_limit, 100);
  row_offset integer := coalesce(p_offset, 0);
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Active manager access required' using errcode='42501';
  end if;
  select * into catalogue_row from private.data_review_catalogue() c where c.code = p_issue;
  if catalogue_row.code is null then raise exception 'Unknown Data review issue'; end if;
  if row_limit not between 1 and 500 then raise exception 'Limit must be between 1 and 500'; end if;
  if row_offset < 0 then raise exception 'Offset cannot be negative'; end if;
  return jsonb_build_object(
    'issue', catalogue_row.code,
    'label', catalogue_row.label,
    'entity_type', catalogue_row.entity_type,
    'total', (select count(*) from private.data_review_issue_rows() r where r.code = p_issue),
    'limit', row_limit,
    'offset', row_offset,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('entity_type', x.entity_type, 'entity_id', x.entity_id, 'name', x.name,
               'category', x.category, 'detail', x.detail, 'fix', x.fix) order by x.name, x.entity_id)
      from (select r.* from private.data_review_issue_rows() r where r.code = p_issue
            order by pg_catalog.lower(r.name), r.entity_id limit row_limit offset row_offset) x), '[]'::jsonb));
end
$function$;
revoke all on function private.data_review_rows(text, integer, integer) from public, anon;
grant execute on function private.data_review_rows(text, integer, integer) to authenticated;

-- Evidence rule (a suggestion is shown only when all hold):
--   1. >= 3 stock observations in the last 120 days: counted lines of verified
--      count sessions (historical snapshots excluded) and the S84 trusted owner
--      confirmation (source_confirmed_at/_quantity);
--   2. observations span >= 14 days and all use the item's current unit;
--   3. every interval usage = q_prev + restocks between - q_next is >= 0
--      (restocks = 'restock' movements with quantity_change > 0);
--   4. average daily usage = total usage / span days is > 0.
create or replace function private.par_level_evidence(p_item_ids uuid[], p_cover_days numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  item public.inventory_items;
  obs record;
  items_out jsonb := '[]'::jsonb;
  observations jsonb;
  intervals jsonb;
  n integer;
  first_at timestamptz;
  prev_at timestamptz;
  prev_q numeric;
  restocked numeric;
  usage numeric;
  total_usage numeric;
  unit_mismatch boolean;
  negative boolean;
  span numeric;
  avg_usage numeric;
  reason text;
  suggestion jsonb;
  window_start timestamptz := pg_catalog.now() - interval '120 days';
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Active manager access required' using errcode='42501';
  end if;
  if p_item_ids is not null and coalesce(array_length(p_item_ids, 1), 0) > 500 then
    raise exception 'Request evidence for at most 500 items';
  end if;
  if p_cover_days is not null and not (p_cover_days > 0 and p_cover_days <= 365) then
    raise exception 'Days of cover must be between 1 and 365';
  end if;
  for item in
    select * from public.inventory_items i
    where i.active and (p_item_ids is null or i.id = any(p_item_ids))
    order by pg_catalog.lower(i.name), i.id
  loop
    observations := '[]'::jsonb; intervals := '[]'::jsonb;
    n := 0; first_at := null; prev_at := null; prev_q := null; total_usage := 0;
    unit_mismatch := false; negative := false;
    for obs in
      select distinct on (e.at) e.at, e.quantity, e.unit, e.source
      from (
        select l.counted_at as at, l.observed_quantity as quantity, l.inventory_unit as unit,
               'verified_count'::text as source, 1 as rank
        from atlas_private.inventory_count_lines l
        join atlas_private.inventory_count_sessions s on s.id = l.session_id
        where l.inventory_item_id = item.id and l.line_status = 'counted' and s.status = 'verified'
          and l.source_kind <> 'historical_snapshot' and l.observed_quantity is not null
          and l.counted_at >= window_start and l.counted_at <= pg_catalog.now()
        union all
        select item.source_confirmed_at, item.source_confirmed_quantity, item.unit, 'owner_confirmation', 2
        where item.source_confirmed_at is not null and item.source_confirmed_quantity is not null
          and item.source_confirmed_at >= window_start and item.source_confirmed_at <= pg_catalog.now()
      ) e
      order by e.at, e.rank
    loop
      n := n + 1;
      if obs.unit is distinct from item.unit then unit_mismatch := true; end if;
      if prev_at is not null then
        select coalesce(sum(m.quantity_change), 0) into restocked
        from public.inventory_movements m
        where m.item_id = item.id and m.movement_type = 'restock' and m.quantity_change > 0
          and m.created_at > prev_at and m.created_at <= obs.at;
        usage := prev_q + restocked - obs.quantity;
        if usage < 0 then negative := true; end if;
        total_usage := total_usage + usage;
        intervals := intervals || jsonb_build_array(jsonb_build_object(
          'from', prev_at, 'to', obs.at, 'start_quantity', prev_q, 'restocked', restocked,
          'end_quantity', obs.quantity, 'usage', usage,
          'days', round(extract(epoch from (obs.at - prev_at)) / 86400, 2)));
      end if;
      observations := observations || jsonb_build_array(jsonb_build_object(
        'at', obs.at, 'quantity', obs.quantity, 'unit', obs.unit, 'source', obs.source));
      first_at := coalesce(first_at, obs.at);
      prev_at := obs.at; prev_q := obs.quantity;
    end loop;
    span := case when n > 0 then extract(epoch from (prev_at - first_at)) / 86400 else 0 end;
    avg_usage := case when span > 0 then total_usage / span else null end;
    reason := case
      when n < 3 then 'insufficient_observations'
      when unit_mismatch then 'unit_changed'
      when span < 14 then 'span_too_short'
      when negative then 'inconsistent_evidence'
      when avg_usage is null or avg_usage <= 0 then 'no_usage'
    end;
    suggestion := null;
    if reason is null and p_cover_days is not null then
      suggestion := jsonb_build_object(
        'cover_days', p_cover_days,
        'par_level', ceil(avg_usage * p_cover_days),
        'cases', case when coalesce(item.units_per_case, 0) > 0
                   then ceil(ceil(avg_usage * p_cover_days) / item.units_per_case) end,
        'saved', false);
    end if;
    items_out := items_out || jsonb_build_array(jsonb_build_object(
      'item_id', item.id, 'name', item.name, 'category', item.category, 'unit', item.unit,
      'par_level', item.par_level, 'critical_minimum', item.critical_minimum,
      'units_per_case', item.units_per_case, 'updated_at', item.updated_at,
      'observations', n,
      'span_days', round(span, 2),
      'avg_daily_usage', case when reason is null then round(avg_usage, 4) end,
      'eligible', reason is null,
      'reason', reason,
      'evidence', observations,
      'intervals', intervals,
      'evidence_digest', pg_catalog.md5(observations::text),
      'suggestion', suggestion));
  end loop;
  return jsonb_build_object(
    'generated_at', pg_catalog.now(),
    'rule', jsonb_build_object('min_observations', 3, 'min_span_days', 14, 'window_days', 120,
      'sources', jsonb_build_array('verified_count', 'owner_confirmation')),
    'items', items_out);
end
$function$;
revoke all on function private.par_level_evidence(uuid[], numeric) from public, anon;
grant execute on function private.par_level_evidence(uuid[], numeric) to authenticated;

create or replace function private.apply_par_levels(p_changes jsonb, p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  actor_role text;
  request_key text := nullif(pg_catalog.btrim(coalesce(p_request_id, '')), '');
  entry jsonb;
  normalized jsonb := '[]'::jsonb;
  request_hash text;
  stored atlas_private.par_level_requests;
  item public.inventory_items;
  change jsonb;
  new_par numeric;
  expected_par numeric;
  expected_at timestamptz;
  suggestion jsonb;
  conflicts jsonb := '[]'::jsonb;
  changed jsonb := '[]'::jsonb;
  unchanged jsonb := '[]'::jsonb;
  result jsonb;
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Active manager access required' using errcode='42501';
  end if;
  if request_key is null or length(request_key) > 200 then raise exception 'A request ID is required'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) not between 1 and 500 then
    raise exception 'Send 1 to 500 par changes';
  end if;
  for entry in select value from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(entry) <> 'object'
       or coalesce(entry->>'item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Each par change needs an item';
    end if;
    if not (entry ? 'par_level') or not (entry ? 'expected_par_level')
       or jsonb_typeof(entry->'par_level') not in ('number', 'null')
       or jsonb_typeof(entry->'expected_par_level') not in ('number', 'null') then
      raise exception 'Each par change needs par_level and expected_par_level (number or null)';
    end if;
    new_par := (entry->>'par_level')::numeric;
    if new_par is not null and not (new_par >= 0 and new_par <= 1000000000) then
      raise exception 'Par level must be between 0 and 1000000000';
    end if;
    expected_at := null;
    if entry ? 'expected_updated_at' and jsonb_typeof(entry->'expected_updated_at') <> 'null' then
      begin
        expected_at := (entry->>'expected_updated_at')::timestamptz;
      exception when others then
        raise exception 'expected_updated_at must be a timestamp';
      end;
    end if;
    suggestion := null;
    if jsonb_typeof(entry->'suggestion') = 'object' then
      suggestion := jsonb_build_object(
        'shown', coalesce((entry->'suggestion'->'shown') = 'true'::jsonb, false),
        'value', case when jsonb_typeof(entry->'suggestion'->'value') = 'number' then entry->'suggestion'->'value' end,
        'cover_days', case when jsonb_typeof(entry->'suggestion'->'cover_days') = 'number' then entry->'suggestion'->'cover_days' end,
        'evidence_digest', left(entry->'suggestion'->>'evidence_digest', 64));
    end if;
    if exists (select 1 from jsonb_array_elements(normalized) x where x->>'item_id' = lower(entry->>'item_id')) then
      raise exception 'Use one change per inventory item';
    end if;
    normalized := normalized || jsonb_build_array(jsonb_build_object(
      'item_id', lower(entry->>'item_id'), 'par_level', new_par,
      'expected_par_level', (entry->>'expected_par_level')::numeric,
      'expected_updated_at', expected_at, 'suggestion', suggestion));
  end loop;
  select pg_catalog.md5(coalesce(jsonb_agg(x order by x->>'item_id'), '[]'::jsonb)::text) into request_hash
  from jsonb_array_elements(normalized) x;

  -- Serialize retries of the same request, then replay a stored result.
  perform pg_advisory_xact_lock(hashtextextended('par-levels:' || request_key, 0));
  select * into stored from atlas_private.par_level_requests where request_id = request_key;
  if stored.request_id is not null then
    if stored.actor_id = actor and stored.request_hash = request_hash then
      return stored.applied || jsonb_build_object('replayed', true);
    end if;
    raise exception 'This request ID was already used for different changes';
  end if;

  -- Lock every row in id order; check all before writing anything.
  for item in
    select i.* from public.inventory_items i
    where i.id in (select (x->>'item_id')::uuid from jsonb_array_elements(normalized) x)
    order by i.id for update
  loop
    null;
  end loop;
  for change in select value from jsonb_array_elements(normalized) order by value->>'item_id' loop
    select * into item from public.inventory_items where id = (change->>'item_id')::uuid;
    if item.id is null or item.active is not true then
      raise exception 'Inventory item not found or inactive';
    end if;
    expected_par := (change->>'expected_par_level')::numeric;
    expected_at := (change->>'expected_updated_at')::timestamptz;
    if item.par_level is distinct from expected_par
       or (expected_at is not null and item.updated_at is distinct from expected_at) then
      conflicts := conflicts || jsonb_build_array(jsonb_build_object(
        'item_id', item.id, 'name', item.name,
        'expected_par_level', expected_par, 'current_par_level', item.par_level,
        'expected_updated_at', expected_at, 'current_updated_at', item.updated_at));
    end if;
  end loop;
  if jsonb_array_length(conflicts) > 0 then
    -- Nothing was written; the request ID stays unused so the editor can reload.
    return jsonb_build_object('status', 'conflict', 'request_id', request_key, 'replayed', false,
      'conflicts', conflicts, 'changed', '[]'::jsonb, 'unchanged', '[]'::jsonb);
  end if;

  actor_role := private.current_profile_role();
  for change in select value from jsonb_array_elements(normalized) order by value->>'item_id' loop
    select * into item from public.inventory_items where id = (change->>'item_id')::uuid;
    new_par := (change->>'par_level')::numeric;
    if new_par is not distinct from item.par_level then
      unchanged := unchanged || jsonb_build_array(item.id);
      continue;
    end if;
    if new_par is not null and item.critical_minimum is not null and item.critical_minimum > new_par then
      raise exception 'Par level for % cannot be below its critical minimum', item.name;
    end if;
    update public.inventory_items set par_level = new_par where id = item.id returning * into item;
    insert into atlas_private.item_master_events (event_type, external_item_id, actor_id, actor_role, payload)
    values ('par_levels_updated', item.id, actor, actor_role, jsonb_build_object(
      'from', (change->>'expected_par_level')::numeric, 'to', new_par, 'request_id', request_key,
      'suggestion', change->'suggestion'));
    changed := changed || jsonb_build_array(jsonb_build_object(
      'item_id', item.id, 'from', (change->>'expected_par_level')::numeric, 'to', new_par,
      'updated_at', item.updated_at));
  end loop;
  result := jsonb_build_object('status', 'applied', 'request_id', request_key,
    'changed', changed, 'unchanged', unchanged, 'conflicts', '[]'::jsonb);
  insert into atlas_private.par_level_requests (request_id, actor_id, request_hash, applied)
  values (request_key, actor, request_hash, result);
  return result || jsonb_build_object('replayed', false);
end
$function$;
revoke all on function private.apply_par_levels(jsonb, text) from public, anon;
grant execute on function private.apply_par_levels(jsonb, text) to authenticated;

create or replace function public.atlas_data_review_summary()
returns jsonb language sql stable security invoker set search_path = ''
as $function$ select private.data_review_summary(); $function$;
create or replace function public.atlas_data_review_rows(p_issue text, p_limit integer default 100, p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path = ''
as $function$ select private.data_review_rows(p_issue, p_limit, p_offset); $function$;
create or replace function public.atlas_par_level_evidence(p_item_ids uuid[] default null, p_cover_days numeric default null)
returns jsonb language sql stable security invoker set search_path = ''
as $function$ select private.par_level_evidence(p_item_ids, p_cover_days); $function$;
create or replace function public.atlas_apply_par_levels(p_changes jsonb, p_request_id text)
returns jsonb language sql security invoker set search_path = ''
as $function$ select private.apply_par_levels(p_changes, p_request_id); $function$;

revoke all on function public.atlas_data_review_summary() from public, anon;
revoke all on function public.atlas_data_review_rows(text, integer, integer) from public, anon;
revoke all on function public.atlas_par_level_evidence(uuid[], numeric) from public, anon;
revoke all on function public.atlas_apply_par_levels(jsonb, text) from public, anon;
grant execute on function public.atlas_data_review_summary() to authenticated;
grant execute on function public.atlas_data_review_rows(text, integer, integer) to authenticated;
grant execute on function public.atlas_par_level_evidence(uuid[], numeric) to authenticated;
grant execute on function public.atlas_apply_par_levels(jsonb, text) to authenticated;

notify pgrst, 'reload schema';
