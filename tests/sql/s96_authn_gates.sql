-- S96 (authn) negative regressions on a replayed database (scripts/verify_full_migration_replay.sh stubs).
-- 1. A self-registered user (public sign-up) gets an inactive viewer profile, whatever metadata it sends,
--    and reaches no business rows or privileged RPCs.
-- 2. Deactivation and demotion take effect on the next statement (no cached role).
-- 3. Privileged gates require aal2 once the person has a verified factor, or always in mandatory mode.
begin;
create function pg_temp.as_user(uid uuid, extra jsonb default '{}') returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub',uid,'role','authenticated') || extra)::text, true),
         set_config('request.jwt.claim.sub', uid::text, true), set_config('role','authenticated',true);
$$;
insert into auth.users(id,email,raw_user_meta_data) values ('96000000-0000-4000-8000-00000000a001','s96-owner@example.invalid','{}');
update public.profiles set role='admin', active=true where id='96000000-0000-4000-8000-00000000a001';
insert into auth.users(id,email,raw_user_meta_data) values ('96000000-0000-4000-8000-00000000c001','s96-staff@example.invalid','{}');
update public.profiles set role='bartender', active=true where id='96000000-0000-4000-8000-00000000c001';
insert into public.inventory_items(name) values ('S96 synthetic item');
-- 1. hostile self sign-up
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,raw_app_meta_data)
values ('96000000-0000-4000-8000-00000000b001','s96-signup@example.invalid',now(),
        '{"full_name":"Owner","role":"admin","active":true}','{"role":"admin"}');
do $$ begin
  if (select row(role::text, active) from public.profiles where id='96000000-0000-4000-8000-00000000b001')
     is distinct from row('viewer'::text, false) then
    raise exception 'Self sign-up must create an inactive viewer profile';
  end if;
end $$;
select pg_temp.as_user('96000000-0000-4000-8000-00000000b001');
do $$ begin
  if private.is_active_staff() or private.is_manager_or_admin() or private.current_profile_role() is not null then
    raise exception 'A self-registered user must hold no Atlas role';
  end if;
  if exists(select 1 from public.inventory_items) or exists(select 1 from public.profiles) then
    raise exception 'A self-registered user must not read business or profile rows';
  end if;
  update public.profiles set role='admin', active=true where id='96000000-0000-4000-8000-00000000b001';
  if (select active from public.profiles where id='96000000-0000-4000-8000-00000000b001') then
    raise exception 'Self-activation must be impossible';
  end if;
  begin
    perform public.adjust_inventory_v2('s96-req',(select id from public.inventory_items limit 1),1,'restock',null,null,'x');
    raise exception 'privileged RPC accepted a self-registered user';
  exception when others then
    if sqlerrm = 'privileged RPC accepted a self-registered user' then raise; end if;
  end;
end $$;
reset role;
-- 2. deactivation / demotion apply to the very next statement
select pg_temp.as_user('96000000-0000-4000-8000-00000000c001');
do $$ begin if not private.is_active_staff() then raise exception 'staff baseline'; end if; end $$;
reset role;
update public.profiles set active=false where id='96000000-0000-4000-8000-00000000c001';
select pg_temp.as_user('96000000-0000-4000-8000-00000000c001');
do $$ begin if private.is_active_staff() then raise exception 'Deactivation must apply immediately'; end if; end $$;
reset role;
-- 3. MFA gate for privileged roles
select pg_temp.as_user('96000000-0000-4000-8000-00000000a001', '{"aal":"aal1"}');
do $$ begin if not private.is_manager_or_admin() then raise exception 'Pre-enrolment admin must not be locked out'; end if; end $$;
reset role;
insert into auth.mfa_factors(user_id,status) values ('96000000-0000-4000-8000-00000000a001','verified');
select pg_temp.as_user('96000000-0000-4000-8000-00000000a001', '{"aal":"aal1"}');
do $$ begin
  if private.is_manager_or_admin() or private.current_profile_role() is not null then
    raise exception 'An enrolled admin on an aal1 session must not hold admin power';
  end if;
  if exists(select 1 from public.inventory_items) then raise exception 'aal1 enrolled admin read manager rows'; end if;
end $$;
reset role;
select pg_temp.as_user('96000000-0000-4000-8000-00000000a001', '{"aal":"aal2"}');
do $$ begin if not private.is_manager_or_admin() then raise exception 'aal2 admin must be privileged'; end if; end $$;
reset role;
delete from auth.mfa_factors where user_id='96000000-0000-4000-8000-00000000a001';
update private.auth_policy set require_privileged_mfa = true;
select pg_temp.as_user('96000000-0000-4000-8000-00000000a001', '{"aal":"aal1"}');
do $$ begin if private.is_manager_or_admin() then raise exception 'Mandatory mode must require aal2'; end if; end $$;
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ begin if not private.privileged_session_ok() then raise exception 'service-role context must be unaffected'; end if; end $$;
rollback;
