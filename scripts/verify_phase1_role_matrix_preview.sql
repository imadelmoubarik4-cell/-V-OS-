-- Phase 1 preview-only role acceptance.
--
-- This script requires an empty isolated Supabase branch. It creates temporary
-- Auth/profile/catalog fixtures inside one transaction, exercises the anon,
-- bartender, admin, inactive and unlisted boundaries, reports a JSON result,
-- and rolls everything back. It must never be used as a production data test.

begin;

do $preview_only$
begin
  if exists (select 1 from auth.users where deleted_at is null)
     or exists (select 1 from public.profiles)
     or exists (select 1 from public.inventory_items)
     or exists (select 1 from public.inventory_movements) then
    raise exception 'Phase 1 role-matrix fixtures require an empty isolated preview branch';
  end if;
end
$preview_only$;

create temporary table phase1_role_acceptance (
  test_name text primary key,
  passed boolean not null,
  detail text not null
) on commit drop;
grant all on table phase1_role_acceptance to anon, authenticated;

insert into auth.users (
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
)
select instance_id,user_id,'authenticated','authenticated',email,'',now(),
       '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from (
  values
    ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000000001'::uuid,'phase1-admin@example.invalid'),
    ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000000002'::uuid,'phase1-bartender@example.invalid'),
    ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000000003'::uuid,'phase1-inactive@example.invalid')
) as seed(instance_id,user_id,email);

update public.profiles
set display_name='Phase 1 admin',role='admin',active=true
where id='00000000-0000-4000-8000-000000000001';
update public.profiles
set display_name='Phase 1 bartender',role='bartender',active=true
where id='00000000-0000-4000-8000-000000000002';
update public.profiles
set display_name='Phase 1 inactive',role='viewer',active=false
where id='00000000-0000-4000-8000-000000000003';

insert into public.inventory_items (
  id,name,category,quantity,unit,par_level,cost_price,case_cost,supplier,active
) values (
  '00000000-0000-4000-8000-000000000101','Phase 1 acceptance item','Test',7,'bottles',10,1234,7404,'Private acceptance supplier',true
);
insert into public.suppliers (id,name,active)
values ('00000000-0000-4000-8000-000000000301','Private acceptance supplier',true);
insert into public.recipes (
  id,name,type,yield_quantity,yield_unit,menu_price,show_on_menu,active
) values (
  '00000000-0000-4000-8000-000000000201','Phase 1 public test drink','test',1,'serving',2990,true,true
);

insert into phase1_role_acceptance
select 'anon_public_menu_grant',has_table_privilege('anon','public.public_menu','select'),
       'Anonymous role retains SELECT only on the deliberate public menu projection.';
insert into phase1_role_acceptance
select 'anon_inventory_catalog_denied',not has_table_privilege('anon','public.inventory_catalog','select'),
       'Anonymous role has no SELECT grant on the staff inventory catalogue.';
insert into phase1_role_acceptance
select 'anon_inventory_table_denied',not has_table_privilege('anon','public.inventory_items','select'),
       'Anonymous role has no direct inventory table SELECT grant.';

set local role anon;
select set_config('request.jwt.claim.role','anon',true);
select set_config('request.jwt.claim.sub','',true);
insert into phase1_role_acceptance
select 'logged_out_public_menu_reads',count(*)=1,
       format('Logged-out public menu rows for the acceptance fixture: %s.',count(*))
from public.public_menu
where id='00000000-0000-4000-8000-000000000201';
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
insert into phase1_role_acceptance
select 'bartender_active_profile',private.is_active_staff() and not private.is_manager_or_admin(),
       'Active bartender is recognized as staff but not as manager/admin.';
insert into phase1_role_acceptance
select 'bartender_redacted_inventory_reads',count(*)=1,
       format('Bartender-visible redacted inventory rows: %s.',count(*))
from public.inventory_catalog
where id='00000000-0000-4000-8000-000000000101';
insert into phase1_role_acceptance
select 'bartender_cost_table_hidden',count(*)=0,
       format('Bartender-visible canonical inventory rows: %s.',count(*))
from public.inventory_items
where id='00000000-0000-4000-8000-000000000101';
insert into phase1_role_acceptance
select 'bartender_recipe_catalog_reads',count(*)=1,
       format('Bartender-visible redacted recipe rows: %s.',count(*))
from public.recipe_catalog
where id='00000000-0000-4000-8000-000000000201';
with changed as (
  update public.inventory_items set cost_price=cost_price
  where id='00000000-0000-4000-8000-000000000101'
  returning id
)
insert into phase1_role_acceptance
select 'bartender_direct_update_denied',count(*)=0,
       format('Rows reachable by bartender UPDATE policy: %s.',count(*))
from changed;
with removed as (
  delete from public.inventory_items
  where id='00000000-0000-4000-8000-000000000101'
  returning id
)
insert into phase1_role_acceptance
select 'bartender_direct_delete_denied',count(*)=0,
       format('Rows reachable by bartender DELETE policy: %s.',count(*))
from removed;
insert into phase1_role_acceptance
select 'bartender_stock_summary_reads',count(*)>=0,
       'Bartender can query the redacted stock-count summary without manager evidence columns.'
from public.stock_count_summary;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
insert into phase1_role_acceptance
select 'admin_active_manager',private.is_active_staff() and private.is_manager_or_admin(),
       'Active admin is recognized as manager/admin.';
insert into phase1_role_acceptance
select 'admin_commercial_inventory_reads',count(*)=1,
       format('Admin-visible canonical inventory rows: %s.',count(*))
from public.inventory_items
where id='00000000-0000-4000-8000-000000000101' and cost_price=1234 and case_cost=7404;
insert into phase1_role_acceptance
select 'admin_supplier_reads',count(*)=1,
       format('Admin-visible supplier rows: %s.',count(*))
from public.suppliers
where id='00000000-0000-4000-8000-000000000301';
insert into phase1_role_acceptance
select 'admin_recipe_reads',count(*)=1,
       format('Admin-visible canonical recipe rows: %s.',count(*))
from public.recipes
where id='00000000-0000-4000-8000-000000000201';
insert into phase1_role_acceptance
select 'admin_manager_stock_summary_reads',count(*)>=0,
       'Admin can query the manager stock-count evidence summary.'
from public.stock_count_manager_summary;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
insert into phase1_role_acceptance
select 'inactive_profile_denied',count(*)=0,
       format('Inactive-profile inventory catalogue rows: %s.',count(*))
from public.inventory_catalog;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000099',true);
insert into phase1_role_acceptance
select 'unlisted_authenticated_denied',count(*)=0,
       format('Unlisted authenticated inventory catalogue rows: %s.',count(*))
from public.inventory_catalog;
reset role;

select jsonb_build_object(
  'rolled_back',true,
  'passed',bool_and(passed),
  'passed_count',count(*) filter (where passed),
  'failed_count',count(*) filter (where not passed),
  'tests',jsonb_agg(
    jsonb_build_object('test',test_name,'passed',passed,'detail',detail)
    order by test_name
  )
) as phase1_role_acceptance
from phase1_role_acceptance;

rollback;
