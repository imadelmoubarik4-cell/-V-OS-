-- S87 inventory delete guard.
--
-- Deleting an inventory item sets inventory_movements.item_id and
-- recipe_ingredients.item_id to NULL (existing foreign keys), which silently
-- detaches stock history and makes recipes incomplete. The browser now
-- deactivates items instead (active = false). This trigger refuses browser
-- deletes of items that still have movements or recipe links; trusted server
-- contexts keep their existing cleanup ability. No row, policy or grant is
-- modified.

create or replace function private.inventory_item_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_role text := coalesce((select auth.role()), '');
  trusted_server boolean := caller_role = 'service_role' or session_user = 'postgres';
begin
  if not trusted_server and (
    exists (select 1 from public.inventory_movements movement where movement.item_id = old.id)
    or exists (select 1 from public.recipe_ingredients ingredient where ingredient.item_id = old.id)
  ) then
    raise exception 'This item has stock history or recipe links. Deactivate it instead of deleting it.'
      using errcode = '42501';
  end if;
  return old;
end;
$function$;

revoke all on function private.inventory_item_delete_guard() from public, anon, authenticated;

drop trigger if exists inventory_items_s87_delete_guard on public.inventory_items;
create trigger inventory_items_s87_delete_guard
  before delete on public.inventory_items
  for each row execute function private.inventory_item_delete_guard();
