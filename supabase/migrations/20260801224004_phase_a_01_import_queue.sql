-- Atlas Phase A.1.1 - Import Queue and private source storage
-- Applied to project dnefgcmjcgxlynycxkts on 2026-08-01.

alter table public.import_batches
  add column if not exists file_name text,
  add column if not exists file_extension text,
  add column if not exists mime_type text,
  add column if not exists file_size bigint,
  add column if not exists entity_scope text not null default 'inventory',
  add column if not exists current_stage text not null default 'uploaded',
  add column if not exists progress_percent integer not null default 0,
  add column if not exists storage_bucket text,
  add column if not exists storage_path text,
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists started_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists last_error text;

alter table public.import_batches alter column status set default 'uploaded';
alter table public.import_batches drop constraint if exists import_batches_status_check;
alter table public.import_batches add constraint import_batches_status_check check (
  status in ('prepared','uploaded','reading','extracting','matching','ready','importing','completed','completed_with_review','imported','failed','cancelled')
);
alter table public.import_batches drop constraint if exists import_batches_progress_percent_check;
alter table public.import_batches add constraint import_batches_progress_percent_check check (progress_percent between 0 and 100);

create index if not exists import_batches_status_created_idx on public.import_batches(status, created_at desc);
create index if not exists import_batches_created_by_idx on public.import_batches(created_by, created_at desc);
create index if not exists import_batches_storage_path_idx on public.import_batches(storage_bucket, storage_path) where storage_path is not null;

create or replace function public.atlas_touch_import_batch()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  new.updated_at=now();
  if new.status in ('imported','completed','completed_with_review') and new.completed_at is null then new.completed_at=now(); end if;
  return new;
end; $$;

drop trigger if exists trg_import_batches_touch on public.import_batches;
create trigger trg_import_batches_touch before update on public.import_batches for each row execute function public.atlas_touch_import_batch();

alter table public.import_batches enable row level security;
drop policy if exists "authenticated staff can insert import batches" on public.import_batches;
create policy "authenticated staff can insert import batches" on public.import_batches for insert to authenticated with check ((select auth.uid()) is not null);
drop policy if exists "authenticated staff can update import batches" on public.import_batches;
create policy "authenticated staff can update import batches" on public.import_batches for update to authenticated using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
drop policy if exists "authenticated staff can delete import batches" on public.import_batches;
create policy "authenticated staff can delete import batches" on public.import_batches for delete to authenticated using ((select auth.uid()) is not null);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('atlas-imports','atlas-imports',false,52428800,array['text/csv','text/plain','application/json','application/pdf','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/jpeg','image/png','image/webp','image/heic','image/heif']::text[])
on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "authenticated staff can view atlas import files" on storage.objects;
create policy "authenticated staff can view atlas import files" on storage.objects for select to authenticated using(bucket_id='atlas-imports' and (select auth.uid()) is not null);
drop policy if exists "authenticated staff can upload atlas import files" on storage.objects;
create policy "authenticated staff can upload atlas import files" on storage.objects for insert to authenticated with check(bucket_id='atlas-imports' and (select auth.uid()) is not null);
drop policy if exists "authenticated staff can update atlas import files" on storage.objects;
create policy "authenticated staff can update atlas import files" on storage.objects for update to authenticated using(bucket_id='atlas-imports' and (select auth.uid()) is not null) with check(bucket_id='atlas-imports' and (select auth.uid()) is not null);
drop policy if exists "authenticated staff can delete atlas import files" on storage.objects;
create policy "authenticated staff can delete atlas import files" on storage.objects for delete to authenticated using(bucket_id='atlas-imports' and (select auth.uid()) is not null);
