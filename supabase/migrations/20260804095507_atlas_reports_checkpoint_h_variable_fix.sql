-- Migration-history bridge for the Checkpoint H variable-name repair.
--
-- The branch database received this repair under version 20260804095507.
-- The repository carries the same idempotent repair in
-- 20260804095939_atlas_reports_snapshot_variable_fix.sql. Keeping this version
-- locally reconciles Supabase branch history without executing the repair twice.
select 1;
