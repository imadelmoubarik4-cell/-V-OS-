-- S95B preview-only acceptance: the recipe.draft proposal kind
-- (20261005091000_s95b_recipe_draft_kind.sql). Rolled back.
--
-- * atlas_ai_action_create accepts the recipe.draft proposal kind for
--   managers and administrators only (bartenders and viewers can never be
--   named approvers), exactly like knowledge.draft.
-- * Every kind that existed before S95B keeps exactly its S90F roles.
-- * The allow-list stays private (service role only).

begin;

create temporary table s95b_ai (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s95b_ai to public;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-0000000b9501','s95b-ai-mgr@example.invalid')) as u(id, email);
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-0000000b9501','s95b-ai-mgr@example.invalid','S95b manager','manager',true)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;

insert into s95b_ai select 'recipe.draft is a known kind for admin and manager only',
  atlas_private.ai_action_allowed_roles('recipe.draft','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('recipe.no_such_kind','{}'::jsonb) is null;
insert into s95b_ai select 'every earlier kind keeps its S90F roles',
  atlas_private.ai_action_allowed_roles('purchase_order.create','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('purchase_order.update_draft','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('purchase_order.receive','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('shift.draft','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('knowledge.draft','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('settings.suggestion','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('par_level.suggestion','{}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('stock_count.draft','{}'::jsonb) = array['admin','manager','bartender']::text[]
  and atlas_private.ai_action_allowed_roles('catalog.alias','{}'::jsonb) = array['admin','manager','bartender']::text[]
  and atlas_private.ai_action_allowed_roles('catalog.new_item','{}'::jsonb) = array['admin','manager','bartender']::text[]
  and atlas_private.ai_action_allowed_roles('catalog.wrong_match','{}'::jsonb) = array['admin','manager','bartender']::text[]
  and atlas_private.ai_action_allowed_roles('team_message.send','{"channel_key":"announcements"}'::jsonb) = array['admin','manager']::text[]
  and atlas_private.ai_action_allowed_roles('team_message.send','{"channel_key":"bar"}'::jsonb) = array['admin','manager','bartender']::text[];
insert into s95b_ai select 'the allow-list stays private (service role only)',
  not has_function_privilege('authenticated','atlas_private.ai_action_allowed_roles(text,jsonb)','execute')
  and not has_function_privilege('anon','atlas_private.ai_action_allowed_roles(text,jsonb)','execute')
  and has_function_privilege('service_role','atlas_private.ai_action_allowed_roles(text,jsonb)','execute');

do $kind$
declare
  created jsonb;
  bartender_named boolean := false;
begin
  created := public.atlas_ai_action_create('00000000-0000-4000-8000-0000000b9501','manager',null,null,
    'recipe.draft','Draft: Basil Pear Collins','{"headline":"New draft recipe"}'::jsonb,
    '{"recipe":{"name":"Basil Pear Collins","type":"cocktail","active":false,"show_on_menu":false},"ingredients":[]}'::jsonb,
    array['admin','manager']::text[], 3600);
  insert into s95b_ai select 'a manager can record a recipe.draft proposal for admin/manager approval', created is not null;
  begin
    perform public.atlas_ai_action_create('00000000-0000-4000-8000-0000000b9501','manager',null,null,
      'recipe.draft','Draft: Basil Pear Collins','{}'::jsonb,
      '{"recipe":{"name":"Basil Pear Collins"},"ingredients":[]}'::jsonb,
      array['admin','manager','bartender']::text[], 3600);
  exception when others then bartender_named := sqlstate = '22023';
  end;
  insert into s95b_ai select 'a bartender can never be named an approver of a recipe draft', bartender_named;
end
$kind$;

insert into s95b_ai select 'recording a proposal creates no recipe',
  not exists (select 1 from public.recipes where name = 'Basil Pear Collins');

select jsonb_build_object(
  's95b_recipe_draft_kind', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s95b_ai;

rollback;
