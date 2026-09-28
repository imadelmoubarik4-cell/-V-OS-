-- S96 test fixture (NOT a migration): recreate the production-only legacy public tables
-- (shifts, staff_availability, staff_details, staff_documents, onboarding_tasks,
-- onboarding_progress, document_acknowledgements) with the columns, constraints, grants and
-- policies captured read-only from the production catalog on 2026-09-28. No repository
-- migration creates them, so a clean replay cannot otherwise exercise their policies.
-- Apply to a disposable replay database BEFORE the S96 migrations to mirror production:
--   psql -v ON_ERROR_STOP=1 -X -q -f scripts/s96_production_legacy_tables_fixture.sql
-- Contains no production rows.

begin;
-- Production-only legacy tables (not created by any repo migration).
create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_name text, starts_at timestamptz not null, ends_at timestamptz not null,
  break_minutes integer not null default 0 check (break_minutes >= 0),
  status text not null default 'draft' check (status = any (array['draft','published','confirmed','completed','cancelled'])),
  note text, created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_at > starts_at));
create table if not exists public.staff_availability (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  available_from time, available_to time, unavailable boolean not null default false, note text,
  unique (user_id, weekday));
create table if not exists public.staff_details (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  job_title text, phone text, emergency_contact_name text, emergency_contact_phone text,
  start_date date, hourly_rate numeric check (hourly_rate is null or hourly_rate >= 0), notes text,
  updated_at timestamptz not null default now());
create table if not exists public.staff_documents (
  id uuid primary key default gen_random_uuid(), title text not null, category text not null default 'general',
  content text, file_url text, required boolean not null default false, active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.onboarding_tasks (
  id uuid primary key default gen_random_uuid(), title text not null, description text,
  category text not null default 'general', sort_order integer not null default 0,
  required boolean not null default true, active boolean not null default true);
create table if not exists public.onboarding_progress (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.onboarding_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  completed_at timestamptz, completed_by uuid references public.profiles(id) on delete set null, note text,
  unique (task_id, user_id));
create table if not exists public.document_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.staff_documents(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  acknowledged_at timestamptz not null default now(), unique (document_id, user_id));

do $$ declare t text; begin
  foreach t in array array['shifts','staff_availability','staff_details','staff_documents','onboarding_tasks','onboarding_progress','document_acknowledgements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant select, insert, update, delete on public.shifts, public.staff_availability, public.staff_details,
  public.staff_documents, public.onboarding_tasks, public.onboarding_progress to authenticated;
grant select, insert on public.document_acknowledgements to authenticated;

create policy "staff add own acknowledgements" on public.document_acknowledgements for insert to authenticated with check (private.is_active_staff() AND (user_id = ( SELECT auth.uid() AS uid)));
create policy "staff read own acknowledgements" on public.document_acknowledgements for select to authenticated using (private.is_self_or_manager(user_id));
create policy "active managers delete onboarding progress" on public.onboarding_progress for delete to authenticated using (private.is_manager_or_admin());
create policy "staff add own onboarding progress" on public.onboarding_progress for insert to authenticated with check (private.is_self_or_manager(user_id));
create policy "staff read own onboarding progress" on public.onboarding_progress for select to authenticated using (private.is_self_or_manager(user_id));
create policy "staff update own onboarding progress" on public.onboarding_progress for update to authenticated using (private.is_self_or_manager(user_id)) with check (private.is_self_or_manager(user_id));
create policy "active managers add onboarding tasks" on public.onboarding_tasks for insert to authenticated with check (private.is_manager_or_admin());
create policy "active managers delete onboarding tasks" on public.onboarding_tasks for delete to authenticated using (private.is_manager_or_admin());
create policy "active managers update onboarding tasks" on public.onboarding_tasks for update to authenticated using (private.is_manager_or_admin()) with check (private.is_manager_or_admin());
create policy "active staff read onboarding tasks" on public.onboarding_tasks for select to authenticated using (private.is_active_staff() AND (active IS TRUE));
create policy "active managers add shifts" on public.shifts for insert to authenticated with check (private.is_manager_or_admin());
create policy "active managers delete shifts" on public.shifts for delete to authenticated using (private.is_manager_or_admin());
create policy "active managers update shifts" on public.shifts for update to authenticated using (private.is_manager_or_admin()) with check (private.is_manager_or_admin());
create policy "active staff read shifts" on public.shifts for select to authenticated using (private.is_active_staff());
create policy "staff add own availability" on public.staff_availability for insert to authenticated with check (private.is_self_or_manager(user_id));
create policy "staff delete own availability" on public.staff_availability for delete to authenticated using (private.is_self_or_manager(user_id));
create policy "staff read own availability" on public.staff_availability for select to authenticated using (private.is_self_or_manager(user_id));
create policy "staff update own availability" on public.staff_availability for update to authenticated using (private.is_self_or_manager(user_id)) with check (private.is_self_or_manager(user_id));
create policy "active managers delete staff details" on public.staff_details for delete to authenticated using (private.is_manager_or_admin());
create policy "staff add own details" on public.staff_details for insert to authenticated with check (private.is_self_or_manager(user_id));
create policy "staff read own details" on public.staff_details for select to authenticated using (private.is_self_or_manager(user_id));
create policy "staff update own details" on public.staff_details for update to authenticated using (private.is_self_or_manager(user_id)) with check (private.is_self_or_manager(user_id));
create policy "active managers add staff documents" on public.staff_documents for insert to authenticated with check (private.is_manager_or_admin());
create policy "active managers delete staff documents" on public.staff_documents for delete to authenticated using (private.is_manager_or_admin());
create policy "active managers update staff documents" on public.staff_documents for update to authenticated using (private.is_manager_or_admin()) with check (private.is_manager_or_admin());
create policy "active staff read published staff documents" on public.staff_documents for select to authenticated using (private.is_active_staff() AND (active IS TRUE));

commit;
