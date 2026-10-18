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
    'found', (person.id is not null) or has_details or has_photo,
    'account_kind', case when p_profile_id is not null then 'login' else 'schedule_only' end,
    'person_id', person.id,
    -- The resolved roster row's own link, so the caller can refuse a schedule-only
    -- delete that actually points at a login-linked employee.
    'person_profile_id', person.profile_id,
    'login_enabled', coalesce(person.login_enabled, false),
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
  resolved boolean := false;
  kind text := case when p_profile_id is not null then 'login' else 'schedule_only' end;
begin
  -- Exactly one identifier. Never both (ambiguous), never neither (no target).
  if (p_profile_id is null) = (p_person_id is null) then
    raise exception 'exactly one of p_profile_id / p_person_id is required';
  end if;

  if p_profile_id is not null then
    select * into person from atlas_private.shift_people where profile_id = p_profile_id limit 1;
  else
    select * into person from atlas_private.shift_people where id = p_person_id limit 1;
    -- The schedule-only route must never touch a login-linked roster row: those
    -- belong to an auth account and are deleted through the profile route.
    if person.id is not null and person.profile_id is not null then
      raise exception 'person % is linked to a login profile; use the profile route', p_person_id;
    end if;
  end if;

  if person.id is not null then
    resolved := true;
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
    -- Durability: register the Storage object for cleanup in the SAME transaction
    -- that removes its DB reference, so the only information needed to finish the
    -- cleanup can never be lost if the Edge Function dies before Storage removal.
    -- The Edge Function marks it resolved only after Storage confirms deletion.
    if photo_path is not null then
      insert into atlas_private.team_member_deletion_orphans(storage_path, recorded_by, recorded_by_label)
      values (photo_path, p_actor_id, p_actor_label)
      on conflict (storage_path) do update set resolved_at = null, resolved_by = null, resolved_by_label = null,
        recorded_by = excluded.recorded_by, recorded_by_label = excluded.recorded_by_label;
    end if;
    if contacts_deleted > 0 or details_deleted > 0 or photo_path is not null then
      resolved := true;
    end if;
  end if;

  -- A schedule-only person is known ONLY by their roster row, so an unknown
  -- person_id must raise instead of looking like success. A login member is
  -- different: existence is owned by the production Auth account (verified by the
  -- Edge Function before this runs), and the branch side may legitimately be empty
  -- — an unaccepted invitation never had roster/detail rows, and a resumed delete
  -- after a failed Auth-user deletion has already purged them. So the login route
  -- is idempotent: zero branch rows is a valid no-op, not a false success.
  if not resolved and p_person_id is not null then
    raise exception 'no team member found for the given identifier';
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

  -- Append-only audit for a PERMANENT deletion keeps only non-identifying keys:
  -- the pseudonymous ids, counts and the acting administrator — never the deleted
  -- person's name, so an undeletable record can't defeat the erasure.
  insert into atlas_private.team_member_deletion_audit
    (action, target_kind, target_profile_id, target_person_id, target_label, mode, shift_entry_count,
     actor_id, actor_label, actor_role, detail)
  values ('permanently_deleted', kind, p_profile_id, person.id, null, mode, entry_count,
    p_actor_id, p_actor_label, p_actor_role,
    jsonb_build_object('details_deleted', details_deleted, 'contacts_deleted', contacts_deleted,
      'photo_removed', photo_path is not null, 'already_clean', not resolved));

  return jsonb_build_object(
    'ok', true, 'mode', mode, 'shift_entry_count', entry_count,
    'photo_storage_path', photo_path,
    'details_deleted', details_deleted, 'contacts_deleted', contacts_deleted,
    -- true when there was no branch-side data to remove (a resumed delete or an
    -- unaccepted invitation); the Edge Function still finishes the Auth deletion.
    'already_clean', not resolved
  );
end
$function$;
revoke all on function atlas_private.team_member_purge_branch(uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- 4b. Orphaned profile-photo registry (storage-cleanup retry) --------------------
-- When a permanent delete removes the photo DB row but the Storage object removal
-- fails, the object is left orphaned. We record its path here so an administrator
-- can finish the cleanup from inside Alcedo (no manual Supabase access), and mark
-- it resolved once removed. Resolvable (not append-only); service-role-only.
create table if not exists atlas_private.team_member_deletion_orphans (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  recorded_by uuid,
  recorded_by_label text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolved_by_label text
);
create index if not exists team_member_deletion_orphans_unresolved_idx
  on atlas_private.team_member_deletion_orphans (created_at) where resolved_at is null;

alter table atlas_private.team_member_deletion_orphans enable row level security;
drop policy if exists "service role manages photo orphans" on atlas_private.team_member_deletion_orphans;
create policy "service role manages photo orphans" on atlas_private.team_member_deletion_orphans
  for all to service_role using (true) with check (true);
revoke all on atlas_private.team_member_deletion_orphans from public, anon, authenticated;
grant select, insert, update on atlas_private.team_member_deletion_orphans to service_role;
revoke delete, truncate on atlas_private.team_member_deletion_orphans from service_role, authenticated, anon;

-- Record an orphan (idempotent: re-opens a previously resolved path if it recurs).
create or replace function atlas_private.team_member_record_photo_orphan(p_storage_path text, p_actor_id uuid, p_actor_label text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
begin
  if p_storage_path is null or length(p_storage_path) = 0 then
    raise exception 'a storage path is required';
  end if;
  insert into atlas_private.team_member_deletion_orphans(storage_path, recorded_by, recorded_by_label)
  values (p_storage_path, p_actor_id, p_actor_label)
  on conflict (storage_path) do update set resolved_at = null, resolved_by = null, resolved_by_label = null,
    recorded_by = excluded.recorded_by, recorded_by_label = excluded.recorded_by_label;
  return jsonb_build_object('ok', true, 'storage_path', p_storage_path);
end
$function$;
revoke all on function atlas_private.team_member_record_photo_orphan(text, uuid, text) from public, anon, authenticated;

-- List the unresolved orphans (newest first) for the admin cleanup UI.
create or replace function atlas_private.team_member_list_photo_orphans()
returns jsonb language sql stable security definer set search_path = ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('storage_path', storage_path, 'created_at', created_at) order by created_at desc), '[]'::jsonb)
  from atlas_private.team_member_deletion_orphans where resolved_at is null;
$function$;
revoke all on function atlas_private.team_member_list_photo_orphans() from public, anon, authenticated;

-- Mark an orphan resolved once its Storage object has actually been removed.
create or replace function atlas_private.team_member_resolve_photo_orphan(p_storage_path text, p_actor_id uuid, p_actor_label text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare updated integer := 0;
begin
  update atlas_private.team_member_deletion_orphans
    set resolved_at = now(), resolved_by = p_actor_id, resolved_by_label = p_actor_label
    where storage_path = p_storage_path and resolved_at is null;
  get diagnostics updated = row_count;
  return jsonb_build_object('ok', true, 'resolved', updated > 0);
end
$function$;
revoke all on function atlas_private.team_member_resolve_photo_orphan(text, uuid, text) from public, anon, authenticated;

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

create or replace function public.atlas_team_member_record_photo_orphan(p_storage_path text, p_actor_id uuid, p_actor_label text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.team_member_record_photo_orphan(p_storage_path, p_actor_id, p_actor_label); $$;
revoke all on function public.atlas_team_member_record_photo_orphan(text, uuid, text) from public, anon, authenticated;
grant execute on function public.atlas_team_member_record_photo_orphan(text, uuid, text) to service_role;

create or replace function public.atlas_team_member_list_photo_orphans()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select atlas_private.team_member_list_photo_orphans(); $$;
revoke all on function public.atlas_team_member_list_photo_orphans() from public, anon, authenticated;
grant execute on function public.atlas_team_member_list_photo_orphans() to service_role;

create or replace function public.atlas_team_member_resolve_photo_orphan(p_storage_path text, p_actor_id uuid, p_actor_label text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select atlas_private.team_member_resolve_photo_orphan(p_storage_path, p_actor_id, p_actor_label); $$;
revoke all on function public.atlas_team_member_resolve_photo_orphan(text, uuid, text) from public, anon, authenticated;
grant execute on function public.atlas_team_member_resolve_photo_orphan(text, uuid, text) to service_role;
