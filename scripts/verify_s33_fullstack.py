#!/usr/bin/env python3
"""Disposable CI Supabase recovery: real Auth, Storage bytes and all runtime gateways.
No hosted credentials, endpoint inputs or external email provider are accepted.
"""
import base64, hashlib, html, json, os, re, secrets, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
from prepare_s33_fullstack import prepare
from s33_fullstack_fixtures import exercise
from verify_s33_runtime_delta import verify as verify_delta
ROOT=Path(__file__).resolve().parents[1]
API='http://127.0.0.1:54321'
MAIL='http://127.0.0.1:54324'
NAMES=('atlas-s33-source','atlas-s33-recovery')
EXCLUDES='realtime,imgproxy,postgres-meta,studio,logflare,vector,supavisor'
BASE_FILES=['20260801000000_legacy_schema_baseline.sql','20260801105516_atlas_alpha_02_recipe_engine.sql','20260801125810_atlas_alpha_02_phase1_recipe_architecture.sql','20260801165947_atlas_vision_media_and_import_foundation.sql','20260801180202_atlas_inventory_import_audit_fields.sql','20260801222046_inventory_imported_at_default.sql','20260801224004_phase_a_01_import_queue.sql']
DELTA='20260910205055_atlas_s33_runtime_delta.sql'
CONTRACTS='20260910211903_atlas_s33_runtime_source_contracts.sql'
IMPORT='20260910201435_atlas_s33_csv_import_pipeline.sql'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
OPENER=urllib.request.build_opener(NoRedirect)
def cmd(args, data=None):
    p=subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if p.returncode:
        # Never print CLI status or Auth/Storage responses containing credentials.
        error=p.stderr.decode(errors='replace')[-3500:]
        error=re.sub(r'eyJ[A-Za-z0-9_.-]+','[redacted]',error)
        raise RuntimeError(str(args[:3])+' failed: '+error)
    return p.stdout

def cli(work,*args): return cmd(['supabase',*args,'--workdir',str(work)])
def db(name,query):
    return cmd(['docker','exec','-i','supabase_db_'+name,'psql','-X','-qAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],query.encode()).decode().strip()
def lit(v): return "'"+str(v).replace("'","''")+"'"
def request(path,method='GET',body=None,token=None,key=None,raw=None,ctype='application/json',mail=False):
    if not path.startswith('/') or path.startswith('//'): raise ValueError('Relative local path required')
    headers={'Content-Type':ctype}
    if key: headers['apikey']=key
    if token: headers['Authorization']='Bearer '+token
    data=raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req=urllib.request.Request((MAIL if mail else API)+path,data=data,headers=headers,method=method)
    try: response=OPENER.open(req,timeout=60)
    except urllib.error.HTTPError as error: response=error
    content=response.read()
    try: value=json.loads(content)
    except (ValueError,UnicodeDecodeError): value=content
    return response.status,value,dict(response.headers)
def okay(result, label):
    if not 200<=result[0]<300:
        # Only safe diagnostic fields, never response tokens/passwords.
        value=result[1]
        detail={k:value[k] for k in ('error','message','code','error_code') if isinstance(value,dict) and k in value}
        raise AssertionError(f'{label}: HTTP {result[0]} {detail}')
    return result[1]
def login(user,key): return okay(request('/auth/v1/token?grant_type=password','POST',{'email':user['email'],'password':user['password']},key=key),'login '+user['role'])
def start(work,name):
    print('Starting '+name,flush=True)
    cli(work,'start','--exclude',EXCLUDES)
    status=json.loads(cli(work,'status','-o','json'))
    assert status['API_URL']==API
    key=status.get('PUBLISHABLE_KEY') or status['ANON_KEY']
    service=status.get('SERVICE_ROLE_KEY') or status['SECRET_KEY']
    env=work/'edge.env'
    env.write_text('ATLAS_AUTH_PROJECT_URL=http://kong:8000\nATLAS_AUTH_PUBLISHABLE_KEY='+key+'\nATLAS_IMPORT_ENABLED=true\nATLAS_STOCK_COUNT_PUBLICATION_ENABLED=false\n')
    env.chmod(0o600)
    # Supabase supplies its own internal URL and service role; no hosted values.
    log=open(work/'edge.log','wb')
    process=subprocess.Popen(['supabase','functions','serve','--env-file',str(env),'--workdir',str(work)],stdout=log,stderr=log)
    time.sleep(3)
    return key,service,process

def baseline(name):
    db(name,'create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key,statements text[],name text);')
    for filename in BASE_FILES: db(name,(ROOT/'supabase/migrations'/filename).read_text())
    db(name,(ROOT/'supabase/production-adoption/sql/005_local_rls_trigger_fixture.sql').read_text())
    for filename in ('20260910094217_atlas_phase1_production_adoption.sql','20260910104621_atlas_phase1_recipe_access_and_index_cleanup.sql','20260910121248_atlas_purchase_order_lifecycle.sql'):
        db(name,(ROOT/'supabase/migrations'/filename).read_text())
    # Reconstruct the accepted ledger version/name pairs without pretending these
    # synthetic statement arrays are an exact hosted fingerprint.
    entries=[(f.split('_',1)[0],f.split('_',1)[1][:-4]) for f in BASE_FILES[1:]]
    entries += [('20260910103758','pr30_validation_baseline_and_exact_candidate'),('20260910113945','atlas_phase1_recipe_access_and_index_cleanup'),('20260910133602','atlas_purchase_order_lifecycle')]
    for version,label in entries:
        db(name,'insert into supabase_migrations.schema_migrations(version,name,statements) values ('+lit(version)+','+lit(label)+",array['synthetic CI baseline']) on conflict(version) do nothing;")
    for filename in (DELTA,CONTRACTS,IMPORT): db(name,(ROOT/'supabase/s33/migrations'/filename).read_text())
    db(name,"notify pgrst, 'reload schema';")

def fingerprint(name):
    tables=json.loads(db(name,"select coalesce(json_agg(quote_ident(n.nspname)||'.'||quote_ident(c.relname) order by n.nspname,c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','private','public_menu_private','atlas_private','supabase_migrations')"))
    return {t:hashlib.sha256(db(name,'select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),\'[]\') from '+t+' t').encode()).hexdigest() for t in tables}

def gateways(users,key,phase,report):
    names=[x['name'] for x in json.loads((ROOT/'tests/fixtures/s33-runtime-artifact.json').read_text())['functions']]
    restricted={'atlas-sprint3-review','atlas-sprint4-briefing','atlas-phase3-brain','atlas-phase3-intelligence','atlas-system'}
    matrix={}
    for user in users:
        token=login(user,key)['access_token']
        statuses={}
        for name in names:
            path='/functions/v1/'+name+('?week_start=2026-09-07' if name=='atlas-shifts' else '')
            result=request(path,token=token,key=key)
            expected=403 if user['role'] in ('inactive','unlisted') or (user['role'] in ('viewer','bartender') and name in restricted) else 200
            if result[0]!=expected: okay(result,phase+' '+user['role']+' '+name) if expected==200 else (_ for _ in ()).throw(AssertionError(phase+' '+user['role']+' '+name+' expected denial, got '+str(result[0])))
            statuses[name]=result[0]
        batch=report['fullstack_csv_publication']['batch_id']
        worker=request('/functions/v1/atlas-import-worker','POST',{'action':'source','batch_id':batch},token=token,key=key)
        expected=200 if user['role'] in ('admin','manager') else 403
        if worker[0]!=expected: okay(worker,phase+' '+user['role']+' atlas-import-worker') if expected==200 else (_ for _ in ()).throw(AssertionError(phase+' '+user['role']+' atlas-import-worker expected denial, got '+str(worker[0])))
        statuses['atlas-import-worker']=worker[0]
        matrix[user['role']]=statuses
    for name in names:
        assert request('/functions/v1/'+name,key=key)[0] in (401,403),name+' anonymous'
    assert request('/functions/v1/atlas-import-worker','POST',{'action':'source','batch_id':report['fullstack_csv_publication']['batch_id']},key=key)[0] in (401,403),'atlas-import-worker anonymous'
    report[phase+'_runtime_role_matrix']=matrix

def reset(user,key,expire=False):
    previous=okay(request('/api/v1/messages',mail=True),'mail list')
    ids={m['ID'] for m in previous.get('messages',[])}
    okay(request('/auth/v1/recover?redirect_to='+urllib.parse.quote('http://127.0.0.1:3000/recovery.html',safe=''),'POST',{'email':user['email']},key=key),'request reset')
    message=None
    for _ in range(30):
        listing=okay(request('/api/v1/messages',mail=True),'mail list')
        new=[m for m in listing.get('messages',[]) if m['ID'] not in ids]
        if new:
            message=okay(request('/api/v1/message/'+new[0]['ID'],mail=True),'captured reset email'); break
        time.sleep(1)
    assert message,'Local reset email not delivered'
    content=html.unescape(message.get('HTML','')+' '+message.get('Text',''))
    urls=re.findall(r'https?://[^\s<>"\)]+',content)
    link=next((u for u in urls if '/auth/v1/verify?' in u),None)
    assert link,'Reset email contains no verification link'
    url=urllib.parse.urlsplit(link)
    assert url.scheme+'://'+url.netloc==API,'Recovery link left local stack'
    path=url.path+'?'+url.query
    if expire:
        time.sleep(65)
        response=request(path)
        assert 'error' in response[2].get('Location','').lower(),'Expired reset accepted'
        return
    response=request(path)
    location=response[2].get('Location','')
    assert location.startswith('http://127.0.0.1:3000/recovery.html'), 'Unexpected reset redirect'
    values=urllib.parse.parse_qs(urllib.parse.urlsplit(location).fragment)
    token=values.get('access_token',[''])[0]
    assert token,'Reset did not grant recovery session'
    old=user['password']; user['password']=secrets.token_urlsafe(24)+'1aA!'
    okay(request('/auth/v1/user','PUT',{'password':user['password']},token=token,key=key),'choose reset password')
    login(user,key)
    assert request('/auth/v1/token?grant_type=password','POST',{'email':user['email'],'password':old},key=key)[0]==400,'Old password still accepted'
    repeat=request(path)
    assert 'error' in repeat[2].get('Location','').lower(),'Consumed reset link accepted'

def main():
    if os.environ.get('GITHUB_ACTIONS')!='true' or not os.environ.get('RUNNER_TEMP'):
        raise SystemExit('Dedicated disposable GitHub Actions runner required')
    if any(os.environ.get(x) for x in ('SUPABASE_ACCESS_TOKEN','SUPABASE_DB_PASSWORD','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY')):
        raise SystemExit('Hosted environment inputs are forbidden')
    temp=Path(os.environ['RUNNER_TEMP']).resolve()
    if '--cleanup' in sys.argv:
        for name in NAMES:
            work=temp/name
            if (work/'supabase/config.toml').exists(): cli(work,'stop','--no-backup')
        import shutil
        for name in (*NAMES,'atlas-s33-private-recovery'):
            shutil.rmtree(temp/name,ignore_errors=True)
        return
    evidence=temp/'atlas-s33-fullstack-evidence'; evidence.mkdir(exist_ok=False)
    private=temp/'atlas-s33-private-recovery'; private.mkdir(mode=0o700)
    report={'status':'running','scope':'Disposable local Supabase, synthetic identities and files only','cli_version':cmd(['supabase','--version']).decode().strip(),'hosted_changes':False,'operator_browser_acceptance':False}
    report['runtime_delta']=verify_delta()
    report['commit_under_test']=os.environ.get('GITHUB_SHA')
    started=time.monotonic()
    try:
        source=prepare(temp/NAMES[0],NAMES[0]); key,service,process=start(source,NAMES[0]); baseline(NAMES[0])
        report['reference_row_counts']={t:int(db(NAMES[0],'select count(*) from '+t)) for t in fingerprint(NAMES[0])}
        users=[]
        for role in ('admin','manager','bartender','viewer','inactive','unlisted'):
            user={'role':role,'email':'s33-ci-'+role+'@example.invalid','password':secrets.token_urlsafe(24)+'aA1!'}
            created=okay(request('/auth/v1/admin/users','POST',{'email':user['email'],'password':user['password'],'email_confirm':True},key=service,token=service),'create synthetic user')
            user['id']=created['id']; users.append(user)
            db(NAMES[0],"update public.profiles set role="+lit(role if role not in ('inactive','unlisted') else 'viewer')+",active="+('false' if role=='inactive' else 'true')+" where id="+lit(user['id']))
            if role=='unlisted': db(NAMES[0],'delete from public.profiles where id='+lit(user['id']))
        manager=users[1]; viewer=users[3]
        manager_session=login(manager,key); token=manager_session['access_token']
        # Real private Storage API upload/download and role denial.
        data=b'name,unit,quantity,cost_price\nS33 recovery item,bottle,2,100\n'
        object_path=manager['id']+'/s33-recovery/source.csv'
        okay(request('/storage/v1/object/atlas-imports/'+object_path,'POST',token=token,key=key,raw=data,ctype='text/csv'),'Storage upload')
        downloaded=okay(request('/storage/v1/object/atlas-imports/'+object_path,token=token,key=key),'Storage download')
        assert downloaded==data
        assert request('/storage/v1/object/atlas-imports/'+object_path,token=login(viewer,key)['access_token'],key=key)[0]>=400,'Viewer read private source'
        assert request('/storage/v1/object/atlas-imports/'+object_path,key=key)[0]>=400,'Anonymous read private source'
        report['storage_source_sha256']=hashlib.sha256(data).hexdigest()
        exercise(request,okay,db,NAMES[0],key,manager,token,object_path,data,report)
        gateways(users,key,'source',report)
        reset(viewer,key); report['source_reset_and_reuse_denial']=True
        reset(viewer,key,expire=True); report['source_expired_reset_denial']=True
        # Native recoverable set: Auth identities/password hashes, app schema/data,
        # custom Auth trigger, Storage policies/buckets and separately captured bytes.
        before=fingerprint(NAMES[0]); report['source_table_hashes']=before
        report['snapshot_row_counts']={t:int(db(NAMES[0],'select count(*) from '+t)) for t in before}
        assert db(NAMES[0], 'select count(*) from storage.objects')=='1'
        metadata_query="select json_build_object('bucket_id',bucket_id,'name',name,'owner_id',owner_id,'size',metadata->>'size','mimetype',metadata->>'mimetype') from storage.objects where bucket_id='atlas-imports' and name="+lit(object_path)
        source_metadata=json.loads(db(NAMES[0],metadata_query))
        report['source_object_metadata']=source_metadata
        app=cmd(['docker','exec','supabase_db_'+NAMES[0],'pg_dump','-U','postgres','-d','postgres','--schema=public','--schema=private','--schema=public_menu_private','--schema=atlas_private','--schema=supabase_migrations','--no-owner'])
        auth=cmd(['docker','exec','supabase_db_'+NAMES[0],'pg_dump','-U','postgres','-d','postgres','--data-only','--column-inserts','--table=auth.users','--table=auth.identities'])
        trigger=db(NAMES[0],"select pg_get_triggerdef(oid)||';' from pg_trigger where tgrelid='auth.users'::regclass and tgname='on_auth_user_created'")
        policies=json.loads(db(NAMES[0],"select coalesce(json_agg(json_build_object('name',policyname,'permissive',permissive,'roles',roles,'cmd',cmd,'qual',qual,'check',with_check)),'[]') from pg_policies where schemaname='storage' and tablename='objects'"))
        buckets=okay(request('/storage/v1/bucket',key=service,token=service),'bucket inventory')
        for filename,content in (('application.sql',app),('auth-identities.sql',auth),('source.csv',data)):
            (private/filename).write_bytes(content)
        report['recovery_file_hashes']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in private.iterdir()}
        report['recovery_set_contains_no_sessions']=True
        old_refresh=manager_session['refresh_token']
        process.terminate(); process.wait(timeout=20)
        cli(source,'stop','--no-backup')
        recovery_started=time.monotonic()
        target=prepare(temp/NAMES[1],NAMES[1]); key,service,process=start(target,NAMES[1])
        assert db(NAMES[1],'select count(*) from auth.users')=='0','Destination is not empty'
        # No trigger disabling: restore Auth before the app's profile trigger.
        db(NAMES[1],auth.decode())
        # Supabase CLI may initialize an empty migration-history schema itself.
        if db(NAMES[1],"select to_regclass('supabase_migrations.schema_migrations') is not null")=='t':
            assert db(NAMES[1],'select count(*) from supabase_migrations.schema_migrations')=='0'
            db(NAMES[1],'drop table supabase_migrations.schema_migrations')
        db(NAMES[1],app.decode().replace('CREATE SCHEMA public;','-- public schema provided by local Supabase').replace('CREATE SCHEMA supabase_migrations;','CREATE SCHEMA IF NOT EXISTS supabase_migrations;'))
        db(NAMES[1],trigger)
        for p in policies:
            quoted='"'+p['name'].replace('"','""')+'"'
            roles=','.join('"'+r.replace('"','""')+'"' for r in p['roles'])
            query='create policy '+quoted+' on storage.objects as '+p['permissive']+' for '+p['cmd']+' to '+roles
            if p['qual']: query+=' using ('+p['qual']+')'
            if p['check']: query+=' with check ('+p['check']+')'
            db(NAMES[1],query+';')
        for bucket in buckets:
            okay(request('/storage/v1/bucket','POST',{k:bucket[k] for k in ('id','name','public','file_size_limit','allowed_mime_types') if bucket.get(k) is not None},key=service,token=service),'restore bucket')
        db(NAMES[1],"notify pgrst, 'reload schema';")
        assert fingerprint(NAMES[1])==before,'Application row recovery mismatch'
        assert db(NAMES[1],'select count(*) from auth.sessions')=='0','Source sessions restored'
        assert request('/auth/v1/token?grant_type=refresh_token','POST',{'refresh_token':old_refresh},key=key)[0]==400,'Old source refresh token accepted'
        token=login(manager,key)['access_token']
        assert request('/storage/v1/object/atlas-imports/'+object_path,token=token,key=key)[0]>=400,'Storage bytes existed before API restore'
        okay(request('/storage/v1/object/atlas-imports/'+object_path,'POST',token=token,key=key,raw=(private/'source.csv').read_bytes(),ctype='text/csv'),'restore Storage bytes')
        assert okay(request('/storage/v1/object/atlas-imports/'+object_path,token=token,key=key),'restored download')==data
        assert request('/storage/v1/object/atlas-imports/'+object_path,token=login(viewer,key)['access_token'],key=key)[0]>=400,'Restored viewer read private source'
        assert request('/storage/v1/object/atlas-imports/'+object_path,key=key)[0]>=400,'Restored anonymous read private source'
        assert json.loads(db(NAMES[1],metadata_query))==source_metadata,'Restored Storage metadata differs'
        before_retry=fingerprint(NAMES[1])
        batch=report['fullstack_csv_publication']['batch_id']
        okay(request('/functions/v1/atlas-import-worker','POST',{'action':'promote','batch_id':batch},token=token,key=key),'restored CSV retry')
        assert fingerprint(NAMES[1])==before_retry,'Restored CSV retry changed application rows'
        report['restored_csv_retry_deduplicated']=True
        report['storage_bytes_and_private_access_restored']=True
        gateways(users,key,'recovery',report)
        reset(viewer,key); report['restored_password_recovery']=True
        report['application_rows_equal']=True
        report['fresh_auth_and_old_refresh_denied']=True
        report['recovery_seconds']=round(time.monotonic()-recovery_started,2)
        report['container_images']=json.loads(cmd(['docker','inspect','supabase_db_'+NAMES[1],'supabase_auth_'+NAMES[1],'supabase_storage_'+NAMES[1],'supabase_edge_runtime_'+NAMES[1],'--format','{{json .Config.Image}}']).decode().replace('\n',',').rstrip(',').join(['[',']']))
        report['status']='passed'
        process.terminate(); process.wait(timeout=20)
    except Exception as error:
        report['status']='failed'; report['error']=str(error)
        raise
    finally:
        report['elapsed_seconds']=round(time.monotonic()-started,2)
        (evidence/'acceptance.json').write_text(json.dumps(report,indent=2)+'\n')
        print('S33_REDACTED_ACCEPTANCE='+json.dumps(report,separators=(',',':')),flush=True)
if __name__=='__main__': main()
