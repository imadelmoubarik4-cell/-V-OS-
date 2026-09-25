-- S87 atlas-media write access.
--
-- The public atlas-media bucket serves recipe and menu images. Its object
-- policies only required a signed-in user, so any authenticated account
-- (bartenders, viewers and deactivated profiles whose session had not yet
-- expired) could upload, overwrite or delete every public menu image. The only
-- writer is the manager-only recipe editor.
--
-- Reads stay open to active staff (the public URL already serves the images);
-- writes require an active manager or administrator. Other buckets and their
-- policies are unchanged.

drop policy if exists "authenticated staff can view atlas media objects" on storage.objects;
drop policy if exists "authenticated staff can upload atlas media objects" on storage.objects;
drop policy if exists "authenticated staff can update atlas media objects" on storage.objects;
drop policy if exists "authenticated staff can delete atlas media objects" on storage.objects;

create policy "active staff can view atlas media objects"
  on storage.objects for select to authenticated
  using (bucket_id = 'atlas-media' and (select private.is_active_staff()));

create policy "active managers can upload atlas media objects"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'atlas-media' and (select private.is_manager_or_admin()));

create policy "active managers can update atlas media objects"
  on storage.objects for update to authenticated
  using (bucket_id = 'atlas-media' and (select private.is_manager_or_admin()))
  with check (bucket_id = 'atlas-media' and (select private.is_manager_or_admin()));

create policy "active managers can delete atlas media objects"
  on storage.objects for delete to authenticated
  using (bucket_id = 'atlas-media' and (select private.is_manager_or_admin()));
