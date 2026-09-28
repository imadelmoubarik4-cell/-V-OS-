-- S96 (edgea): staff and viewers must not receive commercial count-line
-- snapshots (unit/case cost, supplier, source file) from stock-count detail.
-- Run against a replayed database: psql -v ON_ERROR_STOP=1 -f this-file.
-- Fails (raises) before 20261010092000_s96_stock_count_detail_cost_redaction.sql.
begin;
insert into atlas_private.inventory_count_sessions(id,session_key,client_request_id,title,status,scope_type,started_by,started_by_label,submitted_by,submitted_by_label,submitted_at,verified_by,verified_by_label,verified_at)
values ('11111111-1111-4111-8111-111111111111','s96-test','s96-test','t','verified','all','22222222-2222-4222-8222-222222222222','Manager','22222222-2222-4222-8222-222222222222','Manager',now(),'22222222-2222-4222-8222-222222222222','Manager',now());
insert into atlas_private.inventory_count_lines(id,session_id,inventory_item_id,item_name,inventory_unit,expected_quantity,unit_cost_snapshot,case_cost_snapshot,supplier_snapshot,source_file_snapshot)
values ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','Gin','bottle',3,1234.5,9999,'Supplier','prices.xlsx');
set local role service_role;
do $$
declare role_name text; line jsonb;
begin
  foreach role_name in array array['bartender','viewer'] loop
    select l into line from jsonb_array_elements(public.atlas_stock_count_detail(
      '11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555',role_name)->'lines') l limit 1;
    if line ?| array['unit_cost_snapshot','case_cost_snapshot','supplier_snapshot','source_file_snapshot'] then
      raise exception 'S96: % received commercial count-line fields', role_name;
    end if;
    if line->>'item_name' <> 'Gin' then raise exception 'S96: % lost the operational line', role_name; end if;
  end loop;
  select l into line from jsonb_array_elements(public.atlas_stock_count_detail(
    '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','manager')->'lines') l limit 1;
  if (line->>'unit_cost_snapshot')::numeric is distinct from 1234.5 then raise exception 'S96: managers must keep cost snapshots'; end if;
end $$;
rollback;
