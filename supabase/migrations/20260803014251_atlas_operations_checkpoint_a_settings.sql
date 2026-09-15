-- Checkpoint A manager settings snapshot.
-- Service-role-only and contains no credentials.

create or replace function atlas_private.operations_settings()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
select jsonb_build_object(
  'version','atlas-operations-settings/0.1.0',
  'templates',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',template.id,
      'template_key',template.template_key,
      'name',template.name,
      'description',template.description,
      'routine_type',template.routine_type,
      'recurrence',template.recurrence,
      'days_of_week',template.days_of_week,
      'available_from',template.available_from,
      'due_time',template.due_time,
      'assigned_role',template.assigned_role,
      'requires_manager_signoff',template.requires_manager_signoff,
      'allow_photo_evidence',template.allow_photo_evidence,
      'active',template.active,
      'display_order',template.display_order,
      'item_count',(select count(*) from atlas_private.routine_template_items item where item.template_id=template.id and item.active=true),
      'metadata',template.metadata
    ) order by template.display_order,template.name)
    from atlas_private.routine_templates template
  ),'[]'::jsonb),
  'temperature_points',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',point.id,
      'point_key',point.point_key,
      'name',point.name,
      'location',point.location,
      'equipment_type',point.equipment_type,
      'min_temp_c',point.min_temp_c,
      'max_temp_c',point.max_temp_c,
      'active',point.active,
      'display_order',point.display_order,
      'metadata',point.metadata
    ) order by point.display_order,point.name)
    from atlas_private.temperature_points point
  ),'[]'::jsonb),
  'connections',coalesce((
    select jsonb_agg(jsonb_build_object(
      'provider_key',connection.provider_key,
      'label',connection.label,
      'category',connection.category,
      'status',connection.status,
      'capabilities',connection.capabilities,
      'requirements',connection.requirements,
      'external_account_id',connection.external_account_id,
      'external_account_label',connection.external_account_label,
      'last_verified_at',connection.last_verified_at,
      'metadata',connection.metadata
    ) order by connection.category,connection.label)
    from atlas_private.integration_connections connection
  ),'[]'::jsonb)
);
$$;

create or replace function public.atlas_operations_settings()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$ select atlas_private.operations_settings(); $$;

revoke execute on function atlas_private.operations_settings() from public,anon,authenticated;
revoke execute on function public.atlas_operations_settings() from public,anon,authenticated;
grant execute on function atlas_private.operations_settings() to service_role;
grant execute on function public.atlas_operations_settings() to service_role;

comment on function public.atlas_operations_settings() is
  'Service-role-only manager settings snapshot for recurring routines, temperature points and integration boundaries.';
