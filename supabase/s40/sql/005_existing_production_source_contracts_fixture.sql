-- Synthetic schema-only/current-shape fixture for S40 disposable replay.
-- IDs and labels below are test values and do not reproduce production data.

create table public.onboarding_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 200),
  description text,
  category text not null default 'general' check (length(trim(category)) between 1 and 80),
  sort_order integer not null default 0,
  required boolean not null default false,
  active boolean not null default true
);

create table public.onboarding_progress (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.onboarding_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  completed_at timestamptz not null default now(),
  completed_by uuid references public.profiles(id) on delete set null,
  note text check (note is null or length(note) <= 2000),
  unique (task_id, user_id)
);

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

insert into public.onboarding_tasks
  (id, title, description, category, sort_order, required, active)
values
  ('40000000-0000-4000-8000-000000000001', 'Synthetic task 1', 'S40 fixture', 'general', 1, true, true),
  ('40000000-0000-4000-8000-000000000002', 'Synthetic task 2', 'S40 fixture', 'general', 2, true, true),
  ('40000000-0000-4000-8000-000000000003', 'Synthetic task 3', 'S40 fixture', 'service', 3, true, true),
  ('40000000-0000-4000-8000-000000000004', 'Synthetic task 4', 'S40 fixture', 'service', 4, false, true),
  ('40000000-0000-4000-8000-000000000005', 'Synthetic task 5', 'S40 fixture', 'safety', 5, true, true),
  ('40000000-0000-4000-8000-000000000006', 'Synthetic task 6', 'S40 fixture', 'safety', 6, false, true),
  ('40000000-0000-4000-8000-000000000007', 'Synthetic task 7', 'S40 fixture', 'systems', 7, true, true),
  ('40000000-0000-4000-8000-000000000008', 'Synthetic task 8', 'S40 fixture', 'systems', 8, false, true);
