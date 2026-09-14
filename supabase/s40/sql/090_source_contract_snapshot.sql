select jsonb_build_object(
  'source_contract_snapshot_version', 1,
  'onboarding_tasks', jsonb_build_object(
    'count', (select count(*) from public.onboarding_tasks),
    'fingerprint', (
      select md5(coalesce(string_agg(
        concat_ws('|', id::text, title, coalesce(description, ''), category,
          sort_order::text, required::text, active::text), E'\n' order by id), ''))
      from public.onboarding_tasks
    )
  ),
  'onboarding_progress', jsonb_build_object(
    'count', (select count(*) from public.onboarding_progress),
    'fingerprint', (
      select md5(coalesce(string_agg(
        concat_ws('|', id::text, task_id::text, user_id::text,
          completed_at::text, coalesce(completed_by::text, ''), coalesce(note, '')),
        E'\n' order by id), ''))
      from public.onboarding_progress
    )
  ),
  'shifts', jsonb_build_object(
    'count', (select count(*) from public.shifts),
    'fingerprint', (
      select md5(coalesce(string_agg(
        concat_ws('|', id::text, coalesce(user_id::text, ''), coalesce(role_name, ''),
          starts_at::text, ends_at::text, status, coalesce(note, ''),
          created_at::text, updated_at::text), E'\n' order by id), ''))
      from public.shifts
    )
  )
);
