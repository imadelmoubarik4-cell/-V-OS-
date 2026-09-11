-- S33 runtime source contracts missing from the reviewed Phase 1 baseline.
--
-- Supabase CLI 2.117.0 allocated this migration identity. The migration adds
-- empty application tables only: it does not insert staff, schedule or
-- onboarding data.

do $preflight$
begin
  if to_regclass('public.profiles') is null
     or to_regprocedure('private.is_active_staff()') is null
     or to_regprocedure('private.is_manager_or_admin()') is null
     or to_regprocedure('private.is_self_or_manager(uuid)') is null then
    raise exception 'S33 runtime source contracts require the reviewed Phase 1 profile and authorization baseline';
  end if;

  if to_regclass('public.onboarding_tasks') is not null
     or to_regclass('public.onboarding_progress') is not null
     or to_regclass('public.shifts') is not null
     or to_regclass('atlas_private.report_events') is not null then
    raise exception 'S33 runtime source contract target is not empty';
  end if;
end
$preflight$;

create table public.onboarding_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 200),
  description text,
  category text not null default 'general' check (length(trim(category)) between 1 and 80),
  sort_order integer not null default 0,
  required boolean not null default false,
  active boolean not null default true
);

create index onboarding_tasks_active_order_idx
  on public.onboarding_tasks (active, sort_order, title);

create table public.onboarding_progress (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.onboarding_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  completed_at timestamptz not null default now(),
  completed_by uuid references public.profiles(id) on delete set null,
  note text check (note is null or length(note) <= 2000),
  unique (task_id, user_id)
);

create index onboarding_progress_user_idx
  on public.onboarding_progress (user_id, completed_at desc);

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  role_name text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (length(status) between 1 and 40)
);

create index shifts_starts_at_idx on public.shifts (starts_at);
create index shifts_user_starts_at_idx on public.shifts (user_id, starts_at);

create table atlas_private.report_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (length(trim(event_type)) between 1 and 80),
  saved_view_id uuid,
  report_key text,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_label text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index report_events_created_at_idx
  on atlas_private.report_events (created_at desc);

revoke all on table atlas_private.report_events
  from public, anon, authenticated;
grant select, insert on table atlas_private.report_events to service_role;

revoke all on table public.onboarding_tasks, public.onboarding_progress, public.shifts
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.onboarding_tasks, public.onboarding_progress, public.shifts
  to authenticated;

alter table public.onboarding_tasks enable row level security;
alter table public.onboarding_progress enable row level security;
alter table public.shifts enable row level security;

create policy "active staff read onboarding tasks"
  on public.onboarding_tasks for select to authenticated
  using (private.is_active_staff() and active is true);
create policy "active managers add onboarding tasks"
  on public.onboarding_tasks for insert to authenticated
  with check (private.is_manager_or_admin());
create policy "active managers update onboarding tasks"
  on public.onboarding_tasks for update to authenticated
  using (private.is_manager_or_admin())
  with check (private.is_manager_or_admin());
create policy "active managers delete onboarding tasks"
  on public.onboarding_tasks for delete to authenticated
  using (private.is_manager_or_admin());

create policy "staff read own onboarding progress"
  on public.onboarding_progress for select to authenticated
  using (private.is_self_or_manager(user_id));
create policy "staff add own onboarding progress"
  on public.onboarding_progress for insert to authenticated
  with check (private.is_self_or_manager(user_id));
create policy "staff update own onboarding progress"
  on public.onboarding_progress for update to authenticated
  using (private.is_self_or_manager(user_id))
  with check (private.is_self_or_manager(user_id));
create policy "active managers delete onboarding progress"
  on public.onboarding_progress for delete to authenticated
  using (private.is_manager_or_admin());

create policy "active staff read shifts"
  on public.shifts for select to authenticated
  using (private.is_active_staff());
create policy "active managers add shifts"
  on public.shifts for insert to authenticated
  with check (private.is_manager_or_admin());
create policy "active managers update shifts"
  on public.shifts for update to authenticated
  using (private.is_manager_or_admin())
  with check (private.is_manager_or_admin());
create policy "active managers delete shifts"
  on public.shifts for delete to authenticated
  using (private.is_manager_or_admin());

comment on table public.onboarding_tasks is
  'Manager-maintained onboarding task catalogue consumed by Atlas Knowledge and Team Profiles.';
comment on table public.onboarding_progress is
  'Per-profile onboarding completion records consumed by Atlas Knowledge and Team Profiles.';
comment on table public.shifts is
  'Published shift link targets consumed by Atlas Team Messages; private shift planning remains authoritative.';
comment on table atlas_private.report_events is
  'Private Reports audit source consumed by the Atlas System timeline; initialized empty in S33.';
