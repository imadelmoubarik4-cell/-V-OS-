-- S96 (webstore): Storage UPDATE on atlas-media and atlas-imports is not used
-- by Atlas (uploads use upsert:false; nothing moves or renames objects), but
-- the two permissive UPDATE policies let any manager, through the Storage
-- move API, rename another manager's import file, move objects between
-- atlas-imports and the public atlas-media bucket (bypassing that bucket's
-- image-only MIME list and 10 MB limit) and move them outside the per-user
-- import folder. Removing them leaves INSERT (own folder for imports), SELECT
-- and DELETE unchanged. The restrictive "claimed import source" policies stay.
drop policy if exists "active managers can update atlas media objects" on storage.objects;
drop policy if exists "active managers update atlas import files" on storage.objects;
