-- Checkpoint B - Phone bottle scanner.
-- Barcode aliases and scanner audit events remain private. Preview count submissions
-- default to shadow mode so the isolated branch cannot silently change live inventory.

create table if not exists atlas_private.inventory_scanner_settings (
  setting_key text primary key,
  live_apply_enabled boolean not null default false,
  allow_staff_linking boolean not null default false,
  allowed_formats text[] not null default array['ean_13','ean_8','upc_a','upc_e','code_128','code_39']::text[],
  max_observed_quantity numeric not null default 100000 check (max_observed_quantity > 0),
  zxing_version text not null default '0.2.1',
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.inventory_scan_aliases (
  id uuid primary key default gen_random_uuid(),
  normalized_code text not null unique,
  raw_code text not null,
  symbology text not null default 'unknown',
  external_item_id uuid not null,
  external_item_name text not null,
  external_item_category text,
  external_item_unit text,
  active boolean not null default true,
  verified boolean not null default true,
  linked_by uuid,
  linked_by_label text,
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz,
  scan_count bigint not null default 0 check (scan_count >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(normalized_code) between 3 and 128),
  check (char_length(raw_code) between 1 and 256)
);

create table if not exists atlas_private.inventory_scan_events (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid unique,
  event_type text not null check (event_type in ('code_linked','count_recorded','count_applied','count_no_change','count_failed','code_unlinked')),
  status text not null check (status in ('linked','shadow_recorded','pending_live','live_applied','no_change','failed','unlinked')),
  alias_id uuid references atlas_private.inventory_scan_aliases(id) on delete set null,
  normalized_code text not null,
  raw_code text not null,
  symbology text not null default 'unknown',
  external_item_id uuid not null,
  external_item_name text not null,
  external_item_category text,
  previous_quantity numeric,
  observed_quantity numeric,
  applied_quantity numeric,
  quantity_delta numeric,
  unit text,
  note text,
  source text not null default 'manual' check (source in ('camera_native','camera_zxing','image_native','image_zxing','manual')),
  actor_id uuid,
  actor_label text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  check (char_length(normalized_code) between 3 and 128),
  check (observed_quantity is null or observed_quantity >= 0),
  check (previous_quantity is null or previous_quantity >= 0),
  check (applied_quantity is null or applied_quantity >= 0)
);

create index if not exists inventory_scan_aliases_item_idx
  on atlas_private.inventory_scan_aliases(external_item_id,active);
create index if not exists inventory_scan_aliases_seen_idx
  on atlas_private.inventory_scan_aliases(last_seen_at desc nulls last);
create index if not exists inventory_scan_events_created_idx
  on atlas_private.inventory_scan_events(created_at desc);
create index if not exists inventory_scan_events_item_idx
  on atlas_private.inventory_scan_events(external_item_id,created_at desc);
create index if not exists inventory_scan_events_code_idx
  on atlas_private.inventory_scan_events(normalized_code,created_at desc);

alter table atlas_private.inventory_scanner_settings enable row level security;
alter table atlas_private.inventory_scan_aliases enable row level security;
alter table atlas_private.inventory_scan_events enable row level security;

drop policy if exists "service role manages inventory scanner settings" on atlas_private.inventory_scanner_settings;
create policy "service role manages inventory scanner settings"
  on atlas_private.inventory_scanner_settings for all to service_role
  using (true) with check (true);
drop policy if exists "service role manages inventory scan aliases" on atlas_private.inventory_scan_aliases;
create policy "service role manages inventory scan aliases"
  on atlas_private.inventory_scan_aliases for all to service_role
  using (true) with check (true);
drop policy if exists "service role manages inventory scan events" on atlas_private.inventory_scan_events;
create policy "service role manages inventory scan events"
  on atlas_private.inventory_scan_events for all to service_role
  using (true) with check (true);

revoke all on atlas_private.inventory_scanner_settings from public,anon,authenticated;
revoke all on atlas_private.inventory_scan_aliases from public,anon,authenticated;
revoke all on atlas_private.inventory_scan_events from public,anon,authenticated;
grant all on atlas_private.inventory_scanner_settings to service_role;
grant all on atlas_private.inventory_scan_aliases to service_role;
grant all on atlas_private.inventory_scan_events to service_role;

drop trigger if exists inventory_scanner_settings_touch on atlas_private.inventory_scanner_settings;
create trigger inventory_scanner_settings_touch
  before update on atlas_private.inventory_scanner_settings
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists inventory_scan_aliases_touch on atlas_private.inventory_scan_aliases;
create trigger inventory_scan_aliases_touch
  before update on atlas_private.inventory_scan_aliases
  for each row execute function atlas_private.touch_updated_at();

insert into atlas_private.inventory_scanner_settings (
  setting_key,live_apply_enabled,allow_staff_linking,allowed_formats,max_observed_quantity,zxing_version,metadata
) values (
  'va',false,false,array['ean_13','ean_8','upc_a','upc_e','code_128','code_39']::text[],100000,'0.2.1',
  '{"preview_safety":"Live inventory mutation remains disabled until browser acceptance and production release approval.","label_recognition":"future_checkpoint","camera_requires_secure_context":true}'::jsonb
)
on conflict (setting_key) do update set
  allowed_formats=excluded.allowed_formats,
  max_observed_quantity=excluded.max_observed_quantity,
  zxing_version=excluded.zxing_version,
  metadata=excluded.metadata,
  updated_at=now();

create or replace function atlas_private.normalize_scan_code(p_code text)
returns text
language sql
immutable
security invoker
set search_path=''
as $$
  select case
    when nullif(pg_catalog.btrim(p_code),'') is null then null
    when pg_catalog.btrim(p_code) ~ '^[0-9[:space:]-]+$'
      then pg_catalog.regexp_replace(pg_catalog.btrim(p_code),'[^0-9]','','g')
    else pg_catalog.upper(pg_catalog.regexp_replace(pg_catalog.btrim(p_code),'[[:space:]]+','','g'))
  end;
$$;

create or replace function atlas_private.inventory_scanner_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'version','atlas-inventory-scanner/0.1.0',
    'settings',jsonb_build_object(
      'live_apply_enabled',settings.live_apply_enabled,
      'allow_staff_linking',settings.allow_staff_linking,
      'allowed_formats',settings.allowed_formats,
      'max_observed_quantity',settings.max_observed_quantity,
      'zxing_version',settings.zxing_version,
      'metadata',settings.metadata
    ),
    'summary',jsonb_build_object(
      'active_aliases',(select count(*) from atlas_private.inventory_scan_aliases where active=true),
      'count_events',(select count(*) from atlas_private.inventory_scan_events where event_type in ('count_recorded','count_applied','count_no_change')),
      'last_scan_at',(select max(created_at) from atlas_private.inventory_scan_events)
    ),
    'recent_events',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',event.id,
        'event_type',event.event_type,
        'status',event.status,
        'code',event.raw_code,
        'symbology',event.symbology,
        'item_id',event.external_item_id,
        'item_name',event.external_item_name,
        'previous_quantity',event.previous_quantity,
        'observed_quantity',event.observed_quantity,
        'applied_quantity',event.applied_quantity,
        'unit',event.unit,
        'actor_label',event.actor_label,
        'created_at',event.created_at
      ) order by event.created_at desc)
      from (
        select * from atlas_private.inventory_scan_events
        order by created_at desc
        limit 20
      ) event
    ),'[]'::jsonb),
    'trust',jsonb_build_object(
      'private_branch',true,
      'direct_browser_table_access',false,
      'live_inventory_mutation_enabled',settings.live_apply_enabled,
      'uncertain_image_match_auto_apply',false,
      'audit_events_preserved',true
    )
  )
  from atlas_private.inventory_scanner_settings settings
  where settings.setting_key='va';
$$;

create or replace function atlas_private.inventory_scanner_lookup(p_code text)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  with normalized as (
    select atlas_private.normalize_scan_code(p_code) as code
  ), matched as (
    select alias.*
    from atlas_private.inventory_scan_aliases alias, normalized
    where alias.normalized_code=normalized.code and alias.active=true
    limit 1
  )
  select jsonb_build_object(
    'normalized_code',(select code from normalized),
    'matched',exists(select 1 from matched),
    'alias',case when exists(select 1 from matched) then (
      select jsonb_build_object(
        'id',id,
        'normalized_code',normalized_code,
        'raw_code',raw_code,
        'symbology',symbology,
        'item_id',external_item_id,
        'item_name',external_item_name,
        'item_category',external_item_category,
        'item_unit',external_item_unit,
        'verified',verified,
        'linked_by_label',linked_by_label,
        'linked_at',linked_at,
        'last_seen_at',last_seen_at,
        'scan_count',scan_count
      ) from matched
    ) else null end
  );
$$;

create or replace function atlas_private.inventory_scanner_link_code(
  p_raw_code text,
  p_symbology text,
  p_item_id uuid,
  p_item_name text,
  p_item_category text,
  p_item_unit text,
  p_actor_id uuid,
  p_actor_label text,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  normalized text := atlas_private.normalize_scan_code(p_raw_code);
  alias_row atlas_private.inventory_scan_aliases;
  existing_item uuid;
begin
  if normalized is null or char_length(normalized) < 3 or char_length(normalized) > 128 then
    raise exception 'Barcode or SKU must contain between 3 and 128 characters';
  end if;
  if p_item_id is null or nullif(trim(coalesce(p_item_name,'')),'') is null then
    raise exception 'A valid inventory item is required';
  end if;

  select external_item_id into existing_item
  from atlas_private.inventory_scan_aliases
  where normalized_code=normalized and active=true;
  if existing_item is not null and existing_item<>p_item_id then
    raise exception 'This code is already linked to another inventory item';
  end if;

  insert into atlas_private.inventory_scan_aliases (
    normalized_code,raw_code,symbology,external_item_id,external_item_name,
    external_item_category,external_item_unit,active,verified,linked_by,linked_by_label,last_seen_at
  ) values (
    normalized,p_raw_code,coalesce(nullif(trim(p_symbology),''),'unknown'),p_item_id,p_item_name,
    p_item_category,p_item_unit,true,true,p_actor_id,p_actor_label,now()
  )
  on conflict (normalized_code) do update set
    raw_code=excluded.raw_code,
    symbology=excluded.symbology,
    external_item_id=excluded.external_item_id,
    external_item_name=excluded.external_item_name,
    external_item_category=excluded.external_item_category,
    external_item_unit=excluded.external_item_unit,
    active=true,
    verified=true,
    linked_by=excluded.linked_by,
    linked_by_label=excluded.linked_by_label,
    linked_at=now(),
    last_seen_at=now()
  returning * into alias_row;

  if p_client_request_id is null or not exists (
    select 1 from atlas_private.inventory_scan_events where client_request_id=p_client_request_id
  ) then
    insert into atlas_private.inventory_scan_events (
      client_request_id,event_type,status,alias_id,normalized_code,raw_code,symbology,
      external_item_id,external_item_name,external_item_category,unit,source,actor_id,actor_label,metadata
    ) values (
      p_client_request_id,'code_linked','linked',alias_row.id,normalized,p_raw_code,alias_row.symbology,
      p_item_id,p_item_name,p_item_category,p_item_unit,'manual',p_actor_id,p_actor_label,
      jsonb_build_object('verified',true)
    );
  end if;

  return atlas_private.inventory_scanner_lookup(p_raw_code);
end;
$$;

create or replace function atlas_private.inventory_scanner_record_count(
  p_client_request_id uuid,
  p_raw_code text,
  p_symbology text,
  p_item_id uuid,
  p_item_name text,
  p_item_category text,
  p_previous_quantity numeric,
  p_observed_quantity numeric,
  p_applied_quantity numeric,
  p_unit text,
  p_note text,
  p_source text,
  p_status text,
  p_actor_id uuid,
  p_actor_label text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  normalized text := atlas_private.normalize_scan_code(p_raw_code);
  alias_row atlas_private.inventory_scan_aliases;
  event_row atlas_private.inventory_scan_events;
  max_quantity numeric;
  derived_event_type text;
begin
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;

  select * into event_row
  from atlas_private.inventory_scan_events
  where client_request_id=p_client_request_id;
  if found then
    return jsonb_build_object('duplicate',true,'event',to_jsonb(event_row));
  end if;

  select max_observed_quantity into max_quantity
  from atlas_private.inventory_scanner_settings where setting_key='va';
  if p_observed_quantity is null or p_observed_quantity<0 or p_observed_quantity>coalesce(max_quantity,100000) then
    raise exception 'Observed quantity is outside the accepted range';
  end if;
  if p_previous_quantity is not null and p_previous_quantity<0 then
    raise exception 'Previous quantity cannot be negative';
  end if;
  if p_status not in ('shadow_recorded','pending_live','live_applied','no_change','failed') then
    raise exception 'Invalid scanner count status';
  end if;
  if p_source not in ('camera_native','camera_zxing','image_native','image_zxing','manual') then
    raise exception 'Invalid scanner source';
  end if;

  select * into alias_row
  from atlas_private.inventory_scan_aliases
  where normalized_code=normalized and active=true;
  if found and alias_row.external_item_id<>p_item_id then
    raise exception 'Scanned code is linked to a different inventory item';
  end if;

  derived_event_type := case
    when p_status='live_applied' then 'count_applied'
    when p_status='no_change' then 'count_no_change'
    when p_status='failed' then 'count_failed'
    else 'count_recorded'
  end;

  insert into atlas_private.inventory_scan_events (
    client_request_id,event_type,status,alias_id,normalized_code,raw_code,symbology,
    external_item_id,external_item_name,external_item_category,previous_quantity,
    observed_quantity,applied_quantity,quantity_delta,unit,note,source,actor_id,actor_label,metadata,finalized_at
  ) values (
    p_client_request_id,derived_event_type,p_status,alias_row.id,normalized,p_raw_code,
    coalesce(nullif(trim(p_symbology),''),'unknown'),p_item_id,p_item_name,p_item_category,
    p_previous_quantity,p_observed_quantity,p_applied_quantity,
    case when p_previous_quantity is null then null else p_observed_quantity-p_previous_quantity end,
    p_unit,nullif(trim(coalesce(p_note,'')),''),p_source,p_actor_id,p_actor_label,
    coalesce(p_metadata,'{}'::jsonb),
    case when p_status in ('live_applied','no_change','failed','shadow_recorded') then now() else null end
  ) returning * into event_row;

  if alias_row.id is not null then
    update atlas_private.inventory_scan_aliases
    set last_seen_at=now(),scan_count=scan_count+1
    where id=alias_row.id;
  end if;

  return jsonb_build_object('duplicate',false,'event',to_jsonb(event_row));
end;
$$;

create or replace function atlas_private.inventory_scanner_finalize_count(
  p_event_id uuid,
  p_status text,
  p_applied_quantity numeric,
  p_metadata jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare event_row atlas_private.inventory_scan_events;
begin
  if p_status not in ('live_applied','no_change','failed') then
    raise exception 'Invalid final scanner status';
  end if;
  update atlas_private.inventory_scan_events
  set status=p_status,
      event_type=case when p_status='live_applied' then 'count_applied' when p_status='no_change' then 'count_no_change' else 'count_failed' end,
      applied_quantity=p_applied_quantity,
      metadata=metadata || coalesce(p_metadata,'{}'::jsonb),
      finalized_at=now()
  where id=p_event_id and status='pending_live'
  returning * into event_row;
  if not found then
    select * into event_row from atlas_private.inventory_scan_events where id=p_event_id;
  end if;
  if event_row.id is null then raise exception 'Scanner count event not found'; end if;
  return to_jsonb(event_row);
end;
$$;

create or replace function public.atlas_inventory_scanner_snapshot()
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.inventory_scanner_snapshot(); $$;

create or replace function public.atlas_inventory_scanner_lookup(p_code text)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.inventory_scanner_lookup(p_code); $$;

create or replace function public.atlas_inventory_scanner_link_code(
  p_raw_code text,p_symbology text,p_item_id uuid,p_item_name text,p_item_category text,p_item_unit text,
  p_actor_id uuid,p_actor_label text,p_client_request_id uuid
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.inventory_scanner_link_code(p_raw_code,p_symbology,p_item_id,p_item_name,p_item_category,p_item_unit,p_actor_id,p_actor_label,p_client_request_id); $$;

create or replace function public.atlas_inventory_scanner_record_count(
  p_client_request_id uuid,p_raw_code text,p_symbology text,p_item_id uuid,p_item_name text,p_item_category text,
  p_previous_quantity numeric,p_observed_quantity numeric,p_applied_quantity numeric,p_unit text,p_note text,p_source text,
  p_status text,p_actor_id uuid,p_actor_label text,p_metadata jsonb
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.inventory_scanner_record_count(p_client_request_id,p_raw_code,p_symbology,p_item_id,p_item_name,p_item_category,p_previous_quantity,p_observed_quantity,p_applied_quantity,p_unit,p_note,p_source,p_status,p_actor_id,p_actor_label,p_metadata); $$;

create or replace function public.atlas_inventory_scanner_finalize_count(
  p_event_id uuid,p_status text,p_applied_quantity numeric,p_metadata jsonb
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.inventory_scanner_finalize_count(p_event_id,p_status,p_applied_quantity,p_metadata); $$;

revoke execute on function public.atlas_inventory_scanner_snapshot() from public,anon,authenticated;
revoke execute on function public.atlas_inventory_scanner_lookup(text) from public,anon,authenticated;
revoke execute on function public.atlas_inventory_scanner_link_code(text,text,uuid,text,text,text,uuid,text,uuid) from public,anon,authenticated;
revoke execute on function public.atlas_inventory_scanner_record_count(uuid,text,text,uuid,text,text,numeric,numeric,numeric,text,text,text,text,uuid,text,jsonb) from public,anon,authenticated;
revoke execute on function public.atlas_inventory_scanner_finalize_count(uuid,text,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.atlas_inventory_scanner_snapshot() to service_role;
grant execute on function public.atlas_inventory_scanner_lookup(text) to service_role;
grant execute on function public.atlas_inventory_scanner_link_code(text,text,uuid,text,text,text,uuid,text,uuid) to service_role;
grant execute on function public.atlas_inventory_scanner_record_count(uuid,text,text,uuid,text,text,numeric,numeric,numeric,text,text,text,text,uuid,text,jsonb) to service_role;
grant execute on function public.atlas_inventory_scanner_finalize_count(uuid,text,numeric,jsonb) to service_role;

comment on table atlas_private.inventory_scan_aliases is 'Private barcode/SKU aliases linked to production inventory item IDs; no direct browser access.';
comment on table atlas_private.inventory_scan_events is 'Audited scanner links and count observations. Preview defaults to shadow recording rather than live inventory mutation.';
comment on function public.atlas_inventory_scanner_snapshot() is 'Service-role-only scanner configuration and audit summary.';
