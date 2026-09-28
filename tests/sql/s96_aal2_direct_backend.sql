-- S96 MFA gate, direct-backend negative regression (run on a replayed database):
-- an Administrator who has enrolled a verified factor but holds only an aal1 session
-- must be refused by every RPC that signed-in users can call directly (PostgREST
-- /rpc), by manager-only table reads, and by manager-only Storage writes — i.e. the
-- MFA screen cannot be bypassed by calling the backend. The same person at aal2 is
-- not refused on authorization grounds.
begin;
create function pg_temp.as_user(uid uuid, extra jsonb default '{}') returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub',uid,'role','authenticated') || extra)::text, true),
         set_config('request.jwt.claim.sub', uid::text, true), set_config('role','authenticated',true);
$$;
create temp table s96_calls(label text primary key, stmt text not null) on commit drop;
create temp table s96_results(aal text, label text, sqlstate text, message text) on commit drop;
grant all on s96_calls, s96_results to authenticated;
-- The replay stubs storage.objects without Supabase's default grants; production grants
-- authenticated full table privileges there (baseline effective_table_privs.json) and relies on
-- RLS, so mirror that here (rolled back).
grant select, insert, update, delete on storage.objects to authenticated;
insert into auth.users(id,email,raw_user_meta_data) values ('96000000-0000-4000-8000-00000000d001','s96-mfa-admin@example.invalid','{}');
update public.profiles set role='admin', active=true where id='96000000-0000-4000-8000-00000000d001';
insert into auth.mfa_factors(user_id,status) values ('96000000-0000-4000-8000-00000000d001','verified');
insert into public.inventory_items(name) values ('S96 aal item');
insert into s96_calls values
 ('adjust_inventory', $q$select public.adjust_inventory((select id from public.inventory_items limit 1),1,'restock',null,null,'s96')$q$),
 ('adjust_inventory_v2', $q$select public.adjust_inventory_v2('s96-aal',(select id from public.inventory_items limit 1),1,'restock',null,null,'s96')$q$),
 ('atlas_apply_item_master_update', $q$select public.atlas_apply_item_master_update((select id from public.inventory_items limit 1),'{}'::jsonb,null,null,'s96-aal')$q$),
 ('atlas_apply_par_levels', $q$select public.atlas_apply_par_levels('[]'::jsonb,'s96-aal')$q$),
 ('atlas_data_review_rows', $q$select public.atlas_data_review_rows('all',10,0)$q$),
 ('atlas_data_review_summary', $q$select public.atlas_data_review_summary()$q$),
 ('atlas_par_level_evidence', $q$select public.atlas_par_level_evidence(array[]::uuid[],7)$q$),
 ('atlas_purchase_order_command', $q$select public.atlas_purchase_order_command(null,'create',null,null,'[]'::jsonb,'s96')$q$),
 ('atlas_purchase_order_command_v2', $q$select public.atlas_purchase_order_command_v2(null,'create',null,null,'[]'::jsonb,'s96',null,null,'s96-aal',null)$q$),
 ('atlas_purchase_order_detail', $q$select public.atlas_purchase_order_detail(gen_random_uuid())$q$),
 ('atlas_purchase_order_policy', $q$select public.atlas_purchase_order_policy()$q$),
 ('atlas_save_recipe', $q$select public.atlas_save_recipe(null,'{"name":"S96 aal recipe"}'::jsonb,'[]'::jsonb)$q$),
 ('storage_insert_atlas_media', $q$insert into storage.objects(bucket_id,name) values ('atlas-media','s96/aal-probe.png')$q$);

create function pg_temp.run_all(p_aal text) returns void language plpgsql as $$
declare c record; st text; msg text;
begin
  for c in select * from s96_calls order by label loop
    begin
      execute c.stmt;
      insert into s96_results values (p_aal, c.label, '00000', 'ok');
    exception when others then
      get stacked diagnostics st = returned_sqlstate, msg = message_text;
      insert into s96_results values (p_aal, c.label, st, msg);
    end;
  end loop;
end $$;

-- aal1 (password only) after enrolment: every call must be refused.
select pg_temp.as_user('96000000-0000-4000-8000-00000000d001', '{"aal":"aal1","amr":[{"method":"password","timestamp":1}]}');
select pg_temp.run_all('aal1');
do $$ begin
  if exists (select 1 from public.inventory_items) then raise exception 'aal1 enrolled admin read manager-only rows'; end if;
end $$;
reset role;
-- aal2 (TOTP completed): authorization must pass (calls may still fail for data reasons).
select pg_temp.as_user('96000000-0000-4000-8000-00000000d001', '{"aal":"aal2","amr":[{"method":"totp","timestamp":2}]}');
select pg_temp.run_all('aal2');
do $$ begin
  if not exists (select 1 from public.inventory_items) then raise exception 'aal2 admin must read manager rows'; end if;
end $$;
reset role;

select aal, label, sqlstate, left(message, 90) as message from s96_results order by label, aal;
do $$
declare bad text;
begin
  select string_agg(label, ', ') into bad from s96_results where aal = 'aal1' and sqlstate = '00000';
  if bad is not null then raise exception 'MFA bypass: aal1 enrolled admin executed: %', bad; end if;
  -- An aal1 refusal must be an authorization refusal, identical in kind for every call;
  -- the same statement at aal2 must not produce that refusal.
  select string_agg(r1.label, ', ') into bad from s96_results r1 join s96_results r2 on r2.label = r1.label and r2.aal = 'aal2'
   where r1.aal = 'aal1' and r2.sqlstate = r1.sqlstate and r2.message = r1.message;
  if bad is not null then raise exception 'Not an MFA refusal (same outcome at aal2): %', bad; end if;
end $$;
rollback;
