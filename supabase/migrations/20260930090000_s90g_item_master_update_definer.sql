-- S90g: item-master publication moves behind a private definer, like the
-- other reviewed browser RPCs, so it keeps working after
-- 20260928095000_s89_revoke_direct_item_update.sql revokes UPDATE on
-- public.inventory_items from authenticated.
--
--   * private.apply_item_master_update: the current body of
--     public.atlas_apply_item_master_update, unchanged apart from its manager
--     check (auth.uid() is null or not private.is_manager_or_admin(), errcode
--     42501). SECURITY DEFINER, search_path '', not exposed by the API.
--   * public.atlas_apply_item_master_update: same signature, SECURITY INVOKER
--     wrapper with the same manager check, calling the private function.
--     atlas-item-master calls it with the signed-in manager's token, so
--     authenticated keeps EXECUTE; anon never has it.
--
-- The body is copied from the live definition, so the S89 attribute
-- extension (20260927091000) is kept wherever it is installed. Re-running is a
-- no-op once the private function exists. Safe before the new web deploy:
-- nothing is revoked here and the signature, messages and result are the same.

do $s90g_item_master_definer$
declare
  definition text;
  old_check constant text := $c$if not private.is_manager_or_admin() then raise exception 'Only active managers can publish item-master changes'; end if;$c$;
  new_check constant text := $c$if auth.uid() is null or not private.is_manager_or_admin() then raise exception 'Only active managers can publish item-master changes' using errcode='42501'; end if;$c$;
begin
  if to_regprocedure('private.apply_item_master_update(uuid,jsonb,uuid[],jsonb,text)') is not null then
    return;
  end if;
  select pg_catalog.pg_get_functiondef('public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text)'::regprocedure)
  into definition;
  if position('CREATE OR REPLACE FUNCTION public.atlas_apply_item_master_update(' in definition) <> 1
     or position(old_check in definition) = 0
     or position(E'\n SECURITY DEFINER' in definition) > 0
     or position(E'\n SET search_path TO ''''' in definition) = 0 then
    raise exception 'S90g: unexpected definition of public.atlas_apply_item_master_update';
  end if;
  definition := replace(definition,
    'CREATE OR REPLACE FUNCTION public.atlas_apply_item_master_update(',
    'CREATE FUNCTION private.apply_item_master_update(');
  definition := replace(definition, E'\n SET search_path TO ''''', E'\n SECURITY DEFINER\n SET search_path TO ''''');
  definition := replace(definition, old_check, new_check);
  execute definition;
end
$s90g_item_master_definer$;

revoke all on function private.apply_item_master_update(uuid,jsonb,uuid[],jsonb,text) from public, anon;
grant execute on function private.apply_item_master_update(uuid,jsonb,uuid[],jsonb,text) to authenticated, service_role;

create or replace function public.atlas_apply_item_master_update(
  p_item_id uuid,
  p_values jsonb,
  p_recipe_ingredient_ids uuid[],
  p_expected_values jsonb,
  p_request_id text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
begin
  if auth.uid() is null or not private.is_manager_or_admin() then raise exception 'Only active managers can publish item-master changes' using errcode='42501'; end if;
  return private.apply_item_master_update(p_item_id, p_values, p_recipe_ingredient_ids, p_expected_values, p_request_id);
end
$$;

revoke all on function public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text) from public, anon;
grant execute on function public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text) to authenticated, service_role;

comment on function public.atlas_apply_item_master_update(uuid,jsonb,uuid[],jsonb,text) is
  'Manager-only item-master publication (atlas-item-master, signed-in manager token). Invoker wrapper; the change is applied by private.apply_item_master_update (SECURITY DEFINER) so the browser never needs UPDATE on inventory_items.';
