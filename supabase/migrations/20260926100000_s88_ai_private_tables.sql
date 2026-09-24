-- S88 Atlas AI private storage.
--
-- Conversation memory, observability, action proposals, media metadata and
-- preferences for the atlas-ai Edge Function (docs/ai/Atlas_AI_Architecture.md
-- §5–§8, §13). Every table lives in atlas_private, has RLS enabled with a
-- service-role-only policy, and grants nothing to public, anon or
-- authenticated. Browsers reach these rows only through atlas-ai, which calls
-- the owner-checking public.atlas_ai_* RPCs with the verified actor.
--
-- Contains no VÁ operational rows. Atlas AI starts disabled (ai_settings).

set lock_timeout = '5s';
set statement_timeout = '2min';

-- Conversations -----------------------------------------------------------

create table if not exists atlas_private.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'New conversation',
  pinned boolean not null default false,
  archived boolean not null default false,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  last_message_at timestamptz not null default pg_catalog.now(),
  search tsvector generated always as (to_tsvector('simple'::regconfig, coalesce(title, ''))) stored,
  constraint ai_conversations_title_length check (char_length(title) between 1 and 200),
  constraint ai_conversations_context_object check (jsonb_typeof(context) = 'object'),
  constraint ai_conversations_context_size check (octet_length(context::text) <= 65536)
);

-- Runs (observability, §13). Created before messages so messages can link a run.
create table if not exists atlas_private.ai_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references atlas_private.ai_conversations(id) on delete set null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('admin','manager','bartender','viewer')),
  channel text not null default 'text'
    check (channel in ('text','voice','voice_note','voice_tool','quick_action','background')),
  models jsonb not null default '{}'::jsonb check (jsonb_typeof(models) = 'object'),
  started_at timestamptz not null default pg_catalog.now(),
  finished_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  tokens_in integer check (tokens_in is null or tokens_in >= 0),
  tokens_out integer check (tokens_out is null or tokens_out >= 0),
  est_cost_usd numeric(12,6) check (est_cost_usd is null or est_cost_usd >= 0),
  tool_calls integer not null default 0 check (tool_calls >= 0),
  status text not null default 'running'
    check (status in ('running','completed','failed','cancelled','rejected')),
  error_code text check (error_code is null or char_length(error_code) <= 120),
  created_at timestamptz not null default pg_catalog.now(),
  check (finished_at is null or finished_at >= started_at)
);

create table if not exists atlas_private.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references atlas_private.ai_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool','system_note')),
  content text not null default '',
  items jsonb not null default '[]'::jsonb,
  source text not null default 'text'
    check (source in ('text','voice_note','live_voice','quick_action')),
  attachments jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  records jsonb not null default '[]'::jsonb,
  proposals jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  run_id uuid references atlas_private.ai_runs(id) on delete set null,
  status text not null default 'complete'
    check (status in ('complete','streaming','stopped','error')),
  client_request_id text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  search tsvector generated always as (to_tsvector('simple'::regconfig, left(coalesce(content, ''), 100000))) stored,
  constraint ai_messages_content_length check (char_length(content) <= 100000),
  constraint ai_messages_items_array check (jsonb_typeof(items) = 'array'),
  constraint ai_messages_items_size check (octet_length(items::text) <= 2097152),
  constraint ai_messages_attachments_array check (jsonb_typeof(attachments) = 'array'),
  constraint ai_messages_evidence_array check (jsonb_typeof(evidence) = 'array'),
  constraint ai_messages_records_array check (jsonb_typeof(records) = 'array'),
  constraint ai_messages_proposals_array check (jsonb_typeof(proposals) = 'array'),
  constraint ai_messages_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint ai_messages_client_request_id_length
    check (client_request_id is null or char_length(client_request_id) between 8 and 128),
  constraint ai_messages_client_request_unique unique (conversation_id, client_request_id)
);

create table if not exists atlas_private.ai_tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references atlas_private.ai_runs(id) on delete cascade,
  conversation_id uuid references atlas_private.ai_conversations(id) on delete set null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  tool_name text not null check (tool_name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and char_length(tool_name) <= 120),
  level text not null check (level in ('read','draft','execute')),
  role text not null check (role in ('admin','manager','bartender','viewer')),
  decision text not null check (decision in ('allowed','denied')),
  arguments_redacted jsonb not null default '{}'::jsonb,
  result_summary text check (result_summary is null or char_length(result_summary) <= 2000),
  evidence_count integer not null default 0 check (evidence_count >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  status text not null default 'ok' check (status in ('ok','failed','denied','timeout')),
  error_code text check (error_code is null or char_length(error_code) <= 120),
  created_at timestamptz not null default pg_catalog.now(),
  constraint ai_tool_calls_arguments_size check (octet_length(arguments_redacted::text) <= 32768)
);

-- Action proposals (§5). command is the exact server payload; preview is what
-- the person reads. The browser only ever sends the proposal id back.
create table if not exists atlas_private.ai_actions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references atlas_private.ai_conversations(id) on delete cascade,
  message_id uuid references atlas_private.ai_messages(id) on delete set null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_at_proposal text not null check (role_at_proposal in ('admin','manager','bartender','viewer')),
  kind text not null check (kind ~ '^[a-z][a-z0-9_.]{1,63}$'),
  title text not null check (char_length(title) between 1 and 200),
  preview jsonb not null default '{}'::jsonb check (jsonb_typeof(preview) = 'object'),
  command jsonb not null check (jsonb_typeof(command) = 'object'),
  required_roles text[] not null default array['admin','manager']::text[],
  status text not null default 'proposed'
    check (status in ('proposed','executing','executed','failed','rejected','expired')),
  expires_at timestamptz not null default (pg_catalog.now() + interval '24 hours'),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_by_role text check (decided_by_role is null or decided_by_role in ('admin','manager','bartender','viewer')),
  decided_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error text check (error is null or char_length(error) <= 2000),
  brain_recommendation_id uuid references atlas_private.brain_recommendations(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint ai_actions_required_roles_valid
    check (cardinality(required_roles) > 0
      and required_roles <@ array['admin','manager','bartender','viewer']::text[]),
  constraint ai_actions_command_size check (octet_length(command::text) <= 262144),
  constraint ai_actions_preview_size check (octet_length(preview::text) <= 65536)
);

-- Media metadata (§7). Objects live in the private atlas-ai-media bucket.
create table if not exists atlas_private.ai_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid references atlas_private.ai_conversations(id) on delete set null,
  bucket text not null default 'atlas-ai-media' check (bucket = 'atlas-ai-media'),
  path text not null,
  mime text not null check (mime in (
    'image/jpeg','image/png','image/webp','image/heic','image/heif',
    'application/pdf','text/plain','text/csv',
    'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav'
  )),
  bytes bigint not null check (bytes between 1 and 26214400),
  kind text not null check (kind in ('image','pdf','document','audio')),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  constraint ai_media_bucket_path_unique unique (bucket, path),
  constraint ai_media_path_shape
    check (path ~ '^[0-9a-f-]{36}/([0-9a-f-]{36}|unsorted)/[0-9a-f-]{36}\.[a-z0-9]{1,8}$'),
  constraint ai_media_kind_matches_mime check (
    (kind = 'image' and mime like 'image/%')
    or (kind = 'pdf' and mime = 'application/pdf')
    or (kind = 'document' and mime in ('text/plain','text/csv'))
    or (kind = 'audio' and mime like 'audio/%')
  )
);

create table if not exists atlas_private.ai_user_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  reply_length text not null default 'normal' check (reply_length in ('short','normal','detailed')),
  speak_answers boolean not null default false,
  voice_enabled boolean not null default true,
  language text not null default 'auto' check (language in ('auto','en','is')),
  updated_at timestamptz not null default pg_catalog.now()
);

-- Singleton settings. Atlas AI is off until an owner enables it.
create table if not exists atlas_private.ai_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  media_retention_days integer not null default 30 check (media_retention_days between 1 and 365),
  audio_retention text not null default 'delete_after_transcription'
    check (audio_retention in ('delete_after_transcription','keep_with_media')),
  daily_turn_limit_per_user integer not null default 200 check (daily_turn_limit_per_user between 1 and 10000),
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into atlas_private.ai_settings (id) values (true) on conflict (id) do nothing;

-- Access paths -------------------------------------------------------------

create index if not exists ai_conversations_user_recent_idx
  on atlas_private.ai_conversations (user_id, archived, pinned desc, last_message_at desc, id);
create index if not exists ai_conversations_search_idx
  on atlas_private.ai_conversations using gin (search);
create index if not exists ai_messages_conversation_created_idx
  on atlas_private.ai_messages (conversation_id, created_at, id);
create index if not exists ai_messages_search_idx
  on atlas_private.ai_messages using gin (search);
create index if not exists ai_messages_run_idx
  on atlas_private.ai_messages (run_id) where run_id is not null;
create index if not exists ai_runs_user_started_idx
  on atlas_private.ai_runs (user_id, started_at desc);
create index if not exists ai_runs_conversation_idx
  on atlas_private.ai_runs (conversation_id) where conversation_id is not null;
create index if not exists ai_tool_calls_run_idx
  on atlas_private.ai_tool_calls (run_id, created_at);
create index if not exists ai_tool_calls_conversation_idx
  on atlas_private.ai_tool_calls (conversation_id) where conversation_id is not null;
create index if not exists ai_tool_calls_user_created_idx
  on atlas_private.ai_tool_calls (user_id, created_at desc);
create index if not exists ai_actions_conversation_idx
  on atlas_private.ai_actions (conversation_id, created_at);
create index if not exists ai_actions_user_status_idx
  on atlas_private.ai_actions (user_id, status, created_at desc);
create index if not exists ai_actions_proposed_expiry_idx
  on atlas_private.ai_actions (expires_at) where status = 'proposed';
create index if not exists ai_actions_message_idx
  on atlas_private.ai_actions (message_id) where message_id is not null;
create index if not exists ai_actions_brain_recommendation_idx
  on atlas_private.ai_actions (brain_recommendation_id) where brain_recommendation_id is not null;
create index if not exists ai_actions_decided_by_idx
  on atlas_private.ai_actions (decided_by) where decided_by is not null;
create index if not exists ai_media_user_created_idx
  on atlas_private.ai_media (user_id, created_at desc);
create index if not exists ai_media_conversation_idx
  on atlas_private.ai_media (conversation_id) where conversation_id is not null;
create index if not exists ai_media_purge_idx
  on atlas_private.ai_media (expires_at) where deleted_at is null;
create index if not exists ai_settings_updated_by_idx
  on atlas_private.ai_settings (updated_by) where updated_by is not null;

-- Touch triggers -------------------------------------------------------------

drop trigger if exists ai_conversations_touch on atlas_private.ai_conversations;
create trigger ai_conversations_touch before update on atlas_private.ai_conversations
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists ai_messages_touch on atlas_private.ai_messages;
create trigger ai_messages_touch before update on atlas_private.ai_messages
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists ai_actions_touch on atlas_private.ai_actions;
create trigger ai_actions_touch before update on atlas_private.ai_actions
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists ai_user_preferences_touch on atlas_private.ai_user_preferences;
create trigger ai_user_preferences_touch before update on atlas_private.ai_user_preferences
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists ai_settings_touch on atlas_private.ai_settings;
create trigger ai_settings_touch before update on atlas_private.ai_settings
  for each row execute function atlas_private.touch_updated_at();

-- RLS and grants: service role only -----------------------------------------

alter table atlas_private.ai_conversations enable row level security;
alter table atlas_private.ai_runs enable row level security;
alter table atlas_private.ai_messages enable row level security;
alter table atlas_private.ai_tool_calls enable row level security;
alter table atlas_private.ai_actions enable row level security;
alter table atlas_private.ai_media enable row level security;
alter table atlas_private.ai_user_preferences enable row level security;
alter table atlas_private.ai_settings enable row level security;

revoke all on atlas_private.ai_conversations from public, anon, authenticated;
revoke all on atlas_private.ai_runs from public, anon, authenticated;
revoke all on atlas_private.ai_messages from public, anon, authenticated;
revoke all on atlas_private.ai_tool_calls from public, anon, authenticated;
revoke all on atlas_private.ai_actions from public, anon, authenticated;
revoke all on atlas_private.ai_media from public, anon, authenticated;
revoke all on atlas_private.ai_user_preferences from public, anon, authenticated;
revoke all on atlas_private.ai_settings from public, anon, authenticated;
grant all on atlas_private.ai_conversations to service_role;
grant all on atlas_private.ai_runs to service_role;
grant all on atlas_private.ai_messages to service_role;
grant all on atlas_private.ai_tool_calls to service_role;
grant all on atlas_private.ai_actions to service_role;
grant all on atlas_private.ai_media to service_role;
grant all on atlas_private.ai_user_preferences to service_role;
grant all on atlas_private.ai_settings to service_role;

drop policy if exists "service role manages ai conversations" on atlas_private.ai_conversations;
create policy "service role manages ai conversations"
  on atlas_private.ai_conversations for all to service_role using (true) with check (true);
drop policy if exists "service role manages ai runs" on atlas_private.ai_runs;
create policy "service role manages ai runs"
  on atlas_private.ai_runs for all to service_role using (true) with check (true);
drop policy if exists "service role manages ai messages" on atlas_private.ai_messages;
create policy "service role manages ai messages"
  on atlas_private.ai_messages for all to service_role using (true) with check (true);
drop policy if exists "service role manages ai tool calls" on atlas_private.ai_tool_calls;
create policy "service role manages ai tool calls"
  on atlas_private.ai_tool_calls for all to service_role using (true) with check (true);
drop policy if exists "service role manages ai actions" on atlas_private.ai_actions;
create policy "service role manages ai actions"
  on atlas_private.ai_actions for all to service_role using (true) with check (true);
drop policy if exists "service role manages ai media" on atlas_private.ai_media;
create policy "service role manages ai media"
  on atlas_private.ai_media for all to service_role using (true) with check (true);
drop policy if exists "service role manages ai user preferences" on atlas_private.ai_user_preferences;
create policy "service role manages ai user preferences"
  on atlas_private.ai_user_preferences for all to service_role using (true) with check (true);
drop policy if exists "service role manages ai settings" on atlas_private.ai_settings;
create policy "service role manages ai settings"
  on atlas_private.ai_settings for all to service_role using (true) with check (true);

comment on table atlas_private.ai_conversations is
  'Atlas AI conversations. Owner-scoped: only public.atlas_ai_* RPCs with the verified owner read or change a row; managers do not read other users'' conversations.';
comment on table atlas_private.ai_messages is
  'Atlas AI messages. items holds Agents SDK history items; search is a simple-config tsvector over content.';
comment on table atlas_private.ai_runs is 'Atlas AI run observability: channel, models, latency, tokens, estimated cost, status.';
comment on table atlas_private.ai_tool_calls is 'Atlas AI tool gateway audit: tool, level, role decision, redacted arguments, result summary.';
comment on table atlas_private.ai_actions is
  'Atlas AI action proposals. command is the stored server payload; transitions are single-use and role-gated in SQL.';
comment on table atlas_private.ai_media is 'Metadata for objects in the private atlas-ai-media bucket; purge returns paths for the gateway to delete.';
comment on table atlas_private.ai_user_preferences is 'Non-sensitive Atlas AI preferences per user.';
comment on table atlas_private.ai_settings is 'Singleton Atlas AI settings. Disabled by default.';
