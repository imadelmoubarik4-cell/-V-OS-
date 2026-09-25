-- S92 Accounting: supplier invoices, receipts and staff reimbursements.
--
-- Administrators upload an invoice or a receipt (photo or PDF). Atlas may
-- read it into a draft, and an administrator checks and approves it, then
-- marks it paid (or, when a team member paid with their own money,
-- reimbursed). Nothing is posted to an accounting system; the accountant gets
-- a monthly export.
--
-- Same pattern as atlas-profile-photos and atlas-ai-media:
-- * The tables live in atlas_private with RLS on, a service-role-only policy
--   and no grant to anon or authenticated.
-- * The bucket is private and has no storage.objects policy, so a browser can
--   neither list, read nor write a file directly.
-- * The atlas-accounting Edge Function verifies the caller and calls the
--   public.atlas_accounting_* RPCs below, which only service_role may
--   execute. Each RPC checks again that the actor is an active admin.
--
-- Retention (Icelandic bookkeeping law, 7 years): a document can never be
-- deleted. A mistaken upload that was never approved can be discarded (its
-- file is removed, the record and its history stay); an approved document can
-- only be voided, with a reason, and keeps its file. The history is
-- append-only.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- Private bucket -----------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'atlas-accounting-documents',
  'atlas-accounting-documents',
  false,
  15728640,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  updated_at = now();

-- No storage.objects policy is created for this bucket on purpose.

-- Tables ---------------------------------------------------------------------

create table if not exists atlas_private.accounting_documents (
  id uuid primary key default gen_random_uuid(),
  version integer not null default 1,
  status text not null default 'to_review'
    check (status in ('to_review','approved','paid','void','discarded')),
  kind text not null default 'invoice'
    check (kind in ('invoice','receipt','credit_note','other')),
  category text
    check (category is null or category in ('drinks','food','supplies','cleaning','repairs','rent','utilities','staff','marketing','other')),
  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_name text check (supplier_name is null or char_length(supplier_name) between 1 and 200),
  supplier_kennitala text check (supplier_kennitala is null or supplier_kennitala ~ '^[0-9]{10}$'),
  document_number text check (document_number is null or char_length(document_number) between 1 and 80),
  issue_date date,
  due_date date,
  currency text not null default 'ISK' check (currency ~ '^[A-Z]{3}$'),
  net_amount numeric(14,2) check (net_amount is null or net_amount >= 0),
  vat_amount numeric(14,2) check (vat_amount is null or vat_amount >= 0),
  total_amount numeric(14,2) check (total_amount is null or total_amount >= 0),
  vat_lines jsonb not null default '[]'::jsonb
    check (jsonb_typeof(vat_lines) = 'array' and jsonb_array_length(vat_lines) <= 6),
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  note text check (note is null or char_length(note) <= 2000),
  paid_by text not null default 'company' check (paid_by in ('company','staff')),
  paid_by_profile_id uuid references public.profiles(id) on delete set null,
  paid_at date,
  payment_method text check (payment_method is null or payment_method in ('bank_transfer','card','cash','other')),
  payment_reference text check (payment_reference is null or char_length(payment_reference) <= 120),
  void_reason text check (void_reason is null or char_length(void_reason) between 3 and 500),
  -- The file. storage_path is cleared when a mistaken upload is discarded.
  storage_path text check (storage_path is null or storage_path ~ '^documents/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|heic|heif|pdf)$'),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf')),
  byte_size integer not null check (byte_size between 1 and 15728640),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text check (file_name is null or char_length(file_name) between 1 and 160),
  -- What Atlas read from the file: a draft only, never applied on its own.
  extraction_status text not null default 'none'
    check (extraction_status in ('none','reading','read','failed','not_configured','not_readable')),
  extraction jsonb check (extraction is null or (jsonb_typeof(extraction) = 'object' and octet_length(extraction::text) <= 65536)),
  request_id uuid not null,
  created_by uuid not null references public.profiles(id),
  created_by_label text not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default pg_catalog.now(),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  -- Staff-paid needs the team member from approval on (a draft may not have one yet).
  constraint accounting_documents_staff_payer check (paid_by = 'company' or paid_by_profile_id is not null or status in ('to_review','discarded')),
  constraint accounting_documents_paid_state check (
    (status = 'paid') = (paid_at is not null) or status = 'void'
  ),
  constraint accounting_documents_void_reason check ((status = 'void') = (void_reason is not null)),
  constraint accounting_documents_file_kept check (status = 'discarded' or storage_path is not null),
  constraint accounting_documents_due_after_issue check (due_date is null or issue_date is null or due_date >= issue_date),
  constraint accounting_documents_request unique (created_by, request_id)
);

-- One live record per file: the same file cannot be uploaded twice unless the
-- first upload was discarded.
create unique index if not exists accounting_documents_live_file
  on atlas_private.accounting_documents (file_sha256) where status <> 'discarded';
create index if not exists accounting_documents_status_idx
  on atlas_private.accounting_documents (status, issue_date desc);
create index if not exists accounting_documents_supplier_number_idx
  on atlas_private.accounting_documents (lower(supplier_name), lower(document_number));

create table if not exists atlas_private.accounting_document_events (
  id bigint generated always as identity primary key,
  document_id uuid not null references atlas_private.accounting_documents(id),
  action text not null check (action in (
    'uploaded','read_started','read','read_failed','edited','approved','reopened',
    'paid','unpaid','voided','discarded','file_opened','exported')),
  actor_id uuid references public.profiles(id),
  actor_label text not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 16384),
  created_at timestamptz not null default pg_catalog.now()
);
create index if not exists accounting_document_events_document_idx
  on atlas_private.accounting_document_events (document_id, id);
create index if not exists accounting_document_events_reads_idx
  on atlas_private.accounting_document_events (created_at) where action = 'read_started';

alter table atlas_private.accounting_documents enable row level security;
alter table atlas_private.accounting_document_events enable row level security;
drop policy if exists "service role manages accounting documents" on atlas_private.accounting_documents;
create policy "service role manages accounting documents" on atlas_private.accounting_documents
  for all to service_role using (true) with check (true);
drop policy if exists "service role manages accounting document events" on atlas_private.accounting_document_events;
create policy "service role manages accounting document events" on atlas_private.accounting_document_events
  for all to service_role using (true) with check (true);
revoke all on atlas_private.accounting_documents from public, anon, authenticated;
revoke all on atlas_private.accounting_document_events from public, anon, authenticated;
grant select, insert, update on atlas_private.accounting_documents to service_role;
grant select, insert on atlas_private.accounting_document_events to service_role;

-- Retention guards: documents are never deleted; history is append-only.
create or replace function atlas_private.accounting_retention_guard()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'accounting records are kept for 7 years and cannot be deleted or rewritten'
    using errcode = '42501', hint = 'atlas:append_only';
end
$function$;
revoke all on function atlas_private.accounting_retention_guard() from public, anon, authenticated;

drop trigger if exists accounting_documents_no_delete on atlas_private.accounting_documents;
create trigger accounting_documents_no_delete before delete on atlas_private.accounting_documents
  for each row execute function atlas_private.accounting_retention_guard();
drop trigger if exists accounting_document_events_append_only on atlas_private.accounting_document_events;
create trigger accounting_document_events_append_only before update or delete on atlas_private.accounting_document_events
  for each row execute function atlas_private.accounting_retention_guard();

-- Helpers --------------------------------------------------------------------

-- The actor must be an active administrator (owner decision: Accounting is
-- admin only). Returns the actor's display label.
create or replace function atlas_private.accounting_require_admin(p_actor_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  actor record;
begin
  select p.id, p.role::text as role, p.active, p.display_name into actor
  from public.profiles p where p.id = p_actor_id;
  if actor.id is null or actor.active is not true or actor.role <> 'admin' then
    raise exception 'accounting is for administrators' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return coalesce(nullif(pg_catalog.btrim(actor.display_name), ''), 'Team member');
end
$function$;
revoke all on function atlas_private.accounting_require_admin(uuid) from public, anon, authenticated;

create or replace function atlas_private.accounting_log(p_document_id uuid, p_action text, p_actor_id uuid, p_actor_label text, p_details jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $function$
  insert into atlas_private.accounting_document_events (document_id, action, actor_id, actor_label, details)
  values (p_document_id, p_action, p_actor_id, coalesce(nullif(pg_catalog.btrim(p_actor_label), ''), 'Team member'), coalesce(p_details, '{}'::jsonb));
$function$;
revoke all on function atlas_private.accounting_log(uuid,text,uuid,text,jsonb) from public, anon, authenticated;

create or replace function atlas_private.accounting_fold(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select nullif(pg_catalog.regexp_replace(pg_catalog.lower(coalesce(p_value, '')), '[^[:alnum:]]+', '', 'g'), '');
$function$;
revoke all on function atlas_private.accounting_fold(text) from public, anon, authenticated;

-- One document as the gateway returns it: fields, labels and checks.
create or replace function atlas_private.accounting_document_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', d.id, 'version', d.version, 'status', d.status, 'kind', d.kind, 'category', d.category,
    'supplier_id', d.supplier_id, 'supplier_name', coalesce(d.supplier_name, s.name), 'supplier_kennitala', d.supplier_kennitala,
    'supplier_known', d.supplier_id is not null,
    'document_number', d.document_number, 'issue_date', d.issue_date, 'due_date', d.due_date,
    'currency', d.currency, 'net_amount', d.net_amount, 'vat_amount', d.vat_amount, 'total_amount', d.total_amount,
    'vat_lines', d.vat_lines, 'purchase_order_id', d.purchase_order_id, 'note', d.note,
    'paid_by', d.paid_by, 'paid_by_profile_id', d.paid_by_profile_id,
    'paid_by_label', case when d.paid_by = 'staff' then coalesce(nullif(pg_catalog.btrim(pp.display_name), ''), 'Team member') end,
    'paid_at', d.paid_at, 'payment_method', d.payment_method, 'payment_reference', d.payment_reference,
    'void_reason', d.void_reason,
    'has_file', d.storage_path is not null, 'mime_type', d.mime_type, 'byte_size', d.byte_size, 'file_name', d.file_name,
    'extraction_status', d.extraction_status, 'extraction', d.extraction,
    'created_by_label', d.created_by_label, 'created_at', d.created_at, 'updated_at', d.updated_at,
    'approved_at', d.approved_at,
    'approved_by_label', case when d.approved_by is not null then coalesce(nullif(pg_catalog.btrim(ap.display_name), ''), 'Team member') end,
    'order', case when po.id is not null then pg_catalog.jsonb_build_object(
      'id', po.id, 'status', po.status, 'total', private.purchase_order_total(po.lines),
      'supplier_name', ps.name, 'ordered_at', po.ordered_at, 'received_at', po.received_at) end,
    'checks', pg_catalog.jsonb_build_object(
      'totals_mismatch', d.total_amount is not null and d.net_amount is not null and d.vat_amount is not null
        and abs(d.net_amount + d.vat_amount - d.total_amount) > 1,
      'vat_lines_mismatch', d.vat_amount is not null and pg_catalog.jsonb_array_length(d.vat_lines) > 0
        and abs(d.vat_amount - (select coalesce(sum((v->>'vat')::numeric), 0) from pg_catalog.jsonb_array_elements(d.vat_lines) v)) > 1,
      'order_difference', case when po.id is not null and d.total_amount is not null
        then d.total_amount - private.purchase_order_total(po.lines) end,
      'overdue', d.status = 'approved' and d.due_date is not null and d.due_date < atlas_private.venue_date(),
      'possible_duplicates', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', o.id, 'status', o.status, 'document_number', o.document_number, 'issue_date', o.issue_date, 'total_amount', o.total_amount)
          order by o.created_at)
        from atlas_private.accounting_documents o
        left join public.suppliers os on os.id = o.supplier_id
        where o.id <> d.id and o.status not in ('discarded','void')
          and atlas_private.accounting_fold(coalesce(o.supplier_name, os.name, '')) = atlas_private.accounting_fold(coalesce(d.supplier_name, s.name, ''))
          and atlas_private.accounting_fold(coalesce(d.supplier_name, s.name, '')) is not null
          and (
            (atlas_private.accounting_fold(o.document_number) is not null
              and atlas_private.accounting_fold(o.document_number) = atlas_private.accounting_fold(d.document_number))
            or (o.total_amount is not null and o.total_amount = d.total_amount and o.issue_date = d.issue_date)
          )
      ), '[]'::jsonb)
    )
  )
  from atlas_private.accounting_documents d
  left join public.suppliers s on s.id = d.supplier_id
  left join public.profiles pp on pp.id = d.paid_by_profile_id
  left join public.profiles ap on ap.id = d.approved_by
  left join public.purchase_orders po on po.id = d.purchase_order_id
  left join public.suppliers ps on ps.id = po.supplier_id
  where d.id = p_id;
$function$;
revoke all on function atlas_private.accounting_document_json(uuid) from public, anon, authenticated;

-- Validated editable fields from a jsonb payload. Unknown keys are ignored;
-- a present key with an invalid value is refused (22023).
create or replace function atlas_private.accounting_apply_fields(p_id uuid, p_fields jsonb, p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  f jsonb := coalesce(p_fields, '{}'::jsonb);
  line jsonb;
  supplier uuid;
begin
  if jsonb_typeof(f) <> 'object' then
    raise exception 'fields must be an object' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if f ? 'supplier_id' and nullif(f->>'supplier_id', '') is not null then
    supplier := (f->>'supplier_id')::uuid;
    if not exists (select 1 from public.suppliers s where s.id = supplier) then
      raise exception 'unknown supplier' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
  end if;
  if f ? 'purchase_order_id' and nullif(f->>'purchase_order_id', '') is not null
     and not exists (select 1 from public.purchase_orders o where o.id = (f->>'purchase_order_id')::uuid) then
    raise exception 'unknown purchase order' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if f ? 'paid_by_profile_id' and nullif(f->>'paid_by_profile_id', '') is not null
     and not exists (select 1 from public.profiles p where p.id = (f->>'paid_by_profile_id')::uuid) then
    raise exception 'unknown team member' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if f ? 'vat_lines' then
    if jsonb_typeof(f->'vat_lines') <> 'array' or jsonb_array_length(f->'vat_lines') > 6 then
      raise exception 'invalid vat lines' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    for line in select value from jsonb_array_elements(f->'vat_lines') loop
      if jsonb_typeof(line) <> 'object'
         or (line->>'rate')::numeric not in (0, 11, 24)
         or coalesce((line->>'net')::numeric, 0) < 0 or coalesce((line->>'vat')::numeric, 0) < 0 then
        raise exception 'invalid vat line' using errcode = '22023', hint = 'atlas:invalid_request';
      end if;
    end loop;
  end if;

  update atlas_private.accounting_documents d set
    kind = case when f ? 'kind' then coalesce(nullif(f->>'kind', ''), d.kind) else d.kind end,
    category = case when f ? 'category' then nullif(f->>'category', '') else d.category end,
    supplier_id = case when f ? 'supplier_id' then nullif(f->>'supplier_id', '')::uuid else d.supplier_id end,
    supplier_name = case when f ? 'supplier_name' then nullif(pg_catalog.btrim(f->>'supplier_name'), '') else d.supplier_name end,
    supplier_kennitala = case when f ? 'supplier_kennitala' then nullif(pg_catalog.regexp_replace(coalesce(f->>'supplier_kennitala', ''), '[^0-9]', '', 'g'), '') else d.supplier_kennitala end,
    document_number = case when f ? 'document_number' then nullif(pg_catalog.btrim(f->>'document_number'), '') else d.document_number end,
    issue_date = case when f ? 'issue_date' then nullif(f->>'issue_date', '')::date else d.issue_date end,
    due_date = case when f ? 'due_date' then nullif(f->>'due_date', '')::date else d.due_date end,
    currency = case when f ? 'currency' then coalesce(pg_catalog.upper(nullif(pg_catalog.btrim(f->>'currency'), '')), 'ISK') else d.currency end,
    net_amount = case when f ? 'net_amount' then nullif(f->>'net_amount', '')::numeric else d.net_amount end,
    vat_amount = case when f ? 'vat_amount' then nullif(f->>'vat_amount', '')::numeric else d.vat_amount end,
    total_amount = case when f ? 'total_amount' then nullif(f->>'total_amount', '')::numeric else d.total_amount end,
    vat_lines = case when f ? 'vat_lines' then f->'vat_lines' else d.vat_lines end,
    purchase_order_id = case when f ? 'purchase_order_id' then nullif(f->>'purchase_order_id', '')::uuid else d.purchase_order_id end,
    note = case when f ? 'note' then nullif(pg_catalog.btrim(f->>'note'), '') else d.note end,
    paid_by = case when f ? 'paid_by' then coalesce(nullif(f->>'paid_by', ''), 'company') else d.paid_by end,
    paid_by_profile_id = case
      when f ? 'paid_by' and coalesce(nullif(f->>'paid_by', ''), 'company') = 'company' then null
      when f ? 'paid_by_profile_id' then nullif(f->>'paid_by_profile_id', '')::uuid
      else d.paid_by_profile_id end,
    updated_by = p_actor_id,
    updated_at = pg_catalog.now()
  where d.id = p_id;
exception
  when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then
    raise exception 'invalid field value' using errcode = '22023', hint = 'atlas:invalid_request';
  when check_violation then
    raise exception 'invalid field value' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function atlas_private.accounting_apply_fields(uuid,jsonb,uuid) from public, anon, authenticated;

-- Gateway RPCs (service_role only) ------------------------------------------

-- The workspace: open documents of any age, everything else from the last
-- 400 days, plus suppliers, recent orders and the team for "Paid by".
create or replace function public.atlas_accounting_snapshot(p_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  today date := atlas_private.venue_date();
begin
  perform atlas_private.accounting_require_admin(p_actor_id);
  return pg_catalog.jsonb_build_object(
    'today', today,
    'documents', coalesce((
      select pg_catalog.jsonb_agg(atlas_private.accounting_document_json(d.id) order by coalesce(d.issue_date, d.created_at::date) desc, d.created_at desc)
      from (
        select id, issue_date, created_at from atlas_private.accounting_documents
        where status in ('to_review','approved') or created_at >= pg_catalog.now() - interval '400 days'
           or issue_date >= today - 400
        order by created_at desc limit 1000
      ) d
    ), '[]'::jsonb),
    'suppliers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
      from public.suppliers s where s.active is not false
    ), '[]'::jsonb),
    'orders', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', o.id, 'supplier_id', o.supplier_id, 'status', o.status,
        'total', private.purchase_order_total(o.lines), 'ordered_at', o.ordered_at, 'received_at', o.received_at,
        'created_at', o.created_at) order by o.created_at desc)
      from (select * from public.purchase_orders
            where status not in ('draft','cancelled') and created_at >= pg_catalog.now() - interval '180 days'
            order by created_at desc limit 300) o
    ), '[]'::jsonb),
    'team', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'label', coalesce(nullif(pg_catalog.btrim(p.display_name), ''), 'Team member'), 'active', p.active)
        order by p.active desc, p.display_name)
      from public.profiles p
    ), '[]'::jsonb),
    'ai_enabled', coalesce((select a.enabled from atlas_private.ai_settings a limit 1), false),
    'reads_today', (
      select count(*) from atlas_private.accounting_document_events e
      where e.action = 'read_started' and e.created_at >= pg_catalog.now() - interval '24 hours')
  );
end
$function$;

create or replace function public.atlas_accounting_document(p_actor_id uuid, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
begin
  perform atlas_private.accounting_require_admin(p_actor_id);
  result := atlas_private.accounting_document_json(p_id);
  if result is null then
    raise exception 'document not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  return result || pg_catalog.jsonb_build_object('history', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'action', e.action, 'actor_label', e.actor_label, 'details', e.details, 'created_at', e.created_at) order by e.id desc)
    from atlas_private.accounting_document_events e where e.document_id = p_id
  ), '[]'::jsonb));
end
$function$;

-- A live document already holds this file (the gateway checks before storing).
create or replace function public.atlas_accounting_find_file(p_actor_id uuid, p_sha256 text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform atlas_private.accounting_require_admin(p_actor_id);
  return (
    select pg_catalog.jsonb_build_object('id', d.id, 'status', d.status, 'supplier_name', d.supplier_name,
      'document_number', d.document_number, 'created_at', d.created_at)
    from atlas_private.accounting_documents d
    where d.file_sha256 = p_sha256 and d.status <> 'discarded'
    limit 1
  );
end
$function$;

-- Records an uploaded file as a new document to review. Idempotent on
-- (actor, request id): a retry returns the first document.
create or replace function public.atlas_accounting_create(
  p_actor_id uuid, p_request_id uuid, p_file jsonb, p_fields jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.accounting_require_admin(p_actor_id);
  existing uuid;
  created uuid;
begin
  if p_request_id is null or p_file is null or jsonb_typeof(p_file) <> 'object' then
    raise exception 'invalid upload' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select d.id into existing from atlas_private.accounting_documents d
  where d.created_by = p_actor_id and d.request_id = p_request_id;
  if existing is not null then
    return atlas_private.accounting_document_json(existing) || '{"replayed": true}'::jsonb;
  end if;
  if exists (select 1 from atlas_private.accounting_documents d where d.file_sha256 = p_file->>'sha256' and d.status <> 'discarded') then
    raise exception 'this file is already in Accounting' using errcode = '23505', hint = 'atlas:duplicate_file';
  end if;
  begin
    insert into atlas_private.accounting_documents (
      id, storage_path, mime_type, byte_size, file_sha256, file_name, request_id, created_by, created_by_label, updated_by)
    values (
      (p_file->>'document_id')::uuid, p_file->>'storage_path', p_file->>'mime_type', (p_file->>'byte_size')::integer,
      p_file->>'sha256', nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_file->>'file_name', '')), 160), ''),
      p_request_id, p_actor_id, label, p_actor_id)
    returning id into created;
  exception
    when check_violation or not_null_violation or invalid_text_representation then
      raise exception 'invalid upload' using errcode = '22023', hint = 'atlas:invalid_request';
  end;
  perform atlas_private.accounting_apply_fields(created, p_fields, p_actor_id);
  perform atlas_private.accounting_log(created, 'uploaded', p_actor_id, label,
    pg_catalog.jsonb_build_object('mime_type', p_file->>'mime_type', 'byte_size', (p_file->>'byte_size')::integer));
  return atlas_private.accounting_document_json(created);
end
$function$;

-- Daily limit for Atlas reading documents (a cost guard). Marks the document
-- as being read and logs it; the gateway then calls the model, only when
-- Atlas AI is switched on (Settings › Atlas AI, ai_settings.enabled).
create or replace function public.atlas_accounting_begin_read(p_actor_id uuid, p_id uuid, p_daily_limit integer default 60)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.accounting_require_admin(p_actor_id);
  doc atlas_private.accounting_documents%rowtype;
  used integer;
begin
  select * into doc from atlas_private.accounting_documents d where d.id = p_id for update;
  if doc.id is null then
    raise exception 'document not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  if doc.status <> 'to_review' or doc.storage_path is null then
    raise exception 'only a document to review can be read' using errcode = '40001', hint = 'atlas:stale_request';
  end if;
  select count(*) into used from atlas_private.accounting_document_events e
  where e.action = 'read_started' and e.created_at >= pg_catalog.now() - interval '24 hours';
  if used >= greatest(1, least(coalesce(p_daily_limit, 60), 500)) then
    raise exception 'rate_limited: daily document reading limit' using errcode = 'P0001';
  end if;
  update atlas_private.accounting_documents set extraction_status = 'reading', updated_at = pg_catalog.now() where id = p_id;
  perform atlas_private.accounting_log(p_id, 'read_started', p_actor_id, label, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('id', doc.id, 'storage_path', doc.storage_path, 'mime_type', doc.mime_type, 'file_name', doc.file_name,
    'ai_enabled', coalesce((select a.enabled from atlas_private.ai_settings a limit 1), false));
end
$function$;

-- Commands on one document, each checked against its version.
--   save            edit the fields while it is to review
--   record_read     store what Atlas read (draft) and fill only EMPTY fields
--   approve         to review -> approved (supplier, date and total required)
--   reopen          approved (unpaid) -> to review
--   mark_paid       approved -> paid (date, method, reference); staff-paid = reimbursed
--   unmark_paid     paid -> approved
--   void            approved or paid -> void, with a reason; the file is kept
--   discard         to review -> discarded; returns the file path to remove
create or replace function public.atlas_accounting_command(
  p_actor_id uuid, p_id uuid, p_version integer, p_command text, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.accounting_require_admin(p_actor_id);
  doc atlas_private.accounting_documents%rowtype;
  payload jsonb := coalesce(p_payload, '{}'::jsonb);
  fields jsonb;
  draft jsonb;
  prefill jsonb;
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
    raise exception 'document changed' using errcode = '40001', hint = 'atlas:stale_request';
  end if;

  case p_command
  when 'save' then
    if doc.status <> 'to_review' then
      raise exception 'only a document to review can be edited' using errcode = '40001', hint = 'atlas:stale_request';
    end if;
    fields := coalesce(payload->'fields', '{}'::jsonb);
    perform atlas_private.accounting_apply_fields(p_id, fields, p_actor_id);
    perform atlas_private.accounting_log(p_id, 'edited', p_actor_id, label,
      pg_catalog.jsonb_build_object('fields', (select coalesce(pg_catalog.jsonb_agg(k order by k), '[]'::jsonb) from pg_catalog.jsonb_object_keys(fields) k)));

  when 'record_read' then
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
      if doc.status = 'to_review' then
        fields := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', case when doc.kind = 'invoice' and prefill->>'kind' in ('receipt','credit_note','other') then prefill->>'kind' end,
          'supplier_name', case when doc.supplier_name is null and doc.supplier_id is null then prefill->>'supplier_name' end,
          'supplier_id', case when doc.supplier_id is null then prefill->>'supplier_id' end,
          'supplier_kennitala', case when doc.supplier_kennitala is null then prefill->>'supplier_kennitala' end,
          'document_number', case when doc.document_number is null then prefill->>'document_number' end,
          'issue_date', case when doc.issue_date is null then prefill->>'issue_date' end,
          'due_date', case when doc.due_date is null then prefill->>'due_date' end,
          'currency', case when doc.currency = 'ISK' then prefill->>'currency' end,
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
        pg_catalog.jsonb_build_object('reason', pg_catalog.left(coalesce(payload->>'outcome', 'failed'), 40)));
    end if;
    -- The version moves on (below), so a form opened before the read reloads
    -- instead of saving its empty fields over what Atlas filled in.

  when 'approve' then
    if doc.status <> 'to_review' then
      raise exception 'only a document to review can be approved' using errcode = '40001', hint = 'atlas:stale_request';
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
      raise exception 'only an approved, unpaid document can be reopened' using errcode = '40001', hint = 'atlas:stale_request';
    end if;
    update atlas_private.accounting_documents set status = 'to_review', approved_by = null, approved_at = null,
      updated_by = p_actor_id, updated_at = pg_catalog.now() where id = p_id;
    perform atlas_private.accounting_log(p_id, 'reopened', p_actor_id, label, '{}'::jsonb);

  when 'mark_paid' then
    if doc.status <> 'approved' then
      raise exception 'only an approved document can be marked paid' using errcode = '40001', hint = 'atlas:stale_request';
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
      raise exception 'only a paid document can be unmarked' using errcode = '40001', hint = 'atlas:stale_request';
    end if;
    update atlas_private.accounting_documents set status = 'approved', paid_at = null, payment_method = null, payment_reference = null,
      updated_by = p_actor_id, updated_at = pg_catalog.now() where id = p_id;
    perform atlas_private.accounting_log(p_id, 'unpaid', p_actor_id, label, '{}'::jsonb);

  when 'void' then
    if doc.status not in ('approved','paid') then
      raise exception 'only an approved or paid document can be voided' using errcode = '40001', hint = 'atlas:stale_request';
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
    if doc.status <> 'to_review' then
      raise exception 'only a document to review can be discarded' using errcode = '40001', hint = 'atlas:stale_request';
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
$function$;

-- A signed link for an administrator: returns the path and logs the opening.
create or replace function public.atlas_accounting_file(p_actor_id uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.accounting_require_admin(p_actor_id);
  doc record;
begin
  select d.id, d.storage_path, d.mime_type, d.file_name into doc from atlas_private.accounting_documents d where d.id = p_id;
  if doc.id is null or doc.storage_path is null then
    raise exception 'file not found' using errcode = 'P0002', hint = 'atlas:not_found';
  end if;
  perform atlas_private.accounting_log(p_id, 'file_opened', p_actor_id, label, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('storage_path', doc.storage_path, 'mime_type', doc.mime_type, 'file_name', doc.file_name);
end
$function$;

-- The accountant's export: every approved, paid or void document whose
-- document date is in the range (void rows are included and marked).
create or replace function public.atlas_accounting_export(p_actor_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.accounting_require_admin(p_actor_id);
  result_rows jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'invalid range' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select coalesce(pg_catalog.jsonb_agg(atlas_private.accounting_document_json(d.id)
           || pg_catalog.jsonb_build_object('storage_path', d.storage_path) order by d.issue_date, d.created_at), '[]'::jsonb)
  into result_rows
  from atlas_private.accounting_documents d
  where d.status in ('approved','paid','void') and d.issue_date between p_from and p_to;
  insert into atlas_private.accounting_document_events (document_id, action, actor_id, actor_label, details)
  select (r->>'id')::uuid, 'exported', p_actor_id, label, pg_catalog.jsonb_build_object('from', p_from, 'to', p_to)
  from pg_catalog.jsonb_array_elements(result_rows) r;
  return pg_catalog.jsonb_build_object('from', p_from, 'to', p_to, 'documents', result_rows);
end
$function$;

revoke all on function public.atlas_accounting_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.atlas_accounting_document(uuid,uuid) from public, anon, authenticated;
revoke all on function public.atlas_accounting_find_file(uuid,text) from public, anon, authenticated;
revoke all on function public.atlas_accounting_create(uuid,uuid,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.atlas_accounting_begin_read(uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.atlas_accounting_command(uuid,uuid,integer,text,jsonb) from public, anon, authenticated;
revoke all on function public.atlas_accounting_file(uuid,uuid) from public, anon, authenticated;
revoke all on function public.atlas_accounting_export(uuid,date,date) from public, anon, authenticated;
grant execute on function public.atlas_accounting_snapshot(uuid) to service_role;
grant execute on function public.atlas_accounting_document(uuid,uuid) to service_role;
grant execute on function public.atlas_accounting_find_file(uuid,text) to service_role;
grant execute on function public.atlas_accounting_create(uuid,uuid,jsonb,jsonb) to service_role;
grant execute on function public.atlas_accounting_begin_read(uuid,uuid,integer) to service_role;
grant execute on function public.atlas_accounting_command(uuid,uuid,integer,text,jsonb) to service_role;
grant execute on function public.atlas_accounting_file(uuid,uuid) to service_role;
grant execute on function public.atlas_accounting_export(uuid,date,date) to service_role;
