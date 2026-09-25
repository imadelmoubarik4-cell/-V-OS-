-- S84 preview-only owner-confirmation acceptance.
--
-- Requires an empty isolated replay database. Seeds temporary fixtures in one
-- transaction, exercises trusted-server, manager-browser and staff-browser
-- paths, reports a JSON result, and rolls everything back. Browser paths run
-- under a temporary session_user so the trusted-server shortcut is not taken.

begin;

do $preview_only$
begin
  if exists (select 1 from auth.users where deleted_at is null)
     or exists (select 1 from public.profiles)
     or exists (select 1 from public.inventory_items)
     or exists (select 1 from public.inventory_movements) then
    raise exception 'S84 owner-confirmation fixtures require an empty isolated preview branch';
  end if;
end
$preview_only$;

create temporary table s84_acceptance (
  test_name text primary key,
  passed boolean not null,
  detail text not null
) on commit drop;
grant all on table s84_acceptance to authenticated;

create role s84_browser_probe nologin;
grant authenticated to s84_browser_probe;

insert into auth.users (
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
)
select instance_id,user_id,'authenticated','authenticated',email,'',now(),
       '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from (
  values
    ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000008401'::uuid,'s84-manager@example.invalid'),
    ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000008402'::uuid,'s84-bartender@example.invalid')
) as seed(instance_id,user_id,email);

update public.profiles set display_name='S84 manager',role='manager',active=true where id='00000000-0000-4000-8000-000000008401';
update public.profiles set display_name='S84 bartender',role='bartender',active=true where id='00000000-0000-4000-8000-000000008402';

-- Trusted owner workflow: a new owner-confirmed row is stamped from its quantity.
insert into public.inventory_items (
  id,name,category,quantity,unit,size_ml,cost_price,active,source_type,source_confidence
) values
  ('00000000-0000-4000-8000-000000008501','S84 owner item','Wine',10,'bottles',750,2000,true,'owner_confirmed',100),
  ('00000000-0000-4000-8000-000000008502','S84 plain item','Wine',5,'bottles',750,2000,true,'inventory_pdf',85);

create temporary table s84_before on commit drop as
select id,source_confirmed_at,source_confirmed_quantity from public.inventory_items;
grant select on table s84_before to authenticated;

insert into s84_acceptance
select 'trusted_insert_stamps_owner_confirmation',
       source_confirmed_at is not null and source_confirmed_quantity = 10,
       format('Owner confirmation: %s at %s.',source_confirmed_quantity,source_confirmed_at)
from public.inventory_items where id='00000000-0000-4000-8000-000000008501';

insert into s84_acceptance
select 'non_owner_rows_are_not_stamped',
       source_confirmed_at is null and source_confirmed_quantity is null,
       'Rows without owner confidence 100 carry no confirmation.'
from public.inventory_items where id='00000000-0000-4000-8000-000000008502';

-- Manager browser path.
set session authorization s84_browser_probe;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000008401',true);

-- S89 20260928095000 revokes browser UPDATE on inventory_items; the edit is
-- then refused (42501) and the checks below hold with nothing changed.
do $s84_cost_edit$
begin
  update public.inventory_items set cost_price=2100 where id='00000000-0000-4000-8000-000000008501';
exception when insufficient_privilege then null;
end
$s84_cost_edit$;
insert into s84_acceptance
select 'manager_master_edit_keeps_confirmation_date',
       item.source_confirmed_at = before.source_confirmed_at and item.updated_at > before.source_confirmed_at - interval '1 second',
       'A cost edit does not re-date the owner confirmation.'
from public.inventory_items item join s84_before before using (id)
where item.id='00000000-0000-4000-8000-000000008501';

do $manager_direct$
begin
  begin
    update public.inventory_items set source_confirmed_at=now() + interval '1 day'
    where id='00000000-0000-4000-8000-000000008501';
    insert into s84_acceptance values ('manager_cannot_write_confirmation_at',false,'Manager moved the confirmation date.');
  exception when insufficient_privilege then
    insert into s84_acceptance values ('manager_cannot_write_confirmation_at',true,'Rejected with 42501.');
  end;
  begin
    update public.inventory_items set source_confirmed_quantity=99
    where id='00000000-0000-4000-8000-000000008501';
    insert into s84_acceptance values ('manager_cannot_write_confirmation_quantity',false,'Manager changed the confirmed quantity.');
  exception when insufficient_privilege then
    insert into s84_acceptance values ('manager_cannot_write_confirmation_quantity',true,'Rejected with 42501.');
  end;
end
$manager_direct$;

-- S89 20260928095000 revokes browser UPDATE on inventory_items; the edit is
-- then refused (42501) and the checks below hold with nothing changed.
do $s84_promote_edit$
begin
  update public.inventory_items set source_type='owner_confirmed',source_confidence=100
  where id='00000000-0000-4000-8000-000000008502';
exception when insufficient_privilege then null;
end
$s84_promote_edit$;
insert into s84_acceptance
select 'manager_cannot_promote_row_to_owner_confirmation',
       source_confirmed_at is null and source_confirmed_quantity is null,
       'Changing source metadata from the browser creates no stock baseline.'
from public.inventory_items where id='00000000-0000-4000-8000-000000008502';

do $sale$
begin
  perform public.adjust_inventory('00000000-0000-4000-8000-000000008501'::uuid,-2::numeric,'sale',null,null,'S84 acceptance sale');
end
$sale$;
insert into s84_acceptance
select 'controlled_movement_keeps_confirmation',
       quantity = 8 and source_confirmed_quantity = 10,
       format('Live %s, confirmed %s.',quantity,source_confirmed_quantity)
from public.inventory_items where id='00000000-0000-4000-8000-000000008501';

-- Staff browser path.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000008402',true);
insert into s84_acceptance
select 'staff_catalog_exposes_owner_baseline',
       count(*) filter (where id='00000000-0000-4000-8000-000000008501' and owner_confirmed_quantity=10 and owner_confirmed_at is not null)=1
       and count(*) filter (where id='00000000-0000-4000-8000-000000008502' and owner_confirmed_quantity is null and owner_confirmed_at is null)=1,
       'Only confirmed owner rows carry a baseline for staff.'
from public.inventory_catalog;

insert into s84_acceptance
select 'staff_catalog_hides_source_metadata',
       not exists (
         select 1 from information_schema.columns
         where table_schema='public' and table_name='inventory_catalog'
           and column_name in ('source_type','source_confidence','source_hash','source_file','source_confirmed_at','source_confirmed_quantity','cost_price','supplier','supplier_id','notes')
       ),
       'Staff see owner_confirmed_* only.';

insert into s84_acceptance
select 'staff_cannot_read_inventory_items',count(*)=0,
       format('Staff-visible canonical rows: %s.',count(*))
from public.inventory_items;

reset role;
reset session authorization;

insert into s84_acceptance
select 'confirmation_function_not_callable_by_clients',
       not has_function_privilege('anon','private.inventory_owner_confirmation_guard()','execute')
       and not has_function_privilege('authenticated','private.inventory_owner_confirmation_guard()','execute'),
       'Trigger function is not granted to browser roles.';

do $verdict$
begin
  if exists (select 1 from s84_acceptance where not passed) then
    raise exception 'S84 owner-confirmation acceptance failed: %',
      (select jsonb_agg(to_jsonb(row_data)) from s84_acceptance row_data where not passed);
  end if;
end
$verdict$;

select jsonb_build_object(
  'rolled_back',true,
  's84_owner_confirmation','passed',
  'tests',(select jsonb_agg(test_name order by test_name) from s84_acceptance)
);

rollback;
