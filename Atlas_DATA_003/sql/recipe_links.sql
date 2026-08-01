-- DATA-003
-- Table for linking inventory to recipes
CREATE TABLE IF NOT EXISTS recipe_inventory_links (
    recipe_id UUID,
    inventory_item_id UUID,
    quantity NUMERIC,
    unit TEXT
);
