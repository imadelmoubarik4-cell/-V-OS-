"""Build an isolated web artifact. Never edits the deployed config or calls a service."""
import argparse
import html
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = 'atialqebqxcquzdkezln'


def build(output, publishable_key):
    if not re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]+', publishable_key):
        raise ValueError('Use a staging publishable key; secret and legacy JWT keys are rejected.')
    output = Path(output).resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError('Build outside the repository so it cannot replace or enter the deployed app.')
    if output.exists():
        raise ValueError('Output must be a new directory; existing files are never overwritten.')
    shutil.copytree(ROOT / 'apps/web', output)
    source = (ROOT / 'apps/web/config.js').read_text()
    names = re.findall(r'^  ([A-Z0-9_]+_API):', source, re.M)
    cfg = {'MODE': 'isolated-rehearsal', 'SUPABASE_URL': f'https://{TARGET}.supabase.co',
           'SUPABASE_ANON_KEY': publishable_key, 'PURCHASE_ORDERS_ENABLED': True,
           **{name: '' for name in names}}
    # Deliberately omit config.js's runtime module loader. Those services do not
    # exist on the accepted Phase 1 database and must not fall back to live URLs.
    (output / 'config.js').write_text('window.VABAR_CONFIG = ' + json.dumps(cfg, indent=2) + ';\n')
    index = (output / 'index.html').read_text()
    for filename in ('brain.js', 'business.js'):
        index = index.replace(f'<script src="assets/js/{filename}"></script>', '')
    (output / 'index.html').write_text(index)
    csp = (ROOT / 'netlify.toml').read_text().split('Content-Security-Policy = "', 1)[1].split('"', 1)[0]
    for ref in ('dnefgcmjcgxlynycxkts', 'uhbamqetppqmygesoeeh'):
        csp = csp.replace(f'https://{ref}.supabase.co', f'https://{TARGET}.supabase.co')
        csp = csp.replace(f'wss://{ref}.supabase.co', f'wss://{TARGET}.supabase.co')
    # A meta policy also protects local/static previews whose server ignores
    # Netlify's _headers file. frame-ancestors is effective only as a header.
    meta_csp = re.sub(r'; frame-ancestors[^;]+', '', csp)
    for page in output.rglob('*.html'):
        markup = page.read_text()
        markup = re.sub(r'<head(\s[^>]*)?>', lambda m: m.group(0) +
                        '<meta http-equiv="Content-Security-Policy" content="' + html.escape(meta_csp, quote=True) + '">',
                        markup, count=1, flags=re.I)
        page.write_text(markup)
    (output / '_headers').write_text('/*\n  Content-Security-Policy: ' + csp + '\n  Cache-Control: no-store\n  Referrer-Policy: no-referrer\n')
    (output / 'rehearsal-manifest.json').write_text(json.dumps({
        'target': TARGET, 'mode': cfg['MODE'], 'disabled_runtime_settings': names,
        'hosted_setup_performed': False,
        'required_migration': '20260910121248_atlas_purchase_order_lifecycle.sql',
        'limitations': ['No runtime gateway deployment', 'Import queue upload is not processing/promotion',
                        'Offline reads require an already-open authenticated session; no offline login or automatic write replay']
    }, indent=2))
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--publishable-key', required=True)
    args = parser.parse_args()
    print(build(args.output, args.publishable_key))
