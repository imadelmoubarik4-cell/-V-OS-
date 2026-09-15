-- Migration-history bridge for the remote Checkpoint K experiment applied on
-- 2026-08-05. The experimental atlas_private.intelligence_* model was never
-- connected to the deployed Checkpoint K gateway; the canonical implementation
-- remains the earlier atlas_private.brain_* model created by
-- 20260805093732_atlas_brain_checkpoint_k_intelligence.sql.
--
-- The following consolidation migration removes the unused experimental model.
select 1;
