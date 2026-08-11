-- Checkpoint H foundation.
--
-- This first contract established the service-role-only Reports RPC while the
-- live-source hand-off was being added. The following migration replaces it
-- with atlas_reports_snapshot_v2, which accepts production records only after
-- the authenticated gateway has applied role-based data minimisation.

create or replace function atlas_private.reports_snapshot(
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text,
  p_period_start date,
  p_period_end date,
  p_comparison_start date,
  p_comparison_end date,
  p_comparison_key text default 'previous_period',
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'version','atlas-reports/0.1.0',
    'generated_at',pg_catalog.now(),
    'timezone','Atlantic/Reykjavik',
    'currency','ISK',
    'period',jsonb_build_object(
      'start',p_period_start,
      'end',p_period_end
    ),
    'comparison',jsonb_build_object(
      'key',coalesce(p_comparison_key,'previous_period'),
      'start',p_comparison_start,
      'end',p_comparison_end,
      'enabled',p_comparison_start is not null and p_comparison_end is not null
    ),
    'filters',coalesce(p_filters,'{}'::jsonb),
    'sections','[]'::jsonb,
    'kpis','[]'::jsonb,
    'attention','[]'::jsonb,
    'data_sources',jsonb_build_array(jsonb_build_object(
      'key','foundation',
      'name','Reports live-source gateway',
      'status','waiting_for_live_sources',
      'note','The next versioned migration supplies production records through the authenticated gateway.'
    )),
    'reports','{}'::jsonb,
    'permissions',jsonb_build_object(
      'can_view_manager_reports',p_actor_role in ('admin','manager'),
      'can_view_employee_detail',p_actor_role in ('admin','manager'),
      'can_export',true,
      'can_ask_atlas',true,
      'read_only',true
    ),
    'trust',jsonb_build_object(
      'reports_are_read_only',true,
      'sales_values_invented',false,
      'source_data_modified',false,
      'permission_sensitive_data_loaded_for_staff',false,
      'reykjavik_reporting_timezone',true,
      'currency','ISK'
    )
  );
$$;

create or replace function public.atlas_reports_snapshot(
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text,
  p_period_start date,
  p_period_end date,
  p_comparison_start date,
  p_comparison_end date,
  p_comparison_key text,
  p_filters jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.reports_snapshot(
    p_profiles,p_tasks,p_progress,p_actor_id,p_actor_role,p_period_start,p_period_end,
    p_comparison_start,p_comparison_end,p_comparison_key,p_filters
  );
$$;

revoke execute on function public.atlas_reports_snapshot(jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.atlas_reports_snapshot(jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  to service_role;

comment on function public.atlas_reports_snapshot(jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)
  is 'Checkpoint H Reports foundation. Superseded by atlas_reports_snapshot_v2 after live-source role filtering.';
