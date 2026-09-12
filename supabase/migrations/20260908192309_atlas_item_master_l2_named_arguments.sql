-- Restore the named PostgREST contract for the Item Master gateway wrappers.
-- The private implementations, data, RLS policies, and production publication path are unchanged.

create or replace function public.atlas_item_master_snapshot(
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select atlas_private.item_master_snapshot(p_actor_id, p_actor_role);
$function$;

create or replace function public.atlas_item_master_save_draft(
  p_external_item_id uuid,
  p_item_name text,
  p_category text,
  p_source_snapshot jsonb,
  p_proposed_values jsonb,
  p_recipe_links jsonb,
  p_barcode_aliases jsonb,
  p_priority_score integer,
  p_priority_tier text,
  p_priority_reasons jsonb,
  p_missing_fields jsonb,
  p_expected_version integer,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.item_master_save_draft(
    p_external_item_id,
    p_item_name,
    p_category,
    p_source_snapshot,
    p_proposed_values,
    p_recipe_links,
    p_barcode_aliases,
    p_priority_score,
    p_priority_tier,
    p_priority_reasons,
    p_missing_fields,
    p_expected_version,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_item_master_prepare_publication(
  p_draft_id uuid,
  p_request_id text,
  p_current_source_snapshot jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.item_master_prepare_publication(
    p_draft_id,
    p_request_id,
    p_current_source_snapshot,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_item_master_begin_publication(
  p_publication_id uuid,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.item_master_begin_publication(
    p_publication_id,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

create or replace function public.atlas_item_master_complete_publication(
  p_publication_id uuid,
  p_status text,
  p_applied_values jsonb,
  p_failure_message text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select atlas_private.item_master_complete_publication(
    p_publication_id,
    p_status,
    p_applied_values,
    p_failure_message,
    p_actor_id,
    p_actor_label,
    p_actor_role
  );
$function$;

revoke all on function public.atlas_item_master_snapshot(uuid,text) from public, anon, authenticated;
revoke all on function public.atlas_item_master_save_draft(uuid,text,text,jsonb,jsonb,jsonb,jsonb,integer,text,jsonb,jsonb,integer,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_item_master_prepare_publication(uuid,text,jsonb,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_item_master_begin_publication(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_item_master_complete_publication(uuid,text,jsonb,text,uuid,text,text) from public, anon, authenticated;

grant execute on function public.atlas_item_master_snapshot(uuid,text) to service_role;
grant execute on function public.atlas_item_master_save_draft(uuid,text,text,jsonb,jsonb,jsonb,jsonb,integer,text,jsonb,jsonb,integer,uuid,text,text) to service_role;
grant execute on function public.atlas_item_master_prepare_publication(uuid,text,jsonb,uuid,text,text) to service_role;
grant execute on function public.atlas_item_master_begin_publication(uuid,uuid,text,text) to service_role;
grant execute on function public.atlas_item_master_complete_publication(uuid,text,jsonb,text,uuid,text,text) to service_role;

notify pgrst, 'reload schema';
