-- Phase 2 / P2.3 — Checkpoint M: deterministic POS product mapping.
--
-- This is a private, review-first mapping foundation. It does not ingest sales
-- facts, calculate revenue, enable ordering or feed sales intelligence to Brain.
-- External POS products must be staged by an authorized server connector and
-- every usable mapping must be approved by a manager or administrator.

do $checkpoint_m_invariants$
begin
  if to_regclass('atlas_private.integration_connections') is null then
    raise exception 'Checkpoint M requires the canonical P2.0 connection registry';
  end if;
end
$checkpoint_m_invariants$;

create table if not exists atlas_private.pos_mapping_settings (
  setting_key text primary key,
  provider_key text not null references atlas_private.integration_connections(provider_key)
    on update cascade on delete restrict,
  sales_ingestion_enabled boolean not null default false
    check (sales_ingestion_enabled is false),
  automatic_mapping_enabled boolean not null default false
    check (automatic_mapping_enabled is false),
  minimum_candidate_score numeric(5,4) not null default 0.35
    check (minimum_candidate_score between 0 and 1),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.pos_mapping_targets (
  id uuid primary key default gen_random_uuid(),
  production_recipe_id uuid not null unique,
  target_key text not null unique,
  name text not null,
  normalized_name text not null,
  product_type text,
  category_id uuid,
  menu_price numeric,
  show_on_menu boolean not null default false,
  active boolean not null default true,
  source_updated_at timestamptz,
  refreshed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(target_key) between 3 and 180),
  check (char_length(name) between 1 and 240),
  check (char_length(normalized_name) between 1 and 240)
);

create index if not exists pos_mapping_targets_name_idx
  on atlas_private.pos_mapping_targets(normalized_name,active);
create index if not exists pos_mapping_targets_active_idx
  on atlas_private.pos_mapping_targets(active,show_on_menu,name);

create table if not exists atlas_private.pos_import_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  provider_key text not null references atlas_private.integration_connections(provider_key)
    on update cascade on delete restrict,
  status text not null default 'staged'
    check (status in ('staged','review','mapped','failed','retired')),
  source_record_count integer not null default 0 check (source_record_count>=0),
  created_by uuid,
  created_by_label text,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.pos_products (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references atlas_private.pos_import_runs(id) on delete cascade,
  provider_key text not null references atlas_private.integration_connections(provider_key)
    on update cascade on delete restrict,
  external_product_id text not null,
  external_sku text,
  name text not null,
  normalized_name text not null,
  category text,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_key,external_product_id),
  check (char_length(external_product_id) between 1 and 500),
  check (external_sku is null or char_length(external_sku)<=500),
  check (char_length(name) between 1 and 240),
  check (char_length(normalized_name) between 1 and 240)
);

create index if not exists pos_products_run_idx
  on atlas_private.pos_products(run_id,active,name);
create index if not exists pos_products_name_idx
  on atlas_private.pos_products(normalized_name,active);

create table if not exists atlas_private.pos_product_candidates (
  product_id uuid not null references atlas_private.pos_products(id) on delete cascade,
  target_id uuid not null references atlas_private.pos_mapping_targets(id) on delete cascade,
  candidate_rank integer not null check (candidate_rank between 1 and 20),
  score numeric(5,4) not null check (score between 0 and 1),
  strategy text not null check (strategy in ('exact_name','contained_name','token_overlap')),
  explanation jsonb not null default '{}'::jsonb
    check (jsonb_typeof(explanation)='object'),
  generated_at timestamptz not null default now(),
  primary key (product_id,target_id)
);

create index if not exists pos_candidates_product_rank_idx
  on atlas_private.pos_product_candidates(product_id,candidate_rank,score desc);

create table if not exists atlas_private.pos_product_mappings (
  product_id uuid primary key references atlas_private.pos_products(id) on delete cascade,
  target_id uuid references atlas_private.pos_mapping_targets(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','ignored')),
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  mapping_source text not null default 'deterministic_candidate'
    check (mapping_source in ('deterministic_candidate','manager','imported')),
  decision_note text,
  decided_by uuid,
  decided_by_label text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status='approved' and target_id is not null and decided_at is not null)
    or status<>'approved'
  ),
  check (decision_note is null or char_length(decision_note)<=2000)
);

create index if not exists pos_mappings_status_idx
  on atlas_private.pos_product_mappings(status,updated_at desc);
create index if not exists pos_mappings_target_idx
  on atlas_private.pos_product_mappings(target_id,status)
  where target_id is not null;

create table if not exists atlas_private.pos_mapping_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'foundation_initialized','target_catalog_refreshed','products_staged',
    'candidates_generated','mapping_approved','mapping_rejected',
    'mapping_ignored','mapping_reset','connector_blocked'
  )),
  run_id uuid references atlas_private.pos_import_runs(id) on delete set null,
  product_id uuid references atlas_private.pos_products(id) on delete set null,
  target_id uuid references atlas_private.pos_mapping_targets(id) on delete set null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now()
);

create index if not exists pos_mapping_events_created_idx
  on atlas_private.pos_mapping_events(created_at desc);
create index if not exists pos_mapping_events_product_idx
  on atlas_private.pos_mapping_events(product_id,created_at desc)
  where product_id is not null;

alter table atlas_private.pos_mapping_settings enable row level security;
alter table atlas_private.pos_mapping_targets enable row level security;
alter table atlas_private.pos_import_runs enable row level security;
alter table atlas_private.pos_products enable row level security;
alter table atlas_private.pos_product_candidates enable row level security;
alter table atlas_private.pos_product_mappings enable row level security;
alter table atlas_private.pos_mapping_events enable row level security;

do $checkpoint_m_grants$
declare
  table_name text;
begin
  foreach table_name in array array[
    'pos_mapping_settings','pos_mapping_targets','pos_import_runs','pos_products',
    'pos_product_candidates','pos_product_mappings','pos_mapping_events'
  ]
  loop
    execute format('revoke all on atlas_private.%I from public,anon,authenticated',table_name);
    execute format('grant all on atlas_private.%I to service_role',table_name);
    execute format('drop policy if exists %I on atlas_private.%I',table_name || '_service_only',table_name);
    execute format(
      'create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',
      table_name || '_service_only',table_name
    );
  end loop;
end
$checkpoint_m_grants$;

create or replace function atlas_private.pos_mapping_events_append_only()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
begin
  raise exception 'POS mapping event history is append-only' using errcode='42501';
end;
$function$;
revoke all on function atlas_private.pos_mapping_events_append_only()
  from public,anon,authenticated;
grant execute on function atlas_private.pos_mapping_events_append_only()
  to service_role;
drop trigger if exists pos_mapping_events_append_only
  on atlas_private.pos_mapping_events;
create trigger pos_mapping_events_append_only
before update or delete on atlas_private.pos_mapping_events
for each row execute function atlas_private.pos_mapping_events_append_only();

create or replace function atlas_private.pos_normalize_name(p_value text)
returns text
language sql
immutable
security invoker
set search_path=''
as $function$
  select trim(regexp_replace(
    regexp_replace(
      translate(lower(coalesce(p_value,'')),'áéíóúýöðþæ','aeiouyodta'),
      '[^a-z0-9]+',' ','g'
    ),
    '[[:space:]]+',' ','g'
  ));
$function$;

create or replace function atlas_private.pos_candidate_score(
  p_product_name text,
  p_target_name text
)
returns numeric
language sql
immutable
security invoker
set search_path=''
as $function$
  with names as (
    select atlas_private.pos_normalize_name(p_product_name) product_name,
           atlas_private.pos_normalize_name(p_target_name) target_name
  ),
  product_tokens as (
    select distinct token from names,
      unnest(regexp_split_to_array(product_name,'[[:space:]]+')) token
    where token<>''
  ),
  target_tokens as (
    select distinct token from names,
      unnest(regexp_split_to_array(target_name,'[[:space:]]+')) token
    where token<>''
  ),
  values as (
    select names.*,
      (select count(*) from product_tokens) product_count,
      (select count(*) from target_tokens) target_count,
      (select count(*) from product_tokens p join target_tokens t using(token)) overlap_count
    from names
  )
  select round((case
    when product_name='' or target_name='' then 0
    when product_name=target_name then 1
    when char_length(product_name)>=4 and char_length(target_name)>=4
      and (product_name like '%'||target_name||'%' or target_name like '%'||product_name||'%')
      then 0.85
    when greatest(product_count,target_count)>0
      then least(0.80,overlap_count::numeric/greatest(product_count,target_count))
    else 0
  end)::numeric,4)
  from values;
$function$;

create or replace function atlas_private.pos_mapping_assert_actor(
  p_actor_role text,
  p_admin_required boolean default false
)
returns void
language plpgsql
stable
security invoker
set search_path=''
as $function$
begin
  if p_actor_role not in ('admin','manager') then
    raise exception 'Checkpoint M is available only to managers and administrators';
  end if;
  if p_admin_required and p_actor_role<>'admin' then
    raise exception 'This Checkpoint M action requires an administrator';
  end if;
end;
$function$;

create or replace function atlas_private.pos_generate_candidates(p_run_id uuid default null)
returns integer
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  inserted_count integer;
  minimum_score numeric := coalesce((
    select minimum_candidate_score
    from atlas_private.pos_mapping_settings where setting_key='va'
  ),0.35);
begin
  delete from atlas_private.pos_product_candidates candidate
  using atlas_private.pos_products product
  where candidate.product_id=product.id
    and (p_run_id is null or product.run_id=p_run_id);

  with scores as (
    select product.id product_id,target.id target_id,
           atlas_private.pos_candidate_score(product.name,target.name) score,
           case
             when product.normalized_name=target.normalized_name then 'exact_name'
             when product.normalized_name like '%'||target.normalized_name||'%'
               or target.normalized_name like '%'||product.normalized_name||'%'
               then 'contained_name'
             else 'token_overlap'
           end strategy,
           product.name product_name,target.name target_name
    from atlas_private.pos_products product
    cross join atlas_private.pos_mapping_targets target
    where product.active and target.active
      and (p_run_id is null or product.run_id=p_run_id)
  ),
  ranked as (
    select *,row_number() over(
      partition by product_id order by score desc,target_name,target_id
    ) candidate_rank
    from scores where score>=minimum_score
  )
  insert into atlas_private.pos_product_candidates(
    product_id,target_id,candidate_rank,score,strategy,explanation
  )
  select product_id,target_id,candidate_rank,score,strategy,
         jsonb_build_object(
           'product_name',product_name,
           'target_name',target_name,
           'deterministic',true,
           'automatic_approval',false
         )
  from ranked where candidate_rank<=5
  on conflict (product_id,target_id) do update
  set candidate_rank=excluded.candidate_rank,
      score=excluded.score,
      strategy=excluded.strategy,
      explanation=excluded.explanation,
      generated_at=now();
  get diagnostics inserted_count=row_count;

  insert into atlas_private.pos_product_mappings(product_id,status,mapping_source)
  select product.id,'pending','deterministic_candidate'
  from atlas_private.pos_products product
  where product.active and (p_run_id is null or product.run_id=p_run_id)
  on conflict (product_id) do nothing;

  return inserted_count;
end;
$function$;

create or replace function atlas_private.pos_refresh_targets(
  p_targets jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  target_row record;
  refreshed_count integer := 0;
  candidates_count integer := 0;
begin
  perform atlas_private.pos_mapping_assert_actor(p_actor_role,false);
  if jsonb_typeof(coalesce(p_targets,'[]'::jsonb))<>'array' then
    raise exception 'POS target catalogue must be an array';
  end if;
  if jsonb_array_length(coalesce(p_targets,'[]'::jsonb))>2000 then
    raise exception 'POS target catalogue is too large';
  end if;

  update atlas_private.pos_mapping_targets set active=false,updated_at=now();

  for target_row in
    select * from jsonb_to_recordset(coalesce(p_targets,'[]'::jsonb)) as target(
      production_recipe_id uuid,
      name text,
      product_type text,
      category_id uuid,
      menu_price numeric,
      show_on_menu boolean,
      active boolean,
      source_updated_at timestamptz
    )
  loop
    if target_row.production_recipe_id is null
       or nullif(trim(coalesce(target_row.name,'')),'') is null then
      raise exception 'Every POS mapping target requires a production recipe id and name';
    end if;

    insert into atlas_private.pos_mapping_targets(
      production_recipe_id,target_key,name,normalized_name,product_type,
      category_id,menu_price,show_on_menu,active,source_updated_at,
      refreshed_at,metadata
    ) values (
      target_row.production_recipe_id,
      'recipe:'||target_row.production_recipe_id::text,
      trim(target_row.name),
      atlas_private.pos_normalize_name(target_row.name),
      nullif(trim(coalesce(target_row.product_type,'')),''),
      target_row.category_id,target_row.menu_price,
      coalesce(target_row.show_on_menu,false),coalesce(target_row.active,true),
      target_row.source_updated_at,now(),
      jsonb_build_object('source','production_recipes','manager_filtered',true)
    )
    on conflict (production_recipe_id) do update
    set target_key=excluded.target_key,
        name=excluded.name,
        normalized_name=excluded.normalized_name,
        product_type=excluded.product_type,
        category_id=excluded.category_id,
        menu_price=excluded.menu_price,
        show_on_menu=excluded.show_on_menu,
        active=excluded.active,
        source_updated_at=excluded.source_updated_at,
        refreshed_at=now(),
        metadata=excluded.metadata,
        updated_at=now();
    refreshed_count:=refreshed_count+1;
  end loop;

  candidates_count:=atlas_private.pos_generate_candidates(null);

  insert into atlas_private.pos_mapping_events(
    event_type,actor_id,actor_label,actor_role,payload
  ) values (
    'target_catalog_refreshed',p_actor_id,left(coalesce(p_actor_label,''),160),p_actor_role,
    jsonb_build_object(
      'targets_received',refreshed_count,
      'candidates_generated',candidates_count,
      'production_source_mutation',false
    )
  );

  return jsonb_build_object(
    'targets_refreshed',refreshed_count,
    'candidates_generated',candidates_count,
    'sales_ingestion_enabled',false
  );
end;
$function$;

create or replace function atlas_private.pos_stage_products(
  p_run_key text,
  p_provider_key text,
  p_products jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  run_row atlas_private.pos_import_runs;
  product_row record;
  staged_count integer := 0;
  candidates_count integer := 0;
  connection_state text;
begin
  perform atlas_private.pos_mapping_assert_actor(p_actor_role,false);
  if nullif(trim(coalesce(p_run_key,'')),'') is null then
    raise exception 'POS import run key is required';
  end if;
  if p_provider_key<>'dineout' then
    raise exception 'Checkpoint M currently supports only the registered Dineout provider';
  end if;
  select atlas_private.connection_effective_state(
    health_state,last_succeeded_at,token_expires_at,stale_after_seconds
  ) into connection_state
  from atlas_private.integration_connections
  where provider_key=p_provider_key and active;
  if connection_state is distinct from 'healthy' then
    insert into atlas_private.pos_mapping_events(
      event_type,actor_id,actor_label,actor_role,payload
    ) values (
      'connector_blocked',p_actor_id,left(coalesce(p_actor_label,''),160),p_actor_role,
      jsonb_build_object('provider_key',p_provider_key,'connection_state',connection_state)
    );
    raise exception 'The POS connection must be healthy before products can be staged';
  end if;
  if jsonb_typeof(coalesce(p_products,'[]'::jsonb))<>'array' then
    raise exception 'POS products must be an array';
  end if;
  if jsonb_array_length(coalesce(p_products,'[]'::jsonb))>5000 then
    raise exception 'POS product batch is too large';
  end if;

  insert into atlas_private.pos_import_runs(
    run_key,provider_key,status,created_by,created_by_label,metadata
  ) values (
    trim(p_run_key),p_provider_key,'staged',p_actor_id,left(coalesce(p_actor_label,''),160),
    jsonb_build_object('automatic_mapping',false,'sales_facts_included',false)
  )
  on conflict (run_key) do update
  set status='staged',updated_at=now(),created_by=p_actor_id,
      created_by_label=left(coalesce(p_actor_label,''),160)
  returning * into run_row;

  for product_row in
    select * from jsonb_to_recordset(coalesce(p_products,'[]'::jsonb)) as product(
      external_product_id text,
      external_sku text,
      name text,
      category text,
      active boolean,
      metadata jsonb
    )
  loop
    if nullif(trim(coalesce(product_row.external_product_id,'')),'') is null
       or nullif(trim(coalesce(product_row.name,'')),'') is null then
      raise exception 'Every POS product requires an external id and name';
    end if;
    insert into atlas_private.pos_products(
      run_id,provider_key,external_product_id,external_sku,name,normalized_name,
      category,active,first_seen_at,last_seen_at,metadata
    ) values (
      run_row.id,p_provider_key,trim(product_row.external_product_id),
      nullif(trim(coalesce(product_row.external_sku,'')),''),trim(product_row.name),
      atlas_private.pos_normalize_name(product_row.name),
      nullif(trim(coalesce(product_row.category,'')),''),coalesce(product_row.active,true),
      now(),now(),coalesce(product_row.metadata,'{}'::jsonb)
    )
    on conflict (provider_key,external_product_id) do update
    set run_id=excluded.run_id,
        external_sku=excluded.external_sku,
        name=excluded.name,
        normalized_name=excluded.normalized_name,
        category=excluded.category,
        active=excluded.active,
        last_seen_at=now(),
        metadata=excluded.metadata,
        updated_at=now();
    staged_count:=staged_count+1;
  end loop;

  update atlas_private.pos_import_runs
  set source_record_count=staged_count,status='review',completed_at=now(),updated_at=now()
  where id=run_row.id;

  candidates_count:=atlas_private.pos_generate_candidates(run_row.id);

  insert into atlas_private.pos_mapping_events(
    event_type,run_id,actor_id,actor_label,actor_role,payload
  ) values (
    'products_staged',run_row.id,p_actor_id,left(coalesce(p_actor_label,''),160),p_actor_role,
    jsonb_build_object(
      'provider_key',p_provider_key,
      'products_staged',staged_count,
      'candidates_generated',candidates_count,
      'sales_facts_included',false
    )
  );

  return jsonb_build_object(
    'run_id',run_row.id,
    'products_staged',staged_count,
    'candidates_generated',candidates_count,
    'automatic_approval',false,
    'sales_ingestion_enabled',false
  );
end;
$function$;

create or replace function atlas_private.pos_decide_mapping(
  p_product_id uuid,
  p_target_id uuid,
  p_decision text,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  decision_status text;
  event_name text;
  score_value numeric;
  mapping_row atlas_private.pos_product_mappings;
begin
  perform atlas_private.pos_mapping_assert_actor(p_actor_role,false);
  if not exists (select 1 from atlas_private.pos_products where id=p_product_id) then
    raise exception 'POS product was not found';
  end if;

  decision_status:=case p_decision
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'ignore' then 'ignored'
    when 'reset' then 'pending'
    else null
  end;
  if decision_status is null then raise exception 'POS mapping decision is invalid'; end if;
  if p_decision='approve' and (
    p_target_id is null or not exists(
      select 1 from atlas_private.pos_mapping_targets where id=p_target_id and active
    )
  ) then
    raise exception 'An active mapping target is required for approval';
  end if;

  select candidate.score into score_value
  from atlas_private.pos_product_candidates candidate
  where candidate.product_id=p_product_id and candidate.target_id=p_target_id;

  insert into atlas_private.pos_product_mappings(
    product_id,target_id,status,confidence,mapping_source,decision_note,
    decided_by,decided_by_label,decided_at
  ) values (
    p_product_id,case when decision_status='approved' then p_target_id else null end,
    decision_status,case when decision_status='approved' then score_value else null end,
    'manager',nullif(trim(coalesce(p_note,'')),''),p_actor_id,
    left(coalesce(p_actor_label,''),160),case when decision_status='pending' then null else now() end
  )
  on conflict (product_id) do update
  set target_id=excluded.target_id,
      status=excluded.status,
      confidence=excluded.confidence,
      mapping_source='manager',
      decision_note=excluded.decision_note,
      decided_by=excluded.decided_by,
      decided_by_label=excluded.decided_by_label,
      decided_at=excluded.decided_at,
      updated_at=now()
  returning * into mapping_row;

  event_name:=case decision_status
    when 'approved' then 'mapping_approved'
    when 'rejected' then 'mapping_rejected'
    when 'ignored' then 'mapping_ignored'
    else 'mapping_reset'
  end;
  insert into atlas_private.pos_mapping_events(
    event_type,product_id,target_id,actor_id,actor_label,actor_role,payload
  ) values (
    event_name,p_product_id,mapping_row.target_id,p_actor_id,
    left(coalesce(p_actor_label,''),160),p_actor_role,
    jsonb_build_object(
      'status',mapping_row.status,
      'confidence',mapping_row.confidence,
      'sales_ingestion_enabled',false,
      'automatic_approval',false
    )
  );

  return to_jsonb(mapping_row);
end;
$function$;

create or replace function atlas_private.pos_mapping_snapshot(
  p_actor_id uuid,
  p_actor_role text,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $function$
declare
  safe_limit integer:=least(greatest(coalesce(p_limit,200),1),500);
  connection_row jsonb;
  product_rows jsonb;
  target_rows jsonb;
  event_rows jsonb;
  total_products integer;
  pending_products integer;
  approved_products integer;
  rejected_products integer;
  ignored_products integer;
  unmatched_products integer;
  target_count integer;
  effective_state text;
begin
  perform atlas_private.pos_mapping_assert_actor(p_actor_role,false);

  select atlas_private.connection_effective_state(
           connection.health_state,connection.last_succeeded_at,
           connection.token_expires_at,connection.stale_after_seconds
         ),
         jsonb_build_object(
           'connection_key',connection.provider_key,
           'label',connection.label,
           'state',atlas_private.connection_effective_state(
             connection.health_state,connection.last_succeeded_at,
             connection.token_expires_at,connection.stale_after_seconds
           ),
           'authorization_state',connection.authorization_state,
           'last_succeeded_at',connection.last_succeeded_at,
           'last_error_code',connection.last_error_code,
           'last_error_summary',connection.last_error_summary
         )
  into effective_state,connection_row
  from atlas_private.integration_connections connection
  where connection.provider_key='dineout';

  select count(*),
         count(*) filter (where coalesce(mapping.status,'pending')='pending'),
         count(*) filter (where mapping.status='approved'),
         count(*) filter (where mapping.status='rejected'),
         count(*) filter (where mapping.status='ignored'),
         count(*) filter (where coalesce(mapping.status,'pending')='pending'
                          and not exists(
                            select 1 from atlas_private.pos_product_candidates candidate
                            where candidate.product_id=product.id
                          ))
  into total_products,pending_products,approved_products,rejected_products,
       ignored_products,unmatched_products
  from atlas_private.pos_products product
  left join atlas_private.pos_product_mappings mapping on mapping.product_id=product.id
  where product.active;

  select count(*) into target_count
  from atlas_private.pos_mapping_targets where active;

  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id',product.id,
    'run_id',product.run_id,
    'external_product_id',product.external_product_id,
    'external_sku',product.external_sku,
    'name',product.name,
    'normalized_name',product.normalized_name,
    'category',product.category,
    'active',product.active,
    'last_seen_at',product.last_seen_at,
    'mapping',case when mapping.product_id is null then null else jsonb_build_object(
      'status',mapping.status,
      'target_id',mapping.target_id,
      'confidence',mapping.confidence,
      'mapping_source',mapping.mapping_source,
      'decision_note',mapping.decision_note,
      'decided_by_label',mapping.decided_by_label,
      'decided_at',mapping.decided_at
    ) end,
    'candidates',coalesce((
      select jsonb_agg(jsonb_build_object(
        'target_id',candidate.target_id,
        'target_name',target.name,
        'target_type',target.product_type,
        'menu_price',target.menu_price,
        'rank',candidate.candidate_rank,
        'score',candidate.score,
        'strategy',candidate.strategy
      ) order by candidate.candidate_rank,candidate.score desc)
      from atlas_private.pos_product_candidates candidate
      join atlas_private.pos_mapping_targets target on target.id=candidate.target_id
      where candidate.product_id=product.id and target.active
    ),'[]'::jsonb)
  ) order by coalesce(mapping.status,'pending'),product.name,product.id),'[]'::jsonb)
  into product_rows
  from (
    select * from atlas_private.pos_products
    where active order by name,id limit safe_limit
  ) product
  left join atlas_private.pos_product_mappings mapping on mapping.product_id=product.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'target_id',target.id,
    'production_recipe_id',target.production_recipe_id,
    'target_key',target.target_key,
    'name',target.name,
    'normalized_name',target.normalized_name,
    'product_type',target.product_type,
    'menu_price',target.menu_price,
    'show_on_menu',target.show_on_menu,
    'source_updated_at',target.source_updated_at,
    'refreshed_at',target.refreshed_at
  ) order by target.name,target.id),'[]'::jsonb)
  into target_rows
  from (
    select * from atlas_private.pos_mapping_targets
    where active order by name,id limit 500
  ) target;

  select coalesce(jsonb_agg(to_jsonb(event_row) order by event_row.created_at desc),'[]'::jsonb)
  into event_rows
  from (
    select id,event_type,run_id,product_id,target_id,actor_label,actor_role,payload,created_at
    from atlas_private.pos_mapping_events
    order by created_at desc limit 80
  ) event_row;

  return jsonb_build_object(
    'version','atlas-pos-mapping/0.1.0',
    'generated_at',now(),
    'connection',connection_row,
    'summary',jsonb_build_object(
      'target_products',coalesce(target_count,0),
      'pos_products',coalesce(total_products,0),
      'pending',coalesce(pending_products,0),
      'approved',coalesce(approved_products,0),
      'rejected',coalesce(rejected_products,0),
      'ignored',coalesce(ignored_products,0),
      'unmatched',coalesce(unmatched_products,0),
      'mapping_complete',coalesce(total_products,0)>0
        and coalesce(pending_products,0)=0
        and coalesce(approved_products,0)>0,
      'ready_for_sales_ingestion',false
    ),
    'products',product_rows,
    'targets',target_rows,
    'events',event_rows,
    'permissions',jsonb_build_object(
      'can_view',true,
      'can_refresh_targets',true,
      'can_decide_mappings',true,
      'can_stage_external_products',effective_state='healthy',
      'can_ingest_sales',false
    ),
    'policy',jsonb_build_object(
      'manager_approval_required',true,
      'automatic_mapping_approval',false,
      'sales_ingestion_enabled',false,
      'brain_sales_evidence_enabled',false,
      'automatic_ordering_enabled',false,
      'production_source_mutation',false
    ),
    'actor',jsonb_build_object('id',p_actor_id,'role',p_actor_role)
  );
end;
$function$;

create or replace function atlas_private.pos_mapping_ping()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select jsonb_build_object(
    'version','atlas-pos-mapping/0.1.0',
    'checked_at',now(),
    'targets',(select count(*) from atlas_private.pos_mapping_targets where active),
    'products',(select count(*) from atlas_private.pos_products where active),
    'approved_mappings',(
      select count(*) from atlas_private.pos_product_mappings where status='approved'
    ),
    'sales_ingestion_enabled',false,
    'automatic_mapping_approval',false
  );
$function$;

create or replace function public.atlas_pos_mapping_snapshot(
  p_actor_id uuid,
  p_actor_role text,
  p_limit integer default 200
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select atlas_private.pos_mapping_snapshot(p_actor_id,p_actor_role,p_limit);
$function$;

create or replace function public.atlas_pos_mapping_refresh_targets(
  p_targets jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $function$
  select atlas_private.pos_refresh_targets(
    p_targets,p_actor_id,p_actor_label,p_actor_role
  );
$function$;

create or replace function public.atlas_pos_mapping_stage_products(
  p_run_key text,
  p_provider_key text,
  p_products jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $function$
  select atlas_private.pos_stage_products(
    p_run_key,p_provider_key,p_products,p_actor_id,p_actor_label,p_actor_role
  );
$function$;

create or replace function public.atlas_pos_mapping_decide(
  p_product_id uuid,
  p_target_id uuid,
  p_decision text,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $function$
  select atlas_private.pos_decide_mapping(
    p_product_id,p_target_id,p_decision,p_note,
    p_actor_id,p_actor_label,p_actor_role
  );
$function$;

create or replace function public.atlas_pos_mapping_ping()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select atlas_private.pos_mapping_ping();
$function$;

select set_config('atlas.allow_high_risk_capability_grant','on',true);
insert into atlas_private.connection_capability_grants(
  connection_key,capability_key,capability_kind,grant_state,risk_level,
  manager_approval_required,automatic_execution_allowed,metadata
)
values
  ('dineout','sales.catalog.read','read','verification_required','medium',true,false,
    '{"mapping_required":true,"checkpoint":"M"}'::jsonb),
  ('dineout','sales.transactions.read','read','verification_required','high',true,false,
    '{"blocked_until_mapping_complete":true,"sales_ingestion_enabled":false}'::jsonb),
  ('atlas-private-database','pos.mapping.review','write','granted','medium',true,false,
    '{"manager_approval_required":true,"automatic_approval":false}'::jsonb)
on conflict (connection_key,capability_key) do update
set capability_kind=excluded.capability_kind,
    grant_state=excluded.grant_state,
    risk_level=excluded.risk_level,
    manager_approval_required=excluded.manager_approval_required,
    automatic_execution_allowed=false,
    metadata=excluded.metadata,
    updated_at=now();

insert into atlas_private.connection_dependencies(
  connection_key,module_key,requirement_level,required_capabilities,safety_boundary
)
values
  ('dineout','checkpoint-m','required',array['sales.catalog.read'],
    'External product catalogue must be mapped and manager-approved before any sales ingestion.'),
  ('dineout','reports','future',array['sales.transactions.read'],
    'Sales reporting remains disabled until product mappings and transaction evidence are approved.'),
  ('atlas-private-database','checkpoint-m','required',array['pos.mapping.review'],
    'Mappings are private review records and never mutate production recipes or inventory.')
on conflict (connection_key,module_key) do update
set requirement_level=excluded.requirement_level,
    required_capabilities=excluded.required_capabilities,
    safety_boundary=excluded.safety_boundary,
    updated_at=now();

update atlas_private.integration_connections
set requirements=requirements || jsonb_build_object(
      'product_mapping_required',true,
      'manager_approval_required',true,
      'sales_ingestion_enabled',false
    ),
    metadata=metadata || jsonb_build_object(
      'checkpoint','M',
      'automatic_mapping_approval',false,
      'automatic_ordering',false
    )
where provider_key='dineout';

do $checkpoint_m_brain_gate$
begin
  if to_regclass('atlas_private.brain_data_connections') is not null then
    update atlas_private.brain_data_connections
    set metadata=metadata || jsonb_build_object(
      'checkpoint_m_mapping_required',true,
      'sales_ingestion_enabled',false,
      'automatic_mapping_approval',false
    )
    where connection_key='sales_history';
  end if;
end
$checkpoint_m_brain_gate$;

insert into atlas_private.pos_mapping_settings(
  setting_key,provider_key,sales_ingestion_enabled,automatic_mapping_enabled,
  minimum_candidate_score,metadata
) values (
  'va','dineout',false,false,0.35,
  jsonb_build_object(
    'checkpoint','M',
    'manager_approval_required',true,
    'sales_facts_accepted',false
  )
)
on conflict (setting_key) do update
set provider_key=excluded.provider_key,
    sales_ingestion_enabled=false,
    automatic_mapping_enabled=false,
    minimum_candidate_score=excluded.minimum_candidate_score,
    metadata=excluded.metadata,
    updated_at=now();

insert into atlas_private.pos_mapping_events(
  event_type,actor_label,actor_role,payload
)
select 'foundation_initialized','Atlas migration','system',jsonb_build_object(
  'checkpoint','M',
  'sales_ingestion_enabled',false,
  'automatic_mapping_approval',false,
  'automatic_ordering',false
)
where not exists (
  select 1 from atlas_private.pos_mapping_events
  where event_type='foundation_initialized'
);

do $checkpoint_m_function_grants$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure signature
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='atlas_private' and p.proname like 'pos_%')
       or (n.nspname='public' and p.proname like 'atlas_pos_mapping_%')
  loop
    execute format('revoke all on function %s from public,anon,authenticated',function_row.signature);
    execute format('grant execute on function %s to service_role',function_row.signature);
  end loop;
end
$checkpoint_m_function_grants$;

comment on table atlas_private.pos_product_mappings is
  'Checkpoint M manager-approved mapping from external POS products to production recipe/menu targets. No sales facts are stored.';
comment on function public.atlas_pos_mapping_snapshot(uuid,text,integer) is
  'Service-role-only Checkpoint M snapshot. Browser access is available only through atlas-pos-mapping.';

notify pgrst,'reload schema';
