#!/usr/bin/env bash
# S96 concurrency acceptance (N4 race conditions / N5 idempotency) against a DISPOSABLE
# replayed database. Unlike the rolled-back previews, concurrent sessions need committed
# fixtures: the script seeds rows with fixed S96 ids, runs pairs of overlapping sessions,
# prints a JSON verdict and deletes its fixtures. Loopback databases only.
#
#   DBRLS-06  two administrators deactivating each other at the same time must leave one
#             active administrator (fails before 20261010090300_s96_last_admin_race.sql);
#   control   two concurrent approvals of one purchase order record one approval;
#   control   two concurrent waste movements of the last unit never drive stock negative;
#   control   the same adjust_inventory_v2 request id sent twice at once posts one movement.
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=vaos_replay}"
export PGHOST PGUSER PGDATABASE
case "$PGHOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing non-loopback PGHOST: $PGHOST" >&2; exit 1 ;; esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
q() { psql -X -v ON_ERROR_STOP=1 -qAt "$@" 2> >(grep -v "does not exist, skipping" >&2); }

A1=00000000-0000-4000-8000-0000000a9701; A2=00000000-0000-4000-8000-0000000a9702
M1=00000000-0000-4000-8000-0000000a9703; M2=00000000-0000-4000-8000-0000000a9704
SUP=00000000-0000-4000-8000-0000000a9711; ITEM=00000000-0000-4000-8000-0000000a9712
PO=00000000-0000-4000-8000-0000000a9713

cleanup() {
  q <<SQL >/dev/null
-- S96: purchase_order_events and inventory_movements are append-only (20261010096000).
-- This disposable-fixture teardown runs as postgres, so it uses the migration's own
-- break-glass escape hatch (private.audit_append_only honours atlas.audit_break_glass
-- for postgres/supabase_admin) to remove its committed fixtures. The append-only
-- protection itself is exercised by tests/sql/s96_audit_append_only_test.sql.
set atlas.audit_break_glass = 'on';
delete from public.purchase_order_events where order_id = '$PO';
delete from public.purchase_orders where id = '$PO';
delete from atlas_private.stock_adjustment_requests where item_id = '$ITEM';
delete from public.inventory_movements where item_id = '$ITEM';
delete from public.inventory_items where id = '$ITEM';
delete from public.suppliers where id = '$SUP';
alter table public.profiles disable trigger profiles_preserve_active_admin;
delete from public.profiles where id in ('$A1','$A2','$M1','$M2');
alter table public.profiles enable trigger profiles_preserve_active_admin;
delete from auth.users where id in ('$A1','$A2','$M1','$M2');
update atlas_private.settings_sections
  set settings_value = settings_value - 'purchase_approval_required' - 'purchase_approval_threshold_isk'
  where section_key = 'inventory';
drop role if exists s96_race_probe;
SQL
}
cleanup
trap 'cleanup; rm -rf "$WORK"' EXIT

q <<SQL >/dev/null
create role s96_race_probe nologin;
grant authenticated to s96_race_probe;
insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), u::uuid, 'authenticated','authenticated', 's96-race-'||right(u,4)||'@example.invalid', '', now(), '{}', '{}', now(), now()
from unnest(array['$A1','$A2','$M1','$M2']) u;
update public.profiles set role='admin', active=true where id in ('$A1','$A2');
update public.profiles set role='manager', active=true where id in ('$M1','$M2');
insert into public.suppliers (id, name) values ('$SUP', 'S96 race supplier');
insert into public.inventory_items (id, name, quantity, unit, active, supplier_id) values ('$ITEM', 'S96 race gin', 1, 'bottle', true, '$SUP');
insert into atlas_private.settings_sections (section_key, label, settings_value)
values ('inventory', 'Inventory', '{"purchase_approval_required":true,"purchase_approval_threshold_isk":1000}')
on conflict (section_key) do update set settings_value = atlas_private.settings_sections.settings_value || excluded.settings_value;
SQL

as_user() { # $1 user id, rest: SQL
  local who="$1"; shift
  printf "set session authorization s96_race_probe; set role authenticated;\nselect set_config('request.jwt.claim.sub','%s',false), set_config('request.jwt.claims','{\"sub\":\"%s\",\"role\":\"authenticated\"}',false);\n%s\n" "$who" "$who" "$*" \
    | psql -X -qAt 2>&1 | grep -v '^[0-9a-f-]*|{' || true
}

# DBRLS-06: A1 deactivates A2 and holds its transaction; A2 deactivates A1 meanwhile.
as_user "$A1" "begin; update public.profiles set active=false where id='$A2'; select pg_sleep(2); commit;" > "$WORK/a.txt" &
sleep 0.5
as_user "$A2" "begin; update public.profiles set active=false where id='$A1'; commit;" > "$WORK/b.txt" || true
wait
admins="$(q -c "select count(*) from public.profiles where id in ('$A1','$A2') and role='admin' and active")"

# Purchase order: create and submit, then two concurrent approvals by M2.
as_user "$M1" "select (public.atlas_purchase_order_command_v2('$PO','create',null,'$SUP','[{\"item_id\":\"$ITEM\",\"quantity\":10,\"unit_cost\":500}]'::jsonb,'',null,null,null,null)).status;
select (public.atlas_purchase_order_command_v2('$PO','submit',1,null,null,null,null,null,null,null)).status;" > /dev/null
for i in 1 2; do
  as_user "$M2" "begin; select (public.atlas_purchase_order_command_v2('$PO','approve',2,null,null,null,null,null,null,null)).status; select pg_sleep(1); commit;" > "$WORK/appr$i.txt" &
done
wait
approvals="$(q -c "select count(*) from public.purchase_order_events where order_id='$PO' and event_type='approved'")"

# Two concurrent waste movements of the last unit.
for i in 1 2; do
  as_user "$M1" "begin; select (public.adjust_inventory_v2('s96-race-waste-$i','$ITEM',-1,'waste')).id; select pg_sleep(1); commit;" > "$WORK/w$i.txt" &
done
wait
quantity="$(q -c "select quantity from public.inventory_items where id='$ITEM'")"

# The same request id twice at once.
for i in 1 2; do
  as_user "$M1" "begin; select (public.adjust_inventory_v2('s96-race-same-1','$ITEM',5,'restock')).id; select pg_sleep(1); commit;" > "$WORK/s$i.txt" &
done
wait
same_rows="$(q -c "select count(*) from atlas_private.stock_adjustment_requests where request_id='s96-race-same-1'")"
quantity_after="$(q -c "select quantity from public.inventory_items where id='$ITEM'")"

ok() { if [ "$1" = "$2" ]; then echo ok; else echo FAIL; fi; }
r1="$(ok "$admins" 1)"; r2="$(ok "$approvals" 1)"; r3="$(ok "$quantity" 0)"; r4="$(ok "$same_rows|$quantity_after" "1|5")"
verdict=passed
for r in "$r1" "$r2" "$r3" "$r4"; do [ "$r" = ok ] || verdict=failed; done
printf '{"tests": [{"test": "DBRLS-06: concurrent mutual admin deactivation leaves one active administrator", "result": "%s", "active_admins": %s}, {"test": "concurrent approvals record one approval", "result": "%s", "approvals": %s}, {"test": "concurrent waste never drives stock negative", "result": "%s", "quantity": %s}, {"test": "one request id sent twice at once posts one movement", "result": "%s", "requests": %s, "quantity": %s}], "s96_races": "%s"}\n' \
  "$r1" "$admins" "$r2" "$approvals" "$r3" "$quantity" "$r4" "$same_rows" "$quantity_after" "$verdict"
[ "$verdict" = passed ]
