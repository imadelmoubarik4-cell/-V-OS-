-- S96 (opsrisk): attributable, append-only audit of staff access changes.
--
-- Problem: public.profiles (role, active, email) is the authorization source
-- for every RLS policy and every Edge Function (_shared/auth.mjs). An active
-- admin may PATCH /rest/v1/profiles directly (policy "active administrators
-- update profiles"); atlas-team-profiles only logs role/active changes
-- *after* the PATCH, best-effort, in a separate request, so a direct PATCH
-- (or a service-role / SQL change) leaves no audit record at all.
--
-- Fix: a database trigger records every INSERT/DELETE and every change of
-- role, active, email or id on public.profiles into
-- atlas_private.security_audit_events, in the same transaction as the
-- change (it cannot be skipped by calling PostgREST directly), with the
-- acting user (auth.uid()), the acting user's current profile role, the
-- request role claim (authenticated / service_role) and the database
-- session user. The table is append-only (private.audit_append_only from
-- 20261010096000).
--
-- SECURITY DEFINER is required and deliberate here: the trigger fires in the
-- caller's context (authenticated has no USAGE on atlas_private) and must be
-- able to insert the audit row that the caller must not be able to write,
-- change or skip. search_path is pinned to '' and the function is not
-- executable by API roles.

create table if not exists atlas_private.security_audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default pg_catalog.clock_timestamp(),
  action text not null,
  target_type text not null,
  target_id uuid,
  actor_id uuid,
  actor_profile_role text,
  request_role text,
  session_user_name text not null default session_user,
  old_values jsonb,
  new_values jsonb,
  constraint security_audit_events_action_check check (action ~ '^[a-z_.]{3,64}$')
);

alter table atlas_private.security_audit_events enable row level security;
revoke all on table atlas_private.security_audit_events from public, anon, authenticated, service_role;
grant select on table atlas_private.security_audit_events to service_role;

drop policy if exists "service role reads security audit" on atlas_private.security_audit_events;
create policy "service role reads security audit"
  on atlas_private.security_audit_events for select to service_role using (true);

create index if not exists security_audit_events_target_idx
  on atlas_private.security_audit_events (target_type, target_id, occurred_at desc);
create index if not exists security_audit_events_actor_idx
  on atlas_private.security_audit_events (actor_id, occurred_at desc);

drop trigger if exists s96_append_only on atlas_private.security_audit_events;
create trigger s96_append_only before update or delete on atlas_private.security_audit_events
  for each row execute function private.audit_append_only();
drop trigger if exists s96_append_only_no_truncate on atlas_private.security_audit_events;
create trigger s96_append_only_no_truncate before truncate on atlas_private.security_audit_events
  for each statement execute function private.audit_append_only();

create or replace function private.profile_access_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  acting_user uuid := (select auth.uid());
  claims_role text := nullif(current_setting('request.jwt.claim.role', true), '');
  acting_role text;
  action_name text;
  old_doc jsonb;
  new_doc jsonb;
begin
  if claims_role is null then
    begin
      claims_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
    exception when others then
      claims_role := null;
    end;
  end if;

  if acting_user is not null then
    select profile.role::text into acting_role
    from public.profiles as profile
    where profile.id = acting_user;
  end if;

  if tg_op = 'INSERT' then
    action_name := 'profile.created';
    new_doc := jsonb_build_object('role', new.role::text, 'active', new.active, 'email', new.email);
  elsif tg_op = 'DELETE' then
    action_name := 'profile.deleted';
    old_doc := jsonb_build_object('role', old.role::text, 'active', old.active, 'email', old.email);
  else
    if new.role is not distinct from old.role
       and new.active is not distinct from old.active
       and new.email is not distinct from old.email
       and new.id is not distinct from old.id then
      return new; -- display name / timestamps only: not a security event
    end if;
    action_name := case
      when new.role is distinct from old.role then 'profile.role_changed'
      when new.active is distinct from old.active then
        case when new.active is true then 'profile.activated' else 'profile.deactivated' end
      else 'profile.identity_changed'
    end;
    old_doc := jsonb_build_object('id', old.id, 'role', old.role::text, 'active', old.active, 'email', old.email);
    new_doc := jsonb_build_object('id', new.id, 'role', new.role::text, 'active', new.active, 'email', new.email);
  end if;

  insert into atlas_private.security_audit_events (
    action, target_type, target_id, actor_id, actor_profile_role, request_role, old_values, new_values
  ) values (
    action_name, 'profile', coalesce(new.id, old.id), acting_user, acting_role, claims_role, old_doc, new_doc
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function private.profile_access_audit() from public, anon, authenticated, service_role;

drop trigger if exists s96_profiles_access_audit on public.profiles;
create trigger s96_profiles_access_audit
after insert or update or delete on public.profiles
for each row execute function private.profile_access_audit();
