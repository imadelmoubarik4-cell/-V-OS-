-- Recovered from Supabase migration history for project dnefgcmjcgxlynycxkts.
-- This file preserves the SQL already recorded as applied; do not rewrite it.

alter table public.inventory_items
  add column if not exists image_url text,
  add column if not exists sell_price numeric,
  add column if not exists source_key text,
  add column if not exists source_file text,
  add column if not exists source_updated_at date,
  add column if not exists imported_at timestamptz;

alter table public.recipes
  add column if not exists happy_hour_price numeric,
  add column if not exists glass_price numeric,
  add column if not exists bottle_price numeric,
  add column if not exists source_key text,
  add column if not exists source_file text,
  add column if not exists imported_at timestamptz;

create unique index if not exists inventory_items_source_key_uidx
  on public.inventory_items(source_key)
  where source_key is not null;

create unique index if not exists recipes_source_key_uidx
  on public.recipes(source_key)
  where source_key is not null;

create table if not exists public.atlas_media (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('inventory_item','recipe')),
  entity_id uuid not null,
  storage_path text not null unique,
  public_url text not null,
  media_kind text not null default 'gallery' check (media_kind in ('primary','gallery','barcode','back_label','shelf')),
  is_primary boolean not null default false,
  sort_order integer not null default 0,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists atlas_media_entity_idx
  on public.atlas_media(entity_type, entity_id, is_primary desc, sort_order, created_at);

alter table public.atlas_media enable row level security;

grant select, insert, update, delete on public.atlas_media to authenticated;

 drop policy if exists "authenticated staff can read atlas media" on public.atlas_media;
create policy "authenticated staff can read atlas media"
  on public.atlas_media for select
  to authenticated
  using ((select auth.uid()) is not null);

 drop policy if exists "authenticated staff can add atlas media" on public.atlas_media;
create policy "authenticated staff can add atlas media"
  on public.atlas_media for insert
  to authenticated
  with check ((select auth.uid()) is not null and uploaded_by = (select auth.uid()));

 drop policy if exists "authenticated staff can update atlas media" on public.atlas_media;
create policy "authenticated staff can update atlas media"
  on public.atlas_media for update
  to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

 drop policy if exists "authenticated staff can delete atlas media" on public.atlas_media;
create policy "authenticated staff can delete atlas media"
  on public.atlas_media for delete
  to authenticated
  using ((select auth.uid()) is not null);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'atlas-media',
  'atlas-media',
  true,
  10485760,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

 drop policy if exists "authenticated staff can view atlas media objects" on storage.objects;
create policy "authenticated staff can view atlas media objects"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'atlas-media' and (select auth.uid()) is not null);

 drop policy if exists "authenticated staff can upload atlas media objects" on storage.objects;
create policy "authenticated staff can upload atlas media objects"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'atlas-media' and (select auth.uid()) is not null);

 drop policy if exists "authenticated staff can update atlas media objects" on storage.objects;
create policy "authenticated staff can update atlas media objects"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'atlas-media' and (select auth.uid()) is not null)
  with check (bucket_id = 'atlas-media' and (select auth.uid()) is not null);

 drop policy if exists "authenticated staff can delete atlas media objects" on storage.objects;
create policy "authenticated staff can delete atlas media objects"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'atlas-media' and (select auth.uid()) is not null);

insert into public.recipe_categories (slug, name, description, icon, display_order, active)
values
  ('shots', 'Shots', 'Single-serve shots and shooters.', 'glass-water', 55, true),
  ('beer-cider', 'Beer & Cider', 'Draught, bottles, cans and alcohol-free beer.', 'beer', 56, true),
  ('wine-sparkling', 'Sparkling Wine', 'Sparkling wine and Champagne.', 'wine', 57, true),
  ('wine-white', 'White Wine', 'White wine by the glass or bottle.', 'wine', 58, true),
  ('wine-rose', 'Rosé Wine', 'Rosé wine by the glass or bottle.', 'wine', 59, true),
  ('wine-red', 'Red Wine', 'Red wine by the glass or bottle.', 'wine', 60, true)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  icon = excluded.icon,
  display_order = excluded.display_order,
  active = true;
