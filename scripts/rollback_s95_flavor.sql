-- S95 Atlas Flavor Intelligence: rollback (production only on owner approval).
--
-- Removes everything S95A/B/C added and puts atlas_private.ai_action_allowed_roles
-- back to its S90F definition (the one in production before S95B). It touches
-- no inventory, stock, supplier, recipe, menu, count or purchasing row: draft
-- recipes a manager already approved stay as ordinary inactive recipes (delete
-- them in Recipes if they are not wanted). Pending recipe.draft proposals are
-- expired so no card can be approved after the rollback.
-- Redeploy atlas-ai from main (version without the flavor routes) together with
-- this script.

begin;

update atlas_private.ai_actions
   set status = 'expired', updated_at = now()
 where kind = 'recipe.draft' and status = 'proposed';

drop function if exists public.atlas_flavor_snapshot();

drop table if exists atlas_private.flavor_item_links;
drop table if exists atlas_private.flavor_edges;
drop table if exists atlas_private.flavor_ingredient_preparations;
drop table if exists atlas_private.flavor_aliases;
drop table if exists atlas_private.flavor_preparations;
drop table if exists atlas_private.flavor_ingredients;
drop table if exists atlas_private.flavor_sources;

create or replace function atlas_private.ai_action_allowed_roles(p_kind text, p_command jsonb)
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_kind in ('purchase_order.create','purchase_order.update_draft','purchase_order.receive','shift.draft','knowledge.draft',
                    'settings.suggestion','par_level.suggestion') then array['admin','manager']::text[]
    when p_kind in ('stock_count.draft','catalog.alias','catalog.new_item','catalog.wrong_match') then array['admin','manager','bartender']::text[]
    when p_kind = 'team_message.send' then
      case when p_command->>'channel_key' = 'announcements' then array['admin','manager']::text[]
           else array['admin','manager','bartender']::text[] end
    else null
  end;
$$;
revoke all on function atlas_private.ai_action_allowed_roles(text, jsonb) from public, anon, authenticated;
grant execute on function atlas_private.ai_action_allowed_roles(text, jsonb) to service_role;

delete from supabase_migrations.schema_migrations
 where name in ('s95a_flavor_graph', 's95b_recipe_draft_kind', 's95c_flavor_seed');

commit;
