-- S94B preview-only publishing-connections acceptance. Rolled back.
-- Proves: browser roles cannot reach the new tables or RPCs; verify derives
-- publishing_permission_state (so Marketing shows "connected" once publish
-- permission is granted); listed resources are never selected by default
-- (except the single TikTok account); one selected resource per kind; Page
-- tokens are stored only as ciphertext for the selected Page; the review
-- state is administrator-only; readiness reasons; the delivery credential
-- read needs a live claim, approved content, granted permission and the
-- selected resource, and records credential_used; the refresh lease is
-- exclusive; no payload the browser or an event receives has secret keys.
--
-- The delivery checks run against a stand-in atlas_private.marketing_deliveries
-- (the S94C table is renamed away inside this transaction when present), so
-- the preview works before and after the S94C migration.

begin;

create temporary table s94b_connections (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s94b_connections to anon, authenticated, service_role;

create or replace function pg_temp.s94b_has_secret_keys(p_value jsonb)
returns boolean language sql immutable as $$
  select coalesce(p_value::text ~* '"(ciphertext|nonce|verifier|verifier_ciphertext|verifier_nonce|access_token|refresh_token|api_key|client_secret|state_hash|code_verifier|token|lock_token)"\s*:', false);
$$;

create or replace function pg_temp.s94b_target(p_provider text)
returns jsonb language sql stable as $$
  select t from jsonb_array_elements(public.atlas_integration_publish_targets()) t where t->>'provider_key' = p_provider;
$$;

create or replace function pg_temp.s94b_raises(p_sql text, p_state text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return p_state is null or sqlstate = p_state;
end;
$$;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000094b01','authenticated','authenticated','s94b-mgr@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
       ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000094b02','authenticated','authenticated','s94b-admin@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
       ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000094b03','authenticated','authenticated','s94b-bar@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
       ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000094b04','authenticated','authenticated','s94b-old@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
update public.profiles set role='manager', active=true where id='00000000-0000-4000-8000-000000094b01';
update public.profiles set role='admin', active=true where id='00000000-0000-4000-8000-000000094b02';
update public.profiles set role='bartender', active=true where id='00000000-0000-4000-8000-000000094b03';
update public.profiles set role='manager', active=false where id='00000000-0000-4000-8000-000000094b04';

-- ---------------------------------------------------------------- privileges and structure

insert into s94b_connections
select format('%s has no privilege on atlas_private.%s', r.role_name, t.table_name),
       not has_table_privilege(r.role_name, format('atlas_private.%I', t.table_name), 'select,insert,update,delete')
from (values ('anon'),('authenticated')) r(role_name)
cross join (values ('integration_resources'),('integration_resource_credentials')) t(table_name);

insert into s94b_connections
select format('%s cannot execute %s', r.role_name, p.oid::regprocedure),
       not has_function_privilege(r.role_name, p.oid, 'execute')
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'),('authenticated'),('public')) r(role_name)
where (n.nspname = 'public' and p.proname in (
        'atlas_integration_set_state_purpose','atlas_integration_resources_store','atlas_integration_resource_select',
        'atlas_integration_read_resource_credential','atlas_integration_set_review_state','atlas_integration_publish_targets',
        'atlas_integration_read_credential_for_delivery','atlas_integration_refresh_lock','atlas_integration_refresh_store',
        'atlas_integration_refresh_release'))
   or (n.nspname = 'atlas_private' and p.proname in (
        'integration_publish_scopes','integration_primary_resource_kind','integration_assert_publishing_provider',
        'integration_assert_admin','integration_derive_publishing','integration_resources_json','integration_delivery_claim_ok',
        'integration_set_state_purpose','integration_resources_store','integration_resource_select',
        'integration_read_resource_credential','integration_set_review_state','integration_publish_targets',
        'integration_read_credential_for_delivery','integration_refresh_lock','integration_refresh_store','integration_refresh_release'));

insert into s94b_connections values
  ('service_role can execute the publish-targets RPC', has_function_privilege('service_role', 'public.atlas_integration_publish_targets()', 'execute')),
  ('service_role can execute the delivery credential RPC', has_function_privilege('service_role', 'public.atlas_integration_read_credential_for_delivery(uuid, uuid)', 'execute')),
  ('new RPCs are security definer with an empty search_path', not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ((n.nspname = 'public' and p.proname in ('atlas_integration_resources_store','atlas_integration_resource_select','atlas_integration_set_review_state','atlas_integration_publish_targets','atlas_integration_read_credential_for_delivery','atlas_integration_refresh_lock'))
        or (n.nspname = 'atlas_private' and p.proname in ('integration_resources_store','integration_resource_select','integration_set_review_state','integration_publish_targets','integration_read_credential_for_delivery','integration_refresh_lock')))
      and (not p.prosecdef or not ('search_path=""' = any (coalesce(p.proconfig, '{}'::text[]))))
  )),
  ('RLS is enabled on the two new tables', (
    select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'atlas_private' and c.relname in ('integration_resources','integration_resource_credentials')
  )),
  ('no policy grants browser roles the new tables', not exists (
    select 1 from pg_policies p where p.schemaname = 'atlas_private'
      and p.tablename in ('integration_resources','integration_resource_credentials')
      and (p.roles && array['anon','authenticated','public']::name[])
  )),
  ('review state defaults to unknown', (select bool_and(publishing_review_state = 'unknown') from atlas_private.integration_connections
    where provider_key in ('facebook','instagram','tiktok','google-business-profile'))),
  ('event types include the S94B events', (
    select pg_get_constraintdef(oid) ~ 'publish_scope_requested' and pg_get_constraintdef(oid) ~ 'credential_used'
       and pg_get_constraintdef(oid) ~ 'resource_listed' and pg_get_constraintdef(oid) ~ 'resource_selected'
       and pg_get_constraintdef(oid) ~ 'review_state_set'
    from pg_constraint where conname = 'integration_events_event_type_check')),
  ('resource metadata refuses credential-shaped keys', pg_temp.s94b_raises(
    $q$insert into atlas_private.integration_resources (provider_key, resource_kind, resource_id, label, metadata)
       values ('facebook','facebook_page','1','P','{"access_token":"x"}'::jsonb)$q$, '23514')),
  ('resource kind must match the provider', pg_temp.s94b_raises(
    $q$insert into atlas_private.integration_resources (provider_key, resource_kind, resource_id, label)
       values ('facebook','instagram_account','1','P')$q$, '23514')),
  ('publish scopes follow the contract', atlas_private.integration_publish_scopes('instagram')
    = array['instagram_basic','instagram_content_publish','pages_show_list','pages_read_engagement','business_management']
    and atlas_private.integration_publish_scopes('tiktok') = array['video.upload','video.publish']);

-- ---------------------------------------------------------------- browser roles cannot call the RPCs

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000094b01', true);
do $probe$
declare v_blocked boolean;
begin
  v_blocked := false;
  begin perform public.atlas_integration_publish_targets(); exception when insufficient_privilege then v_blocked := true; end;
  insert into s94b_connections values ('manager JWT cannot read publish targets', v_blocked);
  v_blocked := false;
  begin perform public.atlas_integration_read_credential_for_delivery(gen_random_uuid(), gen_random_uuid()); exception when insufficient_privilege then v_blocked := true; end;
  insert into s94b_connections values ('manager JWT cannot read delivery credentials', v_blocked);
  v_blocked := false;
  begin perform 1 from atlas_private.integration_resource_credentials; exception when insufficient_privilege then v_blocked := true; end;
  insert into s94b_connections values ('manager JWT cannot read resource credentials', v_blocked);
end
$probe$;
reset role;

-- ---------------------------------------------------------------- Facebook: verify derives publishing state

set local role service_role;
select public.atlas_integration_store_credential('facebook', 'oauth_token_set', repeat('aa', 40), repeat('bb', 12), 1::smallint,
  now() + interval '50 days', null, null, '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
reset role;
insert into s94b_connections values ('a stored credential alone leaves publishing not_requested',
  (select publishing_permission_state = 'not_requested' from atlas_private.integration_connections where provider_key = 'facebook'));

set local role service_role;
select public.atlas_integration_record_result('facebook', 'verified', null, 'Two Pages', array['pages_show_list','pages_read_engagement'],
  now() + interval '50 days', null, null, '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
reset role;
insert into s94b_connections values
  ('verify with connect scopes only: publishing missing',
    (select publishing_permission_state = 'missing' from atlas_private.integration_connections where provider_key = 'facebook')),
  ('Marketing shows missing publishing permission, not waiting for authorization',
    (select atlas_private.marketing_connection_display_status(authorization_state, publishing_permission_state, analytics_permission_state, token_expires_at)
       = 'missing_publishing_permission' from atlas_private.integration_connections where provider_key = 'facebook')),
  ('readiness: publishing permission missing',
    pg_temp.s94b_target('facebook')->>'reason' = 'publishing_permission_missing' and (pg_temp.s94b_target('facebook')->>'ready')::boolean = false);

set local role service_role;
-- Allow publishing: a started state becomes a publishing consent (event).
select public.atlas_integration_begin('facebook', repeat('5a', 32), null, null, null, '#settings',
  '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
select public.atlas_integration_set_state_purpose('facebook', repeat('5a', 32), 'publishing',
  '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
reset role;
insert into s94b_connections values
  ('publishing purpose is stored on the state', exists (select 1 from atlas_private.integration_oauth_states where state_hash = decode(repeat('5a', 32), 'hex') and purpose = 'publishing')),
  ('publish_scope_requested is recorded', exists (select 1 from atlas_private.integration_events where provider_key = 'facebook' and event_type = 'publish_scope_requested'));
set local role service_role;
select public.atlas_integration_bind_browser('facebook', repeat('5a', 32), repeat('5b', 32));
reset role;
insert into s94b_connections values ('the hop learns the purpose from bind_browser',
  exists (select 1 from atlas_private.integration_oauth_states where state_hash = decode(repeat('5a', 32), 'hex') and browser_binding_hash is not null));
insert into s94b_connections values ('purpose cannot change after the browser is bound', pg_temp.s94b_raises(
  $q$select public.atlas_integration_set_state_purpose('facebook', repeat('5a', 32), 'connect', '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager')$q$, '22023'));

set local role service_role;
select public.atlas_integration_record_result('facebook', 'verified', null, 'Two Pages',
  array['pages_show_list','pages_read_engagement','pages_manage_posts','business_management'],
  now() + interval '50 days', null, null, '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
reset role;
insert into s94b_connections values
  ('verify with publish scopes: publishing granted',
    (select publishing_permission_state = 'granted' from atlas_private.integration_connections where provider_key = 'facebook')),
  ('Marketing display shows connected once publishing is granted (report 02 §9 fixed)',
    (select atlas_private.marketing_connection_display_status(authorization_state, publishing_permission_state, analytics_permission_state, token_expires_at)
       = 'connected' from atlas_private.integration_connections where provider_key = 'facebook')),
  ('readiness: no Page chosen yet', pg_temp.s94b_target('facebook')->>'reason' = 'no_resource_selected'
    and pg_temp.s94b_target('facebook')->'resource' = 'null'::jsonb);

-- ---------------------------------------------------------------- resources: list, no default, select

insert into s94b_connections values
  ('a bartender cannot store resources', pg_temp.s94b_raises(
    $q$select public.atlas_integration_resources_store('facebook', '[{"resource_kind":"facebook_page","resource_id":"111","label":"VÁ Bar"}]'::jsonb,
       '00000000-0000-4000-8000-000000094b03', 'S94B bartender', 'bartender')$q$, '42501')),
  ('an inactive manager cannot store resources', pg_temp.s94b_raises(
    $q$select public.atlas_integration_resources_store('facebook', '[{"resource_kind":"facebook_page","resource_id":"111","label":"VÁ Bar"}]'::jsonb,
       '00000000-0000-4000-8000-000000094b04', 'S94B old', 'manager')$q$, '42501')),
  ('a claimed role that does not match the profile is refused', pg_temp.s94b_raises(
    $q$select public.atlas_integration_resources_store('facebook', '[]'::jsonb, '00000000-0000-4000-8000-000000094b03', 'x', 'manager')$q$, '42501'));

set local role service_role;
select public.atlas_integration_resources_store('facebook',
  '[{"resource_kind":"facebook_page","resource_id":"111","label":"VÁ Bar","metadata":{"category":"Bar","tasks":["MANAGE","CREATE_CONTENT"],"selectable":true}},
    {"resource_kind":"facebook_page","resource_id":"222","label":"VÁ Events","metadata":{"category":"Event","tasks":["CREATE_CONTENT"],"selectable":true}},
    {"resource_kind":"facebook_page","resource_id":"333","label":"Old Page","metadata":{"tasks":["ANALYZE"],"selectable":false,"unavailable_reason":"no_create_content"}}]'::jsonb,
  '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
reset role;
insert into s94b_connections values
  ('three Pages listed, none selected (no [0] default)', (select count(*) = 3 and bool_and(not selected) from atlas_private.integration_resources where provider_key = 'facebook')),
  ('resource_listed recorded with a count only', exists (select 1 from atlas_private.integration_events where provider_key = 'facebook' and event_type = 'resource_listed' and payload = '{"resource_count": 3}'::jsonb)),
  ('selecting a Page needs its Page credential', pg_temp.s94b_raises(
    $q$select public.atlas_integration_resource_select('facebook','facebook_page','111',null,null,null,'00000000-0000-4000-8000-000000094b01','S94B manager','manager')$q$, '22023')),
  ('a Page that cannot publish cannot be selected', pg_temp.s94b_raises(
    $q$select public.atlas_integration_resource_select('facebook','facebook_page','333',repeat('cc',40),repeat('dd',12),1::smallint,'00000000-0000-4000-8000-000000094b01','S94B manager','manager')$q$, '22023')),
  ('an unlisted Page cannot be selected', pg_temp.s94b_raises(
    $q$select public.atlas_integration_resource_select('facebook','facebook_page','999',repeat('cc',40),repeat('dd',12),1::smallint,'00000000-0000-4000-8000-000000094b01','S94B manager','manager')$q$, '22023'));

set local role service_role;
select public.atlas_integration_resource_select('facebook','facebook_page','111',repeat('cc',40),repeat('dd',12),1::smallint,
  '00000000-0000-4000-8000-000000094b01','S94B manager','manager');
select public.atlas_integration_resource_select('facebook','facebook_page','222',repeat('ce',40),repeat('de',12),1::smallint,
  '00000000-0000-4000-8000-000000094b01','S94B manager','manager');
reset role;
insert into s94b_connections values
  ('exactly one Page is selected', (select count(*) = 1 from atlas_private.integration_resources where provider_key = 'facebook' and selected)),
  ('the selected Page is the last choice', exists (select 1 from atlas_private.integration_resources where provider_key = 'facebook' and resource_id = '222' and selected)),
  ('only the selected Page keeps a stored token', (select count(*) = 1 and bool_and(resource_id = '222') from atlas_private.integration_resource_credentials where provider_key = 'facebook')),
  ('the Page token is stored as ciphertext bytes', (select octet_length(ciphertext) = 40 and octet_length(nonce) = 12 from atlas_private.integration_resource_credentials where provider_key = 'facebook')),
  ('the connection shows the chosen Page', exists (select 1 from atlas_private.integration_connections where provider_key = 'facebook' and external_account_id = '222' and external_account_label = 'VÁ Events')),
  ('the one-selected index refuses a second selection', pg_temp.s94b_raises(
    $q$update atlas_private.integration_resources set selected = true where provider_key = 'facebook' and resource_id = '111'$q$, '23505')),
  ('resource_selected recorded without secrets', exists (select 1 from atlas_private.integration_events where provider_key = 'facebook' and event_type = 'resource_selected' and payload->>'resource_id' = '222')),
  ('readiness: Facebook ready with the chosen Page', (pg_temp.s94b_target('facebook')->>'ready')::boolean
    and pg_temp.s94b_target('facebook')->'resource' = '{"id": "222", "kind": "facebook_page", "label": "VÁ Events"}'::jsonb
    and pg_temp.s94b_target('facebook')->'target_kinds' ? 'fb_page_photo');

-- A fresh listing without the selected Page removes it and its token.
set local role service_role;
select public.atlas_integration_resources_store('facebook',
  '[{"resource_kind":"facebook_page","resource_id":"111","label":"VÁ Bar","metadata":{"selectable":true}}]'::jsonb,
  '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
reset role;
insert into s94b_connections values
  ('a Page gone from the listing loses its selection and token', not exists (select 1 from atlas_private.integration_resources where provider_key = 'facebook' and selected)
    and not exists (select 1 from atlas_private.integration_resource_credentials where provider_key = 'facebook')),
  ('readiness returns to no Page chosen', pg_temp.s94b_target('facebook')->>'reason' = 'no_resource_selected');
set local role service_role;
select public.atlas_integration_resource_select('facebook','facebook_page','111',repeat('cc',40),repeat('dd',12),1::smallint,
  '00000000-0000-4000-8000-000000094b01','S94B manager','manager');
reset role;

-- ---------------------------------------------------------------- review state (administrator only)

insert into s94b_connections values
  ('a manager cannot set the review state', pg_temp.s94b_raises(
    $q$select public.atlas_integration_set_review_state('facebook','approved','00000000-0000-4000-8000-000000094b01','S94B manager','manager')$q$, '42501')),
  ('an unknown review state is refused', pg_temp.s94b_raises(
    $q$select public.atlas_integration_set_review_state('facebook','maybe','00000000-0000-4000-8000-000000094b02','S94B admin','admin')$q$, '22023'));
set local role service_role;
select public.atlas_integration_set_review_state('facebook','required','00000000-0000-4000-8000-000000094b02','S94B admin','admin');
reset role;
insert into s94b_connections values
  ('review required blocks Facebook publishing', pg_temp.s94b_target('facebook')->>'reason' = 'review_required'),
  ('review_state_set recorded', exists (select 1 from atlas_private.integration_events where provider_key = 'facebook' and event_type = 'review_state_set'
    and payload = '{"review": "required", "previous": "unknown"}'::jsonb));
set local role service_role;
select public.atlas_integration_set_review_state('facebook','pending','00000000-0000-4000-8000-000000094b02','S94B admin','admin');
reset role;
insert into s94b_connections values ('review pending blocks Facebook publishing', pg_temp.s94b_target('facebook')->>'reason' = 'review_pending');
set local role service_role;
select public.atlas_integration_set_review_state('facebook','approved','00000000-0000-4000-8000-000000094b02','S94B admin','admin');
reset role;
insert into s94b_connections values ('review approved: Facebook ready again', (pg_temp.s94b_target('facebook')->>'ready')::boolean);

-- ---------------------------------------------------------------- Google Business Profile

set local role service_role;
select public.atlas_integration_store_credential('google-business-profile', 'oauth_token_set', repeat('a1', 40), repeat('b1', 12), 1::smallint,
  now() + interval '1 hour', now() + interval '180 days', null, '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
select public.atlas_integration_record_result('google-business-profile', 'verified', null, 'VÁ accounts', array['https://www.googleapis.com/auth/business.manage'],
  now() + interval '1 hour', null, null, '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
reset role;
insert into s94b_connections values
  ('GBP verified without a location: publishing pending', (select publishing_permission_state = 'pending' from atlas_private.integration_connections where provider_key = 'google-business-profile')),
  ('GBP readiness: no location chosen', pg_temp.s94b_target('google-business-profile')->>'reason' = 'no_resource_selected');
set local role service_role;
select public.atlas_integration_resources_store('google-business-profile',
  '[{"resource_kind":"gbp_account","resource_id":"accounts/1","label":"VÁ Group","metadata":{"type":"LOCATION_GROUP","role":"OWNER"}},
    {"resource_kind":"gbp_location","resource_id":"accounts/1/locations/10","parent_resource_id":"accounts/1","label":"VÁ Bar","metadata":{"address":"Laugavegur 1, 101 Reykjavík","selectable":true}},
    {"resource_kind":"gbp_location","resource_id":"accounts/1/locations/11","parent_resource_id":"accounts/1","label":"VÁ Kitchen","metadata":{"selectable":true}}]'::jsonb,
  '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
reset role;
insert into s94b_connections values
  ('GBP listing selects nothing', not exists (select 1 from atlas_private.integration_resources where provider_key = 'google-business-profile' and selected)),
  ('a GBP location takes no separate credential', pg_temp.s94b_raises(
    $q$select public.atlas_integration_resource_select('google-business-profile','gbp_location','accounts/1/locations/10',repeat('cc',40),repeat('dd',12),1::smallint,'00000000-0000-4000-8000-000000094b01','S94B manager','manager')$q$, '22023')),
  ('a GBP account is not a publishing target', pg_temp.s94b_raises(
    $q$select public.atlas_integration_resource_select('google-business-profile','gbp_account','accounts/1',null,null,null,'00000000-0000-4000-8000-000000094b01','S94B manager','manager')$q$, '22023'));
set local role service_role;
select public.atlas_integration_resource_select('google-business-profile','gbp_location','accounts/1/locations/10',null,null,null,
  '00000000-0000-4000-8000-000000094b01','S94B manager','manager');
reset role;
insert into s94b_connections values
  ('selecting a location also selects its account', exists (select 1 from atlas_private.integration_resources where provider_key = 'google-business-profile' and resource_kind = 'gbp_account' and resource_id = 'accounts/1' and selected)),
  ('GBP granted once a location is chosen', (select publishing_permission_state = 'granted' from atlas_private.integration_connections where provider_key = 'google-business-profile')),
  ('GBP ready with gbp_local_post', (pg_temp.s94b_target('google-business-profile')->>'ready')::boolean
    and pg_temp.s94b_target('google-business-profile')->'target_kinds' = '["gbp_local_post"]'::jsonb);
set local role service_role;
select public.atlas_integration_set_review_state('google-business-profile','pending','00000000-0000-4000-8000-000000094b02','S94B admin','admin');
reset role;
insert into s94b_connections values
  ('GBP API access pending: publishing pending, reason review_pending',
    (select publishing_permission_state = 'pending' from atlas_private.integration_connections where provider_key = 'google-business-profile')
    and pg_temp.s94b_target('google-business-profile')->>'reason' = 'review_pending');
set local role service_role;
select public.atlas_integration_set_review_state('google-business-profile','approved','00000000-0000-4000-8000-000000094b02','S94B admin','admin');
reset role;

-- ---------------------------------------------------------------- TikTok

set local role service_role;
select public.atlas_integration_store_credential('tiktok', 'oauth_token_set', repeat('a2', 40), repeat('b2', 12), 1::smallint,
  now() + interval '1 day', now() + interval '365 days', 'open-1', '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
select public.atlas_integration_record_result('tiktok', 'verified', 'open-1', 'VÁ Bar', array['user.info.basic','video.upload','video.publish'],
  now() + interval '1 day', null, null, '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
select public.atlas_integration_resources_store('tiktok',
  '[{"resource_kind":"tiktok_account","resource_id":"open-1","label":"VÁ Bar","metadata":{"selectable":true}}]'::jsonb,
  '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
reset role;
insert into s94b_connections values
  ('the single TikTok account is selected (the token belongs to it)', exists (select 1 from atlas_private.integration_resources where provider_key = 'tiktok' and selected and resource_id = 'open-1')),
  ('TikTok unaudited: ready for inbox upload only', (pg_temp.s94b_target('tiktok')->>'ready')::boolean
    and pg_temp.s94b_target('tiktok')->'target_kinds' = '["tiktok_inbox_video"]'::jsonb);
set local role service_role;
select public.atlas_integration_set_review_state('tiktok','approved','00000000-0000-4000-8000-000000094b02','S94B admin','admin');
reset role;
insert into s94b_connections values ('TikTok approved adds Direct Post', pg_temp.s94b_target('tiktok')->'target_kinds' = '["tiktok_inbox_video", "tiktok_video"]'::jsonb);

insert into s94b_connections values
  ('readiness covers the four publishing providers in order', (
    select jsonb_agg(t->>'provider_key') = '["instagram", "facebook", "tiktok", "google-business-profile"]'::jsonb
    from jsonb_array_elements(public.atlas_integration_publish_targets()) t)),
  ('Instagram not connected', pg_temp.s94b_target('instagram')->>'reason' = 'not_connected'),
  ('readiness has no secret keys', not pg_temp.s94b_has_secret_keys(public.atlas_integration_publish_targets()));

-- ---------------------------------------------------------------- delivery credential read

insert into s94b_connections values ('before S94C the delivery read refuses safely',
  case when to_regclass('atlas_private.marketing_deliveries') is null
    then public.atlas_integration_read_credential_for_delivery(gen_random_uuid(), gen_random_uuid()) = '{"reason": "publishing_not_installed", "granted": false}'::jsonb
    else true end);

do $stand_in$
begin
  if to_regclass('atlas_private.marketing_deliveries') is not null then
    alter table atlas_private.marketing_deliveries rename to marketing_deliveries_s94b_hidden;
  end if;
end
$stand_in$;
create table atlas_private.marketing_deliveries (
  id uuid primary key, content_id uuid, provider_key text, external_account_id text,
  claim_token uuid, claimed_until timestamptz, status text not null default 'publishing'
);
alter table atlas_private.marketing_content_items disable trigger user;
insert into atlas_private.marketing_content_items (id, title, content_type, status) values
  ('00000000-0000-4000-8000-0000000c9401', 'S94B approved post', 'post', 'approved'),
  ('00000000-0000-4000-8000-0000000c9402', 'S94B draft post', 'post', 'draft');
insert into atlas_private.marketing_deliveries values
  ('00000000-0000-4000-8000-0000000d9401', '00000000-0000-4000-8000-0000000c9401', 'facebook', '111', '00000000-0000-4000-8000-0000000e9401', now() + interval '5 minutes', 'publishing'),
  ('00000000-0000-4000-8000-0000000d9402', '00000000-0000-4000-8000-0000000c9401', 'facebook', '111', '00000000-0000-4000-8000-0000000e9402', now() - interval '1 second', 'publishing'),
  ('00000000-0000-4000-8000-0000000d9403', '00000000-0000-4000-8000-0000000c9402', 'facebook', '111', '00000000-0000-4000-8000-0000000e9403', now() + interval '5 minutes', 'publishing'),
  ('00000000-0000-4000-8000-0000000d9404', '00000000-0000-4000-8000-0000000c9401', 'facebook', '222', '00000000-0000-4000-8000-0000000e9404', now() + interval '5 minutes', 'publishing'),
  ('00000000-0000-4000-8000-0000000d9405', '00000000-0000-4000-8000-0000000c9401', 'tiktok', 'open-1', '00000000-0000-4000-8000-0000000e9405', now() + interval '5 minutes', 'publishing'),
  ('00000000-0000-4000-8000-0000000d9406', '00000000-0000-4000-8000-0000000c9401', 'instagram', 'x', '00000000-0000-4000-8000-0000000e9406', now() + interval '5 minutes', 'publishing');

set local role service_role;
create temporary table s94b_reads on commit drop as
select 'ok' as name, public.atlas_integration_read_credential_for_delivery('00000000-0000-4000-8000-0000000d9401', '00000000-0000-4000-8000-0000000e9401') as result
union all select 'wrong_token', public.atlas_integration_read_credential_for_delivery('00000000-0000-4000-8000-0000000d9401', '00000000-0000-4000-8000-0000000e9402')
union all select 'expired_lease', public.atlas_integration_read_credential_for_delivery('00000000-0000-4000-8000-0000000d9402', '00000000-0000-4000-8000-0000000e9402')
union all select 'draft', public.atlas_integration_read_credential_for_delivery('00000000-0000-4000-8000-0000000d9403', '00000000-0000-4000-8000-0000000e9403')
union all select 'other_page', public.atlas_integration_read_credential_for_delivery('00000000-0000-4000-8000-0000000d9404', '00000000-0000-4000-8000-0000000e9404')
union all select 'tiktok', public.atlas_integration_read_credential_for_delivery('00000000-0000-4000-8000-0000000d9405', '00000000-0000-4000-8000-0000000e9405')
union all select 'instagram', public.atlas_integration_read_credential_for_delivery('00000000-0000-4000-8000-0000000d9406', '00000000-0000-4000-8000-0000000e9406')
union all select 'unknown', public.atlas_integration_read_credential_for_delivery(gen_random_uuid(), gen_random_uuid());
reset role;

insert into s94b_connections values
  ('claimed delivery gets the user and Page ciphertext', (select (result->>'granted')::boolean and result->>'provider_key' = 'facebook'
     and result->'credential'->>'ciphertext' = repeat('aa', 40) and result->'resource'->'credential'->>'ciphertext' = repeat('cc', 40)
     and result->'resource'->>'id' = '111' and result->'resource'->>'kind' = 'facebook_page' from s94b_reads where name = 'ok')),
  ('another claim token is refused', (select result = '{"reason": "not_claimed", "granted": false}'::jsonb from s94b_reads where name = 'wrong_token')),
  ('an expired lease is refused', (select result = '{"reason": "not_claimed", "granted": false}'::jsonb from s94b_reads where name = 'expired_lease')),
  ('content that is not approved is refused', (select result = '{"reason": "not_approved", "granted": false}'::jsonb from s94b_reads where name = 'draft')),
  ('a delivery for another Page is refused', (select result = '{"reason": "resource_changed", "granted": false}'::jsonb from s94b_reads where name = 'other_page')),
  ('TikTok has no resource credential', (select (result->>'granted')::boolean and result->'resource'->'credential' = 'null'::jsonb from s94b_reads where name = 'tiktok')),
  ('an unconnected provider is refused', (select result = '{"reason": "not_connected", "granted": false}'::jsonb from s94b_reads where name = 'instagram')),
  ('an unknown delivery is refused', (select result = '{"reason": "not_found", "granted": false}'::jsonb from s94b_reads where name = 'unknown')),
  ('credential_used recorded once per granted read, without secrets', (
    select count(*) = 2 and bool_and(payload ? 'delivery_id' and not pg_temp.s94b_has_secret_keys(payload))
    from atlas_private.integration_events where event_type = 'credential_used'));

-- Publishing permission withdrawn: refused.
update atlas_private.integration_connections set scopes_granted = array['pages_show_list'] where provider_key = 'facebook';
select atlas_private.integration_derive_publishing('facebook');
set local role service_role;
insert into s94b_connections values ('missing publishing permission is refused',
  public.atlas_integration_read_credential_for_delivery('00000000-0000-4000-8000-0000000d9401', '00000000-0000-4000-8000-0000000e9401')
    = '{"reason": "publishing_permission_missing", "granted": false}'::jsonb);
reset role;

-- ---------------------------------------------------------------- refresh lease

set local role service_role;
create temporary table s94b_locks on commit drop as
select 'first' as name, public.atlas_integration_refresh_lock('tiktok', '00000000-0000-4000-8000-0000000d9405', '00000000-0000-4000-8000-0000000e9405', null, null, null, 60) as result
union all select 'second', null::jsonb;
update s94b_locks set result = public.atlas_integration_refresh_lock('tiktok', '00000000-0000-4000-8000-0000000d9405', '00000000-0000-4000-8000-0000000e9405', null, null, null, 60) where name = 'second';
reset role;
insert into s94b_connections values
  ('the first caller gets the refresh lease', (select (result->>'acquired')::boolean and result ? 'lock_token' from s94b_locks where name = 'first')),
  ('a second caller waits and sees the current ciphertext', (select not (result->>'acquired')::boolean and not result ? 'lock_token'
     and result->'credential'->>'ciphertext' = repeat('a2', 40) from s94b_locks where name = 'second')),
  ('a worker without a live claim cannot take the lease', pg_temp.s94b_raises(
    $q$select public.atlas_integration_refresh_lock('tiktok', '00000000-0000-4000-8000-0000000d9402', '00000000-0000-4000-8000-0000000e9402', null, null, null, 60)$q$, '42501')),
  ('a claim for another provider cannot take the lease', pg_temp.s94b_raises(
    $q$select public.atlas_integration_refresh_lock('tiktok', '00000000-0000-4000-8000-0000000d9401', '00000000-0000-4000-8000-0000000e9401', null, null, null, 60)$q$, '42501')),
  ('Meta tokens have no refresh lease', pg_temp.s94b_raises(
    $q$select public.atlas_integration_refresh_lock('facebook', null, null, '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager', 60)$q$, '22023')),
  ('a bartender cannot take the lease', pg_temp.s94b_raises(
    $q$select public.atlas_integration_refresh_lock('tiktok', null, null, '00000000-0000-4000-8000-000000094b03', 'x', 'bartender', 60)$q$, '42501')),
  ('a wrong lock token cannot store', (
    select public.atlas_integration_refresh_store('tiktok', gen_random_uuid(), repeat('a3', 40), repeat('b3', 12), 1::smallint, now() + interval '1 day', null)
      = '{"reason": "lock_lost", "stored": false}'::jsonb));
set local role service_role;
select public.atlas_integration_refresh_store('tiktok', (select (result->>'lock_token')::uuid from s94b_locks where name = 'first'),
  repeat('a3', 40), repeat('b3', 12), 1::smallint, now() + interval '1 day', now() + interval '365 days');
reset role;
insert into s94b_connections values
  ('the lease holder stores the refreshed ciphertext and releases', exists (select 1 from atlas_private.integration_credentials
     where provider_key = 'tiktok' and ciphertext = decode(repeat('a3', 40), 'hex') and refresh_lock_token is null and rotated_at is not null)),
  ('refreshed recorded for the publisher', exists (select 1 from atlas_private.integration_events where provider_key = 'tiktok' and event_type = 'refreshed' and actor_label = 'Atlas publisher'));
set local role service_role;
create temporary table s94b_fail on commit drop as
select public.atlas_integration_refresh_lock('tiktok', null, null, '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager', 60) as result;
select public.atlas_integration_refresh_release('tiktok', (select (result->>'lock_token')::uuid from s94b_fail), 'invalid_grant', true);
reset role;
insert into s94b_connections values
  ('a failed refresh marks the connection for reconnecting', exists (select 1 from atlas_private.integration_connections where provider_key = 'tiktok' and status = 'expired')
     and pg_temp.s94b_target('tiktok')->>'reason' = 'needs_reauthorization'),
  ('refresh_failed recorded and the lease released', exists (select 1 from atlas_private.integration_events where provider_key = 'tiktok' and event_type = 'refresh_failed')
     and exists (select 1 from atlas_private.integration_credentials where provider_key = 'tiktok' and refresh_lock_token is null));

-- ---------------------------------------------------------------- status payload and disconnect

set local role service_role;
create temporary table s94b_status on commit drop as
select public.atlas_integration_status('manager', '00000000-0000-4000-8000-000000094b01') as result;
reset role;
insert into s94b_connections values
  ('status carries publishing fields and resources', (
    select bool_and(row ? 'publishing_permission_state' and row ? 'publishing_review_state' and row ? 'resources')
    from s94b_status, jsonb_array_elements(result) row)),
  ('status has no credential-shaped keys', (select not pg_temp.s94b_has_secret_keys(result) from s94b_status)),
  ('no event payload has credential-shaped keys', not exists (select 1 from atlas_private.integration_events where pg_temp.s94b_has_secret_keys(payload)));

set local role service_role;
select public.atlas_integration_disconnect('facebook', '00000000-0000-4000-8000-000000094b01', 'S94B manager', 'manager');
reset role;
insert into s94b_connections values
  ('disconnect removes Pages and Page tokens', not exists (select 1 from atlas_private.integration_resources where provider_key = 'facebook')
     and not exists (select 1 from atlas_private.integration_resource_credentials where provider_key = 'facebook')),
  ('disconnect resets publishing to not_requested and keeps the review state', exists (select 1 from atlas_private.integration_connections
     where provider_key = 'facebook' and publishing_permission_state = 'not_requested' and publishing_review_state = 'approved'));

-- "tests" sorts first in jsonb output (the preview runner greps ^{"tests).
select jsonb_build_object(
  'tests', count(*),
  's94b_connections', case when bool_and(passed) and count(*) >= 150 then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed', coalesce(jsonb_agg(test_name order by test_name) filter (where not passed), '[]'::jsonb)
) from s94b_connections;

rollback;
