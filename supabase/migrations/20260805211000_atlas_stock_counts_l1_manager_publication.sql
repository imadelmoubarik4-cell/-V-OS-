-- Checkpoint L1: manager-only publication boundary.
--
-- Saving or verifying a count never changes live inventory. This migration adds
-- one explicit, auditable publication transaction. It remains disabled by
-- default and can only be called through the service-role gateway after that
-- gateway has revalidated an active manager or administrator profile.

alter table atlas_private.inventory_count_settings
  drop constraint if exists inventory_count_settings_production_apply_enabled_check;

alter table atlas_private.inventory_count_sessions
  drop constraint if exists inventory_count_sessions_production_applied_check;

alter table atlas_private.inventory_count_sessions
  add column if not exists publication_status text not null default 'not_ready',
  add column if not exists publication_approved_by uuid,
  add column if not exists publication_approved_by_label text,
  add column if not exists publication_approved_at timestamptz,
  add column if not exists publication_request_id text,
  add column if not exists published_by uuid,
  add column if not exists published_by_label text,
  add column if not exists published_at timestamptz;

alter table atlas_private.inventory_count_sessions
  drop constraint if exists inventory_count_sessions_publication_status_check;
alter table atlas_private.inventory_count_sessions
  add constraint inventory_count_sessions_publication_status_check
  check (publication_status in ('not_ready','ready','blocked','publishing','published','failed'));

create unique index if not exists inventory_count_sessions_publication_request_uidx
  on atlas_private.inventory_count_sessions(publication_request_id)
  where publication_request_id is not null;

create table if not exists atlas_private.inventory_count_publications (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references atlas_private.inventory_count_sessions(id) on delete restrict,
  request_id text not null unique,
  status text not null default 'ready'
    check (status in ('ready','blocked','publishing','published','failed')),
  production_apply_enabled boolean not null default false,
  blocked_reason text,
  approved_by uuid not null,
  approved_by_label text not null,
  approved_at timestamptz not null default now(),
  published_by uuid,
  published_by_label text,
  published_at timestamptz,
  item_count integer not null default 0 check (item_count >= 0),
  adjustment_count integer not null default 0 check (adjustment_count >= 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  failure_message text,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists atlas_private.inventory_count_publication_lines (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references atlas_private.inventory_count_publications(id) on delete cascade,
  session_id uuid not null references atlas_private.inventory_count_sessions(id) on delete restrict,
  count_line_id uuid not null references atlas_private.inventory_count_lines(id) on delete restrict,
  inventory_item_id uuid not null,
  item_name text not null,
  inventory_unit text not null,
  before_quantity numeric,
  observed_quantity numeric not null check (observed_quantity >= 0),
  adjustment_quantity numeric,
  before_updated_at timestamptz,
  verified_production_quantity numeric,
  verified_production_updated_at timestamptz,
  conflict_reason text,
  status text not null default 'pending'
    check (status in ('pending','blocked','applied','skipped','failed')),
  movement_note text,
  production_after_quantity numeric,
  applied_at timestamptz,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(publication_id,count_line_id)
);

create index if not exists inventory_count_publications_status_idx
  on atlas_private.inventory_count_publications(status,approved_at desc);
create index if not exists inventory_count_publication_lines_status_idx
  on atlas_private.inventory_count_publication_lines(publication_id,status,item_name);

alter table atlas_private.inventory_count_publications enable row level security;
alter table atlas_private.inventory_count_publication_lines enable row level security;

revoke all on atlas_private.inventory_count_publications from public,anon,authenticated;
revoke all on atlas_private.inventory_count_publication_lines from public,anon,authenticated;
grant all on atlas_private.inventory_count_publications to service_role;
grant all on atlas_private.inventory_count_publication_lines to service_role;

drop policy if exists "service role manages inventory count publications" on atlas_private.inventory_count_publications;
create policy "service role manages inventory count publications"
  on atlas_private.inventory_count_publications for all to service_role using (true) with check (true);
drop policy if exists "service role manages inventory count publication lines" on atlas_private.inventory_count_publication_lines;
create policy "service role manages inventory count publication lines"
  on atlas_private.inventory_count_publication_lines for all to service_role using (true) with check (true);

drop trigger if exists inventory_count_publications_touch on atlas_private.inventory_count_publications;
create trigger inventory_count_publications_touch before update on atlas_private.inventory_count_publications
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists inventory_count_publication_lines_touch on atlas_private.inventory_count_publication_lines;
create trigger inventory_count_publication_lines_touch before update on atlas_private.inventory_count_publication_lines
  for each row execute function atlas_private.touch_updated_at();

alter table atlas_private.inventory_count_events
  drop constraint if exists inventory_count_events_event_type_check;
alter table atlas_private.inventory_count_events
  add constraint inventory_count_events_event_type_check check (event_type in (
    'session_started','line_saved','session_submitted','session_verified','session_rejected','session_cancelled',
    'publication_prepared','publication_blocked','session_published','publication_failed'
  ));

create or replace function atlas_private.stock_count_prepare_publication(
  p_session_id uuid,
  p_inventory jsonb,
  p_request_id text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  publication_row atlas_private.inventory_count_publications;
  item_total integer := 0;
  adjustment_total integer := 0;
  conflict_total integer := 0;
  blocked_text text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can approve stock-count publication'; end if;
  if jsonb_typeof(coalesce(p_inventory,'[]'::jsonb))<>'array' then raise exception 'Inventory catalog must be an array'; end if;
  if nullif(trim(coalesce(p_request_id,'')),'') is null then raise exception 'Publication request ID is required'; end if;

  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status<>'verified' then raise exception 'Only a manager-verified count can be prepared for publication'; end if;
  if session_row.production_applied or session_row.publication_status='published' then
    return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
  end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';

  insert into atlas_private.inventory_count_publications (
    session_id,request_id,status,production_apply_enabled,approved_by,approved_by_label,evidence
  ) values (
    p_session_id,trim(p_request_id),'ready',coalesce(settings_row.production_apply_enabled,false),
    p_actor_id,p_actor_label,
    jsonb_build_object('verified_at',session_row.verified_at,'prepared_against_inventory_at',now())
  )
  on conflict(session_id) do update set
    request_id=excluded.request_id,
    status=case when atlas_private.inventory_count_publications.status='published' then 'published' else 'ready' end,
    production_apply_enabled=excluded.production_apply_enabled,
    blocked_reason=null,approved_by=excluded.approved_by,approved_by_label=excluded.approved_by_label,
    approved_at=now(),failure_message=null,evidence=excluded.evidence,updated_at=now()
  returning * into publication_row;

  if publication_row.status='published' then
    return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
  end if;

  delete from atlas_private.inventory_count_publication_lines where publication_id=publication_row.id;

  with current_inventory as (
    select
      (item->>'id')::uuid as inventory_item_id,
      coalesce(nullif(item->>'quantity','')::numeric,0) as quantity,
      nullif(item->>'updated_at','')::timestamptz as updated_at
    from jsonb_array_elements(p_inventory) item
  )
  insert into atlas_private.inventory_count_publication_lines (
    publication_id,session_id,count_line_id,inventory_item_id,item_name,inventory_unit,
    before_quantity,observed_quantity,adjustment_quantity,before_updated_at,
    verified_production_quantity,verified_production_updated_at,conflict_reason,status,movement_note
  )
  select
    publication_row.id,line_row.session_id,line_row.id,line_row.inventory_item_id,line_row.item_name,line_row.inventory_unit,
    current.quantity,line_row.observed_quantity,line_row.observed_quantity-current.quantity,current.updated_at,
    balance_row.production_quantity_at_verification,balance_row.production_updated_at,
    case
      when current.inventory_item_id is null then 'Inventory item is no longer present in the active catalog'
      when current.quantity is distinct from balance_row.production_quantity_at_verification then 'Production quantity changed after manager verification'
      when current.updated_at is distinct from balance_row.production_updated_at then 'Production record changed after manager verification'
      else null
    end,
    case
      when current.inventory_item_id is null then 'blocked'
      when current.quantity is distinct from balance_row.production_quantity_at_verification then 'blocked'
      when current.updated_at is distinct from balance_row.production_updated_at then 'blocked'
      when line_row.observed_quantity=current.quantity then 'skipped'
      else 'pending'
    end,
    'Atlas verified count '||publication_row.request_id||' · session '||line_row.session_id::text||' · line '||line_row.id::text
  from atlas_private.inventory_count_lines line_row
  join atlas_private.inventory_verified_balances balance_row
    on balance_row.source_session_id=line_row.session_id and balance_row.source_line_id=line_row.id
  left join current_inventory current on current.inventory_item_id=line_row.inventory_item_id
  where line_row.session_id=p_session_id and line_row.line_status='counted';

  select count(*),count(*) filter(where adjustment_quantity<>0),count(*) filter(where status='blocked')
  into item_total,adjustment_total,conflict_total
  from atlas_private.inventory_count_publication_lines where publication_id=publication_row.id;

  if item_total=0 then blocked_text := 'No counted lines are available for publication';
  elsif conflict_total>0 then blocked_text := conflict_total||' production conflict(s) require a fresh verification';
  elsif not coalesce(settings_row.production_apply_enabled,false) then blocked_text := 'Production publication is disabled in this environment';
  else blocked_text := null;
  end if;

  update atlas_private.inventory_count_publications
  set item_count=item_total,adjustment_count=adjustment_total,conflict_count=conflict_total,
      status=case when blocked_text is null then 'ready' else 'blocked' end,
      blocked_reason=blocked_text,updated_at=now()
  where id=publication_row.id;

  update atlas_private.inventory_count_sessions
  set publication_status=case when blocked_text is null then 'ready' else 'blocked' end,
      publication_approved_by=p_actor_id,publication_approved_by_label=p_actor_label,
      publication_approved_at=now(),publication_request_id=publication_row.request_id,
      version=version+1,updated_at=now()
  where id=p_session_id;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    case when blocked_text is null then 'publication_prepared' else 'publication_blocked' end,
    p_session_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('publication_id',publication_row.id,'request_id',publication_row.request_id,
      'item_count',item_total,'adjustment_count',adjustment_total,'conflict_count',conflict_total,
      'production_apply_enabled',coalesce(settings_row.production_apply_enabled,false),'blocked_reason',blocked_text)
  );

  return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
end;
$$;

create or replace function atlas_private.stock_count_publish(
  p_session_id uuid,
  p_request_id text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  publication_row atlas_private.inventory_count_publications;
  publication_line atlas_private.inventory_count_publication_lines;
  item_row public.inventory_items;
  conflict_total integer := 0;
  delta numeric;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can publish stock counts'; end if;
  if nullif(trim(coalesce(p_request_id,'')),'') is null then raise exception 'Publication request ID is required'; end if;

  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';
  if not coalesce(settings_row.production_apply_enabled,false) then
    raise exception 'Production stock-count publication is disabled';
  end if;

  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.production_applied or session_row.publication_status='published' then
    return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
  end if;
  if session_row.status<>'verified' then raise exception 'Only a manager-verified count can be published'; end if;

  select * into publication_row
  from atlas_private.inventory_count_publications
  where session_id=p_session_id and request_id=trim(p_request_id)
  for update;
  if not found then raise exception 'Prepare this publication again before applying it'; end if;
  if publication_row.status<>'ready' then raise exception 'This publication is not ready to apply'; end if;

  select count(*) into conflict_total
  from atlas_private.inventory_count_publication_lines plan_line
  left join public.inventory_items item on item.id=plan_line.inventory_item_id
  where plan_line.publication_id=publication_row.id
    and (
      item.id is null
      or item.quantity is distinct from plan_line.before_quantity
      or item.updated_at is distinct from plan_line.before_updated_at
    );

  if conflict_total>0 then
    update atlas_private.inventory_count_publications
    set status='blocked',blocked_reason=conflict_total||' inventory record(s) changed after publication approval',
        conflict_count=conflict_total,updated_at=now()
    where id=publication_row.id;
    update atlas_private.inventory_count_sessions
    set publication_status='blocked',version=version+1,updated_at=now() where id=p_session_id;
    insert into atlas_private.inventory_count_events (
      event_type,session_id,actor_id,actor_label,actor_role,payload
    ) values (
      'publication_blocked',p_session_id,p_actor_id,p_actor_label,p_actor_role,
      jsonb_build_object('publication_id',publication_row.id,'request_id',publication_row.request_id,'conflict_count',conflict_total)
    );
    return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
  end if;

  update atlas_private.inventory_count_publications set status='publishing',updated_at=now() where id=publication_row.id;
  update atlas_private.inventory_count_sessions set publication_status='publishing',version=version+1,updated_at=now() where id=p_session_id;

  for publication_line in
    select * from atlas_private.inventory_count_publication_lines
    where publication_id=publication_row.id order by item_name,id
  loop
    select * into item_row from public.inventory_items where id=publication_line.inventory_item_id for update;
    if not found then raise exception 'Inventory item % disappeared during publication',publication_line.item_name; end if;
    if item_row.quantity is distinct from publication_line.before_quantity
       or item_row.updated_at is distinct from publication_line.before_updated_at then
      raise exception 'Inventory item % changed during publication',publication_line.item_name;
    end if;

    delta := publication_line.observed_quantity-item_row.quantity;
    if delta<>0 then
      update public.inventory_items
      set quantity=publication_line.observed_quantity,updated_by=p_actor_id::text,updated_at=now()
      where id=item_row.id
      returning * into item_row;

      insert into public.inventory_movements (
        item_id,item_name,movement_type,quantity_change,unit_cost,total_cost,supplier_id,note,created_by
      ) values (
        item_row.id,item_row.name,'count',delta,item_row.cost_price,
        case when item_row.cost_price is null then null else abs(delta)*item_row.cost_price end,
        item_row.supplier_id,publication_line.movement_note,p_actor_id
      );

      update atlas_private.inventory_count_publication_lines
      set status='applied',production_after_quantity=item_row.quantity,applied_at=now(),updated_at=now()
      where id=publication_line.id;
    else
      update atlas_private.inventory_count_publication_lines
      set status='skipped',production_after_quantity=item_row.quantity,applied_at=now(),updated_at=now()
      where id=publication_line.id;
    end if;
  end loop;

  update atlas_private.inventory_count_publications
  set status='published',published_by=p_actor_id,published_by_label=p_actor_label,published_at=now(),
      blocked_reason=null,failure_message=null,updated_at=now()
  where id=publication_row.id;

  update atlas_private.inventory_count_sessions
  set publication_status='published',production_applied=true,published_by=p_actor_id,
      published_by_label=p_actor_label,published_at=now(),version=version+1,updated_at=now()
  where id=p_session_id;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'session_published',p_session_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('publication_id',publication_row.id,'request_id',publication_row.request_id,
      'item_count',publication_row.item_count,'adjustment_count',publication_row.adjustment_count)
  );

  return atlas_private.stock_count_detail(p_session_id,p_actor_id,p_actor_role);
exception when others then
  update atlas_private.inventory_count_publications
  set status='failed',failure_message=sqlerrm,updated_at=now()
  where session_id=p_session_id and request_id=trim(p_request_id) and status<>'published';
  update atlas_private.inventory_count_sessions
  set publication_status='failed',version=version+1,updated_at=now()
  where id=p_session_id and not production_applied;
  insert into atlas_private.inventory_count_events (
    event_type,session_id,actor_id,actor_label,actor_role,payload
  ) values (
    'publication_failed',p_session_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('request_id',trim(p_request_id),'error',sqlerrm)
  );
  raise;
end;
$$;

create or replace function public.atlas_stock_count_prepare_publication(uuid,jsonb,text,uuid,text,text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select atlas_private.stock_count_prepare_publication($1,$2,$3,$4,$5,$6); $$;

create or replace function public.atlas_stock_count_publish(uuid,text,uuid,text,text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$ select atlas_private.stock_count_publish($1,$2,$3,$4,$5); $$;

revoke all on function public.atlas_stock_count_prepare_publication(uuid,jsonb,text,uuid,text,text)
  from public,anon,authenticated;
revoke all on function public.atlas_stock_count_publish(uuid,text,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.atlas_stock_count_prepare_publication(uuid,jsonb,text,uuid,text,text)
  to service_role;
grant execute on function public.atlas_stock_count_publish(uuid,text,uuid,text,text)
  to service_role;

-- Preview and branch deployments stay read-only until an explicit production
-- release decision enables publication after authenticated browser acceptance.
update atlas_private.inventory_count_settings
set production_apply_enabled=false,updated_at=now()
where setting_key='va';

comment on table atlas_private.inventory_count_publications is
  'Manager-approved publication plans. Count observations and verification cannot mutate live inventory; only stock_count_publish can create controlled count adjustments.';
