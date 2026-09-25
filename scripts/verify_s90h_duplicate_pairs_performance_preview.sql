-- S90h preview-only acceptance: Data › Issues stays inside the API limit
-- (20260930091000_s90h_duplicate_pairs_performance.sql). Rolled back.
--
-- Seeds a realistic 300-item bar catalogue (brands × products × sizes, no
-- identity duplicates) plus near-duplicate pairs, then:
-- * the full Data review issue list is computed well inside the 8 s limit
--   (budget 3 s here; the pre-S90h function took over 20 s at this size);
-- * the seeded near-duplicates are still reported as possible duplicates.

begin;

create temporary table s90h_perf (test_name text primary key, passed boolean not null) on commit drop;

insert into public.inventory_items (id,name,category,unit,active,quantity,size_ml)
select gen_random_uuid(), b.brand || ' ' || p.product || case when s.size = 700 then '' else ' ' || s.size || 'ml' end,
       p.category, 'bottles', true, 0, s.size
from (values ('Absolut'),('Beefeater'),('Bacardi'),('Havana'),('Jameson'),('Tullamore'),('Smirnoff'),('Gordons'),('Bombay'),('Hendricks'),
             ('Monin'),('Giffard'),('Fever-Tree'),('Schweppes'),('Martini'),('Cinzano'),('Campari'),('Luxardo'),('Cointreau'),('Disaronno')) b(brand)
cross join (values ('Vodka','Vodka'),('Gin','Gin'),('Rum','Rum'),('Whiskey','Whiskey'),('Vanilla Syrup','Syrups'),
                   ('Tonic Water','Mixers'),('Bitter','Aperitif'),('Liqueur','Liqueur'),('Maraschino','Liqueur'),('Orange','Liqueur'),
                   ('Ginger Ale','Mixers'),('Espresso','Liqueur'),('Rosso','Vermouth'),('Bianco','Vermouth'),('Caramel Syrup','Syrups')) p(product, category)
cross join (values (700)) s(size)
on conflict do nothing;

insert into public.inventory_items (id,name,category,unit,active,quantity,size_ml) values
  (gen_random_uuid(),'S90h Giffard Vanille Sirop','Syrups','bottles',true,0,1000),
  (gen_random_uuid(),'S90h Giffard Vanilla Syrup','Syrups','bottles',true,0,1000),
  (gen_random_uuid(),'S90h Kahlúa Coffee Liqueur','Liqueur','bottles',true,0,700),
  (gen_random_uuid(),'S90h Kahlua Coffee Liqueur','Liqueur','bottles',true,0,700);

insert into s90h_perf select 'the seeded catalogue has at least 300 active items',
  (select count(*) from public.inventory_items where active) >= 300;

do $timing$
declare
  started timestamptz := clock_timestamp();
  total integer;
  elapsed_ms numeric;
begin
  select count(*) into total from private.data_review_issue_rows();
  elapsed_ms := extract(epoch from clock_timestamp() - started) * 1000;
  raise notice 's90h issue rows: % in % ms', total, round(elapsed_ms);
  insert into s90h_perf values ('the full Data review issue list is computed in under 3 s', elapsed_ms < 3000);
end
$timing$;

insert into s90h_perf select 'seeded near-duplicates are still reported',
  exists (select 1 from atlas_private.catalog_possible_duplicate_pairs(0.75) d
          join public.inventory_items a on a.id = d.item_a join public.inventory_items b on b.id = d.item_b
          where a.name like 'S90h Kahl%' and b.name like 'S90h Kahl%');

select jsonb_build_object(
  's90h_duplicate_pairs_performance', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s90h_perf;

rollback;
