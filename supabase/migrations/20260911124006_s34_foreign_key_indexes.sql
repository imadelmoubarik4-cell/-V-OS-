-- Atlas S34 Git-only performance candidate.
-- Generated with `supabase migration new`; intentionally not applied.
-- Scope is limited to the 12 foreign-key columns reported by the S33 advisor.

set lock_timeout = '5s';
set statement_timeout = '2min';

create index if not exists inventory_count_events_line_id_idx
  on atlas_private.inventory_count_events (line_id);
create index if not exists inventory_count_publication_lines_count_line_id_idx
  on atlas_private.inventory_count_publication_lines (count_line_id);
create index if not exists inventory_count_publication_lines_session_id_idx
  on atlas_private.inventory_count_publication_lines (session_id);
create index if not exists inventory_verified_balances_source_line_id_idx
  on atlas_private.inventory_verified_balances (source_line_id);
create index if not exists inventory_verified_balances_source_session_id_idx
  on atlas_private.inventory_verified_balances (source_session_id);
create index if not exists report_events_actor_id_idx
  on atlas_private.report_events (actor_id);
create index if not exists routine_item_results_template_item_id_idx
  on atlas_private.routine_item_results (template_item_id);
create index if not exists atlas_media_uploaded_by_idx
  on public.atlas_media (uploaded_by);
create index if not exists inventory_movements_created_by_idx
  on public.inventory_movements (created_by);
create index if not exists inventory_movements_supplier_id_idx
  on public.inventory_movements (supplier_id);
create index if not exists onboarding_progress_completed_by_idx
  on public.onboarding_progress (completed_by);
create index if not exists recipes_updated_by_idx
  on public.recipes (updated_by);

reset statement_timeout;
reset lock_timeout;
