-- Historical ledger anchor for the completed Real VA preview transfer cleanup.
--
-- The hosted preview already removed the temporary pg_net extension and its
-- private transfer marker after the five-table checkpoint was restored and
-- verified. There is no transport state to recreate or clean during a fresh
-- database replay.
--
-- This version remains in the migration ledger for deterministic history and is
-- intentionally a no-op in every environment.
select 1;
