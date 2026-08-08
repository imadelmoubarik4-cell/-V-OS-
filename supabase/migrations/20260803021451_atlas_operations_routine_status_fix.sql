-- Checkpoint A status correction.
-- Returning the last required checklist item to unchecked must return the
-- routine to scheduled/overdue instead of leaving a misleading 0/N in-progress state.

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
  local_now timestamp := pg_catalog.now() at time zone 'Atlantic/Reykjavik';
begin
  select * into instance_row
  from atlas_private.routine_instances
  where id=p_instance_id
  for update;
  if not found then raise exception 'Routine instance not found'; end if;
  if instance_row.status in ('completed','skipped') then
    raise exception 'Completed or skipped routines cannot be edited';
  end if;

  select * into template_item_row
  from atlas_private.routine_template_items
  where id=p_template_item_id
    and template_id=instance_row.template_id
    and active=true;
  if not found then raise exception 'Routine checklist item not found'; end if;

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
      'completed',p_completed,
      'completed_required_count',completed_required_count,
      'note',p_note
    )
  );

  return atlas_private.operations_today(instance_row.scheduled_date);
end;
$$;

update atlas_private.routine_instances instance
set status=case
      when instance.scheduled_date=(pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date
        and template.due_time is not null
        and (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::time > template.due_time
      then 'overdue'
      else 'scheduled'
    end,
    started_at=null,
    started_by=null,
    started_by_label=null
from atlas_private.routine_templates template
where instance.template_id=template.id
  and instance.status='in_progress'
  and not exists (
    select 1
    from atlas_private.routine_item_results result
    join atlas_private.routine_template_items item on item.id=result.template_item_id
    where result.instance_id=instance.id
      and result.completed=true
      and item.active=true
      and item.required=true
  );
