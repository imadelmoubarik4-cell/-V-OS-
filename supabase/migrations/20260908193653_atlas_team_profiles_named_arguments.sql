-- Restore the named PostgREST contract for the Team Profiles gateway wrappers.
-- Private implementations, profile data, onboarding data, RLS policies, and production remain unchanged.

create or replace function public.atlas_team_profiles_snapshot(
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select atlas_private.team_profiles_snapshot(
    p_profiles,
    p_tasks,
    p_progress,
    p_actor_id,
    p_actor_role
  );
$function$;

create or replace function public.atlas_team_profile_upsert_details(
  p_profile_id uuid,
  p_preferred_name text,
  p_job_title text,
  p_department text,
  p_employment_type text,
  p_start_date date,
  p_phone text,
  p_phone_visibility text,
  p_preferred_language text,
  p_manager_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.team_profile_upsert_details(
    p_profile_id,
    p_preferred_name,
    p_job_title,
    p_department,
    p_employment_type,
    p_start_date,
    p_phone,
    p_phone_visibility,
    p_preferred_language,
    p_manager_notes,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_team_profile_save_emergency_contact(
  p_contact_id uuid,
  p_profile_id uuid,
  p_contact_name text,
  p_relationship text,
  p_phone text,
  p_note text,
  p_priority smallint,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.team_profile_save_emergency_contact(
    p_contact_id,
    p_profile_id,
    p_contact_name,
    p_relationship,
    p_phone,
    p_note,
    p_priority,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_team_profile_remove_emergency_contact(
  p_contact_id uuid,
  p_profile_id uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.team_profile_remove_emergency_contact(
    p_contact_id,
    p_profile_id,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_team_profile_log_external_event(
  p_event_type text,
  p_profile_id uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_payload jsonb
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.team_profile_log_external_event(
    p_event_type,
    p_profile_id,
    p_actor_id,
    p_actor_label,
    p_actor_role,
    p_payload
  );
$function$;

revoke all on function public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text) from public, anon, authenticated;
revoke all on function public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb) from public, anon, authenticated;

grant execute on function public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text) to service_role;
grant execute on function public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text) to service_role;
grant execute on function public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text) to service_role;
grant execute on function public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb) to service_role;

notify pgrst, 'reload schema';
