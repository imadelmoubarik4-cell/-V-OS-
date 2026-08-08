-- Recovered from Supabase migration history for project dnefgcmjcgxlynycxkts.
-- This file preserves the SQL already recorded as applied; do not rewrite it.

alter table public.inventory_items alter column imported_at set default now();
