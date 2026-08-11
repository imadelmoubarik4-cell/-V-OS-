
CREATE TABLE IF NOT EXISTS recipes(
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  selling_price_isk NUMERIC,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recipe_ingredients(
  recipe_id UUID,
  inventory_item_id UUID,
  quantity NUMERIC,
  unit TEXT,
  PRIMARY KEY(recipe_id, inventory_item_id)
);
