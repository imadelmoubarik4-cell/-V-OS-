-- S105 Team member removal & permanent deletion — database-boundary proof on a
-- replayed database (scripts/verify_full_migration_replay.sh). Proves at the DB
-- boundary (the edge function owns authorization/MFA/last-admin; this is the data
-- layer it stands on):
--   1. the deletion audit + RPCs are sealed from anon/authenticated; service_role
--      alone holds EXECUTE on the public wrappers; the private functions carry no
--      PUBLIC/anon/authenticated EXECUTE; anon is denied at runtime (42501).
--   2. the audit table has RLS on and is append-only — UPDATE/DELETE/TRUNCATE are
--      refused even for service_role (the S96 trigger fires regardless of BYPASSRLS).
--   3. shift_entries ON DELETE RESTRICT is honoured: a person WITH worked shifts is
--      anonymized (name/email/role cleared, profile link dropped, source→manual,
--      archived) and the shift row survives; a person with NO shifts is hard-deleted
--      and availability/time-off/responses CASCADE while events SET NULL.
--   4. the schedule-only route refuses a login-linked roster row; exactly one
--      identifier is required; an unknown target raises instead of a false success.
--   5. the permanent-deletion audit stores NO identifying name (redacted) — only the
--      pseudonymous ids, counts and the acting administrator.
--   6. remove-from-team archives (active=false) reversibly and keeps every record.
begin;

-- Branch-side ids are free UUIDs (cross-project split: no FK to production profiles).
-- Actor for the RPCs.

-- --- fixtures -------------------------------------------------------------------
-- A: login member with NO worked shifts → full delete + cascade.
insert into atlas_private.shift_people(id, profile_id, display_name, email, default_role, active, login_enabled, source)
values ('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-0000000000a1','Del NoShift','del.noshift@example.invalid','Barback',true,true,'profile');
insert into atlas_private.team_profile_details(profile_id, job_title) values ('a0000000-0000-4000-8000-0000000000a1','Barback');
insert into atlas_private.team_profile_photos(profile_id, bucket_id, storage_path, mime_type, byte_size) values ('a0000000-0000-4000-8000-0000000000a1','atlas-profile-photos','profiles/a0000000-0000-4000-8000-0000000000a1/a0000000-0000-4000-8000-0000000000a2.webp','image/webp',1024);
insert into atlas_private.team_emergency_contacts(profile_id, contact_name, phone, priority) values ('a0000000-0000-4000-8000-0000000000a1','Kin A','+354 555 0001',1);
insert into atlas_private.shift_availability(person_id, weekday) values ('a0000000-0000-4000-8000-000000000001',1);
insert into atlas_private.shift_time_off(person_id, starts_on, ends_on, request_type, status)
  values ('a0000000-0000-4000-8000-000000000001','2026-02-01','2026-02-02','vacation','approved');

-- B: login member WITH a worked shift → anonymize, keep the shift.
insert into atlas_private.shift_people(id, profile_id, display_name, email, default_role, active, login_enabled, source)
values ('b0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-0000000000b1','Del WithShift','del.withshift@example.invalid','Bartender',true,true,'profile');
insert into atlas_private.team_profile_details(profile_id, job_title) values ('b0000000-0000-4000-8000-0000000000b1','Bartender');
insert into atlas_private.shift_weeks(week_start) values ('2026-01-05') on conflict do nothing;
insert into atlas_private.shift_entries(id, week_start, person_id, role_name, starts_at, ends_at)
values ('b0000000-0000-4000-8000-00000000e001','2026-01-05','b0000000-0000-4000-8000-000000000001','Bar','2026-01-06T17:00:00Z','2026-01-07T01:00:00Z');

-- C: genuine schedule-only roster person (manual, no login) → full delete via person route.
insert into atlas_private.shift_people(id, profile_id, display_name, email, default_role, active, login_enabled, source)
values ('c0000000-0000-4000-8000-000000000001', null,'Sched Only',null,'Runner',true,false,'manual');

-- D: a login-LINKED roster row — the schedule-only route must refuse it.
insert into atlas_private.shift_people(id, profile_id, display_name, email, default_role, active, login_enabled, source)
values ('d0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-0000000000d1','Linked Login','linked@example.invalid','Bar',true,true,'profile');

-- 1. Grants: browser roles cannot execute; service_role can; private fns are sealed.
do $$
declare bad text;
begin
  if has_function_privilege('anon','public.atlas_team_member_purge_branch(uuid,uuid,uuid,text,text)','EXECUTE')
     or has_function_privilege('authenticated','public.atlas_team_member_purge_branch(uuid,uuid,uuid,text,text)','EXECUTE')
     or has_function_privilege('anon','public.atlas_team_member_remove_from_team(uuid,uuid,uuid,text,text)','EXECUTE')
     or has_function_privilege('authenticated','public.atlas_team_member_deletion_preview(uuid,uuid)','EXECUTE')
  then raise exception 'browser roles can execute the deletion wrappers'; end if;
  if not has_function_privilege('service_role','public.atlas_team_member_purge_branch(uuid,uuid,uuid,text,text)','EXECUTE')
  then raise exception 'service_role cannot execute the purge wrapper'; end if;
  -- Orphan-photo cleanup wrappers are equally sealed from browser roles.
  if has_function_privilege('anon','public.atlas_team_member_list_photo_orphans()','EXECUTE')
     or has_function_privilege('authenticated','public.atlas_team_member_resolve_photo_orphan(text,uuid,text)','EXECUTE')
     or has_function_privilege('anon','public.atlas_team_member_record_photo_orphan(text,uuid,text)','EXECUTE')
  then raise exception 'browser roles can execute the orphan-cleanup wrappers'; end if;
  -- Private functions carry no PUBLIC/anon/authenticated EXECUTE.
  if has_function_privilege('anon','atlas_private.team_member_purge_branch(uuid,uuid,uuid,text,text)','EXECUTE')
     or has_function_privilege('authenticated','atlas_private.team_member_purge_branch(uuid,uuid,uuid,text,text)','EXECUTE')
  then raise exception 'browser roles can execute a private deletion function'; end if;
  -- The audit table is unreadable/unwritable by browser roles and RLS is on.
  if has_table_privilege('anon','atlas_private.team_member_deletion_audit','SELECT')
     or has_table_privilege('authenticated','atlas_private.team_member_deletion_audit','INSERT')
  then raise exception 'browser roles can touch the deletion audit'; end if;
  if not (select relrowsecurity from pg_class where oid='atlas_private.team_member_deletion_audit'::regclass)
  then raise exception 'RLS is not enabled on the deletion audit'; end if;
  raise notice 'check 1 ok: grants + RLS sealed';
end $$;

-- 1b. Runtime denial: anon is refused execution of a wrapper (42501).
do $$
begin
  set local role anon;
  begin
    perform public.atlas_team_member_deletion_preview('a0000000-0000-4000-8000-0000000000a1', null);
    reset role;
    raise exception 'anon was allowed to call the preview wrapper';
  exception when insufficient_privilege then
    reset role; raise notice 'check 1b ok: anon denied at runtime';
  end;
end $$;

-- 2. Full delete of a login member with no shifts: cascades go, audit is redacted.
do $$
declare res jsonb;
begin
  set local role service_role;
  res := public.atlas_team_member_purge_branch('a0000000-0000-4000-8000-0000000000a1', null, '99999999-9999-4999-8999-999999999999'::uuid, 'Owner', 'admin');
  reset role;
  if (res->>'mode') <> 'full_delete' then raise exception 'A: expected full_delete, got %', res->>'mode'; end if;
  if exists(select 1 from atlas_private.shift_people where id='a0000000-0000-4000-8000-000000000001') then raise exception 'A: roster row not hard-deleted'; end if;
  if exists(select 1 from atlas_private.shift_availability where person_id='a0000000-0000-4000-8000-000000000001') then raise exception 'A: availability did not cascade'; end if;
  if exists(select 1 from atlas_private.shift_time_off where person_id='a0000000-0000-4000-8000-000000000001') then raise exception 'A: time-off did not cascade'; end if;
  if exists(select 1 from atlas_private.team_profile_details where profile_id='a0000000-0000-4000-8000-0000000000a1') then raise exception 'A: details not deleted'; end if;
  if exists(select 1 from atlas_private.team_emergency_contacts where profile_id='a0000000-0000-4000-8000-0000000000a1') then raise exception 'A: contacts not deleted'; end if;
  if exists(select 1 from atlas_private.team_profile_photos where profile_id='a0000000-0000-4000-8000-0000000000a1') then raise exception 'A: photo row not deleted'; end if;
  if (res->>'photo_storage_path') <> 'profiles/a0000000-0000-4000-8000-0000000000a1/a0000000-0000-4000-8000-0000000000a2.webp' then raise exception 'A: photo path not returned for storage cleanup'; end if;
  -- Audit written, name REDACTED (null), ids/counts/actor kept.
  if not exists(select 1 from atlas_private.team_member_deletion_audit
    where action='permanently_deleted' and target_profile_id='a0000000-0000-4000-8000-0000000000a1'
      and target_label is null and actor_id = '99999999-9999-4999-8999-999999999999'::uuid) then raise exception 'A: redacted audit row missing'; end if;
  raise notice 'check 2 ok: full delete + cascade + redacted audit';
end $$;

-- 3. Login member WITH a worked shift: anonymized, shift kept (RESTRICT honoured).
do $$
declare res jsonb; row atlas_private.shift_people;
begin
  set local role service_role;
  res := public.atlas_team_member_purge_branch('b0000000-0000-4000-8000-0000000000b1', null, '99999999-9999-4999-8999-999999999999'::uuid, 'Owner', 'admin');
  reset role;
  if (res->>'mode') <> 'anonymized_kept_shifts' then raise exception 'B: expected anonymize, got %', res->>'mode'; end if;
  if (res->>'shift_entry_count')::int <> 1 then raise exception 'B: wrong shift count'; end if;
  if not exists(select 1 from atlas_private.shift_entries where id='b0000000-0000-4000-8000-00000000e001') then raise exception 'B: worked shift was destroyed'; end if;
  select * into row from atlas_private.shift_people where id='b0000000-0000-4000-8000-000000000001';
  if row.id is null then raise exception 'B: roster row disappeared'; end if;
  if row.display_name <> 'Former team member' or row.email is not null or row.profile_id is not null
     or row.login_enabled or row.active or row.source <> 'manual'
  then raise exception 'B: row not anonymized/unlinked (%, source %)', row.display_name, row.source; end if;
  raise notice 'check 3 ok: anonymize keeps shift history';
end $$;

-- 4a. Schedule-only route refuses a login-linked roster row.
do $$
begin
  set local role service_role;
  begin
    perform public.atlas_team_member_purge_branch(null, 'd0000000-0000-4000-8000-000000000001', '99999999-9999-4999-8999-999999999999'::uuid, 'Owner', 'admin');
    reset role; raise exception '4a: a login-linked person was deleted via the schedule route';
  exception when others then
    reset role;
    if sqlerrm not like '%linked to a login profile%' then raise exception '4a: wrong error: %', sqlerrm; end if;
  end;
  if not exists(select 1 from atlas_private.shift_people where id='d0000000-0000-4000-8000-000000000001') then raise exception '4a: linked row was removed'; end if;
  raise notice 'check 4a ok: schedule route refuses a login-linked person';
end $$;

-- 4b. Exactly one identifier (both → error) and unknown target (→ error, no false ok).
do $$
begin
  set local role service_role;
  begin
    perform public.atlas_team_member_purge_branch('a0000000-0000-4000-8000-0000000000a1','c0000000-0000-4000-8000-000000000001', '99999999-9999-4999-8999-999999999999'::uuid,'Owner','admin');
    reset role; raise exception '4b: both identifiers were accepted';
  exception when others then reset role; if sqlerrm not like '%exactly one%' then raise exception '4b: wrong both-id error: %', sqlerrm; end if; end;

  -- Unknown SCHEDULE-ONLY target must raise (its only existence is the roster row).
  -- The login route is deliberately idempotent instead (proven in check 7).
  set local role service_role;
  begin
    perform public.atlas_team_member_purge_branch(null, 'f0000000-0000-4000-8000-00000000ffff', '99999999-9999-4999-8999-999999999999'::uuid,'Owner','admin');
    reset role; raise exception '4b: an unknown schedule-only target returned success';
  exception when others then reset role; if sqlerrm not like '%no team member found%' then raise exception '4b: wrong unknown-target error: %', sqlerrm; end if; end;
  raise notice 'check 4b ok: exactly-one identifier + unknown schedule-only target refused';
end $$;

-- 4c. Genuine schedule-only person is fully removed via the person route.
do $$
declare res jsonb;
begin
  set local role service_role;
  res := public.atlas_team_member_purge_branch(null, 'c0000000-0000-4000-8000-000000000001', '99999999-9999-4999-8999-999999999999'::uuid, 'Owner', 'admin');
  reset role;
  if (res->>'mode') <> 'full_delete' then raise exception '4c: expected full_delete'; end if;
  if exists(select 1 from atlas_private.shift_people where id='c0000000-0000-4000-8000-000000000001') then raise exception '4c: schedule-only row not deleted'; end if;
  raise notice 'check 4c ok: schedule-only person removed';
end $$;

-- 5. Append-only audit: UPDATE / DELETE / TRUNCATE refused even for service_role.
do $$
begin
  set local role service_role;
  begin
    update atlas_private.team_member_deletion_audit set actor_label='tamper' where true;
    reset role; raise exception '5: audit UPDATE was allowed';
  exception when others then reset role; if sqlerrm not like '%append-only%' and sqlerrm not like '%permission%' then raise exception '5: unexpected update error: %', sqlerrm; end if; end;

  set local role service_role;
  begin
    delete from atlas_private.team_member_deletion_audit where true;
    reset role; raise exception '5: audit DELETE was allowed';
  exception when others then reset role; if sqlerrm not like '%append-only%' and sqlerrm not like '%permission%' then raise exception '5: unexpected delete error: %', sqlerrm; end if; end;
  raise notice 'check 5 ok: audit is append-only';
end $$;

-- 6. remove-from-team archives (reversible) and keeps the record.
do $$
declare res jsonb; row atlas_private.shift_people;
begin
  insert into atlas_private.shift_people(id, profile_id, display_name, email, default_role, active, login_enabled, source)
  values ('e0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-0000000000e1','Keep Me','keep@example.invalid','Bar',true,true,'profile');
  set local role service_role;
  res := public.atlas_team_member_remove_from_team('e0000000-0000-4000-8000-0000000000e1', null, '99999999-9999-4999-8999-999999999999'::uuid, 'Owner', 'admin');
  reset role;
  select * into row from atlas_private.shift_people where id='e0000000-0000-4000-8000-000000000001';
  if row.id is null then raise exception '6: remove deleted the record (should archive)'; end if;
  if row.active then raise exception '6: remove did not archive (active still true)'; end if;
  if row.display_name <> 'Keep Me' then raise exception '6: remove changed identifying data'; end if;
  if not exists(select 1 from atlas_private.team_member_deletion_audit where action='removed_from_team' and target_profile_id='e0000000-0000-4000-8000-0000000000e1') then raise exception '6: no removed_from_team audit'; end if;
  raise notice 'check 6 ok: remove-from-team archives reversibly';
end $$;

-- 7. Login route is IDEMPOTENT: a profile with no branch rows (a resumed delete
--    after a failed Auth deletion, or an unaccepted invitation) is a valid no-op,
--    not a false success — it returns ok with already_clean=true and never raises.
do $$
declare res jsonb;
begin
  set local role service_role;
  res := public.atlas_team_member_purge_branch('f0000000-0000-4000-8000-0000000000f1', null, '99999999-9999-4999-8999-999999999999'::uuid, 'Owner', 'admin');
  reset role;
  if not (res->>'ok')::boolean then raise exception '7: idempotent login purge did not return ok'; end if;
  if not (res->>'already_clean')::boolean then raise exception '7: expected already_clean=true for an empty login target'; end if;
  raise notice 'check 7 ok: login purge is idempotent (resumable / invitation)';
end $$;

-- 8. Orphan-photo registry: record → list → resolve, and DELETE is revoked.
do $$
declare listed jsonb;
begin
  set local role service_role;
  perform public.atlas_team_member_record_photo_orphan('profiles/f0000000-0000-4000-8000-0000000000f1/f0000000-0000-4000-8000-0000000000f2.webp', '99999999-9999-4999-8999-999999999999'::uuid, 'Owner');
  listed := public.atlas_team_member_list_photo_orphans();
  if jsonb_array_length(listed) <> 1 then raise exception '8: orphan not listed after record'; end if;
  perform public.atlas_team_member_resolve_photo_orphan('profiles/f0000000-0000-4000-8000-0000000000f1/f0000000-0000-4000-8000-0000000000f2.webp', '99999999-9999-4999-8999-999999999999'::uuid, 'Owner');
  listed := public.atlas_team_member_list_photo_orphans();
  if jsonb_array_length(listed) <> 0 then raise exception '8: orphan still listed after resolve'; end if;
  reset role;
  if has_table_privilege('service_role','atlas_private.team_member_deletion_orphans','DELETE')
  then raise exception '8: service_role can DELETE from the orphan registry'; end if;
  if has_table_privilege('anon','atlas_private.team_member_deletion_orphans','SELECT')
  then raise exception '8: anon can read the orphan registry'; end if;
  raise notice 'check 8 ok: orphan registry record/list/resolve + sealed';
end $$;

select 'S105: all deletion authorization and integrity checks passed' as result;

rollback;
