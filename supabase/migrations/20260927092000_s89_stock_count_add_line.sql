-- S89 stock count integration (WP5).
--
--   * atlas_stock_count_add_line: add one out-of-scope item to a draft count
--     (bartender, manager, admin), snapshotting it exactly as
--     stock_count_start does. Idempotent per item. Never changes stock.
--   * atlas_stock_count_save_line_v2 (same signature) now
--       - accepts at most three decimal places (0.2, 0.4, 1.7 bottles), and
--       - validates recognition evidence: the referenced recognition outcome
--         must belong to the counting person, name the same item, be a
--         confirmation and be less than 30 minutes old. Otherwise the
--         evidence is dropped (and recorded as dropped) and a barcode/photo
--         method falls back to manual.
-- Recognition never calls this function; the person's save is the
-- confirmation. Quantities still reach stock only through verify/publish.

do $s89_count_events$
declare
  definition text;
  kinds text[];
begin
  select pg_catalog.pg_get_constraintdef(c.oid) into definition
  from pg_catalog.pg_constraint c
  where c.conrelid = 'atlas_private.inventory_count_events'::regclass and c.contype = 'c'
    and pg_catalog.pg_get_constraintdef(c.oid) like '%event_type%';
  select array_agg(distinct m[1] order by m[1]) into kinds
  from regexp_matches(definition, '''([a-z_]+)''', 'g') as m;
  if not 'line_added' = any(kinds) then
    kinds := kinds || array['line_added'];
    execute (
      select format('alter table atlas_private.inventory_count_events drop constraint %I', c.conname)
      from pg_catalog.pg_constraint c
      where c.conrelid = 'atlas_private.inventory_count_events'::regclass and c.contype = 'c'
        and pg_catalog.pg_get_constraintdef(c.oid) like '%event_type%');
    execute format(
      'alter table atlas_private.inventory_count_events add constraint inventory_count_events_event_type_check check (event_type = any (%L::text[]))',
      kinds);
  end if;
end
$s89_count_events$;

create or replace function atlas_private.stock_count_add_line(
  p_session_id uuid, p_item jsonb, p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  session_row atlas_private.inventory_count_sessions;
  line_row atlas_private.inventory_count_lines;
  item_id uuid;
begin
  if p_actor_role not in ('admin','manager','bartender') then
    raise exception 'This profile cannot count inventory' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  if jsonb_typeof(coalesce(p_item, 'null'::jsonb)) <> 'object' then
    raise exception 'Inventory item is required' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  begin
    item_id := (p_item->>'id')::uuid;
  exception when invalid_text_representation then
    raise exception 'Inventory item is invalid' using errcode = '22023', hint = 'atlas:invalid_request';
  end;
  if item_id is null then raise exception 'Inventory item is required' using errcode = '22023', hint = 'atlas:invalid_request'; end if;
  if coalesce((p_item->>'active')::boolean, true) is not true then
    raise exception 'Only active items can be counted' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  select * into session_row from atlas_private.inventory_count_sessions where id = p_session_id for update;
  if not found then raise exception 'Stock-count session not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if session_row.status <> 'draft' then
    raise exception 'Only draft stock counts can be edited' using errcode = '55000', hint = 'atlas:count_closed';
  end if;

  select * into line_row from atlas_private.inventory_count_lines where session_id = p_session_id and inventory_item_id = item_id;
  if found then
    return jsonb_build_object('added', false, 'line_id', line_row.id, 'line_version', line_row.version,
      'detail', atlas_private.stock_count_detail(p_session_id, p_actor_id, p_actor_role), 'stock_changed', false);
  end if;

  insert into atlas_private.inventory_count_lines (
    session_id,inventory_item_id,item_name,category,inventory_unit,bin_location,sku,barcode,
    expected_quantity,expected_updated_at,source_updated_at,source_kind,observed_unit,
    units_per_case_snapshot,size_ml_snapshot,package_size_snapshot,package_weight_g_snapshot,
    par_level_snapshot,supplier_snapshot,unit_cost_snapshot,case_cost_snapshot,source_file_snapshot
  )
  select
    p_session_id, item_id, coalesce(nullif(item->>'name',''),'Unnamed inventory item'),
    nullif(item->>'category',''), coalesce(nullif(item->>'unit',''),'units'), nullif(item->>'bin_location',''),
    nullif(item->>'sku',''), nullif(item->>'barcode',''),
    case when nullif(item->>'source_updated_at','')::date <= date '2026-07-31' then null else nullif(item->>'quantity','')::numeric end,
    nullif(item->>'updated_at','')::timestamptz, nullif(item->>'source_updated_at','')::date,
    case when nullif(item->>'source_updated_at','')::date <= date '2026-07-31' then 'historical_snapshot' else 'production_observation' end,
    coalesce(nullif(item->>'unit',''),'units'), nullif(item->>'units_per_case','')::numeric,
    nullif(item->>'size_ml','')::numeric, nullif(item->>'package_size',''),
    coalesce(nullif(item->>'package_weight_g','')::numeric, atlas_private.stock_count_package_weight_g(item->>'package_size')),
    nullif(item->>'par_level','')::numeric, nullif(coalesce(item->>'supplier', item->>'supplier_name'),''),
    nullif(item->>'cost_price','')::numeric, nullif(item->>'case_cost','')::numeric, nullif(item->>'source_file','')
  from (select p_item as item) source
  returning * into line_row;

  update atlas_private.inventory_count_sessions
  set source_record_count = source_record_count + 1, version = version + 1
  where id = p_session_id;
  insert into atlas_private.inventory_count_events (event_type, session_id, line_id, inventory_item_id, actor_id, actor_label, actor_role, payload)
  values ('line_added', p_session_id, line_row.id, item_id, p_actor_id, p_actor_label, p_actor_role,
    jsonb_build_object('item_name', line_row.item_name, 'reason', 'outside_session_scope'));
  return jsonb_build_object('added', true, 'line_id', line_row.id, 'line_version', line_row.version,
    'detail', atlas_private.stock_count_detail(p_session_id, p_actor_id, p_actor_role), 'stock_changed', false);
end
$function$;

create or replace function public.atlas_stock_count_add_line(
  p_session_id uuid, p_item jsonb, p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.stock_count_add_line(p_session_id, p_item, p_actor_id, p_actor_label, p_actor_role);
$function$;

-- Recognition evidence check for a count line. Returns
-- {valid, reason, recognition} where recognition is rebuilt from the audit
-- rows (the client's band and score are never trusted).
create or replace function atlas_private.stock_count_recognition_evidence(
  p_recognition jsonb, p_item_id uuid, p_actor_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  outcome atlas_private.recognition_outcomes;
  detection atlas_private.recognition_detections;
  candidate atlas_private.recognition_candidates;
  outcome_id uuid;
begin
  if jsonb_typeof(p_recognition) <> 'object' then
    return jsonb_build_object('valid', false, 'reason', 'not_an_object');
  end if;
  begin
    outcome_id := (p_recognition->>'outcome_id')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('valid', false, 'reason', 'invalid_outcome_id');
  end;
  if outcome_id is null then return jsonb_build_object('valid', false, 'reason', 'missing_outcome_id'); end if;
  select * into outcome from atlas_private.recognition_outcomes where id = outcome_id;
  if not found then return jsonb_build_object('valid', false, 'reason', 'outcome_not_found'); end if;
  if outcome.actor_id is distinct from p_actor_id then return jsonb_build_object('valid', false, 'reason', 'other_person'); end if;
  if outcome.chosen_item_id is distinct from p_item_id then return jsonb_build_object('valid', false, 'reason', 'other_item'); end if;
  if outcome.outcome not in ('confirmed_preselected','chose_candidate','chose_by_search') then
    return jsonb_build_object('valid', false, 'reason', 'not_a_confirmation');
  end if;
  if outcome.created_at < now() - interval '30 minutes' then
    return jsonb_build_object('valid', false, 'reason', 'expired');
  end if;
  select * into detection from atlas_private.recognition_detections where id = outcome.detection_id;
  select * into candidate from atlas_private.recognition_candidates
  where detection_id = outcome.detection_id and item_id = p_item_id order by rank limit 1;
  return jsonb_build_object('valid', true, 'reason', null, 'recognition', jsonb_build_object(
    'outcome_id', outcome.id, 'outcome', outcome.outcome, 'detection_id', detection.id,
    'request_id', detection.request_id, 'band', detection.band, 'rank', candidate.rank,
    'score', candidate.score, 'validated_at', now()));
end
$function$;

create or replace function public.atlas_stock_count_save_line_v2(
  p_session_id uuid, p_line_id uuid, p_line_status text, p_input_quantity numeric, p_input_unit text,
  p_count_method text, p_note text, p_skipped_reason text, p_expected_version integer, p_evidence jsonb,
  p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  method text := p_count_method;
  item_id uuid;
  checked jsonb;
begin
  if p_line_status = 'counted' and p_input_quantity is not null and p_input_quantity <> round(p_input_quantity, 3) then
    raise exception 'Counts accept up to three decimal places' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if jsonb_typeof(evidence) = 'object' and evidence ? 'recognition' then
    select line.inventory_item_id into item_id from atlas_private.inventory_count_lines line
    where line.id = p_line_id and line.session_id = p_session_id;
    checked := atlas_private.stock_count_recognition_evidence(evidence->'recognition', item_id, p_actor_id);
    if (checked->>'valid')::boolean then
      evidence := evidence || jsonb_build_object('recognition', checked->'recognition');
    else
      evidence := (evidence - 'recognition') || jsonb_build_object('recognition_dropped', checked->>'reason');
      if method in ('barcode', 'photo') then method := 'manual'; end if;
    end if;
  end if;
  return atlas_private.stock_count_save_line_v2(p_session_id, p_line_id, p_line_status, p_input_quantity, p_input_unit,
    method, p_note, p_skipped_reason, p_expected_version, evidence, p_actor_id, p_actor_label, p_actor_role);
end
$function$;

do $s89_count_grants$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'atlas_private' and p.proname in ('stock_count_add_line', 'stock_count_recognition_evidence'))
       or (n.nspname = 'public' and p.proname in ('atlas_stock_count_add_line', 'atlas_stock_count_save_line_v2'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', function_row.signature);
    execute format('grant execute on function %s to service_role', function_row.signature);
  end loop;
end
$s89_count_grants$;

notify pgrst, 'reload schema';
