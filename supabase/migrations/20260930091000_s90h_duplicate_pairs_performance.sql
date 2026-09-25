-- S90h: Data › Issues timed out in production (57014 after the 8 s API limit).
--
-- atlas_private.catalog_possible_duplicate_pairs() prefilters candidate
-- pairs (shared name tokens, shared codes, alias hits) and then scores them
-- with atlas_private.catalog_duplicate_score(). The planner moved the score
-- into a keys × keys nested loop ahead of the candidate join, so it scored
-- every pair of active items (236 × 236 = 55,696 on production, twice),
-- about 18 s, instead of the ~140 candidates.
--
-- Same signature, same results. The candidates and their scores are
-- materialised first, so only candidate pairs are scored. The alias check is
-- an equality join on alias keys instead of a comparison of every pair.

create or replace function atlas_private.catalog_possible_duplicate_pairs(p_threshold numeric default 0.75)
returns table (item_a uuid, item_b uuid, score numeric, code_collision boolean, evidence jsonb)
language sql
stable
set search_path = ''
as $function$
  with keys as materialized (
    select k.* from atlas_private.catalog_item_duplicate_keys() k where k.active
  ), tokens as materialized (
    select k.item_id, t.token, cardinality(string_to_array(coalesce(k.keys->>'match_key', ''), ' ')) as size
    from keys k cross join lateral unnest(string_to_array(nullif(k.keys->>'match_key', ''), ' ')) as t(token)
  ), token_pairs as (
    select a.item_id as item_a, b.item_id as item_b
    from tokens a join tokens b on a.token = b.token and a.item_id < b.item_id
    group by a.item_id, b.item_id, a.size, b.size
    having 2.0 * count(distinct a.token) / (a.size + b.size) >= 0.5
  ), codes as materialized (
    select k.item_id, c->>'kind' as kind, c->>'normalized' as normalized
    from keys k cross join lateral jsonb_array_elements(coalesce(k.keys->'codes', '[]'::jsonb)) c
  ), code_pairs as (
    select a.item_id as item_a, b.item_id as item_b
    from codes a join codes b
      on a.kind = b.kind and a.normalized = b.normalized and a.item_id < b.item_id
  ), alias_hits as materialized (
    select k.item_id, a.alias_key
    from keys k cross join lateral jsonb_array_elements_text(coalesce(k.keys->'alias_keys', '[]'::jsonb)) a(alias_key)
  ), alias_pairs as (
    select least(h.item_id, m.item_id) as item_a, greatest(h.item_id, m.item_id) as item_b
    from alias_hits h join keys m on (m.keys->>'match_key') = h.alias_key and m.item_id <> h.item_id
  ), pairs as materialized (
    select * from token_pairs union select * from code_pairs union select * from alias_pairs
  ), scored as materialized (
    select p.item_a, p.item_b, atlas_private.catalog_duplicate_score(a.keys, b.keys) as result
    from pairs p
    join keys a on a.item_id = p.item_a
    join keys b on b.item_id = p.item_b
  )
  select s.item_a, s.item_b, (s.result->>'score')::numeric, (s.result->>'code_collision')::boolean, s.result->'evidence'
  from scored s
  where ((s.result->>'score')::numeric >= p_threshold or (s.result->>'code_collision')::boolean)
    and not exists (select 1 from atlas_private.catalog_distinct_pairs d
                    where d.item_a = least(s.item_a, s.item_b) and d.item_b = greatest(s.item_a, s.item_b));
$function$;
revoke all on function atlas_private.catalog_possible_duplicate_pairs(numeric) from public, anon, authenticated;
grant execute on function atlas_private.catalog_possible_duplicate_pairs(numeric) to service_role;
