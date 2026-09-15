-- Cover the scanner event -> barcode alias foreign key used by audit/history queries.
create index if not exists inventory_scan_events_alias_idx
  on atlas_private.inventory_scan_events(alias_id)
  where alias_id is not null;
