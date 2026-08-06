-- Migration-history anchor for the Checkpoint J API deployment recorded on the
-- pull-request Supabase branch before its source file was retained in Git.
--
-- The later atlas_settings_checkpoint_j_canonical migration recreates the
-- complete replayable RPC contract. This anchor only restores parity between
-- the remote migration ledger and the repository.
select 1;
