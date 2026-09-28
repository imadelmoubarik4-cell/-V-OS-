-- S96 (webstore): after 20261010094000, no authenticated caller can UPDATE
-- (move/rename/overwrite metadata of) Storage objects; uploads and deletes
-- keep working. Run on the replay database as a superuser; expects the users
-- seeded below. Fails (raises) on any regression.
begin;
insert into auth.users(id,email) values ('aaaaaaaa-0000-4000-8000-00000000000a','ma@x.test'),('bbbbbbbb-0000-4000-8000-00000000000b','mb@x.test') on conflict do nothing;
insert into public.profiles(id,email,display_name,role,active) values ('aaaaaaaa-0000-4000-8000-00000000000a','ma@x.test','MA','manager',true),('bbbbbbbb-0000-4000-8000-00000000000b','mb@x.test','MB','manager',true) on conflict (id) do update set role=excluded.role, active=excluded.active;
insert into storage.objects(bucket_id,name,metadata) values ('atlas-imports','aaaaaaaa-0000-4000-8000-00000000000a/a.csv','{"mimetype":"text/csv"}'),('atlas-media','recipes/r/i.png','{"mimetype":"image/png"}');
do $$ declare n int; begin
  perform set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-4000-8000-00000000000b","role":"authenticated"}',true); perform set_config('request.jwt.claim.sub','bbbbbbbb-0000-4000-8000-00000000000b',true);
  set local role authenticated;
  update storage.objects set name='bbbbbbbb-0000-4000-8000-00000000000b/moved.csv' where name='aaaaaaaa-0000-4000-8000-00000000000a/a.csv'; get diagnostics n = row_count;
  if n <> 0 then raise exception 'manager B renamed manager A''s import file'; end if;
  update storage.objects set bucket_id='atlas-media' where bucket_id='atlas-imports'; get diagnostics n = row_count;
  if n <> 0 then raise exception 'an import file moved into the public atlas-media bucket'; end if;
  update storage.objects set bucket_id='atlas-imports' where bucket_id='atlas-media'; get diagnostics n = row_count;
  if n <> 0 then raise exception 'a recipe image moved out of atlas-media'; end if;
  insert into storage.objects(bucket_id,name) values ('atlas-imports','bbbbbbbb-0000-4000-8000-00000000000b/ok.csv');
  insert into storage.objects(bucket_id,name) values ('atlas-media','recipes/bbbbbbbb-0000-4000-8000-00000000000b/new.png');
  delete from storage.objects where name='bbbbbbbb-0000-4000-8000-00000000000b/ok.csv'; get diagnostics n = row_count;
  if n <> 1 then raise exception 'managers can no longer delete their import file'; end if;
  begin
    insert into storage.objects(bucket_id,name) values ('atlas-imports','aaaaaaaa-0000-4000-8000-00000000000a/b.csv');
    raise exception 'manager B uploaded into manager A''s import folder';
  exception when insufficient_privilege then null; end;
  reset role;
end $$;
select 's96_storage_update_policies: ok';
rollback;
