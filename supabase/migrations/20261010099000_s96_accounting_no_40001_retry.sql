-- S96 (owner-approved Accounting integration): replace SQLSTATE 40001 with PT409 in the
-- two accounting RPCs so a stale/state-conflict refusal returns a bounded HTTP 409 instead
-- of PostgREST retrying indefinitely (OPSRISK-01). Bodies are the deployed PR#93 definitions
-- unchanged except the errcode; the 'atlas:stale_request' hint is preserved, so the handler's
-- user-facing message and all Accounting behaviour (upload/extraction/review/VAT/totals/
-- duplicate/PO checks/approvals/payment/reimbursements/exports/history/retention/admin authz)
-- are unchanged. Additive: create or replace only; no data touched.

CREATE OR REPLACE FUNCTION public.atlas_accounting_command(p_actor_id uuid, p_id uuid, p_version integer, p_command text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  label text := atlas_private.accounting_require_admin(p_actor_id);
  doc atlas_private.accounting_documents%rowtype;
  payload jsonb := coalesce(p_payload, '{}'::jsonb);
  fields jsonb;
  draft jsonb;
  prefill jsonb;
  changes jsonb;
  ever_edited boolean;
  removed_path text;
  current_json jsonb;
  paid_date date;
begin
  select * into doc from atlas_private.accounting_documents d where d.id = p_id for update;
  if doc.id is null then
    raise exception 'document not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  -- record_read comes from the gateway after a read, not from a form, so it
  -- does not carry the version the administrator saw.
  if p_command <> 'record_read' and doc.version is distinct from p_version then
    raise exception 'document changed' using errcode = 'PT409', hint = 'atlas:stale_request';
  end if;

  case p_command
  when 'save' then
    if doc.status <> 'to_review' then
      raise exception 'only a document to review can be edited' using errcode = 'PT409', hint = 'atlas:stale_request';
    end if;
    fields := coalesce(payload->'fields', '{}'::jsonb);
    changes := atlas_private.accounting_apply_fields(p_id, fields, p_actor_id);
    -- The history keeps each changed value, before and after.
    if changes <> '{}'::jsonb then
      perform atlas_private.accounting_log(p_id, 'edited', p_actor_id, label, pg_catalog.jsonb_build_object('changes', changes));
    end if;

  when 'record_read' then
    -- A read that ends after the document left review changes nothing.
    if doc.status <> 'to_review' then
      return atlas_private.accounting_document_json(p_id);
    end if;
    if payload->>'outcome' = 'read' then
      draft := payload->'extraction';
      if draft is null or jsonb_typeof(draft) <> 'object' or octet_length(draft::text) > 65536 then
        raise exception 'invalid extraction' using errcode = '22023', hint = 'atlas:invalid_request';
      end if;
      update atlas_private.accounting_documents set extraction_status = 'read', extraction = draft, updated_at = pg_catalog.now()
      where id = p_id;
      -- draft.prefill holds only the values the gateway judged confident
      -- (and a supplier matched to Purchasing); draft.fields is everything read.
      prefill := coalesce(draft->'prefill', '{}'::jsonb);
      -- Prefill only fields that are still empty, and only while to review:
      -- whatever an administrator typed is never overwritten.
      ever_edited := exists (select 1 from atlas_private.accounting_document_events e where e.document_id = p_id and e.action = 'edited');
      if doc.status = 'to_review' then
        fields := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', case when not ever_edited and doc.kind = 'invoice' and prefill->>'kind' in ('receipt','credit_note','other') then prefill->>'kind' end,
          'supplier_name', case when doc.supplier_name is null and doc.supplier_id is null then prefill->>'supplier_name' end,
          'supplier_id', case when doc.supplier_id is null and doc.supplier_name is null then prefill->>'supplier_id' end,
          'supplier_kennitala', case when doc.supplier_kennitala is null then prefill->>'supplier_kennitala' end,
          'document_number', case when doc.document_number is null then prefill->>'document_number' end,
          'issue_date', case when doc.issue_date is null then prefill->>'issue_date' end,
          'due_date', case when doc.due_date is null then prefill->>'due_date' end,
          'currency', case when not ever_edited and doc.currency = 'ISK' then prefill->>'currency' end,
          'net_amount', case when doc.net_amount is null then prefill->>'net_amount' end,
          'vat_amount', case when doc.vat_amount is null then prefill->>'vat_amount' end,
          'total_amount', case when doc.total_amount is null then prefill->>'total_amount' end,
          'vat_lines', case when pg_catalog.jsonb_array_length(doc.vat_lines) = 0 and jsonb_typeof(prefill->'vat_lines') = 'array' then prefill->'vat_lines' end,
          'category', case when doc.category is null then prefill->>'category' end
        ));
        begin
          perform atlas_private.accounting_apply_fields(p_id, fields, null);
        exception when sqlstate '22023' then
          -- A value the model got wrong is left for the administrator; the
          -- draft is still stored and shown.
          null;
        end;
      end if;
      perform atlas_private.accounting_log(p_id, 'read', null, 'Atlas',
        pg_catalog.jsonb_build_object('model', payload->>'model', 'tokens_in', payload->'tokens_in', 'tokens_out', payload->'tokens_out',
          'est_cost_usd', payload->'est_cost_usd'));
    else
      update atlas_private.accounting_documents set
        extraction_status = case when payload->>'outcome' in ('not_configured','not_readable') then payload->>'outcome' else 'failed' end,
        updated_at = pg_catalog.now()
      where id = p_id;
      perform atlas_private.accounting_log(p_id, 'read_failed', null, 'Atlas',
        pg_catalog.jsonb_build_object('reason', pg_catalog.left(coalesce(payload->>'outcome', 'failed'), 40))
        || case when jsonb_typeof(payload->'est_cost_usd') = 'number'
             then pg_catalog.jsonb_build_object('est_cost_usd', payload->'est_cost_usd') else '{}'::jsonb end);
    end if;
    -- The version moves on (below), so a form opened before the read reloads
    -- instead of saving its empty fields over what Atlas filled in.

  when 'approve' then
    if doc.status <> 'to_review' then
      raise exception 'only a document to review can be approved' using errcode = 'PT409', hint = 'atlas:stale_request';
    end if;
    current_json := atlas_private.accounting_document_json(p_id);
    if coalesce(current_json->>'supplier_name', '') = '' or doc.issue_date is null or doc.total_amount is null then
      raise exception 'supplier, date and total are required' using errcode = '22023', hint = 'atlas:missing_fields';
    end if;
    if doc.paid_by = 'staff' and doc.paid_by_profile_id is null then
      raise exception 'choose who paid' using errcode = '22023', hint = 'atlas:missing_fields';
    end if;
    if pg_catalog.jsonb_array_length(current_json->'checks'->'possible_duplicates') > 0
       and coalesce((payload->>'confirm_duplicate')::boolean, false) is not true then
      raise exception 'possible duplicate' using errcode = '23505', hint = 'atlas:possible_duplicate';
    end if;
    update atlas_private.accounting_documents set status = 'approved', approved_by = p_actor_id, approved_at = pg_catalog.now(),
      updated_by = p_actor_id, updated_at = pg_catalog.now() where id = p_id;
    perform atlas_private.accounting_log(p_id, 'approved', p_actor_id, label,
      pg_catalog.jsonb_build_object('total_amount', doc.total_amount, 'currency', doc.currency,
        'confirmed_duplicate', coalesce((payload->>'confirm_duplicate')::boolean, false)));

  when 'reopen' then
    if doc.status <> 'approved' then
      raise exception 'only an approved, unpaid document can be reopened' using errcode = 'PT409', hint = 'atlas:stale_request';
    end if;
    update atlas_private.accounting_documents set status = 'to_review', approved_by = null, approved_at = null,
      updated_by = p_actor_id, updated_at = pg_catalog.now() where id = p_id;
    perform atlas_private.accounting_log(p_id, 'reopened', p_actor_id, label, '{}'::jsonb);

  when 'mark_paid' then
    if doc.status <> 'approved' then
      raise exception 'only an approved document can be marked paid' using errcode = 'PT409', hint = 'atlas:stale_request';
    end if;
    begin
      paid_date := coalesce(nullif(payload->>'paid_at', '')::date, atlas_private.venue_date());
    exception when others then
      raise exception 'invalid date' using errcode = '22023', hint = 'atlas:invalid_request';
    end;
    if paid_date > atlas_private.venue_date() + 1 or paid_date < date '2000-01-01' then
      raise exception 'invalid date' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if coalesce(payload->>'payment_method', 'bank_transfer') not in ('bank_transfer','card','cash','other') then
      raise exception 'invalid method' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    update atlas_private.accounting_documents set status = 'paid', paid_at = paid_date,
      payment_method = coalesce(nullif(payload->>'payment_method', ''), 'bank_transfer'),
      payment_reference = nullif(pg_catalog.left(pg_catalog.btrim(coalesce(payload->>'payment_reference', '')), 120), ''),
      updated_by = p_actor_id, updated_at = pg_catalog.now() where id = p_id;
    perform atlas_private.accounting_log(p_id, 'paid', p_actor_id, label,
      pg_catalog.jsonb_build_object('paid_at', paid_date, 'payment_method', coalesce(nullif(payload->>'payment_method', ''), 'bank_transfer'),
        'reimbursement', doc.paid_by = 'staff'));

  when 'unmark_paid' then
    if doc.status <> 'paid' then
      raise exception 'only a paid document can be unmarked' using errcode = 'PT409', hint = 'atlas:stale_request';
    end if;
    update atlas_private.accounting_documents set status = 'approved', paid_at = null, payment_method = null, payment_reference = null,
      updated_by = p_actor_id, updated_at = pg_catalog.now() where id = p_id;
    perform atlas_private.accounting_log(p_id, 'unpaid', p_actor_id, label, '{}'::jsonb);

  when 'void' then
    if doc.status not in ('approved','paid') then
      raise exception 'only an approved or paid document can be voided' using errcode = 'PT409', hint = 'atlas:stale_request';
    end if;
    if char_length(pg_catalog.btrim(coalesce(payload->>'reason', ''))) < 3 then
      raise exception 'a reason is required' using errcode = '22023', hint = 'atlas:missing_fields';
    end if;
    update atlas_private.accounting_documents set status = 'void',
      void_reason = pg_catalog.left(pg_catalog.btrim(payload->>'reason'), 500),
      updated_by = p_actor_id, updated_at = pg_catalog.now() where id = p_id;
    perform atlas_private.accounting_log(p_id, 'voided', p_actor_id, label,
      pg_catalog.jsonb_build_object('reason', pg_catalog.left(pg_catalog.btrim(payload->>'reason'), 500), 'was', doc.status));

  when 'discard' then
    -- Only a mistaken upload that was never approved or exported: once a
    -- document has been approved (even if reopened since), it can only be voided.
    if doc.status <> 'to_review' or doc.approved_at is not null
       or exists (select 1 from atlas_private.accounting_document_events e
                  where e.document_id = p_id and e.action in ('approved','exported')) then
      raise exception 'an approved document can only be voided' using errcode = 'PT409', hint = 'atlas:stale_request';
    end if;
    removed_path := doc.storage_path;
    update atlas_private.accounting_documents set status = 'discarded', storage_path = null,
      updated_by = p_actor_id, updated_at = pg_catalog.now() where id = p_id;
    perform atlas_private.accounting_log(p_id, 'discarded', p_actor_id, label,
      pg_catalog.jsonb_build_object('reason', nullif(pg_catalog.left(pg_catalog.btrim(coalesce(payload->>'reason', '')), 500), '')));

  else
    raise exception 'unknown command' using errcode = '22023', hint = 'atlas:invalid_request';
  end case;

  update atlas_private.accounting_documents set version = version + 1 where id = p_id;
  return atlas_private.accounting_document_json(p_id)
    || case when removed_path is not null then pg_catalog.jsonb_build_object('removed_storage_path', removed_path) else '{}'::jsonb end;
end
$function$

;

CREATE OR REPLACE FUNCTION public.atlas_accounting_begin_read(p_actor_id uuid, p_id uuid, p_daily_limit integer DEFAULT 60, p_daily_budget_usd numeric DEFAULT 2, p_max_bytes integer DEFAULT 5242880, p_again boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    raise exception 'only a document to review can be read' using errcode = 'PT409', hint = 'atlas:stale_request';
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
$function$

;

