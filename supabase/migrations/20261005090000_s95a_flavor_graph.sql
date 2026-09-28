-- S95A Atlas Flavor Intelligence: the flavor graph (docs/flavor/Schema.md).
--
-- An additive, private knowledge layer beside the inventory. It never writes
-- to inventory, recipes, suppliers, stock, menus or purchasing:
-- * atlas_private.flavor_sources: provenance registry (provider, licence,
--   commercial use, attribution, ingest verdict). Rejected sources are kept
--   in the registry with verdict do_not_ingest so they are never re-added.
-- * atlas_private.flavor_ingredients: canonical ingredient concepts ("gin",
--   "lime", "elderflower liqueur"), not products. Aroma families 0..1, basic
--   tastes 0..5, intensity, texture, ABV, allergens, dietary flags, uses.
-- * atlas_private.flavor_aliases: search aliases (English, Icelandic, brand
--   words) with a normalised alias_key produced by scripts/build_flavor_seed.mjs.
-- * atlas_private.flavor_preparations (+ flavor_ingredient_preparations):
--   preparation types (juice, zest, syrup, infusion, ...) with heuristic taste
--   and aroma shifts.
-- * atlas_private.flavor_edges: undirected pairing edges (a_id < b_id) typed
--   by relation and by evidence (scientific | culinary | atlas_learned |
--   ai_interpretation). Evidence types never mix: AI text is never scientific.
-- * atlas_private.flavor_item_links: inventory item -> canonical ingredient.
--   Additive only; an inventory row is never changed. Uncertain matches are
--   'needs_review', never silently merged. Deleting an inventory item removes
--   only its links (on delete cascade on the link side).
--
-- Every table: atlas_private, RLS on, a service-role-only policy, no browser
-- grants. The only reader is public.atlas_flavor_snapshot() (security definer,
-- search_path = '', execute for service_role only), called by the atlas-ai
-- Edge Function after its own role gate. There are no write RPCs in the MVP:
-- curated data arrives through the generated seed migration (S95C).

-- ------------------------------------------------------------------ tables

create table if not exists atlas_private.flavor_sources (
  id text primary key check (id ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  name text not null,
  url text,
  license text,
  commercial_use boolean not null default false,
  attribution text,
  verdict text not null check (verdict in ('use','use_with_attribution','do_not_ingest','needs_legal_review')),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists atlas_private.flavor_ingredients (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (btrim(name) <> ''),
  family text not null check (family ~ '^[a-z0-9_]+$'),
  subfamily text,
  aroma jsonb not null default '{}'::jsonb check (jsonb_typeof(aroma) = 'object'),
  taste jsonb not null default '{}'::jsonb check (jsonb_typeof(taste) = 'object'),
  intensity smallint check (intensity between 1 and 5),
  texture text,
  abv_typical numeric check (abv_typical is null or abv_typical between 0 and 100),
  allergens text[] not null default '{}',
  dietary text[] not null default '{}',
  uses text[] not null default '{}'
    check (uses <@ array['cocktail','mocktail','coffee','dessert','food']::text[]),
  techniques text[] not null default '{}',
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  provider text not null references atlas_private.flavor_sources(id),
  confidence numeric not null check (confidence between 0 and 1),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column atlas_private.flavor_ingredients.aroma is
  'Aroma family -> weight 0..1 (Atlas aroma vocabulary, docs/flavor/Schema.md).';
comment on column atlas_private.flavor_ingredients.taste is
  'sweet, sour, bitter, salty, umami, fat, alcohol, astringency -> 0..5.';
comment on column atlas_private.flavor_ingredients.attributes is
  'Extra curated facts: trigeminal (pungency/cooling/carbonation), may_contain, region_tags, review_status, seed_version.';

create table if not exists atlas_private.flavor_aliases (
  ingredient_id uuid not null references atlas_private.flavor_ingredients(id) on delete cascade,
  alias text not null check (btrim(alias) <> ''),
  alias_key text not null check (alias_key ~ '^[a-z0-9]+( [a-z0-9]+)*$'),
  language text not null default 'en' check (language ~ '^[a-z]{2,3}$'),
  primary key (ingredient_id, alias_key)
);
create index if not exists flavor_aliases_key_idx on atlas_private.flavor_aliases (alias_key);

create table if not exists atlas_private.flavor_preparations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (btrim(name) <> ''),
  taste_shift jsonb not null default '{}'::jsonb check (jsonb_typeof(taste_shift) = 'object'),
  aroma_shift jsonb not null default '{}'::jsonb check (jsonb_typeof(aroma_shift) = 'object'),
  texture text,
  notes text
);

create table if not exists atlas_private.flavor_ingredient_preparations (
  ingredient_id uuid not null references atlas_private.flavor_ingredients(id) on delete cascade,
  preparation_id uuid not null references atlas_private.flavor_preparations(id) on delete cascade,
  primary key (ingredient_id, preparation_id)
);
create index if not exists flavor_ingredient_preparations_prep_idx
  on atlas_private.flavor_ingredient_preparations (preparation_id);

create table if not exists atlas_private.flavor_edges (
  id uuid primary key default gen_random_uuid(),
  a_id uuid not null references atlas_private.flavor_ingredients(id) on delete cascade,
  a_prep uuid references atlas_private.flavor_preparations(id) on delete cascade,
  b_id uuid not null references atlas_private.flavor_ingredients(id) on delete cascade,
  b_prep uuid references atlas_private.flavor_preparations(id) on delete cascade,
  relation text not null check (relation in ('complement','contrast','bridge','substitute')),
  strength numeric not null check (strength between 0 and 1),
  aroma_score numeric check (aroma_score is null or aroma_score between 0 and 1),
  taste_score numeric check (taste_score is null or taste_score between 0 and 1),
  texture_score numeric check (texture_score is null or texture_score between 0 and 1),
  contexts text[] not null default '{}'
    check (contexts <@ array['cocktail','mocktail','coffee','dessert','food']::text[]),
  evidence_type text not null check (evidence_type in ('scientific','culinary','atlas_learned','ai_interpretation')),
  provider text not null references atlas_private.flavor_sources(id),
  confidence numeric not null check (confidence between 0 and 1),
  explanation text not null check (btrim(explanation) <> ''),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  -- Undirected: stored once, lower id first.
  constraint flavor_edges_distinct_ends check (a_id <> b_id),
  constraint flavor_edges_ordered check (a_id < b_id)
);
comment on column atlas_private.flavor_edges.contexts is
  'Where the pairing is known to work: cocktail, mocktail, coffee, dessert, food.';
create unique index if not exists flavor_edges_identity_idx on atlas_private.flavor_edges (
  a_id, coalesce(a_prep, '00000000-0000-0000-0000-000000000000'::uuid),
  b_id, coalesce(b_prep, '00000000-0000-0000-0000-000000000000'::uuid),
  relation, evidence_type);
create index if not exists flavor_edges_b_idx on atlas_private.flavor_edges (b_id);

create table if not exists atlas_private.flavor_item_links (
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  ingredient_id uuid not null references atlas_private.flavor_ingredients(id) on delete cascade,
  preparation_id uuid references atlas_private.flavor_preparations(id) on delete set null,
  status text not null check (status in ('confirmed','needs_review','rejected')),
  match_method text not null,
  confidence numeric not null check (confidence between 0 and 1),
  note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (inventory_item_id, ingredient_id)
);
create index if not exists flavor_item_links_ingredient_idx on atlas_private.flavor_item_links (ingredient_id);
comment on table atlas_private.flavor_item_links is
  'Inventory item -> canonical ingredient. Additive: never changes an inventory row. needs_review links are possible matches only.';

drop trigger if exists flavor_ingredients_touch on atlas_private.flavor_ingredients;
create trigger flavor_ingredients_touch before update on atlas_private.flavor_ingredients
  for each row execute function atlas_private.touch_updated_at();

-- ------------------------------------------------------------------ RLS, grants

do $s95a_grants$
declare
  t text;
begin
  foreach t in array array['flavor_sources','flavor_ingredients','flavor_aliases','flavor_preparations',
    'flavor_ingredient_preparations','flavor_edges','flavor_item_links'] loop
    execute format('alter table atlas_private.%I enable row level security', t);
    execute format('drop policy if exists %I on atlas_private.%I', 'service role manages ' || replace(t, '_', ' '), t);
    execute format('create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',
      'service role manages ' || replace(t, '_', ' '), t);
    execute format('revoke all on atlas_private.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on atlas_private.%I to service_role', t);
    execute format('revoke truncate, references, trigger on atlas_private.%I from service_role', t);
  end loop;
end
$s95a_grants$;

-- ------------------------------------------------------------------ reader

-- The whole graph in one read (a few hundred rows). The Edge Function caches
-- it for five minutes; `version` is an md5 of the content so a cache can tell
-- when curated data changed. Links carry ids and review state only: product
-- facts (name, stock, cost) stay in inventory and are read from there.
create or replace function public.atlas_flavor_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with body as (
    select pg_catalog.jsonb_build_object(
      'sources', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', s.id, 'name', s.name, 'url', s.url, 'license', s.license,
          'commercial_use', s.commercial_use, 'attribution', s.attribution,
          'verdict', s.verdict, 'notes', s.notes) order by s.id)
        from atlas_private.flavor_sources s), '[]'::jsonb),
      'ingredients', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', i.id, 'slug', i.slug, 'name', i.name, 'family', i.family, 'subfamily', i.subfamily,
          'aroma', i.aroma, 'taste', i.taste, 'intensity', i.intensity, 'texture', i.texture,
          'abv_typical', i.abv_typical, 'allergens', pg_catalog.to_jsonb(i.allergens),
          'dietary', pg_catalog.to_jsonb(i.dietary), 'uses', pg_catalog.to_jsonb(i.uses),
          'techniques', pg_catalog.to_jsonb(i.techniques), 'attributes', i.attributes,
          'provider', i.provider, 'confidence', i.confidence, 'version', i.version) order by i.slug)
        from atlas_private.flavor_ingredients i), '[]'::jsonb),
      'aliases', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'ingredient_id', a.ingredient_id, 'slug', i.slug, 'alias', a.alias,
          'alias_key', a.alias_key, 'language', a.language) order by i.slug, a.alias_key)
        from atlas_private.flavor_aliases a
        join atlas_private.flavor_ingredients i on i.id = a.ingredient_id), '[]'::jsonb),
      'preparations', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', p.id, 'slug', p.slug, 'name', p.name, 'taste_shift', p.taste_shift,
          'aroma_shift', p.aroma_shift, 'texture', p.texture, 'notes', p.notes) order by p.slug)
        from atlas_private.flavor_preparations p), '[]'::jsonb),
      'ingredient_preparations', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'ingredient_id', ip.ingredient_id, 'slug', i.slug,
          'preparation_id', ip.preparation_id, 'preparation', p.slug) order by i.slug, p.slug)
        from atlas_private.flavor_ingredient_preparations ip
        join atlas_private.flavor_ingredients i on i.id = ip.ingredient_id
        join atlas_private.flavor_preparations p on p.id = ip.preparation_id), '[]'::jsonb),
      'edges', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', e.id, 'a_id', e.a_id, 'a', ia.slug, 'a_prep', pa.slug,
          'b_id', e.b_id, 'b', ib.slug, 'b_prep', pb.slug,
          'relation', e.relation, 'strength', e.strength, 'aroma_score', e.aroma_score,
          'taste_score', e.taste_score, 'texture_score', e.texture_score,
          'contexts', pg_catalog.to_jsonb(e.contexts), 'evidence_type', e.evidence_type,
          'provider', e.provider, 'confidence', e.confidence, 'explanation', e.explanation,
          'version', e.version) order by ia.slug, ib.slug, e.relation, e.evidence_type, e.id)
        from atlas_private.flavor_edges e
        join atlas_private.flavor_ingredients ia on ia.id = e.a_id
        join atlas_private.flavor_ingredients ib on ib.id = e.b_id
        left join atlas_private.flavor_preparations pa on pa.id = e.a_prep
        left join atlas_private.flavor_preparations pb on pb.id = e.b_prep), '[]'::jsonb),
      'links', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'inventory_item_id', l.inventory_item_id, 'ingredient_id', l.ingredient_id, 'slug', i.slug,
          'preparation', p.slug, 'status', l.status, 'match_method', l.match_method,
          'confidence', l.confidence, 'note', l.note) order by i.slug, l.inventory_item_id)
        from atlas_private.flavor_item_links l
        join atlas_private.flavor_ingredients i on i.id = l.ingredient_id
        left join atlas_private.flavor_preparations p on p.id = l.preparation_id
        where l.status in ('confirmed','needs_review')), '[]'::jsonb)
    ) as b
  )
  select body.b || pg_catalog.jsonb_build_object('version', pg_catalog.md5(body.b::text))
  from body;
$function$;

comment on function public.atlas_flavor_snapshot() is
  'S95 Flavor Intelligence: read-only graph snapshot for the atlas-ai Edge Function (service_role only).';
revoke all on function public.atlas_flavor_snapshot() from public, anon, authenticated;
grant execute on function public.atlas_flavor_snapshot() to service_role;

notify pgrst, 'reload schema';
