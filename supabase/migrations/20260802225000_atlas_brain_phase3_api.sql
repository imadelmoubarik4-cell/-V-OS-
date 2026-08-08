-- Sprint 4 Phase 3 - service-role read contracts for recommendation detail and memory.
-- Public-safe database contract only. Contains no VÁ operational rows.

create or replace function public.atlas_phase3_recommendation_detail(p_recommendation_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  recommendation_row atlas_private.brain_recommendation_feed;
  memory_items jsonb;
begin
  select * into recommendation_row
  from atlas_private.brain_recommendation_feed feed
  where feed.id=p_recommendation_id;
  if not found then raise exception 'Phase 3 recommendation not found'; end if;

  select coalesce(jsonb_agg(to_jsonb(memory) order by memory.occurred_at desc),'[]'::jsonb)
  into memory_items
  from (
    select *
    from atlas_private.brain_decision_memory memory
    where (memory.context->>'recommendation_id')::uuid=p_recommendation_id
       or (memory.subject_type=recommendation_row.subject_type
           and memory.subject_key=recommendation_row.subject_key)
    order by memory.occurred_at desc
    limit 50
  ) memory;

  return jsonb_build_object(
    'recommendation',to_jsonb(recommendation_row),
    'memory',memory_items,
    'trust',jsonb_build_object(
      'shadow_mode',recommendation_row.shadow_mode,
      'automatic_operational_mutation',false,
      'manager_review_required',true
    )
  );
end;
$$;

create or replace function public.atlas_phase3_memory_search(
  p_subject_type text default null,
  p_subject_key text default null,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(memory) order by memory.occurred_at desc),'[]'::jsonb)
  from (
    select *
    from atlas_private.brain_decision_memory memory
    where (p_subject_type is null or memory.subject_type=p_subject_type)
      and (p_subject_key is null or memory.subject_key=p_subject_key)
    order by memory.occurred_at desc
    limit greatest(1,least(coalesce(p_limit,50),100))
  ) memory;
$$;

revoke execute on function public.atlas_phase3_recommendation_detail(uuid)
  from public,anon,authenticated;
revoke execute on function public.atlas_phase3_memory_search(text,text,integer)
  from public,anon,authenticated;
grant execute on function public.atlas_phase3_recommendation_detail(uuid)
  to service_role;
grant execute on function public.atlas_phase3_memory_search(text,text,integer)
  to service_role;

comment on function public.atlas_phase3_recommendation_detail(uuid) is
  'Service-role-only evidence, outcome and memory detail for one shadow recommendation.';
comment on function public.atlas_phase3_memory_search(text,text,integer) is
  'Service-role-only search over significant Atlas and Real VÁ Data decision memory.';
