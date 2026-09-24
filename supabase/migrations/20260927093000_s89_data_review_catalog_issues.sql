-- S89 Data review issue codes for catalogue governance (WP11, SQL only; the
-- Data review UI and the Home attention row are owned by E4/E2).
--
--   inventory.possible_duplicate  active pairs that score >= 0.75 on the
--                                 duplicate guard or share an active code,
--                                 minus pairs a manager marked "Not duplicates"
--   catalog.pending_approval      open catalogue change requests ("Waiting for approval")
--   catalog.code_collision        one active code held by two active items
--   inventory.category_unmapped   category text missing from the taxonomy
--
-- inventory.missing_reference also counts S89 codes. Read-only: nothing here
-- writes an item, a code or a request.

create or replace function private.data_review_catalogue()
returns table (code text, entity_type text, label text, sort_order integer)
language sql
immutable
set search_path = ''
as $function$
  select * from (values
    ('inventory.missing_supplier','inventory_item','No supplier linked',1),
    ('inventory.supplier_text_unlinked','inventory_item','Supplier name typed but not linked',2),
    ('inventory.missing_cost','inventory_item','No unit or case cost',3),
    ('inventory.missing_reference','inventory_item','No SKU, barcode or supplier reference',4),
    ('inventory.package_missing','inventory_item','No package size',5),
    ('inventory.package_unreadable','inventory_item','Package size cannot be read',6),
    ('inventory.missing_par','inventory_item','No par level',7),
    ('inventory.flagged_needs_review','inventory_item','Flagged for review',8),
    ('recipe.missing_price','recipe','Recipe has no menu price',9),
    ('recipe.no_ingredients','recipe','Recipe has no ingredients',10),
    ('recipe.ingredient_unlinked','recipe_ingredient','Ingredient not linked to stock',11),
    ('recipe.ingredient_inactive_item','recipe_ingredient','Ingredient uses an inactive item',12),
    ('inventory.possible_duplicate','inventory_item','Possible duplicate item',13),
    ('catalog.pending_approval','catalog_change_request','Waiting for approval',14),
    ('catalog.code_collision','inventory_item','Barcode or code used by two items',15),
    ('inventory.category_unmapped','inventory_item','Category not in the product list',16)
  ) as catalogue(code, entity_type, label, sort_order);
$function$;
revoke all on function private.data_review_catalogue() from public, anon, authenticated;

-- Active pairs worth a manager's look. Cheap prefilter on shared match
-- tokens or codes, then the duplicate guard score.
create or replace function atlas_private.catalog_possible_duplicate_pairs(p_threshold numeric default 0.75)
returns table (item_a uuid, item_b uuid, score numeric, code_collision boolean, evidence jsonb)
language sql
stable
set search_path = ''
as $function$
  with keys as materialized (
    select k.* from atlas_private.catalog_item_duplicate_keys() k where k.active
  ), tokens as (
    select k.item_id, t.token, cardinality(string_to_array(coalesce(k.keys->>'match_key', ''), ' ')) as size
    from keys k cross join lateral unnest(string_to_array(nullif(k.keys->>'match_key', ''), ' ')) as t(token)
  ), token_pairs as (
    select a.item_id as item_a, b.item_id as item_b
    from tokens a join tokens b on a.token = b.token and a.item_id < b.item_id
    group by a.item_id, b.item_id, a.size, b.size
    having 2.0 * count(distinct a.token) / (a.size + b.size) >= 0.5
  ), code_pairs as (
    select a.item_id as item_a, b.item_id as item_b
    from keys a, jsonb_array_elements(a.keys->'codes') ca,
         keys b, jsonb_array_elements(b.keys->'codes') cb
    where a.item_id < b.item_id and ca->>'kind' = cb->>'kind' and ca->>'normalized' = cb->>'normalized'
  ), alias_pairs as (
    select a.item_id as item_a, b.item_id as item_b
    from keys a join keys b on a.item_id < b.item_id
    where (a.keys->>'match_key') = any(array(select jsonb_array_elements_text(b.keys->'alias_keys')))
       or (b.keys->>'match_key') = any(array(select jsonb_array_elements_text(a.keys->'alias_keys')))
  ), pairs as (
    select * from token_pairs union select * from code_pairs union select * from alias_pairs
  )
  select p.item_a, p.item_b, (s.result->>'score')::numeric, (s.result->>'code_collision')::boolean, s.result->'evidence'
  from pairs p
  join keys a on a.item_id = p.item_a
  join keys b on b.item_id = p.item_b
  cross join lateral (select atlas_private.catalog_duplicate_score(a.keys, b.keys) as result) s
  where ((s.result->>'score')::numeric >= p_threshold or (s.result->>'code_collision')::boolean)
    and not exists (select 1 from atlas_private.catalog_distinct_pairs d
                    where d.item_a = least(p.item_a, p.item_b) and d.item_b = greatest(p.item_a, p.item_b));
$function$;
revoke all on function atlas_private.catalog_possible_duplicate_pairs(numeric) from public, anon, authenticated;
grant execute on function atlas_private.catalog_possible_duplicate_pairs(numeric) to service_role;

create or replace function private.data_review_issue_rows()
returns table (code text, entity_type text, entity_id uuid, name text, category text, detail jsonb, fix text)
language sql
stable
security definer
set search_path = ''
as $function$
  with items as (
    select i.*,
      nullif(pg_catalog.btrim(coalesce(i.package_size,'')),'') as package_text,
      exists (select 1 from atlas_private.inventory_scan_aliases a
              where a.external_item_id = i.id and a.active)
      or exists (select 1 from atlas_private.inventory_item_codes c
              where c.item_id = i.id and c.status = 'active') as has_alias
    from public.inventory_items i
    where i.active
  ), duplicate_pairs as materialized (
    select * from atlas_private.catalog_possible_duplicate_pairs(0.75)
  ), item_issues as (
    select 'inventory.missing_supplier' as code, i.id, i.name, i.category,
           jsonb_build_object('supplier_text', nullif(pg_catalog.btrim(coalesce(i.supplier,'')),'')) as detail, 'item_master' as fix
    from items i where i.supplier_id is null
    union all
    select 'inventory.supplier_text_unlinked', i.id, i.name, i.category,
           jsonb_build_object('supplier_text', pg_catalog.btrim(i.supplier)), 'item_master'
    from items i where i.supplier_id is null and nullif(pg_catalog.btrim(coalesce(i.supplier,'')),'') is not null
    union all
    select 'inventory.missing_cost', i.id, i.name, i.category,
           jsonb_build_object('case_cost', i.case_cost, 'units_per_case', i.units_per_case), 'item_master'
    from items i where i.cost_price is null and not (i.case_cost is not null and coalesce(i.units_per_case,0) > 0)
    union all
    select 'inventory.missing_reference', i.id, i.name, i.category, '{}'::jsonb, 'item_master'
    from items i
    where nullif(pg_catalog.btrim(coalesce(i.sku,'')),'') is null
      and nullif(pg_catalog.btrim(coalesce(i.barcode,'')),'') is null
      and nullif(pg_catalog.btrim(coalesce(i.supplier_product_reference,'')),'') is null
      and not i.has_alias
    union all
    select 'inventory.package_missing', i.id, i.name, i.category, '{}'::jsonb, 'item_master'
    from items i where i.size_ml is null and i.package_weight_g is null and i.package_text is null
      and i.unit_size_quantity is null
    union all
    select 'inventory.package_unreadable', i.id, i.name, i.category,
           jsonb_build_object('package_size', i.package_text), 'item_master'
    from items i
    where i.size_ml is null and i.package_weight_g is null and i.package_text is not null and i.unit_size_quantity is null
      and (select p.measure_quantity from atlas_private.reports_parse_pack_measure(i.package_text) p limit 1) is null
    union all
    select 'inventory.missing_par', i.id, i.name, i.category,
           jsonb_build_object('unit', i.unit, 'critical_minimum', i.critical_minimum), 'par_levels'
    from items i where i.par_level is null
    union all
    select 'inventory.flagged_needs_review', i.id, i.name, i.category,
           jsonb_build_object('source_type', i.source_type, 'source_confidence', i.source_confidence), 'item_master'
    from items i where i.needs_review
    union all
    select 'inventory.possible_duplicate', i.id, i.name, i.category,
           jsonb_build_object('other_item_id', other.id, 'other_item_name', other.name, 'score', d.score,
             'code_collision', d.code_collision, 'evidence', d.evidence), 'catalog_duplicates'
    from duplicate_pairs d
    join items i on i.id in (d.item_a, d.item_b)
    join public.inventory_items other on other.id = case when i.id = d.item_a then d.item_b else d.item_a end
    union all
    select 'catalog.code_collision', i.id, i.name, i.category,
           jsonb_build_object('kind', c.kind, 'code', c.code_normalized,
             'other_item_ids', to_jsonb(array(select l.item_id from atlas_private.inventory_code_lookup l
               join public.inventory_items o on o.id = l.item_id and o.active
               where l.kind = c.kind and l.code_normalized = c.code_normalized and l.status = 'active' and l.item_id <> i.id))),
           'catalog_codes'
    from items i
    join atlas_private.inventory_code_lookup c on c.item_id = i.id and c.status = 'active'
    where exists (select 1 from atlas_private.inventory_code_lookup l
                  join public.inventory_items o on o.id = l.item_id and o.active
                  where l.kind = c.kind and l.code_normalized = c.code_normalized and l.status = 'active'
                    and l.item_id <> i.id
                    and (c.kind <> 'supplier_ref' or l.supplier_id is null or c.supplier_id is null or l.supplier_id = c.supplier_id))
    union all
    select 'inventory.category_unmapped', i.id, i.name, i.category,
           jsonb_build_object('category', i.category, 'subcategory', i.subcategory), 'item_master'
    from items i where atlas_private.inventory_class_for_category(i.category, i.subcategory) is null
  ), recipe_issues as (
    select 'recipe.missing_price' as code, 'recipe' as entity_type, r.id, r.name, r.type as category,
           '{}'::jsonb as detail, 'recipe' as fix
    from public.recipes r where r.active and r.menu_price is null
    union all
    select 'recipe.no_ingredients', 'recipe', r.id, r.name, r.type, '{}'::jsonb, 'recipe'
    from public.recipes r
    where r.active and not exists (select 1 from public.recipe_ingredients ri where ri.recipe_id = r.id)
    union all
    select 'recipe.ingredient_unlinked', 'recipe_ingredient', ri.id, r.name, r.type,
           jsonb_build_object('recipe_id', r.id, 'ingredient_name', ri.item_name), 'recipe'
    from public.recipe_ingredients ri join public.recipes r on r.id = ri.recipe_id
    where r.active and ri.item_id is null
    union all
    select 'recipe.ingredient_inactive_item', 'recipe_ingredient', ri.id, r.name, r.type,
           jsonb_build_object('recipe_id', r.id, 'ingredient_name', ri.item_name, 'item_id', i.id, 'item_name', i.name), 'recipe'
    from public.recipe_ingredients ri
    join public.recipes r on r.id = ri.recipe_id
    join public.inventory_items i on i.id = ri.item_id
    where r.active and i.active is not true
  ), catalog_issues as (
    select 'catalog.pending_approval' as code, 'catalog_change_request' as entity_type, r.id,
           coalesce((select i.name from public.inventory_items i where i.id = r.subject_item_id),
                    r.payload->'values'->>'name', r.payload->>'alias', r.kind) as name,
           r.kind as category,
           jsonb_build_object('kind', r.kind, 'source', r.source, 'requested_by_label', r.requested_by_label,
             'requested_at', r.requested_at, 'version', r.version) as detail,
           'catalog_queue' as fix
    from atlas_private.catalog_change_requests r
    where r.status = 'pending'
  )
  select ii.code, 'inventory_item', ii.id, ii.name, ii.category, ii.detail, ii.fix from item_issues ii
  union all
  select ri.code, ri.entity_type, ri.id, ri.name, ri.category, ri.detail, ri.fix from recipe_issues ri
  union all
  select ci.code, ci.entity_type, ci.id, ci.name, ci.category, ci.detail, ci.fix from catalog_issues ci;
$function$;
revoke all on function private.data_review_issue_rows() from public, anon, authenticated;

notify pgrst, 'reload schema';
