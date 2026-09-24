-- S89 catalog governance (WP4): one approval queue for every catalogue change.
--
-- Nothing is created, merged, linked or changed automatically. Staff propose;
-- a manager decides; every decision and its effect is written to the
-- append-only atlas_private.catalog_events.
--
--   * atlas_private.catalog_change_requests  the queue (alias, code, new_item,
--     duplicate_resolution, metadata_correction, wrong_match_report, code_conflict)
--   * atlas_private.catalog_events           append-only audit
--   * atlas_private.catalog_distinct_pairs   "not duplicates" decisions
--   * duplicate guard (mandatory before any item is created): barcode, SKU,
--     supplier reference, identity key, name key, search match key (other
--     spelling or language), aliases, legacy canonical key, brand, variant,
--     size and class, over active AND inactive items. "Create anyway" is a
--     manager acknowledgement with a reason per candidate, audited.
--   * public.atlas_catalog_* commands (service_role only; the database
--     re-checks the actor profile): find_duplicates, create_item,
--     request_create, request_decide, request_withdraw, queue, my_requests,
--     propose_backfill
--   * public.atlas_recognition_* proposal commands that run as the NOLOGIN
--     recognition definer: they can only insert PENDING requests
--   * Item Master publication accepts the S89 attribute columns
--   * reactivation also refuses an active item with the same identity key
--
-- Owner defaults recorded in the design (S88 default, owner may change):
-- bartenders may propose new-product drafts, aliases, codes, metadata
-- corrections and wrong-match reports; viewers may report wrong matches; a
-- manager may self-approve (single-manager venue), always audited;
-- duplicate resolution never transfers stock; backfill of brand, product,
-- variant, class and unit size is proposed through this queue only.

create table if not exists atlas_private.catalog_change_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('alias','code','new_item','duplicate_resolution','metadata_correction',
    'wrong_match_report','code_conflict')),
  status text not null default 'pending' check (status in ('pending','approved','rejected','applied','failed','withdrawn','superseded')),
  subject_item_id uuid references public.inventory_items(id) on delete set null,
  related_item_ids uuid[] not null default '{}',
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 131072),
  duplicate_check jsonb,
  source text not null check (source in ('recognition','ai_proposal','manager','data_review','backfill','import')),
  ai_action_id uuid,
  recognition_request_id uuid references atlas_private.recognition_requests(id) on delete set null,
  media_id uuid references atlas_private.ai_media(id) on delete set null,
  requested_by uuid not null,
  requested_by_label text not null,
  requested_by_role text not null check (requested_by_role in ('admin','manager','bartender','viewer')),
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_by_label text,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 2000),
  self_approved boolean not null default false,
  applied_result jsonb,
  failure_message text,
  request_id text unique check (request_id is null or char_length(request_id) between 1 and 200),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  check (status = 'pending' or status = 'withdrawn' or decided_at is not null)
);
create index if not exists catalog_change_requests_queue_idx
  on atlas_private.catalog_change_requests (status, kind, requested_at desc);
create index if not exists catalog_change_requests_requester_idx
  on atlas_private.catalog_change_requests (requested_by, requested_at desc);
create index if not exists catalog_change_requests_subject_idx
  on atlas_private.catalog_change_requests (subject_item_id) where subject_item_id is not null;

create table if not exists atlas_private.catalog_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('request_created','request_approved','request_rejected','request_applied',
    'request_failed','request_withdrawn','item_created','alias_added','alias_retired','code_linked','code_retired',
    'duplicate_resolved','duplicates_distinct','metadata_corrected','wrong_match_reported','duplicate_acknowledged')),
  change_request_id uuid,
  item_id uuid,
  actor_id uuid,
  actor_label text,
  actor_role text,
  ai_assisted boolean not null default false,
  recognition_request_id uuid,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists catalog_events_request_idx on atlas_private.catalog_events (change_request_id, created_at);
create index if not exists catalog_events_item_idx on atlas_private.catalog_events (item_id, created_at desc);

create table if not exists atlas_private.catalog_distinct_pairs (
  item_a uuid not null references public.inventory_items(id) on delete cascade,
  item_b uuid not null references public.inventory_items(id) on delete cascade,
  decided_by uuid not null,
  decided_by_label text not null,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  change_request_id uuid,
  created_at timestamptz not null default now(),
  primary key (item_a, item_b),
  check (item_a < item_b)
);

-- Idempotency ledger for create_item (the par_level_requests pattern).
create table if not exists atlas_private.catalog_command_requests (
  request_id text primary key check (char_length(request_id) between 1 and 200),
  command text not null,
  actor_id uuid not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now()
);

do $s89_governance_tables$
declare
  table_name text;
begin
  foreach table_name in array array['catalog_change_requests','catalog_events','catalog_distinct_pairs','catalog_command_requests'] loop
    execute format('alter table atlas_private.%I enable row level security', table_name);
    execute format('revoke all on atlas_private.%I from public, anon, authenticated', table_name);
    execute format('grant all on atlas_private.%I to service_role', table_name);
    execute format('drop policy if exists %I on atlas_private.%I', table_name || '_service_only', table_name);
    execute format('create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',
      table_name || '_service_only', table_name);
  end loop;
end
$s89_governance_tables$;

-- The audit is append-only for everyone but the owner.
revoke update, delete, truncate on atlas_private.catalog_events from service_role;
create or replace function private.catalog_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'Catalog audit events cannot be changed or deleted' using errcode = '42501', hint = 'atlas:append_only';
end
$function$;
revoke all on function private.catalog_events_append_only() from public, anon, authenticated;
drop trigger if exists catalog_events_append_only on atlas_private.catalog_events;
create trigger catalog_events_append_only before update or delete on atlas_private.catalog_events
  for each row execute function private.catalog_events_append_only();

-- Requests inserted by the recognition definer are always pending and
-- undecided, whatever the caller sends. Invoker trigger: current_user is the
-- role that performs the insert.
create or replace function atlas_private.catalog_request_insert_guard()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if current_user = 'atlas_recognition_definer' or new.status = 'pending' then
    new.status := 'pending';
    new.decided_by := null;
    new.decided_by_label := null;
    new.decided_at := null;
    new.decision_note := null;
    new.self_approved := false;
    new.applied_result := null;
    new.failure_message := null;
    new.version := 1;
  end if;
  return new;
end
$function$;
drop trigger if exists catalog_change_requests_insert_guard on atlas_private.catalog_change_requests;
create trigger catalog_change_requests_insert_guard before insert on atlas_private.catalog_change_requests
  for each row execute function atlas_private.catalog_request_insert_guard();

-- ---------------------------------------------------------------------------
-- Actor gate and value validation
-- ---------------------------------------------------------------------------
create or replace function atlas_private.catalog_actor_role(p_actor_id uuid, p_allowed text[])
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  actor_role text;
begin
  select profile.role::text into actor_role from public.profiles profile
  where profile.id = p_actor_id and profile.active is true;
  if p_actor_id is null or actor_role is null or not actor_role = any(p_allowed) then
    raise exception 'This catalogue action is not available for your Atlas role'
      using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return actor_role;
end
$function$;

create or replace function atlas_private.catalog_invalid(p_message text)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
begin
  raise exception '%', p_message using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;

-- Item values accepted by create_item and metadata corrections. Returns the
-- cleaned object; unknown keys and bad values are refused.
create or replace function atlas_private.catalog_clean_values(p_values jsonb, p_require_name boolean)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  v jsonb := coalesce(p_values, '{}'::jsonb);
  cleaned jsonb := '{}'::jsonb;
  key text;
  text_keys text[] := array['name','category','subcategory','unit','brand','product_name','variant','item_class',
    'packaging_type','unit_size_base','package_size','bin_location','notes','supplier'];
  number_keys text[] := array['unit_size_quantity','size_ml','package_weight_g','units_per_case','abv_percent',
    'par_level','critical_minimum','cost_price','case_cost','discount_percent','minimum_order_quantity','lead_time_days'];
  value text;
  number_value numeric;
  max_length integer;
begin
  if jsonb_typeof(v) <> 'object' then perform atlas_private.catalog_invalid('Item values must be an object'); end if;
  for key in select jsonb_object_keys(v) loop
    if key = any(text_keys) then
      if jsonb_typeof(v->key) = 'null' then cleaned := cleaned || jsonb_build_object(key, null); continue; end if;
      if jsonb_typeof(v->key) <> 'string' then perform atlas_private.catalog_invalid(format('%s must be text', key)); end if;
      value := nullif(btrim(v->>key), '');
      max_length := case when key = 'notes' then 2000 when key = 'name' then 200 else 240 end;
      if value is not null and char_length(value) > max_length then
        perform atlas_private.catalog_invalid(format('%s is too long', key));
      end if;
      cleaned := cleaned || jsonb_build_object(key, value);
    elsif key = any(number_keys) then
      if jsonb_typeof(v->key) = 'null' or (jsonb_typeof(v->key) = 'string' and btrim(v->>key) = '') then
        cleaned := cleaned || jsonb_build_object(key, null); continue;
      end if;
      begin
        number_value := (v->>key)::numeric;
      exception when others then
        perform atlas_private.catalog_invalid(format('%s must be a number', key));
      end;
      if number_value < 0 then perform atlas_private.catalog_invalid(format('%s cannot be negative', key)); end if;
      if key in ('unit_size_quantity','size_ml','package_weight_g','units_per_case','minimum_order_quantity') and number_value <= 0 then
        perform atlas_private.catalog_invalid(format('%s must be greater than zero', key));
      end if;
      if key = 'abv_percent' and number_value > 100 then perform atlas_private.catalog_invalid('ABV must be between 0 and 100'); end if;
      if key = 'lead_time_days' and number_value <> trunc(number_value) then
        perform atlas_private.catalog_invalid('Lead time must be a whole number of days');
      end if;
      cleaned := cleaned || jsonb_build_object(key, number_value);
    elsif key = 'supplier_id' then
      if jsonb_typeof(v->key) = 'null' then cleaned := cleaned || jsonb_build_object(key, null); continue; end if;
      begin
        if not exists (select 1 from public.suppliers s where s.id = (v->>key)::uuid) then
          perform atlas_private.catalog_invalid('Select a supplier from the current supplier list');
        end if;
      exception when invalid_text_representation then
        perform atlas_private.catalog_invalid('Supplier is invalid');
      end;
      cleaned := cleaned || jsonb_build_object(key, (v->>key)::uuid);
    else
      perform atlas_private.catalog_invalid(format('Unsupported item field %s', key));
    end if;
  end loop;

  if p_require_name and nullif(cleaned->>'name', '') is null then
    perform atlas_private.catalog_invalid('A product name is required');
  end if;
  if cleaned ? 'item_class' and cleaned->>'item_class' is not null and cleaned->>'item_class' not in ('spirit','liqueur',
     'wine','sparkling','beer_cider','non_alcoholic','syrup','bar_ingredient','dairy_alt','coffee_tea','produce',
     'garnish','food','consumable','cleaning','equipment','gas','prep','reference') then
    perform atlas_private.catalog_invalid('Product type is not in the Atlas taxonomy');
  end if;
  if cleaned ? 'packaging_type' and cleaned->>'packaging_type' is not null and cleaned->>'packaging_type' not in ('bottle',
     'can','carton','keg','bag','box','case','jar','tub','pouch','sachet','tray','bundle','loose','cup','wrapped',
     'cylinder','tool','other') then
    perform atlas_private.catalog_invalid('Package type is not supported');
  end if;
  if (cleaned ? 'unit_size_quantity' or cleaned ? 'unit_size_base')
     and ((cleaned->>'unit_size_quantity' is null) <> (cleaned->>'unit_size_base' is null)
          or coalesce(cleaned->>'unit_size_base', 'ml') not in ('ml','g','count')) then
    perform atlas_private.catalog_invalid('Unit size needs a quantity and a unit (ml, g or count)');
  end if;
  if cleaned->>'unit_size_base' = 'ml' and cleaned->>'size_ml' is not null
     and (cleaned->>'size_ml')::numeric <> (cleaned->>'unit_size_quantity')::numeric then
    perform atlas_private.catalog_invalid('Unit size and bottle size disagree');
  end if;
  if cleaned->>'unit_size_base' = 'g' and cleaned->>'package_weight_g' is not null
     and (cleaned->>'package_weight_g')::numeric <> (cleaned->>'unit_size_quantity')::numeric then
    perform atlas_private.catalog_invalid('Unit size and package weight disagree');
  end if;
  return cleaned;
end
$function$;

-- ---------------------------------------------------------------------------
-- Duplicate guard
-- ---------------------------------------------------------------------------
-- Keys of every item, computed once per call (legacy columns included).
create or replace function atlas_private.catalog_item_duplicate_keys()
returns table (item_id uuid, name text, active boolean, category text, unit text, keys jsonb)
language sql
stable
set search_path = ''
as $function$
  with codes as materialized (
    select l.item_id, jsonb_agg(jsonb_build_object('kind', l.kind, 'normalized', l.code_normalized,
             'supplier_id', l.supplier_id)) as codes
    from atlas_private.inventory_code_lookup l
    where l.status = 'active'
    group by l.item_id
  )
  select i.id, i.name, i.active, i.category, i.unit,
    jsonb_build_object(
      'name_key', k.name_key,
      'match_key', d.match_key,
      'pack_key', coalesce(k.pack_key, '?'),
      'brand_key', d.brand_key,
      'item_class', coalesce(i.item_class, atlas_private.inventory_class_for_category(i.category, i.subcategory)),
      'legacy_key', d.legacy_key,
      'identity_key', k.identity_key,
      'codes', coalesce(c.codes, '[]'::jsonb),
      'alias_keys', to_jsonb(coalesce(d.alias_match_keys, '{}'::text[])))
  from public.inventory_items i
  left join atlas_private.inventory_identity_keys k on k.item_id = i.id
  left join atlas_private.inventory_search_documents d on d.item_id = i.id
  left join codes c on c.item_id = i.id;
$function$;

-- The mandatory duplicate check for a draft. Scores every item, active and
-- inactive; lists >= 0.30, requires a manager acknowledgement >= 0.60.
create or replace function atlas_private.catalog_find_duplicates_core(
  p_values jsonb, p_codes jsonb, p_aliases jsonb, p_exclude_item_id uuid, p_limit integer)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  thresholds jsonb := atlas_private.product_identity_constants()->'duplicate_thresholds';
  v jsonb := coalesce(p_values, '{}'::jsonb);
  draft jsonb;
  draft_class text;
  row_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  candidates jsonb;
  code_conflicts jsonb;
  alias_conflicts jsonb;
  identity_conflict jsonb;
  draft_identity text;
begin
  draft_class := coalesce(nullif(v->>'item_class', ''), atlas_private.inventory_class_for_category(v->>'category', v->>'subcategory'));
  draft := atlas_private.catalog_duplicate_keys(v || jsonb_build_object(
    'codes', coalesce(p_codes, '[]'::jsonb), 'aliases', coalesce(p_aliases, '[]'::jsonb)))
    || jsonb_build_object('item_class', draft_class);
  draft_identity := atlas_private.product_identity_key(v->>'brand', v->>'product_name', v->>'variant', v->>'name',
    nullif(v->>'unit_size_quantity', '')::numeric, v->>'unit_size_base', nullif(v->>'size_ml', '')::numeric,
    nullif(v->>'package_weight_g', '')::numeric, v->>'package_size', v->>'unit');

  with scored as (
    select k.item_id, k.name, k.active, k.category, k.unit, k.keys,
           atlas_private.catalog_duplicate_score(draft, k.keys) as result
    from atlas_private.catalog_item_duplicate_keys() k
    where p_exclude_item_id is null or k.item_id <> p_exclude_item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', s.item_id, 'name', s.name, 'active', s.active, 'category', s.category, 'unit', s.unit,
           'pack_key', s.keys->>'pack_key', 'score', (s.result->>'score')::numeric,
           'band', case when (s.result->>'score')::numeric >= (thresholds->>'strong')::numeric then 'strong'
                        when (s.result->>'score')::numeric >= (thresholds->>'possible')::numeric then 'possible'
                        else 'listed' end,
           'requires_ack', (s.result->>'score')::numeric >= (thresholds->>'possible')::numeric,
           'code_collision', (s.result->>'code_collision')::boolean,
           'evidence', s.result->'evidence')
         order by (s.result->>'score')::numeric desc, s.active desc, s.name), '[]'::jsonb)
  into candidates
  from (
    select * from scored
    where (result->>'score')::numeric >= (thresholds->>'listed')::numeric or (result->>'code_collision')::boolean
    order by (result->>'score')::numeric desc, active desc, name
    limit row_limit
  ) s;

  -- Codes another item already holds (never overridable).
  select coalesce(jsonb_agg(distinct jsonb_build_object('kind', l.kind, 'normalized', l.code_normalized,
           'item_id', l.item_id, 'origin', l.origin)), '[]'::jsonb)
  into code_conflicts
  from jsonb_array_elements(draft->'codes') c
  join atlas_private.inventory_code_lookup l
    on l.kind = c->>'kind' and l.code_normalized = c->>'normalized' and l.status = 'active'
   and (l.kind <> 'supplier_ref' or nullif(c->>'supplier_id', '') is null or l.supplier_id is null
        or l.supplier_id::text = c->>'supplier_id')
  where p_exclude_item_id is null or l.item_id <> p_exclude_item_id;

  -- Aliases that already name another item (approved alias or item name).
  select coalesce(jsonb_agg(distinct jsonb_build_object('alias', a.alias_text, 'item_id', x.item_id)), '[]'::jsonb)
  into alias_conflicts
  from (
    select case when jsonb_typeof(e) = 'string' then e #>> '{}' else e->>'alias' end as alias_text
    from jsonb_array_elements(case when jsonb_typeof(p_aliases) = 'array' then p_aliases else '[]'::jsonb end) e
  ) a
  cross join lateral (
    select atlas_private.product_name_key(null, null, null, a.alias_text) as key
  ) n
  join lateral (
    select ia.item_id from public.inventory_aliases ia
    where ia.item_id is not null and (ia.status is null or ia.status = 'approved')
      and atlas_private.product_name_key(null, null, null, ia.alias) = n.key
    union
    select k.item_id from atlas_private.inventory_identity_keys k where k.name_key = n.key and k.active
  ) x on true
  where n.key is not null and (p_exclude_item_id is null or x.item_id <> p_exclude_item_id);

  select jsonb_build_object('item_id', k.item_id, 'name', i.name) into identity_conflict
  from atlas_private.inventory_identity_keys k join public.inventory_items i on i.id = k.item_id
  where draft_identity is not null and k.identity_key = draft_identity and k.active
    and (p_exclude_item_id is null or k.item_id <> p_exclude_item_id)
  limit 1;

  return jsonb_build_object(
    'checked_at', now(),
    'version', atlas_private.product_identity_constants()->>'version',
    'draft_keys', draft,
    'thresholds', thresholds,
    'candidates', candidates,
    'requires_ack', coalesce((select jsonb_agg(c->'item_id') from jsonb_array_elements(candidates) c
                              where (c->>'requires_ack')::boolean), '[]'::jsonb),
    'code_conflicts', code_conflicts,
    'alias_conflicts', alias_conflicts,
    'identity_conflict', identity_conflict,
    'stock_changed', false);
end
$function$;

-- ---------------------------------------------------------------------------
-- Guarded item creation (the only create path; quantity always starts at 0)
-- ---------------------------------------------------------------------------
create or replace function atlas_private.catalog_media_retain(p_media_id uuid, p_reason text)
returns void
language sql
set search_path = ''
as $function$
  update atlas_private.ai_media
  set expires_at = case when p_reason is null then now() + interval '30 days' else null end,
      retention_reason = p_reason
  where id = p_media_id and purpose = 'recognition' and deleted_at is null;
$function$;

create or replace function atlas_private.catalog_insert_alias(
  p_item_id uuid, p_alias text, p_alias_kind text, p_language text, p_source text, p_change_request_id uuid,
  p_actor_id uuid, p_actor_label text, p_evidence jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  item_row public.inventory_items;
  clean_alias text := nullif(btrim(coalesce(p_alias, '')), '');
  kind text := coalesce(nullif(p_alias_kind, ''), 'product_name');
  key text;
  holder uuid;
  alias_row public.inventory_aliases;
begin
  select * into item_row from public.inventory_items where id = p_item_id;
  if not found then raise exception 'Inventory item not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if clean_alias is null or char_length(clean_alias) > 200 then
    perform atlas_private.catalog_invalid('An alias needs 1 to 200 characters');
  end if;
  if kind not in ('product_name','recipe_label','supplier_name','ocr_variant','legacy_name') then
    perform atlas_private.catalog_invalid('Alias type is not supported');
  end if;
  key := atlas_private.product_name_key(null, null, null, clean_alias);
  if key is null then perform atlas_private.catalog_invalid('An alias needs letters or digits'); end if;
  select x.item_id into holder from (
    select a.item_id from public.inventory_aliases a
    where a.item_id is not null and a.item_id <> p_item_id and (a.status is null or a.status = 'approved')
      and coalesce(a.alias_kind, 'legacy') <> 'recipe_label'
      and atlas_private.product_name_key(null, null, null, a.alias) = key
    union all
    select k.item_id from atlas_private.inventory_identity_keys k
    where k.item_id <> p_item_id and k.active and k.name_key = key
  ) x limit 1;
  if holder is not null and kind <> 'recipe_label' then
    raise exception 'This name already belongs to another inventory item'
      using errcode = '23505', hint = 'atlas:alias_conflict', detail = holder::text;
  end if;
  if exists (select 1 from public.inventory_aliases a where a.item_id = p_item_id
             and (a.status is null or a.status = 'approved')
             and atlas_private.product_name_key(null, null, null, a.alias) = key) then
    select * into alias_row from public.inventory_aliases a where a.item_id = p_item_id
      and (a.status is null or a.status = 'approved')
      and atlas_private.product_name_key(null, null, null, a.alias) = key limit 1;
    return jsonb_build_object('alias_id', alias_row.id, 'alias', alias_row.alias, 'existing', true);
  end if;
  insert into public.inventory_aliases (alias, canonical_key, item_id, source_note, created_by, alias_kind, status,
    source, language, created_by_label, approved_by, approved_by_label, approved_at, change_request_id, evidence)
  values (clean_alias, coalesce(nullif(item_row.canonical_key, ''), 'item:' || item_row.id), p_item_id,
    'S89 catalog approval', p_actor_id, kind, 'approved', p_source, nullif(p_language, ''), p_actor_label,
    p_actor_id, p_actor_label, now(), p_change_request_id, coalesce(p_evidence, '{}'::jsonb))
  returning * into alias_row;
  return jsonb_build_object('alias_id', alias_row.id, 'alias', alias_row.alias, 'alias_kind', kind, 'existing', false);
end
$function$;

create or replace function atlas_private.catalog_insert_code(
  p_item_id uuid, p_code jsonb, p_source text, p_change_request_id uuid, p_actor_id uuid, p_actor_label text)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  item_row public.inventory_items;
  kind text := nullif(p_code->>'kind', '');
  raw text := coalesce(p_code->>'code', p_code->>'raw', p_code->>'normalized');
  normalized jsonb;
  supplier uuid;
  code_row atlas_private.inventory_item_codes;
begin
  select * into item_row from public.inventory_items where id = p_item_id;
  if not found then raise exception 'Inventory item not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  normalized := atlas_private.product_code_normalize(kind, raw, p_code->>'symbology');
  if not (normalized->>'valid')::boolean then
    raise exception 'This code is not valid (%)', coalesce(normalized->>'reason', 'unknown')
      using errcode = '22023', hint = 'atlas:invalid_code';
  end if;
  begin
    supplier := coalesce(nullif(p_code->>'supplier_id', '')::uuid, case when normalized->>'kind' = 'supplier_ref' then item_row.supplier_id end);
  exception when invalid_text_representation then
    perform atlas_private.catalog_invalid('Supplier is invalid');
  end;
  if normalized->>'kind' = 'supplier_ref' and supplier is null then
    perform atlas_private.catalog_invalid('A supplier reference needs a supplier');
  end if;
  select * into code_row from atlas_private.inventory_item_codes c
  where c.item_id = p_item_id and c.kind = normalized->>'kind' and c.code_normalized = normalized->>'normalized'
    and c.status = 'active' and (c.kind <> 'supplier_ref' or c.supplier_id = supplier);
  if found then return jsonb_build_object('code_id', code_row.id, 'existing', true); end if;
  insert into atlas_private.inventory_item_codes (item_id, kind, code_raw, code_normalized, symbology, supplier_id,
    pack_level, units_in_pack, source, change_request_id, created_by, created_by_label)
  values (p_item_id, normalized->>'kind', btrim(raw), normalized->>'normalized', normalized->>'symbology',
    case when normalized->>'kind' = 'supplier_ref' then supplier end,
    coalesce(nullif(p_code->>'pack_level', ''), 'unit'), nullif(p_code->>'units_in_pack', '')::numeric,
    p_source, p_change_request_id, p_actor_id, p_actor_label)
  returning * into code_row;
  return jsonb_build_object('code_id', code_row.id, 'kind', code_row.kind, 'code_normalized', code_row.code_normalized,
    'pack_level', code_row.pack_level, 'existing', false);
end
$function$;

create or replace function atlas_private.catalog_create_item_core(
  p_values jsonb, p_codes jsonb, p_aliases jsonb, p_media_id uuid, p_duplicate_ack jsonb,
  p_change_request_id uuid, p_request_id text, p_actor_id uuid, p_actor_label text, p_source text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  actor_role text := atlas_private.catalog_actor_role(p_actor_id, array['admin','manager']);
  label text := coalesce(nullif(btrim(coalesce(p_actor_label, '')), ''), p_actor_id::text);
  clean_request text := nullif(btrim(coalesce(p_request_id, '')), '');
  existing atlas_private.catalog_command_requests;
  cleaned jsonb;
  checked jsonb;
  acks jsonb;
  missing jsonb;
  item_row public.inventory_items;
  code jsonb;
  alias jsonb;
  codes_out jsonb := '[]'::jsonb;
  aliases_out jsonb := '[]'::jsonb;
  inserted jsonb;
  result jsonb;
  code_source text := case when p_source = 'recognition' then 'recognition_confirmed' else 'manager' end;
  alias_source text := case p_source when 'recognition' then 'recognition' when 'ai_proposal' then 'ai_proposal'
                                     when 'import' then 'import' else 'manager' end;
begin
  if clean_request is null then perform atlas_private.catalog_invalid('A request id is required'); end if;
  select * into existing from atlas_private.catalog_command_requests where request_id = clean_request;
  if found then
    if existing.actor_id <> p_actor_id or existing.command <> 'create_item' then
      raise exception 'This request id was used for another command' using errcode = '42501', hint = 'atlas:forbidden';
    end if;
    return existing.result || jsonb_build_object('replayed', true);
  end if;
  if jsonb_typeof(coalesce(p_codes, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_codes, '[]'::jsonb)) > 20 then
    perform atlas_private.catalog_invalid('Codes must be a list of up to 20');
  end if;
  if jsonb_typeof(coalesce(p_aliases, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_aliases, '[]'::jsonb)) > 20 then
    perform atlas_private.catalog_invalid('Aliases must be a list of up to 20');
  end if;
  cleaned := atlas_private.catalog_clean_values(p_values, true);

  -- Legacy form fields: sku and barcode become codes, never raw columns.
  checked := atlas_private.catalog_find_duplicates_core(cleaned, coalesce(p_codes, '[]'::jsonb),
    coalesce(p_aliases, '[]'::jsonb), null, 25);
  if checked->'identity_conflict' is not null and jsonb_typeof(checked->'identity_conflict') = 'object' then
    raise exception 'An active item with the same name and package already exists'
      using errcode = '23505', hint = 'atlas:duplicate_identity', detail = checked::text;
  end if;
  if jsonb_array_length(checked->'code_conflicts') > 0 then
    raise exception 'A barcode, SKU or supplier reference already belongs to another item'
      using errcode = '23505', hint = 'atlas:code_conflict', detail = checked::text;
  end if;
  if jsonb_array_length(checked->'alias_conflicts') > 0 then
    raise exception 'An alias already names another item'
      using errcode = '23505', hint = 'atlas:alias_conflict', detail = checked::text;
  end if;

  acks := case jsonb_typeof(p_duplicate_ack)
            when 'array' then p_duplicate_ack
            when 'object' then case when jsonb_typeof(p_duplicate_ack->'acknowledged') = 'array'
                                    then p_duplicate_ack->'acknowledged' else '[]'::jsonb end
            else '[]'::jsonb end;
  select coalesce(jsonb_agg(required), '[]'::jsonb) into missing
  from jsonb_array_elements(checked->'requires_ack') required
  where not exists (
    select 1 from jsonb_array_elements(acks) ack
    where ack->>'item_id' = required #>> '{}' and char_length(btrim(coalesce(ack->>'reason', ''))) >= 3);
  if jsonb_array_length(missing) > 0 then
    raise exception 'Possible existing matches found. Use an existing item or confirm each one is different.'
      using errcode = 'P0001', hint = 'atlas:duplicate_suspected', detail = checked::text;
  end if;

  perform set_config('atlas.catalog_command', 'create_item', true);
  insert into public.inventory_items (
    name, category, subcategory, unit, brand, product_name, variant, item_class, packaging_type,
    unit_size_quantity, unit_size_base, size_ml, package_weight_g, package_size, units_per_case, abv_percent,
    par_level, critical_minimum, cost_price, case_cost, discount_percent, minimum_order_quantity, lead_time_days,
    bin_location, notes, supplier_id, supplier, quantity, active, attributes_source, updated_by)
  values (
    cleaned->>'name', coalesce(cleaned->>'category', 'other'), cleaned->>'subcategory', coalesce(cleaned->>'unit', 'bottles'),
    cleaned->>'brand', cleaned->>'product_name', cleaned->>'variant', cleaned->>'item_class', cleaned->>'packaging_type',
    (cleaned->>'unit_size_quantity')::numeric, cleaned->>'unit_size_base',
    coalesce((cleaned->>'size_ml')::numeric, case when cleaned->>'unit_size_base' = 'ml' then (cleaned->>'unit_size_quantity')::numeric end),
    coalesce((cleaned->>'package_weight_g')::numeric, case when cleaned->>'unit_size_base' = 'g' then (cleaned->>'unit_size_quantity')::numeric end),
    cleaned->>'package_size', (cleaned->>'units_per_case')::numeric, (cleaned->>'abv_percent')::numeric,
    (cleaned->>'par_level')::numeric, (cleaned->>'critical_minimum')::numeric, (cleaned->>'cost_price')::numeric,
    (cleaned->>'case_cost')::numeric, coalesce((cleaned->>'discount_percent')::numeric, 0),
    (cleaned->>'minimum_order_quantity')::numeric, (cleaned->>'lead_time_days')::integer,
    cleaned->>'bin_location', cleaned->>'notes', (cleaned->>'supplier_id')::uuid,
    coalesce(cleaned->>'supplier', (select s.name from public.suppliers s where s.id = (cleaned->>'supplier_id')::uuid)),
    0, true,
    (select coalesce(jsonb_object_agg(key, jsonb_build_object('source', p_source, 'change_request_id', p_change_request_id,
              'approved_by', p_actor_id)), '{}'::jsonb)
     from jsonb_object_keys(cleaned) key
     where key in ('brand','product_name','variant','item_class','packaging_type','unit_size_quantity','unit_size_base','abv_percent')),
    p_actor_id::text)
  returning * into item_row;

  for code in select value from jsonb_array_elements(coalesce(p_codes, '[]'::jsonb)) loop
    inserted := atlas_private.catalog_insert_code(item_row.id, code, code_source, p_change_request_id, p_actor_id, label);
    codes_out := codes_out || inserted;
    insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
    values ('code_linked', p_change_request_id, item_row.id, p_actor_id, label, actor_role, inserted);
  end loop;
  for alias in select value from jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) loop
    inserted := atlas_private.catalog_insert_alias(item_row.id,
      case when jsonb_typeof(alias) = 'string' then alias #>> '{}' else alias->>'alias' end,
      case when jsonb_typeof(alias) = 'object' then alias->>'alias_kind' end,
      case when jsonb_typeof(alias) = 'object' then alias->>'language' end,
      alias_source, p_change_request_id, p_actor_id, label, null);
    aliases_out := aliases_out || inserted;
    insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
    values ('alias_added', p_change_request_id, item_row.id, p_actor_id, label, actor_role, inserted);
  end loop;
  if p_media_id is not null then perform atlas_private.catalog_media_retain(p_media_id, 'approved_change'); end if;

  insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role,
    ai_assisted, payload)
  values ('item_created', p_change_request_id, item_row.id, p_actor_id, label, actor_role, p_source in ('recognition','ai_proposal'),
    jsonb_build_object('values', cleaned, 'source', p_source, 'quantity', 0, 'media_id', p_media_id,
      'duplicate_candidates', checked->'candidates', 'acknowledged', acks));
  if jsonb_array_length(acks) > 0 then
    insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
    values ('duplicate_acknowledged', p_change_request_id, item_row.id, p_actor_id, label, actor_role,
      jsonb_build_object('acknowledged', acks, 'required', checked->'requires_ack'));
  end if;

  result := jsonb_build_object(
    'item_id', item_row.id,
    'item', jsonb_build_object('id', item_row.id, 'name', item_row.name, 'category', item_row.category, 'unit', item_row.unit,
      'brand', item_row.brand, 'product_name', item_row.product_name, 'variant', item_row.variant,
      'item_class', item_row.item_class, 'packaging_type', item_row.packaging_type,
      'unit_size_quantity', item_row.unit_size_quantity, 'unit_size_base', item_row.unit_size_base,
      'size_ml', item_row.size_ml, 'package_weight_g', item_row.package_weight_g, 'package_size', item_row.package_size,
      'units_per_case', item_row.units_per_case, 'active', item_row.active, 'quantity', item_row.quantity,
      'updated_at', item_row.updated_at),
    'codes', codes_out,
    'aliases', aliases_out,
    'duplicate_check', checked,
    'acknowledged', acks,
    'change_request_id', p_change_request_id,
    'request_id', clean_request,
    'quantity_status', 'not_counted',
    'stock_changed', false);
  insert into atlas_private.catalog_command_requests (request_id, command, actor_id, result)
  values (clean_request, 'create_item', p_actor_id, result);
  return result;
end
$function$;

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------
create or replace function atlas_private.catalog_request_json(p_request atlas_private.catalog_change_requests)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select to_jsonb(p_request)
    || jsonb_build_object(
      'subject_item', (select jsonb_build_object('id', i.id, 'name', i.name, 'active', i.active, 'category', i.category)
                       from public.inventory_items i where i.id = p_request.subject_item_id),
      'related_items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'active', i.active))
                                 from public.inventory_items i where i.id = any(p_request.related_item_ids)), '[]'::jsonb));
$function$;

-- Validates a proposal and inserts it as pending. Runs as the caller: the
-- service role (manager tools) or the recognition definer (staff proposals).
create or replace function atlas_private.catalog_request_insert(
  p_kind text, p_subject_item_id uuid, p_payload jsonb, p_evidence jsonb, p_source text, p_ai_action_id uuid,
  p_recognition_request_id uuid, p_media_id uuid, p_request_id text,
  p_actor_id uuid, p_actor_label text)
returns atlas_private.catalog_change_requests
language plpgsql
volatile
set search_path = ''
as $function$
declare
  actor_role text := atlas_private.catalog_actor_role(p_actor_id, array['admin','manager','bartender','viewer']);
  label text := coalesce(nullif(btrim(coalesce(p_actor_label, '')), ''), p_actor_id::text);
  payload jsonb := coalesce(p_payload, '{}'::jsonb);
  subject uuid := p_subject_item_id;
  related uuid[] := '{}';
  dup jsonb;
  normalized jsonb;
  existing atlas_private.catalog_change_requests;
  request_row atlas_private.catalog_change_requests;
  clean_request text := nullif(btrim(coalesce(p_request_id, '')), '');
begin
  if clean_request is not null then
    select * into existing from atlas_private.catalog_change_requests where request_id = clean_request;
    if found then
      if existing.requested_by <> p_actor_id then
        raise exception 'This request id belongs to another person' using errcode = '42501', hint = 'atlas:forbidden';
      end if;
      return existing;
    end if;
  end if;
  if jsonb_typeof(payload) <> 'object' then perform atlas_private.catalog_invalid('Payload must be an object'); end if;
  if p_kind not in ('alias','code','new_item','duplicate_resolution','metadata_correction','wrong_match_report','code_conflict') then
    perform atlas_private.catalog_invalid('Unknown catalogue request type');
  end if;
  if actor_role = 'viewer' and p_kind <> 'wrong_match_report' then
    raise exception 'Viewers can report a wrong match only' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  if actor_role = 'bartender' and p_kind in ('duplicate_resolution','code_conflict') then
    raise exception 'Duplicate resolution is limited to managers' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  begin
    if subject is null and nullif(payload->>'item_id', '') is not null then subject := (payload->>'item_id')::uuid; end if;
  exception when invalid_text_representation then
    perform atlas_private.catalog_invalid('Item id is invalid');
  end;
  if subject is not null and not exists (select 1 from public.inventory_items i where i.id = subject) then
    raise exception 'Inventory item not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;

  if p_kind = 'alias' then
    if subject is null then perform atlas_private.catalog_invalid('Choose the item this name belongs to'); end if;
    if atlas_private.product_name_key(null, null, null, payload->>'alias') is null or char_length(coalesce(payload->>'alias', '')) > 200 then
      perform atlas_private.catalog_invalid('An alias needs 1 to 200 characters');
    end if;
    if coalesce(payload->>'alias_kind', 'product_name') not in ('product_name','recipe_label','supplier_name','ocr_variant','legacy_name') then
      perform atlas_private.catalog_invalid('Alias type is not supported');
    end if;
  elsif p_kind = 'code' then
    if subject is null then perform atlas_private.catalog_invalid('Choose the item this code belongs to'); end if;
    normalized := atlas_private.product_code_normalize(payload->>'kind', coalesce(payload->>'code', payload->>'raw'), payload->>'symbology');
    if not (normalized->>'valid')::boolean then
      raise exception 'This code is not valid (%)', coalesce(normalized->>'reason', 'unknown')
        using errcode = '22023', hint = 'atlas:invalid_code';
    end if;
    payload := payload || jsonb_build_object('kind', normalized->>'kind', 'normalized', normalized->>'normalized');
  elsif p_kind = 'new_item' then
    perform atlas_private.catalog_clean_values(payload->'values', true);
    dup := atlas_private.catalog_find_duplicates_core(payload->'values', coalesce(payload->'codes', '[]'::jsonb),
      coalesce(payload->'aliases', '[]'::jsonb), null, 25);
    select coalesce(array_agg((c->>'item_id')::uuid), '{}') into related
    from jsonb_array_elements(dup->'candidates') c where (c->>'requires_ack')::boolean;
  elsif p_kind = 'metadata_correction' then
    if subject is null then perform atlas_private.catalog_invalid('Choose the item to correct'); end if;
    if jsonb_typeof(payload->'values') <> 'object' or payload->'values' = '{}'::jsonb then
      perform atlas_private.catalog_invalid('Say which details to change');
    end if;
    perform atlas_private.catalog_clean_values(payload->'values', false);
    if (payload->'values') ? 'name' and nullif(btrim(coalesce(payload->'values'->>'name', '')), '') is null then
      perform atlas_private.catalog_invalid('A product name cannot be empty');
    end if;
  elsif p_kind = 'duplicate_resolution' then
    begin
      subject := (payload->>'keep_item_id')::uuid;
      related := array[(payload->>'retire_item_id')::uuid];
    exception when invalid_text_representation then
      perform atlas_private.catalog_invalid('Duplicate item ids are invalid');
    end;
    if subject is null or related[1] is null or subject = related[1] then
      perform atlas_private.catalog_invalid('Choose the item to keep and the duplicate');
    end if;
    if (select count(*) from public.inventory_items i where i.id in (subject, related[1])) <> 2 then
      raise exception 'Inventory item not found' using errcode = 'P0002', hint = 'atlas:not_found';
    end if;
  elsif p_kind in ('wrong_match_report', 'code_conflict') then
    if subject is null and p_recognition_request_id is null then
      perform atlas_private.catalog_invalid('Say which item or scan was wrong');
    end if;
    if char_length(coalesce(payload->>'note', '')) > 2000 then perform atlas_private.catalog_invalid('Note is too long'); end if;
    begin
      if nullif(payload->>'suggested_item_id', '') is not null then related := array[(payload->>'suggested_item_id')::uuid]; end if;
    exception when invalid_text_representation then
      perform atlas_private.catalog_invalid('Suggested item id is invalid');
    end;
  end if;

  if p_media_id is not null and not exists (
    select 1 from atlas_private.ai_media m where m.id = p_media_id and m.deleted_at is null
      and (m.user_id = p_actor_id or actor_role in ('admin','manager'))) then
    raise exception 'Image not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;

  insert into atlas_private.catalog_change_requests (kind, status, subject_item_id, related_item_ids, payload, evidence,
    duplicate_check, source, ai_action_id, recognition_request_id, media_id, requested_by, requested_by_label,
    requested_by_role, request_id)
  values (p_kind, 'pending', subject, coalesce(related, '{}'), payload, coalesce(p_evidence, '{}'::jsonb), dup,
    p_source, p_ai_action_id, p_recognition_request_id, p_media_id, p_actor_id, label, actor_role, clean_request)
  returning * into request_row;

  insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role,
    ai_assisted, recognition_request_id, payload)
  values (case when p_kind = 'wrong_match_report' then 'wrong_match_reported' else 'request_created' end,
    request_row.id, subject, p_actor_id, label, actor_role, p_source in ('recognition','ai_proposal'),
    p_recognition_request_id, jsonb_build_object('kind', p_kind, 'source', p_source));

  if p_media_id is not null then
    -- Held while the request is open (owner retention rule).
    update atlas_private.ai_media set expires_at = null,
      retention_reason = case when p_kind = 'wrong_match_report' then 'disputed_match' else 'pending_review' end
    where id = p_media_id and purpose = 'recognition' and deleted_at is null;
  end if;
  return request_row;
end
$function$;

-- Metadata corrections apply to the S89 attribute columns and the plain
-- catalogue fields. Quantity is never a correctable field.
create or replace function atlas_private.catalog_apply_metadata(
  p_item_id uuid, p_values jsonb, p_expected jsonb, p_request atlas_private.catalog_change_requests,
  p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  cleaned jsonb := atlas_private.catalog_clean_values(p_values, false);
  item_row public.inventory_items;
  current_values jsonb;
  key text;
begin
  select * into item_row from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'Inventory item not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  current_values := to_jsonb(item_row);
  if jsonb_typeof(p_expected) = 'object' then
    for key in select jsonb_object_keys(p_expected) loop
      if (current_values->key) is distinct from (p_expected->key)
         and not (jsonb_typeof(current_values->key) = 'number' and jsonb_typeof(p_expected->key) = 'number'
                  and (current_values->>key)::numeric = (p_expected->>key)::numeric) then
        raise exception 'This item changed after the request was made. Review it again.'
          using errcode = '40001', hint = 'atlas:stale_item';
      end if;
    end loop;
  end if;
  update public.inventory_items set
    name = case when cleaned ? 'name' then cleaned->>'name' else name end,
    category = case when cleaned ? 'category' then coalesce(cleaned->>'category', 'other') else category end,
    subcategory = case when cleaned ? 'subcategory' then cleaned->>'subcategory' else subcategory end,
    unit = case when cleaned ? 'unit' then coalesce(cleaned->>'unit', unit) else unit end,
    brand = case when cleaned ? 'brand' then cleaned->>'brand' else brand end,
    product_name = case when cleaned ? 'product_name' then cleaned->>'product_name' else product_name end,
    variant = case when cleaned ? 'variant' then cleaned->>'variant' else variant end,
    item_class = case when cleaned ? 'item_class' then cleaned->>'item_class' else item_class end,
    packaging_type = case when cleaned ? 'packaging_type' then cleaned->>'packaging_type' else packaging_type end,
    unit_size_quantity = case when cleaned ? 'unit_size_quantity' then (cleaned->>'unit_size_quantity')::numeric else unit_size_quantity end,
    unit_size_base = case when cleaned ? 'unit_size_base' then cleaned->>'unit_size_base' else unit_size_base end,
    size_ml = case when cleaned ? 'size_ml' then (cleaned->>'size_ml')::numeric else size_ml end,
    package_weight_g = case when cleaned ? 'package_weight_g' then (cleaned->>'package_weight_g')::numeric else package_weight_g end,
    package_size = case when cleaned ? 'package_size' then cleaned->>'package_size' else package_size end,
    units_per_case = case when cleaned ? 'units_per_case' then (cleaned->>'units_per_case')::numeric else units_per_case end,
    abv_percent = case when cleaned ? 'abv_percent' then (cleaned->>'abv_percent')::numeric else abv_percent end,
    supplier_id = case when cleaned ? 'supplier_id' then (cleaned->>'supplier_id')::uuid else supplier_id end,
    supplier = case when cleaned ? 'supplier_id' then (select s.name from public.suppliers s where s.id = (cleaned->>'supplier_id')::uuid)
                    when cleaned ? 'supplier' then cleaned->>'supplier' else supplier end,
    par_level = case when cleaned ? 'par_level' then (cleaned->>'par_level')::numeric else par_level end,
    critical_minimum = case when cleaned ? 'critical_minimum' then (cleaned->>'critical_minimum')::numeric else critical_minimum end,
    cost_price = case when cleaned ? 'cost_price' then (cleaned->>'cost_price')::numeric else cost_price end,
    case_cost = case when cleaned ? 'case_cost' then (cleaned->>'case_cost')::numeric else case_cost end,
    bin_location = case when cleaned ? 'bin_location' then cleaned->>'bin_location' else bin_location end,
    notes = case when cleaned ? 'notes' then cleaned->>'notes' else notes end,
    attributes_source = coalesce(attributes_source, '{}'::jsonb) || (
      select coalesce(jsonb_object_agg(k, jsonb_build_object('source', p_request.source, 'change_request_id', p_request.id,
               'approved_by', p_actor_id, 'approved_at', now())), '{}'::jsonb)
      from jsonb_object_keys(cleaned) k),
    updated_by = p_actor_id::text
  where id = p_item_id
  returning * into item_row;
  insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role,
    ai_assisted, payload)
  values ('metadata_corrected', p_request.id, p_item_id, p_actor_id, p_actor_label, p_actor_role,
    p_request.source in ('recognition','ai_proposal'),
    jsonb_build_object('values', cleaned, 'before', (select jsonb_object_agg(k, current_values->k) from jsonb_object_keys(cleaned) k)));
  return jsonb_build_object('item_id', p_item_id, 'values', cleaned, 'updated_at', item_row.updated_at, 'quantity_mutated', false);
end
$function$;

-- Duplicate resolution. Never moves stock: movements and count history stay
-- on the retired item for audit.
create or replace function atlas_private.catalog_apply_duplicate_resolution(
  p_request atlas_private.catalog_change_requests, p_resolution jsonb,
  p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  keep_id uuid := p_request.subject_item_id;
  retire_id uuid := p_request.related_item_ids[1];
  mode text := coalesce(nullif(p_resolution->>'mode', ''), nullif(p_request.payload->>'mode', ''), 'retire_into');
  reason text := coalesce(nullif(btrim(coalesce(p_resolution->>'reason', '')), ''), nullif(btrim(coalesce(p_request.payload->>'reason', '')), ''));
  keep_row public.inventory_items;
  retire_row public.inventory_items;
  moved jsonb := '[]'::jsonb;
  code_row atlas_private.inventory_item_codes;
  relinked uuid[];
  ingredient_ids uuid[];
  alias_result jsonb;
  pair_a uuid;
  pair_b uuid;
begin
  if keep_id is null or retire_id is null then perform atlas_private.catalog_invalid('Both items are required'); end if;
  select * into keep_row from public.inventory_items where id = keep_id for update;
  select * into retire_row from public.inventory_items where id = retire_id for update;
  if keep_row.id is null or retire_row.id is null then
    raise exception 'Inventory item not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;

  if mode = 'not_duplicates' then
    pair_a := least(keep_id, retire_id);
    pair_b := greatest(keep_id, retire_id);
    insert into atlas_private.catalog_distinct_pairs (item_a, item_b, decided_by, decided_by_label, reason, change_request_id)
    values (pair_a, pair_b, p_actor_id, p_actor_label, coalesce(reason, 'Marked not duplicates'), p_request.id)
    on conflict (item_a, item_b) do nothing;
    insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
    values ('duplicates_distinct', p_request.id, keep_id, p_actor_id, p_actor_label, p_actor_role,
      jsonb_build_object('item_a', pair_a, 'item_b', pair_b, 'reason', reason));
    return jsonb_build_object('mode', mode, 'item_a', pair_a, 'item_b', pair_b, 'quantity_mutated', false);
  end if;

  if mode = 'different_pack' then
    return jsonb_build_object('mode', mode) || atlas_private.catalog_apply_metadata(retire_id,
      coalesce(p_resolution->'values', p_request.payload->'values', '{}'::jsonb), null, p_request,
      p_actor_id, p_actor_label, p_actor_role);
  end if;

  if mode <> 'retire_into' then perform atlas_private.catalog_invalid('Unknown duplicate resolution'); end if;
  if not keep_row.active then
    perform atlas_private.catalog_invalid('The item to keep must be active');
  end if;
  -- Preconditions (enforced here, not in the UI).
  if exists (
    select 1 from public.purchase_orders po
    where po.status not in ('received', 'cancelled', 'closed', 'rejected')
      and exists (select 1 from jsonb_array_elements(po.lines) line where line->>'item_id' = retire_id::text)) then
    raise exception 'The duplicate is on an open purchase order. Receive or edit the order first.'
      using errcode = '55000', hint = 'atlas:open_purchase_order';
  end if;
  if exists (
    select 1 from atlas_private.inventory_count_lines line
    join atlas_private.inventory_count_sessions session on session.id = line.session_id
    where line.inventory_item_id = retire_id and line.line_status = 'counted'
      and session.status in ('draft', 'submitted')) then
    raise exception 'The duplicate has unverified count lines. Finish or cancel that count first.'
      using errcode = '55000', hint = 'atlas:open_count';
  end if;
  if exists (
    select 1 from atlas_private.inventory_verified_balances balance
    where balance.inventory_item_id = retire_id and balance.verification_status = 'current'
      and balance.expires_at > now() and coalesce(balance.verified_quantity, 0) > 0) then
    raise exception 'Count the duplicate to zero or move its stock first.'
      using errcode = '55000', hint = 'atlas:stock_on_duplicate';
  end if;

  -- 1. Codes held in the codes table move; legacy column codes stay on the
  --    retired item (read-only history) and are listed in the result.
  for code_row in select * from atlas_private.inventory_item_codes where item_id = retire_id and status = 'active' loop
    update atlas_private.inventory_item_codes set status = 'retired', retired_at = now(), retired_by = p_actor_id,
      retired_reason = 'Merged into ' || keep_row.name where id = code_row.id;
    insert into atlas_private.inventory_item_codes (item_id, kind, code_raw, code_normalized, symbology, supplier_id,
      pack_level, units_in_pack, source, change_request_id, created_by, created_by_label)
    values (keep_id, code_row.kind, code_row.code_raw, code_row.code_normalized, code_row.symbology, code_row.supplier_id,
      code_row.pack_level, code_row.units_in_pack, 'duplicate_resolution', p_request.id, p_actor_id, p_actor_label);
    moved := moved || jsonb_build_object('kind', code_row.kind, 'code_normalized', code_row.code_normalized);
    insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
    values ('code_retired', p_request.id, retire_id, p_actor_id, p_actor_label, p_actor_role, jsonb_build_object('code_id', code_row.id)),
           ('code_linked', p_request.id, keep_id, p_actor_id, p_actor_label, p_actor_role,
            jsonb_build_object('kind', code_row.kind, 'code_normalized', code_row.code_normalized, 'from_item_id', retire_id));
  end loop;

  -- 3. Recipe links move only for the ticked ingredient rows (all by default).
  if jsonb_typeof(p_resolution->'recipe_ingredient_ids') = 'array' then
    select coalesce(array_agg(value::uuid), '{}') into ingredient_ids
    from jsonb_array_elements_text(p_resolution->'recipe_ingredient_ids');
  else
    select coalesce(array_agg(ri.id), '{}') into ingredient_ids from public.recipe_ingredients ri where ri.item_id = retire_id;
  end if;
  update public.recipe_ingredients set item_id = keep_id
  where item_id = retire_id and id = any(ingredient_ids);
  select coalesce(array_agg(ri.id), '{}') into relinked from public.recipe_ingredients ri
  where ri.item_id = keep_id and ri.id = any(ingredient_ids);

  -- 4. Deactivate through the S88 audited activation command.
  perform atlas_private.set_inventory_item_active(retire_id, false, 'Merged into ' || keep_row.name, null, p_actor_id, p_actor_label);

  -- 5. The duplicate's name becomes a legacy alias of the kept item once the
  --    duplicate is inactive (skipped when the names already agree or the
  --    name is still an approved alias elsewhere; the result says so).
  if atlas_private.product_name_key(null, null, null, retire_row.name) is distinct from
     atlas_private.product_name_key(keep_row.brand, keep_row.product_name, keep_row.variant, keep_row.name) then
    begin
      alias_result := atlas_private.catalog_insert_alias(keep_id, retire_row.name, 'legacy_name', null, 'duplicate_resolution',
        p_request.id, p_actor_id, p_actor_label, jsonb_build_object('merged_item_id', retire_id));
    exception when unique_violation then
      alias_result := jsonb_build_object('skipped', 'This name is still an approved alias of another item');
    end;
  end if;

  insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
  values ('duplicate_resolved', p_request.id, keep_id, p_actor_id, p_actor_label, p_actor_role,
    jsonb_build_object('kept_item_id', keep_id, 'retired_item_id', retire_id, 'codes_moved', moved,
      'alias', alias_result, 'recipe_ingredients_relinked', to_jsonb(relinked), 'quantity_transferred', false));
  return jsonb_build_object('mode', mode, 'kept_item_id', keep_id, 'retired_item_id', retire_id, 'codes_moved', moved,
    'alias', alias_result, 'recipe_ingredients_relinked', to_jsonb(relinked), 'quantity_mutated', false,
    'quantity_transferred', false);
end
$function$;

create or replace function atlas_private.catalog_request_decide(
  p_id uuid, p_decision text, p_note text, p_expected_version integer, p_resolution jsonb,
  p_actor_id uuid, p_actor_label text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  actor_role text := atlas_private.catalog_actor_role(p_actor_id, array['admin','manager']);
  label text := coalesce(nullif(btrim(coalesce(p_actor_label, '')), ''), p_actor_id::text);
  request_row atlas_private.catalog_change_requests;
  resolution jsonb := coalesce(p_resolution, '{}'::jsonb);
  applied jsonb;
  failure text;
  failure_hint text;
  code_row atlas_private.inventory_item_codes;
  retired jsonb := '[]'::jsonb;
  id_text text;
begin
  if p_decision not in ('approve', 'reject') then perform atlas_private.catalog_invalid('Decision must be approve or reject'); end if;
  if char_length(coalesce(p_note, '')) > 2000 then perform atlas_private.catalog_invalid('Note is limited to 2000 characters'); end if;
  select * into request_row from atlas_private.catalog_change_requests where id = p_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if request_row.status <> 'pending' then
    raise exception 'This request was already decided' using errcode = '40001', hint = 'atlas:stale_request';
  end if;
  if p_expected_version is not null and request_row.version <> p_expected_version then
    raise exception 'This request changed. Refresh before deciding.' using errcode = '40001', hint = 'atlas:stale_request';
  end if;

  if p_decision = 'reject' then
    update atlas_private.catalog_change_requests set status = 'rejected', decided_by = p_actor_id, decided_by_label = label,
      decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), ''), self_approved = requested_by = p_actor_id,
      version = version + 1, updated_at = now()
    where id = p_id returning * into request_row;
    insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
    values ('request_rejected', p_id, request_row.subject_item_id, p_actor_id, label, actor_role,
      jsonb_build_object('kind', request_row.kind, 'note', request_row.decision_note));
    if request_row.media_id is not null and request_row.kind <> 'wrong_match_report' then
      perform atlas_private.catalog_media_retain(request_row.media_id, null);
    end if;
    return atlas_private.catalog_request_json(request_row);
  end if;

  update atlas_private.catalog_change_requests set status = 'approved', decided_by = p_actor_id, decided_by_label = label,
    decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), ''), self_approved = requested_by = p_actor_id,
    version = version + 1, updated_at = now()
  where id = p_id returning * into request_row;
  insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, ai_assisted, payload)
  values ('request_approved', p_id, request_row.subject_item_id, p_actor_id, label, actor_role,
    request_row.source in ('recognition','ai_proposal'),
    jsonb_build_object('kind', request_row.kind, 'self_approved', request_row.self_approved, 'resolution', resolution));

  begin
    if request_row.kind = 'alias' then
      applied := atlas_private.catalog_insert_alias(request_row.subject_item_id, request_row.payload->>'alias',
        request_row.payload->>'alias_kind', request_row.payload->>'language',
        case request_row.source when 'recognition' then 'recognition' when 'ai_proposal' then 'ai_proposal' else 'manager' end,
        p_id, p_actor_id, label, request_row.evidence);
      insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
      values ('alias_added', p_id, request_row.subject_item_id, p_actor_id, label, actor_role, applied);
    elsif request_row.kind = 'code' then
      applied := atlas_private.catalog_insert_code(request_row.subject_item_id, request_row.payload,
        case when request_row.source = 'recognition' then 'recognition_confirmed' else 'manager' end, p_id, p_actor_id, label);
      insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
      values ('code_linked', p_id, request_row.subject_item_id, p_actor_id, label, actor_role, applied);
    elsif request_row.kind = 'new_item' then
      applied := atlas_private.catalog_create_item_core(
        coalesce(resolution->'values', request_row.payload->'values'),
        coalesce(resolution->'codes', request_row.payload->'codes', '[]'::jsonb),
        coalesce(resolution->'aliases', request_row.payload->'aliases', '[]'::jsonb),
        request_row.media_id, resolution->'duplicate_ack', p_id, 'catalog-request:' || p_id::text,
        p_actor_id, label, request_row.source);
      update atlas_private.catalog_change_requests set subject_item_id = (applied->>'item_id')::uuid where id = p_id;
    elsif request_row.kind = 'metadata_correction' then
      applied := atlas_private.catalog_apply_metadata(request_row.subject_item_id,
        coalesce(resolution->'values', request_row.payload->'values'), request_row.payload->'expected',
        request_row, p_actor_id, label, actor_role);
    elsif request_row.kind = 'duplicate_resolution' then
      applied := atlas_private.catalog_apply_duplicate_resolution(request_row, resolution, p_actor_id, label, actor_role);
    else
      -- wrong_match_report / code_conflict: acknowledge, optionally retiring
      -- the code or alias that caused the wrong match.
      for id_text in select jsonb_array_elements_text(coalesce(resolution->'retire_code_ids', '[]'::jsonb)) loop
        update atlas_private.inventory_item_codes set status = 'retired', retired_at = now(), retired_by = p_actor_id,
          retired_reason = 'Wrong match report ' || p_id
        where id = id_text::uuid and status = 'active' returning * into code_row;
        if code_row.id is not null then
          retired := retired || jsonb_build_object('code_id', code_row.id);
          insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
          values ('code_retired', p_id, code_row.item_id, p_actor_id, label, actor_role, jsonb_build_object('code_id', code_row.id));
        end if;
      end loop;
      for id_text in select jsonb_array_elements_text(coalesce(resolution->'retire_alias_ids', '[]'::jsonb)) loop
        update public.inventory_aliases set status = 'retired', retired_at = now(),
          retired_reason = 'Wrong match report ' || p_id,
          alias_kind = coalesce(alias_kind, 'legacy_name'), source = coalesce(source, 'owner_history')
        where id = id_text::uuid and (status is null or status = 'approved');
        if found then
          retired := retired || jsonb_build_object('alias_id', id_text);
          insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
          values ('alias_retired', p_id, request_row.subject_item_id, p_actor_id, label, actor_role, jsonb_build_object('alias_id', id_text));
        end if;
      end loop;
      applied := jsonb_build_object('acknowledged', true, 'retired', retired);
    end if;
  exception when others then
    get stacked diagnostics failure = message_text, failure_hint = pg_exception_hint;
    if coalesce(failure_hint, '') like 'atlas:%' then
      raise;  -- business refusal: the request stays pending, the caller sees why
    end if;
    update atlas_private.catalog_change_requests set status = 'failed', failure_message = left(failure, 1000),
      updated_at = now() where id = p_id returning * into request_row;
    insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
    values ('request_failed', p_id, request_row.subject_item_id, p_actor_id, label, actor_role,
      jsonb_build_object('message', left(failure, 1000)));
    return atlas_private.catalog_request_json(request_row);
  end;

  update atlas_private.catalog_change_requests set status = 'applied', applied_result = applied, updated_at = now()
  where id = p_id returning * into request_row;
  insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, ai_assisted, payload)
  values ('request_applied', p_id, request_row.subject_item_id, p_actor_id, label, actor_role,
    request_row.source in ('recognition','ai_proposal'), jsonb_build_object('kind', request_row.kind));
  if request_row.media_id is not null then
    perform atlas_private.catalog_media_retain(request_row.media_id,
      case when request_row.kind = 'wrong_match_report' then 'disputed_match' else 'approved_change' end);
  end if;
  return atlas_private.catalog_request_json(request_row);
end
$function$;

create or replace function atlas_private.catalog_request_create(
  p_kind text, p_subject_item_id uuid, p_payload jsonb, p_evidence jsonb, p_source text, p_ai_action_id uuid,
  p_recognition_request_id uuid, p_media_id uuid, p_request_id text, p_self_approve boolean,
  p_actor_id uuid, p_actor_label text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  request_row atlas_private.catalog_change_requests;
  actor_role text := atlas_private.catalog_actor_role(p_actor_id, array['admin','manager','bartender','viewer']);
begin
  if coalesce(p_source, '') not in ('recognition','ai_proposal','manager','data_review','backfill','import') then
    perform atlas_private.catalog_invalid('Unknown request source');
  end if;
  request_row := atlas_private.catalog_request_insert(p_kind, p_subject_item_id, p_payload, p_evidence, p_source,
    p_ai_action_id, p_recognition_request_id, p_media_id, p_request_id, p_actor_id, p_actor_label);
  if coalesce(p_self_approve, false) then
    if actor_role not in ('admin','manager') then
      raise exception 'Only managers can approve their own change' using errcode = '42501', hint = 'atlas:forbidden';
    end if;
    if request_row.status = 'pending' then
      return atlas_private.catalog_request_decide(request_row.id, 'approve', 'Self-approved by a manager', request_row.version,
        coalesce(p_payload->'resolution', '{}'::jsonb), p_actor_id, p_actor_label);
    end if;
  end if;
  return atlas_private.catalog_request_json(request_row);
end
$function$;

create or replace function atlas_private.catalog_request_withdraw(p_id uuid, p_actor_id uuid, p_actor_label text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  actor_role text := atlas_private.catalog_actor_role(p_actor_id, array['admin','manager','bartender','viewer']);
  request_row atlas_private.catalog_change_requests;
begin
  select * into request_row from atlas_private.catalog_change_requests where id = p_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if request_row.requested_by <> p_actor_id then
    raise exception 'Only the person who asked can withdraw a request' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  if request_row.status <> 'pending' then
    raise exception 'This request was already decided' using errcode = '40001', hint = 'atlas:stale_request';
  end if;
  update atlas_private.catalog_change_requests set status = 'withdrawn', version = version + 1, updated_at = now()
  where id = p_id returning * into request_row;
  insert into atlas_private.catalog_events (event_type, change_request_id, item_id, actor_id, actor_label, actor_role, payload)
  values ('request_withdrawn', p_id, request_row.subject_item_id, p_actor_id, p_actor_label, actor_role, '{}'::jsonb);
  if request_row.media_id is not null and request_row.kind <> 'wrong_match_report' then
    perform atlas_private.catalog_media_retain(request_row.media_id, null);
  end if;
  return atlas_private.catalog_request_json(request_row);
end
$function$;

create or replace function atlas_private.catalog_queue(
  p_kind text, p_status text, p_limit integer, p_offset integer, p_actor_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  row_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  row_offset integer := greatest(coalesce(p_offset, 0), 0);
  status_filter text := coalesce(nullif(p_status, ''), 'pending');
begin
  perform atlas_private.catalog_actor_role(p_actor_id, array['admin','manager']);
  return jsonb_build_object(
    'status', status_filter,
    'kind', nullif(p_kind, ''),
    'counts', coalesce((select jsonb_object_agg(kind, total) from (
        select r.kind, count(*) as total from atlas_private.catalog_change_requests r
        where r.status = 'pending' group by r.kind) k), '{}'::jsonb),
    'total', (select count(*) from atlas_private.catalog_change_requests r
              where (status_filter = 'all' or r.status = status_filter) and (nullif(p_kind, '') is null or r.kind = p_kind)),
    'rows', coalesce((select jsonb_agg(atlas_private.catalog_request_json(r) order by r.requested_at, r.id)
      from (select * from atlas_private.catalog_change_requests r
            where (status_filter = 'all' or r.status = status_filter) and (nullif(p_kind, '') is null or r.kind = p_kind)
            order by r.requested_at, r.id limit row_limit offset row_offset) r), '[]'::jsonb));
end
$function$;

create or replace function atlas_private.catalog_my_requests(p_limit integer, p_actor_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
begin
  perform atlas_private.catalog_actor_role(p_actor_id, array['admin','manager','bartender','viewer']);
  return jsonb_build_object('rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'status', r.status, 'subject_item_id', r.subject_item_id,
             'subject_item_name', (select i.name from public.inventory_items i where i.id = r.subject_item_id),
             'payload', r.payload, 'requested_at', r.requested_at, 'decided_at', r.decided_at,
             'decision_note', r.decision_note, 'version', r.version) order by r.requested_at desc)
    from (select * from atlas_private.catalog_change_requests r where r.requested_by = p_actor_id
          order by r.requested_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) r), '[]'::jsonb));
end
$function$;

-- Suggestions for the empty S89 attribute columns, as pending requests.
-- Nothing is written to an item until a manager approves each request.
create or replace function atlas_private.catalog_propose_backfill(p_limit integer, p_actor_id uuid, p_actor_label text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  item_row record;
  suggestion jsonb;
  created integer := 0;
  skipped integer := 0;
  pack jsonb;
  inferred_class text;
  request_key text;
begin
  perform atlas_private.catalog_actor_role(p_actor_id, array['admin','manager']);
  for item_row in
    select i.* from public.inventory_items i
    where i.active and (i.item_class is null or i.unit_size_quantity is null)
    order by i.name, i.id
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  loop
    suggestion := '{}'::jsonb;
    inferred_class := atlas_private.inventory_class_for_category(item_row.category, item_row.subcategory);
    if item_row.item_class is null and inferred_class is not null then
      suggestion := suggestion || jsonb_build_object('item_class', inferred_class);
    end if;
    if item_row.unit_size_quantity is null then
      pack := atlas_private.product_parse_item_package(null, null, item_row.size_ml, item_row.package_weight_g,
        item_row.package_size, item_row.name, item_row.unit);
      if pack->>'unit_quantity' is not null then
        suggestion := suggestion || jsonb_build_object('unit_size_quantity', (pack->>'unit_quantity')::numeric,
          'unit_size_base', pack->>'unit_base');
      end if;
    end if;
    if suggestion = '{}'::jsonb then skipped := skipped + 1; continue; end if;
    request_key := 'backfill:' || (atlas_private.product_identity_constants()->>'version') || ':' || item_row.id;
    if exists (select 1 from atlas_private.catalog_change_requests r where r.request_id = request_key) then
      skipped := skipped + 1; continue;
    end if;
    perform atlas_private.catalog_request_insert('metadata_correction', item_row.id,
      jsonb_build_object('item_id', item_row.id, 'values', suggestion,
        'expected', jsonb_build_object('item_class', item_row.item_class, 'unit_size_quantity', item_row.unit_size_quantity)),
      jsonb_build_object('basis', jsonb_build_object('category', item_row.category, 'size_ml', item_row.size_ml,
        'package_weight_g', item_row.package_weight_g, 'package_size', item_row.package_size)),
      'backfill', null, null, null, request_key, p_actor_id, p_actor_label);
    created := created + 1;
  end loop;
  return jsonb_build_object('created', created, 'skipped', skipped, 'stock_changed', false);
end
$function$;

-- ---------------------------------------------------------------------------
-- Public service-role wrappers
-- ---------------------------------------------------------------------------
create or replace function public.atlas_catalog_find_duplicates(
  p_values jsonb, p_codes jsonb, p_aliases jsonb, p_exclude_item_id uuid, p_limit integer, p_actor_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $function$
begin
  perform atlas_private.catalog_actor_role(p_actor_id, array['admin','manager','bartender']);
  return atlas_private.catalog_find_duplicates_core(atlas_private.catalog_clean_values(p_values, false),
    p_codes, p_aliases, p_exclude_item_id, p_limit);
end
$function$;

create or replace function public.atlas_catalog_create_item(
  p_values jsonb, p_codes jsonb, p_aliases jsonb, p_media_id uuid, p_duplicate_ack jsonb,
  p_change_request_id uuid, p_request_id text, p_actor_id uuid, p_actor_label text)
returns jsonb language sql volatile security invoker set search_path = '' as $function$
  select atlas_private.catalog_create_item_core(p_values, p_codes, p_aliases, p_media_id, p_duplicate_ack,
    p_change_request_id, p_request_id, p_actor_id, p_actor_label, 'manager');
$function$;

create or replace function public.atlas_catalog_request_create(
  p_kind text, p_subject_item_id uuid, p_payload jsonb, p_evidence jsonb, p_source text, p_ai_action_id uuid,
  p_recognition_request_id uuid, p_media_id uuid, p_request_id text, p_self_approve boolean,
  p_actor_id uuid, p_actor_label text)
returns jsonb language sql volatile security invoker set search_path = '' as $function$
  select atlas_private.catalog_request_create(p_kind, p_subject_item_id, p_payload, p_evidence, p_source, p_ai_action_id,
    p_recognition_request_id, p_media_id, p_request_id, p_self_approve, p_actor_id, p_actor_label);
$function$;

create or replace function public.atlas_catalog_request_decide(
  p_id uuid, p_decision text, p_note text, p_expected_version integer, p_resolution jsonb,
  p_actor_id uuid, p_actor_label text)
returns jsonb language sql volatile security invoker set search_path = '' as $function$
  select atlas_private.catalog_request_decide(p_id, p_decision, p_note, p_expected_version, p_resolution, p_actor_id, p_actor_label);
$function$;

create or replace function public.atlas_catalog_request_withdraw(p_id uuid, p_actor_id uuid, p_actor_label text)
returns jsonb language sql volatile security invoker set search_path = '' as $function$
  select atlas_private.catalog_request_withdraw(p_id, p_actor_id, p_actor_label);
$function$;

create or replace function public.atlas_catalog_queue(p_kind text, p_status text, p_limit integer, p_offset integer, p_actor_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $function$
  select atlas_private.catalog_queue(p_kind, p_status, p_limit, p_offset, p_actor_id);
$function$;

create or replace function public.atlas_catalog_my_requests(p_limit integer, p_actor_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $function$
  select atlas_private.catalog_my_requests(p_limit, p_actor_id);
$function$;

create or replace function public.atlas_catalog_propose_backfill(p_limit integer, p_actor_id uuid, p_actor_label text)
returns jsonb language sql volatile security invoker set search_path = '' as $function$
  select atlas_private.catalog_propose_backfill(p_limit, p_actor_id, p_actor_label);
$function$;

-- ---------------------------------------------------------------------------
-- Recognition proposal commands (run as atlas_recognition_definer)
-- ---------------------------------------------------------------------------
grant select on atlas_private.catalog_change_requests to atlas_recognition_definer;
grant insert on atlas_private.catalog_change_requests, atlas_private.catalog_events to atlas_recognition_definer;
do $s89_governance_policies$
declare
  target record;
begin
  for target in select * from (values
      ('catalog_change_requests', 'select'), ('catalog_change_requests', 'insert'), ('catalog_events', 'insert')
    ) as v(table_name, command)
  loop
    execute format('drop policy if exists %I on atlas_private.%I', 'recognition definer ' || target.command, target.table_name);
    if target.command = 'select' then
      execute format('create policy %I on atlas_private.%I for select to atlas_recognition_definer using (true)',
        'recognition definer ' || target.command, target.table_name);
    elsif target.table_name = 'catalog_change_requests' then
      execute format('create policy %I on atlas_private.%I for insert to atlas_recognition_definer with check (status = %L and decided_at is null)',
        'recognition definer ' || target.command, target.table_name, 'pending');
    else
      execute format('create policy %I on atlas_private.%I for insert to atlas_recognition_definer with check (true)',
        'recognition definer ' || target.command, target.table_name);
    end if;
  end loop;
end
$s89_governance_policies$;

create or replace function atlas_private.recognition_record_outcome(
  p_outcome jsonb, p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  role_name text := atlas_private.recognition_actor(p_actor_id, p_actor_role);
  label text := coalesce(nullif(btrim(coalesce(p_actor_label, '')), ''), p_actor_id::text);
  o jsonb := coalesce(p_outcome, '{}'::jsonb);
  detection atlas_private.recognition_detections;
  request atlas_private.recognition_requests;
  existing atlas_private.recognition_outcomes;
  outcome_row atlas_private.recognition_outcomes;
  chosen uuid;
  report atlas_private.catalog_change_requests;
  top_item uuid;
begin
  begin
    select * into existing from atlas_private.recognition_outcomes where client_outcome_id = nullif(o->>'client_outcome_id', '')::uuid;
    select * into detection from atlas_private.recognition_detections where id = (o->>'detection_id')::uuid;
    chosen := nullif(o->>'chosen_item_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Outcome ids must be UUIDs' using errcode = '22023', hint = 'atlas:invalid_request';
  end;
  if existing.id is not null then
    if existing.actor_id <> p_actor_id then
      raise exception 'This outcome id belongs to another person' using errcode = '42501', hint = 'atlas:forbidden';
    end if;
    return jsonb_build_object('outcome_id', existing.id, 'replayed', true, 'stock_changed', false);
  end if;
  if detection.id is null then raise exception 'Recognition result not found' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  select * into request from atlas_private.recognition_requests where id = detection.request_id;
  if request.actor_id <> p_actor_id and role_name not in ('admin','manager') then
    raise exception 'This recognition result belongs to another person' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  if chosen is not null and not exists (select 1 from public.inventory_items i where i.id = chosen and i.active) then
    raise exception 'Choose an active inventory item' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if o->>'outcome' = 'confirmed_preselected' and (detection.preselected_item_id is null or chosen is distinct from detection.preselected_item_id) then
    raise exception 'Only the pre-selected item can be confirmed' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if o->>'used_for' = 'count_line' and role_name = 'viewer' then
    raise exception 'Viewers cannot count stock' using errcode = '42501', hint = 'atlas:forbidden';
  end if;

  insert into atlas_private.recognition_outcomes (client_outcome_id, detection_id, outcome, chosen_item_id, chosen_rank,
    used_for, used_ref, actor_id, actor_label, actor_role, note)
  values (nullif(o->>'client_outcome_id', '')::uuid, detection.id, o->>'outcome', chosen,
    nullif(o->>'chosen_rank', '')::smallint, nullif(o->>'used_for', ''), o->'used_ref', p_actor_id, label, role_name,
    nullif(btrim(coalesce(o->>'note', '')), ''))
  returning * into outcome_row;

  -- A wrong High match may mean a wrong code or alias: report it for review.
  if outcome_row.outcome = 'wrong_product' and detection.band = 'high' then
    select c.item_id into top_item from atlas_private.recognition_candidates c where c.detection_id = detection.id and c.rank = 1;
    report := atlas_private.catalog_request_insert('wrong_match_report', top_item,
      jsonb_build_object('item_id', top_item, 'detection_id', detection.id, 'suggested_item_id', chosen,
        'note', coalesce(outcome_row.note, 'A pre-selected match was marked as the wrong product'), 'automatic', true),
      jsonb_build_object('band', detection.band, 'field_confidence', detection.field_confidence,
        'normalized', detection.normalized),
      'recognition', null, request.id, request.media_id, 'wrong-high:' || outcome_row.id, p_actor_id, label);
  end if;
  return jsonb_build_object('outcome_id', outcome_row.id, 'replayed', false,
    'wrong_match_report_id', report.id, 'stock_changed', false);
end
$function$;

create or replace function atlas_private.recognition_propose(
  p_kind text, p_payload jsonb, p_evidence jsonb, p_recognition_request_id uuid, p_media_id uuid, p_request_id text,
  p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  role_name text := atlas_private.recognition_actor(p_actor_id, p_actor_role);
  request_row atlas_private.catalog_change_requests;
begin
  if p_kind not in ('alias','code','new_item','metadata_correction','wrong_match_report') then
    perform atlas_private.catalog_invalid('This request type is not available from recognition');
  end if;
  if p_recognition_request_id is not null and not exists (
    select 1 from atlas_private.recognition_requests r where r.id = p_recognition_request_id
      and (r.actor_id = p_actor_id or role_name in ('admin','manager'))) then
    raise exception 'Recognition result not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  request_row := atlas_private.catalog_request_insert(p_kind, null, p_payload, p_evidence, 'recognition', null,
    p_recognition_request_id, p_media_id, p_request_id, p_actor_id, p_actor_label);
  return jsonb_build_object('request', atlas_private.catalog_request_json(request_row),
    'message', 'Nothing changes until a manager approves it.', 'stock_changed', false);
end
$function$;

create or replace function atlas_private.recognition_find_duplicates(
  p_values jsonb, p_codes jsonb, p_aliases jsonb, p_limit integer, p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  role_name text := atlas_private.recognition_actor(p_actor_id, p_actor_role);
begin
  if role_name = 'viewer' then
    raise exception 'New product drafts are available to bartenders and managers' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return atlas_private.catalog_find_duplicates_core(atlas_private.catalog_clean_values(p_values, false),
    p_codes, p_aliases, null, p_limit);
end
$function$;

create or replace function atlas_private.recognition_my_requests(p_limit integer, p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform atlas_private.recognition_actor(p_actor_id, p_actor_role);
  return atlas_private.catalog_my_requests(p_limit, p_actor_id);
end
$function$;

create or replace function public.atlas_recognition_record_outcome(p_outcome jsonb, p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb language sql volatile security invoker set search_path = '' as $function$
  select atlas_private.recognition_record_outcome(p_outcome, p_actor_id, p_actor_label, p_actor_role);
$function$;
create or replace function public.atlas_recognition_propose(
  p_kind text, p_payload jsonb, p_evidence jsonb, p_recognition_request_id uuid, p_media_id uuid, p_request_id text,
  p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb language sql volatile security invoker set search_path = '' as $function$
  select atlas_private.recognition_propose(p_kind, p_payload, p_evidence, p_recognition_request_id, p_media_id,
    p_request_id, p_actor_id, p_actor_label, p_actor_role);
$function$;
create or replace function public.atlas_recognition_find_duplicates(
  p_values jsonb, p_codes jsonb, p_aliases jsonb, p_limit integer, p_actor_id uuid, p_actor_role text)
returns jsonb language sql stable security invoker set search_path = '' as $function$
  select atlas_private.recognition_find_duplicates(p_values, p_codes, p_aliases, p_limit, p_actor_id, p_actor_role);
$function$;
create or replace function public.atlas_recognition_my_requests(p_limit integer, p_actor_id uuid, p_actor_role text)
returns jsonb language sql stable security invoker set search_path = '' as $function$
  select atlas_private.recognition_my_requests(p_limit, p_actor_id, p_actor_role);
$function$;

grant create on schema atlas_private to atlas_recognition_definer;
alter function atlas_private.recognition_record_outcome(jsonb, uuid, text, text) owner to atlas_recognition_definer;
alter function atlas_private.recognition_propose(text, jsonb, jsonb, uuid, uuid, text, uuid, text, text) owner to atlas_recognition_definer;
alter function atlas_private.recognition_find_duplicates(jsonb, jsonb, jsonb, integer, uuid, text) owner to atlas_recognition_definer;
alter function atlas_private.recognition_my_requests(integer, uuid, text) owner to atlas_recognition_definer;
revoke create on schema atlas_private from atlas_recognition_definer;

-- The definer may run the proposal path and the read-only guard, nothing else.
do $s89_governance_execute$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure as signature, p.proname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'atlas_private' and p.proname in (
      'catalog_actor_role', 'catalog_invalid', 'catalog_clean_values', 'catalog_item_duplicate_keys',
      'catalog_find_duplicates_core', 'catalog_request_insert', 'catalog_request_json', 'catalog_my_requests',
      'catalog_request_insert_guard')
  loop
    execute format('grant execute on function %s to atlas_recognition_definer', function_row.signature);
  end loop;
  for function_row in
    select p.oid::regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'atlas\_catalog\_%' or p.proname in (
      'atlas_recognition_record_outcome', 'atlas_recognition_propose', 'atlas_recognition_find_duplicates',
      'atlas_recognition_my_requests'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', function_row.signature);
    execute format('grant execute on function %s to service_role', function_row.signature);
  end loop;
end
$s89_governance_execute$;
revoke execute on all functions in schema atlas_private from public;
grant execute on all functions in schema atlas_private to service_role;

-- ---------------------------------------------------------------------------
-- Reactivation also refuses an active item with the same identity key
-- ---------------------------------------------------------------------------
create or replace function atlas_private.inventory_active_identity_holder(p_item_id uuid)
returns table (id uuid, name text)
language sql
stable
set search_path = ''
as $function$
  select other.id, other.name
  from atlas_private.inventory_identity_keys mine
  join public.inventory_items item on item.id = mine.item_id
  join public.inventory_items other on other.active and other.id <> p_item_id
  left join atlas_private.inventory_identity_keys theirs on theirs.item_id = other.id
  where mine.item_id = p_item_id
    and ((mine.identity_key is not null and theirs.identity_key = mine.identity_key)
         or lower(btrim(other.name)) = lower(btrim(item.name)))
  order by other.name, other.id
  limit 1;
$function$;
revoke all on function atlas_private.inventory_active_identity_holder(uuid) from public, anon, authenticated;
grant execute on function atlas_private.inventory_active_identity_holder(uuid) to service_role;

do $s89_activation_identity$
declare
  definition text;
begin
  -- Extend the S88 same-name reactivation guard to the identity key without
  -- restating the whole function: swap the duplicate predicate in place.
  select pg_catalog.pg_get_functiondef('atlas_private.set_inventory_item_active(uuid,boolean,text,timestamptz,uuid,text)'::regprocedure)
  into definition;
  if position('inventory_active_identity_holder' in definition) = 0 then
    definition := replace(definition,
      E'  if p_active and exists (\n    select 1 from public.inventory_items other\n    where other.active and other.id <> p_item_id\n      and lower(btrim(other.name)) = lower(btrim(item_row.name))\n  ) then',
      E'  if p_active and exists (select 1 from atlas_private.inventory_active_identity_holder(p_item_id)) then');
    if position('inventory_active_identity_holder' in definition) = 0 then
      raise exception 'S89: could not extend the S88 reactivation guard';
    end if;
    execute definition;
  end if;

  select pg_catalog.pg_get_functiondef('atlas_private.inventory_item_dependency_facts(uuid)'::regprocedure) into definition;
  if position('inventory_active_identity_holder' in definition) = 0 then
    definition := replace(definition,
      E'  select other.id, other.name into duplicate_id, duplicate_name\n  from public.inventory_items other\n  where other.active\n    and other.id <> p_item_id\n    and lower(btrim(other.name)) = lower(btrim(item_row.name))\n  order by other.name, other.id\n  limit 1;',
      E'  select holder.id, holder.name into duplicate_id, duplicate_name\n  from atlas_private.inventory_active_identity_holder(p_item_id) holder;');
    if position('inventory_active_identity_holder' in definition) = 0 then
      raise exception 'S89: could not extend the S88 dependency facts';
    end if;
    execute definition;
  end if;
end
$s89_activation_identity$;

-- ---------------------------------------------------------------------------
-- Item Master publication accepts the S89 attribute columns. The legacy
-- fourteen fields keep their exact optimistic check; new fields are checked
-- when the caller sends an expected value for them.
-- ---------------------------------------------------------------------------
do $s89_item_master_publish$
declare
  definition text;
begin
  select pg_catalog.pg_get_functiondef('public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text)'::regprocedure)
  into definition;
  if position('unit_size_quantity' in definition) = 0 then
    definition := replace(definition,
      $old$where item_key not in ('par_level','critical_minimum','supplier_id','supplier','supplier_product_reference','units_per_case','size_ml','package_weight_g','package_size','cost_price','case_cost','bin_location','lead_time_days','minimum_order_quantity')$old$,
      $new$where item_key not in ('par_level','critical_minimum','supplier_id','supplier','supplier_product_reference','units_per_case','size_ml','package_weight_g','package_size','cost_price','case_cost','bin_location','lead_time_days','minimum_order_quantity','brand','product_name','variant','item_class','packaging_type','unit_size_quantity','unit_size_base','abv_percent','subcategory')$new$);
    definition := replace(definition,
      $old$  if current_values is distinct from p_expected_values then raise exception 'Production item-master fields changed after draft review'; end if;$old$,
      $new$  if current_values is distinct from (coalesce(p_expected_values,'{}'::jsonb) - array['brand','product_name','variant','item_class','packaging_type','unit_size_quantity','unit_size_base','abv_percent','subcategory'])
     or exists (
       select 1 from jsonb_each(coalesce(p_expected_values,'{}'::jsonb)) expected
       where expected.key in ('brand','product_name','variant','item_class','packaging_type','unit_size_quantity','unit_size_base','abv_percent','subcategory')
         and (to_jsonb(item_row)->expected.key) is distinct from expected.value
         and not (jsonb_typeof(to_jsonb(item_row)->expected.key) = 'number' and jsonb_typeof(expected.value) = 'number'
                  and (to_jsonb(item_row)->>expected.key)::numeric = (expected.value #>> '{}')::numeric)) then
    raise exception 'Production item-master fields changed after draft review';
  end if;
  if p_values ? 'item_class' and nullif(p_values->>'item_class','') is not null and p_values->>'item_class' not in ('spirit','liqueur','wine','sparkling','beer_cider','non_alcoholic','syrup','bar_ingredient','dairy_alt','coffee_tea','produce','garnish','food','consumable','cleaning','equipment','gas','prep','reference') then raise exception 'Product type is not in the Atlas taxonomy'; end if;
  if p_values ? 'unit_size_quantity' and p_values->'unit_size_quantity' <> 'null'::jsonb and (p_values->>'unit_size_quantity')::numeric <= 0 then raise exception 'Unit size must be greater than zero'; end if;
  if p_values ? 'abv_percent' and p_values->'abv_percent' <> 'null'::jsonb and (p_values->>'abv_percent')::numeric not between 0 and 100 then raise exception 'ABV must be between 0 and 100'; end if;$new$);
    definition := replace(definition,
      $old$      minimum_order_quantity=case when p_values ? 'minimum_order_quantity' then nullif(p_values->>'minimum_order_quantity','')::numeric else minimum_order_quantity end,$old$,
      $new$      minimum_order_quantity=case when p_values ? 'minimum_order_quantity' then nullif(p_values->>'minimum_order_quantity','')::numeric else minimum_order_quantity end,
      brand=case when p_values ? 'brand' then nullif(trim(p_values->>'brand'),'') else brand end,
      product_name=case when p_values ? 'product_name' then nullif(trim(p_values->>'product_name'),'') else product_name end,
      variant=case when p_values ? 'variant' then nullif(trim(p_values->>'variant'),'') else variant end,
      item_class=case when p_values ? 'item_class' then nullif(trim(p_values->>'item_class'),'') else item_class end,
      packaging_type=case when p_values ? 'packaging_type' then nullif(trim(p_values->>'packaging_type'),'') else packaging_type end,
      unit_size_quantity=case when p_values ? 'unit_size_quantity' then nullif(p_values->>'unit_size_quantity','')::numeric else unit_size_quantity end,
      unit_size_base=case when p_values ? 'unit_size_base' then nullif(trim(p_values->>'unit_size_base'),'') else unit_size_base end,
      abv_percent=case when p_values ? 'abv_percent' then nullif(p_values->>'abv_percent','')::numeric else abv_percent end,
      subcategory=case when p_values ? 'subcategory' then nullif(trim(p_values->>'subcategory'),'') else subcategory end,$new$);
    if position('unit_size_quantity=case' in definition) = 0 or position('unit_size_base' in definition) = 0
       or position('jsonb_each(coalesce(p_expected_values' in definition) = 0 then
      raise exception 'S89: could not extend atlas_apply_item_master_update';
    end if;
    execute definition;
  end if;
end
$s89_item_master_publish$;

comment on function public.atlas_catalog_create_item(jsonb, jsonb, jsonb, uuid, jsonb, uuid, text, uuid, text) is
  'S89 service-role-only guarded item creation: manager only, mandatory duplicate check (codes, keys, aliases, active and inactive items), acknowledged candidates audited, quantity starts at 0.';
comment on function public.atlas_catalog_request_decide(uuid, text, text, integer, jsonb, uuid, text) is
  'S89 service-role-only manager decision on a catalogue change request. Applies in the same transaction; never changes stock.';

notify pgrst, 'reload schema';
