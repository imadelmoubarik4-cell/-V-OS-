-- S92b: Atlas never pays to read one accounting document twice.
--
-- Production showed 60 paid reads for 14 uploads: concurrent upload runs in
-- the browser each asked Atlas to read the same documents. The web app now
-- runs one upload at a time; this moves the last line of defence into the
-- database, under the document's row lock, where two requests cannot both
-- pass: begin_read gains p_again (default false, so the gateway deployed
-- before this migration keeps working) and returns {already: 'read'|'reading'}
-- instead of starting a paid read.
--
-- Apply before deploying the atlas-accounting version that passes p_again.

drop function if exists public.atlas_accounting_begin_read(uuid, uuid, integer, numeric, integer);

create or replace function public.atlas_accounting_begin_read(
  p_actor_id uuid, p_id uuid, p_daily_limit integer default 60, p_daily_budget_usd numeric default 2,
  p_max_bytes integer default 5242880, p_again boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.accounting_require_admin(p_actor_id);
  doc atlas_private.accounting_documents%rowtype;
  used integer;
  spent numeric;
  enabled boolean := coalesce((select a.enabled from atlas_private.ai_settings a limit 1), false);
begin
  select * into doc from atlas_private.accounting_documents d where d.id = p_id for update;
  if doc.id is null then
    raise exception 'document not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  if doc.status <> 'to_review' or doc.storage_path is null then
    raise exception 'only a document to review can be read' using errcode = '40001', hint = 'atlas:stale_request';
  end if;
  -- Under the row lock, so two requests cannot both pay for one document:
  -- a read in progress (under 90 s old) is never started twice, and a
  -- document Atlas already read is read again only when asked (Read again).
  -- A read that died without finishing can be retried after 90 s.
  if doc.extraction_status = 'reading' and doc.updated_at > pg_catalog.now() - interval '90 seconds' then
    return pg_catalog.jsonb_build_object('id', doc.id, 'ai_enabled', enabled, 'already', 'reading');
  end if;
  if doc.extraction_status = 'read' and not coalesce(p_again, false) then
    return pg_catalog.jsonb_build_object('id', doc.id, 'ai_enabled', enabled, 'already', 'read');
  end if;
  if not enabled then
    return pg_catalog.jsonb_build_object('id', doc.id, 'ai_enabled', false);
  end if;
  -- Too large to send to the model: typed by hand, nothing spent.
  if doc.byte_size > greatest(1, coalesce(p_max_bytes, 5242880)) then
    return pg_catalog.jsonb_build_object('id', doc.id, 'ai_enabled', true, 'too_large', true);
  end if;
  -- One reader at a time checks the limits, so two reads cannot both slip under.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('atlas_accounting_reads'));
  select count(*) filter (where e.action = 'read_started'),
         coalesce(sum((e.details->>'est_cost_usd')::numeric)
           filter (where e.action in ('read','read_failed') and jsonb_typeof(e.details->'est_cost_usd') = 'number'), 0)
    into used, spent
  from atlas_private.accounting_document_events e
  where e.action in ('read_started','read','read_failed') and e.created_at >= pg_catalog.now() - interval '24 hours';
  if used >= greatest(1, least(coalesce(p_daily_limit, 60), 500))
     or spent >= greatest(0.01, least(coalesce(p_daily_budget_usd, 2), 100)) then
    raise exception 'rate_limited: daily document reading limit' using errcode = 'P0001';
  end if;
  update atlas_private.accounting_documents set extraction_status = 'reading', updated_at = pg_catalog.now() where id = p_id;
  perform atlas_private.accounting_log(p_id, 'read_started', p_actor_id, label, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('id', doc.id, 'storage_path', doc.storage_path, 'mime_type', doc.mime_type, 'file_name', doc.file_name,
    'ai_enabled', true);
end
$function$;

revoke all on function public.atlas_accounting_begin_read(uuid,uuid,integer,numeric,integer,boolean) from public, anon, authenticated;
grant execute on function public.atlas_accounting_begin_read(uuid,uuid,integer,numeric,integer,boolean) to service_role;
