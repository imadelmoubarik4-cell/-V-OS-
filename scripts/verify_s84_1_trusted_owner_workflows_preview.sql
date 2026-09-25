-- S84.1 preview-only trusted owner workflow acceptance.
--
-- Requires an empty isolated replay database. Seeds temporary fixtures in one
-- transaction, exercises trusted-server, manager-browser and staff-browser
-- paths for the owner prep and owner count workflows, reports a JSON result,
-- and rolls everything back.

begin;

do $preview_only$
begin
  if exists (select 1 from auth.users where deleted_at is null)
     or exists (select 1 from public.profiles)
     or exists (select 1 from public.inventory_items)
     or exists (select 1 from public.inventory_movements) then
    raise exception 'S84.1 fixtures require an empty isolated preview branch';
  end if;
end
$preview_only$;

create temporary table s841_acceptance (
  test_name text primary key,
  passed boolean not null,
  detail text not null
) on commit drop;
grant all on table s841_acceptance to authenticated;

create role s841_browser_probe nologin;
grant authenticated to s841_browser_probe;

insert into auth.users (
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
)
select instance_id,user_id,'authenticated','authenticated',email,'',now(),
       '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from (
  values
    ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000084101'::uuid,'s841-manager@example.invalid'),
    ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000084102'::uuid,'s841-bartender@example.invalid')
) as seed(instance_id,user_id,email);

update public.profiles set display_name='S84.1 manager',role='manager',active=true where id='00000000-0000-4000-8000-000000084101';
update public.profiles set display_name='S84.1 bartender',role='bartender',active=true where id='00000000-0000-4000-8000-000000084102';

-- Trusted owner workflows.
insert into public.inventory_items (id,name,category,quantity,unit,active,source_type,source_confidence) values
  ('00000000-0000-4000-8000-000000084201','S84.1 orange juice','Prep',0,'liters',true,'owner_confirmed_prep',100),
  ('00000000-0000-4000-8000-000000084202','S84.1 infused tequila','Prep',1,'ml',true,'owner_confirmed_prep',100),
  ('00000000-0000-4000-8000-000000084203','S84.1 green tea','Tea',11,'boxes',true,'owner_verified_count',100),
  ('00000000-0000-4000-8000-000000084204','S84.1 unverified','Other',3,'units',true,'owner_approved_unverified_stock',100),
  ('00000000-0000-4000-8000-000000084205','S84.1 low confidence prep','Prep',2,'liters',true,'owner_confirmed_prep',90);

insert into s841_acceptance
select 'trusted_owner_workflows_are_stamped',
       count(*) filter (where source_confirmed_at is not null and source_confirmed_quantity = quantity) = 3,
       'owner_confirmed_prep and owner_verified_count rows carry evidence, including a confirmed zero.'
from public.inventory_items
where id in ('00000000-0000-4000-8000-000000084201','00000000-0000-4000-8000-000000084202','00000000-0000-4000-8000-000000084203');

insert into s841_acceptance
select 'untrusted_workflows_are_not_stamped',
       count(*) filter (where source_confirmed_at is null and source_confirmed_quantity is null) = 2,
       'Unverified or low-confidence owner rows carry no evidence.'
from public.inventory_items
where id in ('00000000-0000-4000-8000-000000084204','00000000-0000-4000-8000-000000084205');

do $trusted_untrusted$
begin
  begin
    update public.inventory_items set source_confirmed_at=now(),source_confirmed_quantity=3
    where id='00000000-0000-4000-8000-000000084204';
    insert into s841_acceptance values ('evidence_requires_trusted_workflow',false,'Evidence was written on an untrusted workflow.');
  exception when insufficient_privilege then
    insert into s841_acceptance values ('evidence_requires_trusted_workflow',true,'Rejected with 42501 even for a trusted server.');
  end;
end
$trusted_untrusted$;

create temporary table s841_before on commit drop as
select id,source_confirmed_at,source_confirmed_quantity from public.inventory_items;
grant select on table s841_before to authenticated;

-- Manager browser path.
set session authorization s841_browser_probe;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000084101',true);

-- S89 20260928095000 revokes browser UPDATE on inventory_items; the edit is
-- then refused (42501) and the checks below hold with nothing changed.
do $s841_master_edit$
begin
  update public.inventory_items set par_level=5,category='Prep batches',cost_price=100
  where id='00000000-0000-4000-8000-000000084201';
exception when insufficient_privilege then null;
end
$s841_master_edit$;
insert into s841_acceptance
select 'manager_master_edit_keeps_prep_confirmation',
       item.source_confirmed_at = before.source_confirmed_at and item.source_confirmed_quantity = before.source_confirmed_quantity,
       'Par, category and cost edits do not re-date owner prep evidence.'
from public.inventory_items item join s841_before before using (id)
where item.id='00000000-0000-4000-8000-000000084201';

do $manager_direct$
begin
  begin
    update public.inventory_items set source_confirmed_quantity=50
    where id='00000000-0000-4000-8000-000000084203';
    insert into s841_acceptance values ('manager_cannot_write_owner_count_evidence',false,'Manager changed owner count evidence.');
  exception when insufficient_privilege then
    insert into s841_acceptance values ('manager_cannot_write_owner_count_evidence',true,'Rejected with 42501.');
  end;
end
$manager_direct$;

-- S89 20260928095000 revokes browser UPDATE on inventory_items; the edit is
-- then refused (42501) and the checks below hold with nothing changed.
do $s841_promote_edit$
begin
  update public.inventory_items set source_type='owner_verified_count',source_confidence=100
  where id='00000000-0000-4000-8000-000000084204';
exception when insufficient_privilege then null;
end
$s841_promote_edit$;
insert into s841_acceptance
select 'manager_cannot_promote_row_to_owner_count',
       source_confirmed_at is null and source_confirmed_quantity is null,
       'Changing source metadata from the browser creates no stock evidence.'
from public.inventory_items where id='00000000-0000-4000-8000-000000084204';

-- Staff browser path.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000084102',true);
insert into s841_acceptance
select 'staff_catalog_exposes_prep_and_count_baselines',
       count(*) filter (where id='00000000-0000-4000-8000-000000084201' and owner_confirmed_quantity=0 and owner_confirmed_at is not null)=1
       and count(*) filter (where id='00000000-0000-4000-8000-000000084202' and owner_confirmed_quantity=1)=1
       and count(*) filter (where id='00000000-0000-4000-8000-000000084203' and owner_confirmed_quantity=11)=1
       and count(*) filter (where id in ('00000000-0000-4000-8000-000000084204','00000000-0000-4000-8000-000000084205') and owner_confirmed_at is null)=2,
       'Staff see the same evidence managers reconcile from.'
from public.inventory_catalog;

insert into s841_acceptance
select 'staff_catalog_hides_source_metadata',
       not exists (
         select 1 from information_schema.columns
         where table_schema='public' and table_name='inventory_catalog'
           and column_name in ('source_type','source_confidence','source_hash','source_file','source_confirmed_at','source_confirmed_quantity','cost_price','case_cost','supplier','supplier_id','notes','import_note')
       ),
       'Staff see owner_confirmed_* only.';

reset role;
reset session authorization;

update public.inventory_items set source_confirmed_at=null,source_confirmed_quantity=null
where id='00000000-0000-4000-8000-000000084202';
insert into s841_acceptance
select 'trusted_server_can_revoke_evidence',
       source_confirmed_at is null and source_confirmed_quantity is null,
       'Trusted server paths may clear evidence.'
from public.inventory_items where id='00000000-0000-4000-8000-000000084202';

insert into s841_acceptance
select 'inventory_catalog_stays_security_invoker',
       coalesce('security_invoker=true' = any(reloptions),false),
       'public.inventory_catalog keeps security_invoker = true.'
from pg_class where oid='public.inventory_catalog'::regclass;

insert into s841_acceptance
select 'trust_helper_not_callable_by_clients',
       not has_function_privilege('anon','private.is_trusted_owner_stock_source(text,numeric)','execute')
       and not has_function_privilege('authenticated','private.is_trusted_owner_stock_source(text,numeric)','execute'),
       'The workflow allow-list is not granted to browser roles.';

do $verdict$
begin
  if exists (select 1 from s841_acceptance where not passed) then
    raise exception 'S84.1 acceptance failed: %',
      (select jsonb_agg(to_jsonb(row_data)) from s841_acceptance row_data where not passed);
  end if;
end
$verdict$;

select jsonb_build_object(
  'rolled_back',true,
  's84_1_trusted_owner_workflows','passed',
  'tests',(select jsonb_agg(test_name order by test_name) from s841_acceptance)
);

rollback;
