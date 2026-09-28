-- S96 (authn, N18) negative regression: deactivation or demotion ends every Auth
-- session (refresh tokens cascade); unrelated edits and promotions do not.
begin;
create function pg_temp.sessions(uid uuid) returns bigint language sql as $$
  select count(*) from auth.sessions where user_id = uid $$;
create function pg_temp.live_refresh(uid uuid) returns bigint language sql as $$
  select count(*) from auth.refresh_tokens r join auth.sessions s on s.id = r.session_id where s.user_id = uid $$;
insert into auth.users(id,email,raw_user_meta_data) values
  ('96000000-0000-4000-8000-00000000a101','s96-admin@example.invalid','{}'),
  ('96000000-0000-4000-8000-00000000a102','s96-admin2@example.invalid','{}'),
  ('96000000-0000-4000-8000-00000000c101','s96-staff@example.invalid','{}');
update public.profiles set role='admin', active=true where id in ('96000000-0000-4000-8000-00000000a101','96000000-0000-4000-8000-00000000a102');
update public.profiles set role='bartender', active=true where id='96000000-0000-4000-8000-00000000c101';
create function pg_temp.sign_in(uid uuid) returns void language sql as $$
  with s as (insert into auth.sessions(user_id) values (uid) returning id)
  insert into auth.refresh_tokens(token,user_id,session_id) select 'rt', uid::text, id from s $$;
select pg_temp.sign_in('96000000-0000-4000-8000-00000000c101'), pg_temp.sign_in('96000000-0000-4000-8000-00000000c101'),
       pg_temp.sign_in('96000000-0000-4000-8000-00000000a102');
-- the change is made the way Team Profiles makes it: an active administrator through PostgREST
select set_config('request.jwt.claims','{"sub":"96000000-0000-4000-8000-00000000a101","role":"authenticated","aal":"aal2"}',true),
       set_config('request.jwt.claim.sub','96000000-0000-4000-8000-00000000a101',true);
set local role authenticated;
update public.profiles set display_name='Renamed' where id='96000000-0000-4000-8000-00000000c101';
update public.profiles set role='manager' where id='96000000-0000-4000-8000-00000000c101';
reset role;
do $$ begin
  if pg_temp.sessions('96000000-0000-4000-8000-00000000c101') <> 2 then
    raise exception 'A rename or promotion must not end sessions';
  end if;
end $$;
set local role authenticated;
update public.profiles set active=false where id='96000000-0000-4000-8000-00000000c101';
update public.profiles set role='bartender' where id='96000000-0000-4000-8000-00000000a102';
reset role;
do $$ begin
  if pg_temp.sessions('96000000-0000-4000-8000-00000000c101') <> 0 or pg_temp.live_refresh('96000000-0000-4000-8000-00000000c101') <> 0 then
    raise exception 'Deactivation must end every session and refresh token';
  end if;
  if pg_temp.sessions('96000000-0000-4000-8000-00000000a102') <> 0 then
    raise exception 'Demotion must end every session';
  end if;
end $$;
-- reactivation does not resurrect old sessions
update public.profiles set active=true where id='96000000-0000-4000-8000-00000000c101';
do $$ begin
  if pg_temp.sessions('96000000-0000-4000-8000-00000000c101') <> 0 then raise exception 'Old sessions resurrected'; end if;
end $$;
-- nobody can call the trigger function directly
set local role authenticated;
do $$ begin
  begin
    perform private.revoke_sessions_on_access_loss();
    raise exception 'direct call allowed';
  exception when others then
    if sqlerrm = 'direct call allowed' then raise; end if;
  end;
end $$;
reset role;
-- account deletion cascades profile + sessions (existing production FKs)
select pg_temp.sign_in('96000000-0000-4000-8000-00000000c101');
delete from auth.users where id='96000000-0000-4000-8000-00000000c101';
do $$ begin
  if pg_temp.sessions('96000000-0000-4000-8000-00000000c101') <> 0
     or exists(select 1 from public.profiles where id='96000000-0000-4000-8000-00000000c101') then
    raise exception 'Account deletion must remove profile and sessions';
  end if;
end $$;
rollback;
