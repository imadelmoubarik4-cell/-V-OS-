-- S90g preview-only acceptance: item-master publication through the private
-- definer (20260930090000_s90g_item_master_update_definer.sql). Rolled back.
--
-- Runs after the release-gated revokes (replay order), exactly as production
-- will be once the rollout is complete:
-- * a signed-in manager (role authenticated) publishes item-master fields
--   through public.atlas_apply_item_master_update although authenticated can
--   no longer UPDATE public.inventory_items directly;
-- * a bartender is refused with 42501 and nothing changes;
-- * anon cannot execute it; the private definer is not callable by anon;
-- * the security gate recognises the wrapper as a reviewed browser RPC.

begin;

create temporary table s90g_im (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s90g_im to public;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-0000000a9f01','s90g-mgr@example.invalid'),
  ('00000000-0000-4000-8000-0000000a9f02','s90g-bar@example.invalid')) as u(id, email);
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-0000000a9f01','s90g-mgr@example.invalid','S90g manager','manager',true),
  ('00000000-0000-4000-8000-0000000a9f02','s90g-bar@example.invalid','S90g bartender','bartender',true)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;
insert into public.inventory_items (id,name,category,unit,active,quantity,par_level,cost_price) values
  ('00000000-0000-4000-8000-0000000a9f11','S90g Peach Syrup','Syrups','bottles',true,3,4,1900);

create temporary table s90g_expected on commit drop as
  select jsonb_build_object('par_level',par_level,'critical_minimum',critical_minimum,'supplier_id',supplier_id,'supplier',supplier,
     'supplier_product_reference',supplier_product_reference,'units_per_case',units_per_case,'size_ml',size_ml,
     'package_weight_g',package_weight_g,'package_size',package_size,'cost_price',cost_price,'case_cost',case_cost,
     'bin_location',bin_location,'lead_time_days',lead_time_days,'minimum_order_quantity',minimum_order_quantity) as expected
  from public.inventory_items where id='00000000-0000-4000-8000-0000000a9f11';
grant select on table s90g_expected to public;

insert into s90g_im select 'the wrapper is an invoker with search_path pinned; the body is a private definer',
  not p.prosecdef and coalesce('search_path=""' = any(p.proconfig), false)
  and i.prosecdef and coalesce('search_path=""' = any(i.proconfig), false)
  and i.pronamespace = 'private'::regnamespace
  from pg_proc p, pg_proc i
  where p.oid = to_regprocedure('public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text)')
    and i.oid = to_regprocedure('private.apply_item_master_update(uuid,jsonb,uuid[],jsonb,text)');
insert into s90g_im select 'authenticated may execute the wrapper; anon may execute neither function',
  has_function_privilege('authenticated','public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text)','execute')
  and not has_function_privilege('anon','public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text)','execute')
  and not has_function_privilege('anon','private.apply_item_master_update(uuid,jsonb,uuid[],jsonb,text)','execute');
insert into s90g_im select 'authenticated cannot UPDATE inventory_items directly (release-gated revoke applied)',
  not has_table_privilege('authenticated','public.inventory_items','update');

-- ---------- the manager browser session (atlas-item-master forwards the manager token) ----------
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true),
       set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000a9f01',true),
       set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-0000000a9f01","role":"authenticated"}',true);
do $manager$
declare
  result jsonb;
begin
  result := public.atlas_apply_item_master_update('00000000-0000-4000-8000-0000000a9f11',
    '{"par_level":6,"cost_price":2100}', '{}', (select expected from s90g_expected), 's90g-im-1');
  insert into s90g_im values ('a manager publishes item-master fields without UPDATE on inventory_items',
    result is not null and coalesce((result->>'quantity_mutated')::boolean, false) = false);
exception when others then
  insert into s90g_im values ('a manager publishes item-master fields without UPDATE on inventory_items', false);
  raise notice 's90g manager publish failed: % %', sqlstate, sqlerrm;
end
$manager$;

-- ---------- a bartender session ----------
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000a9f02',true),
       set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-0000000a9f02","role":"authenticated"}',true);
do $bartender$
declare
  refused boolean := false;
begin
  begin
    perform public.atlas_apply_item_master_update('00000000-0000-4000-8000-0000000a9f11',
      '{"par_level":99}', '{}', '{}'::jsonb, 's90g-im-2');
  exception when others then refused := sqlstate = '42501';
  end;
  insert into s90g_im values ('a bartender is refused with 42501', refused);
end
$bartender$;
reset role;
select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claims','',true), set_config('request.jwt.claim.role','',true);

insert into s90g_im select 'the manager change landed and the bartender attempt changed nothing',
  par_level = 6 and cost_price = 2100 and quantity = 3
  from public.inventory_items where id='00000000-0000-4000-8000-0000000a9f11';

select jsonb_build_object(
  's90g_item_master_definer', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s90g_im;

rollback;
