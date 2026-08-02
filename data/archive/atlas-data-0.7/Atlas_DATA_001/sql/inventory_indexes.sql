-- DATA-001
CREATE INDEX IF NOT EXISTS idx_inventory_name ON inventory_items (name);
CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory_items (barcode);
CREATE INDEX IF NOT EXISTS idx_inventory_supplier ON inventory_items (supplier);
