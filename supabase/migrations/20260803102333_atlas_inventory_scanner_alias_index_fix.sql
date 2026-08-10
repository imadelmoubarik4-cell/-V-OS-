-- Supabase's foreign-key linter requires a complete covering index.
drop index if exists atlas_private.inventory_scan_events_alias_idx;
create index inventory_scan_events_alias_idx
  on atlas_private.inventory_scan_events(alias_id);
