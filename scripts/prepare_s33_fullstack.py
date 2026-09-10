#!/usr/bin/env python3
"""Build only a named disposable CI stack; never repoint the staging artifact."""
import json, os, shutil, sys, tempfile
from pathlib import Path
from build_isolated_runtime import build, EXCLUDED
ROOT = Path(__file__).resolve().parents[1]

def prepare(destination, name):
    dest = Path(destination).resolve()
    if os.environ.get('GITHUB_ACTIONS') != 'true' or name not in ('atlas-s33-source','atlas-s33-recovery'):
        raise SystemExit('Dedicated S33 CI stacks only')
    if dest.exists() or not dest.is_relative_to(Path(os.environ['RUNNER_TEMP']).resolve()):
        raise SystemExit('New RUNNER_TEMP destination required')
    dest.mkdir()
    with tempfile.TemporaryDirectory() as temporary:
        artifact = Path(temporary)/'artifact'
        build(artifact)
        shutil.copytree(artifact, dest/'supabase')
    supa=dest/'supabase'
    shutil.copytree(ROOT/'supabase/s33/functions/atlas-import-worker',supa/'functions/atlas-import-worker')
    # Separate recovery build, fixed to the CLI's internal gateway. The reviewed
    # hosted artifact and its fail-closed target guard remain unchanged.
    for path in (supa/'functions').rglob('*'):
        if path.suffix not in ('.ts','.mjs'): continue
        text=path.read_text().replace('https://atialqebqxcquzdkezln.supabase.co','http://kong:8000')
        text=text.replace('https://atlas-s32-rehearsal.coffee-cockt-8589.chatgpt.site','http://127.0.0.1:3000')
        # These imports contain declarations only; Deno runtime APIs need no package.
        text=text.replace('import "jsr:@supabase/functions-js/edge-runtime.d.ts";','')
        # Local CLI exposes JWT anon keys; accept only its explicit anon value in
        # this generated CI build, never in the hosted candidate.
        text=text.replace('/^sb_publishable_[A-Za-z0-9_-]+$/.test','/^[A-Za-z0-9_.-]+$/.test')
        if any(ref in text for ref in EXCLUDED): raise AssertionError('Excluded project')
        path.write_text(text)
    config=f'''project_id = "{name}"
[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000
[db]
port = 54322
shadow_port = 54320
major_version = 17
[db.seed]
enabled = false
[realtime]
enabled = false
[studio]
enabled = false
[local_smtp]
enabled = true
port = 54324
[storage]
enabled = true
file_size_limit = "10MiB"
[storage.vector]
enabled = false
[auth]
enabled = true
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = ["http://127.0.0.1:3000/recovery.html"]
jwt_expiry = 120
enable_signup = false
enable_anonymous_sign_ins = false
minimum_password_length = 12
[auth.email]
enable_signup = false
enable_confirmations = true
secure_password_change = false
max_frequency = "1s"
otp_expiry = 60
[auth.rate_limit]
email_sent = 20
sign_in_sign_ups = 100
[edge_runtime]
enabled = true
policy = "per_worker"
inspector_port = 8083
[analytics]
enabled = false
'''
    config+=(supa/'config.toml').read_text()
    config+='\n[functions.atlas-import-worker]\nverify_jwt = false\n'
    (supa/'config.toml').write_text(config)
    return dest

if __name__=='__main__': prepare(sys.argv[1],sys.argv[2])
