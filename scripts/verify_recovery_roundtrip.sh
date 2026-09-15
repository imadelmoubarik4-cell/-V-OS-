#!/usr/bin/env bash
# Synthetic data only, inside the PostgreSQL service owned by this CI job.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${PGHOST:-}" == 127.0.0.1 && "${PGDATABASE:-}" == vaos_adoption ]]
[[ "${POSTGRES_CONTAINER_ID:-}" =~ ^[a-f0-9]{12,64}$ ]]
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
# The source test guards an empty database. The committed variant is used only
# as a synthetic restore fixture and never sent to a hosted Supabase project.
python - "$work_dir/fixture.sql" <<'PY'
import pathlib,sys
source=pathlib.Path('scripts/verify_purchase_order_preview.sql').read_text()
assert source.endswith('rollback;\n')
source=source[:-len('rollback;\n')]+'commit;\n'
source=source.replace("'rolled_back',true", "'rolled_back',false")
pathlib.Path(sys.argv[1]).write_text(source)
PY
psql -X -q -v ON_ERROR_STOP=1 -f "$work_dir/fixture.sql" > "$work_dir/fixture.log"
cat > "$work_dir/fingerprint.sql" <<'SQL'
select jsonb_object_agg(name, rows) from (
 select 'orders' as name,jsonb_agg(to_jsonb(t) order by id) as rows from public.purchase_orders t
 union all select 'items',jsonb_agg(to_jsonb(t) order by id) from public.inventory_items t
 union all select 'movements',jsonb_agg(to_jsonb(t) order by id) from public.inventory_movements t
 union all select 'profiles',jsonb_agg(to_jsonb(t) order by id) from public.profiles t
 union all select 'users',jsonb_agg(to_jsonb(t) order by id) from auth.users t
 union all select 'suppliers',jsonb_agg(to_jsonb(t) order by id) from public.suppliers t
 union all select 'categories',jsonb_agg(to_jsonb(t) order by id) from public.recipe_categories t
 union all select 'ledger',jsonb_agg(to_jsonb(t) order by version) from supabase_migrations.schema_migrations t
) snapshot;
SQL
psql -X -qAt -v ON_ERROR_STOP=1 -f "$work_dir/fingerprint.sql" > "$work_dir/before.json"
docker exec "$POSTGRES_CONTAINER_ID" pg_dump -U postgres -Fc vaos_adoption > "$work_dir/synthetic.dump"
docker exec "$POSTGRES_CONTAINER_ID" createdb -U postgres vaos_recovery_drill
docker exec -i "$POSTGRES_CONTAINER_ID" pg_restore -U postgres --clean --if-exists --exit-on-error -d vaos_recovery_drill < "$work_dir/synthetic.dump"
PGDATABASE=vaos_recovery_drill psql -X -qAt -v ON_ERROR_STOP=1 -f "$work_dir/fingerprint.sql" > "$work_dir/after.json"
cmp "$work_dir/before.json" "$work_dir/after.json"
PGDATABASE=vaos_recovery_drill psql -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-7000-000000000002',true);
do $$ begin
 if exists(select 1 from public.purchase_orders) then raise exception 'Restored RLS exposed orders to staff'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-7000-000000000001',true);
select public.atlas_purchase_order_command('00000000-0000-4000-7000-000000000301','receive',3);
do $$ begin
 if (select count(*) from public.purchase_orders) <> 2
 or (select quantity from public.inventory_items where id='00000000-0000-4000-7000-000000000201') <> 8
 or (select count(*) from public.inventory_movements) <> 1 then raise exception 'Restored order acceptance failed'; end if;
end $$;
rollback;
SQL
echo '{"synthetic_restore":"passed","full_row_fingerprints":"equal","restored_rls":"passed","receipt_idempotence":"passed","production_backup_tested":false}'
