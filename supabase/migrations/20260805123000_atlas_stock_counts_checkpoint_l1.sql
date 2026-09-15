-- Checkpoint L1: manager-verified current stock-count sessions.
-- Counts are private preview evidence. Verification creates a private current
-- balance for Atlas intelligence; production inventory is never mutated here.

create table if not exists atlas_private.inventory_count_settings (
  setting_key text primary key,
  freshness_days integer not null default 7 check (freshness_days between 1 and 90),
  allow_staff_start boolean not null default true,
  allow_staff_submit boolean not null default true,
  production_apply_enabled boolean not null default false check (production_apply_enabled is false),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.inventory_count_sessions (
  id uuid primary key default gen_random_uuid(),
  session_key text not null unique,
  client_request_id text not null unique,
  title text not null,
  status text not null default 'draft'
    check (status in ('draft','submitted','verified','rejected','cancelled')),
  scope_type text not null default 'all'
    check (scope_type in ('all','location','category')),
  scope_value text,
  notes text,
  inventory_snapshot_at timestamptz not null default now(),
  source_record_count integer not null default 0 check (source_record_count >= 0),
  started_by uuid not null,
  started_by_label text not null,
  started_at timestamptz not null default now(),
  submitted_by uuid,
  submitted_by_label text,
  submitted_at timestamptz,
  verified_by uuid,
  verified_by_label text,
  verified_at timestamptz,
  rejected_by uuid,
  rejected_by_label text,
  rejected_at timestamptz,
  rejected_reason text,
  conflict_count integer not null default 0 check (conflict_count >= 0),
  conflicts_acknowledged boolean not null default false,
  production_applied boolean not null default false check (production_applied is false),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope_type='all' and scope_value is null) or (scope_type<>'all' and nullif(trim(scope_value),'') is not null)),
  check ((status='submitted' and submitted_at is not null) or status<>'submitted'),
  check ((status='verified' and verified_at is not null) or status<>'verified'),
  check ((status='rejected' and rejected_at is not null and nullif(trim(rejected_reason),'') is not null) or status<>'rejected')
);

create table if not exists atlas_private.inventory_count_lines (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references atlas_private.inventory_count_sessions(id) on delete cascade,
  inventory_item_id uuid not null,
  item_name text not null,
  category text,
  inventory_unit text not null default 'units',
  bin_location text,
  sku text,
  barcode text,
  expected_quantity numeric not null default 0,
  expected_updated_at timestamptz,
  source_updated_at date,
  source_kind text not null default 'production_observation'
    check (source_kind in ('production_observation','historical_snapshot','manager_verified_count')),
  observed_quantity numeric check (observed_quantity is null or observed_quantity >= 0),
  observed_unit text,
  line_status text not null default 'pending'
    check (line_status in ('pending','counted','skipped')),
  count_method text
    check (count_method is null or count_method in ('manual','barcode','photo','import')),
  note text,
  skipped_reason text,
  counted_by uuid,
  counted_by_label text,
  counted_at timestamptz,
  source_changed_since_start boolean not null default false,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id,inventory_item_id),
  check ((line_status='counted' and observed_quantity is not null and counted_at is not null) or line_status<>'counted'),
  check ((line_status='skipped' and nullif(trim(skipped_reason),'') is not null) or line_status<>'skipped')
);

create table if not exists atlas_private.inventory_verified_balances (
  inventory_item_id uuid primary key,
  item_name text not null,
  category text,
  inventory_unit text not null,
  bin_location text,
  verified_quantity numeric not null check (verified_quantity >= 0),
  verification_status text not null default 'current'
    check (verification_status in ('current','revoked')),
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  source_session_id uuid not null references atlas_private.inventory_count_sessions(id) on delete restrict,
  source_line_id uuid not null references atlas_private.inventory_count_lines(id) on delete restrict,
  verified_by uuid not null,
  verified_by_label text not null,
  production_quantity_at_verification numeric,
  production_updated_at timestamptz,
  variance numeric,
  source_kind text not null default 'manager_verified_count'
    check (source_kind='manager_verified_count'),
  historical boolean not null default false check (historical is false),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > verified_at)
);

create table if not exists atlas_private.inventory_count_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null
    check (event_type in ('session_started','line_saved','session_submitted','session_verified','session_rejected','session_cancelled')),
  session_id uuid references atlas_private.inventory_count_sessions(id) on delete set null,
  line_id uuid references atlas_private.inventory_count_lines(id) on delete set null,
  inventory_item_id uuid,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now()
);

create index if not exists inventory_count_sessions_status_started_idx
  on atlas_private.inventory_count_sessions(status,started_at desc);
create index if not exists inventory_count_sessions_started_by_idx
  on atlas_private.inventory_count_sessions(started_by,started_at desc);
create index if not exists inventory_count_lines_session_status_idx
  on atlas_private.inventory_count_lines(session_id,line_status,item_name);
create index if not exists inventory_count_lines_item_idx
  on atlas_private.inventory_count_lines(inventory_item_id,created_at desc);
create index if not exists inventory_verified_balances_freshness_idx
  on atlas_private.inventory_verified_balances(verification_status,expires_at);
create index if not exists inventory_count_events_session_created_idx
  on atlas_private.inventory_count_events(session_id,created_at desc);

alter table atlas_private.inventory_count_settings enable row level security;
alter table atlas_private.inventory_count_sessions enable row level security;
alter table atlas_private.inventory_count_lines enable row level security;
alter table atlas_private.inventory_verified_balances enable row level security;
alter table atlas_private.inventory_count_events enable row level security;

drop policy if exists "service role manages inventory count settings" on atlas_private.inventory_count_settings;
create policy "service role manages inventory count settings" on atlas_private.inventory_count_settings
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages inventory count sessions" on atlas_private.inventory_count_sessions;
create policy "service role manages inventory count sessions" on atlas_private.inventory_count_sessions
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages inventory count lines" on atlas_private.inventory_count_lines;
create policy "service role manages inventory count lines" on atlas_private.inventory_count_lines
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages inventory verified balances" on atlas_private.inventory_verified_balances;
create policy "service role manages inventory verified balances" on atlas_private.inventory_verified_balances
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages inventory count events" on atlas_private.inventory_count_events;
create policy "service role manages inventory count events" on atlas_private.inventory_count_events
  for all to service_role using (true) with check (true);

revoke all on atlas_private.inventory_count_settings from public,anon,authenticated;
revoke all on atlas_private.inventory_count_sessions from public,anon,authenticated;
revoke all on atlas_private.inventory_count_lines from public,anon,authenticated;
revoke all on atlas_private.inventory_verified_balances from public,anon,authenticated;
revoke all on atlas_private.inventory_count_events from public,anon,authenticated;
grant all on atlas_private.inventory_count_settings to service_role;
grant all on atlas_private.inventory_count_sessions to service_role;
grant all on atlas_private.inventory_count_lines to service_role;
grant all on atlas_private.inventory_verified_balances to service_role;
grant all on atlas_private.inventory_count_events to service_role;

drop trigger if exists inventory_count_settings_touch on atlas_private.inventory_count_settings;
create trigger inventory_count_settings_touch before update on atlas_private.inventory_count_settings
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists inventory_count_sessions_touch on atlas_private.inventory_count_sessions;
create trigger inventory_count_sessions_touch before update on atlas_private.inventory_count_sessions
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists inventory_count_lines_touch on atlas_private.inventory_count_lines;
create trigger inventory_count_lines_touch before update on atlas_private.inventory_count_lines
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists inventory_verified_balances_touch on atlas_private.inventory_verified_balances;
create trigger inventory_verified_balances_touch before update on atlas_private.inventory_verified_balances
  for each row execute function atlas_private.touch_updated_at();

insert into atlas_private.inventory_count_settings (
  setting_key,freshness_days,allow_staff_start,allow_staff_submit,production_apply_enabled
) values ('va',7,true,true,false)
on conflict (setting_key) do update set
  production_apply_enabled=false,
  updated_at=now();

create or replace function atlas_private.stock_count_session_summary(p_session_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'total_lines',count(*)::bigint,
    'counted_lines',count(*) filter (where line_status='counted')::bigint,
    'skipped_lines',count(*) filter (where line_status='skipped')::bigint,
    'pending_lines',count(*) filter (where line_status='pending')::bigint,
    'changed_source_lines',count(*) filter (where source_changed_since_start=true)::bigint,
    'progress_percent',case when count(*)=0 then 0 else round(
      100.0*(count(*) filter (where line_status in ('counted','skipped')))::numeric/count(*)::numeric,1
    ) end,
    'positive_variances',count(*) filter (where line_status='counted' and observed_quantity>expected_quantity)::bigint,
    'negative_variances',count(*) filter (where line_status='counted' and observed_quantity<expected_quantity)::bigint,
    'unchanged_lines',count(*) filter (where line_status='counted' and observed_quantity=expected_quantity)::bigint
  )
  from atlas_private.inventory_count_lines
  where session_id=p_session_id;
$$;

create or replace function atlas_private.stock_count_detail(
  p_session_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  is_manager boolean := p_actor_role in ('admin','manager');
begin
  select * into session_row
  from atlas_private.inventory_count_sessions
  where id=p_session_id;
  if not found then raise exception 'Stock-count session not found'; end if;
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'This profile cannot access stock counts';
  end if;
  if p_actor_role='viewer' and session_row.status<>'verified' then
    raise exception 'This stock-count session is not available to viewers';
  end if;

  return jsonb_build_object(
    'session',to_jsonb(session_row),
    'summary',atlas_private.stock_count_session_summary(session_row.id),
    'lines',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',line.id,
        'session_id',line.session_id,
        'inventory_item_id',line.inventory_item_id,
        'item_name',line.item_name,
        'category',line.category,
        'inventory_unit',line.inventory_unit,
        'bin_location',line.bin_location,
        'sku',line.sku,
        'barcode',line.barcode,
        'expected_quantity',line.expected_quantity,
        'expected_updated_at',line.expected_updated_at,
        'source_updated_at',line.source_updated_at,
        'source_kind',line.source_kind,
        'observed_quantity',line.observed_quantity,
        'observed_unit',line.observed_unit,
        'line_status',line.line_status,
        'count_method',line.count_method,
        'note',line.note,
        'skipped_reason',line.skipped_reason,
        'counted_by',line.counted_by,
        'counted_by_label',line.counted_by_label,
        'counted_at',line.counted_at,
        'source_changed_since_start',line.source_changed_since_start,
        'variance',case when line.observed_quantity is null then null else line.observed_quantity-line.expected_quantity end,
        'version',line.version,
        'updated_at',line.updated_at
      ) order by coalesce(line.bin_location,''),coalesce(line.category,''),line.item_name)
      from atlas_private.inventory_count_lines line
      where line.session_id=session_row.id
    ),'[]'::jsonb),
    'permissions',jsonb_build_object(
      'can_edit',(p_actor_role in ('admin','manager','bartender') and session_row.status='draft'),
      'can_submit',(p_actor_role in ('admin','manager','bartender') and session_row.status='draft'),
      'can_verify',(is_manager and session_row.status='submitted'),
      'can_reject',(is_manager and session_row.status='submitted'),
      'can_cancel',((is_manager or session_row.started_by=p_actor_id) and session_row.status in ('draft','submitted')),
      'production_apply_enabled',false
    ),
    'trust',jsonb_build_object(
      'production_inventory_mutated',false,
      'manager_verification_required',true,
      'historical_rows_are_current',false,
      'verified_balances_are_private',true
    )
  );
end;
$$;

create or replace function atlas_private.stock_count_snapshot(
  p_inventory jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  settings_row atlas_private.inventory_count_settings;
  sessions_json jsonb := '[]'::jsonb;
  catalog_json jsonb := '[]'::jsonb;
  balances_json jsonb := '[]'::jsonb;
  is_manager boolean := p_actor_role in ('admin','manager');
begin
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'This profile cannot access stock counts';
  end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then
    raise exception 'Inventory catalog must be an array';
  end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',session.id,
    'session_key',session.session_key,
    'title',session.title,
    'status',session.status,
    'scope_type',session.scope_type,
    'scope_value',session.scope_value,
    'started_by',session.started_by,
    'started_by_label',session.started_by_label,
    'started_at',session.started_at,
    'submitted_at',session.submitted_at,
    'verified_at',session.verified_at,
    'verified_by_label',session.verified_by_label,
    'conflict_count',session.conflict_count,
    'conflicts_acknowledged',session.conflicts_acknowledged,
    'version',session.version,
    'summary',atlas_private.stock_count_session_summary(session.id)
  ) order by session.started_at desc),'[]'::jsonb)
  into sessions_json
  from atlas_private.inventory_count_sessions session
  where p_actor_role<>'viewer' or session.status='verified';

  with items as (
    select item
    from jsonb_array_elements(coalesce(p_inventory,'[]'::jsonb)) item
    where coalesce((item->>'active')::boolean,true)=true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',item->>'id',
    'name',item->>'name',
    'category',item->>'category',
    'quantity',coalesce(nullif(item->>'quantity','')::numeric,0),
    'unit',coalesce(nullif(item->>'unit',''),'units'),
    'par_level',nullif(item->>'par_level','')::numeric,
    'bin_location',nullif(item->>'bin_location',''),
    'sku',nullif(item->>'sku',''),
    'barcode',nullif(item->>'barcode',''),
    'updated_at',nullif(item->>'updated_at','')::timestamptz,
    'source_updated_at',nullif(item->>'source_updated_at','')::date,
    'source_kind',case
      when balance.inventory_item_id is not null and balance.verification_status='current' and balance.expires_at>now() then 'manager_verified_count'
      when nullif(item->>'source_updated_at','')::date<=date '2026-07-26' then 'historical_snapshot'
      else 'production_observation'
    end,
    'verified_quantity',balance.verified_quantity,
    'verified_at',balance.verified_at,
    'verified_expires_at',balance.expires_at,
    'freshness_state',case
      when balance.inventory_item_id is null then 'unverified'
      when balance.verification_status<>'current' then 'revoked'
      when balance.expires_at<=now() then 'stale'
      else 'current'
    end
  ) order by coalesce(item->>'bin_location',''),coalesce(item->>'category',''),item->>'name'),'[]'::jsonb)
  into catalog_json
  from items
  left join atlas_private.inventory_verified_balances balance
    on balance.inventory_item_id=(item->>'id')::uuid;

  select coalesce(jsonb_agg(jsonb_build_object(
    'inventory_item_id',balance.inventory_item_id,
    'item_name',balance.item_name,
    'category',balance.category,
    'inventory_unit',balance.inventory_unit,
    'bin_location',balance.bin_location,
    'verified_quantity',balance.verified_quantity,
    'verified_at',balance.verified_at,
    'expires_at',balance.expires_at,
    'verified_by_label',balance.verified_by_label,
    'source_session_id',balance.source_session_id,
    'variance',balance.variance,
    'freshness_state',case
      when balance.verification_status<>'current' then 'revoked'
      when balance.expires_at<=now() then 'stale'
      else 'current'
    end
  ) order by balance.verified_at desc),'[]'::jsonb)
  into balances_json
  from atlas_private.inventory_verified_balances balance;

  return jsonb_build_object(
    'version','atlas-stock-counts/0.1.0',
    'generated_at',now(),
    'sessions',sessions_json,
    'catalog',catalog_json,
    'verified_balances',balances_json,
    'settings',to_jsonb(settings_row),
    'summary',jsonb_build_object(
      'draft_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='draft'),
      'submitted_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='submitted'),
      'verified_sessions',(select count(*)::bigint from atlas_private.inventory_count_sessions where status='verified'),
      'current_verified_balances',(select count(*)::bigint from atlas_private.inventory_verified_balances where verification_status='current' and expires_at>now()),
      'stale_verified_balances',(select count(*)::bigint from atlas_private.inventory_verified_balances where verification_status='current' and expires_at<=now()),
      'catalog_items',jsonb_array_length(catalog_json)
    ),
    'permissions',jsonb_build_object(
      'can_start',(p_actor_role in ('admin','manager') or (p_actor_role='bartender' and settings_row.allow_staff_start)),
      'can_count',(p_actor_role in ('admin','manager','bartender')),
      'can_submit',(p_actor_role in ('admin','manager') or (p_actor_role='bartender' and settings_row.allow_staff_submit)),
      'can_verify',is_manager,
      'production_apply_enabled',false
    ),
    'trust',jsonb_build_object(
      'shadow_mode',true,
      'production_inventory_mutation',false,
      'automatic_inventory_adjustment',false,
      'manager_verification_required',true,
      'historical_inventory_used_as_current',false,
      'verified_balance_source','manager_verified_count'
    )
  );
end;
$$;

create or replace function atlas_private.stock_count_start(
  p_inventory jsonb,
  p_title text,
  p_scope_type text,
  p_scope_value text,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_client_request_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  inserted_count integer;
  settings_row atlas_private.inventory_count_settings;
begin
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot start stock counts'; end if;
  if p_actor_role='bartender' and not settings_row.allow_staff_start then raise exception 'Staff-started stock counts are disabled'; end if;
  if p_scope_type not in ('all','location','category') then raise exception 'Stock-count scope is invalid'; end if;
  if p_scope_type<>'all' and nullif(trim(coalesce(p_scope_value,'')),'') is null then raise exception 'A scope value is required'; end if;
  if nullif(trim(coalesce(p_client_request_id,'')),'') is null then raise exception 'A client request ID is required'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;

  select * into session_row
  from atlas_private.inventory_count_sessions
  where client_request_id=p_client_request_id;
  if found then return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role); end if;

  insert into atlas_private.inventory_count_sessions (
    session_key,client_request_id,title,scope_type,scope_value,notes,inventory_snapshot_at,
    started_by,started_by_label
  ) values (
    'count-'||to_char(now(),'YYYYMMDD-HH24MISS')||'-'||substr(gen_random_uuid()::text,1,8),
    trim(p_client_request_id),
    coalesce(nullif(trim(coalesce(p_title,'')),''),'Current stock count'),
    p_scope_type,
    case when p_scope_type='all' then null else trim(p_scope_value) end,
    nullif(trim(coalesce(p_notes,'')),''),
    now(),p_actor_id,p_actor_label
  ) returning * into session_row;

  insert into atlas_private.inventory_count_lines (
    session_id,inventory_item_id,item_name,category,inventory_unit,bin_location,sku,barcode,
    expected_quantity,expected_updated_at,source_updated_at,source_kind,observed_unit
  )
  select
    session_row.id,
    (item->>'id')::uuid,
    coalesce(nullif(item->>'name',''),'Unnamed inventory item'),
    nullif(item->>'category',''),
    coalesce(nullif(item->>'unit',''),'units'),
    nullif(item->>'bin_location',''),
    nullif(item->>'sku',''),
    nullif(item->>'barcode',''),
    coalesce(nullif(item->>'quantity','')::numeric,0),
    nullif(item->>'updated_at','')::timestamptz,
    nullif(item->>'source_updated_at','')::date,
    case when nullif(item->>'source_updated_at','')::date<=date '2026-07-26'
      then 'historical_snapshot' else 'production_observation' end,
    coalesce(nullif(item->>'unit',''),'units')
  from jsonb_array_elements(p_inventory) item
  where coalesce((item->>'active')::boolean,true)=true
    and (
      p_scope_type='all'
      or (p_scope_type='location' and lower(coalesce(item->>'bin_location',''))=lower(trim(p_scope_value)))
      or (p_scope_type='category' and lower(coalesce(item->>'category',''))=lower(trim(p_scope_value)))
    );

  get diagnostics inserted_count=row_count;
  if inserted_count=0 then
    delete from atlas_private.inventory_count_sessions where id=session_row.id;
    raise exception 'No active inventory items match this stock-count scope';
  end if;

  update atlas_private.inventory_count_sessions
  set source_record_count=inserted_count
  where id=session_row.id;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_started',session_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('scope_type',p_scope_type,'scope_value',case when p_scope_type='all' then null else trim(p_scope_value) end,'source_record_count',inserted_count)
  );

  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

create or replace function atlas_private.stock_count_save_line(
  p_session_id uuid,
  p_line_id uuid,
  p_line_status text,
  p_observed_quantity numeric,
  p_count_method text,
  p_note text,
  p_skipped_reason text,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  line_row atlas_private.inventory_count_lines;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot count inventory'; end if;
  if p_line_status not in ('pending','counted','skipped') then raise exception 'Count-line status is invalid'; end if;
  if p_count_method is not null and p_count_method not in ('manual','barcode','photo','import') then raise exception 'Count method is invalid'; end if;
  if p_line_status='counted' and (p_observed_quantity is null or p_observed_quantity<0) then raise exception 'A counted line requires a quantity of zero or more'; end if;
  if p_line_status='skipped' and nullif(trim(coalesce(p_skipped_reason,'')),'') is null then raise exception 'A skipped line requires a reason'; end if;

  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status<>'draft' then raise exception 'Only draft stock counts can be edited'; end if;

  update atlas_private.inventory_count_lines
  set line_status=p_line_status,
      observed_quantity=case when p_line_status='counted' then p_observed_quantity else null end,
      observed_unit=case when p_line_status='counted' then inventory_unit else observed_unit end,
      count_method=case when p_line_status='counted' then coalesce(p_count_method,'manual') else null end,
      note=nullif(trim(coalesce(p_note,'')),''),
      skipped_reason=case when p_line_status='skipped' then trim(p_skipped_reason) else null end,
      counted_by=case when p_line_status='counted' then p_actor_id else null end,
      counted_by_label=case when p_line_status='counted' then p_actor_label else null end,
      counted_at=case when p_line_status='counted' then now() else null end,
      version=version+1
  where id=p_line_id and session_id=p_session_id and version=p_expected_version
  returning * into line_row;
  if not found then raise exception 'This count line changed in another session. Refresh and try again'; end if;

  update atlas_private.inventory_count_sessions
  set version=version+1
  where id=p_session_id;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,line_id,inventory_item_id,actor_id,actor_label,actor_role,payload
  ) values (
    'line_saved',p_session_id,line_row.id,line_row.inventory_item_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('line_status',line_row.line_status,'observed_quantity',line_row.observed_quantity,'count_method',line_row.count_method,'line_version',line_row.version)
  );

  return jsonb_build_object('line',to_jsonb(line_row),'summary',atlas_private.stock_count_session_summary(p_session_id));
end;
$$;

create or replace function atlas_private.stock_count_submit(
  p_session_id uuid,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  pending_count integer;
  settings_row atlas_private.inventory_count_settings;
begin
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot submit stock counts'; end if;
  if p_actor_role='bartender' and not settings_row.allow_staff_submit then raise exception 'Staff stock-count submission is disabled'; end if;
  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status='submitted' then return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role); end if;
  if session_row.status<>'draft' then raise exception 'Only draft stock counts can be submitted'; end if;
  select count(*) into pending_count from atlas_private.inventory_count_lines where session_id=p_session_id and line_status='pending';
  if pending_count>0 then raise exception 'Complete or skip every count line before submission'; end if;

  update atlas_private.inventory_count_sessions
  set status='submitted',submitted_by=p_actor_id,submitted_by_label=p_actor_label,submitted_at=now(),
      notes=coalesce(nullif(trim(coalesce(p_notes,'')),''),notes),version=version+1
  where id=p_session_id
  returning * into session_row;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_submitted',session_row.id,p_actor_id,p_actor_label,p_actor_role,
    atlas_private.stock_count_session_summary(session_row.id)
  );
  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

create or replace function atlas_private.stock_count_verify(
  p_session_id uuid,
  p_inventory jsonb,
  p_acknowledge_conflicts boolean,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  conflict_count_value integer := 0;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can verify stock counts'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status='verified' then return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role); end if;
  if session_row.status<>'submitted' then raise exception 'Only submitted stock counts can be verified'; end if;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      coalesce(nullif(item->>'quantity','')::numeric,0) as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  select count(*) into conflict_count_value
  from atlas_private.inventory_count_lines line
  left join current_inventory current on current.inventory_item_id=line.inventory_item_id
  where line.session_id=p_session_id and line.line_status='counted'
    and (
      current.inventory_item_id is null
      or current.quantity is distinct from line.expected_quantity
      or current.updated_at is distinct from line.expected_updated_at
    );

  if conflict_count_value>0 and not coalesce(p_acknowledge_conflicts,false) then
    raise exception 'The production source changed for % counted item(s). Review and acknowledge the conflicts before verification',conflict_count_value;
  end if;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      coalesce(nullif(item->>'quantity','')::numeric,0) as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  update atlas_private.inventory_count_lines line
  set source_changed_since_start=(
    current.inventory_item_id is null
    or current.quantity is distinct from line.expected_quantity
    or current.updated_at is distinct from line.expected_updated_at
  )
  from current_inventory current
  where line.session_id=p_session_id and line.inventory_item_id=current.inventory_item_id;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      coalesce(nullif(item->>'quantity','')::numeric,0) as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  insert into atlas_private.inventory_verified_balances (
    inventory_item_id,item_name,category,inventory_unit,bin_location,verified_quantity,
    verification_status,verified_at,expires_at,source_session_id,source_line_id,
    verified_by,verified_by_label,production_quantity_at_verification,production_updated_at,variance
  )
  select
    line.inventory_item_id,line.item_name,line.category,line.inventory_unit,line.bin_location,line.observed_quantity,
    'current',now(),now()+make_interval(days=>settings_row.freshness_days),line.session_id,line.id,
    p_actor_id,p_actor_label,current.quantity,current.updated_at,line.observed_quantity-current.quantity
  from atlas_private.inventory_count_lines line
  left join current_inventory current on current.inventory_item_id=line.inventory_item_id
  where line.session_id=p_session_id and line.line_status='counted'
  on conflict (inventory_item_id) do update set
    item_name=excluded.item_name,
    category=excluded.category,
    inventory_unit=excluded.inventory_unit,
    bin_location=excluded.bin_location,
    verified_quantity=excluded.verified_quantity,
    verification_status='current',
    verified_at=excluded.verified_at,
    expires_at=excluded.expires_at,
    source_session_id=excluded.source_session_id,
    source_line_id=excluded.source_line_id,
    verified_by=excluded.verified_by,
    verified_by_label=excluded.verified_by_label,
    production_quantity_at_verification=excluded.production_quantity_at_verification,
    production_updated_at=excluded.production_updated_at,
    variance=excluded.variance,
    source_kind='manager_verified_count',
    historical=false,
    updated_at=now();

  update atlas_private.inventory_count_sessions
  set status='verified',verified_by=p_actor_id,verified_by_label=p_actor_label,verified_at=now(),
      conflict_count=conflict_count_value,conflicts_acknowledged=(conflict_count_value=0 or coalesce(p_acknowledge_conflicts,false)),
      version=version+1
  where id=p_session_id
  returning * into session_row;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_verified',session_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('conflict_count',conflict_count_value,'conflicts_acknowledged',session_row.conflicts_acknowledged,'freshness_days',settings_row.freshness_days,'production_applied',false)
  );

  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

create or replace function atlas_private.stock_count_reject(
  p_session_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare session_row atlas_private.inventory_count_sessions;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can reject stock counts'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A rejection reason is required'; end if;
  update atlas_private.inventory_count_sessions
  set status='rejected',rejected_by=p_actor_id,rejected_by_label=p_actor_label,rejected_at=now(),
      rejected_reason=trim(p_reason),version=version+1
  where id=p_session_id and status='submitted'
  returning * into session_row;
  if not found then raise exception 'Only a submitted stock count can be rejected'; end if;
  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values ('session_rejected',session_row.id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('reason',trim(p_reason)));
  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

create or replace function atlas_private.stock_count_cancel(
  p_session_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare session_row atlas_private.inventory_count_sessions;
begin
  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if p_actor_role not in ('admin','manager') and session_row.started_by<>p_actor_id then raise exception 'This profile cannot cancel this stock count'; end if;
  if session_row.status not in ('draft','submitted') then raise exception 'This stock count can no longer be cancelled'; end if;
  update atlas_private.inventory_count_sessions
  set status='cancelled',rejected_reason=nullif(trim(coalesce(p_reason,'')),''),version=version+1
  where id=p_session_id
  returning * into session_row;
  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values ('session_cancelled',session_row.id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('reason',nullif(trim(coalesce(p_reason,'')),'')));
  return atlas_private.stock_count_detail(session_row.id,p_actor_id,p_actor_role);
end;
$$;

create or replace function atlas_private.stock_count_verified_balances()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'inventory_item_id',balance.inventory_item_id,
    'item_name',balance.item_name,
    'category',balance.category,
    'inventory_unit',balance.inventory_unit,
    'bin_location',balance.bin_location,
    'verified_quantity',balance.verified_quantity,
    'verified_at',balance.verified_at,
    'expires_at',balance.expires_at,
    'source_session_id',balance.source_session_id,
    'source_line_id',balance.source_line_id,
    'verified_by_label',balance.verified_by_label,
    'production_quantity_at_verification',balance.production_quantity_at_verification,
    'production_updated_at',balance.production_updated_at,
    'variance',balance.variance,
    'source_kind',balance.source_kind,
    'historical',balance.historical,
    'freshness_state',case
      when balance.verification_status<>'current' then 'revoked'
      when balance.expires_at<=now() then 'stale'
      else 'current'
    end
  ) order by balance.verified_at desc),'[]'::jsonb)
  from atlas_private.inventory_verified_balances balance;
$$;

create or replace function public.atlas_stock_count_snapshot(jsonb,uuid,text)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.stock_count_snapshot($1,$2,$3); $$;
create or replace function public.atlas_stock_count_detail(uuid,uuid,text)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.stock_count_detail($1,$2,$3); $$;
create or replace function public.atlas_stock_count_start(jsonb,text,text,text,text,uuid,text,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_start($1,$2,$3,$4,$5,$6,$7,$8,$9); $$;
create or replace function public.atlas_stock_count_save_line(uuid,uuid,text,numeric,text,text,text,integer,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_save_line($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11); $$;
create or replace function public.atlas_stock_count_submit(uuid,text,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_submit($1,$2,$3,$4,$5); $$;
create or replace function public.atlas_stock_count_verify(uuid,jsonb,boolean,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_verify($1,$2,$3,$4,$5,$6); $$;
create or replace function public.atlas_stock_count_reject(uuid,text,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_reject($1,$2,$3,$4,$5); $$;
create or replace function public.atlas_stock_count_cancel(uuid,text,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.stock_count_cancel($1,$2,$3,$4,$5); $$;
create or replace function public.atlas_stock_count_verified_balances()
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.stock_count_verified_balances(); $$;

revoke execute on function public.atlas_stock_count_snapshot(jsonb,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_stock_count_detail(uuid,uuid,text) from public,anon,authenticated;
revoke execute on function public.atlas_stock_count_start(jsonb,text,text,text,text,uuid,text,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_stock_count_save_line(uuid,uuid,text,numeric,text,text,text,integer,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_stock_count_submit(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_stock_count_verify(uuid,jsonb,boolean,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_stock_count_reject(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_stock_count_cancel(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_stock_count_verified_balances() from public,anon,authenticated;
grant execute on function public.atlas_stock_count_snapshot(jsonb,uuid,text) to service_role;
grant execute on function public.atlas_stock_count_detail(uuid,uuid,text) to service_role;
grant execute on function public.atlas_stock_count_start(jsonb,text,text,text,text,uuid,text,text,text) to service_role;
grant execute on function public.atlas_stock_count_save_line(uuid,uuid,text,numeric,text,text,text,integer,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_submit(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_verify(uuid,jsonb,boolean,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_reject(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_cancel(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_verified_balances() to service_role;

comment on table atlas_private.inventory_count_sessions is
  'Private Checkpoint L1 count sessions. Verification records evidence only; production inventory is never changed.';
comment on table atlas_private.inventory_verified_balances is
  'Manager-verified current stock evidence used by Atlas intelligence until its freshness window expires.';
comment on function public.atlas_stock_count_verified_balances() is
  'Service-role-only current count evidence for evidence-gated Atlas intelligence.';
