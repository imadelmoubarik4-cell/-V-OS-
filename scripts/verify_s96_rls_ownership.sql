-- S96 replay-level verification: RLS ownership, self-escalation and RPC authorization.
-- Rolled back. Run against a replayed database (optionally with the production-only legacy
-- tables recreated by scripts/s96_production_legacy_tables_fixture.sql BEFORE the S96
-- migrations, to mirror production):
--   psql -v ON_ERROR_STOP=1 -X -qAt -f scripts/verify_s96_rls_ownership.sql
--
-- Negative tests (must be rejected):
--   * a new sign-up is an inactive viewer whatever its user/app metadata says;
--   * sign-up, profile-less and deactivated sessions read no business rows and write nothing;
--   * a bartender cannot raise their own profiles.role / active flag;
--   * DBRLS-01: staff cannot mark their own onboarding tasks complete or forge completed_by;
--     a manager cannot attribute a completion to another manager;
--   * DBRLS-02: staff cannot write the legacy staff tables (own hourly_rate, back-dated
--     acknowledgements, availability, shifts);
--   * DBRLS-03: bartenders cannot write public.atlas_media rows;
--   * IDOR: a bartender cannot touch another user's rows;
--   * the 16 browser RPCs reject every non-manager caller;
--   * DBRLS-04: with purchase approval enabled, an order priced under the threshold and
--     received at a higher unit cost is rejected (approval bypass through the receipt price);
--   * DBRLS-05: managers cannot insert fabricated stock-ledger rows (inventory_movements);
--   * no public function is executable by anon; authenticated only the 16 reviewed RPCs.
-- Positive tests (must keep working): manager onboarding upsert, bartender reads of
-- shifts/own details, manager media writes, manager RPCs.
-- Each test reports ok, FAIL or not_applicable (legacy table absent in a clean replay); the
-- verdict key s96_rls_ownership is 'passed' only when no test reports FAIL.

begin;

create temporary table s96_rls (test_name text primary key, result text not null) on commit drop;
grant all on table s96_rls to public;

create role s96_rls_probe nologin;
grant authenticated to s96_rls_probe;
grant anon to s96_rls_probe;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(),
       u.app_meta::jsonb, u.user_meta::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-0000000a9601','s96-admin@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-0000000a9602','s96-mgr@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-0000000a9603','s96-mgr2@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-0000000a9604','s96-bar@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-0000000a9605','s96-bar2@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-0000000a9606','s96-viewer@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-0000000a9607','s96-gone@example.invalid','{}','{}'),
  ('00000000-0000-4000-8000-0000000a9608','s96-signup@example.invalid','{"role":"admin"}','{"full_name":"Owner","role":"admin","active":true}')
) as u(id, email, app_meta, user_meta);

insert into s96_rls select 'a sign-up with role/active metadata becomes an inactive viewer',
  case when exists (select 1 from public.profiles where id='00000000-0000-4000-8000-0000000a9608' and role::text='viewer' and active is false)
       then 'ok' else 'FAIL' end;

update public.profiles set role='admin', active=true where id='00000000-0000-4000-8000-0000000a9601';
update public.profiles set role='manager', active=true where id in ('00000000-0000-4000-8000-0000000a9602','00000000-0000-4000-8000-0000000a9603');
update public.profiles set role='bartender', active=true where id in ('00000000-0000-4000-8000-0000000a9604','00000000-0000-4000-8000-0000000a9605');
update public.profiles set role='viewer', active=true where id='00000000-0000-4000-8000-0000000a9606';
update public.profiles set role='manager', active=false where id='00000000-0000-4000-8000-0000000a9607';

insert into public.suppliers (id, name) values ('00000000-0000-4000-8000-0000000a9611','S96 supplier');
insert into public.inventory_items (id, name, quantity, unit, active, supplier_id)
  values ('00000000-0000-4000-8000-0000000a9612','S96 gin',0,'bottle',true,'00000000-0000-4000-8000-0000000a9611');
insert into public.recipes (id, name, yield_quantity) values ('00000000-0000-4000-8000-0000000a9613','S96 sour',1);
insert into public.atlas_media (id, entity_type, entity_id, storage_path, public_url, uploaded_by)
  values ('00000000-0000-4000-8000-0000000a9614','recipe','00000000-0000-4000-8000-0000000a9613','recipes/s96.jpg','https://example.invalid/s96.jpg','00000000-0000-4000-8000-0000000a9605');

do $seed$
begin
  if to_regclass('public.onboarding_progress') is not null then
    insert into public.onboarding_tasks (id, title) values ('00000000-0000-4000-8000-0000000a9621','S96 food safety');
    insert into public.onboarding_progress (task_id, user_id) values ('00000000-0000-4000-8000-0000000a9621','00000000-0000-4000-8000-0000000a9605');
  end if;
  if to_regclass('public.staff_details') is not null then
    insert into public.staff_details (user_id, hourly_rate, notes) values
      ('00000000-0000-4000-8000-0000000a9604', 20, 'manager note'),
      ('00000000-0000-4000-8000-0000000a9605', 20, 'manager note');
  end if;
  if to_regclass('public.shifts') is not null then
    insert into public.shifts (user_id, starts_at, ends_at) values ('00000000-0000-4000-8000-0000000a9604', now(), now() + interval '8 hours');
  end if;
  if to_regclass('public.staff_documents') is not null then
    insert into public.staff_documents (id, title) values ('00000000-0000-4000-8000-0000000a9622','S96 handbook');
  end if;
end
$seed$;

-- Purchase approval on (threshold 1000 ISK, separate approver) for the DBRLS-04 probes.
insert into atlas_private.settings_sections (section_key, label, settings_value)
values ('inventory', 'Inventory', '{"purchase_approval_required":true,"purchase_approval_threshold_isk":1000,"purchase_approval_separate_approver":true}')
on conflict (section_key) do update
  set settings_value = atlas_private.settings_sections.settings_value || excluded.settings_value;

set session authorization s96_rls_probe;

do $probe$
declare
  ok boolean;
  n integer;
  total integer;
  t text;
  who text;
  legacy boolean;
  item constant uuid := '00000000-0000-4000-8000-0000000a9612';
  admin_id constant uuid := '00000000-0000-4000-8000-0000000a9601';
  mgr constant uuid := '00000000-0000-4000-8000-0000000a9602';
  mgr2 constant uuid := '00000000-0000-4000-8000-0000000a9603';
  bar constant uuid := '00000000-0000-4000-8000-0000000a9604';
  bar2 constant uuid := '00000000-0000-4000-8000-0000000a9605';
  viewer constant uuid := '00000000-0000-4000-8000-0000000a9606';
  task constant uuid := '00000000-0000-4000-8000-0000000a9621';
  rpc text;
  rpcs constant text[] := array[
    $$select public.adjust_inventory('00000000-0000-4000-8000-0000000a9612', 1, 'restock')$$,
    $$select public.adjust_inventory_v2('s96-request-1', '00000000-0000-4000-8000-0000000a9612', 1, 'restock')$$,
    $$select public.atlas_apply_item_master_update('00000000-0000-4000-8000-0000000a9612', '{}'::jsonb, null, '{}'::jsonb, 's96')$$,
    $$select public.atlas_apply_par_levels('[{"item_id":"00000000-0000-4000-8000-0000000a9612","par_level":1,"expected_par_level":null}]'::jsonb, 's96-par')$$,
    $$select public.atlas_data_review_rows('missing_cost', 10, 0)$$,
    $$select public.atlas_data_review_summary()$$,
    $$select public.atlas_par_level_evidence(null, 7)$$,
    $$select public.atlas_purchase_order_command(gen_random_uuid(), 'create', null, '00000000-0000-4000-8000-0000000a9611', '[{"item_id":"00000000-0000-4000-8000-0000000a9612","quantity":1,"unit_cost":1}]'::jsonb, '')$$,
    $$select public.atlas_purchase_order_command_v2(gen_random_uuid(), 'create', null, '00000000-0000-4000-8000-0000000a9611', '[{"item_id":"00000000-0000-4000-8000-0000000a9612","quantity":1,"unit_cost":1}]'::jsonb, '', null, null, null, null)$$,
    $$select public.atlas_purchase_order_detail(gen_random_uuid())$$,
    $$select public.atlas_purchase_order_policy()$$,
    $$select public.atlas_save_recipe(null, '{"name":"x","yield_quantity":1}'::jsonb, '[]'::jsonb)$$,
    $$select public.atlas_inventory_location_save(null, 'S96X', 'S96 location')$$,
    $$select public.atlas_inventory_location_set_active(gen_random_uuid(), false)$$,
    $$select public.atlas_inventory_location_delete(gen_random_uuid())$$,
    $$select public.atlas_inventory_item_locations_set('00000000-0000-4000-8000-0000000a9612', array[]::uuid[], null)$$
  ];
begin
  set local role authenticated;

  -- Sign-up, profile-less and deactivated sessions: nothing readable, nothing writable.
  foreach who in array array['00000000-0000-4000-8000-0000000a9608','00000000-0000-4000-8000-00000000dead','00000000-0000-4000-8000-0000000a9607'] loop
    perform set_config('request.jwt.claim.sub', who, true);
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    total := 0;
    for t in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p')
               and has_table_privilege('authenticated', c.oid, 'SELECT') loop
      begin
        execute format('select count(*) from public.%I', t) into n;
      exception when insufficient_privilege or raise_exception then n := 0;
      end;
      total := total + n;
    end loop;
    insert into s96_rls values ('session ' || who || ' without an active profile reads no public rows', case when total = 0 then 'ok' else 'FAIL' end);
    ok := true;
    begin
      insert into public.suppliers (name) values ('s96 unauth');
      ok := false;
    exception when insufficient_privilege then null;
    end;
    update public.profiles set role = 'admin', active = true where id = who::uuid;
    get diagnostics n = row_count;
    insert into s96_rls values ('session ' || who || ' cannot write suppliers or activate itself', case when ok and n = 0 then 'ok' else 'FAIL' end);
  end loop;

  -- Bartender self-escalation and IDOR.
  perform set_config('request.jwt.claim.sub', bar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', bar, 'role', 'authenticated')::text, true);
  update public.profiles set role = 'admin' where id = bar;
  get diagnostics n = row_count;
  update public.profiles set active = true, role = 'manager' where id = viewer;
  get diagnostics total = row_count;
  insert into s96_rls values ('bartender cannot change own role or another profile', case when n = 0 and total = 0 then 'ok' else 'FAIL' end);

  update public.atlas_media set public_url = 'https://evil.invalid/x.jpg', is_primary = true where id = '00000000-0000-4000-8000-0000000a9614';
  get diagnostics n = row_count;
  delete from public.atlas_media where id = '00000000-0000-4000-8000-0000000a9614';
  get diagnostics total = row_count;
  insert into s96_rls values ('IDOR: bartender cannot change or delete another user''s media row', case when n = 0 and total = 0 then 'ok' else 'FAIL' end);

  ok := true;
  begin
    insert into public.atlas_media (entity_type, entity_id, storage_path, public_url, uploaded_by)
    values ('recipe', '00000000-0000-4000-8000-0000000a9613', 'x', 'javascript:alert(1)', bar);
    ok := false;
  exception when insufficient_privilege then null;
  end;
  insert into s96_rls values ('DBRLS-03: bartender cannot insert atlas_media rows', case when ok then 'ok' else 'FAIL' end);

  legacy := to_regclass('public.onboarding_progress') is not null;
  if legacy then
    ok := true;
    begin
      insert into public.onboarding_progress (task_id, user_id, completed_at, completed_by) values (task, bar, now(), mgr);
      ok := false;
    exception when insufficient_privilege then null;
    end;
    update public.onboarding_progress set completed_at = now(), completed_by = mgr where user_id = bar;
    get diagnostics n = row_count;
    insert into s96_rls values ('DBRLS-01: bartender cannot self-complete onboarding or forge completed_by', case when ok and n = 0 then 'ok' else 'FAIL' end);
    ok := true;
    begin
      insert into public.onboarding_progress (task_id, user_id, completed_at, completed_by) values (task, bar2, now(), bar);
      ok := false;
    exception when insufficient_privilege then null;
    end;
    update public.onboarding_progress set completed_at = now() where user_id = bar2;
    get diagnostics n = row_count;
    insert into s96_rls values ('IDOR: bartender cannot write another user''s onboarding progress', case when ok and n = 0 then 'ok' else 'FAIL' end);
  else
    insert into s96_rls values ('DBRLS-01: bartender cannot self-complete onboarding or forge completed_by', 'not_applicable');
    insert into s96_rls values ('IDOR: bartender cannot write another user''s onboarding progress', 'not_applicable');
  end if;

  if to_regclass('public.staff_details') is not null then
    ok := true;
    begin
      update public.staff_details set hourly_rate = 999, notes = 'self-approved' where user_id = bar;
      get diagnostics n = row_count;
      ok := n = 0;
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.staff_availability (user_id, weekday) values (bar, 2);
      ok := false;
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.document_acknowledgements (document_id, user_id, acknowledged_at) values ('00000000-0000-4000-8000-0000000a9622', bar, '2020-01-01');
      ok := false;
    exception when insufficient_privilege then null;
    end;
    begin
      update public.shifts set status = 'confirmed' where user_id = bar;
      get diagnostics n = row_count;
      ok := ok and n = 0;
    exception when insufficient_privilege then null;
    end;
    insert into s96_rls values ('DBRLS-02: bartender cannot write legacy staff tables (own hourly_rate, availability, back-dated acknowledgement, shifts)', case when ok then 'ok' else 'FAIL' end);
    select count(*) into n from public.shifts;
    select count(*) into total from public.staff_details;
    insert into s96_rls values ('bartender still reads shifts and only their own staff details', case when n >= 1 and total = 1 then 'ok' else 'FAIL' end);
  else
    insert into s96_rls values ('DBRLS-02: bartender cannot write legacy staff tables (own hourly_rate, availability, back-dated acknowledgement, shifts)', 'not_applicable');
    insert into s96_rls values ('bartender still reads shifts and only their own staff details', 'not_applicable');
  end if;

  -- Browser RPCs reject every non-manager caller.
  foreach who in array array[bar::text, viewer::text, '00000000-0000-4000-8000-0000000a9608', '00000000-0000-4000-8000-0000000a9607'] loop
    perform set_config('request.jwt.claim.sub', who, true);
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    ok := true;
    foreach rpc in array rpcs loop
      begin
        execute rpc;
        ok := false;
      exception when insufficient_privilege then null;
      end;
    end loop;
    insert into s96_rls values ('the 16 browser RPCs reject non-manager ' || who, case when ok then 'ok' else 'FAIL' end);
  end loop;

  -- Legitimate manager paths keep working.
  perform set_config('request.jwt.claim.sub', mgr::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  insert into public.atlas_media (entity_type, entity_id, storage_path, public_url, uploaded_by)
    values ('recipe', '00000000-0000-4000-8000-0000000a9613', 'recipes/mgr.jpg', 'https://example.invalid/mgr.jpg', mgr);
  update public.atlas_media set is_primary = true where id = '00000000-0000-4000-8000-0000000a9614';
  get diagnostics n = row_count;
  insert into s96_rls values ('manager can add and update atlas_media rows', case when n = 1 then 'ok' else 'FAIL' end);
  perform public.atlas_purchase_order_policy();
  perform public.adjust_inventory_v2('s96-request-mgr', item, 1, 'restock');
  insert into s96_rls values ('manager RPCs still work', 'ok');

  ok := true;
  begin
    insert into public.inventory_movements (item_id, item_name, movement_type, quantity_change, unit_cost, total_cost)
    values (item, 'S96 gin', 'restock', 100, 1, 100);
    ok := false;
  exception when insufficient_privilege then null;
  end;
  insert into s96_rls values ('DBRLS-05: manager cannot insert fabricated stock-ledger rows', case when ok then 'ok' else 'FAIL' end);

  -- DBRLS-04: under-priced order, placed without approval, received at the real price.
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-0000000a9631', 'create', null,
    '00000000-0000-4000-8000-0000000a9611', '[{"item_id":"00000000-0000-4000-8000-0000000a9612","quantity":10,"unit_cost":1}]'::jsonb, '', null, null, null, null);
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-0000000a9631', 'place', 1, null, null, null, null, null, null, null);
  ok := true;
  begin
    perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-0000000a9631', 'receive_lines', 2, null, null, null, null,
      '[{"item_id":"00000000-0000-4000-8000-0000000a9612","quantity":10,"unit_cost":500}]'::jsonb, 's96-receipt-1', null);
    ok := false;
  exception when insufficient_privilege then null;
  end;
  insert into s96_rls values ('DBRLS-04: receipt price cannot lift an unapproved order over the approval threshold', case when ok then 'ok' else 'FAIL' end);
  if ok then
    perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-0000000a9631', 'receive_lines', 2, null, null, null, null,
      '[{"item_id":"00000000-0000-4000-8000-0000000a9612","quantity":10,"unit_cost":1}]'::jsonb, 's96-receipt-2', null);
    select count(*) into n from public.purchase_order_receipts where order_id = '00000000-0000-4000-8000-0000000a9631' and unit_cost = 1;
    insert into s96_rls values ('receiving at the ordered cost still works', case when n = 1 then 'ok' else 'FAIL' end);
  else
    insert into s96_rls values ('receiving at the ordered cost still works', 'not_applicable');
  end if;

  -- Honest path: order at the real price is submitted, approved by another manager, received.
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-0000000a9632', 'create', null,
    '00000000-0000-4000-8000-0000000a9611', '[{"item_id":"00000000-0000-4000-8000-0000000a9612","quantity":10,"unit_cost":500}]'::jsonb, '', null, null, null, null);
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-0000000a9632', 'submit', 1, null, null, null, null, null, null, null);
  perform set_config('request.jwt.claim.sub', mgr2::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', mgr2, 'role', 'authenticated')::text, true);
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-0000000a9632', 'approve', 2, null, null, null, null, null, null, null);
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-0000000a9632', 'place', 3, null, null, null, null, null, null, null);
  perform public.atlas_purchase_order_command_v2('00000000-0000-4000-8000-0000000a9632', 'receive_lines', 4, null, null, null, null,
    '[{"item_id":"00000000-0000-4000-8000-0000000a9612","quantity":10,"unit_cost":500}]'::jsonb, 's96-receipt-3', null);
  select count(*) into n from public.purchase_order_receipts where order_id = '00000000-0000-4000-8000-0000000a9632';
  insert into s96_rls values ('approved orders are received at the approved cost', case when n = 1 then 'ok' else 'FAIL' end);
  perform set_config('request.jwt.claim.sub', mgr::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);

  if legacy then
    insert into public.onboarding_progress (task_id, user_id, completed_at, completed_by, note)
    values (task, bar2, now(), mgr, 'checked')
    on conflict (task_id, user_id) do update set completed_at = excluded.completed_at, completed_by = excluded.completed_by, note = excluded.note;
    select count(*) into n from public.onboarding_progress where user_id = bar2 and completed_by = mgr;
    insert into s96_rls values ('manager can upsert onboarding completion (atlas-team-profiles path)', case when n = 1 then 'ok' else 'FAIL' end);
    ok := true;
    begin
      insert into public.onboarding_progress (task_id, user_id, completed_at, completed_by) values (task, viewer, now(), mgr2);
      ok := false;
    exception when insufficient_privilege then null;
    end;
    insert into s96_rls values ('DBRLS-01: manager cannot attribute a completion to another manager', case when ok then 'ok' else 'FAIL' end);
  else
    insert into s96_rls values ('manager can upsert onboarding completion (atlas-team-profiles path)', 'not_applicable');
    insert into s96_rls values ('DBRLS-01: manager cannot attribute a completion to another manager', 'not_applicable');
  end if;
end
$probe$;

reset role;
reset session authorization;

insert into s96_rls select 'no public function is executable by anon',
  case when not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and has_function_privilege('anon', p.oid, 'EXECUTE')) then 'ok' else 'FAIL' end;
insert into s96_rls select 'authenticated executes only the 16 reviewed public RPCs, all SECURITY INVOKER',
  case when not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and (p.prosecdef or p.proname not in ('adjust_inventory','adjust_inventory_v2','atlas_apply_item_master_update',
      'atlas_apply_par_levels','atlas_data_review_rows','atlas_data_review_summary','atlas_par_level_evidence',
      'atlas_purchase_order_command','atlas_purchase_order_command_v2','atlas_purchase_order_detail',
      'atlas_purchase_order_policy','atlas_save_recipe',
      'atlas_inventory_location_save','atlas_inventory_location_set_active','atlas_inventory_location_delete',
      'atlas_inventory_item_locations_set'))) then 'ok' else 'FAIL' end;
insert into s96_rls select 'every SECURITY DEFINER function in public/atlas_private/private pins search_path',
  case when not exists (select 1 from pg_proc p where p.prosecdef
    and p.pronamespace in ('public'::regnamespace, 'atlas_private'::regnamespace, 'private'::regnamespace)
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then 'ok' else 'FAIL' end;
insert into s96_rls select 'every public table has RLS enabled',
  case when not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
    and not c.relrowsecurity) then 'ok' else 'FAIL' end;
insert into s96_rls select 'every public view granted to browser roles is security_invoker',
  case when not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
    and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT'))
    and not coalesce('security_invoker=true' = any(c.reloptions), false)) then 'ok' else 'FAIL' end;

select jsonb_build_object(
  's96_rls_ownership', case when bool_and(result in ('ok','not_applicable')) then 'passed' else 'failed' end,
  'ok_count', count(*) filter (where result = 'ok'),
  'fail_count', count(*) filter (where result = 'FAIL'),
  'not_applicable_count', count(*) filter (where result = 'not_applicable'),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'result', result) order by test_name)
) from s96_rls;

rollback;
