"""Bounded synthetic API writes whose data must survive the S33 recovery drill."""
import json, uuid

def exercise(request, okay, db, database, key, manager, token, object_path, csv, report):
    def post(gateway,action,payload):
        return okay(request('/functions/v1/'+gateway+'?action='+action,'POST',payload,token=token,key=key),gateway+' '+action)
    batch=str(uuid.uuid4())
    payload={'id':batch,'batch_key':'s33-ci-recovery-csv','source_files':['source.csv'],
             'status':'uploaded','current_stage':'uploaded','entity_scope':'inventory',
             'file_extension':'csv','file_name':'source.csv','file_size':len(csv),
             'storage_bucket':'atlas-imports','storage_path':object_path,'created_by':manager['id']}
    okay(request('/rest/v1/import_batches','POST',payload,token=token,key=key),'create public import batch')
    staged=post('atlas-import-worker','stage',{'action':'stage','batch_id':batch})
    rows=json.loads(db(database,"select json_agg(id) from atlas_private.import_inventory_rows where batch_id='"+staged['review_batch_id']+"'"))
    assert len(rows)==1
    assert request('/functions/v1/atlas-import-worker','POST',{'action':'promote','batch_id':batch},token=token,key=key)[0]>=400,'Unreviewed import promoted'
    for row in rows:
        post('atlas-sprint3-review','decision',{'row_kind':'inventory','row_id':row,'decision':'approve','action':'create','notes':'Synthetic recovery fixture'})
    result=post('atlas-import-worker','promote',{'action':'promote','batch_id':batch})
    assert post('atlas-import-worker','promote',{'action':'promote','batch_id':batch})==result
    assert len(result['created_item_ids'])==1
    assert db(database,'select count(*) from public.inventory_movements')=='1'
    source=post('atlas-import-worker','source',{'action':'source','batch_id':batch})
    import base64
    assert base64.b64decode(source['source_base64'])==csv
    report['fullstack_csv_publication']={'batch_id':batch,'item_ids':result['created_item_ids'],'reviewed_rows':1,'retry_deduplicated':True,'source_bytes_match':True}
    # Each creates synthetic in-app records only; no social publication or mail.
    message=post('atlas-team-messages','send',{'channel_key':'general','body':'S33 synthetic recovery message','link_type':'none','client_request_id':str(uuid.uuid4())})
    shift_targets=okay(request('/functions/v1/atlas-team-messages?action=targets&type=shift',token=token,key=key),'team message shift targets')
    assert shift_targets['type']=='shift'
    post('atlas-marketing-workspace','create-campaign',{'name':'S33 synthetic recovery campaign','campaign_type':'always_on','platforms':[]})
    count=db(database,'select count(*) from atlas_private.shift_people')
    bad=request('/functions/v1/atlas-shifts?action=create-person','POST',{'display_name':'S33 invalid calendar fixture'},token=token,key=key)
    assert bad[0]==400 and db(database,'select count(*) from atlas_private.shift_people')==count,'Invalid calendar request committed a person'
    post('atlas-shifts','create-person',{'display_name':'S33 synthetic schedule person','default_role':'bartender','current_week':'2026-09-07'})
    report['shifts_invalid_context_has_no_write']=True
    task=str(uuid.uuid4())
    db(database,"insert into public.onboarding_tasks(id,title,description,category,sort_order,required,active) values ('"+task+"','S33 synthetic onboarding task','Recovery fixture','recovery',1,true,true)")
    post('atlas-team-profiles','update-onboarding',{'profile_id':manager['id'],'task_id':task,'completed':True,'note':'Synthetic recovery fixture'})
    assert db(database,"select count(*) from public.onboarding_progress where task_id='"+task+"' and user_id='"+manager['id']+"'")=='1'
    category=db(database,'select id from atlas_private.knowledge_categories order by category_key limit 1')
    post('atlas-knowledge','save-draft',{'article_key':'s33-recovery-synthetic','category_id':category,'article_type':'reference','title':'S33 recovery reference','content':'Synthetic restoration evidence only.','target_roles':['all'],'task_ids':[task]})
    report['runtime_write_fixtures']=['reviewed_csv_inventory_and_stock_movement','team_message_and_shift_targets','marketing_campaign','schedule_person','onboarding_progress','knowledge_draft']
