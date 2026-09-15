-- Migration-history bridge for Checkpoint L1.
--
-- The complete stock-count schema is kept in
-- 20260805123000_atlas_stock_counts_checkpoint_l1.sql so a fresh branch builds
-- the feature before the later Checkpoint K consolidation. The existing remote
-- preview received that same schema under version 20260805125959. This no-op
-- preserves the remote version locally; the earlier version is marked applied
-- on the existing preview as an explicit migration-history repair.
select 1;
