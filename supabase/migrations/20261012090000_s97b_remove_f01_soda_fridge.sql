-- S97b: the canonical VÁ storage-location set is 15, not 16.
--
-- The S97 seed (20261011090000_s97_inventory_storage_locations.sql) created 16
-- locations including F01 "Main soda fridges". The owner deleted F01 in
-- production via the governed admin delete path (VÁ has one soda fridge, not
-- two); production's canonical layout is now 15 locations:
--   S01, S02, S03, F02, F03, F04, W01, W02, B01, B02, B03, D01, D02, D03, D04.
--
-- This migration makes a clean, from-empty replay match production: it removes
-- the F01 seed row so fresh environments never recreate "F01 — Main soda
-- fridges". It is idempotent (no-op once F01 is gone) and safe: it only removes
-- F01 when nothing is assigned to it (a fresh replay seeds F01 with no
-- assignments; production already has no F01 row, so this is a no-op there).
--
-- The production location_deleted audit event for F01 is the owner's real action
-- and is left untouched. This migration does not write an audit row: it is a
-- seed correction for non-production replays, not a runtime deletion.

delete from public.inventory_locations loc
where lower(loc.code) = 'f01'
  and not exists (
    select 1 from public.inventory_item_locations il where il.location_id = loc.id
  );

notify pgrst, 'reload schema';
