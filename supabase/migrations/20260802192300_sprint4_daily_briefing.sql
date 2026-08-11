-- Sprint 4 - Atlas Brain Daily Briefing.
-- Deterministic, source-aware and read-only. Contains no VÁ operational rows.
-- Depends on the Sprint 3 private staging and review migrations.

create or replace function public.atlas_sprint4_daily_briefing()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_generated_at timestamptz := pg_catalog.now();
  v_venue_date date := (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date;
  v_total bigint := 0;
  v_pending bigint := 0;
  v_approved bigint := 0;
  v_rejected bigint := 0;
  v_imported bigint := 0;
  v_reviewed bigint := 0;
  v_maturity numeric := 0;
  v_batches bigint := 0;
  v_source_files bigint := 0;
  v_hashed_batches bigint := 0;
  v_latest_batch_at timestamptz;
  v_open_issues bigint := 0;
  v_error_issues bigint := 0;
  v_missing_cost bigint := 0;
  v_missing_supplier bigint := 0;
  v_missing_package bigint := 0;
  v_historical_rows bigint := 0;
  v_historical_quantities bigint := 0;
  v_historical_from date;
  v_historical_to date;
  v_coverage jsonb := '[]'::jsonb;
  v_top_issues jsonb := '[]'::jsonb;
  v_sources jsonb := '[]'::jsonb;
  v_signals jsonb := '[]'::jsonb;
  v_limitations jsonb := '[]'::jsonb;
  v_promotion_ready boolean := false;
  v_margin_ready boolean := false;
  v_headline text;
  issue_row record;
begin
  select
    coalesce(sum(coverage.total_rows), 0),
    coalesce(sum(coverage.pending_rows), 0),
    coalesce(sum(coverage.approved_rows), 0),
    coalesce(sum(coverage.rejected_rows), 0),
    coalesce(sum(coverage.imported_rows), 0)
  into v_total, v_pending, v_approved, v_rejected, v_imported
  from atlas_private.data_coverage as coverage;

  v_reviewed := v_approved + v_rejected + v_imported;
  if v_total > 0 then
    v_maturity := round((v_reviewed::numeric / v_total::numeric) * 100, 1);
  end if;

  select
    count(*)::bigint,
    count(distinct source_name)::bigint,
    count(*) filter (where source_hash is not null)::bigint,
    max(created_at)
  into v_batches, v_source_files, v_hashed_batches, v_latest_batch_at
  from (
    select
      batch.id,
      batch.source_hash,
      batch.created_at,
      unnest(
        case
          when coalesce(array_length(batch.source_files, 1), 0) > 0 then batch.source_files
          when batch.file_name is not null then array[batch.file_name]
          else array[batch.batch_key]
        end
      ) as source_name
    from atlas_private.import_batches as batch
  ) as sources;

  select
    coalesce(sum(summary.issue_count), 0),
    coalesce(sum(summary.issue_count) filter (where summary.severity = 'error'), 0),
    coalesce(sum(summary.issue_count) filter (where summary.issue = 'missing_cost'), 0),
    coalesce(sum(summary.issue_count) filter (where summary.issue = 'missing_supplier'), 0),
    coalesce(sum(summary.issue_count) filter (
      where summary.issue in ('missing_verified_package_size', 'missing_package_or_unit', 'bottle_size_not_stated')
    ), 0)
  into v_open_issues, v_error_issues, v_missing_cost, v_missing_supplier, v_missing_package
  from atlas_private.review_summary as summary;

  select
    count(*)::bigint,
    count(*) filter (where nullif(row.normalized_data ->> 'quantity', '') is not null)::bigint,
    min(
      case
        when coalesce(row.normalized_data ->> 'snapshot_effective_at', '') ~ '^\d{4}-\d{2}-\d{2}$'
          then (row.normalized_data ->> 'snapshot_effective_at')::date
        when coalesce(row.normalized_data ->> 'source_updated_at', '') ~ '^\d{4}-\d{2}-\d{2}$'
          then (row.normalized_data ->> 'source_updated_at')::date
        else null
      end
    ),
    max(
      case
        when coalesce(row.normalized_data ->> 'snapshot_effective_at', '') ~ '^\d{4}-\d{2}-\d{2}$'
          then (row.normalized_data ->> 'snapshot_effective_at')::date
        when coalesce(row.normalized_data ->> 'source_updated_at', '') ~ '^\d{4}-\d{2}-\d{2}$'
          then (row.normalized_data ->> 'source_updated_at')::date
        else null
      end
    )
  into v_historical_rows, v_historical_quantities, v_historical_from, v_historical_to
  from atlas_private.import_inventory_rows as row
  where row.normalized_data ->> 'quantity_role' = 'historical_opening_snapshot'
     or row.normalized_data ->> 'is_live_quantity' = 'false';

  select coalesce(jsonb_agg(jsonb_build_object(
    'scope', coverage.entity_scope,
    'total', coverage.total_rows,
    'pending', coverage.pending_rows,
    'approved', coverage.approved_rows,
    'rejected', coverage.rejected_rows,
    'imported', coverage.imported_rows,
    'reviewed', coverage.approved_rows + coverage.rejected_rows + coverage.imported_rows,
    'readiness_percent', case
      when coverage.total_rows > 0 then round(
        ((coverage.approved_rows + coverage.rejected_rows + coverage.imported_rows)::numeric
          / coverage.total_rows::numeric) * 100,
        1
      )
      else 0
    end,
    'confidence', case
      when coverage.pending_rows > 0 then jsonb_build_object(
        'state', 'pending',
        'score', 0.45,
        'reason', 'The domain is source-backed but still contains unreviewed records.'
      )
      when coverage.total_rows > 0 then jsonb_build_object(
        'state', 'reviewed',
        'score', 0.90,
        'reason', 'All represented rows in this domain have completed a review decision.'
      )
      else jsonb_build_object(
        'state', 'pending',
        'score', 0.20,
        'reason', 'No staged records are available for this domain.'
      )
    end,
    'source', jsonb_build_object(
      'kind', 'database_view',
      'schema', 'atlas_private',
      'object', 'data_coverage'
    )
  ) order by case coverage.entity_scope
      when 'inventory' then 1
      when 'recipe' then 2
      when 'menu' then 3
      when 'supplier' then 4
      when 'invoice' then 5
      when 'purchase' then 6
      when 'delivery' then 7
      when 'equipment' then 8
      else 99
    end), '[]'::jsonb)
  into v_coverage
  from atlas_private.data_coverage as coverage;

  select coalesce(jsonb_agg(jsonb_build_object(
    'entity_type', ranked.entity_type,
    'issue_key', ranked.issue,
    'title', initcap(replace(ranked.issue, '_', ' ')),
    'severity', ranked.severity,
    'count', ranked.issue_count,
    'confidence', jsonb_build_object(
      'state', 'pending',
      'score', 0.45,
      'reason', 'The issue count is verified, but the affected source records remain unresolved.'
    ),
    'source', jsonb_build_object(
      'kind', 'database_view',
      'schema', 'atlas_private',
      'object', 'review_summary'
    )
  ) order by ranked.severity_rank, ranked.issue_count desc, ranked.issue), '[]'::jsonb)
  into v_top_issues
  from (
    select
      summary.entity_type,
      summary.issue,
      summary.severity,
      summary.issue_count,
      case summary.severity
        when 'error' then 1
        when 'warning' then 2
        when 'review' then 3
        else 4
      end as severity_rank
    from atlas_private.review_summary as summary
    order by severity_rank, summary.issue_count desc, summary.issue
    limit 8
  ) as ranked;

  v_sources := jsonb_build_array(
    jsonb_build_object(
      'key', 'private-import-batches',
      'label', 'Private Sprint 3 import batches',
      'kind', 'database_table',
      'schema', 'atlas_private',
      'object', 'import_batches',
      'records', v_batches,
      'distinct_source_files', v_source_files,
      'hashed_records', v_hashed_batches,
      'latest_recorded_at', v_latest_batch_at,
      'confidence', jsonb_build_object(
        'state', 'verified',
        'score', 1.00,
        'reason', 'Counts are read directly from the private branch database.'
      )
    ),
    jsonb_build_object(
      'key', 'private-review-queue',
      'label', 'Real VÁ Data review queue',
      'kind', 'database_view',
      'schema', 'atlas_private',
      'object', 'review_queue',
      'records', v_total,
      'pending_records', v_pending,
      'reviewed_records', v_reviewed,
      'confidence', jsonb_build_object(
        'state', 'verified',
        'score', 1.00,
        'reason', 'Queue totals are computed from the complete private staging graph.'
      )
    ),
    jsonb_build_object(
      'key', 'historical-inventory',
      'label', 'July 2026 inventory evidence',
      'kind', 'historical_snapshot',
      'schema', 'atlas_private',
      'object', 'import_inventory_rows',
      'records', v_historical_rows,
      'effective_from', v_historical_from,
      'effective_to', v_historical_to,
      'is_live_quantity', false,
      'confidence', jsonb_build_object(
        'state', 'historical',
        'score', 0.65,
        'reason', 'The quantities are source-backed but are not current live stock.'
      )
    )
  );

  if v_pending > 0 then
    v_signals := v_signals || jsonb_build_array(jsonb_build_object(
      'key', 'review-queue-progress',
      'severity', case when v_maturity = 0 then 'high' else 'medium' end,
      'priority', 10,
      'title', format('%s source records await review', v_pending),
      'detail', format('%s of %s staged records have completed review.', v_reviewed, v_total),
      'domain', 'all',
      'confidence', jsonb_build_object(
        'state', 'verified',
        'score', 1.00,
        'reason', 'The queue totals are counted directly from the private review graph.'
      ),
      'source', jsonb_build_object(
        'kind', 'database_view',
        'schema', 'atlas_private',
        'object', 'data_coverage'
      ),
      'evidence', jsonb_build_object(
        'total_rows', v_total,
        'pending_rows', v_pending,
        'reviewed_rows', v_reviewed,
        'maturity_percent', v_maturity
      ),
      'action', jsonb_build_object('label', 'Open Data Review', 'target', 'sprint3-review')
    ));
  end if;

  for issue_row in
    select
      summary.entity_type,
      summary.issue,
      summary.severity,
      summary.issue_count,
      case summary.severity
        when 'error' then 1
        when 'warning' then 2
        when 'review' then 3
        else 4
      end as severity_rank
    from atlas_private.review_summary as summary
    order by severity_rank, summary.issue_count desc, summary.issue
    limit 5
  loop
    v_signals := v_signals || jsonb_build_array(jsonb_build_object(
      'key', 'issue:' || issue_row.entity_type || ':' || issue_row.issue,
      'severity', case issue_row.severity
        when 'error' then 'critical'
        when 'warning' then 'high'
        when 'review' then 'medium'
        else 'low'
      end,
      'priority', 20 + issue_row.severity_rank,
      'title', initcap(replace(issue_row.issue, '_', ' ')),
      'detail', format('%s %s records carry this unresolved issue.', issue_row.issue_count, replace(issue_row.entity_type, '_', ' ')),
      'domain', issue_row.entity_type,
      'confidence', jsonb_build_object(
        'state', 'pending',
        'score', 0.45,
        'reason', 'The issue count is verified, while the affected rows remain unresolved.'
      ),
      'source', jsonb_build_object(
        'kind', 'database_view',
        'schema', 'atlas_private',
        'object', 'review_summary'
      ),
      'evidence', jsonb_build_object(
        'issue_key', issue_row.issue,
        'issue_count', issue_row.issue_count,
        'entity_type', issue_row.entity_type
      ),
      'action', jsonb_build_object('label', 'Review affected records', 'target', 'sprint3-review')
    ));
  end loop;

  if v_historical_rows > 0 then
    v_signals := v_signals || jsonb_build_array(jsonb_build_object(
      'key', 'historical-inventory-snapshot',
      'severity', 'info',
      'priority', 80,
      'title', 'Historical inventory snapshot is available',
      'detail', format(
        '%s inventory rows are preserved from %s through %s and are not treated as current stock.',
        v_historical_rows,
        coalesce(to_char(v_historical_from, 'YYYY-MM-DD'), 'an unknown date'),
        coalesce(to_char(v_historical_to, 'YYYY-MM-DD'), 'an unknown date')
      ),
      'domain', 'inventory',
      'confidence', jsonb_build_object(
        'state', 'historical',
        'score', 0.65,
        'reason', 'The source evidence is preserved, but its age prevents live operational use.'
      ),
      'source', jsonb_build_object(
        'kind', 'historical_snapshot',
        'schema', 'atlas_private',
        'object', 'import_inventory_rows'
      ),
      'evidence', jsonb_build_object(
        'historical_rows', v_historical_rows,
        'rows_with_quantity', v_historical_quantities,
        'effective_from', v_historical_from,
        'effective_to', v_historical_to,
        'is_live_quantity', false
      ),
      'action', jsonb_build_object('label', 'Open inventory evidence', 'target', 'sprint3-review')
    ));
  end if;

  v_promotion_ready := v_total > 0 and v_pending = 0 and v_error_issues = 0;
  v_margin_ready := v_missing_cost = 0 and v_missing_package = 0 and v_pending = 0;

  if not v_promotion_ready then
    v_signals := v_signals || jsonb_build_array(jsonb_build_object(
      'key', 'canonical-promotion-gate',
      'severity', 'high',
      'priority', 15,
      'title', 'Canonical promotion remains blocked',
      'detail', 'Pending or unresolved source rows must be reviewed before Atlas can promote the private graph into canonical operations.',
      'domain', 'governance',
      'confidence', jsonb_build_object(
        'state', 'verified',
        'score', 1.00,
        'reason', 'The promotion gate is computed from review status and unresolved error counts.'
      ),
      'source', jsonb_build_object(
        'kind', 'computed_gate',
        'schema', 'atlas_private',
        'objects', jsonb_build_array('data_coverage', 'review_summary')
      ),
      'evidence', jsonb_build_object(
        'pending_rows', v_pending,
        'error_issue_rows', v_error_issues,
        'promotion_ready', false
      ),
      'action', jsonb_build_object('label', 'Continue review', 'target', 'sprint3-review')
    ));
  end if;

  v_limitations := v_limitations || jsonb_build_array(
    'Validated sales history is not connected to the trusted briefing layer, so demand forecasts remain disabled.'
  );
  if v_historical_rows > 0 then
    v_limitations := v_limitations || jsonb_build_array(
      'July 2026 inventory quantities are historical evidence, not current live stock.'
    );
  end if;
  if v_missing_cost > 0 or v_missing_package > 0 then
    v_limitations := v_limitations || jsonb_build_array(
      'Trusted margin recommendations remain disabled where cost or package data is incomplete.'
    );
  end if;
  if v_pending > 0 then
    v_limitations := v_limitations || jsonb_build_array(
      'Pending rows are surfaced as review work and are not treated as operational facts.'
    );
  end if;
  v_limitations := v_limitations || jsonb_build_array(
    'The Daily Briefing never creates purchase orders or promotes canonical production rows automatically.'
  );

  if v_total = 0 then
    v_headline := 'Atlas has no private source graph to brief from yet.';
  elsif v_pending > 0 then
    v_headline := format('Atlas has %s source records awaiting review.', v_pending);
  elsif v_promotion_ready then
    v_headline := 'The private source graph is reviewed and ready for a separate promotion assessment.';
  else
    v_headline := 'The source graph is reviewed, but unresolved blockers remain.';
  end if;

  return jsonb_build_object(
    'version', 'atlas-daily-briefing/0.1.0',
    'mode', 'deterministic',
    'generated_at', v_generated_at,
    'venue_date', v_venue_date,
    'headline', v_headline,
    'summary', jsonb_build_object(
      'source_batches', v_batches,
      'source_files', v_source_files,
      'hashed_batches', v_hashed_batches,
      'staged_rows', v_total,
      'pending_rows', v_pending,
      'approved_rows', v_approved,
      'rejected_rows', v_rejected,
      'imported_rows', v_imported,
      'reviewed_rows', v_reviewed,
      'maturity_percent', v_maturity,
      'open_issue_rows', v_open_issues,
      'promotion_ready', v_promotion_ready
    ),
    'capabilities', jsonb_build_object(
      'forecasting_enabled', false,
      'automatic_ordering_enabled', false,
      'trusted_margin_recommendations_enabled', v_margin_ready,
      'canonical_promotion_enabled', false
    ),
    'gaps', jsonb_build_object(
      'missing_cost_rows', v_missing_cost,
      'missing_supplier_rows', v_missing_supplier,
      'missing_package_rows', v_missing_package,
      'error_issue_rows', v_error_issues
    ),
    'historical_inventory', jsonb_build_object(
      'rows', v_historical_rows,
      'rows_with_quantity', v_historical_quantities,
      'effective_from', v_historical_from,
      'effective_to', v_historical_to,
      'is_live_quantity', false,
      'confidence', jsonb_build_object(
        'state', 'historical',
        'score', 0.65,
        'reason', 'The snapshot is source-backed, dated evidence and is not current stock.'
      )
    ),
    'coverage', v_coverage,
    'top_issues', v_top_issues,
    'sources', v_sources,
    'signals', v_signals,
    'limitations', v_limitations,
    'trust', jsonb_build_object(
      'source_graph', 'private_branch',
      'browser_direct_access', false,
      'ai_generation_used', false,
      'historical_stock_used_for_reorder', false,
      'automatic_mutation', false
    )
  );
end;
$function$;

revoke execute on function public.atlas_sprint4_daily_briefing()
  from public, anon, authenticated;
grant execute on function public.atlas_sprint4_daily_briefing()
  to service_role;

comment on function public.atlas_sprint4_daily_briefing() is
  'Service-role-only deterministic Daily Atlas Briefing. Reads private review state and never mutates or promotes canonical rows.';
