-- Migration-history anchor for the Checkpoint J foundation deployed to the
-- pull-request Supabase branch before its source file was retained in Git.
--
-- The canonical, replayable Settings J schema is maintained by the later
-- atlas_settings_checkpoint_j_canonical migration. This version exists only to
-- reconcile the already-applied remote migration number.
select 1;
