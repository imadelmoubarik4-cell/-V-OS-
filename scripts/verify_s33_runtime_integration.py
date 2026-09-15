#!/usr/bin/env python3
"""CI-only schema integration experiment. Never a hosted migration/deploy tool."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
if __package__:
    from .verify_s33_runtime_delta import verify as verify_delta
    from .s33_import_pipeline_checks import verify as verify_import_pipeline
else:
    from verify_s33_runtime_delta import verify as verify_delta
    from s33_import_pipeline_checks import verify as verify_import_pipeline

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'tests/fixtures/s33-runtime-sources.json'


def run(args, env, **kwargs):
    return subprocess.check_output(args, env=env, text=True, **kwargs)


def sql(query, env):
    return run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', query], env).strip()


def sql_file(path, env):
    run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', str(path)], env)


def objects(output):
    return [json.loads(line) for line in output.splitlines()
            if line.strip().startswith('{') and line.strip().endswith('}')]


def fingerprint(env):
    tables = json.loads(sql("""select coalesce(json_agg(n.nspname||'.'||c.relname
        order by n.nspname,c.relname),'[]') from pg_class c join pg_namespace n
        on n.oid=c.relnamespace where c.relkind='r' and
        n.nspname in ('public','atlas_private','auth','supabase_migrations')""", env))
    return {table: json.loads(sql('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),\'[]\') from '
            + '.'.join('"' + part.replace('"', '""') + '"' for part in table.split('.')) + ' t', env))
            for table in tables}


def source_plan():
    plan = json.loads(MANIFEST.read_text())
    for entry in plan['sql_sources']:
        path = ROOT / entry['path']
        if path.parent != ROOT / 'supabase/migrations' or path.is_symlink():
            raise RuntimeError('Unexpected SQL source path')
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
            raise RuntimeError('SQL source changed: ' + entry['path'])
    return plan


def main():
    env = dict(os.environ)
    if (env.get('GITHUB_ACTIONS') != 'true' or env.get('PGHOST') != '127.0.0.1'
            or env.get('PGDATABASE') != 'vaos_s33' or env.get('PGPORT') != '5432'
            or env.get('PGUSER') != 'postgres'
            or not re.fullmatch(r'[0-9a-f]{12,64}', env.get('POSTGRES_CONTAINER_ID', ''))
            or any(env.get(key) for key in ('PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS'))):
        raise SystemExit('Requires the dedicated disposable S33 CI PostgreSQL service')
    if not 170000 <= int(sql('show server_version_num', env)) < 180000:
        raise RuntimeError('PostgreSQL 17 required')
    plan = source_plan()
    verify_delta()
    evidence = Path(env['RUNNER_TEMP']) / 'atlas-s33-evidence'
    evidence.mkdir(exist_ok=False)
    report = {'status': 'running', 'scope': 'synthetic PostgreSQL only',
              'hosted_execution_ready': False, 'sql_source_count': len(plan['sql_sources']),
              'source_revision': plan['source_revision'], 'checks': {}}
    try:
        # Existing reconstruction and acceptance; never read a hosted backup.
        baseline_output = run(['bash', str(ROOT / 'scripts/verify_production_adoption_dry_run.sh')], env)
        report['baseline'] = objects(baseline_output)[-1]
        for filename in ('20260910104621_atlas_phase1_recipe_access_and_index_cleanup.sql',
                         '20260910121248_atlas_purchase_order_lifecycle.sql'):
            sql_file(ROOT / 'supabase/migrations' / filename, env)
        # Synthetic ledger has the accepted nine version/name pairs, not hosted row fingerprints.
        sql("""insert into supabase_migrations.schema_migrations(version,name,statements) values
            ('20260910103758','pr30_validation_baseline_and_exact_candidate',array['synthetic fixture']),
            ('20260910113945','atlas_phase1_recipe_access_and_index_cleanup',array['synthetic fixture']),
            ('20260910133602','atlas_purchase_order_lifecycle',array['synthetic fixture'])""", env)
        assert sql('select count(*) from supabase_migrations.schema_migrations', env) == '9'
        sql('create database vaos_s33_custodian template vaos_s33', env)
        custodian = dict(env, PGDATABASE='vaos_s33_custodian')
        sql("""insert into auth.users(id,email) values
            ('33000000-0000-4000-8000-000000000001','s33-ci-custodian@example.invalid');
            update public.profiles set role='admin',active=true
            where id='33000000-0000-4000-8000-000000000001'""", custodian)
        protected = fingerprint(custodian)
        guard = sql("select pg_get_functiondef('private.preserve_active_admin()'::regprocedure)", custodian)
        for target in (env, custodian):
            sql_file(ROOT / 'supabase/s33/migrations/20260910205055_atlas_s33_runtime_delta.sql', target)
            sql_file(ROOT / 'supabase/s33/migrations/20260910211903_atlas_s33_runtime_source_contracts.sql', target)
            sql_file(ROOT / 'supabase/s33/migrations/20260910201435_atlas_s33_csv_import_pipeline.sql', target)
        after = fingerprint(custodian)
        assert all(after.get(k) == v for k, v in protected.items()), 'Protected baseline rows changed'
        assert guard == sql("select pg_get_functiondef('private.preserve_active_admin()'::regprocedure)", custodian)
        sql("""do $$ begin
            begin
              update public.profiles set active=false where id='33000000-0000-4000-8000-000000000001';
              raise exception 'Last administrator was removable' using errcode='XX000';
            exception when sqlstate 'P0001' then null;
            end;
            if not exists(select 1 from public.profiles where active and role='admin') then
              raise exception 'Administrator guard did not preserve the custodian';
            end if;
        end $$""", custodian)
        report['checks']['protected_rows_and_admin_guard'] = True
        report['runtime_delta_sha256'] = hashlib.sha256((ROOT / 'supabase/s33/migrations/20260910205055_atlas_s33_runtime_delta.sql').read_bytes()).hexdigest()
        contracts = ROOT / 'supabase/s33/migrations/20260910211903_atlas_s33_runtime_source_contracts.sql'
        report['runtime_source_contracts_sha256'] = hashlib.sha256(contracts.read_bytes()).hexdigest()
        assert sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('onboarding_tasks','onboarding_progress','shifts') and c.relrowsecurity", custodian) == '3'
        assert sql("select count(*) from atlas_private.report_events", custodian) == '0'
        report['checks']['runtime_source_contracts'] = True
        for table in ('system_services','system_data_sources','system_jobs','system_release_checkpoints','system_incidents','system_events'):
            assert sql('select count(*) from atlas_private.' + table, custodian) == '0', table
        for name in ('role_matrix', 'recipe_ingredient_access', 'purchase_order'):
            filename = {'role_matrix': 'verify_phase1_role_matrix_preview.sql',
                        'recipe_ingredient_access': 'verify_recipe_ingredient_access_preview.sql',
                        'purchase_order': 'verify_purchase_order_preview.sql'}[name]
            value = objects(run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f',
                                 str(ROOT / 'scripts' / filename)], env))[-1]
            assert value.get('passed') is True, value
            report['checks'][name] = value
        security = objects(run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f',
                                str(ROOT / 'scripts/verify_phase1_security_gate.sql')], env))[-1]
        for key in ('tables_without_rls', 'unsafe_non_public_views', 'browser_function_exposure', 'security_lint_blockers'):
            assert security[key] == [], (key, security[key])
        report['checks']['security'] = security
        names = ','.join("'" + name + "'" for name in plan['rpc_names'])
        functions = json.loads(sql("""select json_agg(json_build_object('name',p.proname,
            'signature',p.oid::regprocedure::text,
            'anon',has_function_privilege('anon',p.oid,'execute'),
            'authenticated',has_function_privilege('authenticated',p.oid,'execute'),
            'service',has_function_privilege('service_role',p.oid,'execute')))
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname in (""" + names + ')', env))
        assert set(plan['rpc_names']) == {f['name'] for f in functions}, 'Missing RPC definitions'
        assert all(f['service'] and not f['anon'] and not f['authenticated'] for f in functions), functions
        report['checks']['rpc_privileges'] = functions
        sql_file(ROOT / 'tests/sql/s33_import_review.sql', custodian)
        report['checks']['private_import_review'] = True
        report['checks']['csv_import_pipeline'] = verify_import_pipeline(custodian, sql, ROOT)
        report['import_candidate_sha256'] = hashlib.sha256(
            (ROOT / 'supabase/s33/migrations/20260910201435_atlas_s33_csv_import_pipeline.sql').read_bytes()).hexdigest()
        # Native PostgreSQL restore, including synthetic private review rows and audit.
        # Does not claim managed Auth login, Storage bytes, or full Supabase restore.
        before_restore = fingerprint(custodian)
        dump = evidence / 'synthetic-database.dump'
        # Use the service image's own tools so dump/restore exactly match its major version.
        container = env['POSTGRES_CONTAINER_ID']
        dump.write_bytes(subprocess.check_output(['docker', 'exec', container,
            'pg_dump', '-U', 'postgres', '-d', 'vaos_s33_custodian', '-Fc']))
        sql('create database vaos_s33_restore', env)
        restore = dict(env, PGDATABASE='vaos_s33_restore')
        subprocess.run(['docker', 'exec', '-i', container, 'pg_restore', '--exit-on-error',
            '-U', 'postgres', '-d', 'vaos_s33_restore'], input=dump.read_bytes(), check=True)
        assert fingerprint(restore) == before_restore, 'Native restore row comparison failed'
        assert guard == sql("select pg_get_functiondef('private.preserve_active_admin()'::regprocedure)", restore)
        restored_before = fingerprint(restore)
        batch = report['checks']['csv_import_pipeline']['published_batch']
        sql("set role service_role; select public.atlas_import_command('promote','" + batch +
            "','33000000-0000-4000-8000-000000000001',null)", restore)
        assert fingerprint(restore) == restored_before, 'Restored import replay changed rows'
        report['checks']['restored_import_retry'] = True
        report['checks']['native_postgres_restore'] = True
        report['dump_sha256'] = hashlib.sha256(dump.read_bytes()).hexdigest()
        report['status'] = 'passed'
    except Exception as exc:
        report['status'] = 'failed'
        report['error'] = str(exc)
        raise
    finally:
        (evidence / 'acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'status': report['status'], 'evidence': str(evidence)}), flush=True)


if __name__ == '__main__':
    main()
