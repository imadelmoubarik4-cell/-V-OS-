#!/usr/bin/env python3
"""Builds a single self-contained preview file of the prototype for review.

Every local asset (video, final frame, logos, mascot, screenshots, icons) referenced by
index.html is embedded as a data URI, so the one file can be opened or shared for review
without the assets folder. The source index.html is not changed.

    python3 tools/build_preview.py OUTPUT.html [PAGE]      (PAGE defaults to index.html)
"""
import base64, mimetypes, pathlib, re, sys

here = pathlib.Path(__file__).resolve().parent.parent
page = sys.argv[2] if len(sys.argv) > 2 else 'index.html'
html = (here / page).read_text()
mimetypes.add_type('image/webp', '.webp')
mimetypes.add_type('image/svg+xml', '.svg')
mimetypes.add_type('image/x-icon', '.ico')
mimetypes.add_type('font/woff2', '.woff2')

def data_uri(rel):
    path = (here / page).parent / rel          # paths are relative to the page (is/ uses ../assets/)
    mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    return f'data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode()

seen = {}
def swap(match):
    rel = match.group(2)
    seen.setdefault(rel, data_uri(rel))
    return match.group(1) + seen[rel] + match.group(3)

out = re.sub(r'((?:src|href)=")((?:\.\./)?assets/[^"]+)(")', swap, html)
out = re.sub(r'(url\(")((?:\.\./)?assets/[^"]+)("\))', swap, out)
pathlib.Path(sys.argv[1]).write_text(out)
print(f'{len(seen)} assets embedded -> {sys.argv[1]} ({len(out) / 1e6:.1f} MB)')
