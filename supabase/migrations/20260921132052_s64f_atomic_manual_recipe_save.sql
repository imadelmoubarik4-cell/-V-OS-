-- Save a manually authored recipe and its ingredients in one transaction.
create or replace function public.atlas_save_recipe(p_recipe_id uuid, p_recipe jsonb, p_ingredients jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  saved_id uuid;
  r public.recipes;
begin
  if auth.uid() is null or not private.is_manager_or_admin() then
    raise exception 'Recipe editing is limited to active managers and administrators' using errcode='42501';
  end if;
  if jsonb_typeof(p_recipe) is distinct from 'object' or jsonb_typeof(p_ingredients) is distinct from 'array' then
    raise exception 'Recipe and ingredient data are required' using errcode='22023';
  end if;
  r := jsonb_populate_record(null::public.recipes, p_recipe);
  if nullif(trim(r.name),'') is null then raise exception 'Recipe name is required'; end if;
  if r.yield_quantity is null or r.yield_quantity <= 0 then raise exception 'Recipe yield must be positive'; end if;
  if exists(select 1 from jsonb_to_recordset(p_ingredients) as i(quantity numeric, unit text, item_name text)
    where quantity is null or quantity <= 0 or nullif(trim(unit),'') is null or nullif(trim(item_name),'') is null) then
    raise exception 'Each ingredient needs a name, positive quantity and unit';
  end if;
  if p_recipe_id is null then
    insert into public.recipes(name,type,category_id,image_url,glassware,garnish,method,notes,yield_quantity,yield_unit,menu_price,active,show_on_menu,updated_by)
    values(trim(r.name),coalesce(r.type,'other'),r.category_id,r.image_url,r.glassware,r.garnish,r.method,r.notes,r.yield_quantity,coalesce(r.yield_unit,'serving'),r.menu_price,coalesce(r.active,true),coalesce(r.show_on_menu,false),auth.uid())
    returning id into saved_id;
  else
    update public.recipes set name=trim(r.name),type=coalesce(r.type,'other'),category_id=r.category_id,image_url=r.image_url,
      glassware=r.glassware,garnish=r.garnish,method=r.method,notes=r.notes,yield_quantity=r.yield_quantity,
      yield_unit=coalesce(r.yield_unit,'serving'),menu_price=r.menu_price,active=coalesce(r.active,true),
      show_on_menu=coalesce(r.show_on_menu,false),updated_by=auth.uid()
    where id=p_recipe_id returning id into saved_id;
    if saved_id is null then raise exception 'Recipe not found or access denied'; end if;
    delete from public.recipe_ingredients where recipe_id=saved_id;
  end if;
  insert into public.recipe_ingredients(recipe_id,item_id,item_name,quantity,unit)
    select saved_id,item_id,item_name,quantity,unit
    from jsonb_to_recordset(p_ingredients) as i(item_id uuid,item_name text,quantity numeric,unit text);
  return saved_id;
end;
$$;
revoke all on function public.atlas_save_recipe(uuid,jsonb,jsonb) from public, anon;
grant execute on function public.atlas_save_recipe(uuid,jsonb,jsonb) to authenticated;
