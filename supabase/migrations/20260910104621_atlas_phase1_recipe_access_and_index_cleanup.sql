-- Follow-up to the unchanged PR30 candidate. Review before hosted application.
-- Staff use recipe_catalog; canonical recipe ingredients remain manager-only.
-- The earlier hardening used spaces in the policy name, missing the underscore.

do $recipe_cleanup_guard$
declare
  keeper pg_index%rowtype;
  redundant pg_index%rowtype;
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'recipe_ingredients'
      and policyname = 'active managers read recipe ingredients'
      and roles = array['authenticated']::name[]
      and cmd = 'SELECT' and permissive = 'PERMISSIVE'
      and qual = 'private.is_manager_or_admin()'
  ) then
    raise exception 'Expected manager-only recipe ingredient policy is missing or changed';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'recipe_ingredients'
      and cmd in ('SELECT', 'ALL')
      and policyname not in (
        'active managers read recipe ingredients', 'active staff read recipe_ingredients'
      )
  ) then
    raise exception 'Unexpected recipe ingredient read policy; review before cleanup';
  end if;

  select * into keeper from pg_index
  where indexrelid = to_regclass('public.recipe_ingredients_recipe_id_idx');
  if keeper.indexrelid is null or not keeper.indisvalid or not keeper.indisready
     or keeper.indrelid <> 'public.recipe_ingredients'::regclass
     or keeper.indisunique or keeper.indisprimary
     or keeper.indnkeyatts <> 1 or keeper.indnatts <> 1
     or keeper.indexprs is not null or keeper.indpred is not null
     or pg_get_indexdef(keeper.indexrelid, 1, true) <> 'recipe_id' then
    raise exception 'Expected valid recipe_id index is missing or changed';
  end if;

  select * into redundant from pg_index
  where indexrelid = to_regclass('public.recipe_ingredients_recipe_idx');
  if redundant.indexrelid is not null then
    if (to_jsonb(keeper) - 'indexrelid') is distinct from
       (to_jsonb(redundant) - 'indexrelid')
       or (select relam from pg_class where oid = keeper.indexrelid) <>
          (select relam from pg_class where oid = redundant.indexrelid)
       or exists (select 1 from pg_constraint where conindid = redundant.indexrelid) then
      raise exception 'Recipe index is not the reviewed duplicate; refusing removal';
    end if;
  end if;
end
$recipe_cleanup_guard$;

drop policy if exists "active staff read recipe_ingredients" on public.recipe_ingredients;
drop index if exists public.recipe_ingredients_recipe_idx;
