-- S96 (security hardening, finding DBRLS-01): onboarding completion is a manager decision.
--
-- public.onboarding_progress predates the repository (production-only table, adopted by
-- 20260910094217_atlas_phase1_production_adoption.sql). Its policies let any active staff
-- member (viewer, bartender) INSERT or UPDATE their own progress rows with any values:
-- a bartender could mark every required onboarding task (food safety, etc.) as completed
-- and set completed_by to a manager's id through a direct PostgREST call, although the
-- only writer in the product, atlas-team-profiles ?action=update-onboarding, requires a
-- manager (requireManager) and always records the caller as completed_by.
--
-- After this migration:
--   * only active managers/administrators insert or update progress rows;
--   * completed_by, when set, must be the caller (no forged attribution);
--   * staff keep reading their own rows; managers keep reading and deleting all rows.
-- The table is absent from clean replays; the migration is then a no-op.

do $s96$
begin
  if to_regclass('public.onboarding_progress') is null then
    raise notice 'S96: public.onboarding_progress is absent; nothing to harden';
    return;
  end if;

  drop policy if exists "staff add own onboarding progress" on public.onboarding_progress;
  drop policy if exists "staff update own onboarding progress" on public.onboarding_progress;
  drop policy if exists "active managers add onboarding progress" on public.onboarding_progress;
  drop policy if exists "active managers update onboarding progress" on public.onboarding_progress;

  create policy "active managers add onboarding progress"
    on public.onboarding_progress for insert to authenticated
    with check (
      (select private.is_manager_or_admin())
      and (completed_by is null or completed_by = (select auth.uid()))
    );

  create policy "active managers update onboarding progress"
    on public.onboarding_progress for update to authenticated
    using ((select private.is_manager_or_admin()))
    with check (
      (select private.is_manager_or_admin())
      and (completed_by is null or completed_by = (select auth.uid()))
    );

  comment on table public.onboarding_progress is
    'Legacy onboarding progress. S96: only active managers write rows (completed_by = the caller); staff read their own rows.';
end
$s96$;

notify pgrst, 'reload schema';
