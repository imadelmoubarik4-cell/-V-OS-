-- S88 shared daily checklists.
--
-- The Operations opening and closing checklists were kept in browser
-- localStorage per device. They now reuse the audited Checkpoint A routine
-- model (routine_templates / routine_template_items / routine_instances /
-- routine_item_results / operations_events): no new table.
--
-- * routine_type gains 'opening' and 'closing'; templates gain date_basis
--   ('calendar' or 'business').
-- * Two templates are seeded with the nine current items each. No due time or
--   availability time is invented. Seeds use "on conflict do nothing" so owner
--   edits survive a re-run.
-- * operations_today uses the venue clock (S88 venue_clock migration), exposes
--   the business date, and never raises alerts for the daily checklists.
-- * set_routine_item requires an active writer profile (admin, manager,
--   bartender) and refuses edits to checklist days older than yesterday's
--   business date, so history stays immutable.
-- * operations_business_date / operations_daily_checklists are new
--   service-role-only reads for the Edge Function.

alter table atlas_private.routine_templates
  drop constraint if exists routine_templates_routine_type_check;
alter table atlas_private.routine_templates
  add constraint routine_templates_routine_type_check check (routine_type in (
    'inventory','deep_cleaning','storage','temperature','other','opening','closing'));

alter table atlas_private.routine_templates
  add column if not exists date_basis text not null default 'calendar';
alter table atlas_private.routine_templates
  drop constraint if exists routine_templates_date_basis_check;
alter table atlas_private.routine_templates
  add constraint routine_templates_date_basis_check check (date_basis in ('calendar','business'));

insert into atlas_private.routine_templates (
  template_key,name,description,routine_type,recurrence,days_of_week,
  available_from,due_time,assigned_role,requires_manager_signoff,
  allow_photo_evidence,active,display_order,metadata,date_basis
) values
  ('daily-opening-checklist','Opening checklist','Shared opening checks for the business day.',
    'opening','daily',array[0,1,2,3,4,5,6]::smallint[],null,null,'any_active_staff',false,false,true,1,
    '{"surface":"operations-daily-checklist","origin":"operations.js S87"}'::jsonb,'business'),
  ('daily-closing-checklist','Closing checklist','Shared closing checks for the business day.',
    'closing','daily',array[0,1,2,3,4,5,6]::smallint[],null,null,'any_active_staff',false,false,true,2,
    '{"surface":"operations-daily-checklist","origin":"operations.js S87"}'::jsonb,'business')
on conflict (template_key) do nothing;

with template as (select id from atlas_private.routine_templates where template_key='daily-opening-checklist')
insert into atlas_private.routine_template_items (template_id,item_key,section,label,description,evidence_type,required,display_order,metadata)
select template.id, item_key, 'Opening', label, null, 'none', true, display_order, '{}'::jsonb
from template cross join (values
  ('cash-pos','Confirm POS, cash float and card terminals',10),
  ('coffee-machine','Start and test the coffee machine',20),
  ('ice','Check ice production and service wells',30),
  ('garnish','Prepare garnish and fresh citrus',40),
  ('glassware','Polish and stock service glassware',50),
  ('bar-stock','Restock the bar to service levels',60),
  ('music-lighting','Set music, lighting and guest areas',70),
  ('toilets','Complete the guest-area and toilet check',80),
  ('tablet','Charge and position the service tablet',90)
) as items(item_key,label,display_order)
on conflict (template_id,item_key) do nothing;

with template as (select id from atlas_private.routine_templates where template_key='daily-closing-checklist')
insert into atlas_private.routine_template_items (template_id,item_key,section,label,description,evidence_type,required,display_order,metadata)
select template.id, item_key, 'Closing', label, null, 'none', true, display_order, '{}'::jsonb
from template cross join (values
  ('cash-close','Close and reconcile the register',10),
  ('dishwasher','Empty and clean the dishwasher',20),
  ('waste','Record waste and remove rubbish',30),
  ('alcohol','Secure alcohol and high-value stock',40),
  ('bar-clean','Clean stations, tools and work surfaces',50),
  ('equipment','Switch off and check equipment',60),
  ('lights','Turn off music and non-essential lighting',70),
  ('alarm','Lock doors and set the alarm',80),
  ('shift-report','Submit the shift handover report',90)
) as items(item_key,label,display_order)
on conflict (template_id,item_key) do nothing;

create or replace function atlas_private.operations_today(p_local_date date)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  local_now timestamp := pg_catalog.now() at time zone atlas_private.venue_timezone();
  routines_json jsonb := '[]'::jsonb;
  points_json jsonb := '[]'::jsonb;
  temperature_summary jsonb := '{}'::jsonb;
  alerts_json jsonb := '[]'::jsonb;
  connections_json jsonb := '[]'::jsonb;
begin
  perform atlas_private.ensure_routine_instances(p_local_date);

  update atlas_private.routine_instances instance
  set status='overdue'
  from atlas_private.routine_templates template
  where instance.template_id=template.id
    and instance.scheduled_date=p_local_date
    and instance.status in ('scheduled','in_progress')
    and template.due_time is not null
    and p_local_date = local_now::date
    and local_now::time > template.due_time;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',instance.id,'template_id',template.id,'template_key',template.template_key,
    'name',template.name,'description',template.description,'routine_type',template.routine_type,
    'date_basis',template.date_basis,
    'available_from',template.available_from,'due_time',template.due_time,
    'assigned_role',template.assigned_role,'requires_manager_signoff',template.requires_manager_signoff,
    'allow_photo_evidence',template.allow_photo_evidence,'status',instance.status,
    'scheduled_date',instance.scheduled_date,'started_at',instance.started_at,
    'started_by_label',instance.started_by_label,
    'completed_at',instance.completed_at,'completed_by_label',instance.completed_by_label,
    'completion_notes',instance.completion_notes,
    'progress',jsonb_build_object(
      'required',coalesce(counts.required_count,0),'completed',coalesce(counts.completed_count,0),
      'percent',case when coalesce(counts.required_count,0)=0 then
        case when template.routine_type='temperature' then 0 else 100 end
        else round((counts.completed_count::numeric/counts.required_count::numeric)*100) end),
    'items',coalesce(items.items,'[]'::jsonb),'metadata',template.metadata
  ) order by template.display_order,template.name),'[]'::jsonb)
  into routines_json
  from atlas_private.routine_instances instance
  join atlas_private.routine_templates template on template.id=instance.template_id
  left join lateral (
    select count(*) filter (where item.required and item.active)::bigint as required_count,
      count(*) filter (where item.required and item.active and coalesce(result.completed,false))::bigint as completed_count
    from atlas_private.routine_template_items item
    left join atlas_private.routine_item_results result
      on result.template_item_id=item.id and result.instance_id=instance.id
    where item.template_id=template.id
  ) counts on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'id',item.id,'item_key',item.item_key,'section',item.section,'label',item.label,
      'description',item.description,'evidence_type',item.evidence_type,'required',item.required,
      'completed',coalesce(result.completed,false),'note',result.note,
      'evidence',coalesce(result.evidence,'{}'::jsonb),'completed_at',result.completed_at,
      'completed_by_label',result.completed_by_label,'metadata',item.metadata
    ) order by item.display_order,item.label) as items
    from atlas_private.routine_template_items item
    left join atlas_private.routine_item_results result
      on result.template_item_id=item.id and result.instance_id=instance.id
    where item.template_id=template.id and item.active=true
  ) items on true
  where instance.scheduled_date=p_local_date;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',point.id,'point_key',point.point_key,'name',point.name,'location',point.location,
    'equipment_type',point.equipment_type,'min_temp_c',point.min_temp_c,'max_temp_c',point.max_temp_c,
    'range_configured',(point.min_temp_c is not null or point.max_temp_c is not null),
    'logged_today',(latest.id is not null),
    'latest_log',case when latest.id is null then null else jsonb_build_object(
      'id',latest.id,'temperature_c',latest.temperature_c,'range_status',latest.range_status,
      'corrective_action',latest.corrective_action,'note',latest.note,
      'reading_at',latest.reading_at,'logged_by_label',latest.logged_by_label) end,
    'metadata',point.metadata
  ) order by point.display_order,point.name),'[]'::jsonb)
  into points_json
  from atlas_private.temperature_points point
  left join lateral (
    select log.* from atlas_private.temperature_logs log
    where log.point_id=point.id and log.reading_date=p_local_date
    order by log.reading_at desc limit 1
  ) latest on true
  where point.active=true;

  select jsonb_build_object(
    'required_points',count(*)::bigint,
    'logged_points',count(*) filter (where latest.id is not null)::bigint,
    'outstanding_points',count(*) filter (where latest.id is null)::bigint,
    'outside_range_points',count(*) filter (where latest.range_status='outside_range')::bigint,
    'range_unconfigured_points',count(*) filter (where point.min_temp_c is null and point.max_temp_c is null)::bigint,
    'complete',(count(*)>0 and count(*) filter (where latest.id is not null)=count(*))
  ) into temperature_summary
  from atlas_private.temperature_points point
  left join lateral (
    select log.* from atlas_private.temperature_logs log
    where log.point_id=point.id and log.reading_date=p_local_date
    order by log.reading_at desc limit 1
  ) latest on true
  where point.active=true;

  -- Daily opening/closing checklists have no due time and are shown in their
  -- own card, so they never raise a routine alert.
  select coalesce(jsonb_agg(alert order by priority,sort_name),'[]'::jsonb)
  into alerts_json
  from (
    select case when instance.status='overdue' then 1 else 10 end as priority,
      template.name as sort_name,
      jsonb_build_object(
        'key','routine:'||instance.id::text,'kind','routine',
        'severity',case when instance.status='overdue' then 'high' else 'medium' end,
        'title',coalesce(template.metadata->>'alert_label',template.name),
        'detail',case when instance.status='overdue' then 'This routine is overdue.' else 'This routine is scheduled for today.' end,
        'routine_id',instance.id,'status',instance.status,'due_time',template.due_time,'target','routines') as alert
    from atlas_private.routine_instances instance
    join atlas_private.routine_templates template on template.id=instance.template_id
    where instance.scheduled_date=p_local_date
      and template.routine_type not in ('temperature','opening','closing')
      and instance.status not in ('completed','skipped')
    union all
    select 5,'Daily temperature log',jsonb_build_object(
      'key','temperature:'||p_local_date::text,'kind','temperature',
      'severity',case when (temperature_summary->>'outside_range_points')::bigint>0 then 'high' else 'medium' end,
      'title','Daily temperature log',
      'detail',format('%s of %s active points logged.',temperature_summary->>'logged_points',temperature_summary->>'required_points'),
      'status',case when (temperature_summary->>'complete')::boolean then 'completed' else 'due' end,
      'target','temperature-log')
    where not (temperature_summary->>'complete')::boolean
       or (temperature_summary->>'outside_range_points')::bigint>0
  ) alerts;

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_key',provider_key,'label',label,'category',category,'status',status,
    'capabilities',capabilities,'requirements',requirements,
    'external_account_label',external_account_label,'last_verified_at',last_verified_at,'metadata',metadata
  ) order by category,label),'[]'::jsonb)
  into connections_json
  from atlas_private.integration_connections;

  return jsonb_build_object(
    'version','atlas-operations-checkpoint-a/0.2.0','venue_date',p_local_date,
    'calendar_date',local_now::date,'business_date',atlas_private.venue_business_date(),
    'timezone',atlas_private.venue_timezone(),
    'generated_at',pg_catalog.now(),'routines',routines_json,
    'temperature',jsonb_build_object('summary',temperature_summary,'points',points_json),
    'alerts',alerts_json,'connections',connections_json,
    'trust',jsonb_build_object('private_branch',true,'manager_review_for_settings',true,
      'quantity_mutation',false,'temperature_logs_audited',true,'routine_history_preserved',true));
end;
$$;

create or replace function atlas_private.set_routine_item(
  p_instance_id uuid,
  p_template_item_id uuid,
  p_completed boolean,
  p_note text,
  p_evidence jsonb,
  p_actor_id uuid,
  p_actor_label text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  instance_row atlas_private.routine_instances;
  template_item_row atlas_private.routine_template_items;
  template_row atlas_private.routine_templates;
  completed_required_count bigint;
  local_now timestamp := pg_catalog.now() at time zone atlas_private.venue_timezone();
begin
  -- The Edge Function already limits writes to active admin, manager and
  -- bartender profiles; the database repeats the check for every caller.
  if p_actor_id is null or not exists (
    select 1 from public.profiles profile
    where profile.id=p_actor_id and profile.active is true
      and profile.role::text in ('admin','manager','bartender')
  ) then
    raise exception 'An active Atlas staff profile with write access is required'
      using errcode='42501', hint='atlas:forbidden';
  end if;

  select * into instance_row
  from atlas_private.routine_instances
  where id=p_instance_id
  for update;
  if not found then raise exception 'Routine instance not found' using hint='atlas:not_found'; end if;
  if instance_row.status in ('completed','skipped') then
    raise exception 'Completed or skipped routines cannot be edited' using hint='atlas:routine_closed';
  end if;
  if instance_row.scheduled_date < atlas_private.venue_business_date() - 1 then
    raise exception 'This checklist day is closed' using hint='atlas:checklist_day_closed';
  end if;

  select * into template_item_row
  from atlas_private.routine_template_items
  where id=p_template_item_id
    and template_id=instance_row.template_id
    and active=true;
  if not found then raise exception 'Routine checklist item not found' using hint='atlas:not_found'; end if;

  select * into template_row
  from atlas_private.routine_templates
  where id=instance_row.template_id;

  insert into atlas_private.routine_item_results (
    instance_id,template_item_id,completed,note,evidence,
    completed_at,completed_by,completed_by_label
  ) values (
    p_instance_id,p_template_item_id,p_completed,
    nullif(trim(coalesce(p_note,'')),''),coalesce(p_evidence,'{}'::jsonb),
    case when p_completed then pg_catalog.now() else null end,
    case when p_completed then p_actor_id else null end,
    case when p_completed then p_actor_label else null end
  )
  on conflict (instance_id,template_item_id) do update set
    completed=excluded.completed,
    note=excluded.note,
    evidence=excluded.evidence,
    completed_at=excluded.completed_at,
    completed_by=excluded.completed_by,
    completed_by_label=excluded.completed_by_label,
    updated_at=pg_catalog.now();

  select count(*) into completed_required_count
  from atlas_private.routine_template_items item
  join atlas_private.routine_item_results result
    on result.template_item_id=item.id
   and result.instance_id=p_instance_id
   and result.completed=true
  where item.template_id=instance_row.template_id
    and item.active=true
    and item.required=true;

  update atlas_private.routine_instances
  set status=case
        when completed_required_count > 0 then 'in_progress'
        when scheduled_date=local_now::date
          and template_row.due_time is not null
          and local_now::time > template_row.due_time then 'overdue'
        else 'scheduled'
      end,
      started_at=case
        when completed_required_count > 0 then coalesce(started_at,pg_catalog.now())
        else null
      end,
      started_by=case
        when completed_required_count > 0 then coalesce(started_by,p_actor_id)
        else null
      end,
      started_by_label=case
        when completed_required_count > 0 then coalesce(started_by_label,p_actor_label)
        else null
      end
  where id=p_instance_id;

  insert into atlas_private.operations_events (
    event_type,entity_type,entity_id,actor_id,actor_label,payload
  ) values (
    'routine_item_updated','routine_instance',p_instance_id,p_actor_id,p_actor_label,
    jsonb_build_object(
      'template_item_id',p_template_item_id,
      'item_key',template_item_row.item_key,
      'template_key',template_row.template_key,
      'completed',p_completed,
      'completed_required_count',completed_required_count,
      'note',p_note,
      'evidence_source',coalesce(p_evidence,'{}'::jsonb)->>'source'
    )
  );

  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

create or replace function atlas_private.operations_business_date()
returns date
language sql
stable
security invoker
set search_path=''
as $$ select atlas_private.venue_business_date(); $$;

-- The two daily checklists for one business date (default: the current
-- business date). Instances are created on first read, exactly like
-- operations_today. "editable" mirrors the set_routine_item day guard.
create or replace function atlas_private.operations_daily_checklists(p_business_date date default null)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  business_today date := atlas_private.venue_business_date();
  target_date date := coalesce(p_business_date, business_today);
  snapshot jsonb;
  checklist_json jsonb;
begin
  if target_date > business_today + 1 then
    raise exception 'Checklists can only be opened up to one day ahead' using hint='atlas:invalid_date';
  end if;
  snapshot := atlas_private.operations_today(target_date);
  select coalesce(jsonb_object_agg(routine->>'routine_type', routine), '{}'::jsonb)
  into checklist_json
  from jsonb_array_elements(snapshot->'routines') routine
  where routine->>'routine_type' in ('opening','closing');

  return jsonb_build_object(
    'business_date',target_date,
    'current_business_date',business_today,
    'venue_date',atlas_private.venue_date(),
    'timezone',atlas_private.venue_timezone(),
    'editable',target_date >= business_today - 1,
    'configured',(checklist_json ? 'opening') and (checklist_json ? 'closing'),
    'opening',checklist_json->'opening',
    'closing',checklist_json->'closing',
    'generated_at',pg_catalog.now()
  );
end;
$$;

create or replace function public.atlas_operations_business_date()
returns date
language sql
stable
security invoker
set search_path=''
as $$ select atlas_private.operations_business_date(); $$;

create or replace function public.atlas_operations_daily_checklists(p_business_date date default null)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$ select atlas_private.operations_daily_checklists(p_business_date); $$;

do $s88_checklist_grants$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'atlas_private' and p.proname in (
        'operations_today','set_routine_item','operations_business_date','operations_daily_checklists'))
       or (n.nspname = 'public' and p.proname in (
        'atlas_operations_business_date','atlas_operations_daily_checklists'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', function_row.signature);
    execute format('grant execute on function %s to service_role', function_row.signature);
  end loop;
end
$s88_checklist_grants$;

comment on function public.atlas_operations_daily_checklists(date) is
  'S88 service-role-only shared opening/closing checklists for one business date.';

notify pgrst, 'reload schema';
