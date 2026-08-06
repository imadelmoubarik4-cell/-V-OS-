-- P2.2 privacy hardening.
--
-- Checkpoint G stores source references for private manager attribution. The
-- initial P2.2 private snapshot included those fields even though the browser UI
-- did not render them. The authenticated browser gateway must not receive a
-- private Drive URL or external document identifier merely because it is hidden
-- by the interface. Sanitize the service-role wrapper response at the database
-- boundary and preserve only the fact that an attribution exists.

create or replace function atlas_private.read_sources_sanitize_snapshot(
  p_snapshot jsonb
)
returns jsonb
language sql
immutable
security invoker
set search_path=''
as $function$
  select jsonb_set(
    coalesce(p_snapshot,'{}'::jsonb),
    '{attributed_sources}',
    coalesce((
      select jsonb_agg(
        (source_row - 'source_reference' - 'external_document_id')
        || jsonb_build_object(
          'source_reference_present',coalesce(source_row ? 'source_reference',false),
          'external_document_id_present',coalesce(source_row ? 'external_document_id',false)
        )
        order by source_row->>'source_label',source_row->>'source_id'
      )
      from jsonb_array_elements(
        coalesce(p_snapshot->'attributed_sources','[]'::jsonb)
      ) source_row
    ),'[]'::jsonb),
    true
  );
$function$;

create or replace function public.atlas_read_sources_snapshot(
  p_actor_id uuid,
  p_actor_role text,
  p_limit integer default 200
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select atlas_private.read_sources_sanitize_snapshot(
    atlas_private.read_sources_snapshot(p_actor_id,p_actor_role,p_limit)
  );
$function$;

revoke all on function atlas_private.read_sources_sanitize_snapshot(jsonb)
  from public,anon,authenticated;
revoke all on function public.atlas_read_sources_snapshot(uuid,text,integer)
  from public,anon,authenticated;
grant execute on function atlas_private.read_sources_sanitize_snapshot(jsonb)
  to service_role;
grant execute on function public.atlas_read_sources_snapshot(uuid,text,integer)
  to service_role;

comment on function atlas_private.read_sources_sanitize_snapshot(jsonb) is
  'Removes private source references and external identifiers before P2.2 metadata reaches the authenticated browser gateway.';

notify pgrst,'reload schema';
