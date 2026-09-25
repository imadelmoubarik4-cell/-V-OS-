-- S92 preview-only acceptance: Accounting documents
-- (20261001090000_s92_accounting_documents.sql). Rolled back.
--
-- * Only service_role may execute the RPCs; the tables and the bucket give
--   browsers nothing (no grants, no storage.objects policy, private bucket).
-- * Every RPC re-checks the actor: an active admin passes, a manager, a
--   bartender and an inactive admin are refused with 42501.
-- * Upload is idempotent per request id; the same file cannot be recorded
--   twice while a live record holds it.
-- * The review workflow: save, record a read (fills only empty fields, never
--   overwrites typed values), approve (required fields, duplicate
--   confirmation), mark paid / reimbursed, unmark, void with a reason,
--   discard (file path returned for removal), stale versions refused.
-- * Retention: documents cannot be deleted and the history cannot be changed.
-- * The daily read limit and the export (approved, paid and void in range).

begin;

create temporary table s92_acc (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s92_acc to public;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u.id::uuid, 'authenticated','authenticated', u.email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-4000-8000-00000092a001','s92-admin@example.invalid'),
  ('00000000-0000-4000-8000-00000092a002','s92-mgr@example.invalid'),
  ('00000000-0000-4000-8000-00000092a003','s92-bar@example.invalid'),
  ('00000000-0000-4000-8000-00000092a004','s92-old@example.invalid')) as u(id, email);
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-00000092a001','s92-admin@example.invalid','S92 Owner','admin',true),
  ('00000000-0000-4000-8000-00000092a002','s92-mgr@example.invalid','S92 Manager','manager',true),
  ('00000000-0000-4000-8000-00000092a003','s92-bar@example.invalid','S92 Anna','bartender',true),
  ('00000000-0000-4000-8000-00000092a004','s92-old@example.invalid','S92 Former admin','admin',false)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;
insert into public.suppliers (id, name, active) values ('00000000-0000-4000-8000-00000092b001', 'S92 Ölgerðin', true),
  ('00000000-0000-4000-8000-00000092b002', 'S92 Globus', true);
insert into public.profiles (id,email,display_name,role,active)
select '00000000-0000-4000-8000-00000092a005','s92-mail@example.invalid','boss@example.com','admin',true
where exists (select 1 from auth.users where id = '00000000-0000-4000-8000-00000092a005');

-- Privileges ------------------------------------------------------------------
insert into s92_acc select 'only service_role may execute the accounting RPCs',
  bool_and(has_function_privilege('service_role', f, 'execute')
    and not has_function_privilege('authenticated', f, 'execute')
    and not has_function_privilege('anon', f, 'execute'))
  from unnest(array[
    'public.atlas_accounting_snapshot(uuid)', 'public.atlas_accounting_document(uuid,uuid)',
    'public.atlas_accounting_find_file(uuid,text,uuid)', 'public.atlas_accounting_create(uuid,uuid,jsonb,jsonb)',
    'public.atlas_accounting_begin_read(uuid,uuid,integer,numeric)', 'public.atlas_accounting_command(uuid,uuid,integer,text,jsonb)',
    'public.atlas_accounting_file(uuid,uuid)', 'public.atlas_accounting_export(uuid,date,date)']) f;
insert into s92_acc select 'browsers have no table privileges; RLS is on',
  not has_table_privilege('authenticated', 'atlas_private.accounting_documents', 'select')
  and not has_table_privilege('anon', 'atlas_private.accounting_documents', 'select')
  and not has_table_privilege('authenticated', 'atlas_private.accounting_document_events', 'select')
  and (select bool_and(relrowsecurity) from pg_class where oid in ('atlas_private.accounting_documents'::regclass, 'atlas_private.accounting_document_events'::regclass));
insert into s92_acc select 'the bucket is private with no storage.objects policy',
  exists (select 1 from storage.buckets where id = 'atlas-accounting-documents' and public = false)
  and (to_regclass('storage.objects') is null or not exists (
    select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and (qual like '%atlas-accounting%' or with_check like '%atlas-accounting%')));

-- Role check ------------------------------------------------------------------
create or replace function pg_temp.refused(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'allowed';
exception when others then
  return sqlstate || ' ' || coalesce((regexp_match(sqlerrm, '^\S+'))[1], '');
end $$;

insert into s92_acc select 'a manager, a bartender and an inactive admin are refused (42501)',
  pg_temp.refused($q$select public.atlas_accounting_snapshot('00000000-0000-4000-8000-00000092a002')$q$) like '42501%'
  and pg_temp.refused($q$select public.atlas_accounting_snapshot('00000000-0000-4000-8000-00000092a003')$q$) like '42501%'
  and pg_temp.refused($q$select public.atlas_accounting_snapshot('00000000-0000-4000-8000-00000092a004')$q$) like '42501%'
  and pg_temp.refused($q$select public.atlas_accounting_snapshot(null)$q$) like '42501%';
insert into s92_acc select 'an active admin reads the workspace',
  (public.atlas_accounting_snapshot('00000000-0000-4000-8000-00000092a001') ? 'documents');

-- Upload ----------------------------------------------------------------------
create temporary table s92_doc (key text primary key, value jsonb) on commit drop;
insert into s92_doc values ('a', public.atlas_accounting_create(
  '00000000-0000-4000-8000-00000092a001', '00000000-0000-4000-8000-00000092c001',
  jsonb_build_object('document_id','00000000-0000-4000-8000-00000092d001',
    'storage_path','documents/00000000-0000-4000-8000-00000092d001/00000000-0000-4000-8000-00000092e001.pdf',
    'mime_type','application/pdf','byte_size',48213,'sha256',repeat('a',64),'file_name','olgerdin-sept.pdf'),
  '{}'::jsonb));
insert into s92_acc select 'an upload becomes a document to review with an audit entry',
  (select value->>'status' = 'to_review' and (value->>'version')::int = 1 and value->>'created_by_label' = 'S92 Owner' from s92_doc where key = 'a')
  and exists (select 1 from atlas_private.accounting_document_events where document_id = '00000000-0000-4000-8000-00000092d001' and action = 'uploaded');
insert into s92_acc select 'a retried upload (same request id) returns the same document',
  (public.atlas_accounting_create('00000000-0000-4000-8000-00000092a001', '00000000-0000-4000-8000-00000092c001',
    jsonb_build_object('document_id','00000000-0000-4000-8000-00000092d009',
      'storage_path','documents/00000000-0000-4000-8000-00000092d009/00000000-0000-4000-8000-00000092e009.pdf',
      'mime_type','application/pdf','byte_size',48213,'sha256',repeat('a',64)), '{}'::jsonb))->>'id' = '00000000-0000-4000-8000-00000092d001';
insert into s92_acc select 'the same file cannot be uploaded twice (23505 duplicate_file); find_file names it',
  pg_temp.refused($q$select public.atlas_accounting_create('00000000-0000-4000-8000-00000092a001', gen_random_uuid(),
    jsonb_build_object('document_id', '00000000-0000-4000-8000-00000092d002',
      'storage_path','documents/00000000-0000-4000-8000-00000092d002/00000000-0000-4000-8000-00000092e002.pdf',
      'mime_type','application/pdf','byte_size',10,'sha256',repeat('a',64)), '{}'::jsonb)$q$) like '23505%'
  and public.atlas_accounting_find_file('00000000-0000-4000-8000-00000092a001', repeat('a',64))->>'id' = '00000000-0000-4000-8000-00000092d001';
insert into s92_acc select 'a path outside documents/<id>/ is refused',
  pg_temp.refused($q$select public.atlas_accounting_create('00000000-0000-4000-8000-00000092a001', gen_random_uuid(),
    jsonb_build_object('document_id', '00000000-0000-4000-8000-00000092d003', 'storage_path','../profiles/x.pdf',
      'mime_type','application/pdf','byte_size',10,'sha256',repeat('b',64)), '{}'::jsonb)$q$) like '22023%';

-- Review ----------------------------------------------------------------------
insert into s92_acc select 'a stale version is refused (40001)',
  pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 7, 'save', '{"fields":{"note":"x"}}')$q$) like '40001%';
insert into s92_acc select 'invalid VAT rates and unknown suppliers are refused (22023)',
  pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 1, 'save', '{"fields":{"vat_lines":[{"rate":20,"net":100,"vat":20}]}}')$q$) like '22023%'
  and pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 1, 'save', '{"fields":{"supplier_id":"00000000-0000-4000-8000-0000000000ff"}}')$q$) like '22023%';

update s92_doc set value = public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 1, 'save',
  '{"fields":{"supplier_id":"00000000-0000-4000-8000-00000092b001","document_number":"F-1001"}}') where key = 'a';
insert into s92_acc select 'save edits fields and moves the version on',
  (select (value->>'version')::int = 2 and value->>'supplier_name' = 'S92 Ölgerðin' and value->>'document_number' = 'F-1001' from s92_doc where key = 'a');

insert into s92_acc select 'while Atlas AI is off a read spends nothing and logs nothing',
  (public.atlas_accounting_begin_read('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 60)->>'ai_enabled') = 'false';
insert into s92_acc select 'no read was logged while Atlas AI was off',
  not exists (select 1 from atlas_private.accounting_document_events where action = 'read_started');
update atlas_private.ai_settings set enabled = true;
select public.atlas_accounting_begin_read('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 60);
update s92_doc set value = public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', null, 'record_read',
  jsonb_build_object('outcome','read','model','test','tokens_in',1000,'tokens_out',200,'est_cost_usd',0.01,
    'extraction', jsonb_build_object('fields', jsonb_build_object('supplier_name','Wrong Name ehf.','net_amount',80645),
      'prefill', jsonb_build_object('supplier_name','Wrong Name ehf.','document_number','X-9','issue_date','2026-09-20',
      'due_date','2026-10-05','currency','ISK','net_amount',80645,'vat_amount',19355,'total_amount',100000,
      'vat_lines', jsonb_build_array(jsonb_build_object('rate',24,'net',80645,'vat',19355)), 'category','drinks')))) where key = 'a';
insert into s92_acc select 'a read fills only empty fields; typed values are kept; the version moves on',
  (select value->>'extraction_status' = 'read' and value->>'supplier_name' = 'S92 Ölgerðin' and value->>'document_number' = 'F-1001'
      and value->>'issue_date' = '2026-09-20' and (value->>'total_amount')::numeric = 100000 and value->>'category' = 'drinks'
      and (value->>'version')::int = 3 and value->'extraction'->'fields'->>'supplier_name' = 'Wrong Name ehf.'
   from s92_doc where key = 'a')
  and exists (select 1 from atlas_private.accounting_document_events where document_id = '00000000-0000-4000-8000-00000092d001' and action = 'read' and actor_id is null);

-- A second document from the same supplier with the same number is flagged.
select public.atlas_accounting_create('00000000-0000-4000-8000-00000092a001', '00000000-0000-4000-8000-00000092c002',
  jsonb_build_object('document_id','00000000-0000-4000-8000-00000092d002',
    'storage_path','documents/00000000-0000-4000-8000-00000092d002/00000000-0000-4000-8000-00000092e002.jpg',
    'mime_type','image/jpeg','byte_size',900000,'sha256',repeat('c',64)),
  '{"supplier_name":"S92 ÖLGERÐIN","document_number":"f-1001","issue_date":"2026-09-21","total_amount":"100000"}');
insert into s92_acc select 'a possible duplicate (same supplier and number, different file) is flagged',
  jsonb_array_length(public.atlas_accounting_document('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d002')->'checks'->'possible_duplicates') = 1;
insert into s92_acc select 'approving a possible duplicate needs confirmation (23505)',
  pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d002', 1, 'approve', '{}')$q$) like '23505%';
insert into s92_acc select 'approve needs supplier, date and total (22023)',
  pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d002', 1, 'save', '{"fields":{"issue_date":""}}')$q$) = 'allowed'
  and pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d002', 2, 'approve', '{"confirm_duplicate":true}')$q$) like '22023%';

update s92_doc set value = public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 3, 'approve', '{"confirm_duplicate":true}') where key = 'a';
insert into s92_acc select 'approve records who and when; an approved document cannot be edited',
  (select value->>'status' = 'approved' and value->>'approved_by_label' = 'S92 Owner' from s92_doc where key = 'a')
  and pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 4, 'save', '{"fields":{"note":"x"}}')$q$) like '40001%';
insert into s92_acc select 'an approved document cannot be discarded',
  pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 4, 'discard', '{}')$q$) like '40001%';

update s92_doc set value = public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 4, 'mark_paid',
  '{"paid_at":"2026-09-24","payment_method":"bank_transfer","payment_reference":"Netbanki 55"}') where key = 'a';
insert into s92_acc select 'mark paid stores date, method and reference',
  (select value->>'status' = 'paid' and value->>'paid_at' = '2026-09-24' and value->>'payment_reference' = 'Netbanki 55' from s92_doc where key = 'a');
update s92_doc set value = public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 5, 'unmark_paid', '{}') where key = 'a';
insert into s92_acc select 'unmark paid returns it to approved and clears the payment',
  (select value->>'status' = 'approved' and value->>'paid_at' is null and value->>'payment_method' is null from s92_doc where key = 'a');
insert into s92_acc select 'void needs a reason',
  pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 6, 'void', '{"reason":""}')$q$) like '22023%';
update s92_doc set value = public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 6, 'void', '{"reason":"Credit note replaced it"}') where key = 'a';
insert into s92_acc select 'void keeps the file and the reason',
  (select value->>'status' = 'void' and (value->>'has_file')::boolean and value->>'void_reason' = 'Credit note replaced it' from s92_doc where key = 'a');

-- Staff reimbursement ---------------------------------------------------------
select public.atlas_accounting_create('00000000-0000-4000-8000-00000092a001', '00000000-0000-4000-8000-00000092c003',
  jsonb_build_object('document_id','00000000-0000-4000-8000-00000092d003',
    'storage_path','documents/00000000-0000-4000-8000-00000092d003/00000000-0000-4000-8000-00000092e003.jpg',
    'mime_type','image/jpeg','byte_size',400000,'sha256',repeat('d',64)),
  '{"kind":"receipt","supplier_name":"Bónus","issue_date":"2026-09-22","total_amount":"2398","paid_by":"staff","category":"food"}');
insert into s92_acc select 'staff-paid needs who paid before approval',
  pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d003', 1, 'approve', '{}')$q$) like '22023%';
select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d003', 1, 'save',
  '{"fields":{"paid_by":"staff","paid_by_profile_id":"00000000-0000-4000-8000-00000092a003"}}');
select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d003', 2, 'approve', '{}');
insert into s92_acc select 'an approved staff receipt shows who is owed; paying it records a reimbursement',
  (public.atlas_accounting_document('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d003')->>'paid_by_label') = 'S92 Anna'
  and (public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d003', 3, 'mark_paid', '{"payment_method":"bank_transfer"}')->>'status') = 'paid';
-- (A statement does not see rows its own function calls wrote, so the
-- history is checked in the next statement.)
insert into s92_acc select 'paying a staff receipt is logged as a reimbursement',
  exists (select 1 from atlas_private.accounting_document_events where document_id = '00000000-0000-4000-8000-00000092d003' and action = 'paid' and (details->>'reimbursement')::boolean);
insert into s92_acc select 'switching back to company-paid clears the team member',
  (select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d002', 2, 'save',
    '{"fields":{"paid_by":"company","paid_by_profile_id":"00000000-0000-4000-8000-00000092a003"}}')->>'paid_by_profile_id') is null;

-- Discard ---------------------------------------------------------------------
insert into s92_acc select 'discard (to review only) returns the file path and keeps the record',
  (public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d002', 3, 'discard', '{"reason":"Uploaded twice"}')->>'removed_storage_path')
    = 'documents/00000000-0000-4000-8000-00000092d002/00000000-0000-4000-8000-00000092e002.jpg';
insert into s92_acc select 'a discarded document keeps its record without a file',
  exists (select 1 from atlas_private.accounting_documents where id = '00000000-0000-4000-8000-00000092d002' and status = 'discarded' and storage_path is null);
insert into s92_acc select 'a discarded file can be uploaded again',
  public.atlas_accounting_find_file('00000000-0000-4000-8000-00000092a001', repeat('c',64)) is null;

-- Retention -------------------------------------------------------------------
insert into s92_acc select 'documents cannot be deleted; history cannot be changed or deleted',
  pg_temp.refused($q$delete from atlas_private.accounting_documents where id = '00000000-0000-4000-8000-00000092d001'$q$) like '42501%'
  and pg_temp.refused($q$update atlas_private.accounting_document_events set actor_label = 'x' where document_id = '00000000-0000-4000-8000-00000092d001'$q$) like '42501%'
  and pg_temp.refused($q$delete from atlas_private.accounting_document_events where document_id = '00000000-0000-4000-8000-00000092d001'$q$) like '42501%';

-- Read limit and export -------------------------------------------------------
insert into s92_acc select 'only a document to review can be read; the daily limit is enforced',
  pg_temp.refused($q$select public.atlas_accounting_begin_read('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001', 60)$q$) like '40001%'
  and pg_temp.refused($q$select public.atlas_accounting_begin_read('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d003', 1)$q$) like '40001%';
select public.atlas_accounting_create('00000000-0000-4000-8000-00000092a001', '00000000-0000-4000-8000-00000092c004',
  jsonb_build_object('document_id','00000000-0000-4000-8000-00000092d004',
    'storage_path','documents/00000000-0000-4000-8000-00000092d004/00000000-0000-4000-8000-00000092e004.png',
    'mime_type','image/png','byte_size',1000,'sha256',repeat('e',64)), '{}'::jsonb);
insert into s92_acc select 'the daily read limit refuses with rate_limited',
  pg_temp.refused($q$select public.atlas_accounting_begin_read('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d004', 1)$q$) like 'P0001 rate_limited%';

insert into s92_acc select 'export returns approved, paid and void documents in range (not to review)',
  (select jsonb_agg(d->>'status' order by d->>'status') = '["paid", "void"]'::jsonb
     from jsonb_array_elements(public.atlas_accounting_export('00000000-0000-4000-8000-00000092a001', date '2026-09-01', date '2026-09-30')->'documents') d)
  and pg_temp.refused($q$select public.atlas_accounting_export('00000000-0000-4000-8000-00000092a001', date '2020-01-01', date '2026-09-30')$q$) like '22023%';
insert into s92_acc select 'the export is logged on each exported document',
  (select count(*) = 2 from atlas_private.accounting_document_events where action = 'exported');

-- Review follow-ups ------------------------------------------------------------
insert into s92_acc select 'every edit is kept with its before and after values',
  exists (select 1 from atlas_private.accounting_document_events
          where document_id = '00000000-0000-4000-8000-00000092d001' and action = 'edited'
            and details->'changes'->'document_number' = '[null, "F-1001"]'::jsonb);

-- A reopened (once approved) document can never be discarded.
select public.atlas_accounting_create('00000000-0000-4000-8000-00000092a001', '00000000-0000-4000-8000-00000092c005',
  jsonb_build_object('document_id','00000000-0000-4000-8000-00000092d005',
    'storage_path','documents/00000000-0000-4000-8000-00000092d005/00000000-0000-4000-8000-00000092e005.pdf',
    'mime_type','application/pdf','byte_size',1000,'sha256',repeat('f',64)),
  '{"supplier_id":"00000000-0000-4000-8000-00000092b002","issue_date":"2026-08-02","total_amount":"5000"}');
select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d005', 1, 'approve', '{}');
select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d005', 2, 'reopen', '{}');
insert into s92_acc select 'a reopened document that was approved cannot be discarded (40001)',
  pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d005', 3, 'discard', '{}')$q$) like '40001%';
insert into s92_acc select 'picking a Purchasing supplier keeps its name on the record',
  (select supplier_name = 'S92 Globus' from atlas_private.accounting_documents where id = '00000000-0000-4000-8000-00000092d005');
delete from public.suppliers where id = '00000000-0000-4000-8000-00000092b002';
insert into s92_acc select 'deleting the supplier in Purchasing keeps the name on the record',
  (public.atlas_accounting_document('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d005')->>'supplier_name') = 'S92 Globus';

insert into s92_acc select 'the reimbursed team member''s name is kept on the record',
  (select paid_by_label = 'S92 Anna' from atlas_private.accounting_documents where id = '00000000-0000-4000-8000-00000092d003');

insert into s92_acc select 'NaN, infinity and far-future values are refused (22023)',
  pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d005', 3, 'save', '{"fields":{"total_amount":"NaN"}}')$q$) like '22023%'
  and pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d005', 3, 'save', '{"fields":{"issue_date":"infinity"}}')$q$) like '22023%'
  and pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d005', 3, 'save', '{"fields":{"due_date":"9999-01-01"}}')$q$) like '22023%'
  and pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d005', 3, 'save', '{"fields":{"vat_lines":[{"vat":1}]}}')$q$) like '22023%'
  and pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d005', 3, 'save', '{"fields":{"vat_lines":[{"rate":24,"net":1,"vat":"NaN"}]}}')$q$) like '22023%'
  and pg_temp.refused($q$select public.atlas_accounting_command('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d005', 3, 'save', '{"fields":{"vat_lines":[{"rate":24,"net":1,"vat":1,"x":"<img>"}]}}')$q$) like '22023%';

insert into s92_acc select 'service_role cannot delete or truncate; truncate is also blocked by trigger',
  not has_table_privilege('service_role', 'atlas_private.accounting_documents', 'delete')
  and not has_table_privilege('service_role', 'atlas_private.accounting_documents', 'truncate')
  and not has_table_privilege('service_role', 'atlas_private.accounting_document_events', 'truncate')
  and not has_table_privilege('service_role', 'atlas_private.accounting_document_events', 'update')
  and pg_temp.refused($q$truncate atlas_private.accounting_document_events$q$) like '42501%';

insert into s92_acc select 'an upload retry with the same request id replays instead of refusing the file',
  (public.atlas_accounting_find_file('00000000-0000-4000-8000-00000092a001', repeat('f',64), '00000000-0000-4000-8000-00000092c005')->>'replayed') = 'true'
  and (public.atlas_accounting_find_file('00000000-0000-4000-8000-00000092a001', repeat('f',64), gen_random_uuid())->>'id') = '00000000-0000-4000-8000-00000092d005';

insert into s92_acc select 'an email display name is never kept as a label',
  atlas_private.accounting_safe_label('boss@example.com') = 'Team member'
  and atlas_private.accounting_safe_label('  Sara   Jónsdóttir ') = 'Sara Jónsdóttir';

-- The spend budget stops reads once the estimated cost reaches it.
insert into s92_acc select 'the daily spend budget refuses reads with rate_limited',
  pg_temp.refused($q$select public.atlas_accounting_begin_read('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d004', 60, 0.01)$q$) like 'P0001 rate_limited%';

select public.atlas_accounting_file('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d004');
select public.atlas_accounting_file('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d004');
insert into s92_acc select 'opening a file twice within an hour is logged once',
  (select count(*) = 1 from atlas_private.accounting_document_events where document_id = '00000000-0000-4000-8000-00000092d004' and action = 'file_opened');

insert into s92_acc select 'the workspace list leaves out Atlas drafts; the single view keeps them',
  (select bool_and(d->'extraction' = 'null'::jsonb) from jsonb_array_elements(public.atlas_accounting_snapshot('00000000-0000-4000-8000-00000092a001')->'documents') d)
  and (public.atlas_accounting_document('00000000-0000-4000-8000-00000092a001','00000000-0000-4000-8000-00000092d001')->'extraction') ? 'prefill';

select jsonb_build_object(
  's92_accounting', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s92_acc;

rollback;
