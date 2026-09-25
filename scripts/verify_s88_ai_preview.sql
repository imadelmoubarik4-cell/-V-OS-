-- S88 preview-only Atlas AI data acceptance.
--
-- Requires an isolated replay database with the S88 migrations applied
-- (scripts/verify_full_migration_replay.sh). Seeds a manager, a bartender and
-- a deactivated user inside one transaction, proves the browser boundary,
-- ownership, proposal lifecycle, Brain recording, Knowledge visibility,
-- conversation search, media purge and rate limit, prints one JSON verdict
-- and rolls everything back.

begin;

create temporary table s88_ai (test_name text primary key, passed boolean not null, detail text) on commit drop;
grant all on table s88_ai to service_role, authenticated, anon;

-- Runs dynamic SQL as the current role and returns 'ok' or the SQLSTATE.
create function public.s88_expect(p_sql text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;
grant execute on function public.s88_expect(text) to service_role, authenticated, anon;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), id, 'authenticated','authenticated', email,'',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from (values
  ('00000000-0000-4000-8000-000000088801'::uuid,'s88-mgr@example.invalid'),
  ('00000000-0000-4000-8000-000000088802'::uuid,'s88-bar@example.invalid'),
  ('00000000-0000-4000-8000-000000088803'::uuid,'s88-gone@example.invalid')) v(id,email);
update public.profiles set role='manager', active=true, display_name='S88 Manager' where id='00000000-0000-4000-8000-000000088801';
update public.profiles set role='bartender', active=true, display_name='S88 Bartender' where id='00000000-0000-4000-8000-000000088802';
update public.profiles set role='bartender', active=false, display_name='S88 Former' where id='00000000-0000-4000-8000-000000088803';

-- 1. Static boundary: RLS, table grants, function grants, bucket -------------

insert into s88_ai
select 'every ai_* table has RLS and no anon/authenticated/public privilege',
  bool_and(c.relrowsecurity
    and not has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')
    and not has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate,references,trigger')
    and has_table_privilege('service_role', c.oid, 'select,insert,update,delete'))
  -- 8 S88 tables + ai_voice_sessions and ai_rate_events (20260926106000_s88_ai_hardening.sql)
  and count(*) = 10,
  string_agg(c.relname, ',' order by c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'atlas_private' and c.relkind = 'r' and c.relname like 'ai\_%';

insert into s88_ai
select 'every atlas_ai_* RPC and atlas_knowledge_search is service-role only, invoker, search_path pinned',
  bool_and(not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl where acl.grantee = 0)
    and has_function_privilege('service_role', p.oid, 'execute')
    and not p.prosecdef
    and coalesce(p.proconfig @> array['search_path=""'], false))
  -- 31 data-layer RPCs + atlas_ai_signals_upsert (20260926105000_s88_ai_signals.sql)
  -- + atlas_ai_voice_session_start/_touch (20260926106000_s88_ai_hardening.sql)
  and count(*) = 34,
  count(*)::text || ' functions'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and (p.proname like 'atlas\_ai\_%' or p.proname = 'atlas_knowledge_search');

insert into s88_ai
select 'atlas_private ai helpers are not executable by browser roles',
  bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')),
  count(*)::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'atlas_private' and (p.proname like 'ai\_%' or p.proname = 'knowledge_version_search_document');

insert into s88_ai
select 'atlas-ai-media bucket is private, 25 MB, exact MIME allow-list, and has no object policies',
  b.public is false and b.file_size_limit = 26214400
  and b.allowed_mime_types @> array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf','text/plain','text/csv','audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav']
  and cardinality(b.allowed_mime_types) = 13
  and not exists (select 1 from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'
    and (coalesce(p.qual,'') like '%atlas-ai-media%' or coalesce(p.with_check,'') like '%atlas-ai-media%')),
  null
from storage.buckets b where b.id = 'atlas-ai-media';

-- 2. Browser roles cannot reach the tables or RPCs -------------------------------

-- Supabase grants these storage privileges; the replay bootstrap does not.
grant select, insert, update, delete on table storage.objects to authenticated;
insert into storage.objects (id, bucket_id, name)
values ('00000000-0000-4000-8000-000000088901', 'atlas-ai-media',
  '00000000-0000-4000-8000-000000088801/unsorted/00000000-0000-4000-8000-000000088902.jpg');

create role s88_ai_probe nologin;
grant authenticated, anon to s88_ai_probe;
set session authorization s88_ai_probe;

do $browser$
declare
  v_role text;
  v_sql text;
  v_state text;
  v_denied boolean;
  v_all boolean;
  v_fn record;
begin
  foreach v_role in array array['authenticated','anon'] loop
    execute format('set local role %I', v_role);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000088801', true);
    perform set_config('request.jwt.claim.role', v_role, true);

    v_all := true;
    foreach v_sql in array array[
      'select count(*) from atlas_private.ai_conversations',
      'select count(*) from atlas_private.ai_messages',
      'select count(*) from atlas_private.ai_runs',
      'select count(*) from atlas_private.ai_tool_calls',
      'select count(*) from atlas_private.ai_actions',
      'select count(*) from atlas_private.ai_media',
      'select count(*) from atlas_private.ai_user_preferences',
      'select count(*) from atlas_private.ai_settings',
      'select count(*) from atlas_private.ai_voice_sessions',
      'select count(*) from atlas_private.ai_rate_events',
      'insert into atlas_private.ai_conversations (user_id) values (''00000000-0000-4000-8000-000000088801'')',
      'insert into atlas_private.ai_messages (conversation_id, role) values (gen_random_uuid(), ''user'')',
      'insert into atlas_private.ai_actions (user_id, role_at_proposal, kind, title, command) values (''00000000-0000-4000-8000-000000088801'', ''manager'', ''x.y'', ''t'', ''{"a":1}'')',
      'update atlas_private.ai_settings set enabled = true'
    ] loop
      v_state := public.s88_expect(v_sql);
      if v_state <> '42501' then v_all := false; raise notice '% % -> %', v_role, v_sql, v_state; end if;
    end loop;
    insert into s88_ai values (v_role || ' cannot select or write any ai_* table', v_all, null);

    v_all := true;
    for v_fn in
      select p.proname, p.pronargs
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and (p.proname like 'atlas\_ai\_%' or p.proname = 'atlas_knowledge_search')
    loop
      v_sql := format('select public.%I(%s)', v_fn.proname,
        (select coalesce(string_agg('null', ','), '') from generate_series(1, v_fn.pronargs)));
      v_state := public.s88_expect(v_sql);
      if v_state <> '42501' then v_all := false; raise notice '% % -> %', v_role, v_sql, v_state; end if;
    end loop;
    insert into s88_ai values (v_role || ' cannot execute any atlas_ai_* RPC or atlas_knowledge_search', v_all, null);
  end loop;

  execute 'set local role authenticated';
  v_denied := public.s88_expect('insert into storage.objects (bucket_id, name) values (''atlas-ai-media'', ''00000000-0000-4000-8000-000000088801/unsorted/00000000-0000-4000-8000-000000088903.jpg'')') = '42501';
  insert into s88_ai values ('signed-in users cannot upload to or list atlas-ai-media directly',
    v_denied and not exists (select 1 from storage.objects where bucket_id = 'atlas-ai-media'), null);
end
$browser$;

reset role;
reset session authorization;

-- 3. Service-role behaviour -----------------------------------------------------------

set role service_role;

do $service$
declare
  mgr uuid := '00000000-0000-4000-8000-000000088801';
  bar uuid := '00000000-0000-4000-8000-000000088802';
  gone uuid := '00000000-0000-4000-8000-000000088803';
  mgr_conv uuid; bar_conv uuid; bar_conv2 uuid; other_conv uuid;
  r jsonb; r2 jsonb; list jsonb;
  msg_id uuid;
  a_mgr_only uuid; a_expiring uuid; a_rejected uuid; a_mgr uuid;
  rec uuid; rec2 uuid;
  category uuid := (select id from atlas_private.knowledge_categories order by sort_order nulls last, id limit 1);
  published_id uuid; draft_id uuid; mgr_only_id uuid; retired_id uuid;
  staff jsonb; manager_k jsonb;
  m_old uuid; m_new uuid; m_conv_media uuid;
  run1 uuid;
  state text;
  cmd jsonb := '{"action":"atlas_purchase_order_command","args":{"p_action":"create","p_lines":[{"item":"S88-PINOT","qty":3}]}}';
begin
  -- Actor verification
  insert into s88_ai values ('deactivated user is refused by every actor-checked RPC',
    public.s88_expect(format('select public.atlas_ai_conversation_create(%L,%L,%L)', gone, 'bartender', 'x')) = '42501'
    and public.s88_expect(format('select public.atlas_ai_conversations_list(%L,%L)', gone, 'bartender')) = '42501'
    and public.s88_expect(format('select public.atlas_knowledge_search(%L,%L,%L,5)', 'pinot', gone, 'bartender')) = '42501', null);
  insert into s88_ai values ('a claimed role that differs from the profile role is refused',
    public.s88_expect(format('select public.atlas_ai_conversation_create(%L,%L,%L)', bar, 'manager', 'x')) = '42501'
    and public.s88_expect(format('select public.atlas_ai_settings_set(%L,%L,%L)', bar, 'admin', '{"enabled":true}')) = '42501', null);

  -- Conversations and ownership
  mgr_conv := (public.atlas_ai_conversation_create(mgr, 'manager', null, '{}'::jsonb)->>'id')::uuid;
  bar_conv := (public.atlas_ai_conversation_create(bar, 'bartender', 'Closing checklist', '{}'::jsonb)->>'id')::uuid;
  bar_conv2 := (public.atlas_ai_conversation_create(bar, 'bartender', 'Pinned rota question', '{}'::jsonb)->>'id')::uuid;

  r := public.atlas_ai_messages_append(mgr_conv, mgr, 'manager', jsonb_build_array(
    jsonb_build_object('role','user','content','Does the Angelo Pinot Grigio delivery match Friday''s order?','client_request_id','s88-req-0001'),
    jsonb_build_object('role','assistant','content','Three cases of Pinot Grigio were ordered; two arrived.','evidence', jsonb_build_array(jsonb_build_object('kind','fact','label','Ordered','value','3 cases')))));
  msg_id := (r->'messages'->0->>'id')::uuid;
  r2 := public.atlas_ai_messages_append(mgr_conv, mgr, 'manager', jsonb_build_array(
    jsonb_build_object('role','user','content','Does the Angelo Pinot Grigio delivery match Friday''s order?','client_request_id','s88-req-0001')));
  insert into s88_ai values ('append is idempotent per client_request_id',
    (r->'messages'->0->>'created')::boolean and not (r2->'messages'->0->>'created')::boolean
    and r2->'messages'->0->>'id' = msg_id::text
    and (select count(*) from atlas_private.ai_messages where conversation_id = mgr_conv) = 2,
    r2::text);
  insert into s88_ai values ('first user message titles a new conversation and messages keep order',
    r->>'title' like 'Does the Angelo Pinot Grigio%'
    and (public.atlas_ai_conversation_get(mgr_conv, mgr, 'manager', 50, null, false)->'messages'->0->>'role') = 'user'
    and (public.atlas_ai_conversation_get(mgr_conv, mgr, 'manager', 50, null, false)->'messages'->1->>'role') = 'assistant', r->>'title');

  insert into s88_ai values ('bartender cannot read, rename, pin, append to, change context of or delete the manager''s conversation',
    public.s88_expect(format('select public.atlas_ai_conversation_get(%L,%L,%L)', mgr_conv, bar, 'bartender')) = 'P0002'
    and public.s88_expect(format('select public.atlas_ai_conversation_rename(%L,%L,%L,%L)', mgr_conv, bar, 'bartender', 'mine now')) = 'P0002'
    and public.s88_expect(format('select public.atlas_ai_conversation_pin(%L,%L,%L,true)', mgr_conv, bar, 'bartender')) = 'P0002'
    and public.s88_expect(format('select public.atlas_ai_conversation_archive(%L,%L,%L,true)', mgr_conv, bar, 'bartender')) = 'P0002'
    and public.s88_expect(format('select public.atlas_ai_messages_append(%L,%L,%L,%L)', mgr_conv, bar, 'bartender', '[{"role":"user","content":"hi"}]')) = 'P0002'
    and public.s88_expect(format('select public.atlas_ai_conversation_context_merge(%L,%L,%L,%L)', mgr_conv, bar, 'bartender', '{"x":1}')) = 'P0002'
    and public.s88_expect(format('select public.atlas_ai_message_update(%L,%L,%L,%L)', msg_id, bar, 'bartender', '{"content":"x"}')) = 'P0002'
    and public.s88_expect(format('select public.atlas_ai_conversation_delete(%L,%L,%L)', mgr_conv, bar, 'bartender')) = 'P0002'
    and (select title from atlas_private.ai_conversations where id = mgr_conv) like 'Does the Angelo%'
    and (select count(*) from atlas_private.ai_messages where conversation_id = mgr_conv) = 2, null);
  insert into s88_ai values ('a manager cannot read a bartender''s conversation either',
    public.s88_expect(format('select public.atlas_ai_conversation_get(%L,%L,%L)', bar_conv, mgr, 'manager')) = 'P0002'
    and not (public.atlas_ai_conversations_list(mgr, 'manager', null, true, 100, 0)->'conversations')::text like '%' || bar_conv::text || '%', null);

  perform public.atlas_ai_conversation_pin(bar_conv2, bar, 'bartender', true);
  list := public.atlas_ai_conversations_list(bar, 'bartender', null, false, 30, 0);
  insert into s88_ai values ('list shows only own conversations, pinned first',
    (list->>'total')::int = 2 and list->'conversations'->0->>'id' = bar_conv2::text
    and (list->'conversations'->0->>'pinned')::boolean
    and list::text not like '%' || mgr_conv::text || '%', list::text);

  -- Full-text search
  list := public.atlas_ai_conversations_list(mgr, 'manager', 'pinot', false, 30, 0);
  r := public.atlas_ai_conversations_list(mgr, 'manager', 'grig deliv', false, 30, 0);
  r2 := public.atlas_ai_conversations_list(bar, 'bartender', 'pinot', false, 30, 0);
  insert into s88_ai values ('full-text conversation search matches message text with prefixes, owner only',
    (list->>'total')::int = 1 and list->'conversations'->0->>'id' = mgr_conv::text
    and list->'conversations'->0->>'snippet' like '%**%'
    and (r->>'total')::int = 1
    and (r2->>'total')::int = 0
    and (public.atlas_ai_conversations_list(bar, 'bartender', 'closing', false, 30, 0)->>'total')::int = 1
    and (public.atlas_ai_conversations_list(mgr, 'manager', 'zzzqqq', false, 30, 0)->>'total')::int = 0, list::text);

  perform public.atlas_ai_conversation_archive(bar_conv, bar, 'bartender', true);
  insert into s88_ai values ('archived conversations leave the default list',
    (public.atlas_ai_conversations_list(bar, 'bartender', null, false, 30, 0)->>'total')::int = 1
    and (public.atlas_ai_conversations_list(bar, 'bartender', null, true, 30, 0)->>'total')::int = 2, null);
  perform public.atlas_ai_conversation_archive(bar_conv, bar, 'bartender', false);

  r := public.atlas_ai_conversation_context_merge(bar_conv, bar, 'bartender', '{"focus_date":"2026-09-26","filters":{"category":"wine"}}');
  r := public.atlas_ai_conversation_context_merge(bar_conv, bar, 'bartender', '{"focus_date":null,"last_records":[{"type":"recipe","id":"r1"}]}');
  insert into s88_ai values ('context merge is shallow and null removes a key',
    not (r->'context' ? 'focus_date') and r->'context'->'filters'->>'category' = 'wine' and r->'context' ? 'last_records', r::text);

  -- Action proposals
  a_mgr_only := (public.atlas_ai_action_create(bar, 'bartender', bar_conv, null, 'purchase_order.create',
    'Order 3 cases of Pinot Grigio', '{"summary":"Draft purchase order for Angelo Pinot Grigio"}'::jsonb, cmd,
    array['admin','manager'], 86400)->>'id')::uuid;
  insert into s88_ai values ('bartender cannot approve a proposal whose required_roles is manager',
    public.s88_expect(format('select public.atlas_ai_action_transition(%L,%L,%L,%L)', a_mgr_only, 'executing', bar, 'bartender')) = '42501'
    and (select status from atlas_private.ai_actions where id = a_mgr_only) = 'proposed', null);

  r := public.atlas_ai_record_proposal(a_mgr_only, bar, 'bartender',
    '[{"tool":"purchasing.suggestions","label":"Below par","kind":"calculation","value":"2 of 6","source":{"type":"inventory_item","id":"item-1","label":"Angelo Pinot Grigio"}},{"tool":"inventory.current_stock","label":"No verified count","kind":"missing"}]'::jsonb,
    'inventory_item', 'item-1', null);
  rec := (r->>'brain_recommendation_id')::uuid;
  r2 := public.atlas_ai_record_proposal(a_mgr_only, bar, 'bartender', '[]'::jsonb, null, null, null);
  insert into s88_ai values ('proposal is recorded once as a shadow assistant Brain recommendation with atlas_ai_tool evidence',
    rec is not null and (r->>'created')::boolean and not (r2->>'created')::boolean and (r2->>'brain_recommendation_id')::uuid = rec
    and exists (select 1 from atlas_private.brain_recommendations b where b.id = rec and b.shadow_mode is true
      and b.recommendation_type = 'assistant' and b.generated_by like 'atlas-ai%' and b.status = 'active'
      and b.recommendation_key = 'atlas-ai:action:' || a_mgr_only and b.subject_key = 'item-1')
    and (select count(*) from atlas_private.brain_recommendation_evidence e where e.recommendation_id = rec and e.source_kind = 'atlas_ai_tool') = 3
    and (select brain_recommendation_id from atlas_private.ai_actions where id = a_mgr_only) = rec, r::text);

  insert into s88_ai values ('a Brain decision is refused until the matching transition happened',
    public.s88_expect(format('select public.atlas_ai_record_decision(%L,%L,%L,%L)', a_mgr_only, 'approve', mgr, 'manager')) = '55000', null);

  r := public.atlas_ai_action_transition(a_mgr_only, 'executing', mgr, 'manager', null, null);
  state := public.s88_expect(format('select public.atlas_ai_action_transition(%L,%L,%L,%L)', a_mgr_only, 'executing', mgr, 'manager'));
  insert into s88_ai values ('approval is single-use and returns the stored command',
    r->'command' = cmd and r->'action'->>'status' = 'executing' and r->>'previous_status' = 'proposed'
    and state = '55000', state);
  insert into s88_ai values ('only the approving user can finish an executing proposal',
    public.s88_expect(format('select public.atlas_ai_action_transition(%L,%L,%L,%L)', a_mgr_only, 'executed', bar, 'bartender')) = '42501', null);
  r := public.atlas_ai_action_transition(a_mgr_only, 'executed', mgr, 'manager', '{"purchase_order_id":"po-1"}'::jsonb, null);
  insert into s88_ai values ('executing → executed stores the result and cannot repeat',
    r->'action'->>'status' = 'executed' and r->'action'->'result'->>'purchase_order_id' = 'po-1' and r->'command' = 'null'::jsonb
    and public.s88_expect(format('select public.atlas_ai_action_transition(%L,%L,%L,%L)', a_mgr_only, 'executed', mgr, 'manager')) = '55000', null);

  r := public.atlas_ai_record_decision(a_mgr_only, 'approve', mgr, 'manager', 'Delivery short by one case');
  r2 := public.atlas_ai_record_decision(a_mgr_only, 'approve', mgr, 'manager', null);
  insert into s88_ai values ('approval is written to brain_decisions through the Brain decide function, idempotently',
    not (r->>'idempotent')::boolean and (r2->>'idempotent')::boolean
    and (select count(*) from atlas_private.brain_decisions d where d.recommendation_id = rec) = 1
    and exists (select 1 from atlas_private.brain_decisions d where d.recommendation_id = rec and d.decision = 'accept'
      and d.decided_by = mgr and d.decided_by_label = 'S88 Manager' and d.reason_code = 'atlas_ai_approve')
    and (select status from atlas_private.brain_recommendations where id = rec) = 'accepted'
    and (select shadow_mode from atlas_private.brain_recommendations where id = rec), r::text);

  a_rejected := (public.atlas_ai_action_create(bar, 'bartender', bar_conv, null, 'team_message.send',
    'Tell the team the fridge is fixed', '{}'::jsonb, '{"channel_key":"general","body":"Fridge fixed"}'::jsonb,
    array['admin','bartender','manager'], 86400)->>'id')::uuid;
  perform public.atlas_ai_record_proposal(a_rejected, bar, 'bartender', '[]'::jsonb, null, null, null);
  r := public.atlas_ai_action_transition(a_rejected, 'rejected', bar, 'bartender', null, 'Not needed');
  r2 := public.atlas_ai_record_decision(a_rejected, 'reject', bar, 'bartender', null);
  insert into s88_ai values ('rejection is final and recorded as a Brain reject decision',
    r->'action'->>'status' = 'rejected'
    and public.s88_expect(format('select public.atlas_ai_action_transition(%L,%L,%L,%L)', a_rejected, 'executing', bar, 'bartender')) = '55000'
    and exists (select 1 from atlas_private.brain_decisions d join atlas_private.ai_actions a on a.brain_recommendation_id = d.recommendation_id
      where a.id = a_rejected and d.decision = 'reject' and d.decided_by = bar), r2::text);

  a_expiring := (public.atlas_ai_action_create(bar, 'bartender', bar_conv, null, 'stock_count.draft',
    'Save a count draft', '{}'::jsonb, '{"action":"stock_count_draft"}'::jsonb, array['admin','bartender','manager'], 3600)->>'id')::uuid;
  perform public.atlas_ai_record_proposal(a_expiring, bar, 'bartender', '[]'::jsonb, null, null, null);
  update atlas_private.ai_actions set expires_at = pg_catalog.now() - interval '1 minute' where id = a_expiring;
  state := public.s88_expect(format('select public.atlas_ai_action_transition(%L,%L,%L,%L)', a_expiring, 'executing', bar, 'bartender'));
  r := public.atlas_ai_actions_expire();
  insert into s88_ai values ('expired proposals cannot be approved and the expiry job closes them and their Brain row',
    state = '55000' and (r->>'expired')::int >= 1
    and (select status from atlas_private.ai_actions where id = a_expiring) = 'expired'
    and (select b.status from atlas_private.brain_recommendations b join atlas_private.ai_actions a on a.brain_recommendation_id = b.id where a.id = a_expiring) = 'expired', r::text);

  a_mgr := (public.atlas_ai_action_create(mgr, 'manager', mgr_conv, msg_id, 'shift.draft', 'Draft Friday shift', '{}'::jsonb,
    '{"action":"shift_draft"}'::jsonb, array['admin','manager'], 86400)->>'id')::uuid;
  insert into s88_ai values ('staff cannot read, approve or reject another user''s proposal',
    public.s88_expect(format('select public.atlas_ai_action_get(%L,%L,%L)', a_mgr, bar, 'bartender')) = 'P0002'
    and public.s88_expect(format('select public.atlas_ai_action_transition(%L,%L,%L,%L)', a_mgr, 'rejected', bar, 'bartender')) = 'P0002'
    and public.s88_expect(format('select public.atlas_ai_record_proposal(%L,%L,%L)', a_mgr, bar, 'bartender')) = 'P0002'
    and public.s88_expect(format('select public.atlas_ai_action_create(%L,%L,%L,%L,%L,%L,%L,%L)', bar, 'bartender', bar_conv, msg_id, 'x.y', 't', '{}', '{"a":1}')) = '22023', null);

  -- Decision memory
  r := public.atlas_ai_memory_search('pinot grigio', 10, 'manager', mgr);
  insert into s88_ai values ('manager free-text decision memory finds the approval; staff are refused',
    jsonb_array_length(r) >= 1 and r::text like '%Order 3 cases of Pinot Grigio%'
    and public.s88_expect(format('select public.atlas_ai_memory_search(%L,10,%L,%L)', 'pinot', 'bartender', bar)) = '42501'
    and public.s88_expect(format('select public.atlas_ai_memory_search(%L,10,%L)', 'pinot', 'bartender')) = '42501'
    and jsonb_array_length(public.atlas_phase3_memory_search('inventory_item', 'item-1', 10)) = 1, r::text);

  -- Knowledge visibility matrix
  r := public.atlas_knowledge_save_draft(null,'s88-published',category,'sop','S88 espresso machine cleaning','Daily espresso backflush','PUBLISHED-BODY backflush the espresso group heads with detergent',false,array['all'],null,'first',mgr,'Manager','manager');
  published_id := coalesce((r->>'id')::uuid, (r->'article'->>'id')::uuid);
  perform public.atlas_knowledge_publish(published_id,'publish',mgr,'Manager','manager');
  perform public.atlas_knowledge_save_draft(published_id,'s88-published',category,'sop','S88 espresso machine cleaning','Daily espresso backflush','UNPUBLISHEDSECRET espresso descaling change',false,array['all'],null,'edit',mgr,'Manager','manager');
  r := public.atlas_knowledge_save_draft(null,'s88-draft',category,'policy','S88 DRAFTONLYTITLE espresso pricing','Draft summary','DRAFTONLYBODY espresso',false,array['all'],null,'draft',mgr,'Manager','manager');
  draft_id := coalesce((r->>'id')::uuid, (r->'article'->>'id')::uuid);
  r := public.atlas_knowledge_save_draft(null,'s88-managers',category,'policy','S88 MANAGERONLY espresso margins','Managers only','MANAGERONLYBODY espresso cost',false,array['manager'],null,'first',mgr,'Manager','manager');
  mgr_only_id := coalesce((r->>'id')::uuid, (r->'article'->>'id')::uuid);
  perform public.atlas_knowledge_publish(mgr_only_id,'publish',mgr,'Manager','manager');
  perform public.atlas_knowledge_save_source(null,published_id,'google_drive','Drive folder','ref','https://drive.example.invalid/PRIVATESOURCEURL',null,'manual_reference',true,'{}'::jsonb,mgr,'Manager','manager');

  staff := public.atlas_knowledge_search('espresso', bar, 'bartender', 10);
  manager_k := public.atlas_knowledge_search('espresso', mgr, 'manager', 10);
  insert into s88_ai values ('staff Knowledge search returns only the published, targeted version',
    (staff->>'count')::int = 1 and staff->'results'->0->>'article_id' = published_id::text
    and staff->'results'->0->>'version_state' = 'published'
    and staff->'results'->0->>'snippet' like '%**%'
    and staff::text not like '%UNPUBLISHEDSECRET%' and staff::text not like '%DRAFTONLY%'
    and staff::text not like '%MANAGERONLY%' and staff::text not like '%PRIVATESOURCEURL%', staff::text);
  insert into s88_ai values ('staff never match draft-only words, pending-edit words or untargeted articles',
    (public.atlas_knowledge_search('unpublishedsecret', bar, 'bartender', 10)->>'count')::int = 0
    and (public.atlas_knowledge_search('draftonlytitle draftonlybody', bar, 'bartender', 10)->>'count')::int = 0
    and (public.atlas_knowledge_search('manageronlybody', bar, 'bartender', 10)->>'count')::int = 0
    and (public.atlas_knowledge_search('backflush', bar, 'bartender', 10)->>'count')::int = 1, null);
  insert into s88_ai values ('managers search drafts, pending edits and manager-targeted articles, one row per article',
    (manager_k->>'count')::int = 3
    and (public.atlas_knowledge_search('unpublishedsecret', mgr, 'manager', 10)->'results'->0->>'version_state') = 'draft'
    and (public.atlas_knowledge_search('draftonlybody', mgr, 'manager', 10)->>'count')::int = 1
    and (public.atlas_knowledge_search('manageronlybody', mgr, 'manager', 10)->>'count')::int = 1
    and manager_k::text not like '%PRIVATESOURCEURL%', manager_k::text);
  insert into s88_ai values ('Knowledge search ranks title matches first and handles empty queries',
    (public.atlas_knowledge_search('espresso machine cleaning', mgr, 'manager', 10)->'results'->0->>'article_id') = published_id::text
    and (public.atlas_knowledge_search('   ', bar, 'bartender', 10)->>'count')::int = 0, null);

  -- Media register, purge and conversation delete
  m_old := (public.atlas_ai_media_register(mgr, 'manager', mgr_conv, mgr || '/' || mgr_conv || '/00000000-0000-4000-8000-000000088a01.jpg', 'image/jpeg', 1024, 'image', null)->>'id')::uuid;
  m_new := (public.atlas_ai_media_register(mgr, 'manager', null, mgr || '/unsorted/00000000-0000-4000-8000-000000088a02.pdf', 'application/pdf', 2048, 'pdf', null)->>'id')::uuid;
  m_conv_media := (public.atlas_ai_media_register(bar, 'bartender', bar_conv, bar || '/' || bar_conv || '/00000000-0000-4000-8000-000000088a03.webm', 'audio/webm', 4096, 'audio', null)->>'id')::uuid;
  update atlas_private.ai_media set expires_at = pg_catalog.now() - interval '1 day' where id = m_old;
  r := public.atlas_ai_media_purge_expired(100);
  insert into s88_ai values ('media registration enforces owner path, type and size',
    public.s88_expect(format('select public.atlas_ai_media_register(%L,%L,null,%L,%L,10,%L)', bar, 'bartender', mgr || '/unsorted/00000000-0000-4000-8000-000000088a09.jpg', 'image/jpeg', 'image')) = '22023'
    and public.s88_expect(format('select public.atlas_ai_media_register(%L,%L,null,%L,%L,10,%L)', bar, 'bartender', bar || '/unsorted/00000000-0000-4000-8000-000000088a09.exe', 'application/x-msdownload', 'document')) = '22023'
    and public.s88_expect(format('select public.atlas_ai_media_register(%L,%L,null,%L,%L,30000000,%L)', bar, 'bartender', bar || '/unsorted/00000000-0000-4000-8000-000000088a09.jpg', 'image/jpeg', 'image')) = '22023'
    and public.s88_expect(format('select public.atlas_ai_media_get(%L,%L,%L)', m_old, bar, 'bartender')) = 'P0002'
    and (select expires_at < pg_catalog.now() + interval '2 days' from atlas_private.ai_media where id = m_conv_media)
    and (select expires_at > pg_catalog.now() + interval '29 days' from atlas_private.ai_media where id = m_new), null);
  r2 := public.atlas_ai_media_purge_confirm(array[m_old, m_new]);
  insert into s88_ai values ('purge returns exactly the expired paths and confirm marks them deleted',
    (r->>'count')::int = 1 and r->'media'->0->>'path' = mgr || '/' || mgr_conv || '/00000000-0000-4000-8000-000000088a01.jpg'
    and (r2->>'confirmed')::int = 1
    and (public.atlas_ai_media_purge_expired(100)->>'count')::int = 0
    and (select deleted_at is null from atlas_private.ai_media where id = m_new), r::text);

  r := public.atlas_ai_conversation_delete(bar_conv, bar, 'bartender');
  insert into s88_ai values ('deleting a conversation cascades messages and proposals and queues its media for purge',
    (r->>'deleted')::boolean and jsonb_array_length(r->'media_marked_for_purge') = 1
    and not exists (select 1 from atlas_private.ai_conversations where id = bar_conv)
    and not exists (select 1 from atlas_private.ai_actions where id = a_mgr_only)
    and (public.atlas_ai_media_purge_expired(100)->'media'->0->>'id') = m_conv_media::text
    and exists (select 1 from atlas_private.brain_decisions d where d.recommendation_id = rec), r::text);

  -- Preferences, settings and rate limit
  r := public.atlas_ai_preferences_set(bar, 'bartender', '{"reply_length":"short","speak_answers":true}');
  insert into s88_ai values ('preferences are per user with defaults',
    r->>'reply_length' = 'short' and (r->>'speak_answers')::boolean and (r->>'voice_enabled')::boolean
    and public.atlas_ai_preferences_get(mgr, 'manager')->>'reply_length' = 'normal'
    and public.s88_expect(format('select public.atlas_ai_preferences_set(%L,%L,%L)', bar, 'bartender', '{"reply_length":"essay"}')) = '22023', r::text);

  r := public.atlas_ai_rate_check(bar, 'bartender');
  insert into s88_ai values ('Atlas AI starts disabled and only managers change settings',
    not (r->>'enabled')::boolean and not (r->>'allowed')::boolean
    and not (public.atlas_ai_settings_get(bar, 'bartender')->>'can_edit')::boolean
    and public.s88_expect(format('select public.atlas_ai_settings_set(%L,%L,%L)', bar, 'bartender', '{"enabled":true}')) = '42501', r::text);
  perform public.atlas_ai_settings_set(mgr, 'manager', '{"enabled":true,"daily_turn_limit_per_user":2}');
  run1 := (public.atlas_ai_run_start(bar, 'bartender', bar_conv2, 'text', '{"orchestrator":"configured"}')->>'run_id')::uuid;
  r2 := public.atlas_ai_rate_check(bar, 'bartender');
  perform public.atlas_ai_tool_call_record(bar, 'bartender', run1, bar_conv2, 'inventory.current_stock', 'read', 'allowed', '{"query":"pinot"}', 'ok', 1, 12, 'ok', null);
  perform public.atlas_ai_tool_call_record(bar, 'bartender', run1, bar_conv2, 'purchasing.draft_po', 'draft', 'denied', '{}', null, 0, 1, 'denied', 'forbidden');
  r := public.atlas_ai_run_finish(run1, bar, 'bartender', 'completed', 1200, 300, 0.0042, null, null, null);
  perform public.atlas_ai_run_start(bar, 'bartender', null, 'voice_note', '{}');
  perform public.atlas_ai_run_start(bar, 'bartender', null, 'voice_tool', '{}');
  -- The next counted turn is refused at run start (atomic reservation).
  state := public.s88_expect(format('select public.atlas_ai_run_start(%L,%L,null,%L)', bar, 'bartender', 'text'));
  insert into s88_ai values ('runs record observability and the daily turn limit blocks the next turn',
    (r2->>'allowed')::boolean and (r2->>'used')::int = 1
    and (r->>'tool_calls')::int = 2 and (r->>'tokens_in')::int = 1200 and r->>'status' = 'completed' and (r->>'latency_ms')::int >= 0
    and not (public.atlas_ai_rate_check(bar, 'bartender')->>'allowed')::boolean
    and (public.atlas_ai_rate_check(bar, 'bartender')->>'used')::int = 2
    and state = '53400'
    and (public.atlas_ai_rate_check(mgr, 'manager')->>'allowed')::boolean
    and (select count(*) from atlas_private.ai_tool_calls where run_id = run1 and role = 'bartender') = 2
    and public.s88_expect(format('select public.atlas_ai_run_finish(%L,%L,%L,%L)', run1, mgr, 'manager', 'failed')) = 'P0002'
    and (public.atlas_ai_run_finish(run1, bar, 'bartender', 'failed', null, null, null, null, null, null)->>'idempotent')::boolean, r::text);
end
$service$;

reset role;

select jsonb_build_object(
  's88_ai_preview', case when bool_and(passed) and count(*) = 40 then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed)
    || case when passed then '{}'::jsonb else jsonb_build_object('detail', detail) end order by test_name)
) from s88_ai;

rollback;
