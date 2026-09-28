-- S96 (authn, N18): losing access ends every Auth session of that person.
--
-- Before: deactivating or demoting a profile stopped data access on the next
-- request (RLS helpers and _shared/auth.mjs read public.profiles every time),
-- but the person's Auth sessions and refresh tokens stayed valid: the app kept
-- refreshing, and reactivating the profile later silently resumed every old
-- session on every device.
-- After: when a profile goes from active to inactive, or its role loses
-- privilege (admin > manager > bartender > viewer), all rows of that user in
-- auth.sessions are deleted (auth.refresh_tokens cascade). The next refresh
-- fails and the app returns to sign-in; Edge Functions refuse the old access
-- token at once (Auth reports the session as gone). This covers every path
-- (Team Profiles, an administrator's direct PostgREST update, SQL).
-- Account deletion needs nothing extra: auth.users ON DELETE CASCADE already
-- removes the profile, sessions and refresh tokens.
--
-- The trigger function is SECURITY DEFINER only because auth.sessions is not
-- visible to the caller's role; it takes no arguments, touches only the row's
-- own user id, and nobody can execute it directly.

create or replace function private.revoke_sessions_on_access_loss()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rank_old int := array_position(array['viewer','bartender','manager','admin'], old.role::text);
  rank_new int := array_position(array['viewer','bartender','manager','admin'], new.role::text);
begin
  if (old.active is true and new.active is not true)
     or coalesce(rank_new, 0) < coalesce(rank_old, 0) then
    delete from auth.sessions as session where session.user_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.revoke_sessions_on_access_loss() from public, anon, authenticated;

drop trigger if exists profiles_revoke_sessions_on_access_loss on public.profiles;
create trigger profiles_revoke_sessions_on_access_loss
  after update of active, role on public.profiles
  for each row execute function private.revoke_sessions_on_access_loss();
