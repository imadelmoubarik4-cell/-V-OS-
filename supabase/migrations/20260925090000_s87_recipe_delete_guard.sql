-- S87 recipe delete guard.
--
-- Recipes could be permanently deleted from one browser confirm dialog while
-- still active on service. Deletion cascades to recipe_ingredients and cannot
-- be undone. The browser now archives recipes (active = false) and offers
-- permanent deletion only for archived recipes; this trigger enforces the same
-- rule for every browser path. Trusted server contexts (service_role, the
-- postgres session) keep their existing ability to clean up records.
--
-- No table, row, policy or grant is modified.

create or replace function private.recipe_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  caller_role text := coalesce((select auth.role()), '');
  trusted_server boolean := caller_role = 'service_role' or session_user = 'postgres';
begin
  if old.active is distinct from false and not trusted_server then
    raise exception 'Archive the recipe before deleting it permanently'
      using errcode = '42501';
  end if;
  return old;
end;
$function$;

revoke all on function private.recipe_delete_guard() from public, anon, authenticated;

drop trigger if exists recipes_s87_delete_guard on public.recipes;
create trigger recipes_s87_delete_guard
  before delete on public.recipes
  for each row execute function private.recipe_delete_guard();
