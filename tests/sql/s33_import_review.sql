-- Synthetic CI private-review journey. Upload/extraction/promotion are separate gates.
begin;
set local role service_role;
insert into atlas_private.import_batches(id,batch_key,source_files,entity_scope,status)
values ('33000000-0000-4000-8000-000000000010','s33-ci-import',array['synthetic.csv'],'inventory','review');
insert into atlas_private.import_inventory_rows(id,batch_id,row_number,source_hash,raw_data,normalized_data)
values ('33000000-0000-4000-8000-000000000011','33000000-0000-4000-8000-000000000010',1,
        repeat('3',64),'{"name":"S33 synthetic item","quantity":"2"}',
        '{"name":"S33 synthetic item","quantity":2}');
do $$ declare result jsonb; begin
  result := public.atlas_sprint3_review_decide_inventory(
    '33000000-0000-4000-8000-000000000011','approve','create',null,'CI review',
    '33000000-0000-4000-8000-000000000001','S33 CI custodian');
  if result->>'review_status' is distinct from 'approved' then
    raise exception 'Review approval failed: %',result;
  end if;
  if (select count(*) from atlas_private.review_decisions
      where row_id='33000000-0000-4000-8000-000000000011') <> 1 then
    raise exception 'Missing review audit';
  end if;
  if (select raw_data from atlas_private.import_inventory_rows
      where id='33000000-0000-4000-8000-000000000011')
      is distinct from '{"name":"S33 synthetic item","quantity":"2"}'::jsonb then
    raise exception 'Review changed source evidence';
  end if;
end $$;
reset role;
do $$ begin
  if exists(select 1 from public.inventory_items) then
    raise exception 'Review unexpectedly promoted canonical inventory';
  end if;
end $$;
commit;
