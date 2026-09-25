-- S88 Atlas AI background signals (docs/ai/Atlas_AI_Architecture.md §12a).
--
-- atlas-ai?action=refresh-signals computes signals deterministically from the
-- Tool Gateway (operations.alerts, data_quality.*, shifts.schedule) — no model
-- call — and stores each one as a shadow Brain recommendation through the
-- existing atlas_private.upsert_shadow_recommendation. The same signal keeps
-- the same fingerprint, so it is refreshed rather than repeated; a changed
-- signal becomes a new version and supersedes the previous one. Nothing is
-- pushed to anyone; Brain stays the decision ledger.
--
-- Error prefixes follow 20260926101000_s88_ai_conversation_rpcs.sql.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- p_signals: array (1..100) of
--   {key, type, severity, audience, title, summary, subject_type, subject_key,
--    fingerprint, source_tool, evidence: [≤ 10 objects]}
-- Manager/administrator actors only (re-checked against the active profile).
create or replace function public.atlas_ai_signals_upsert(
  p_actor_id uuid,
  p_actor_role text,
  p_signals jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_signal jsonb;
  v_key text;
  v_type text;
  v_severity text;
  v_audience text;
  v_title text;
  v_previous_version integer;
  v_rec uuid;
  v_version integer;
  v_created integer := 0;
  v_refreshed integer := 0;
  v_ids uuid[] := '{}';
begin
  perform atlas_private.ai_require_actor(p_actor_id, p_actor_role);
  if coalesce(p_actor_role, '') not in ('admin','manager') then
    raise exception using errcode = '42501', message = 'forbidden: background signals are manager-only';
  end if;
  if p_signals is null or jsonb_typeof(p_signals) <> 'array' or jsonb_array_length(p_signals) not between 1 and 100 then
    perform atlas_private.ai_invalid('signals must be an array of 1 to 100 items');
  end if;

  for v_signal in select value from jsonb_array_elements(p_signals) loop
    if jsonb_typeof(v_signal) <> 'object' then
      perform atlas_private.ai_invalid('each signal must be an object');
    end if;
    v_key := v_signal->>'key';
    if v_key is null or v_key !~ '^[a-z0-9][a-z0-9_.:-]{0,159}$' then
      perform atlas_private.ai_invalid('signal key must match ^[a-z0-9][a-z0-9_.:-]{0,159}$');
    end if;
    v_type := coalesce(nullif(v_signal->>'type', ''), 'operations');
    if v_type not in ('data_quality','shortage','purchase','menu','waste','operations','governance') then
      perform atlas_private.ai_invalid('signal type is not supported');
    end if;
    v_severity := coalesce(nullif(v_signal->>'severity', ''), 'medium');
    if v_severity not in ('critical','high','medium','low') then
      perform atlas_private.ai_invalid('signal severity must be critical, high, medium or low');
    end if;
    v_audience := coalesce(nullif(v_signal->>'audience', ''), 'manager');
    if v_audience not in ('staff','manager') then
      perform atlas_private.ai_invalid('signal audience must be staff or manager');
    end if;
    v_title := atlas_private.ai_clean_title(v_signal->>'title');
    if v_title is null then perform atlas_private.ai_invalid('signal title is required'); end if;
    if v_signal ? 'evidence' and (jsonb_typeof(v_signal->'evidence') <> 'array' or jsonb_array_length(v_signal->'evidence') > 10) then
      perform atlas_private.ai_invalid('signal evidence must be an array of at most 10 items');
    end if;

    select max(r.version) into v_previous_version
    from atlas_private.brain_recommendations r
    where r.recommendation_key = 'atlas-ai:signal:' || v_key;

    v_rec := atlas_private.upsert_shadow_recommendation(
      'atlas-ai:signal:' || v_key,
      v_type,
      'atlas_ai_signals',
      left(coalesce(nullif(btrim(v_signal->>'subject_type'), ''), 'atlas_ai_signal'), 120),
      left(coalesce(nullif(btrim(v_signal->>'subject_key'), ''), v_key), 240),
      v_title,
      left(coalesce(nullif(btrim(v_signal->>'summary'), ''), v_title), 2000),
      'Computed deterministically by Atlas AI from Atlas data. It is a shadow recommendation and changes nothing by itself.',
      jsonb_build_object('kind', 'atlas_ai_signal', 'severity', v_severity, 'audience', v_audience,
        'source_tool', left(v_signal->>'source_tool', 120)),
      '[]'::jsonb,
      '{}'::jsonb,
      'verified',
      0.9,
      'Computed from Atlas tool results without a model.',
      array['Background signal from Atlas AI. Review it in Atlas before acting.']::text[],
      case v_severity when 'critical' then 10 when 'high' then 20 when 'medium' then 50 else 80 end,
      'atlas_ai_signal',
      'atlas_private',
      left(coalesce(nullif(v_signal->>'source_tool', ''), 'atlas_ai_signals'), 120),
      left(coalesce(nullif(btrim(v_signal->>'subject_key'), ''), v_key), 240),
      v_title,
      jsonb_build_object('fingerprint', left(v_signal->>'fingerprint', 128), 'severity', v_severity,
        'audience', v_audience, 'evidence', coalesce(v_signal->'evidence', '[]'::jsonb)),
      pg_catalog.now()
    );

    select r.version into v_version from atlas_private.brain_recommendations r where r.id = v_rec;
    if v_previous_version is null or v_version > v_previous_version then
      v_created := v_created + 1;
    else
      v_refreshed := v_refreshed + 1;
    end if;

    update atlas_private.brain_recommendations r
    set generated_by = 'atlas-ai/signals', valid_until = pg_catalog.now() + interval '2 days', updated_at = pg_catalog.now()
    where r.id = v_rec and r.status = 'active';

    v_ids := v_ids || v_rec;
  end loop;

  return jsonb_build_object('count', cardinality(v_ids), 'created', v_created, 'refreshed', v_refreshed,
    'recommendation_ids', to_jsonb(v_ids));
end;
$$;

revoke execute on function public.atlas_ai_signals_upsert(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.atlas_ai_signals_upsert(uuid,text,jsonb) to service_role;
