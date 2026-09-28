-- S95B Atlas Flavor Intelligence: the recipe.draft proposal kind.
--
-- Atlas can compose a new recipe from the flavor graph and verified current
-- stock, but only as a proposal. Approving a `recipe.draft` card saves a NEW
-- recipe through the existing public.atlas_save_recipe with the approving
-- manager's JWT, always active = false and show_on_menu = false (it appears
-- under Recipes > Drafts and never on the menu). It never edits an existing
-- recipe and never touches stock, inventory or the menu.
--
-- atlas_ai_action_create only accepts known proposal kinds with the roles of
-- atlas_private.ai_action_allowed_roles (mirrors _shared/ai-tools/actions.mjs
-- PROPOSAL_KINDS). This replaces the S90F definition with the same CASE plus
-- 'recipe.draft' for admin/manager only (bartenders and viewers can never be
-- named approvers). Same grants: service_role only.

create or replace function atlas_private.ai_action_allowed_roles(p_kind text, p_command jsonb)
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_kind in ('purchase_order.create','purchase_order.update_draft','purchase_order.receive','shift.draft','knowledge.draft',
                    'settings.suggestion','par_level.suggestion','recipe.draft') then array['admin','manager']::text[]
    when p_kind in ('stock_count.draft','catalog.alias','catalog.new_item','catalog.wrong_match') then array['admin','manager','bartender']::text[]
    when p_kind = 'team_message.send' then
      case when p_command->>'channel_key' = 'announcements' then array['admin','manager']::text[]
           else array['admin','manager','bartender']::text[] end
    else null
  end;
$$;
revoke all on function atlas_private.ai_action_allowed_roles(text, jsonb) from public, anon, authenticated;
grant execute on function atlas_private.ai_action_allowed_roles(text, jsonb) to service_role;
