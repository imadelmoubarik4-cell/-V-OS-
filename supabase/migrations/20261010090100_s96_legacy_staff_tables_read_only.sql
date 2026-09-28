-- S96 (security hardening, findings DBRLS-02 and DBRLS-03): remove unused browser write paths.
--
-- 1. Legacy production-only tables public.shifts, public.staff_availability,
--    public.staff_details, public.staff_documents and public.document_acknowledgements
--    are not written by the live web app (main), the PR103 web app or any deployed Edge
--    Function (Shifts, Team and Knowledge use atlas_private tables through service-role
--    RPCs; atlas-team-messages only READS public.shifts). Their policies still let any
--    active staff member write "own" rows with any values, e.g. a bartender can insert or
--    raise their own staff_details.hourly_rate, rewrite manager notes about themselves,
--    or back-date a document acknowledgement (acknowledged_at is client supplied).
--    Browser roles keep SELECT (still filtered by the existing RLS policies); INSERT,
--    UPDATE, DELETE and TRUNCATE are revoked. The tables are absent from clean replays;
--    each statement is skipped when its table does not exist.
--
-- 2. public.atlas_media (metadata rows; the atlas-media bucket itself became
--    manager-write in S87) still let bartenders insert rows for any recipe or inventory
--    item with an arbitrary public_url and is_primary flag. No current client writes the
--    table. Writes now require an active manager or administrator, matching the bucket.

do $s96$
declare
  legacy_table text;
begin
  foreach legacy_table in array array[
    'shifts', 'staff_availability', 'staff_details', 'staff_documents', 'document_acknowledgements'
  ] loop
    if to_regclass(format('public.%I', legacy_table)) is not null then
      execute format(
        'revoke insert, update, delete, truncate on table public.%I from public, anon, authenticated',
        legacy_table);
      execute format(
        'comment on table public.%I is %L',
        legacy_table,
        'Legacy table. S96: read-only for browser roles; no product path writes it.');
    else
      raise notice 'S96: public.% is absent; skipped', legacy_table;
    end if;
  end loop;
end
$s96$;

drop policy if exists "operational staff add own media" on public.atlas_media;
drop policy if exists "owners or managers update media" on public.atlas_media;
drop policy if exists "owners or managers delete media" on public.atlas_media;
drop policy if exists "active managers add media" on public.atlas_media;
drop policy if exists "active managers update media" on public.atlas_media;
drop policy if exists "active managers delete media" on public.atlas_media;

create policy "active managers add media"
  on public.atlas_media for insert to authenticated
  with check ((select private.is_manager_or_admin()) and uploaded_by = (select auth.uid()));

create policy "active managers update media"
  on public.atlas_media for update to authenticated
  using ((select private.is_manager_or_admin()))
  with check ((select private.is_manager_or_admin()));

create policy "active managers delete media"
  on public.atlas_media for delete to authenticated
  using ((select private.is_manager_or_admin()));

notify pgrst, 'reload schema';
