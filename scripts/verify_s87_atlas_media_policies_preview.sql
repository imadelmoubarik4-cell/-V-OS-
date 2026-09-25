-- S87 preview-only atlas-media storage policy matrix.
--
-- Requires an isolated replay database with the S87 migration applied. Checks
-- that bartenders and deactivated managers cannot write atlas-media objects,
-- active managers can, and active staff can read. Rolled back.

begin;

create temporary table s87_media (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s87_media to authenticated;
-- Supabase grants these table privileges; the replay bootstrap does not.
grant select, insert, update, delete on table storage.objects to authenticated;
create role s87_media_probe nologin;
grant authenticated to s87_media_probe;

insert into storage.buckets (id,name,public) values ('atlas-media','atlas-media',true) on conflict (id) do nothing;
insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), id, 'authenticated','authenticated', email,'',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from (values ('00000000-0000-4000-8000-000000087401'::uuid,'s87-mgr@example.invalid'),('00000000-0000-4000-8000-000000087402'::uuid,'s87-bar@example.invalid'),('00000000-0000-4000-8000-000000087403'::uuid,'s87-gone@example.invalid')) v(id,email);
update public.profiles set role='manager', active=true where id='00000000-0000-4000-8000-000000087401';
update public.profiles set role='bartender', active=true where id='00000000-0000-4000-8000-000000087402';
update public.profiles set role='manager', active=false where id='00000000-0000-4000-8000-000000087403';
insert into storage.objects (id,bucket_id,name) values ('00000000-0000-4000-8000-000000087501','atlas-media','recipes/menu-image.jpg');

set session authorization s87_media_probe;
set role authenticated;

do $probe$
declare
  users uuid[] := array['00000000-0000-4000-8000-000000087402','00000000-0000-4000-8000-000000087403']::uuid[];
  who uuid; wrote boolean; changed integer;
begin
  foreach who in array users loop
    perform set_config('request.jwt.claim.sub', who::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    wrote := true;
    begin
      insert into storage.objects (bucket_id,name) values ('atlas-media','recipes/deface-'||who||'.jpg');
    exception when insufficient_privilege then wrote := false;
    end;
    update storage.objects set name='recipes/renamed.jpg' where bucket_id='atlas-media' and name='recipes/menu-image.jpg';
    get diagnostics changed = row_count;
    delete from storage.objects where bucket_id='atlas-media' and name='recipes/menu-image.jpg';
    insert into s87_media values
      ((case when who='00000000-0000-4000-8000-000000087402' then 'bartender' else 'deactivated manager' end)||' cannot upload, overwrite or delete menu images',
       not wrote and changed = 0);
  end loop;

  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000087403', true);
  insert into s87_media values ('deactivated staff cannot read the bucket through the API', not exists (select 1 from storage.objects where bucket_id='atlas-media'));
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000087402', true);
  insert into s87_media values ('active staff can read menu images', exists (select 1 from storage.objects where bucket_id='atlas-media' and name='recipes/menu-image.jpg'));

  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000087401', true);
  insert into storage.objects (bucket_id,name) values ('atlas-media','recipes/new.jpg');
  delete from storage.objects where bucket_id='atlas-media' and name='recipes/new.jpg';
  insert into s87_media values ('active manager can upload and delete', not exists (select 1 from storage.objects where name='recipes/new.jpg'));
end
$probe$;

reset role;
reset session authorization;

-- Checked with full visibility: a deactivated user can no longer read the
-- bucket, so the survival check cannot run inside that user's session.
insert into s87_media values ('menu image survived every unauthorised attempt',
  exists (select 1 from storage.objects where bucket_id='atlas-media' and name='recipes/menu-image.jpg'));

select jsonb_build_object(
  's87_atlas_media_policies', case when bool_and(passed) then 'passed' else 'failed' end,
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s87_media;

rollback;
