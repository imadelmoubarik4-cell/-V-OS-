-- Restore the named PostgREST contract for Checkpoint J Settings.
--
-- The private functions already expose stable named arguments, but the public
-- service-role wrappers were recreated with positional-only parameters. The
-- Settings Edge Function sends named JSON payloads, so PostgREST could not
-- resolve atlas_settings_snapshot(p_actor_id, p_actor_role, p_profiles).
-- Keep every public wrapper security-invoker and service-role-only.

create or replace function public.atlas_settings_snapshot(
  p_profiles jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select atlas_private.settings_snapshot(p_profiles, p_actor_id, p_actor_role);
$function$;

create or replace function public.atlas_settings_save_section(
  p_section_key text,
  p_value jsonb,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_section(
    p_section_key,
    p_value,
    p_expected_version,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_settings_save_hours(
  p_hours jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_hours(
    p_hours,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_settings_save_offer(
  p_offer_id uuid,
  p_offer_key text,
  p_name text,
  p_description text,
  p_active boolean,
  p_days smallint[],
  p_start_time time without time zone,
  p_end_time time without time zone,
  p_end_next_day boolean,
  p_pricing jsonb,
  p_booking_url text,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_offer(
    p_offer_id,
    p_offer_key,
    p_name,
    p_description,
    p_active,
    p_days,
    p_start_time,
    p_end_time,
    p_end_next_day,
    p_pricing,
    p_booking_url,
    p_expected_version,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_settings_save_role(
  p_role_key text,
  p_permissions jsonb,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_role(
    p_role_key,
    p_permissions,
    p_expected_version,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_settings_save_notification_policy(
  p_event_key text,
  p_enabled boolean,
  p_channels jsonb,
  p_target_roles text[],
  p_reminder_minutes integer[],
  p_escalation_minutes integer,
  p_manager_approval_required boolean,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_notification_policy(
    p_event_key,
    p_enabled,
    p_channels,
    p_target_roles,
    p_reminder_minutes,
    p_escalation_minutes,
    p_manager_approval_required,
    p_expected_version,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_settings_save_preferences(
  p_user_id uuid,
  p_theme text,
  p_density text,
  p_language text,
  p_start_view text,
  p_timezone text,
  p_reduce_motion boolean,
  p_browser_notifications boolean,
  p_email_notifications boolean,
  p_preferences jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select atlas_private.settings_save_preferences(
    p_user_id,
    p_theme,
    p_density,
    p_language,
    p_start_view,
    p_timezone,
    p_reduce_motion,
    p_browser_notifications,
    p_email_notifications,
    p_preferences,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

revoke all on function public.atlas_settings_snapshot(jsonb, uuid, text)
  from public, anon, authenticated;
revoke all on function public.atlas_settings_save_section(text, jsonb, integer, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.atlas_settings_save_hours(jsonb, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.atlas_settings_save_offer(uuid, text, text, text, boolean, smallint[], time without time zone, time without time zone, boolean, jsonb, text, integer, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.atlas_settings_save_role(text, jsonb, integer, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.atlas_settings_save_notification_policy(text, boolean, jsonb, text[], integer[], integer, boolean, integer, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.atlas_settings_save_preferences(uuid, text, text, text, text, text, boolean, boolean, boolean, jsonb, uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.atlas_settings_snapshot(jsonb, uuid, text)
  to service_role;
grant execute on function public.atlas_settings_save_section(text, jsonb, integer, uuid, text, text)
  to service_role;
grant execute on function public.atlas_settings_save_hours(jsonb, uuid, text, text)
  to service_role;
grant execute on function public.atlas_settings_save_offer(uuid, text, text, text, boolean, smallint[], time without time zone, time without time zone, boolean, jsonb, text, integer, uuid, text, text)
  to service_role;
grant execute on function public.atlas_settings_save_role(text, jsonb, integer, uuid, text, text)
  to service_role;
grant execute on function public.atlas_settings_save_notification_policy(text, boolean, jsonb, text[], integer[], integer, boolean, integer, uuid, text, text)
  to service_role;
grant execute on function public.atlas_settings_save_preferences(uuid, text, text, text, text, text, boolean, boolean, boolean, jsonb, uuid, text, text)
  to service_role;

notify pgrst, 'reload schema';
