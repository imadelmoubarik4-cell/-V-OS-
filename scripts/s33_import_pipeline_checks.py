"""Synthetic import integration checks, invoked only by the guarded S33 CI runner."""
from concurrent.futures import ThreadPoolExecutor
import base64
import json
import subprocess
import threading


def verify(env, sql, root):
    checks = []
    # The committed mock bootstrap omits provider-managed Storage grants.
    # Model them only in disposable CI so these checks exercise RLS, not missing grants.
    sql('grant select,insert,update,delete on storage.objects to authenticated',env)
    actor = '33000000-0000-4000-8000-000000000001'
    prefix = '33000000-0000-4000-8000-'
    quote = lambda v: "'" + str(v).replace("'", "''") + "'"

    def command(action, batch, doc=None, who=actor):
        value = 'null' if doc is None else quote(json.dumps(doc)) + '::jsonb'
        return f"select public.atlas_import_command({quote(action)},{quote(batch)},{quote(who)},{value})"

    def call(action, batch, doc=None, who=actor):
        return json.loads(sql('set role service_role; ' + command(action,batch,doc,who),env))

    def denied(query, label):
        result=subprocess.run(['psql','-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose',
                               '-c',query],env=env,capture_output=True,text=True)
        expected = '42501' if label in {'browser_rpc_denied','anonymous_rpc_denied','inactive_actor_denied',
                                       'viewer_actor_denied','claimed_queue_immutable'} else \
                   '23505' if label=='duplicate_source_hash_denied' else 'P0001'
        assert result.returncode != 0 and expected in result.stderr, (label,result.stderr)
        checks.append(label)

    def extraction(text):
        program = "import {extractCSV} from './supabase/s33/functions/atlas-import-worker/csv.mjs';" + \
                  'console.log(JSON.stringify(await extractCSV(new TextEncoder().encode(' + json.dumps(text) + '))));'
        return json.loads(subprocess.check_output(['node','--input-type=module','-e',program],cwd=root,text=True))

    def batch(number, text):
        identity = prefix + f'{number:012d}'
        path = actor + '/' + identity + '.csv'
        sql(f"""insert into public.import_batches(id,batch_key,source_files,status,current_stage,entity_scope,
            file_extension,file_size,file_name,storage_bucket,storage_path,created_by)
            values('{identity}','s33-csv-{number}',array['synthetic.csv'],'uploaded','uploaded','inventory',
            'csv',{len(text.encode())},'synthetic.csv','atlas-imports','{path}','{actor}');
            insert into storage.objects(bucket_id,name,owner) values('atlas-imports','{path}','{actor}');""",env)
        return identity,path

    def approve(identity):
        sql(f"""set role service_role;
          select public.atlas_sprint3_review_decide_inventory(r.id,'approve','create',null,'Synthetic CI',
            '{actor}','CI custodian') from atlas_private.import_inventory_rows r
            join atlas_private.import_jobs j on j.review_batch_id=r.batch_id where j.batch_id='{identity}'""",env)

    def counts():
        return json.loads(sql("select jsonb_build_array((select count(*) from public.inventory_items),"
                             "(select count(*) from public.inventory_movements))",env))

    csv = 'name,unit,quantity,cost_price,sku\nS33 CSV Alpha,pcs,2,100,S33-CSV-A\nS33 CSV Beta,pcs,3,,S33-CSV-B\n'
    first,path = batch(101,csv)
    doc=extraction(csv)
    manager=f"set role authenticated; select set_config('request.jwt.claim.sub','{actor}',false); select set_config('request.jwt.claim.role','authenticated',false);"
    sql(manager+f"""do $$ declare touched integer; begin
      update storage.objects set name=name where bucket_id='atlas-imports' and name='{path}';
      get diagnostics touched=row_count;
      if touched<>1 then raise exception 'Positive control: manager cannot update an unclaimed source'; end if;
    end $$""",env)
    checks.append('unclaimed_source_positive_control')
    viewer=prefix+'000000000002'
    sql(f"insert into auth.users(id,email) values('{viewer}','s33-ci-inactive@example.invalid')",env)
    denied('set role authenticated; '+command('claim',first),'browser_rpc_denied')
    denied('set role anon; '+command('claim',first),'anonymous_rpc_denied')
    denied('set role service_role; '+command('claim',first,who=viewer),'inactive_actor_denied')
    sql(f"update public.profiles set active=true where id='{viewer}'",env)
    denied('set role service_role; '+command('claim',first,who=viewer),'viewer_actor_denied')
    assert call('claim',first)['status']=='claimed'
    denied(manager+f"update public.import_batches set file_name='changed.csv' where id='{first}'",'claimed_queue_immutable')
    sql(manager+f"""do $$ declare touched integer; begin
      delete from storage.objects where bucket_id='atlas-imports' and name='{path}';
      get diagnostics touched=row_count;
      if touched<>0 then raise exception 'Claimed source file was deletable'; end if;
      update storage.objects set name=name||'.changed' where bucket_id='atlas-imports' and name='{path}';
      get diagnostics touched=row_count;
      if touched<>0 then raise exception 'Claimed source file was mutable'; end if;
    end $$""",env)
    checks.append('claimed_storage_delete_update_denied')
    denied('set role service_role; '+command('stage',first,dict(doc,source_base64=base64.b64encode(b'changed').decode())),
           'source_hash_mismatch_denied')
    one=call('stage',first,doc); two=call('stage',first,doc)
    captured=call('source',first)
    assert base64.b64decode(captured['source_base64'])==csv.encode() and captured['source_hash']==doc['source_hash']
    checks.append('captured_source_bytes_and_hash_match')
    assert one['review_batch_id']==two['review_batch_id'] and counts()==[0,0]
    assert sql(f"select count(*) from atlas_private.import_inventory_rows where batch_id='{one['review_batch_id']}'",env)=='2'
    checks.append('extraction_retry_deduplicates_and_does_not_promote')
    denied('set role service_role; '+command('promote',first),'unreviewed_promotion_denied')
    denied(f"set role service_role; update atlas_private.import_inventory_rows set raw_data='{{}}' where batch_id='{one['review_batch_id']}'",'source_evidence_immutable')
    approve(first)
    barrier=threading.Barrier(2)
    def publish(_):
        barrier.wait()
        return sql('begin; set local role service_role; '+command('promote',first)+'; select pg_sleep(0.2); commit;',env)
    with ThreadPoolExecutor(max_workers=2) as executor:
        outputs=list(executor.map(publish,range(2)))
    results=[json.loads(next(line for line in output.splitlines() if line.startswith('{'))) for output in outputs]
    assert results[0]==results[1] and len(results[0]['created_item_ids'])==2 and counts()==[2,2]
    checks.append('concurrent_publication_creates_items_and_movements_once')
    assert call('promote',first)==results[0] and counts()==[2,2]
    assert json.loads(sql("select jsonb_agg(jsonb_build_array(quantity,cost_price) order by name) from public.inventory_items",env))==[[2,100],[3,None]]
    assert sql(f"select count(*) from public.inventory_movements where created_by='{actor}'",env)=='2'
    assert sql("select count(*) from atlas_private.import_inventory_rows where review_status='imported' and matched_item_id is not null",env)=='2'
    checks.append('retry_decimal_null_cost_and_actor_audit')
    denied('set role service_role; '+command('discard',first),'published_discard_denied')
    denied(f"set role service_role; update atlas_private.import_inventory_rows set review_status='pending' where batch_id='{one['review_batch_id']}'",'published_review_immutable')
    duplicate,dup_path=batch(102,csv)
    call('claim',duplicate)
    denied('set role service_role; '+command('stage',duplicate,doc),'duplicate_source_hash_denied')
    assert call('discard',duplicate)['status']=='discarded'
    assert sql(f"select count(*) from atlas_private.import_jobs where batch_id='{duplicate}'",env)=='0'
    sql(manager+f"delete from storage.objects where bucket_id='atlas-imports' and name='{dup_path}'",env)
    assert sql(f"select count(*) from storage.objects where name='{dup_path}'",env)=='0'
    checks.append('unpublished_discard_releases_source')
    bad='name,unit,quantity,cost_price,sku\nS33 CSV Gamma,pcs,4,50,S33-CSV-C\nS33 CSV Alpha,pcs,7,20,S33-CSV-Z\n'
    failed,_=batch(103,bad)
    call('claim',failed); call('stage',failed,extraction(bad)); approve(failed)
    before=counts()
    denied('set role service_role; '+command('promote',failed),'later_row_conflict_rolls_back_entire_publication')
    assert counts()==before
    assert sql("select count(*) from public.inventory_items where name='S33 CSV Gamma'",env)=='0'
    assert sql(f"select status from atlas_private.import_jobs where batch_id='{failed}'",env)=='staged'
    assert call('discard',failed)['status']=='discarded'
    return {'passed':True,'passed_count':len(checks),'checks':checks,'published_batch':first,
            'created_items':2,'stock_movements':2,'scope':'synthetic SQL plus real CSV parser; no hosted Storage/Auth'}
