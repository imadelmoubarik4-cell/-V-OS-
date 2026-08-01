CREATE TABLE IF NOT EXISTS stock_counts(
id UUID PRIMARY KEY,
item_id UUID,
expected_qty NUMERIC,
counted_qty NUMERIC,
difference NUMERIC,
counted_by TEXT,
counted_at TIMESTAMP
);