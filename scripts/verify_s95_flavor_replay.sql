-- S95 Flavor Intelligence replay acceptance (20261005090000_s95a_flavor_graph.sql,
-- 20261005091000_s95b_recipe_draft_kind.sql, 20261005092000_s95c_flavor_seed.sql).
-- Run with psql after a full local replay; everything is rolled back.
--
--   PGHOST=127.0.0.1 PGDATABASE=<replay db> psql -X -qAt -f scripts/verify_s95_flavor_replay.sql
--
-- * the snapshot reader returns the seeded graph (counts) and nothing from inventory
-- * definer functions pin search_path = ''; the reader is service_role only
-- * anon/authenticated have no privilege on any flavor table; RLS is on everywhere
-- * ids are the deterministic md5 uuids; edges are stored once (a_id < b_id)
-- * evidence is culinary only (nothing labelled scientific)
-- * re-running the seed changes nothing (idempotent, versions stay 1)
-- * item links are inserted only for inventory items that exist, a reviewed link
--   is never overwritten, rejected links are not in the snapshot, and deleting an
--   inventory item removes only its links (inventory rows are never written by
--   the seed)

begin;

create temporary table s95_flavor (test_name text primary key, passed boolean not null, detail jsonb) on commit drop;

-- ---------- snapshot on the replayed (empty-inventory) database
insert into s95_flavor
select 'snapshot returns the seeded graph and no links on an empty inventory',
  jsonb_array_length(s->'ingredients') = (select count(*) from atlas_private.flavor_ingredients)
  and jsonb_array_length(s->'edges') = (select count(*) from atlas_private.flavor_edges)
  and jsonb_array_length(s->'aliases') = (select count(*) from atlas_private.flavor_aliases)
  and jsonb_array_length(s->'preparations') = (select count(*) from atlas_private.flavor_preparations)
  and jsonb_array_length(s->'ingredient_preparations') = (select count(*) from atlas_private.flavor_ingredient_preparations)
  and jsonb_array_length(s->'sources') = (select count(*) from atlas_private.flavor_sources)
  and jsonb_array_length(s->'links') = 0
  and jsonb_array_length(s->'ingredients') > 200 and jsonb_array_length(s->'edges') > 900
  and length(s->>'version') = 32,
  jsonb_build_object('ingredients', jsonb_array_length(s->'ingredients'), 'edges', jsonb_array_length(s->'edges'),
    'aliases', jsonb_array_length(s->'aliases'), 'preparations', jsonb_array_length(s->'preparations'),
    'ingredient_preparations', jsonb_array_length(s->'ingredient_preparations'),
    'sources', jsonb_array_length(s->'sources'), 'links', jsonb_array_length(s->'links'), 'version', s->>'version')
from (select public.atlas_flavor_snapshot() as s) x;

insert into s95_flavor
select 'snapshot version is stable across calls',
  (select public.atlas_flavor_snapshot()->>'version') = (select public.atlas_flavor_snapshot()->>'version'), null;

-- ---------- security model
insert into s95_flavor
select 'definer functions pin search_path to empty',
  bool_and(p.prosecdef and coalesce('search_path=""' = any(p.proconfig), false)),
  jsonb_agg(jsonb_build_object('fn', p.oid::regprocedure::text, 'definer', p.prosecdef, 'config', p.proconfig))
from pg_proc p where p.oid = 'public.atlas_flavor_snapshot()'::regprocedure;

insert into s95_flavor
select 'recipe.draft allow-list keeps search_path and stays private',
  coalesce('search_path=""' = any(p.proconfig), false)
  and not has_function_privilege('anon', p.oid, 'execute')
  and not has_function_privilege('authenticated', p.oid, 'execute')
  and has_function_privilege('service_role', p.oid, 'execute')
  and atlas_private.ai_action_allowed_roles('recipe.draft', '{}'::jsonb) = array['admin','manager']::text[], null
from pg_proc p where p.oid = 'atlas_private.ai_action_allowed_roles(text,jsonb)'::regprocedure;

insert into s95_flavor
select 'snapshot reader: service_role only',
  not has_function_privilege('anon', 'public.atlas_flavor_snapshot()', 'execute')
  and not has_function_privilege('authenticated', 'public.atlas_flavor_snapshot()', 'execute')
  and not has_function_privilege('public', 'public.atlas_flavor_snapshot()', 'execute')
  and has_function_privilege('service_role', 'public.atlas_flavor_snapshot()', 'execute'), null;

insert into s95_flavor
select 'no browser role privilege on any flavor table; RLS on; service-role policy only',
  bool_and(c.relrowsecurity
    and not has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')
    and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate,references,trigger')
    and has_table_privilege('service_role', c.oid, 'select')
    and not exists (select 1 from pg_policies pol where pol.schemaname = 'atlas_private' and pol.tablename = c.relname
                    and pol.roles && array['anon','authenticated','public']::name[])),
  jsonb_agg(jsonb_build_object('table', c.relname, 'rls', c.relrowsecurity) order by c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'atlas_private' and c.relname like 'flavor\_%' and c.relkind = 'r'
having count(*) = 7;

insert into s95_flavor
select 'no flavor object is exposed in public except the reader',
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname like '%flavor%')
  and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like '%flavor%') = 1, null;

do $roles$
declare
  n integer;
  denied boolean := false;
begin
  set local role service_role;
  n := jsonb_array_length(public.atlas_flavor_snapshot()->'ingredients');
  reset role;
  set local role authenticated;
  begin
    perform public.atlas_flavor_snapshot();
  exception when insufficient_privilege then denied := true;
  end;
  begin
    perform 1 from atlas_private.flavor_ingredients limit 1;
    denied := false;
  exception when insufficient_privilege then null;
  end;
  reset role;
  insert into s95_flavor values ('as service_role the reader works; as authenticated it and the tables are refused',
    n > 200 and denied, jsonb_build_object('service_role_ingredients', n));
end
$roles$;

-- ---------- data model
insert into s95_flavor
select 'ids are deterministic md5 uuids',
  not exists (select 1 from atlas_private.flavor_ingredients where id <> md5('flavor:' || slug)::uuid)
  and not exists (select 1 from atlas_private.flavor_preparations where id <> md5('flavor-prep:' || slug)::uuid), null;

insert into s95_flavor
select 'edges are undirected, stored once, culinary only, all explained',
  not exists (select 1 from atlas_private.flavor_edges where not (a_id < b_id))
  and not exists (select 1 from atlas_private.flavor_edges where evidence_type <> 'culinary' or provider <> 'atlas_curated')
  and not exists (select 1 from atlas_private.flavor_edges where btrim(explanation) = ''),
  (select jsonb_object_agg(relation, n) from (select relation, count(*) n from atlas_private.flavor_edges group by relation) r);

insert into s95_flavor
select 'every curated row comes from a usable provider',
  not exists (select 1 from atlas_private.flavor_ingredients i join atlas_private.flavor_sources s on s.id = i.provider
              where s.verdict not in ('use','use_with_attribution'))
  and not exists (select 1 from atlas_private.flavor_edges e join atlas_private.flavor_sources s on s.id = e.provider
              where s.verdict not in ('use','use_with_attribution')), null;

-- ---------- idempotent seed
create temporary table s95_before on commit drop as
select (select count(*) from atlas_private.flavor_ingredients) ing, (select count(*) from atlas_private.flavor_edges) edg,
       (select count(*) from atlas_private.flavor_aliases) ali, (select count(*) from atlas_private.flavor_ingredient_preparations) ip,
       (select public.atlas_flavor_snapshot()->>'version') ver;

\ir ../supabase/migrations/20261005092000_s95c_flavor_seed.sql

insert into s95_flavor
select 're-running the seed changes nothing',
  b.ing = (select count(*) from atlas_private.flavor_ingredients)
  and b.edg = (select count(*) from atlas_private.flavor_edges)
  and b.ali = (select count(*) from atlas_private.flavor_aliases)
  and b.ip = (select count(*) from atlas_private.flavor_ingredient_preparations)
  and b.ver = (select public.atlas_flavor_snapshot()->>'version')
  and not exists (select 1 from atlas_private.flavor_ingredients where version <> 1)
  and not exists (select 1 from atlas_private.flavor_edges where version <> 1), null
from s95_before b;

-- ---------- item links (temporary test items with ids from data/flavor/item-links.json)
insert into public.inventory_items (id, name, category, unit, active, quantity) values
  ('22c88317-e608-43c6-86ea-ba2b3b59c975', 'S95 test lime juice', 'Bar Ingredients', 'liters', true, 0),
  ('6955740f-f5c8-4935-85b9-db6177efe468', 'S95 test pink gin', 'Gin', 'bottles', true, 0),
  ('003ceafd-062e-4547-a5c8-a8af09593c11', 'S95 test vermouth', 'Vermouth / Aperitivo', 'bottles', true, 0);

create temporary table s95_items_before on commit drop as
select id, md5(i::text) row_hash from public.inventory_items i;

\ir ../supabase/migrations/20261005092000_s95c_flavor_seed.sql

insert into s95_flavor
select 'links are inserted only for existing items, with the mapped status and preparation',
  (select count(*) from atlas_private.flavor_item_links) = 3
  and exists (select 1 from atlas_private.flavor_item_links l join atlas_private.flavor_ingredients i on i.id = l.ingredient_id
              join atlas_private.flavor_preparations p on p.id = l.preparation_id
              where l.inventory_item_id = '22c88317-e608-43c6-86ea-ba2b3b59c975' and i.slug = 'lime' and p.slug = 'juice' and l.status = 'confirmed')
  and exists (select 1 from atlas_private.flavor_item_links l join atlas_private.flavor_ingredients i on i.id = l.ingredient_id
              where l.inventory_item_id = '6955740f-f5c8-4935-85b9-db6177efe468' and i.slug = 'pink-gin' and l.status = 'confirmed')
  and exists (select 1 from atlas_private.flavor_item_links l join atlas_private.flavor_ingredients i on i.id = l.ingredient_id
              where l.inventory_item_id = '003ceafd-062e-4547-a5c8-a8af09593c11' and i.slug = 'dry-vermouth' and l.status = 'needs_review'),
  (select jsonb_agg(jsonb_build_object('item', inventory_item_id, 'status', status, 'method', match_method) order by inventory_item_id)
   from atlas_private.flavor_item_links);

insert into s95_flavor
select 'the seed never changes an inventory row',
  not exists (select 1 from public.inventory_items i join s95_items_before b on b.id = i.id where md5(i::text) <> b.row_hash)
  and (select count(*) from public.inventory_items) = (select count(*) from s95_items_before), null;

insert into s95_flavor
select 'snapshot links carry ids and status only, no inventory names',
  jsonb_array_length(s->'links') = 3
  and position('S95 test' in s::text) = 0
  and (select bool_and(l ? 'status' and l ? 'inventory_item_id' and not l ? 'name') from jsonb_array_elements(s->'links') l), null
from (select public.atlas_flavor_snapshot() s) x;

-- a manager rejects the vermouth match; a re-seed must not overwrite the review
update atlas_private.flavor_item_links set status = 'rejected', reviewed_at = now()
where inventory_item_id = '003ceafd-062e-4547-a5c8-a8af09593c11';

\ir ../supabase/migrations/20261005092000_s95c_flavor_seed.sql

insert into s95_flavor
select 'a reviewed link survives a re-seed and rejected links are not in the snapshot',
  (select status from atlas_private.flavor_item_links where inventory_item_id = '003ceafd-062e-4547-a5c8-a8af09593c11') = 'rejected'
  and jsonb_array_length(public.atlas_flavor_snapshot()->'links') = 2, null;

-- deleting an inventory item removes only its links
create temporary table s95_graph_before on commit drop as
select (select count(*) from atlas_private.flavor_ingredients) ing, (select count(*) from atlas_private.flavor_edges) edg;

delete from public.inventory_items where id = '22c88317-e608-43c6-86ea-ba2b3b59c975';

insert into s95_flavor
select 'deleting an inventory item cascades only to its flavor links',
  not exists (select 1 from atlas_private.flavor_item_links where inventory_item_id = '22c88317-e608-43c6-86ea-ba2b3b59c975')
  and (select count(*) from atlas_private.flavor_item_links) = 2
  and exists (select 1 from atlas_private.flavor_ingredients where slug = 'lime')
  and g.ing = (select count(*) from atlas_private.flavor_ingredients)
  and g.edg = (select count(*) from atlas_private.flavor_edges)
  and (select count(*) from public.inventory_items) = 2, null
from s95_graph_before g;

-- ---------- the recipe.draft kind (S95B)
insert into s95_flavor
select 'recipe.draft is admin/manager only; earlier kinds unchanged',
  atlas_private.ai_action_allowed_roles('recipe.draft','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('purchase_order.update_draft','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('catalog.alias','{}'::jsonb) = array['admin','manager','bartender']::text[], null;

select jsonb_build_object(
  's95_flavor_replay', case when bool_and(passed) and count(*) = 18 then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed, 'detail', detail) order by test_name)
) from s95_flavor;

rollback;
