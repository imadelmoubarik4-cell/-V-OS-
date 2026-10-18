-- S105 Team member removal & permanent deletion — branch-side data operations.
--
-- Supports the Team → More Actions → "Remove from Team" and "Delete Permanently"
-- feature. This migration owns ONLY the branch project's data (shift_people,
-- team_profile_details, emergency contacts, profile photos row) and a durable,
-- append-only deletion audit. The cross-project orchestration (authorization,
-- recent-MFA, last-admin/self guards, production `profiles` deactivation, and the
-- Supabase Auth user deletion) lives in the atlas-team-profiles Edge Function,
-- which alone can reach the production Auth project and admin API.
--
-- Key constraint honoured: atlas_private.shift_entries.person_id is ON DELETE
-- RESTRICT (historical shifts must never be silently destroyed). So:
--   * A person with NO shift entries can be hard-deleted (availability/time-off/
--     responses cascade; events SET NULL).
--   * A person WITH shift entries is ANONYMIZED instead (name/email/role cleared,
--     profile link dropped, archived) so the shift history survives, attributed to
--     a non-identifying "Former team member" row — never left in the active team.
--
-- Pattern A: tables stay in atlas_private, RLS on, service-role-only; the public
-- wrappers are SECURITY DEFINER, granted to service_role only. Append-only audit
-- uses the S96 private.audit_append_only triggers. Re-runnable.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- 1. Durable deletion audit (append-only; works for login + schedule-only) -------
create table if not exists atlas_private.team_member_deletion_audit (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('removed_from_team','permanently_deleted')),
  target_kind text not null check (target_kind in ('login','schedule_only')),
  target_profile_id uuid,
  target_person_id uuid,
  target_label text,
  mode text check (mode is null or mode in ('archived','full_delete','anonymized_kept_shifts')),
  shift_entry_count integer,
  actor_id uuid,
  actor_label text,
  actor_role text,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists team_member_deletion_audit_created_idx
  on atlas_private.team_member_deletion_audit (created_at desc);

alter table atlas_private.team_member_deletion_audit enable row level security;
drop policy if exists "service role manages team member deletion audit" on atlas_private.team_member_deletion_audit;
create policy "service role manages team member deletion audit" on atlas_private.team_member_deletion_audit
  for all to service_role using (true) with check (true);
revoke all on atlas_private.team_member_deletion_audit from public, anon, authenticated;
grant select, insert on atlas_private.team_member_deletion_audit to service_role;
revoke update, delete, truncate, references, trigger on atlas_private.team_member_deletion_audit from service_role, authenticated, anon;
drop trigger if exists s96_append_only on atlas_private.team_member_deletion_audit;
create trigger s96_append_only before update or delete on atlas_private.team_member_deletion_audit
  for each row execute function private.audit_append_only();
drop trigger if exists s96_append_only_no_truncate on atlas_private.team_member_deletion_audit;
create trigger s96_append_only_no_truncate before truncate on atlas_private.team_member_deletion_audit
  for each statement execute function private.audit_append_only();

-- 2. Resolve + preview -----------------------------------------------------------
-- Finds the roster person for a target (login member by profile_id, schedule-only
-- by person_id) and reports what a permanent delete would do. Read-only.
create or replace function atlas_private.team_member_deletion_preview(p_profile_id uuid, p_person_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  person atlas_private.shift_people;
  entry_count integer := 0;
  has_details boolean := false;
  has_photo boolean := false;
begin
  if p_profile_id is not null then
    select * into person from atlas_private.shift_people where profile_id = p_profile_id limit 1;
  elsif p_person_id is not null then
    select * into person from atlas_private.shift_people where id = p_person_id limit 1;
  end if;

  if person.id is not null then
    select count(*) into entry_count from atlas_private.shift_entries where person_id = person.id;
  end if;
  if p_profile_id is not null then
    select exists(select 1 from atlas_private.team_profile_details where profile_id = p_profile_id) into has_details;
    select exists(select 1 from atlas_private.team_profile_photos where profile_id = p_profile_id) into has_photo;
  end if;

  return jsonb_build_object(
    'found', (person.id is not null) or has_details,
    'account_kind', case when p_profile_id is not null then 'login' else 'schedule_only' end,
    'person_id', person.id,
    'profile_id', p_profile_id,
    'display_name', person.display_name,
    'shift_entry_count', entry_count,
    'has_shift_history', entry_count > 0,
    'has_profile_details', has_details,
    'has_profile_photo', has_photo,
    -- a person with shift history is anonymized (shifts retained); otherwise fully removed
    'hard_delete_mode', case when entry_count > 0 then 'anonymized_kept_shifts' else 'full_delete' end
  );
end
$function$;
revoke all on function atlas_private.team_member_deletion_preview(uuid, uuid) from public, anon, authenticated;

-- 3. Remove from team (archive — reversible; preserves every record) --------------
create or replace function atlas_private.team_member_remove_from_team(
  p_profile_id uuid, p_person_id uuid,
  p_actor_id uuid, p_actor_label text, p_actor_role text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare person atlas_private.shift_people; archived boolean := false;
begin
  if p_profile_id is not null then
    select * into person from atlas_private.shift_people where profile_id = p_profile_id limit 1;
  elsif p_person_id is not null then
    select * into person from atlas_private.shift_people where id = p_person_id limit 1;
  end if;

  if person.id is not null then
    update atlas_private.shift_people
      set active = false, updated_by = p_actor_id, updated_by_label = p_actor_label, updated_at = now()
      where id = person.id;
    archived := true;
  end if;

  insert into atlas_private.team_member_deletion_audit
    (action, target_kind, target_profile_id, target_person_id, target_label, mode, actor_id, actor_label, actor_role, detail)
  values ('removed_from_team', case when p_profile_id is not null then 'login' else 'schedule_only' end,
    p_profile_id, person.id, person.display_name, 'archived', p_actor_id, p_actor_label, p_actor_role,
    jsonb_build_object('roster_archived', archived));

  return jsonb_build_object('ok', true, 'roster_archived', archived, 'person_id', person.id);
end
$function$;
revoke all on function atlas_private.team_member_remove_from_team(uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- 4. Permanent purge of branch-side personal data --------------------------------
-- Deletes profile details + emergency contacts + the photo row (returns the
-- storage path so the Edge Function removes the object), and either hard-deletes
-- or anonymizes the roster person per shift history. Writes the durable audit.
-- The production `profiles` row + Supabase Auth user are deleted by the Edge
-- Function (cross-project), not here.
create or replace function atlas_private.team_member_purge_branch(
  p_profile_id uuid, p_person_id uuid,
  p_actor_id uuid, p_actor_label text, p_actor_role text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  person atlas_private.shift_people;
  entry_count integer := 0;
  photo_path text;
  details_deleted integer := 0;
  contacts_deleted integer := 0;
  mode text;
  label text;
  kind text := case when p_profile_id is not null then 'login' else 'schedule_only' end;
begin
  if p_profile_id is not null then
    select * into person from atlas_private.shift_people where profile_id = p_profile_id limit 1;
  elsif p_person_id is not null then
    select * into person from atlas_private.shift_people where id = p_person_id limit 1;
  end if;
  label := person.display_name;

  if person.id is not null then
    select count(*) into entry_count from atlas_private.shift_entries where person_id = person.id;
  end if;

  -- Branch personal data for a login member.
  if p_profile_id is not null then
    delete from atlas_private.team_emergency_contacts where profile_id = p_profile_id;
    get diagnostics contacts_deleted = row_count;
    delete from atlas_private.team_profile_details where profile_id = p_profile_id;
    get diagnostics details_deleted = row_count;
    select storage_path into photo_path from atlas_private.team_profile_photos where profile_id = p_profile_id;
    delete from atlas_private.team_profile_photos where profile_id = p_profile_id;
    if label is null then
      select display_name into label from atlas_private.team_profile_details where profile_id = p_profile_id; -- already deleted; label stays person.display_name/null
    end if;
  end if;

  -- Roster person: hard-delete when no shift history, else anonymize + archive.
  if person.id is not null then
    if entry_count = 0 then
      delete from atlas_private.shift_people where id = person.id; -- availability/time-off/responses cascade; events SET NULL
      mode := 'full_delete';
    else
      -- Unlink to a manual, anonymized historical entry. source must become
      -- 'manual' because a 'profile' row requires a non-null profile_id +
      -- login_enabled (shift_people CHECK); the shift history is preserved.
      update atlas_private.shift_people
        set display_name = 'Former team member', email = null, default_role = null,
            profile_id = null, login_enabled = false, active = false, source = 'manual',
            updated_by = p_actor_id, updated_by_label = p_actor_label, updated_at = now()
        where id = person.id;
      mode := 'anonymized_kept_shifts';
    end if;
  else
    mode := 'full_delete';
  end if;

  insert into atlas_private.team_member_deletion_audit
    (action, target_kind, target_profile_id, target_person_id, target_label, mode, shift_entry_count,
     actor_id, actor_label, actor_role, detail)
  values ('permanently_deleted', kind, p_profile_id, person.id, label, mode, entry_count,
    p_actor_id, p_actor_label, p_actor_role,
    jsonb_build_object('details_deleted', details_deleted, 'contacts_deleted', contacts_deleted,
      'photo_removed', photo_path is not null));

  return jsonb_build_object(
    'ok', true, 'mode', mode, 'shift_entry_count', entry_count,
    'photo_storage_path', photo_path,
    'details_deleted', details_deleted, 'contacts_deleted', contacts_deleted
  );
end
$function$;
revoke all on function atlas_private.team_member_purge_branch(uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- 5. Public wrappers (service_role only) -----------------------------------------
create or replace function public.atlas_team_member_deletion_preview(p_profile_id uuid, p_person_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select atlas_private.team_member_deletion_preview(p_profile_id, p_person_id); $$;
revoke all on function public.atlas_team_member_deletion_preview(uuid, uuid) from public, anon, authenticated;
grant execute on function public.atlas_team_member_deletion_preview(uuid, uuid) to service_role;

create or replace function public.atlas_team_member_remove_from_team(p_profile_id uuid, p_person_id uuid, p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.team_member_remove_from_team(p_profile_id, p_person_id, p_actor_id, p_actor_label, p_actor_role); $$;
revoke all on function public.atlas_team_member_remove_from_team(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.atlas_team_member_remove_from_team(uuid, uuid, uuid, text, text) to service_role;

create or replace function public.atlas_team_member_purge_branch(p_profile_id uuid, p_person_id uuid, p_actor_id uuid, p_actor_label text, p_actor_role text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.team_member_purge_branch(p_profile_id, p_person_id, p_actor_id, p_actor_label, p_actor_role); $$;
revoke all on function public.atlas_team_member_purge_branch(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.atlas_team_member_purge_branch(uuid, uuid, uuid, text, text) to service_role;
