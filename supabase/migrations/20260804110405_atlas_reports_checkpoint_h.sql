-- Migration-history anchor for the deployed Checkpoint H report snapshot.
--
-- The branch database recorded the combined Reports deployment under this
-- version. The repository keeps the same final contract in the earlier
-- 20260804093723, 20260804095329, 20260804095939 and 20260804125547
-- idempotent migrations. This anchor reconciles history without replaying the
-- combined deployment a second time.
select 1;
