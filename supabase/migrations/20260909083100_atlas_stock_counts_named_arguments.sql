-- Restore the named PostgREST contract for the Stock Count gateway wrappers.
-- Private implementations, count evidence, inventory data, and production remain unchanged.

create or replace function public.atlas_stock_count_snapshot(
  p_inventory jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb language sql stable security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_snapshot(p_inventory, p_actor_id, p_actor_role);
$function$;

create or replace function public.atlas_stock_count_detail(
  p_session_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb language sql stable security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_detail(p_session_id, p_actor_id, p_actor_role);
$function$;

create or replace function public.atlas_stock_count_start(
  p_inventory jsonb,
  p_title text,
  p_scope_type text,
  p_scope_value text,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_client_request_id text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_start(
    p_inventory, p_title, p_scope_type, p_scope_value, p_notes,
    p_actor_id, p_actor_label, p_actor_role, p_client_request_id
  );
$function$;

create or replace function public.atlas_stock_count_save_line_v2(
  p_session_id uuid,
  p_line_id uuid,
  p_line_status text,
  p_input_quantity numeric,
  p_input_unit text,
  p_count_method text,
  p_note text,
  p_skipped_reason text,
  p_expected_version integer,
  p_evidence jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_save_line_v2(
    p_session_id, p_line_id, p_line_status, p_input_quantity, p_input_unit,
    p_count_method, p_note, p_skipped_reason, p_expected_version, p_evidence,
    p_actor_id, p_actor_label, p_actor_role
  );
$function$;

create or replace function public.atlas_stock_count_submit(
  p_session_id uuid,
  p_notes text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_submit(
    p_session_id, p_notes, p_actor_id, p_actor_label, p_actor_role
  );
$function$;

create or replace function public.atlas_stock_count_verify(
  p_session_id uuid,
  p_inventory jsonb,
  p_acknowledge_conflicts boolean,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_verify(
    p_session_id, p_inventory, p_acknowledge_conflicts,
    p_actor_id, p_actor_label, p_actor_role
  );
$function$;

create or replace function public.atlas_stock_count_prepare_publication(
  p_session_id uuid,
  p_inventory jsonb,
  p_request_id text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_prepare_publication(
    p_session_id, p_inventory, p_request_id, p_actor_id, p_actor_label, p_actor_role
  );
$function$;

create or replace function public.atlas_stock_count_publish(
  p_session_id uuid,
  p_request_id text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_publish(
    p_session_id, p_request_id, p_actor_id, p_actor_label, p_actor_role
  );
$function$;

create or replace function public.atlas_stock_count_reject(
  p_session_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_reject(
    p_session_id, p_reason, p_actor_id, p_actor_label, p_actor_role
  );
$function$;

create or replace function public.atlas_stock_count_cancel(
  p_session_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $function$
  select atlas_private.stock_count_cancel(
    p_session_id, p_reason, p_actor_id, p_actor_label, p_actor_role
  );
$function$;

revoke all on function public.atlas_stock_count_snapshot(jsonb,uuid,text) from public, anon, authenticated;
revoke all on function public.atlas_stock_count_detail(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.atlas_stock_count_start(jsonb,text,text,text,text,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.atlas_stock_count_save_line_v2(uuid,uuid,text,numeric,text,text,text,text,integer,jsonb,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_stock_count_submit(uuid,text,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_stock_count_verify(uuid,jsonb,boolean,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_stock_count_prepare_publication(uuid,jsonb,text,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_stock_count_publish(uuid,text,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_stock_count_reject(uuid,text,uuid,text,text) from public, anon, authenticated;
revoke all on function public.atlas_stock_count_cancel(uuid,text,uuid,text,text) from public, anon, authenticated;

grant execute on function public.atlas_stock_count_snapshot(jsonb,uuid,text) to service_role;
grant execute on function public.atlas_stock_count_detail(uuid,uuid,text) to service_role;
grant execute on function public.atlas_stock_count_start(jsonb,text,text,text,text,uuid,text,text,text) to service_role;
grant execute on function public.atlas_stock_count_save_line_v2(uuid,uuid,text,numeric,text,text,text,text,integer,jsonb,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_submit(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_verify(uuid,jsonb,boolean,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_prepare_publication(uuid,jsonb,text,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_publish(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_reject(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_stock_count_cancel(uuid,text,uuid,text,text) to service_role;

notify pgrst, 'reload schema';
