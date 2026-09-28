-- S96 (opsrisk): make Atlas audit history append-only.
--
-- Before this migration the pure event/audit tables below were writable by
-- service_role with UPDATE, DELETE and TRUNCATE (ACL arwdDxtm) and had no
-- append-only trigger, so any holder of a backend secret (or any future
-- service-role code path) could silently rewrite or erase who-did-what
-- history. Only catalog_events, marketing_delivery_attempts,
-- recognition_*, review_decisions and accounting_document_events were
-- protected.
--
-- Two layers:
--   1. Privileges: UPDATE, DELETE, TRUNCATE are revoked from service_role,
--      authenticated and anon. SELECT/INSERT stay as they were. The RPCs that
--      write these tables only INSERT (checked against every function body
--      in production, S96 opsrisk evidence).
--   2. A trigger that rejects UPDATE/DELETE/TRUNCATE for every role,
--      including the table owner, with three narrow exceptions:
--        * a referential ON DELETE SET NULL action that only nulls the FK
--          columns named in the trigger arguments (e.g. deleting a count
--          session nulls inventory_count_events.session_id),
--        * a referential ON DELETE CASCADE issued by Postgres itself
--          (pg_trigger_depth() > 1), so deleting an auth user still works,
--        * an explicit break-glass for a superuser-class SQL session
--          (session_user postgres/supabase_admin, never PostgREST's
--          authenticator) that sets atlas.audit_break_glass = 'on' in the
--          same transaction; intended only for legally required erasure.
--
-- SECURITY: the trigger function is SECURITY INVOKER; it needs no privileges.

create or replace function private.audit_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  allowed_null_columns text[] := coalesce(tg_argv::text[], array[]::text[]);
  old_doc jsonb;
  new_doc jsonb;
  column_name text;
begin
  if coalesce(current_setting('atlas.audit_break_glass', true), '') = 'on'
     and session_user in ('postgres', 'supabase_admin') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'TRUNCATE' then
    raise exception 'Atlas audit history (%.%) cannot be truncated', tg_table_schema, tg_table_name
      using errcode = '42501', hint = 'atlas:append_only';
  end if;

  if tg_op = 'DELETE' then
    -- Only a referential cascade (fired from inside the RI trigger) may remove
    -- an audit row; a direct DELETE never can.
    if pg_catalog.pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'Atlas audit history (%.%) cannot be deleted', tg_table_schema, tg_table_name
      using errcode = '42501', hint = 'atlas:append_only';
  end if;

  -- UPDATE: allowed only as an ON DELETE SET NULL referential action that
  -- nulls one or more of the listed FK columns and changes nothing else.
  if pg_catalog.pg_trigger_depth() > 1 and cardinality(allowed_null_columns) > 0 then
    old_doc := pg_catalog.to_jsonb(old) - allowed_null_columns;
    new_doc := pg_catalog.to_jsonb(new) - allowed_null_columns;
    if old_doc = new_doc then
      foreach column_name in array allowed_null_columns loop
        if (pg_catalog.to_jsonb(new) -> column_name) is distinct from (pg_catalog.to_jsonb(old) -> column_name)
           and (pg_catalog.to_jsonb(new) -> column_name) <> 'null'::jsonb then
          raise exception 'Atlas audit history (%.%) cannot be changed', tg_table_schema, tg_table_name
            using errcode = '42501', hint = 'atlas:append_only';
        end if;
      end loop;
      return new;
    end if;
  end if;

  raise exception 'Atlas audit history (%.%) cannot be changed', tg_table_schema, tg_table_name
    using errcode = '42501', hint = 'atlas:append_only';
end;
$function$;

revoke all on function private.audit_append_only() from public, anon, authenticated;

do $append_only$
declare
  -- table => FK columns that an ON DELETE SET NULL action may null
  spec record;
begin
  for spec in
    select * from (values
      ('atlas_private', 'settings_events',             array[]::text[]),
      ('atlas_private', 'integration_events',          array[]::text[]),
      ('atlas_private', 'inventory_count_events',      array['session_id', 'line_id']),
      ('atlas_private', 'item_master_events',          array['draft_id', 'publication_id']),
      ('atlas_private', 'knowledge_events',            array['article_id', 'version_id', 'source_id']),
      ('atlas_private', 'shift_events',                array['shift_id', 'person_id']),
      ('atlas_private', 'system_events',               array[]::text[]),
      ('atlas_private', 'team_message_events',         array['message_id', 'channel_id']),
      ('atlas_private', 'team_profile_events',         array[]::text[]),
      ('atlas_private', 'operations_events',           array[]::text[]),
      ('atlas_private', 'marketing_workspace_events',  array['campaign_id', 'content_id', 'recommendation_id']),
      ('atlas_private', 'marketing_content_approvals', array[]::text[]),
      ('atlas_private', 'marketing_content_revisions', array[]::text[]),
      ('atlas_private', 'team_message_revisions',      array[]::text[]),
      ('atlas_private', 'brain_decisions',             array[]::text[]),
      ('atlas_private', 'brain_outcomes',              array['decision_id']),
      ('atlas_private', 'ai_tool_calls',               array['conversation_id']),
      ('atlas_private', 'ai_voice_session_events',     array['replaced_by']),
      ('atlas_private', 'shift_publications',          array[]::text[]),
      ('atlas_private', 'shift_month_publications',    array[]::text[]),
      ('atlas_private', 'report_events',               array[]::text[]),
      ('public',        'purchase_order_events',       array[]::text[]),
      ('public',        'inventory_movements',         array['created_by', 'supplier_id', 'item_id'])
    ) as t(schema_name, table_name, null_columns)
  loop
    if pg_catalog.to_regclass(pg_catalog.format('%I.%I', spec.schema_name, spec.table_name)) is null then
      continue; -- table not present in this database (e.g. production-only report_events)
    end if;

    execute pg_catalog.format(
      'revoke update, delete, truncate on table %I.%I from service_role, authenticated, anon',
      spec.schema_name, spec.table_name);

    execute pg_catalog.format('drop trigger if exists s96_append_only on %I.%I', spec.schema_name, spec.table_name);
    execute pg_catalog.format(
      'create trigger s96_append_only before update or delete on %I.%I '
      'for each row execute function private.audit_append_only(%s)',
      spec.schema_name, spec.table_name,
      coalesce((select string_agg(pg_catalog.quote_literal(c), ', ') from unnest(spec.null_columns) c), ''));

    execute pg_catalog.format('drop trigger if exists s96_append_only_no_truncate on %I.%I', spec.schema_name, spec.table_name);
    execute pg_catalog.format(
      'create trigger s96_append_only_no_truncate before truncate on %I.%I '
      'for each statement execute function private.audit_append_only()',
      spec.schema_name, spec.table_name);
  end loop;
end
$append_only$;
