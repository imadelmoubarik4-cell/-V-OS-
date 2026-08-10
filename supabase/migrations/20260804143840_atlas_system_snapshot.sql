-- Migration-history anchor for the deployed Checkpoint I System snapshot.
--
-- The branch database recorded its final System deployment under this version.
-- The repository carries the same idempotent foundation and snapshot contract
-- in 20260804134509, 20260804134510, 20260804143000 and 20260804143100.
-- Keep this version locally so Supabase can reconcile branch history without
-- applying the combined deployment again.
select 1;
