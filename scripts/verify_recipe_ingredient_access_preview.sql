-- Empty isolated staging/CI only. All fixtures roll back, including on failure.
begin;
do $empty_preview$
begin
 if exists (select 1 from auth.users) or exists (select 1 from public.profiles)
 or exists (select 1 from public.recipes) or exists (select 1 from public.recipe_ingredients) then
   raise exception 'Recipe access test requires an empty isolated preview';
 end if;
end
$empty_preview$;
create temporary table recipe_access_results(test text primary key, passed boolean not null) on commit drop;
grant select, insert on recipe_access_results to authenticated;
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
values
('00000000-0000-4000-9000-000000000001','authenticated','authenticated','recipe-admin@example.invalid','{}','{}'),
('00000000-0000-4000-9000-000000000002','authenticated','authenticated','recipe-manager@example.invalid','{}','{}'),
('00000000-0000-4000-9000-000000000003','authenticated','authenticated','recipe-bartender@example.invalid','{}','{}'),
('00000000-0000-4000-9000-000000000004','authenticated','authenticated','recipe-viewer@example.invalid','{}','{}'),
('00000000-0000-4000-9000-000000000005','authenticated','authenticated','recipe-inactive@example.invalid','{}','{}');
update public.profiles set role='admin',active=true where id='00000000-0000-4000-9000-000000000001';
update public.profiles set role='manager',active=true where id='00000000-0000-4000-9000-000000000002';
update public.profiles set role='bartender',active=true where id='00000000-0000-4000-9000-000000000003';
update public.profiles set role='viewer',active=true where id='00000000-0000-4000-9000-000000000004';
update public.profiles set role='viewer',active=false where id='00000000-0000-4000-9000-000000000005';
insert into public.recipes(id,name,type,show_on_menu,active)
values('00000000-0000-4000-9000-000000000101','Recipe access fixture','test',false,true);
insert into public.recipe_ingredients(id,recipe_id,item_name,quantity,unit)
values('00000000-0000-4000-9000-000000000201','00000000-0000-4000-9000-000000000101','Operational ingredient',2,'ml');
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000001',true);
insert into recipe_access_results
select 'admin_canonical_ingredients',count(*)=1
from public.recipe_ingredients where id='00000000-0000-4000-9000-000000000201';
insert into recipe_access_results
select 'admin_catalogue_ingredients',count(*)=1
from public.recipe_catalog
where id='00000000-0000-4000-9000-000000000101'
  and jsonb_array_length(recipe_ingredients)=1
  and recipe_ingredients->0->>'item_name'='Operational ingredient';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000002',true);
insert into recipe_access_results
select 'manager_canonical_ingredients',count(*)=1
from public.recipe_ingredients where id='00000000-0000-4000-9000-000000000201';
insert into recipe_access_results
select 'manager_catalogue_ingredients',count(*)=1
from public.recipe_catalog
where id='00000000-0000-4000-9000-000000000101'
  and jsonb_array_length(recipe_ingredients)=1
  and recipe_ingredients->0->>'item_name'='Operational ingredient';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000003',true);
insert into recipe_access_results
select 'bartender_canonical_ingredients',count(*)=0
from public.recipe_ingredients where id='00000000-0000-4000-9000-000000000201';
insert into recipe_access_results
select 'bartender_catalogue_ingredients',count(*)=1
from public.recipe_catalog
where id='00000000-0000-4000-9000-000000000101'
  and jsonb_array_length(recipe_ingredients)=1
  and recipe_ingredients->0->>'item_name'='Operational ingredient';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000004',true);
insert into recipe_access_results
select 'viewer_canonical_ingredients',count(*)=0
from public.recipe_ingredients where id='00000000-0000-4000-9000-000000000201';
insert into recipe_access_results
select 'viewer_catalogue_ingredients',count(*)=1
from public.recipe_catalog
where id='00000000-0000-4000-9000-000000000101'
  and jsonb_array_length(recipe_ingredients)=1
  and recipe_ingredients->0->>'item_name'='Operational ingredient';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000005',true);
insert into recipe_access_results
select 'inactive_canonical_ingredients',count(*)=0
from public.recipe_ingredients where id='00000000-0000-4000-9000-000000000201';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000000099',true);
insert into recipe_access_results
select 'unlisted_canonical_ingredients',count(*)=0
from public.recipe_ingredients where id='00000000-0000-4000-9000-000000000201';
reset role;
insert into recipe_access_results values
 ('anon_canonical_grant_denied',not has_table_privilege('anon','public.recipe_ingredients','select')),
 ('duplicate_index_removed',to_regclass('public.recipe_ingredients_recipe_idx') is null),
 ('recipe_lookup_index_retained',to_regclass('public.recipe_ingredients_recipe_id_idx') is not null);
insert into recipe_access_results
select 'one_manager_read_policy',count(*)=1 and bool_and(policyname='active managers read recipe ingredients')
from pg_policies where schemaname='public' and tablename='recipe_ingredients' and cmd in ('SELECT','ALL');
do $assert_recipe_access$
begin
 if exists(select 1 from recipe_access_results where not passed) then
   raise exception 'Recipe access regression: %',
     (select string_agg(test, ', ' order by test) from recipe_access_results where not passed);
 end if;
end
$assert_recipe_access$;
select jsonb_build_object('passed',bool_and(passed),'passed_count',count(*) filter(where passed),
 'failed_count',count(*) filter(where not passed),'rolled_back',true,
 'tests',jsonb_agg(to_jsonb(result) order by test)) as recipe_access_acceptance
from recipe_access_results result;
rollback;
