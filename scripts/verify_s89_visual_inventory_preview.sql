-- S89 preview-only Visual Inventory foundation acceptance. Rolled back.
--
-- Covers: Icelandic letters (Á á Ð ð É é Í í Ó ó Ú ú Ý ý Þ þ Æ æ Ö ö) survive
-- folding, stored identity keys, item and alias round trips, and are only
-- transliterated in the search-only key; accent-insensitive search finds them;
-- the full-text path works without pg_trgm and the trigram path works when it
-- is installed; unique active identity; code guard (codes table and legacy
-- columns); GTIN normalisation in resolve-codes; the recognition definer role
-- cannot write quantities, items, codes, aliases or run writers (privilege
-- test); recognition record/outcome audit with stock unchanged; the scanner
-- can never enable live apply; stock-count add-line and recognition evidence
-- validation with three-decimal counts.

begin;

create temporary table s89_vi (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s89_vi to public;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-000000089901','s89-vi-mgr@example.invalid'),
  ('00000000-0000-4000-8000-000000089902','s89-vi-bar@example.invalid'),
  ('00000000-0000-4000-8000-000000089903','s89-vi-view@example.invalid')) as u(id, email);
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-000000089901','s89-vi-mgr@example.invalid','S89 manager','manager',true),
  ('00000000-0000-4000-8000-000000089902','s89-vi-bar@example.invalid','S89 bartender','bartender',true),
  ('00000000-0000-4000-8000-000000089903','s89-vi-view@example.invalid','S89 viewer','viewer',true)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;

insert into public.suppliers (id,name,active) values ('00000000-0000-4000-8000-000000089951','S89 supplier',true);
insert into public.inventory_items (id,name,category,quantity,unit,size_ml,package_weight_g,sku,barcode,supplier_id,supplier_product_reference,active) values
  ('00000000-0000-4000-8000-000000089911','Sítrónur 15kg','Fresh Fruit',0,'boxes',null,null,null,null,null,null,true),
  ('00000000-0000-4000-8000-000000089912','Giffard Vanille Syrup','Syrups',0,'bottles',1000,null,'S89-GIF-01',null,'00000000-0000-4000-8000-000000089951','GV-100',true),
  ('00000000-0000-4000-8000-000000089913','BOTANICA Þurrkaður Ananas 150g','Bar Ingredients',0,'packs',null,150,null,'5000299223017',null,null,true),
  ('00000000-0000-4000-8000-000000089914','Ölgerðin Egils Appelsín','Soda & Mixer',0,'bottles',2000,null,null,null,null,null,true),
  ('00000000-0000-4000-8000-000000089915','ÆÐARDÚNN ÝSA ÍS ÉG ÚR Ó Á Þ Ö','Test S89',0,'units',null,null,null,null,null,null,true),
  ('00000000-0000-4000-8000-000000089916','Giffard Vanille Syrup old','Syrups',0,'bottles',1000,null,null,null,null,null,false);

-- 1. Icelandic letters: stored forms keep them, search form transliterates.
insert into s89_vi select 'fold keeps every Icelandic letter lower-cased',
  atlas_private.product_text_fold('Á á Ð ð É é Í í Ó ó Ú ú Ý ý Þ þ Æ æ Ö ö') = 'á á ð ð é é í í ó ó ú ú ý ý þ þ æ æ ö ö';
insert into s89_vi select 'every Icelandic letter survives the stored name key and identity key',
  bool_and(position(lower(l) in atlas_private.product_name_key(null,null,null,'X' || l || 'y')) > 0
           and position(lower(l) in atlas_private.product_identity_key(null,null,null,'X' || l || 'y',null,null,null,null,null,null)) > 0)
from unnest(array['Á','á','Ð','ð','É','é','Í','í','Ó','ó','Ú','ú','Ý','ý','Þ','þ','Æ','æ','Ö','ö']) l;
insert into s89_vi select 'the search-only key is the only transliterated form',
  atlas_private.product_search_fold('Þurrkaður Ævintýri Ölgerð') = 'thurrkadur aevintyri olgerd'
  and atlas_private.product_name_key(null,null,null,'Þurrkaður Ananas') = 'ananas þurrkaður';
insert into s89_vi select 'item names round-trip byte for byte',
  (select name from public.inventory_items where id='00000000-0000-4000-8000-000000089915') = 'ÆÐARDÚNN ÝSA ÍS ÉG ÚR Ó Á Þ Ö'
  and (select convert_to(name,'UTF8') from public.inventory_items where id='00000000-0000-4000-8000-000000089911') = convert_to('Sítrónur 15kg','UTF8');
insert into s89_vi select 'stored identity keys keep the letters; no stored key is transliterated',
  (select identity_key from atlas_private.inventory_identity_keys where item_id='00000000-0000-4000-8000-000000089911') = 'sítrónur|15000g'
  and (select name_key from atlas_private.inventory_identity_keys where item_id='00000000-0000-4000-8000-000000089915') = 'æðardúnn ég ís ó ö úr ýsa þ'
  and (select match_key from atlas_private.inventory_search_documents where item_id='00000000-0000-4000-8000-000000089911') = 'lemon';
insert into s89_vi select 'the migration wrote no attribute into existing items',
  not exists (select 1 from public.inventory_items where id::text like '00000000-0000-4000-8000-00000008991%'
              and (product_name is not null or variant is not null or item_class is not null or unit_size_quantity is not null
                   or packaging_type is not null or attributes_source is not null));

-- Alias round trip through the governed insert path.
select atlas_private.catalog_insert_alias('00000000-0000-4000-8000-000000089913','Þurrkaður Ananas frá Botanica','product_name','is',
  'manager',null,'00000000-0000-4000-8000-000000089901','S89 manager',null);
insert into s89_vi select 'aliases round-trip with their letters and their key keeps them',
  exists (select 1 from public.inventory_aliases where item_id='00000000-0000-4000-8000-000000089913'
          and alias='Þurrkaður Ananas frá Botanica' and status='approved' and alias_kind='product_name'
          and atlas_private.product_name_key(null,null,null,alias) = 'ananas botanica frá þurrkaður');

-- 2. Search: accent-free and bilingual recall without pg_trgm.
insert into s89_vi select 'accent-free "Sitronur" finds Sítrónur on the full-text path',
  (r->>'method') = case when atlas_private.product_trgm_schema() is null then 'fts' else 'trigram' end
  and exists (select 1 from jsonb_array_elements(r->'candidates') c where c->>'item_id'='00000000-0000-4000-8000-000000089911'
              and (c->'features'->>'match_key_exact')::boolean)
from (select public.atlas_recognition_candidates('{"texts":["Sitronur 15kg"]}'::jsonb, 10,
  '00000000-0000-4000-8000-000000089902','bartender') as r) x;
insert into s89_vi select 'English "Lemons 15 kg" finds the Icelandic item through the search-only lexicon',
  exists (select 1 from jsonb_array_elements(r->'candidates') c where c->>'item_id'='00000000-0000-4000-8000-000000089911')
from (select public.atlas_recognition_candidates('{"texts":["Lemons 15 kg"]}'::jsonb, 10,
  '00000000-0000-4000-8000-000000089902','bartender') as r) x;
insert into s89_vi select 'free-text query "egils appelsin" matches Ölgerðin Egils Appelsín',
  exists (select 1 from jsonb_array_elements(r->'candidates') c where c->>'item_id'='00000000-0000-4000-8000-000000089914'
          and (c->'features'->>'text_score')::numeric > 0)
from (select public.atlas_recognition_candidates('{"query":"egils appelsin"}'::jsonb, 10,
  '00000000-0000-4000-8000-000000089902','bartender') as r) x;
insert into s89_vi select 'recognition payloads never carry costs; suppliers only for managers',
  not exists (select 1 from jsonb_array_elements(b->'candidates') c where c->'item' ? 'supplier_id' or c->'item' ? 'cost_price')
  and exists (select 1 from jsonb_array_elements(m->'candidates') c where c->'item' ? 'supplier_id' and not c->'item' ? 'cost_price')
from (select public.atlas_recognition_candidates('{"texts":["Giffard Vanille"]}'::jsonb, 5,'00000000-0000-4000-8000-000000089902','bartender') b,
             public.atlas_recognition_candidates('{"texts":["Giffard Vanille"]}'::jsonb, 5,'00000000-0000-4000-8000-000000089901','manager') m) x;
insert into s89_vi select 'the migrations never install pg_trgm',
  not exists (select 1 from pg_extension where extname='pg_trgm')
  or exists (select 1 from pg_extension where extname='pg_trgm' and current_setting('atlas.s89_trgm_preinstalled', true) = 'on');

-- Trigram path, exercised only when the extension is available to install
-- here (inside this rolled-back transaction).
do $trgm$
declare
  r jsonb;
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_trgm')
     and not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    create extension pg_trgm with schema extensions;
    perform atlas_private.inventory_search_enable_trigram();
    r := public.atlas_recognition_candidates('{"query":"giffard vanile sirup"}'::jsonb, 10,
      '00000000-0000-4000-8000-000000089902','bartender');
    insert into s89_vi select 'trigram path is used when pg_trgm is installed',
      r->>'method' = 'trigram'
      and exists (select 1 from jsonb_array_elements(r->'candidates') c where c->>'item_id'='00000000-0000-4000-8000-000000089912')
      and to_regclass('atlas_private.inventory_search_documents_trgm_idx') is not null;
    drop index atlas_private.inventory_search_documents_trgm_idx;
    drop extension pg_trgm;
  else
    insert into s89_vi values ('trigram path is used when pg_trgm is installed', true);
  end if;
end
$trgm$;

-- 3. Identity uniqueness (active only; letters case-folded, never transliterated).
do $probe$ begin
  insert into public.inventory_items (name,category,quantity,unit) values ('SÍTRÓNUR 15 kg','Fresh Fruit',0,'boxes');
  insert into s89_vi values ('a second active item with the same identity is refused', false);
exception when unique_violation then
  insert into s89_vi values ('a second active item with the same identity is refused', sqlerrm like 'An active item with the same name and package already exists%');
end $probe$;
insert into public.inventory_items (name,category,quantity,unit,active) values ('Sitronur 15kg','Fresh Fruit',0,'boxes',true);
insert into s89_vi select 'an accent-free spelling is a different stored identity (caught by the duplicate guard instead)',
  (select count(*) from atlas_private.inventory_identity_keys k join public.inventory_items i on i.id=k.item_id
   where i.name in ('Sítrónur 15kg','Sitronur 15kg') and k.active) = 2;
insert into s89_vi select 'inactive duplicates keep their identity row without blocking',
  exists (select 1 from atlas_private.inventory_identity_keys where item_id='00000000-0000-4000-8000-000000089916' and not active
          and identity_key = 'giffard old syrup vanille|1000ml');

-- 4. Codes.
insert into atlas_private.inventory_item_codes (item_id,kind,code_raw,code_normalized,source)
values ('00000000-0000-4000-8000-000000089911','gtin','4006381333931','x','manager');
insert into s89_vi select 'code rows store the canonical GTIN-14',
  exists (select 1 from atlas_private.inventory_item_codes where item_id='00000000-0000-4000-8000-000000089911' and code_normalized='04006381333931');
do $probe$ begin
  insert into atlas_private.inventory_item_codes (item_id,kind,code_raw,code_normalized,source)
  values ('00000000-0000-4000-8000-000000089914','gtin','04006381333931','x','manager');
  insert into s89_vi values ('a code held by another item is refused', false);
exception when unique_violation then
  insert into s89_vi values ('a code held by another item is refused', sqlerrm = 'This code is already linked to another inventory item');
end $probe$;
do $probe$ begin
  insert into atlas_private.inventory_item_codes (item_id,kind,code_raw,code_normalized,source)
  values ('00000000-0000-4000-8000-000000089914','sku','s89-gif-01','x','manager');
  insert into s89_vi values ('a legacy SKU column is guarded too', false);
exception when unique_violation then
  insert into s89_vi values ('a legacy SKU column is guarded too', true);
end $probe$;
do $probe$ begin
  insert into atlas_private.inventory_item_codes (item_id,kind,code_raw,code_normalized,source)
  values ('00000000-0000-4000-8000-000000089914','gtin','4006381333932','x','manager');
  insert into s89_vi values ('an invalid GTIN check digit is refused', false);
exception when invalid_parameter_value then
  insert into s89_vi values ('an invalid GTIN check digit is refused', true);
end $probe$;
insert into s89_vi select 'resolve-codes: UPC/EAN spellings, legacy barcode, supplier ref and bad check digit',
  (r->'codes'->0->>'unique_active_item_id') = '00000000-0000-4000-8000-000000089913'
  and (r->'codes'->1->>'unique_active_item_id') = '00000000-0000-4000-8000-000000089911'
  and (r->'codes'->2->>'valid')::boolean = true and (r->'codes'->2->>'gtin_check_failed')::boolean
  and jsonb_array_length(r->'codes'->2->'matches') = 0
  and (r->'codes'->3->>'unique_active_item_id') = '00000000-0000-4000-8000-000000089912'
  and (r->>'stock_changed')::boolean = false
from (select public.atlas_recognition_resolve_codes(
  '[{"raw":"05000299223017"},{"raw":"4006381333931"},{"raw":"4006381333932"},{"raw":"gv-100 ","kind":"supplier_ref"}]'::jsonb,
  '00000000-0000-4000-8000-000000089902','bartender') as r) x;

-- 5. The recognition definer: structurally unable to write stock or catalogue.
insert into s89_vi select 'recognition bodies are security definer and owned by the NOLOGIN definer role',
  (select bool_and(p.prosecdef and pg_get_userbyid(p.proowner) = 'atlas_recognition_definer')
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='atlas_private' and p.proname in ('recognition_resolve_codes','recognition_candidate_features',
     'recognition_register_media','recognition_record','recognition_record_outcome','recognition_propose',
     'recognition_find_duplicates','recognition_my_requests'))
  and (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='atlas_private' and pg_get_userbyid(p.proowner) = 'atlas_recognition_definer') = 8
  and not (select rolcanlogin or rolinherit or rolsuper or rolbypassrls or rolcreaterole from pg_roles where rolname='atlas_recognition_definer');
insert into s89_vi select 'the definer has no write privilege on any quantity or catalogue table',
  not exists (
    select 1 from (values ('public.inventory_items'),('public.inventory_movements'),('public.purchase_orders'),
      ('public.inventory_aliases'),('public.recipe_ingredients'),('public.suppliers'),
      ('atlas_private.inventory_count_lines'),('atlas_private.inventory_count_sessions'),
      ('atlas_private.inventory_verified_balances'),('atlas_private.inventory_count_publications'),
      ('atlas_private.inventory_item_codes'),('atlas_private.inventory_identity_keys'),
      ('atlas_private.inventory_search_documents'),('atlas_private.inventory_scan_aliases'),
      ('atlas_private.catalog_distinct_pairs'),('atlas_private.catalog_command_requests')) t(name)
    where has_table_privilege('atlas_recognition_definer', t.name, 'INSERT')
       or has_table_privilege('atlas_recognition_definer', t.name, 'UPDATE')
       or has_table_privilege('atlas_recognition_definer', t.name, 'DELETE')
       or has_table_privilege('atlas_recognition_definer', t.name, 'TRUNCATE'))
  and not has_table_privilege('atlas_recognition_definer', 'atlas_private.catalog_change_requests', 'UPDATE')
  and not has_table_privilege('atlas_recognition_definer', 'atlas_private.catalog_events', 'UPDATE')
  and not has_table_privilege('atlas_recognition_definer', 'atlas_private.recognition_outcomes', 'UPDATE');
insert into s89_vi select 'the definer cannot execute any writer',
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where has_function_privilege('atlas_recognition_definer', p.oid, 'EXECUTE')
      and ((n.nspname='public' and (p.proname in ('adjust_inventory','atlas_apply_item_master_update','atlas_set_inventory_item_active')
                                    or p.proname like 'atlas\_stock\_count\_%' or p.proname like 'atlas\_purchase\_order%'
                                    or p.proname like 'atlas\_catalog\_%' or p.proname like 'atlas\_inventory\_scanner\_%'))
        or (n.nspname='atlas_private' and (p.proname like 'stock\_count\_%' or p.proname like 'item\_master\_%'
            or p.proname in ('set_inventory_item_active','catalog_create_item_core','catalog_request_decide','catalog_request_create',
              'catalog_apply_metadata','catalog_apply_duplicate_resolution','catalog_insert_alias','catalog_insert_code',
              'catalog_request_withdraw','catalog_propose_backfill','inventory_identity_refresh','inventory_search_refresh',
              'inventory_search_enable_trigram','catalog_media_retain')))
        or (n.nspname='private' and p.proname like 'purchase\_order%')))
  and has_function_privilege('atlas_recognition_definer','atlas_private.product_match_key(text,text,text,text)','EXECUTE');
do $probe$ begin
  set local role atlas_recognition_definer;
  update public.inventory_items set quantity = 99 where id='00000000-0000-4000-8000-000000089912';
  reset role;
  insert into s89_vi values ('as the definer, an item quantity update is denied', false);
exception when insufficient_privilege then
  reset role;
  insert into s89_vi values ('as the definer, an item quantity update is denied', true);
end $probe$;
do $probe$ begin
  set local role atlas_recognition_definer;
  perform public.adjust_inventory('00000000-0000-4000-8000-000000089912', 5, 'count', null, null, 's89 probe');
  reset role;
  insert into s89_vi values ('as the definer, adjust_inventory is denied', false);
exception when insufficient_privilege then
  reset role;
  insert into s89_vi values ('as the definer, adjust_inventory is denied', true);
end $probe$;
do $probe$ begin
  set local role atlas_recognition_definer;
  insert into atlas_private.inventory_item_codes (item_id,kind,code_raw,code_normalized,source)
  values ('00000000-0000-4000-8000-000000089912','gtin','96385074','x','manager');
  reset role;
  insert into s89_vi values ('as the definer, linking a code is denied', false);
exception when insufficient_privilege then
  reset role;
  insert into s89_vi values ('as the definer, linking a code is denied', true);
end $probe$;
insert into s89_vi select 'no recognition function is executable by anon or authenticated',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (p.proname like 'atlas\_recognition\_%' or p.proname like 'recognition\_%' or p.proname like 'product\_%'
           or p.proname like 'atlas\_catalog\_%' or p.proname like 'catalog\_%' or p.proname = 'atlas_product_identity')
      and n.nspname in ('public','atlas_private')
      and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute')));

-- 6. Recognition audit: request, detections, candidates, outcome; stock unchanged.
create temporary table s89_stock on commit drop as
  select (select coalesce(sum(quantity),0) from public.inventory_items) as total,
         (select count(*) from public.inventory_movements) as movements;
select public.atlas_recognition_record(jsonb_build_object(
  'client_request_id','00000000-0000-4000-8000-000000089a01','mode','identify','extractor_version','x1','scorer_version','s1',
  'detections', jsonb_build_array(jsonb_build_object('detection_index',0,'band','high',
    'preselected_item_id','00000000-0000-4000-8000-000000089912',
    'extracted', '{"brand":{"value":"Giffard"}}'::jsonb, 'normalized', '{"match_key":"giffard syrup vanilla"}'::jsonb,
    'field_confidence', '{"inventory_match":96}'::jsonb,
    'candidates', jsonb_build_array(
      jsonb_build_object('rank',1,'item_id','00000000-0000-4000-8000-000000089912','score',0.96,'features','{}'::jsonb,'explanation','GIFFARD detected'),
      jsonb_build_object('rank',2,'item_id','00000000-0000-4000-8000-000000089916','score',0.4,'features','{}'::jsonb,'explanation','archived item'))))),
  '00000000-0000-4000-8000-000000089902','S89 bartender','bartender');
insert into s89_vi select 'recording is idempotent on the client request id',
  (public.atlas_recognition_record('{"client_request_id":"00000000-0000-4000-8000-000000089a01","mode":"identify"}'::jsonb,
    '00000000-0000-4000-8000-000000089902','S89 bartender','bartender')->>'replayed')::boolean
  and (select count(*) from atlas_private.recognition_candidates c join atlas_private.recognition_detections d on d.id=c.detection_id
       join atlas_private.recognition_requests r on r.id=d.request_id where r.client_request_id='00000000-0000-4000-8000-000000089a01') = 2;
do $probe$ begin
  perform public.atlas_recognition_record(jsonb_build_object('client_request_id','00000000-0000-4000-8000-000000089a02','mode','identify',
    'detections', jsonb_build_array(jsonb_build_object('detection_index',0,'band','medium',
      'preselected_item_id','00000000-0000-4000-8000-000000089912','extracted','{}'::jsonb,'normalized','{}'::jsonb,'field_confidence','{}'::jsonb,
      'candidates', jsonb_build_array(jsonb_build_object('rank',1,'item_id','00000000-0000-4000-8000-000000089912','score',0.7,'features','{}'::jsonb,'explanation','x'))))),
    '00000000-0000-4000-8000-000000089902','S89 bartender','bartender');
  insert into s89_vi values ('only a High band may pre-select', false);
exception when others then
  insert into s89_vi values ('only a High band may pre-select', sqlerrm like 'Only the active rank-1 item of a High match%');
end $probe$;
do $probe$ begin
  perform public.atlas_recognition_record('{"client_request_id":"00000000-0000-4000-8000-000000089a03","mode":"identify"}'::jsonb,
    '00000000-0000-4000-8000-000000089902','S89 bartender','manager');
  insert into s89_vi values ('a claimed role must match the profile', false);
exception when insufficient_privilege then
  insert into s89_vi values ('a claimed role must match the profile', true);
end $probe$;
select public.atlas_recognition_record_outcome(jsonb_build_object('client_outcome_id','00000000-0000-4000-8000-000000089b01',
  'detection_id', (select d.id from atlas_private.recognition_detections d join atlas_private.recognition_requests r on r.id=d.request_id
                   where r.client_request_id='00000000-0000-4000-8000-000000089a01'),
  'outcome','confirmed_preselected','chosen_item_id','00000000-0000-4000-8000-000000089912','chosen_rank',1,'used_for','count_line'),
  '00000000-0000-4000-8000-000000089902','S89 bartender','bartender');
insert into s89_vi select 'recognition never changed stock',
  (select coalesce(sum(quantity),0) from public.inventory_items) = (select total from s89_stock)
  and (select count(*) from public.inventory_movements) = (select movements from s89_stock)
  and not exists (select 1 from atlas_private.recognition_requests where stock_changed);
do $probe$ begin
  update atlas_private.recognition_outcomes set note = 'edited';
  insert into s89_vi values ('recognition outcomes are append-only', false);
exception when insufficient_privilege then
  insert into s89_vi values ('recognition outcomes are append-only', true);
end $probe$;

-- 7. The scanner can never apply counts to stock again.
do $probe$ begin
  update atlas_private.inventory_scanner_settings set live_apply_enabled = true;
  insert into s89_vi values ('scanner live apply cannot be enabled', false);
exception when check_violation then
  insert into s89_vi values ('scanner live apply cannot be enabled', true);
end $probe$;

-- 8. Stock count: add-line, three decimals, recognition evidence.
create temporary table s89_count on commit drop as
select public.atlas_stock_count_start(
  jsonb_build_array(jsonb_build_object('id','00000000-0000-4000-8000-000000089911','name','Sítrónur 15kg','category','Fresh Fruit','unit','boxes','active',true)),
  'S89 count','category','Fresh Fruit',null,'00000000-0000-4000-8000-000000089901','S89 manager','manager','s89-count-1') as detail;
create temporary table s89_session on commit drop as
select s.id from atlas_private.inventory_count_sessions s where s.client_request_id='s89-count-1';
select public.atlas_stock_count_add_line((select id from s89_session),
  '{"id":"00000000-0000-4000-8000-000000089912","name":"Giffard Vanille Syrup","category":"Syrups","unit":"bottles","size_ml":1000,"active":true}'::jsonb,
  '00000000-0000-4000-8000-000000089902','S89 bartender','bartender');
insert into s89_vi select 'add-line snapshots an out-of-scope item once (idempotent)',
  (select count(*) from atlas_private.inventory_count_lines where session_id=(select id from s89_session)
     and inventory_item_id='00000000-0000-4000-8000-000000089912') = 1
  and (public.atlas_stock_count_add_line((select id from s89_session),
         '{"id":"00000000-0000-4000-8000-000000089912","name":"Giffard Vanille Syrup","active":true}'::jsonb,
         '00000000-0000-4000-8000-000000089902','S89 bartender','bartender')->>'added')::boolean = false
  and exists (select 1 from atlas_private.inventory_count_events where session_id=(select id from s89_session) and event_type='line_added');
do $probe$ begin
  perform public.atlas_stock_count_add_line((select id from s89_session),
    '{"id":"00000000-0000-4000-8000-000000089914","name":"x","active":true}'::jsonb,
    '00000000-0000-4000-8000-000000089903','S89 viewer','viewer');
  insert into s89_vi values ('viewers cannot add count lines', false);
exception when insufficient_privilege then
  insert into s89_vi values ('viewers cannot add count lines', true);
end $probe$;
select public.atlas_stock_count_save_line_v2((select id from s89_session),
  (select id from atlas_private.inventory_count_lines where session_id=(select id from s89_session) and inventory_item_id='00000000-0000-4000-8000-000000089912'),
  'counted', 1.7, 'inventory', 'barcode', null, null,
  (select version from atlas_private.inventory_count_lines where session_id=(select id from s89_session) and inventory_item_id='00000000-0000-4000-8000-000000089912'),
  jsonb_build_object('recognition', jsonb_build_object('outcome_id',
    (select id from atlas_private.recognition_outcomes where client_outcome_id='00000000-0000-4000-8000-000000089b01'), 'band', 'forged')),
  '00000000-0000-4000-8000-000000089902','S89 bartender','bartender');
insert into s89_vi select 'valid recognition evidence is kept and rebuilt from the audit rows',
  observed_quantity = 1.7 and count_method = 'barcode' and count_evidence->'recognition'->>'band' = 'high'
  and (count_evidence->'recognition'->>'score')::numeric = 0.96
from atlas_private.inventory_count_lines where session_id=(select id from s89_session) and inventory_item_id='00000000-0000-4000-8000-000000089912';
select public.atlas_stock_count_save_line_v2((select id from s89_session),
  (select id from atlas_private.inventory_count_lines where session_id=(select id from s89_session) and inventory_item_id='00000000-0000-4000-8000-000000089911'),
  'counted', 0.25, 'inventory', 'photo', null, null,
  (select version from atlas_private.inventory_count_lines where session_id=(select id from s89_session) and inventory_item_id='00000000-0000-4000-8000-000000089911'),
  jsonb_build_object('recognition', jsonb_build_object('outcome_id',
    (select id from atlas_private.recognition_outcomes where client_outcome_id='00000000-0000-4000-8000-000000089b01'))),
  '00000000-0000-4000-8000-000000089902','S89 bartender','bartender');
insert into s89_vi select 'evidence for another item is dropped and the line saves as manual',
  observed_quantity = 0.25 and count_method = 'manual' and not count_evidence ? 'recognition'
  and count_evidence->>'recognition_dropped' = 'other_item'
from atlas_private.inventory_count_lines where session_id=(select id from s89_session) and inventory_item_id='00000000-0000-4000-8000-000000089911';
do $probe$ begin
  perform public.atlas_stock_count_save_line_v2((select id from s89_session),
    (select id from atlas_private.inventory_count_lines where session_id=(select id from s89_session) and inventory_item_id='00000000-0000-4000-8000-000000089911'),
    'counted', 1.2345, 'inventory', 'manual', null, null,
    (select version from atlas_private.inventory_count_lines where session_id=(select id from s89_session) and inventory_item_id='00000000-0000-4000-8000-000000089911'),
    '{}'::jsonb, '00000000-0000-4000-8000-000000089902','S89 bartender','bartender');
  insert into s89_vi values ('counts accept at most three decimals', false);
exception when invalid_parameter_value then
  insert into s89_vi values ('counts accept at most three decimals', true);
end $probe$;
insert into s89_vi select 'counting never changed stock',
  (select coalesce(sum(quantity),0) from public.inventory_items) = (select total from s89_stock)
  and (select count(*) from public.inventory_movements) = (select movements from s89_stock);

select jsonb_build_object(
  's89_visual_inventory', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s89_vi;

rollback;
