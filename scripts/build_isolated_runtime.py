#!/usr/bin/env python3
"""Reproduce the reviewed S33 sources offline; no SQL, network or deployment."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / 'tests/fixtures/s33-runtime-artifact.json'
EXCLUDED = ('dnefgcmjcgxlynycxkts', 'uhbamqetppqmygesoeeh', 'cwazoxupbwxnixpmmlhx')
GUARD = '''// S33 isolated candidate: reject configuration before handler registration.
const s33Target = "https://atialqebqxcquzdkezln.supabase.co";
if (Deno.env.get("SUPABASE_URL") !== s33Target ||
    Deno.env.get("ATLAS_AUTH_PROJECT_URL") !== s33Target ||
    !/^sb_publishable_[A-Za-z0-9_-]+$/.test(Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY") ?? "")) {
  throw new Error("S33 requires explicit isolated staging Auth and runtime configuration");
}

'''


def transform(source):
    for name in ('ATLAS_AUTH_PROJECT_URL', 'ATLAS_AUTH_PUBLISHABLE_KEY'):
        source = re.sub(r'(const AUTH_(?:PROJECT_URL|PUBLISHABLE_KEY) = Deno\.env\.get\("'
                        + name + r'"\))\s*\?\?\s*"[^"]+";', r'\1!;', source)
    source = source.replace('const productionOrigin = "https://dnefgcmjcgxlynycxkts.supabase.co";',
                            'const productionOrigin = "https://atialqebqxcquzdkezln.supabase.co";')
    if any(ref in source for ref in EXCLUDED):
        raise ValueError('Unexpected excluded project reference')
    return GUARD + source


def build(destination):
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink() or destination.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError('Use a new destination outside the repository')
    manifest = json.loads(CONTRACT.read_text())
    expected = {f['path']: f for fn in manifest['functions'] for f in fn['files']}
    if len(manifest['functions']) != 16 or len(expected) != 18:
        raise ValueError('Unexpected gateway/file scope')
    actual = set()
    for fn in manifest['functions']:
        folder = ROOT / 'supabase/functions' / fn['name']
        if folder.is_symlink():
            raise ValueError('Symlinked function directory')
        for path in folder.rglob('*'):
            if path.is_symlink():
                raise ValueError('Symlinked function input')
            if path.is_file():
                actual.add(str(path.relative_to(ROOT / 'supabase')))
    if actual != set(expected):
        raise ValueError('Unreviewed or missing runtime source files')
    with tempfile.TemporaryDirectory(prefix='atlas-s33-build-') as temporary:
        output = Path(temporary)
        for name, entry in expected.items():
            source = (ROOT / 'supabase' / name).read_bytes()
            if hashlib.sha256(source).hexdigest() != entry['source_sha256']:
                raise ValueError('Source fingerprint changed: ' + name)
            generated = transform(source.decode()).encode()
            if hashlib.sha256(generated).hexdigest() != entry['candidate_sha256']:
                raise ValueError('Candidate differs from the reviewed artifact: ' + name)
            path = output / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(generated)
        config = '\n\n'.join(f"[functions.{fn['name']}]\nverify_jwt = false\nentrypoint = \"{fn['entrypoint']}\""
                             for fn in manifest['functions']) + '\n'
        (output / 'config.toml').write_text(config)
        (output / 'runtime-manifest.json').write_bytes(CONTRACT.read_bytes())
        shutil.copytree(output, destination)
    return {'functions': 16, 'files': 18, 'deployed': False, 'output': str(destination)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    print(json.dumps(build(parser.parse_args().destination)))
