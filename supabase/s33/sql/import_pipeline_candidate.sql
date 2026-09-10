-- S33 integration candidate only. Not a registered or approved hosted migration.
-- Apply only after the private runtime schema in the disposable integration runner.
begin;
create table atlas_private.import_jobs (
  batch_id uuid primary key references public.import_batches(id) on delete restrict,
  review_batch_id uuid unique references atlas_private.import_batches(id) on delete restrict,
  status text not null check(status in ('claimed','staged','promoted')),
  source_hash text unique check(source_hash ~ '^[0-9a-f]{64}$'),
  source_snapshot jsonb not null,
  claimed_by uuid not null references public.profiles(id) on delete restrict,
  promoted_by uuid references public.profiles(id) on delete restrict,
  result jsonb,
  created_at timestamptz not null default now(),
  promoted_at timestamptz
);
create index import_jobs_claimed_by_idx on atlas_private.import_jobs(claimed_by);
create index import_jobs_promoted_by_idx on atlas_private.import_jobs(promoted_by);
alter table atlas_private.import_jobs enable row level security;
create policy "service role manages import jobs" on atlas_private.import_jobs
  for all to service_role using(true) with check(true);
revoke all on atlas_private.import_jobs from public,anon,authenticated;
grant all on atlas_private.import_jobs to service_role;

create function private.import_source_is_mutable(p_bucket text,p_name text)
returns boolean language sql stable security definer set search_path=''
as $$ select (select auth.uid()) is not null and private.is_manager_or_admin()
  and not exists(select 1 from atlas_private.import_jobs j where
    j.source_snapshot->>'storage_bucket'=p_bucket and j.source_snapshot->>'storage_path'=p_name) $$;
revoke all on function private.import_source_is_mutable(text,text) from public,anon;
grant execute on function private.import_source_is_mutable(text,text) to authenticated,service_role;
create policy "claimed import source cannot be changed" on storage.objects as restrictive
  for update to authenticated using(bucket_id<>'atlas-imports' or private.import_source_is_mutable(bucket_id,name))
  with check(bucket_id<>'atlas-imports' or private.import_source_is_mutable(bucket_id,name));
create policy "claimed import source cannot be deleted" on storage.objects as restrictive
  for delete to authenticated using(bucket_id<>'atlas-imports' or private.import_source_is_mutable(bucket_id,name));

create function private.guard_claimed_import_batch()
returns trigger language plpgsql security definer set search_path=''
as $$ begin
  -- current_setting('role') retains the actual caller role through SECURITY DEFINER.
  if coalesce(current_setting('role',true),'none') not in ('none','postgres','service_role')
     and exists(select 1 from atlas_private.import_jobs where batch_id=old.id) then
    raise exception 'Discard unpublished processing before changing or deleting this import.' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.guard_claimed_import_batch() from public,anon,authenticated;
create trigger import_batch_processing_guard before update or delete on public.import_batches
  for each row execute function private.guard_claimed_import_batch();

create function atlas_private.guard_csv_review_source()
returns trigger language plpgsql security invoker set search_path=''
as $$ begin
  if exists(select 1 from atlas_private.import_jobs where review_batch_id=old.batch_id) then
    if exists(select 1 from atlas_private.import_jobs where review_batch_id=old.batch_id and status='promoted') then
      raise exception 'Published CSV review rows are immutable';
    end if;
    if (to_jsonb(new)-array['review_status','proposed_action','matched_item_id','decision_notes','reviewed_by','reviewed_by_label','reviewed_at','decision_version','updated_at'])
      is distinct from
       (to_jsonb(old)-array['review_status','proposed_action','matched_item_id','decision_notes','reviewed_by','reviewed_by_label','reviewed_at','decision_version','updated_at']) then
      raise exception 'Extracted CSV source evidence is immutable';
    end if;
  end if;
  return new;
end $$;
revoke all on function atlas_private.guard_csv_review_source() from public,anon,authenticated;
grant execute on function atlas_private.guard_csv_review_source() to service_role;
create trigger csv_review_source_guard before update on atlas_private.import_inventory_rows
  for each row execute function atlas_private.guard_csv_review_source();

create function public.atlas_import_command(p_action text,p_batch_id uuid,p_actor uuid,p_document jsonb default null)
returns jsonb language plpgsql security invoker set search_path=''
as $$ declare
  q public.import_batches;
  job atlas_private.import_jobs;
  review_id uuid;
  r jsonb;
  item atlas_private.import_inventory_rows;
  n jsonb;
  item_id uuid;
  amount numeric;
  price numeric;
  old_actor text;
  created_ids jsonb:='[]';
  row_count integer;
begin
  if p_action is null or p_action not in ('claim','stage','promote','discard') then
    raise exception 'Unknown import action';
  end if;
  perform 1 from public.profiles where id=p_actor and active and role::text in ('admin','manager') for share;
  if not found then raise exception 'An active manager or administrator is required' using errcode='42501'; end if;
  -- Consistent queue -> job -> review rows -> inventory locking order across all commands.
  select * into q from public.import_batches where id=p_batch_id for update;
  if not found then raise exception 'Import batch does not exist'; end if;
  select * into job from atlas_private.import_jobs where batch_id=p_batch_id for update;
  if p_action='claim' then
    if job.batch_id is null then
      if q.status<>'uploaded' or q.current_stage<>'uploaded' or q.entity_scope<>'inventory'
         or lower(coalesce(q.file_extension,''))<>'csv' or q.storage_bucket is distinct from 'atlas-imports'
         or q.storage_path is null or q.file_size is null or q.file_size not between 1 and 1048576 then
        raise exception 'Use an uploaded inventory CSV of at most 1 MiB';
      end if;
      perform 1 from storage.objects where bucket_id=q.storage_bucket and name=q.storage_path for share;
      if not found then raise exception 'Uploaded source object does not exist'; end if;
      insert into atlas_private.import_jobs(batch_id,status,source_snapshot,claimed_by)
      values(q.id,'claimed',to_jsonb(q),p_actor) returning * into job;
      update public.import_batches set status='reading',current_stage='reading',progress_percent=10,
        record_counts=jsonb_build_object('worker','atlas-csv-1','processing_status','claimed'),last_error=null where id=q.id;
    end if;
    return jsonb_build_object('batch_id',q.id,'status',job.status,'storage_bucket',job.source_snapshot->>'storage_bucket',
      'storage_path',job.source_snapshot->>'storage_path','review_batch_id',job.review_batch_id);
  end if;
  if job.batch_id is null then raise exception 'Claim the source before processing'; end if;
  if p_action='discard' then
    if job.status='promoted' then raise exception 'Published inventory and its source audit cannot be discarded'; end if;
    delete from atlas_private.import_jobs where batch_id=q.id;
    if job.review_batch_id is not null then delete from atlas_private.import_batches where id=job.review_batch_id; end if;
    update public.import_batches set status='cancelled',current_stage='cancelled',progress_percent=0,
      record_counts='{}',last_error='Unpublished processing discarded.' where id=q.id;
    return jsonb_build_object('batch_id',q.id,'status','discarded');
  end if;
  if p_action='stage' then
    if p_document is null or jsonb_typeof(p_document)<>'object'
       or coalesce(p_document->>'source_hash','') !~ '^[0-9a-f]{64}$'
       or p_document->>'extractor_version' is distinct from 'atlas-csv-1'
       or jsonb_typeof(p_document->'rows') is distinct from 'array' then
      raise exception 'Invalid extraction document';
    end if;
    if job.status in ('staged','promoted') then
      if job.source_hash is distinct from p_document->>'source_hash' then raise exception 'Source hash changed'; end if;
      return jsonb_build_object('batch_id',q.id,'status',job.status,'review_batch_id',job.review_batch_id);
    end if;
    row_count:=jsonb_array_length(p_document->'rows');
    if row_count not between 1 and 1000 then raise exception 'CSV must contain 1 to 1000 rows'; end if;
    insert into atlas_private.import_batches(batch_key,source_files,status,entity_scope,source_hash,
      extractor_version,file_name,storage_bucket,storage_path,record_counts)
    values('csv-'||q.id, q.source_files,'review','inventory',p_document->>'source_hash','atlas-csv-1',
      q.file_name,q.storage_bucket,q.storage_path,jsonb_build_object('inventory',row_count)) returning id into review_id;
    for r in select value from jsonb_array_elements(p_document->'rows') loop
      n:=r->'normalized_data';
      if jsonb_typeof(r->'raw_data') is distinct from 'object' or jsonb_typeof(n) is distinct from 'object'
         or coalesce(r->>'source_hash','') !~ '^[0-9a-f]{64}$'
         or coalesce(r->>'row_number','') !~ '^[0-9]+$'
         or (r->>'row_number')::integer not between 1 and row_count
         or length(btrim(coalesce(n->>'name',''))) not between 1 and 160
         or length(btrim(coalesce(n->>'unit',''))) not between 1 and 32
         or length(coalesce(n->>'sku',''))>100
         or coalesce(n->>'quantity','') !~ '^[0-9]{1,10}(\.[0-9]{1,6})?$'
         or (n->>'quantity')::numeric>1000000
         or (n->>'cost_price' is not null and (n->>'cost_price' !~ '^[0-9]{1,10}(\.[0-9]{1,6})?$' or (n->>'cost_price')::numeric>1000000000))
         or (n->>'par_level' is not null and (n->>'par_level' !~ '^[0-9]{1,10}(\.[0-9]{1,6})?$' or (n->>'par_level')::numeric>1000000)) then
        raise exception 'Extracted row is invalid';
      end if;
      insert into atlas_private.import_inventory_rows(batch_id,row_number,source_hash,raw_data,normalized_data,canonical_key)
      values(review_id,(r->>'row_number')::integer,r->>'source_hash',r->'raw_data',n,'csv:'||q.id||':'||(r->>'row_number'));
    end loop;
    if exists(select 1 from atlas_private.import_inventory_rows where batch_id=review_id
        group by lower(btrim(normalized_data->>'name')) having count(*)>1)
       or exists(select 1 from atlas_private.import_inventory_rows where batch_id=review_id and nullif(normalized_data->>'sku','') is not null
        group by lower(btrim(normalized_data->>'sku')) having count(*)>1) then raise exception 'Duplicate CSV name or SKU'; end if;
    update atlas_private.import_jobs set status='staged',source_hash=p_document->>'source_hash',review_batch_id=review_id where batch_id=q.id;
    update public.import_batches set status='ready',current_stage='ready',progress_percent=100,
      record_counts=jsonb_build_object('worker','atlas-csv-1','processing_status','staged','rows',row_count,'review_batch_id',review_id) where id=q.id;
    return jsonb_build_object('batch_id',q.id,'status','staged','review_batch_id',review_id,'rows',row_count);
  end if;
  if job.status='promoted' then return job.result; end if;
  if job.status<>'staged' then raise exception 'Extract and review this import before publishing'; end if;
  perform 1 from atlas_private.import_inventory_rows where batch_id=job.review_batch_id order by row_number for update;
  if (select count(*) from atlas_private.import_inventory_rows where batch_id=job.review_batch_id)
       is distinct from (q.record_counts->>'rows')::integer then
    raise exception 'Extracted row count changed';
  end if;
  if exists(select 1 from atlas_private.import_inventory_rows where batch_id=job.review_batch_id and
      (review_status<>'approved' or proposed_action not in ('create','skip') or matched_item_id is not null
       or reviewed_by is null or reviewed_at is null)) then
    raise exception 'Every row must be approved as create or skip; existing-item changes require a separate reviewed workflow';
  end if;
  -- Serialize duplicate checks against concurrent inventory inserts without rewriting existing records.
  set local lock_timeout='3s';
  lock table public.inventory_items in share row exclusive mode;
  old_actor:=current_setting('request.jwt.claim.sub',true);
  perform set_config('request.jwt.claim.sub',p_actor::text,true);
  for item in select * from atlas_private.import_inventory_rows where batch_id=job.review_batch_id order by row_number loop
    n:=item.normalized_data;
    item_id:=null;
    if item.proposed_action='create' then
      if exists(select 1 from public.inventory_items i where lower(btrim(i.name))=lower(btrim(n->>'name'))
          or (nullif(n->>'sku','') is not null and lower(btrim(i.sku))=lower(btrim(n->>'sku')))) then
        raise exception 'An inventory name or SKU already exists; nothing was imported';
      end if;
      amount:=(n->>'quantity')::numeric; price:=(n->>'cost_price')::numeric;
      insert into public.inventory_items(name,category,unit,quantity,cost_price,par_level,sku,source_key,source_file,import_note,updated_by)
      values(n->>'name',coalesce(n->>'category','other'),n->>'unit',0,price,(n->>'par_level')::numeric,n->>'sku',
        item.canonical_key,q.file_name,'Reviewed CSV import '||q.id,p_actor::text) returning id into item_id;
      if amount<>0 then perform public.adjust_inventory(item_id,amount,'restock',price,null,'Reviewed CSV import '||q.id); end if;
      created_ids:=created_ids||jsonb_build_array(item_id);
    end if;
    update atlas_private.import_inventory_rows set review_status='imported',matched_item_id=item_id::text where id=item.id;
  end loop;
  perform set_config('request.jwt.claim.sub',coalesce(old_actor,''),true);
  update atlas_private.import_batches set status='promoted',current_stage='complete',progress_percent=100,completed_at=now() where id=job.review_batch_id;
  update atlas_private.import_jobs set status='promoted',promoted_by=p_actor,promoted_at=now(),
    result=jsonb_build_object('batch_id',q.id,'status','promoted','created_item_ids',created_ids) where batch_id=q.id returning * into job;
  update public.import_batches set status='completed',current_stage='complete',progress_percent=100,
    record_counts=record_counts||jsonb_build_object('processing_status','promoted','created',jsonb_array_length(created_ids)) where id=q.id;
  return job.result;
end $$;
revoke all on function public.atlas_import_command(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.atlas_import_command(text,uuid,uuid,jsonb) to service_role;
commit;
