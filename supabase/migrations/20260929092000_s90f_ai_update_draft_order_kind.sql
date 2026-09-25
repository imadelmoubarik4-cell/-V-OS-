-- S90 follow-up: one truth for open orders in Atlas AI.
--
-- The assistant now uses the canonical open-order rule (a draft, an order
-- waiting for approval and an approved order already cover an item). When a
-- supplier already has a Draft, purchasing.prepare_draft_po no longer creates
-- a second draft: it proposes `purchase_order.update_draft`, which on
-- approval runs atlas_purchase_order_command_v2 action 'update' on that draft
-- with the version it was prepared against (a draft changed in the meantime
-- is refused, nothing is saved).
--
-- atlas_ai_action_create only accepts known proposal kinds with the roles of
-- atlas_private.ai_action_allowed_roles (mirrors _shared/ai-tools/actions.mjs
-- PROPOSAL_KINDS). The new kind is manager/admin only, like
-- purchase_order.create. Nothing else changes; the update itself still goes
-- through the purchase-order command with the approving manager's JWT.

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
