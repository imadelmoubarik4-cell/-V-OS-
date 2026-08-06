\set ON_ERROR_STOP on

begin;
create temporary table phase2_results(
  test_name text primary key,
  passed boolean not null,
  detail text not null
) on commit drop;

do $acceptance$
declare
  actor_id constant uuid := '10000000-0000-4000-8000-000000000001';
  source_snapshot jsonb;
  pos_snapshot jsonb;
  check_row jsonb;
  check_id uuid;
  selected_product_id uuid;
  selected_target_id uuid;
  selected_event_id uuid;
  denied boolean;
  exact_score numeric;
begin
  insert into atlas_private.import_batches(
    id,batch_key,entity_scope,file_name,file_extension,status,current_stage,
    progress_percent,source_hash,record_counts
  ) values (
    '11000000-0000-4000-8000-000000000001','p22-contract-source','recipe',
    'P2.2 Contract Source.pdf','pdf','prepared','review',100,
    repeat('a',64),'{"rows":1}'::jsonb
  );

  source_snapshot:=public.atlas_read_sources_snapshot(actor_id,'admin',20);
  insert into phase2_results values(
    'p22_admin_snapshot',
    source_snapshot->>'version'='atlas-read-sources/0.1.0'
      and (source_snapshot->'summary'->>'private_source_batches')::integer>=1,
    'Admin received a metadata-only source snapshot.'
  );
  insert into phase2_results values(
    'p22_source_body_excluded',
    source_snapshot->'trust'->>'source_bodies_returned'='false'
      and source_snapshot->'trust'->>'private_urls_returned'='false'
      and source_snapshot->'trust'->>'credentials_returned'='false'
      and source_snapshot::text !~* 'raw_data|normalized_data|storage_path',
    'No source body, storage path or credential was returned.'
  );
  denied:=false;
  begin
    perform public.atlas_read_sources_snapshot(actor_id,'bartender',20);
  exception when others then denied:=true;
  end;
  insert into phase2_results values(
    'p22_bartender_denied',denied,
    'Bartender source access was denied.'
  );
  insert into phase2_results
  select 'p22_private_rls',
         count(*)=2 and bool_and(c.relrowsecurity)
           and bool_and(not has_table_privilege('anon',format('atlas_private.%I',c.relname),'select'))
           and bool_and(not has_table_privilege('authenticated',format('atlas_private.%I',c.relname),'select')),
         'Source attribution and source events remain private.'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='atlas_private'
    and c.relname in ('knowledge_sources','read_source_events');
  insert into phase2_results values(
    'p22_service_role_rpc_only',
    not has_function_privilege('anon','public.atlas_read_sources_snapshot(uuid,text,integer)','execute')
      and not has_function_privilege('authenticated','public.atlas_read_sources_snapshot(uuid,text,integer)','execute')
      and has_function_privilege('service_role','public.atlas_read_sources_snapshot(uuid,text,integer)','execute'),
    'The read-source RPC is service-role-only.'
  );

  select atlas_private.pos_candidate_score(
    'VÁ Espresso-Martini','VA Espresso Martini'
  ) into exact_score;
  insert into phase2_results values(
    'checkpoint_m_normalization',exact_score=1,
    'Icelandic accents and punctuation normalize deterministically.'
  );

  check_row:=public.atlas_connections_begin_check(
    'dineout',gen_random_uuid(),'synthetic','system',
    actor_id,'Phase 2 acceptance','admin'
  );
  check_id:=(check_row->>'id')::uuid;
  perform public.atlas_connections_finish_check(
    check_id,'healthy','passed',1,null,'Checkpoint M contract fixture.',
    '{"fixture":true,"external_side_effects":false}'::jsonb,
    actor_id,'Phase 2 acceptance','admin'
  );

  perform public.atlas_pos_mapping_refresh_targets(
    jsonb_build_array(
      jsonb_build_object(
        'production_recipe_id','12000000-0000-4000-8000-000000000001',
        'name','Espresso Martini','product_type','cocktail',
        'menu_price',2500,'show_on_menu',true,'active',true
      ),
      jsonb_build_object(
        'production_recipe_id','12000000-0000-4000-8000-000000000002',
        'name','Aperol Spritz','product_type','cocktail',
        'menu_price',2400,'show_on_menu',true,'active',true
      )
    ),
    actor_id,'Phase 2 acceptance','admin'
  );
  perform public.atlas_pos_mapping_stage_products(
    'p23-contract-run','dineout',
    jsonb_build_array(
      jsonb_build_object(
        'external_product_id','pos-espresso','external_sku','1001',
        'name','Espresso Martini','category','Cocktails','active',true
      ),
      jsonb_build_object(
        'external_product_id','pos-aperol','external_sku','1002',
        'name','Aperol Spritz','category','Cocktails','active',true
      )
    ),
    actor_id,'Phase 2 acceptance','admin'
  );

  select product.id,candidate.target_id
  into selected_product_id,selected_target_id
  from atlas_private.pos_products product
  join atlas_private.pos_product_candidates candidate
    on candidate.product_id=product.id
  where product.external_product_id='pos-espresso'
  order by candidate.candidate_rank
  limit 1;

  insert into phase2_results
  select 'checkpoint_m_candidates_pending',
         count(*)=2 and bool_and(mapping.status='pending')
           and (select count(*) from atlas_private.pos_product_candidates)>=2,
         'Candidates were generated without automatic approval.'
  from atlas_private.pos_product_mappings mapping;

  perform public.atlas_pos_mapping_decide(
    selected_product_id,selected_target_id,'approve','Verified fixture',
    actor_id,'Phase 2 acceptance','manager'
  );
  insert into phase2_results
  select 'checkpoint_m_manager_approval',
         mapping.status='approved'
           and mapping.target_id=selected_target_id
           and mapping.decided_at is not null,
         'Manager approval created an explicit mapping.'
  from atlas_private.pos_product_mappings mapping
  where mapping.product_id=selected_product_id;

  denied:=false;
  begin
    perform public.atlas_pos_mapping_decide(
      selected_product_id,selected_target_id,'approve','Not allowed',
      actor_id,'Phase 2 acceptance','bartender'
    );
  exception when others then denied:=true;
  end;
  insert into phase2_results values(
    'checkpoint_m_bartender_denied',denied,
    'Bartender mapping approval was denied.'
  );

  pos_snapshot:=public.atlas_pos_mapping_snapshot(actor_id,'admin',100);
  insert into phase2_results values(
    'checkpoint_m_sales_gate',
    pos_snapshot->'policy'->>'sales_ingestion_enabled'='false'
      and pos_snapshot->'policy'->>'brain_sales_evidence_enabled'='false'
      and pos_snapshot->'policy'->>'automatic_mapping_approval'='false'
      and pos_snapshot->'policy'->>'automatic_ordering_enabled'='false'
      and pos_snapshot->'summary'->>'ready_for_sales_ingestion'='false',
    'Mappings do not enable sales, Brain evidence or ordering.'
  );

  denied:=false;
  begin
    perform public.atlas_pos_mapping_snapshot(actor_id,'viewer',20);
  exception when others then denied:=true;
  end;
  insert into phase2_results values(
    'checkpoint_m_viewer_denied',denied,
    'Viewer Checkpoint M access was denied.'
  );

  insert into phase2_results
  select 'checkpoint_m_private_rls',
         count(*)=7 and bool_and(c.relrowsecurity)
           and bool_and(not has_table_privilege('anon',format('atlas_private.%I',c.relname),'select'))
           and bool_and(not has_table_privilege('authenticated',format('atlas_private.%I',c.relname),'select')),
         'All Checkpoint M tables have RLS and no browser read grant.'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='atlas_private'
    and c.relname in (
      'pos_mapping_settings','pos_mapping_targets','pos_import_runs','pos_products',
      'pos_product_candidates','pos_product_mappings','pos_mapping_events'
    );

  insert into phase2_results values(
    'checkpoint_m_service_role_rpc_only',
    not has_function_privilege('anon','public.atlas_pos_mapping_snapshot(uuid,text,integer)','execute')
      and not has_function_privilege('authenticated','public.atlas_pos_mapping_snapshot(uuid,text,integer)','execute')
      and has_function_privilege('service_role','public.atlas_pos_mapping_snapshot(uuid,text,integer)','execute')
      and not has_function_privilege('authenticated','public.atlas_pos_mapping_decide(uuid,uuid,text,text,uuid,text,text)','execute'),
    'Checkpoint M RPCs are service-role-only.'
  );

  select id into selected_event_id
  from atlas_private.pos_mapping_events order by created_at limit 1;
  denied:=false;
  begin
    update atlas_private.pos_mapping_events
    set payload=payload||'{"tampered":true}'::jsonb
    where id=selected_event_id;
  exception when others then denied:=true;
  end;
  insert into phase2_results values(
    'checkpoint_m_events_append_only',denied,
    'Mapping event mutation was denied.'
  );
end
$acceptance$;

select jsonb_build_object(
  'passed',bool_and(passed),
  'passed_count',count(*) filter(where passed),
  'failed_count',count(*) filter(where not passed),
  'rolled_back',true,
  'tests',jsonb_agg(jsonb_build_object(
    'test',test_name,'passed',passed,'detail',detail
  ) order by test_name)
)
from phase2_results;

rollback;
