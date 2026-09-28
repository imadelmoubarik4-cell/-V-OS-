-- S96 (edgea): stock-count lines carry commercial snapshots (unit/case cost,
-- supplier, source file) copied from the manager inventory projection when a
-- manager starts a count. atlas_private.stock_count_detail returned them to
-- every role (bartenders for every session, viewers for verified sessions)
-- through atlas-stock-counts ?action=detail and every mutation that returns
-- the detail. Staff and viewers now receive the line without those keys; the
-- gateway strips them too (defence in depth). Bodies are otherwise identical
-- to production (md5 333fa870... / 39b94533... before this change).

create or replace function atlas_private.stock_count_commercial_keys(p_actor_role text)
returns text[]
language sql
immutable
set search_path to ''
as $$
  select case when p_actor_role in ('admin','manager') then array[]::text[]
              else array['unit_cost_snapshot','case_cost_snapshot','supplier_snapshot','source_file_snapshot'] end;
$$;
revoke all on function atlas_private.stock_count_commercial_keys(text) from public, anon, authenticated;
grant execute on function atlas_private.stock_count_commercial_keys(text) to service_role;

CREATE OR REPLACE FUNCTION atlas_private.stock_count_detail(p_session_id uuid, p_actor_id uuid, p_actor_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  session_row atlas_private.inventory_count_sessions;
  settings_row atlas_private.inventory_count_settings;
  is_manager boolean := p_actor_role in ('admin','manager');
begin
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'This profile cannot access stock counts';
  end if;
  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id;
  if not found then raise exception 'Stock-count session not found'; end if;
  if p_actor_role='viewer' and session_row.status<>'verified' then
    raise exception 'This stock-count session is not available to viewers';
  end if;
  select * into settings_row from atlas_private.inventory_count_settings where setting_key='va';

  return jsonb_build_object(
    'session',to_jsonb(session_row),
    'summary',atlas_private.stock_count_session_summary(session_row.id),
    'lines',coalesce((
      select jsonb_agg(
        (to_jsonb(line_row) - atlas_private.stock_count_commercial_keys(p_actor_role))
        || jsonb_build_object(
          'variance',case when line_row.observed_quantity is null then null else line_row.observed_quantity-line_row.expected_quantity end,
          'quantity_status',atlas_private.stock_count_quantity_status(line_row.inventory_item_id,line_row.source_updated_at),
          'supported_count_units',atlas_private.stock_count_supported_units(
            line_row.inventory_unit,line_row.units_per_case_snapshot,line_row.size_ml_snapshot,line_row.package_weight_g_snapshot
          )
        )
        order by coalesce(line_row.bin_location,''),coalesce(line_row.category,''),line_row.item_name
      )
      from atlas_private.inventory_count_lines line_row
      where line_row.session_id=session_row.id
    ),'[]'::jsonb),
    'publication',case when to_regclass('atlas_private.inventory_count_publications') is null then null else (
      select to_jsonb(publication_row)
      from atlas_private.inventory_count_publications publication_row
      where publication_row.session_id=session_row.id
    ) end,
    'permissions',jsonb_build_object(
      'can_edit',(p_actor_role in ('admin','manager','bartender') and session_row.status='draft'),
      'can_submit',(p_actor_role in ('admin','manager','bartender') and session_row.status='draft'),
      'can_verify',(is_manager and session_row.status='submitted'),
      'can_reject',(is_manager and session_row.status='submitted'),
      'can_cancel',((is_manager or session_row.started_by=p_actor_id) and session_row.status in ('draft','submitted')),
      'can_prepare_publication',(is_manager and session_row.status='verified' and not session_row.production_applied),
      'production_apply_enabled',coalesce(settings_row.production_apply_enabled,false)
    ),
    'trust',jsonb_build_object(
      'production_inventory_mutated',session_row.production_applied,
      'count_observation_mutates_inventory',false,
      'manager_verification_required',true,
      'manager_publication_required',true,
      'historical_rows_are_current',false,
      'verified_balances_are_private',true
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION atlas_private.stock_count_save_line(p_session_id uuid, p_line_id uuid, p_line_status text, p_observed_quantity numeric, p_count_method text, p_note text, p_skipped_reason text, p_expected_version integer, p_actor_id uuid, p_actor_label text, p_actor_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  session_row atlas_private.inventory_count_sessions;
  line_row atlas_private.inventory_count_lines;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This profile cannot count inventory'; end if;
  if p_line_status not in ('pending','counted','skipped') then raise exception 'Count-line status is invalid'; end if;
  if p_count_method is not null and p_count_method not in ('manual','barcode','photo','import') then raise exception 'Count method is invalid'; end if;
  if p_line_status='counted' and (p_observed_quantity is null or p_observed_quantity<0) then raise exception 'A counted line requires a quantity of zero or more'; end if;
  if p_line_status='skipped' and nullif(trim(coalesce(p_skipped_reason,'')),'') is null then raise exception 'A skipped line requires a reason'; end if;

  select * into session_row from atlas_private.inventory_count_sessions where id=p_session_id for update;
  if not found then raise exception 'Stock-count session not found'; end if;
  if session_row.status<>'draft' then raise exception 'Only draft stock counts can be edited'; end if;

  update atlas_private.inventory_count_lines
  set line_status=p_line_status,
      observed_quantity=case when p_line_status='counted' then p_observed_quantity else null end,
      observed_unit=case when p_line_status='counted' then inventory_unit else observed_unit end,
      count_method=case when p_line_status='counted' then coalesce(p_count_method,'manual') else null end,
      note=nullif(trim(coalesce(p_note,'')),''),
      skipped_reason=case when p_line_status='skipped' then trim(p_skipped_reason) else null end,
      counted_by=case when p_line_status='counted' then p_actor_id else null end,
      counted_by_label=case when p_line_status='counted' then p_actor_label else null end,
      counted_at=case when p_line_status='counted' then now() else null end,
      version=version+1
  where id=p_line_id and session_id=p_session_id and version=p_expected_version
  returning * into line_row;
  if not found then raise exception 'This count line changed in another session. Refresh and try again'; end if;

  update atlas_private.inventory_count_sessions
  set version=version+1
  where id=p_session_id;

  insert into atlas_private.inventory_count_events (
    event_type,session_id,line_id,inventory_item_id,actor_id,actor_label,actor_role,payload
  ) values (
    'line_saved',p_session_id,line_row.id,line_row.inventory_item_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('line_status',line_row.line_status,'observed_quantity',line_row.observed_quantity,'count_method',line_row.count_method,'line_version',line_row.version)
  );

  return jsonb_build_object('line',(to_jsonb(line_row) - atlas_private.stock_count_commercial_keys(p_actor_role)),'summary',atlas_private.stock_count_session_summary(p_session_id));
end;
$function$;
