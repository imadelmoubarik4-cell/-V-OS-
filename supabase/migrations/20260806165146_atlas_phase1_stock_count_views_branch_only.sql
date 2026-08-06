-- Atlas-branch-only stock-count evidence views.
--
-- This migration is safe in every environment. It creates the redacted staff and
-- manager evidence projections only when the isolated Atlas L1 source relation is
-- present. Production has no such source relation, so production receives an
-- intentional no-op and continues to access L1 through authenticated Edge Functions.

do $atlas_stock_count_views$
begin
  if to_regclass('atlas_private.inventory_verified_balances') is not null then
    execute $ddl$
      create or replace function private.read_stock_count_summary()
      returns table (
        inventory_item_id uuid,
        item_name text,
        category text,
        inventory_unit text,
        bin_location text,
        verified_quantity numeric,
        quantity_state text,
        verified_at timestamptz,
        expires_at timestamptz,
        historical boolean
      )
      language plpgsql
      stable
      security definer
      set search_path = ''
      as $function$
      begin
        if coalesce((select auth.role()), '') <> 'service_role'
           and session_user <> 'postgres'
           and not private.is_active_staff() then
          raise exception 'An active Atlas profile is required'
            using errcode = '42501';
        end if;

        return query
        select
          balance.inventory_item_id,
          balance.item_name,
          balance.category,
          balance.inventory_unit,
          balance.bin_location,
          balance.verified_quantity,
          case
            when balance.historical is true then 'historical'
            when balance.verified_at is null then 'unverified'
            when balance.expires_at is not null and balance.expires_at <= now() then 'stale'
            when balance.verification_status = 'current' then 'current'
            else coalesce(balance.verification_status, 'unverified')
          end,
          balance.verified_at,
          balance.expires_at,
          balance.historical
        from atlas_private.inventory_verified_balances as balance;
      end;
      $function$
    $ddl$;

    execute $ddl$
      create or replace function private.read_stock_count_manager_summary()
      returns table (
        inventory_item_id uuid,
        item_name text,
        category text,
        inventory_unit text,
        bin_location text,
        verified_quantity numeric,
        quantity_state text,
        verified_at timestamptz,
        expires_at timestamptz,
        historical boolean,
        source_session_id uuid,
        source_line_id uuid,
        verified_by uuid,
        verified_by_label text,
        production_quantity_at_verification numeric,
        production_updated_at timestamptz,
        variance numeric,
        source_kind text
      )
      language plpgsql
      stable
      security definer
      set search_path = ''
      as $function$
      begin
        if coalesce((select auth.role()), '') <> 'service_role'
           and session_user <> 'postgres'
           and not private.is_manager_or_admin() then
          raise exception 'Stock-count verification evidence is manager-only'
            using errcode = '42501';
        end if;

        return query
        select
          balance.inventory_item_id,
          balance.item_name,
          balance.category,
          balance.inventory_unit,
          balance.bin_location,
          balance.verified_quantity,
          case
            when balance.historical is true then 'historical'
            when balance.verified_at is null then 'unverified'
            when balance.expires_at is not null and balance.expires_at <= now() then 'stale'
            when balance.verification_status = 'current' then 'current'
            else coalesce(balance.verification_status, 'unverified')
          end,
          balance.verified_at,
          balance.expires_at,
          balance.historical,
          balance.source_session_id,
          balance.source_line_id,
          balance.verified_by,
          balance.verified_by_label,
          balance.production_quantity_at_verification,
          balance.production_updated_at,
          balance.variance,
          balance.source_kind
        from atlas_private.inventory_verified_balances as balance;
      end;
      $function$
    $ddl$;

    execute 'drop view if exists public.stock_count_summary';
    execute $ddl$
      create view public.stock_count_summary
      with (security_invoker = true)
      as
      select *
      from private.read_stock_count_summary()
    $ddl$;

    execute 'drop view if exists public.stock_count_manager_summary';
    execute $ddl$
      create view public.stock_count_manager_summary
      with (security_invoker = true)
      as
      select *
      from private.read_stock_count_manager_summary()
    $ddl$;

    execute 'revoke all on function private.read_stock_count_summary() from public, anon';
    execute 'revoke all on function private.read_stock_count_manager_summary() from public, anon';
    execute 'grant execute on function private.read_stock_count_summary() to authenticated, service_role';
    execute 'grant execute on function private.read_stock_count_manager_summary() to authenticated, service_role';
    execute 'revoke all on table public.stock_count_summary from public, anon';
    execute 'revoke all on table public.stock_count_manager_summary from public, anon';
    execute 'grant select on table public.stock_count_summary to authenticated, service_role';
    execute 'grant select on table public.stock_count_manager_summary to authenticated, service_role';
    execute $ddl$
      comment on view public.stock_count_summary is
        'Redacted active-staff verified-stock summary. No verifier identity, variance, supplier or cost fields.'
    $ddl$;
    execute $ddl$
      comment on view public.stock_count_manager_summary is
        'Manager-gated stock-count verification provenance and variance evidence.'
    $ddl$;
  else
    raise notice 'Skipping Atlas stock-count views: verified-balance source is absent';
  end if;
end
$atlas_stock_count_views$;

notify pgrst, 'reload schema';
