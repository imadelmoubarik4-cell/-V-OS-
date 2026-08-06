-- Checkpoint L2: prioritized item-master completion with private drafts and a
-- manager-only publication boundary. Production application remains disabled on
-- the preview branch. No quantity or inventory-movement field is part of this
-- contract.

alter table public.inventory_items
  add column if not exists critical_minimum numeric,
  add column if not exists supplier_product_reference text,
  add column if not exists package_weight_g numeric,
  add column if not exists lead_time_days integer,
  add column if not exists minimum_order_quantity numeric;

do $constraints$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.inventory_items'::regclass and conname='inventory_items_critical_minimum_check') then
    alter table public.inventory_items add constraint inventory_items_critical_minimum_check check (critical_minimum is null or critical_minimum >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.inventory_items'::regclass and conname='inventory_items_package_weight_g_check') then
    alter table public.inventory_items add constraint inventory_items_package_weight_g_check check (package_weight_g is null or package_weight_g > 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.inventory_items'::regclass and conname='inventory_items_lead_time_days_check') then
    alter table public.inventory_items add constraint inventory_items_lead_time_days_check check (lead_time_days is null or lead_time_days >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.inventory_items'::regclass and conname='inventory_items_minimum_order_quantity_check') then
    alter table public.inventory_items add constraint inventory_items_minimum_order_quantity_check check (minimum_order_quantity is null or minimum_order_quantity > 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.inventory_items'::regclass and conname='inventory_items_critical_not_above_par_check') then
    alter table public.inventory_items add constraint inventory_items_critical_not_above_par_check check (critical_minimum is null or par_level is null or critical_minimum <= par_level);
  end if;
end
$constraints$;

create index if not exists inventory_items_supplier_product_reference_idx
  on public.inventory_items(supplier_product_reference)
  where supplier_product_reference is not null;

create table if not exists atlas_private.item_master_settings (
  setting_key text primary key default 'va',
  production_apply_enabled boolean not null default false,
  source_match_required boolean not null default true,
  updated_at timestamptz not null default now(),
  check (setting_key='va')
);

insert into atlas_private.item_master_settings (setting_key,production_apply_enabled,source_match_required)
values ('va',false,true)
on conflict (setting_key) do nothing;

create table if not exists atlas_private.item_master_drafts (
  id uuid primary key default gen_random_uuid(),
  external_item_id uuid not null unique,
  item_name text not null,
  category text,
  source_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(source_snapshot)='object'),
  proposed_values jsonb not null default '{}'::jsonb check (jsonb_typeof(proposed_values)='object'),
  proposed_recipe_links jsonb not null default '[]'::jsonb check (jsonb_typeof(proposed_recipe_links)='array'),
  proposed_barcode_aliases jsonb not null default '[]'::jsonb check (jsonb_typeof(proposed_barcode_aliases)='array'),
  priority_score integer not null default 0 check (priority_score between 0 and 250),
  priority_tier text not null default 'standard' check (priority_tier in ('critical','high','standard','complete')),
  priority_reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(priority_reasons)='array'),
  missing_fields jsonb not null default '[]'::jsonb check (jsonb_typeof(missing_fields)='array'),
  status text not null default 'draft' check (status in ('draft','ready','blocked','published','archived')),
  version integer not null default 1 check (version > 0),
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists item_master_drafts_priority_idx on atlas_private.item_master_drafts(priority_tier,priority_score desc,updated_at desc);
create index if not exists item_master_drafts_status_idx on atlas_private.item_master_drafts(status,updated_at desc);

create table if not exists atlas_private.item_master_publications (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references atlas_private.item_master_drafts(id) on delete restrict,
  external_item_id uuid not null,
  request_id text not null unique,
  status text not null default 'ready' check (status in ('ready','blocked','publishing','published','failed')),
  production_apply_enabled boolean not null default false,
  source_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(source_snapshot)='object'),
  proposed_values jsonb not null default '{}'::jsonb check (jsonb_typeof(proposed_values)='object'),
  proposed_recipe_links jsonb not null default '[]'::jsonb check (jsonb_typeof(proposed_recipe_links)='array'),
  proposed_barcode_aliases jsonb not null default '[]'::jsonb check (jsonb_typeof(proposed_barcode_aliases)='array'),
  blocked_reason text,
  approved_by uuid not null,
  approved_by_label text not null,
  approved_at timestamptz not null default now(),
  published_by uuid,
  published_by_label text,
  published_at timestamptz,
  applied_values jsonb not null default '{}'::jsonb check (jsonb_typeof(applied_values)='object'),
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists item_master_publications_draft_idx on atlas_private.item_master_publications(draft_id,created_at desc);
create index if not exists item_master_publications_item_idx on atlas_private.item_master_publications(external_item_id,created_at desc);

create table if not exists atlas_private.item_master_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('draft_saved','publication_prepared','publication_blocked','publication_published','publication_failed')),
  draft_id uuid references atlas_private.item_master_drafts(id) on delete set null,
  publication_id uuid references atlas_private.item_master_publications(id) on delete set null,
  external_item_id uuid,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now()
);
create index if not exists item_master_events_item_idx on atlas_private.item_master_events(external_item_id,created_at desc);

alter table atlas_private.item_master_settings enable row level security;
alter table atlas_private.item_master_drafts enable row level security;
alter table atlas_private.item_master_publications enable row level security;
alter table atlas_private.item_master_events enable row level security;

revoke all on atlas_private.item_master_settings from public,anon,authenticated;
revoke all on atlas_private.item_master_drafts from public,anon,authenticated;
revoke all on atlas_private.item_master_publications from public,anon,authenticated;
revoke all on atlas_private.item_master_events from public,anon,authenticated;
grant all on atlas_private.item_master_settings to service_role;
grant all on atlas_private.item_master_drafts to service_role;
grant all on atlas_private.item_master_publications to service_role;
grant all on atlas_private.item_master_events to service_role;

drop policy if exists item_master_settings_service_only on atlas_private.item_master_settings;
create policy item_master_settings_service_only on atlas_private.item_master_settings for all to service_role using (true) with check (true);
drop policy if exists item_master_drafts_service_only on atlas_private.item_master_drafts;
create policy item_master_drafts_service_only on atlas_private.item_master_drafts for all to service_role using (true) with check (true);
drop policy if exists item_master_publications_service_only on atlas_private.item_master_publications;
create policy item_master_publications_service_only on atlas_private.item_master_publications for all to service_role using (true) with check (true);
drop policy if exists item_master_events_service_only on atlas_private.item_master_events;
create policy item_master_events_service_only on atlas_private.item_master_events for all to service_role using (true) with check (true);

create or replace function atlas_private.item_master_validate_draft(p_values jsonb,p_recipe_links jsonb,p_barcode_aliases jsonb)
returns void
language plpgsql
immutable
security invoker
set search_path=''
as $$
declare
  unknown_key text;
  numeric_key text;
  value_numeric numeric;
  entry jsonb;
  raw_code text;
  normalized_code text;
begin
  if jsonb_typeof(coalesce(p_values,'{}'::jsonb)) <> 'object' then raise exception 'Item-master values must be an object'; end if;
  if jsonb_typeof(coalesce(p_recipe_links,'[]'::jsonb)) <> 'array' then raise exception 'Recipe links must be an array'; end if;
  if jsonb_typeof(coalesce(p_barcode_aliases,'[]'::jsonb)) <> 'array' then raise exception 'Barcode aliases must be an array'; end if;

  select item_key into unknown_key
  from jsonb_object_keys(coalesce(p_values,'{}'::jsonb)) as keys(item_key)
  where item_key not in ('par_level','critical_minimum','supplier_id','supplier','supplier_product_reference','units_per_case','size_ml','package_weight_g','package_size','cost_price','case_cost','bin_location','lead_time_days','minimum_order_quantity')
  limit 1;
  if unknown_key is not null then raise exception 'Unsupported item-master field %',unknown_key; end if;

  foreach numeric_key in array array['par_level','critical_minimum','units_per_case','size_ml','package_weight_g','cost_price','case_cost','lead_time_days','minimum_order_quantity'] loop
    if p_values ? numeric_key and p_values->numeric_key <> 'null'::jsonb then
      if jsonb_typeof(p_values->numeric_key) <> 'number' then raise exception 'Item-master field % must be numeric',numeric_key; end if;
      value_numeric := (p_values->>numeric_key)::numeric;
      if numeric_key in ('par_level','critical_minimum','cost_price','case_cost','lead_time_days') and value_numeric < 0 then raise exception 'Item-master field % cannot be negative',numeric_key; end if;
      if numeric_key in ('units_per_case','size_ml','package_weight_g','minimum_order_quantity') and value_numeric <= 0 then raise exception 'Item-master field % must be greater than zero',numeric_key; end if;
      if numeric_key='lead_time_days' and value_numeric <> trunc(value_numeric) then raise exception 'Lead time must be a whole number of days'; end if;
    end if;
  end loop;

  if p_values ? 'par_level' and p_values->'par_level' <> 'null'::jsonb and p_values ? 'critical_minimum' and p_values->'critical_minimum' <> 'null'::jsonb and (p_values->>'critical_minimum')::numeric > (p_values->>'par_level')::numeric then
    raise exception 'Critical minimum cannot be above par level';
  end if;
  if p_values ? 'supplier_id' and p_values->'supplier_id' <> 'null'::jsonb and coalesce(p_values->>'supplier_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception 'Supplier id is invalid'; end if;
  if length(coalesce(p_values->>'supplier','')) > 240 or length(coalesce(p_values->>'supplier_product_reference','')) > 240 or length(coalesce(p_values->>'package_size','')) > 120 or length(coalesce(p_values->>'bin_location','')) > 240 then raise exception 'An item-master text field is too long'; end if;

  for entry in select value from jsonb_array_elements(coalesce(p_recipe_links,'[]'::jsonb)) loop
    if jsonb_typeof(entry) <> 'object' then raise exception 'Recipe link entries must be objects'; end if;
    if coalesce(entry->>'ingredient_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception 'Recipe link ingredient id is invalid'; end if;
  end loop;

  for entry in select value from jsonb_array_elements(coalesce(p_barcode_aliases,'[]'::jsonb)) loop
    if jsonb_typeof(entry) <> 'object' then raise exception 'Barcode alias entries must be objects'; end if;
    raw_code := trim(coalesce(entry->>'code',''));
    normalized_code := regexp_replace(lower(raw_code),'[^a-z0-9]','','g');
    if length(normalized_code) < 3 or length(normalized_code) > 128 then raise exception 'Barcode alias must normalize to 3–128 characters'; end if;
  end loop;
end;
$$;

create or replace function atlas_private.item_master_snapshot(p_actor_id uuid,p_actor_role text)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare result jsonb;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Checkpoint L2 is available only to managers and administrators'; end if;

  with count_lines as (
    select inventory_item_id,count(*) filter (where line_status='counted') as count_observations,max(counted_at) as last_counted_at
    from atlas_private.inventory_count_lines group by inventory_item_id
  ), verified as (
    select distinct on (inventory_item_id) inventory_item_id,verified_quantity,verification_status,verified_at,expires_at,historical
    from atlas_private.inventory_verified_balances order by inventory_item_id,verified_at desc
  ), count_context as (
    select coalesce(count_lines.inventory_item_id,verified.inventory_item_id) as inventory_item_id,
      coalesce(count_lines.count_observations,0) as count_observations,count_lines.last_counted_at,
      verified.verified_quantity,verified.verification_status,verified.verified_at,verified.expires_at,verified.historical
    from count_lines full join verified using (inventory_item_id)
  )
  select jsonb_build_object(
    'version','atlas-item-master-l2/0.1.0','generated_at',now(),
    'settings',coalesce((select to_jsonb(s) from atlas_private.item_master_settings s where setting_key='va'),jsonb_build_object('production_apply_enabled',false,'source_match_required',true)),
    'drafts',coalesce((select jsonb_agg(to_jsonb(d) order by priority_score desc,item_name) from atlas_private.item_master_drafts d where status <> 'archived'),'[]'::jsonb),
    'publications',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc) from (select * from atlas_private.item_master_publications order by created_at desc limit 100) p),'[]'::jsonb),
    'barcode_aliases',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.raw_code,'normalized_code',a.normalized_code,'symbology',a.symbology,'external_item_id',a.external_item_id,'verified',a.verified,'active',a.active,'scan_count',a.scan_count,'last_seen_at',a.last_seen_at) order by a.external_item_name,a.raw_code) from atlas_private.inventory_scan_aliases a where a.active=true),'[]'::jsonb),
    'count_activity',coalesce((select jsonb_agg(to_jsonb(c) order by c.inventory_item_id) from count_context c),'[]'::jsonb),
    'policy',jsonb_build_object('manager_only',true,'private_drafts',true,'quantity_mutation',false,'movement_creation',false,'supplier_order_submission',false,'production_apply_enabled',coalesce((select production_apply_enabled from atlas_private.item_master_settings where setting_key='va'),false))
  ) into result;
  return result;
end;
$$;

create or replace function atlas_private.item_master_save_draft(
  p_external_item_id uuid,p_item_name text,p_category text,p_source_snapshot jsonb,p_proposed_values jsonb,
  p_recipe_links jsonb,p_barcode_aliases jsonb,p_priority_score integer,p_priority_tier text,
  p_priority_reasons jsonb,p_missing_fields jsonb,p_expected_version integer,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare existing_row atlas_private.item_master_drafts; draft_row atlas_private.item_master_drafts;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can save item-master drafts'; end if;
  if p_external_item_id is null then raise exception 'Inventory item id is required'; end if;
  if nullif(trim(coalesce(p_item_name,'')),'') is null then raise exception 'Inventory item name is required'; end if;
  if jsonb_typeof(coalesce(p_source_snapshot,'{}'::jsonb)) <> 'object' then raise exception 'Source snapshot must be an object'; end if;
  if p_priority_score < 0 or p_priority_score > 250 then raise exception 'Priority score is invalid'; end if;
  if p_priority_tier not in ('critical','high','standard','complete') then raise exception 'Priority tier is invalid'; end if;
  if jsonb_typeof(coalesce(p_priority_reasons,'[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_missing_fields,'[]'::jsonb)) <> 'array' then raise exception 'Priority reasons and missing fields must be arrays'; end if;
  perform atlas_private.item_master_validate_draft(coalesce(p_proposed_values,'{}'::jsonb),coalesce(p_recipe_links,'[]'::jsonb),coalesce(p_barcode_aliases,'[]'::jsonb));

  select * into existing_row from atlas_private.item_master_drafts where external_item_id=p_external_item_id for update;
  if found then
    if p_expected_version is null or p_expected_version <> existing_row.version then raise exception 'Item-master draft changed after it was opened'; end if;
    update atlas_private.item_master_drafts set
      item_name=trim(p_item_name),category=nullif(trim(coalesce(p_category,'')),''),source_snapshot=coalesce(p_source_snapshot,'{}'::jsonb),
      proposed_values=coalesce(p_proposed_values,'{}'::jsonb),proposed_recipe_links=coalesce(p_recipe_links,'[]'::jsonb),proposed_barcode_aliases=coalesce(p_barcode_aliases,'[]'::jsonb),
      priority_score=p_priority_score,priority_tier=p_priority_tier,priority_reasons=coalesce(p_priority_reasons,'[]'::jsonb),missing_fields=coalesce(p_missing_fields,'[]'::jsonb),
      status='draft',version=version+1,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=now()
    where id=existing_row.id returning * into draft_row;
  else
    if p_expected_version is not null then raise exception 'New item-master drafts must not specify a version'; end if;
    insert into atlas_private.item_master_drafts (
      external_item_id,item_name,category,source_snapshot,proposed_values,proposed_recipe_links,proposed_barcode_aliases,
      priority_score,priority_tier,priority_reasons,missing_fields,status,created_by,created_by_label,updated_by,updated_by_label
    ) values (
      p_external_item_id,trim(p_item_name),nullif(trim(coalesce(p_category,'')),''),coalesce(p_source_snapshot,'{}'::jsonb),coalesce(p_proposed_values,'{}'::jsonb),
      coalesce(p_recipe_links,'[]'::jsonb),coalesce(p_barcode_aliases,'[]'::jsonb),p_priority_score,p_priority_tier,
      coalesce(p_priority_reasons,'[]'::jsonb),coalesce(p_missing_fields,'[]'::jsonb),'draft',p_actor_id,p_actor_label,p_actor_id,p_actor_label
    ) returning * into draft_row;
  end if;

  insert into atlas_private.item_master_events (event_type,draft_id,external_item_id,actor_id,actor_label,actor_role,payload)
  values ('draft_saved',draft_row.id,draft_row.external_item_id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('version',draft_row.version,'priority_score',draft_row.priority_score,'missing_fields',draft_row.missing_fields));
  return to_jsonb(draft_row);
end;
$$;

create or replace function atlas_private.item_master_prepare_publication(
  p_draft_id uuid,p_request_id text,p_current_source_snapshot jsonb,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  draft_row atlas_private.item_master_drafts;
  setting_row atlas_private.item_master_settings;
  publication_row atlas_private.item_master_publications;
  blocked_text text;
  source_changed boolean;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can approve item-master publication'; end if;
  if nullif(trim(coalesce(p_request_id,'')),'') is null then raise exception 'Publication request id is required'; end if;
  if length(p_request_id) > 200 then raise exception 'Publication request id is too long'; end if;
  if jsonb_typeof(coalesce(p_current_source_snapshot,'{}'::jsonb)) <> 'object' then raise exception 'Current source snapshot must be an object'; end if;

  select * into publication_row from atlas_private.item_master_publications where request_id=trim(p_request_id);
  if found then return to_jsonb(publication_row); end if;

  select * into draft_row from atlas_private.item_master_drafts where id=p_draft_id for update;
  if not found then raise exception 'Item-master draft not found'; end if;
  if draft_row.status='archived' then raise exception 'Archived item-master drafts cannot be published'; end if;
  select * into setting_row from atlas_private.item_master_settings where setting_key='va';

  source_changed := coalesce(setting_row.source_match_required,true)
    and coalesce(draft_row.source_snapshot->>'master_fingerprint','') is distinct from coalesce(p_current_source_snapshot->>'master_fingerprint','');
  blocked_text := case when source_changed then 'Production item-master fields changed after this draft was saved'
    when not coalesce(setting_row.production_apply_enabled,false) then 'Production item-master publication is disabled for this preview deployment'
    else null end;

  insert into atlas_private.item_master_publications (
    draft_id,external_item_id,request_id,status,production_apply_enabled,source_snapshot,proposed_values,
    proposed_recipe_links,proposed_barcode_aliases,blocked_reason,approved_by,approved_by_label
  ) values (
    draft_row.id,draft_row.external_item_id,trim(p_request_id),case when blocked_text is null then 'ready' else 'blocked' end,
    coalesce(setting_row.production_apply_enabled,false),coalesce(p_current_source_snapshot,'{}'::jsonb),draft_row.proposed_values,
    draft_row.proposed_recipe_links,draft_row.proposed_barcode_aliases,blocked_text,p_actor_id,p_actor_label
  ) returning * into publication_row;

  update atlas_private.item_master_drafts set status=case when blocked_text is null then 'ready' else 'blocked' end,
    version=version+1,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=now() where id=draft_row.id;
  insert into atlas_private.item_master_events (event_type,draft_id,publication_id,external_item_id,actor_id,actor_label,actor_role,payload)
  values (case when blocked_text is null then 'publication_prepared' else 'publication_blocked' end,draft_row.id,publication_row.id,
    draft_row.external_item_id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('request_id',publication_row.request_id,'production_apply_enabled',publication_row.production_apply_enabled,'blocked_reason',blocked_text,'source_changed',source_changed));
  return to_jsonb(publication_row);
end;
$$;

create or replace function public.atlas_item_master_snapshot(uuid,text)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.item_master_snapshot($1,$2); $$;
create or replace function public.atlas_item_master_save_draft(uuid,text,text,jsonb,jsonb,jsonb,jsonb,integer,text,jsonb,jsonb,integer,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.item_master_save_draft($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15); $$;
create or replace function public.atlas_item_master_prepare_publication(uuid,text,jsonb,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.item_master_prepare_publication($1,$2,$3,$4,$5,$6); $$;

revoke execute on function public.atlas_item_master_snapshot(uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_item_master_save_draft(uuid,text,text,jsonb,jsonb,jsonb,jsonb,integer,text,jsonb,jsonb,integer,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_item_master_prepare_publication(uuid,text,jsonb,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_item_master_snapshot(uuid,text) to service_role;
grant execute on function public.atlas_item_master_save_draft(uuid,text,text,jsonb,jsonb,jsonb,jsonb,integer,text,jsonb,jsonb,integer,uuid,text,text) to service_role;
grant execute on function public.atlas_item_master_prepare_publication(uuid,text,jsonb,uuid,text,text) to service_role;

comment on table atlas_private.item_master_drafts is 'Checkpoint L2 manager-only item-master drafts. Drafts never alter live quantity or create inventory movements.';
comment on table atlas_private.item_master_publications is 'Explicit Checkpoint L2 publication plans. Preview production application is disabled by default and every plan preserves source evidence.';
comment on function public.atlas_item_master_snapshot(uuid,text) is 'Service-role-only Checkpoint L2 queue context, draft evidence, count activity and barcode aliases.';
