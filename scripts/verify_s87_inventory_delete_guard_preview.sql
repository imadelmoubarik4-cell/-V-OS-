-- S87 preview-only inventory delete guard acceptance. Rolled back.

begin;

create temporary table s87_inventory (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s87_inventory to authenticated;
create role s87_inventory_probe nologin;
grant authenticated to s87_inventory_probe;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000087601','authenticated','authenticated','s87-inv-mgr@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
update public.profiles set role='manager', active=true where id='00000000-0000-4000-8000-000000087601';

insert into public.inventory_items (id,name,category,quantity,unit,active) values
  ('00000000-0000-4000-8000-000000087701','S87 linked item','Test',0,'bottles',true),
  ('00000000-0000-4000-8000-000000087702','S87 unused item','Test',0,'bottles',true);
insert into public.recipes (id,name,active) values ('00000000-0000-4000-8000-000000087801','S87 recipe',true);
insert into public.recipe_ingredients (recipe_id,item_id,item_name,quantity,unit) values ('00000000-0000-4000-8000-000000087801','00000000-0000-4000-8000-000000087701','S87 linked item',1,'bottles');

set session authorization s87_inventory_probe;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000087601',true);

do $probe$
declare blocked boolean := false;
begin
  begin
    delete from public.inventory_items where id='00000000-0000-4000-8000-000000087701';
  exception when insufficient_privilege then blocked := true;
  end;
  insert into s87_inventory values ('manager cannot delete an item with recipe links', blocked);

  -- Before S89 20260928095000 a manager may deactivate with a direct update;
  -- after it browsers have no direct UPDATE and deactivation goes through
  -- atlas_set_inventory_item_active (checked below as the server).
  blocked := false;
  begin
    update public.inventory_items set active=false where id='00000000-0000-4000-8000-000000087701';
  exception when insufficient_privilege then blocked := true;
  end;
  insert into s87_inventory values ('a direct deactivation follows the UPDATE grant',
    blocked = not has_table_privilege('authenticated', 'public.inventory_items', 'update'));

  delete from public.inventory_items where id='00000000-0000-4000-8000-000000087702';
  insert into s87_inventory values ('an unused item can still be deleted', not exists (select 1 from public.inventory_items where id='00000000-0000-4000-8000-000000087702'));
end
$probe$;

reset role;
reset session authorization;

select public.atlas_set_inventory_item_active('00000000-0000-4000-8000-000000087701', false, 'S87 acceptance', null, '00000000-0000-4000-8000-000000087601', 'S87 manager');
insert into s87_inventory values ('manager can deactivate it through the governed command', exists (select 1 from public.inventory_items where id='00000000-0000-4000-8000-000000087701' and active=false));

insert into s87_inventory values ('recipe link survived', exists (select 1 from public.recipe_ingredients where recipe_id='00000000-0000-4000-8000-000000087801' and item_id='00000000-0000-4000-8000-000000087701'));

select jsonb_build_object(
  's87_inventory_delete_guard', case when bool_and(passed) then 'passed' else 'failed' end,
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s87_inventory;

rollback;
