-- S87 preview-only recipe delete guard acceptance.
--
-- Requires an isolated replay database. Seeds temporary fixtures in one
-- transaction, exercises the manager-browser and trusted-server paths,
-- reports a JSON result, and rolls everything back.

begin;

create temporary table s87_acceptance (
  test_name text primary key,
  passed boolean not null,
  detail text not null
) on commit drop;
grant all on table s87_acceptance to authenticated;

create role s87_browser_probe nologin;
grant authenticated to s87_browser_probe;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000087101','authenticated','authenticated','s87-manager@example.invalid','',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now());
update public.profiles set display_name='S87 manager',role='manager',active=true where id='00000000-0000-4000-8000-000000087101';

insert into public.recipes (id,name,active) values
  ('00000000-0000-4000-8000-000000087201','S87 active recipe',true),
  ('00000000-0000-4000-8000-000000087202','S87 archived recipe',false);

set session authorization s87_browser_probe;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000087101',true);

do $probe$
declare blocked boolean := false;
begin
  begin
    delete from public.recipes where id='00000000-0000-4000-8000-000000087201';
  exception when insufficient_privilege then blocked := true;
  end;
  insert into s87_acceptance values ('manager cannot delete an active recipe', blocked, 'expected 42501');

  delete from public.recipes where id='00000000-0000-4000-8000-000000087202';
  insert into s87_acceptance values ('manager can delete an archived recipe',
    not exists (select 1 from public.recipes where id='00000000-0000-4000-8000-000000087202'), 'row removed');

  update public.recipes set active=false where id='00000000-0000-4000-8000-000000087201';
  insert into s87_acceptance values ('manager can archive a recipe',
    exists (select 1 from public.recipes where id='00000000-0000-4000-8000-000000087201' and active=false), 'active=false');
end
$probe$;

reset role;
reset session authorization;

update public.recipes set active=true where id='00000000-0000-4000-8000-000000087201';
delete from public.recipes where id='00000000-0000-4000-8000-000000087201';
insert into s87_acceptance values ('trusted server may still delete', not exists (select 1 from public.recipes where id='00000000-0000-4000-8000-000000087201'), 'postgres session');

select jsonb_build_object(
  's87_recipe_delete_guard', case when bool_and(passed) then 'passed' else 'failed' end,
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s87_acceptance;

rollback;
