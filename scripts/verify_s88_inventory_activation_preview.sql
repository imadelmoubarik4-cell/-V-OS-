-- S88 preview-only inventory activation acceptance. Rolled back.
--
-- Covers: manager deactivate/reactivate through the service-role command with
-- reason and actor in item_master_events; the old S87 direct browser update is
-- still allowed for active managers and is audited as direct_update; the
-- database actor check (bartender, viewer, deactivated and unknown profiles
-- refused); refusal to deactivate an item on an open purchase order; refusal
-- to reactivate while an active same-name item exists; stale updated_at
-- refusal; recipe links, par level, supplier and quantity unchanged; the
-- dependency facts; and that anon/authenticated cannot call the RPCs.

begin;

create temporary table s88_activation (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s88_activation to anon, authenticated, service_role;
create role s88_activation_probe nologin;
grant anon, authenticated, service_role to s88_activation_probe;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000088301','authenticated','authenticated','s88-act-mgr@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
  ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000088302','authenticated','authenticated','s88-act-bar@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
  ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000088303','authenticated','authenticated','s88-act-view@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
  ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000088304','authenticated','authenticated','s88-act-off@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-000000088301','s88-act-mgr@example.invalid','S88 manager','manager',true),
  ('00000000-0000-4000-8000-000000088302','s88-act-bar@example.invalid','S88 bartender','bartender',true),
  ('00000000-0000-4000-8000-000000088303','s88-act-view@example.invalid','S88 viewer','viewer',true),
  ('00000000-0000-4000-8000-000000088304','s88-act-off@example.invalid','S88 former manager','manager',false)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;

insert into public.suppliers (id,name,active) values
  ('00000000-0000-4000-8000-000000088401','S88 active supplier',true),
  ('00000000-0000-4000-8000-000000088402','S88 inactive supplier',false);
insert into public.inventory_items (id,name,category,quantity,unit,par_level,supplier_id,active) values
  ('00000000-0000-4000-8000-000000088501','S88 Lime','Test',0,'kg',4,'00000000-0000-4000-8000-000000088402',true),
  ('00000000-0000-4000-8000-000000088502','S88 Ordered Gin','Test',0,'bottles',6,'00000000-0000-4000-8000-000000088401',true),
  ('00000000-0000-4000-8000-000000088503','S88 Twin Rum','Test',0,'bottles',null,null,false),
  ('00000000-0000-4000-8000-000000088504',' s88 twin rum ','Test',0,'bottles',null,null,true),
  ('00000000-0000-4000-8000-000000088505','S88 Browser Item','Test',0,'bottles',null,null,true);
insert into public.recipes (id,name,active) values ('00000000-0000-4000-8000-000000088601','S88 Lime Sour',true);
insert into public.recipe_ingredients (recipe_id,item_id,item_name,quantity,unit)
values ('00000000-0000-4000-8000-000000088601','00000000-0000-4000-8000-000000088501','S88 Lime',0.1,'kg');
insert into public.purchase_orders (id,supplier_id,lines,status,created_by,updated_by) values
  ('00000000-0000-4000-8000-000000088701','00000000-0000-4000-8000-000000088401',
   '[{"item_id":"00000000-0000-4000-8000-000000088502","item_name":"S88 Ordered Gin","quantity":2}]'::jsonb,
   'ordered','00000000-0000-4000-8000-000000088301','00000000-0000-4000-8000-000000088301'),
  ('00000000-0000-4000-8000-000000088702','00000000-0000-4000-8000-000000088401',
   '[{"item_id":"00000000-0000-4000-8000-000000088501","item_name":"S88 Lime","quantity":1}]'::jsonb,
   'received','00000000-0000-4000-8000-000000088301','00000000-0000-4000-8000-000000088301');

set session authorization s88_activation_probe;
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $probe$
declare
  mgr constant uuid := '00000000-0000-4000-8000-000000088301';
  lime constant uuid := '00000000-0000-4000-8000-000000088501';
  gin constant uuid := '00000000-0000-4000-8000-000000088502';
  twin constant uuid := '00000000-0000-4000-8000-000000088503';
  deps jsonb;
  result jsonb;
  lime_updated timestamptz;
  failed boolean;
  sqlstate_value text;
  hint_value text;
begin
  deps := public.atlas_inventory_item_dependencies(lime, mgr);
  insert into s88_activation values ('dependencies list active recipes by name',
    (deps->'recipes'->>'active')::int = 1 and deps->'recipes'->'names' = '["S88 Lime Sour"]'::jsonb);
  insert into s88_activation values ('dependencies warn about an inactive supplier and missing count',
    deps->'warnings' @> '["supplier_inactive","stock_needs_count","used_by_active_recipes"]'::jsonb
    and (deps->'supplier'->>'active')::boolean = false);
  insert into s88_activation values ('received orders do not block deactivation',
    (deps->>'can_deactivate')::boolean and (deps->'open_orders'->>'total')::int = 0);

  deps := public.atlas_inventory_item_dependencies(gin, mgr);
  insert into s88_activation values ('dependencies report the open order',
    (deps->>'can_deactivate')::boolean = false and deps->'blockers' = '["open_purchase_order"]'::jsonb
    and (deps->'open_orders'->'by_status'->>'ordered')::int = 1);

  deps := public.atlas_inventory_item_dependencies(twin, mgr);
  insert into s88_activation values ('dependencies report the active same-name item',
    (deps->>'can_reactivate')::boolean = false
    and deps->'active_name_duplicate'->>'id' = '00000000-0000-4000-8000-000000088504');

  select updated_at into lime_updated from public.inventory_items where id=lime;
  result := public.atlas_set_inventory_item_active(lime, false, 'Seasonal menu ended', lime_updated, mgr, 'S88 manager');
  insert into s88_activation values ('manager deactivates through the command',
    (result->>'changed')::boolean and not (select active from public.inventory_items where id=lime));
  insert into s88_activation values ('deactivation is audited with actor, role and reason', exists (
    select 1 from atlas_private.item_master_events event
    where event.external_item_id=lime and event.event_type='item_deactivated'
      and event.actor_id=mgr and event.actor_role='manager' and event.actor_label='S88 manager'
      and event.payload->>'reason'='Seasonal menu ended' and event.payload->>'via'='rpc'));

  result := public.atlas_set_inventory_item_active(lime, false, null, null, mgr, 'S88 manager');
  insert into s88_activation values ('repeating the same state is a no-op without a new event',
    (result->>'changed')::boolean = false
    and (select count(*) from atlas_private.item_master_events where external_item_id=lime) = 1);

  failed := false;
  begin
    -- now() is constant inside this transaction, so simulate an older read.
    perform public.atlas_set_inventory_item_active(lime, true, null, lime_updated - interval '1 second', mgr, 'S88 manager');
  exception when others then failed := true; get stacked diagnostics hint_value = pg_exception_hint;
  end;
  insert into s88_activation values ('a stale updated_at is refused', failed and hint_value = 'atlas:stale_item');

  select updated_at into lime_updated from public.inventory_items where id=lime;
  result := public.atlas_set_inventory_item_active(lime, true, 'Back on the menu', lime_updated, mgr, 'S88 manager');
  insert into s88_activation values ('manager reactivates and it is audited',
    (select active from public.inventory_items where id=lime)
    and exists (select 1 from atlas_private.item_master_events event
      where event.external_item_id=lime and event.event_type='item_reactivated'
        and event.actor_id=mgr and event.payload->>'reason'='Back on the menu'));
  insert into s88_activation values ('recipe link, par level, supplier and quantity survive the round trip', (
    select item.par_level = 4 and item.quantity = 0
      and item.supplier_id = '00000000-0000-4000-8000-000000088402'
    from public.inventory_items item where item.id=lime)
    and exists (select 1 from public.recipe_ingredients where item_id=lime
      and recipe_id='00000000-0000-4000-8000-000000088601'));

  failed := false;
  begin
    perform public.atlas_set_inventory_item_active(gin, false, null, null, mgr, 'S88 manager');
  exception when others then failed := true; get stacked diagnostics hint_value = pg_exception_hint;
  end;
  insert into s88_activation values ('deactivation is refused while the item is on an ordered purchase order',
    failed and hint_value = 'atlas:open_purchase_order'
    and (select active from public.inventory_items where id=gin));

  failed := false;
  begin
    perform public.atlas_set_inventory_item_active(twin, true, null, null, mgr, 'S88 manager');
  exception when others then failed := true; get stacked diagnostics hint_value = pg_exception_hint;
  end;
  insert into s88_activation values ('reactivation is refused while an active same-name item exists',
    failed and hint_value = 'atlas:active_duplicate_name'
    and not (select active from public.inventory_items where id=twin));

  failed := false;
  begin
    perform public.atlas_set_inventory_item_active(lime, false, repeat('x', 501), null, mgr, 'S88 manager');
  exception when others then failed := true;
  end;
  insert into s88_activation values ('an over-long reason is refused', failed);

  failed := false;
  begin
    perform public.atlas_set_inventory_item_active(gen_random_uuid(), false, null, null, mgr, 'S88 manager');
  exception when others then failed := true; get stacked diagnostics hint_value = pg_exception_hint;
  end;
  insert into s88_activation values ('an unknown item is reported as not found', failed and hint_value = 'atlas:not_found');

  failed := false;
  begin
    perform public.atlas_set_inventory_item_active(lime, false, null, null, '00000000-0000-4000-8000-000000088302', 'S88 bartender');
  exception when others then failed := true; sqlstate_value := sqlstate;
  end;
  insert into s88_activation values ('a bartender cannot change activation', failed and sqlstate_value = '42501');

  failed := false;
  begin
    perform public.atlas_inventory_item_dependencies(lime, '00000000-0000-4000-8000-000000088303');
  exception when others then failed := true; sqlstate_value := sqlstate;
  end;
  insert into s88_activation values ('a viewer cannot read activation dependencies', failed and sqlstate_value = '42501');

  failed := false;
  begin
    perform public.atlas_set_inventory_item_active(lime, false, null, null, '00000000-0000-4000-8000-000000088304', 'S88 former manager');
  exception when others then failed := true; sqlstate_value := sqlstate;
  end;
  insert into s88_activation values ('a deactivated manager cannot change activation', failed and sqlstate_value = '42501');

  failed := false;
  begin
    perform public.atlas_set_inventory_item_active(lime, false, null, null, null, 'Nobody');
  exception when others then failed := true; sqlstate_value := sqlstate;
  end;
  insert into s88_activation values ('a missing actor is refused', failed and sqlstate_value = '42501');

  insert into s88_activation values ('refused commands changed nothing', (
    select active from public.inventory_items where id=lime)
    and (select count(*) from atlas_private.item_master_events where external_item_id=lime) = 2);
end
$probe$;

-- The S87 web path (direct browser update by an active manager) still works
-- and is now audited — until S89 20260928095000 revokes browser UPDATE, after
-- which the direct update is refused and nothing is written.
reset role;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088301',true);

do $probe$
declare denied boolean := false;
declare direct_blocked boolean := false;
begin
  begin
    update public.inventory_items set active=false where id='00000000-0000-4000-8000-000000088505';
  exception when insufficient_privilege then direct_blocked := true;
  end;
  insert into s88_activation values ('a direct manager deactivation follows the UPDATE grant',
    direct_blocked = not has_table_privilege('authenticated', 'public.inventory_items', 'update'));
  begin
    perform public.atlas_set_inventory_item_active('00000000-0000-4000-8000-000000088505', true, null, null,
      '00000000-0000-4000-8000-000000088301', 'S88 manager');
  exception when insufficient_privilege then denied := true;
  end;
  insert into s88_activation values ('an authenticated browser cannot call the activation command directly', denied);
end
$probe$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088302',true);
do $probe$
declare blocked boolean := false;
begin
  begin
    update public.inventory_items set active=false where id='00000000-0000-4000-8000-000000088504';
    blocked := not exists (select 1 from public.inventory_items where id='00000000-0000-4000-8000-000000088504');
  exception when insufficient_privilege then blocked := true;
  end;
  insert into s88_activation values ('a bartender browser still cannot update the item table', blocked);
end
$probe$;

reset role;
set role anon;
do $probe$
declare denied boolean := false;
begin
  begin
    perform public.atlas_inventory_item_dependencies('00000000-0000-4000-8000-000000088501', '00000000-0000-4000-8000-000000088301');
  exception when insufficient_privilege then denied := true;
  end;
  insert into s88_activation values ('anon cannot call the dependency RPC', denied);
end
$probe$;

reset role;
reset session authorization;

insert into s88_activation values ('the direct browser deactivation is audited as direct_update', case
  when has_table_privilege('authenticated', 'public.inventory_items', 'update') then exists (
    select 1 from atlas_private.item_master_events event
    where event.external_item_id='00000000-0000-4000-8000-000000088505' and event.event_type='item_deactivated'
      and event.actor_id='00000000-0000-4000-8000-000000088301' and event.actor_role='manager'
      and event.payload->>'via'='direct_update' and event.payload->>'reason' is null)
  else (select active from public.inventory_items where id='00000000-0000-4000-8000-000000088505')
    and not exists (select 1 from atlas_private.item_master_events event
      where event.external_item_id='00000000-0000-4000-8000-000000088505' and event.event_type='item_deactivated')
  end);
insert into s88_activation values ('the bartender attempt left the item active and unaudited', (
  select active from public.inventory_items where id='00000000-0000-4000-8000-000000088504')
  and not exists (select 1 from atlas_private.item_master_events where external_item_id='00000000-0000-4000-8000-000000088504'));
insert into s88_activation values ('no S88 activation function is executable by anon or authenticated', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where ((n.nspname='public' and p.proname in ('atlas_inventory_item_dependencies','atlas_set_inventory_item_active'))
      or (n.nspname='atlas_private' and p.proname in ('inventory_activation_actor_role','inventory_item_dependency_facts','inventory_item_dependencies','set_inventory_item_active'))
      or (n.nspname='private' and p.proname = 'inventory_item_active_audit'))
    and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))));

select jsonb_build_object(
  's88_inventory_activation', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s88_activation;

rollback;
