-- S90 follow-up preview-only acceptance: one truth for open orders in Atlas AI
-- (20260929092000_s90f_ai_update_draft_order_kind.sql). Rolled back.
--
-- * atlas_ai_action_create accepts the purchase_order.update_draft proposal
--   kind for managers and administrators only (bartenders and viewers can
--   never be named approvers), exactly like purchase_order.create.
-- * The command the approved proposal runs (atlas_purchase_order_command_v2
--   'update' with the version it was prepared against) replaces the draft's
--   lines in place: still one draft for the supplier, version bumped. A stale
--   version and a non-draft order are refused and change nothing.

begin;

create temporary table s90f_ai (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s90f_ai to public;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-0000000a0f01','s90f-ai-mgr@example.invalid'),
  ('00000000-0000-4000-8000-0000000a0f02','s90f-ai-bar@example.invalid')) as u(id, email);
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-0000000a0f01','s90f-ai-mgr@example.invalid','S90f manager','manager',true),
  ('00000000-0000-4000-8000-0000000a0f02','s90f-ai-bar@example.invalid','S90f bartender','bartender',true)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;
insert into public.suppliers (id,name,active) values ('00000000-0000-4000-8000-0000000a0f51','S90f supplier',true);
insert into public.inventory_items (id,name,category,unit,active,quantity,par_level,cost_price) values
  ('00000000-0000-4000-8000-0000000a0f11','S90f Pinot Grigio','Wine','bottles',true,10,12,2900),
  ('00000000-0000-4000-8000-0000000a0f12','S90f Sauvignon Blanc','Wine','bottles',true,4,6,3000);

-- ---------- the proposal kind ----------
insert into s90f_ai select 'update_draft is a known kind for admin and manager only',
  atlas_private.ai_action_allowed_roles('purchase_order.update_draft','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('purchase_order.create','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('purchase_order.no_such_kind','{}'::jsonb) is null;
insert into s90f_ai select 'the allow-list stays private (service role only)',
  not has_function_privilege('authenticated','atlas_private.ai_action_allowed_roles(text,jsonb)','execute')
  and not has_function_privilege('anon','atlas_private.ai_action_allowed_roles(text,jsonb)','execute')
  and has_function_privilege('service_role','atlas_private.ai_action_allowed_roles(text,jsonb)','execute');

do $kind$
declare
  created jsonb;
  bartender_named boolean := false;
begin
  created := public.atlas_ai_action_create('00000000-0000-4000-8000-0000000a0f01','manager',null,null,
    'purchase_order.update_draft','Add to draft order','{"headline":"Add to the draft"}'::jsonb,
    '{"p_id":"00000000-0000-4000-8000-0000000a0f71","p_action":"update","p_version":1}'::jsonb,
    array['admin','manager']::text[], 3600);
  insert into s90f_ai select 'a manager can record an update_draft proposal for admin/manager approval', created is not null;
  begin
    perform public.atlas_ai_action_create('00000000-0000-4000-8000-0000000a0f01','manager',null,null,
      'purchase_order.update_draft','Add to draft order','{}'::jsonb,
      '{"p_id":"00000000-0000-4000-8000-0000000a0f71","p_action":"update","p_version":1}'::jsonb,
      array['admin','manager','bartender']::text[], 3600);
  exception when others then bartender_named := sqlstate = '22023';
  end;
  insert into s90f_ai select 'a bartender can never be named an approver of a draft update', bartender_named;
end
$kind$;

-- ---------- the command an approved proposal runs ----------
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true),
       set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000a0f01',true),
       set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-0000000a0f01","role":"authenticated"}',true);

do $update$
declare
  draft public.purchase_orders;
  updated public.purchase_orders;
  stale_refused boolean := false;
begin
  draft := public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-0000000a0f71','create',null,
    '00000000-0000-4000-8000-0000000a0f51',
    '[{"item_id":"00000000-0000-4000-8000-0000000a0f11","quantity":6,"unit_cost":2900}]'::jsonb,'Weekend wine',null,null,null,null);
  updated := public.atlas_purchase_order_command_v2(draft.id,'update',draft.version,
    '00000000-0000-4000-8000-0000000a0f51',
    '[{"item_id":"00000000-0000-4000-8000-0000000a0f11","quantity":18,"unit_cost":2900},{"item_id":"00000000-0000-4000-8000-0000000a0f12","quantity":6,"unit_cost":3000}]'::jsonb,
    'Weekend wine',null,null,null,null);
  insert into s90f_ai select 'update replaces the draft lines in place and bumps the version',
    updated.id = draft.id and updated.status = 'draft' and updated.version = draft.version + 1
    and jsonb_array_length(updated.lines) = 2 and (updated.lines->0->>'quantity')::numeric = 18 and updated.note = 'Weekend wine';
  insert into s90f_ai select 'still exactly one draft for the supplier',
    (select count(*) from public.purchase_orders o where o.supplier_id='00000000-0000-4000-8000-0000000a0f51' and o.status='draft') = 1;
  begin
    perform public.atlas_purchase_order_command_v2(draft.id,'update',draft.version,
      '00000000-0000-4000-8000-0000000a0f51',
      '[{"item_id":"00000000-0000-4000-8000-0000000a0f11","quantity":99,"unit_cost":2900}]'::jsonb,'Weekend wine',null,null,null,null);
  exception when others then stale_refused := sqlerrm like 'Order changed%';
  end;
  insert into s90f_ai select 'an update prepared against an older version is refused and changes nothing',
    stale_refused and (select (o.lines->0->>'quantity')::numeric = 18 and o.version = updated.version
      from public.purchase_orders o where o.id = draft.id);
end
$update$;

reset role;
select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claims','',true), set_config('request.jwt.claim.role','',true);

select jsonb_build_object(
  's90f_ai_update_draft', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s90f_ai;

rollback;
