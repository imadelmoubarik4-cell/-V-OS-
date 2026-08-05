-- Migration-history bridge for the alternate Checkpoint I snapshot draft.
--
-- The canonical System I snapshot is the deployed contract recorded under
-- 20260804143840_atlas_system_snapshot. The 14:31 draft targeted an incompatible
-- table layout and was never the active browser or Edge Function contract.
-- Keep the version locally as a no-op so fresh preview branches advance through
-- the migration ledger without replacing the canonical System model.
select 1;
