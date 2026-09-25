-- S88 Atlas AI action proposals and Brain decision memory.
--
-- Read → Draft → Execute (docs/ai/Atlas_AI_Architecture.md §5, §8):
-- * A draft tool stores a proposal (ai_actions) with a readable preview and
--   the exact server command. Nothing operational changes.
-- * Approval is an atomic, single-use transition proposed → executing that
--   returns the STORED command, so the gateway never trusts a client payload.
--   It is refused after expiry, and unless the actor's role is in
--   required_roles (administrators always qualify) and the actor is the
--   proposer or a manager/administrator.
-- * Proposals are recorded as shadow Brain recommendations
--   (generated_by 'atlas-ai/…', shadow_mode true, evidence source_kind
--   'atlas_ai_tool'); approve/reject is written through the existing
--   atlas_private.decide_phase3_recommendation. There is no second Brain.
--
-- Error prefixes follow 20260926101000_s88_ai_conversation_rpcs.sql.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- Brain: allow assistant recommendations, keeping every existing type.
alter table atlas_private.brain_recommendations
  drop constraint if exists brain_recommendations_recommendation_type_check;
alter table atlas_private.brain_recommendations
  add constraint brain_recommendations_recommendation_type_check
  check (recommendation_type in ('data_quality','shortage','purchase','menu','waste','operations','governance','assistant'));

create or replace function atlas_private.ai_action_json(p_row atlas_private.ai_actions, p_include_command boolean default false)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'conversation_id', p_row.conversation_id,
    'message_id', p_row.message_id,
    'user_id', p_row.user_id,
    'role_at_proposal', p_row.role_at_proposal,
    'kind', p_row.kind,
    'title', p_row.title,
    'preview', p_row.preview,
    'required_roles', to_jsonb(p_row.required_roles),
    'status', case when p_row.status = 'proposed' and p_row.expires_at <= pg_catalog.now() then 'expired' else p_row.status end,
    'expires_at', p_row.expires_at,
    'decided_by', p_row.decided_by,
    'decided_by_role', p_row.decided_by_role,
    'decided_at', p_row.decided_at,
    'finished_at', p_row.finished_at,
    'result', p_row.result,
    'error', p_row.error,
    'brain_recommendation_id', p_row.brain_recommendation_id,
    'created_at', p_row.created_at,
    'updated_at', p_row.updated_at
  ) || case when coalesce(p_include_command, false) then jsonb_build_object('command', p_row.command) else '{}'::jsonb end;
$$;

create or replace function public.atlas_ai_action_create(
  p_actor_id uuid,
  p_actor_role text,
  p_conversation_id uuid,
  p_message_id uuid,
  p_kind text,
  p_title text,
  p_preview jsonb,
  p_command jsonb,
  p_required_roles text[] default array['admin','manager']::text[],
  p_expires_in_seconds integer default 86400
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_actions;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_conversation_id is not null then
    perform atlas_private.ai_owned_conversation(p_conversation_id, p_actor_id, false);
  end if;
  if p_message_id is not null and not exists (
    select 1 from atlas_private.ai_messages m
    where m.id = p_message_id and m.conversation_id is not distinct from p_conversation_id
  ) then
    perform atlas_private.ai_invalid('message_id is not a message in this conversation');
  end if;
  if p_command is null or jsonb_typeof(p_command) <> 'object' or p_command = '{}'::jsonb then
    perform atlas_private.ai_invalid('command must be a non-empty JSON object');
  end if;
  if coalesce(p_expires_in_seconds, 86400) not between 60 and 604800 then
    perform atlas_private.ai_invalid('expires_in_seconds must be between 60 and 604800');
  end if;

  insert into atlas_private.ai_actions (
    conversation_id, message_id, user_id, role_at_proposal, kind, title, preview, command,
    required_roles, expires_at
  ) values (
    p_conversation_id, p_message_id, p_actor_id, p_actor_role, p_kind,
    atlas_private.ai_clean_title(p_title), coalesce(p_preview, '{}'::jsonb), p_command,
    coalesce(p_required_roles, array['admin','manager']::text[]),
    pg_catalog.now() + make_interval(secs => coalesce(p_expires_in_seconds, 86400))
  ) returning * into v_row;
  return atlas_private.ai_action_json(v_row, false);
exception
  when check_violation or not_null_violation then
    raise exception using errcode = '22023', message = 'invalid_arguments: ' || sqlerrm;
end;
$$;

-- Owner or manager/administrator. Another user's proposal is "not found"
-- for staff. The command is never returned here.
create or replace function public.atlas_ai_action_get(
  p_action_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_actions;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  select * into v_row from atlas_private.ai_actions a
  where a.id = p_action_id and (a.user_id = p_actor_id or p_actor_role in ('admin','manager'));
  if v_row.id is null then raise exception using errcode = 'P0002', message = 'not_found: action'; end if;
  return atlas_private.ai_action_json(v_row, false);
end;
$$;

-- Atomic lifecycle:
--   proposed  → executing  (approve; returns the stored command)
--   executing → executed | failed  (same actor who approved; stores result/error)
--   proposed  → rejected
-- Returns {action, command, previous_status}. command is non-null only for
-- the executing transition.
create or replace function public.atlas_ai_action_transition(
  p_action_id uuid,
  p_to_status text,
  p_actor_id uuid,
  p_actor_role text,
  p_result jsonb default null,
  p_error text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row atlas_private.ai_actions;
  v_previous text;
  v_is_owner boolean;
  v_is_manager boolean := p_actor_role in ('admin','manager');
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_to_status not in ('executing','executed','failed','rejected') then
    perform atlas_private.ai_invalid('to_status must be executing, executed, failed or rejected');
  end if;

  select * into v_row from atlas_private.ai_actions a where a.id = p_action_id for update;
  v_is_owner := v_row.user_id = p_actor_id;
  if v_row.id is null or not (v_is_owner or v_is_manager) then
    raise exception using errcode = 'P0002', message = 'not_found: action';
  end if;
  v_previous := v_row.status;

  if p_to_status = 'executing' then
    if v_row.status <> 'proposed' then
      raise exception using errcode = '55000', message = 'conflict: proposal is already ' || v_row.status;
    end if;
    if v_row.expires_at <= pg_catalog.now() then
      raise exception using errcode = '55000', message = 'conflict: proposal expired';
    end if;
    if not (p_actor_role = any(v_row.required_roles) or p_actor_role = 'admin') then
      raise exception using errcode = '42501', message = 'forbidden: this proposal needs one of the roles ' || array_to_string(v_row.required_roles, ', ');
    end if;
    update atlas_private.ai_actions a set
      status = 'executing', decided_by = p_actor_id, decided_by_role = p_actor_role, decided_at = pg_catalog.now()
    where a.id = v_row.id and a.status = 'proposed'
    returning * into v_row;
    return jsonb_build_object('action', atlas_private.ai_action_json(v_row, false),
      'command', v_row.command, 'previous_status', v_previous);

  elsif p_to_status in ('executed','failed') then
    if v_row.status <> 'executing' then
      raise exception using errcode = '55000', message = 'conflict: proposal is ' || v_row.status || ', not executing';
    end if;
    if v_row.decided_by is distinct from p_actor_id then
      raise exception using errcode = '42501', message = 'forbidden: only the approving user can finish this proposal';
    end if;
    if p_result is not null and octet_length(p_result::text) > 262144 then
      perform atlas_private.ai_invalid('result is too large');
    end if;
    update atlas_private.ai_actions a set
      status = p_to_status, finished_at = pg_catalog.now(), result = p_result,
      error = case when p_to_status = 'failed' then left(coalesce(p_error, 'Execution failed'), 2000) else null end
    where a.id = v_row.id
    returning * into v_row;

  else -- rejected
    if v_row.status <> 'proposed' then
      raise exception using errcode = '55000', message = 'conflict: proposal is already ' || v_row.status;
    end if;
    update atlas_private.ai_actions a set
      status = 'rejected', decided_by = p_actor_id, decided_by_role = p_actor_role,
      decided_at = pg_catalog.now(), finished_at = pg_catalog.now(), error = left(p_error, 2000)
    where a.id = v_row.id
    returning * into v_row;
  end if;

  return jsonb_build_object('action', atlas_private.ai_action_json(v_row, false),
    'command', null, 'previous_status', v_previous);
end;
$$;

-- System job (no actor): marks stale proposals expired and expires their
-- shadow Brain recommendations.
create or replace function public.atlas_ai_actions_expire()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_recs uuid[];
begin
  with expired as (
    update atlas_private.ai_actions a set status = 'expired'
    where a.status = 'proposed' and a.expires_at <= pg_catalog.now()
    returning a.id, a.brain_recommendation_id
  )
  select coalesce(array_agg(id), '{}'::uuid[]), coalesce(array_remove(array_agg(brain_recommendation_id), null), '{}'::uuid[])
  into v_ids, v_recs from expired;

  update atlas_private.brain_recommendations r set status = 'expired', updated_at = pg_catalog.now()
  where r.id = any(v_recs) and r.status in ('active','deferred');

  return jsonb_build_object('expired', coalesce(array_length(v_ids, 1), 0), 'action_ids', to_jsonb(v_ids));
end;
$$;

-- Brain -----------------------------------------------------------------------

-- Records the proposal as a shadow Brain recommendation and links it.
-- p_evidence: array (≤ 20) of
--   {tool, label, kind: fact|calculation|interpretation|estimate|missing,
--    value, source: {type, id, label, route}}
-- Idempotent: a proposal that is already linked returns the existing id.
create or replace function public.atlas_ai_record_proposal(
  p_action_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_evidence jsonb default '[]'::jsonb,
  p_subject_type text default null,
  p_subject_key text default null,
  p_summary text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_action atlas_private.ai_actions;
  v_key text;
  v_rec uuid;
  v_item jsonb;
  v_index integer := 0;
  v_first_tool text;
  v_state text;
  v_score numeric;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_evidence is not null and (jsonb_typeof(p_evidence) <> 'array' or jsonb_array_length(p_evidence) > 20) then
    perform atlas_private.ai_invalid('evidence must be an array of at most 20 items');
  end if;

  select * into v_action from atlas_private.ai_actions a
  where a.id = p_action_id and a.user_id = p_actor_id
  for update;
  if v_action.id is null then raise exception using errcode = 'P0002', message = 'not_found: action'; end if;

  v_key := 'atlas-ai:action:' || v_action.id::text;
  if v_action.brain_recommendation_id is not null then
    return jsonb_build_object('action_id', v_action.id, 'brain_recommendation_id', v_action.brain_recommendation_id,
      'recommendation_key', v_key, 'created', false);
  end if;

  select nullif(item->>'tool', '') into v_first_tool
  from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) item
  where nullif(item->>'tool', '') is not null
  limit 1;

  v_rec := atlas_private.upsert_shadow_recommendation(
    v_key,
    'assistant',
    'atlas_ai_proposals',
    left(coalesce(nullif(btrim(p_subject_type), ''), 'atlas_ai_action'), 120),
    left(coalesce(nullif(btrim(p_subject_key), ''), v_action.kind), 240),
    v_action.title,
    left(coalesce(nullif(btrim(p_summary), ''), v_action.preview->>'summary', v_action.title), 2000),
    format('Prepared by Atlas AI for a %s. Nothing changes until a person approves this proposal; approval runs the normal Atlas command.', v_action.role_at_proposal),
    jsonb_build_object('kind', 'atlas_ai_action', 'action_id', v_action.id, 'action_kind', v_action.kind,
      'required_roles', to_jsonb(v_action.required_roles), 'preview', v_action.preview),
    '[]'::jsonb,
    '{}'::jsonb,
    'modelled',
    0.5,
    'Prepared by Atlas AI from tool results; requires human approval.',
    array['Shadow recommendation from Atlas AI. It never changes operational records by itself.']::text[],
    50,
    'atlas_ai_tool',
    'atlas_private',
    coalesce(v_first_tool, 'ai_actions'),
    v_action.id::text,
    'Atlas AI proposal',
    jsonb_build_object('action_id', v_action.id, 'kind', v_action.kind, 'role_at_proposal', v_action.role_at_proposal,
      'evidence_count', coalesce(jsonb_array_length(p_evidence), 0)),
    pg_catalog.now()
  );

  update atlas_private.brain_recommendations r
  set generated_by = 'atlas-ai/s88', valid_until = v_action.expires_at, updated_at = pg_catalog.now()
  where r.id = v_rec;

  for v_item in select value from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) loop
    v_index := v_index + 1;
    if jsonb_typeof(v_item) <> 'object' then continue; end if;
    v_state := case v_item->>'kind'
      when 'fact' then 'verified' when 'calculation' then 'verified'
      when 'missing' then 'pending' else 'modelled' end;
    v_score := case v_item->>'kind'
      when 'fact' then 1.0 when 'calculation' then 0.95 when 'interpretation' then 0.6
      when 'estimate' then 0.5 else 0.0 end;
    insert into atlas_private.brain_recommendation_evidence (
      recommendation_id, evidence_key, label, source_kind, source_schema, source_object,
      source_row_key, observed_at, confidence_state, confidence_score, value
    ) values (
      v_rec, 'tool-' || lpad(v_index::text, 2, '0'),
      left(coalesce(nullif(v_item->>'label', ''), nullif(v_item->>'tool', ''), 'Evidence'), 240),
      'atlas_ai_tool', null, left(coalesce(nullif(v_item->>'tool', ''), 'unknown'), 120),
      left(v_item->'source'->>'id', 240), pg_catalog.now(), v_state, v_score,
      v_item
    )
    on conflict (recommendation_id, evidence_key) do update set
      label = excluded.label, source_object = excluded.source_object, source_row_key = excluded.source_row_key,
      confidence_state = excluded.confidence_state, confidence_score = excluded.confidence_score, value = excluded.value;
  end loop;

  update atlas_private.ai_actions a set brain_recommendation_id = v_rec where a.id = v_action.id;

  return jsonb_build_object('action_id', v_action.id, 'brain_recommendation_id', v_rec,
    'recommendation_key', v_key, 'created', true);
end;
$$;

-- Writes approve (accept) or reject into brain_decisions through the existing
-- decide function. The decision must match the recorded transition by the
-- same actor. Idempotent per action (client_request_id).
create or replace function public.atlas_ai_record_decision(
  p_action_id uuid,
  p_decision text,
  p_actor_id uuid,
  p_actor_role text,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_action atlas_private.ai_actions;
  v_label text;
  v_result jsonb;
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if p_decision not in ('approve','reject') then
    perform atlas_private.ai_invalid('decision must be approve or reject');
  end if;
  select * into v_action from atlas_private.ai_actions a
  where a.id = p_action_id and (a.user_id = p_actor_id or p_actor_role in ('admin','manager'));
  if v_action.id is null then raise exception using errcode = 'P0002', message = 'not_found: action'; end if;
  if v_action.brain_recommendation_id is null then
    raise exception using errcode = '55000', message = 'conflict: proposal is not recorded in Brain';
  end if;
  if v_action.decided_by is distinct from p_actor_id
     or (p_decision = 'approve' and v_action.status not in ('executing','executed','failed'))
     or (p_decision = 'reject' and v_action.status <> 'rejected') then
    raise exception using errcode = '55000', message = 'conflict: decision does not match the proposal state';
  end if;

  select coalesce(nullif(btrim(profile.display_name), ''), 'Atlas user') into v_label
  from public.profiles profile where profile.id = p_actor_id;

  v_result := atlas_private.decide_phase3_recommendation(
    v_action.brain_recommendation_id,
    case p_decision when 'approve' then 'accept' else 'reject' end,
    'atlas_ai_' || p_decision,
    left(p_notes, 2000),
    null,
    null,
    p_actor_id,
    v_label,
    'atlas-ai:' || v_action.id::text || ':decision'
  );
  return v_result || jsonb_build_object('action_id', v_action.id, 'brain_recommendation_id', v_action.brain_recommendation_id);
end;
$$;

-- Free-text decision memory search for decisions.history. Manager-only,
-- matching the Brain. Exact subject lookups keep using
-- public.atlas_phase3_memory_search(subject_type, subject_key, limit).
-- Pass p_actor_id so the role is re-checked against the active profile.
create or replace function public.atlas_ai_memory_search(
  p_query text,
  p_limit integer,
  p_actor_role text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_query tsquery := atlas_private.ai_tsquery(p_query, false);
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
begin
  if p_actor_id is not null then
    perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  end if;
  if coalesce(p_actor_role, '') not in ('admin','manager') then
    raise exception using errcode = '42501', message = 'forbidden: decision memory is manager-only';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(ranked) - 'document' order by ranked.rank desc, ranked.occurred_at desc)
    from (
      select memory.*,
        case when v_query is null then 0::real else pg_catalog.ts_rank(doc.document, v_query) end as rank,
        doc.document
      from atlas_private.brain_decision_memory memory
      cross join lateral (
        select pg_catalog.to_tsvector('simple'::regconfig, concat_ws(' ',
          memory.title, memory.summary, memory.subject_type, memory.subject_key, memory.action,
          memory.actor_label, memory.context->>'reason_code', memory.context->>'recommendation_key')) as document
      ) doc
      where v_query is null or doc.document @@ v_query
      order by rank desc, memory.occurred_at desc
      limit v_limit
    ) ranked
  ), '[]'::jsonb);
end;
$$;

revoke execute on function atlas_private.ai_action_json(atlas_private.ai_actions,boolean) from public, anon, authenticated;
grant execute on function atlas_private.ai_action_json(atlas_private.ai_actions,boolean) to service_role;

revoke execute on function public.atlas_ai_action_create(uuid,text,uuid,uuid,text,text,jsonb,jsonb,text[],integer) from public, anon, authenticated;
revoke execute on function public.atlas_ai_action_get(uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_action_transition(uuid,text,uuid,text,jsonb,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_actions_expire() from public, anon, authenticated;
revoke execute on function public.atlas_ai_record_proposal(uuid,uuid,text,jsonb,text,text,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_record_decision(uuid,text,uuid,text,text) from public, anon, authenticated;
revoke execute on function public.atlas_ai_memory_search(text,integer,text,uuid) from public, anon, authenticated;

grant execute on function public.atlas_ai_action_create(uuid,text,uuid,uuid,text,text,jsonb,jsonb,text[],integer) to service_role;
grant execute on function public.atlas_ai_action_get(uuid,uuid,text) to service_role;
grant execute on function public.atlas_ai_action_transition(uuid,text,uuid,text,jsonb,text) to service_role;
grant execute on function public.atlas_ai_actions_expire() to service_role;
grant execute on function public.atlas_ai_record_proposal(uuid,uuid,text,jsonb,text,text,text) to service_role;
grant execute on function public.atlas_ai_record_decision(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_ai_memory_search(text,integer,text,uuid) to service_role;

comment on function public.atlas_ai_action_transition(uuid,text,uuid,text,jsonb,text) is
  'Service-role-only. Single-use, expiring, role-gated proposal lifecycle. Approval returns the stored command; the client payload is never used.';
comment on function public.atlas_ai_record_proposal(uuid,uuid,text,jsonb,text,text,text) is
  'Service-role-only. Records an Atlas AI proposal as a shadow Brain recommendation with atlas_ai_tool evidence.';
comment on function public.atlas_ai_record_decision(uuid,text,uuid,text,text) is
  'Service-role-only. Writes the approve/reject decision through atlas_private.decide_phase3_recommendation.';
comment on function public.atlas_ai_memory_search(text,integer,text,uuid) is
  'Service-role-only, manager-only free-text search over Brain decision memory.';
