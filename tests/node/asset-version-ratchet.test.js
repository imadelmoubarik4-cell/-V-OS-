// Cache-key ratchet (platform audit review of L27). The service worker serves
// every ?v= URL cache-first with no revalidation, so a copy an installed app
// has cached is final until its key changes. A file whose bytes change while
// every reference keeps the same ?v= key would never reach installed apps.
//
// tests/fixtures/asset-versions/asset-versions.json records, for each keyed
// file, its keys and its sha256. This test fails when a file's content
// changed but none of its keys did ("bump the key"), and when the record is
// out of date ("refresh the record"). After bumping keys, refresh it with:
//
//   ATLAS_UPDATE_ASSET_VERSIONS=1 node --test tests/node/asset-version-ratchet.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WEB = 'apps/web';
const RECORD = 'tests/fixtures/asset-versions/asset-versions.json';
const REFERENCE = /(?:\.{1,2}\/|[A-Za-z0-9_-])[A-Za-z0-9_./-]*\.[A-Za-z0-9]+\?v=([A-Za-z0-9_.-]+)/g;
// The minified mascot scene builds its own URLs at run time; atlas-bot.js
// carries the same key (tests/node/atlas-bot.test.js keeps them as one).
const SKIP_SOURCES = new Set([`${WEB}/assets/atlas-bot/atlas-mascot-scene.js`]);

function sources(dir = WEB) {
  return readdirSync(dir).flatMap((name) => {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(html|js|css)$/.test(name) && !SKIP_SOURCES.has(full) ? [full] : [];
  });
}

// Every keyed reference, resolved to a file under apps/web: stylesheets
// resolve against their own folder, everything else against the document.
function currentVersions() {
  const files = new Map();
  for (const source of sources()) {
    const text = readFileSync(source, 'utf8');
    const base = source.endsWith('.css') ? path.posix.dirname(source) : WEB;
    for (const match of text.matchAll(REFERENCE)) {
      const [reference, key] = match;
      const target = path.posix.normalize(path.posix.join(base, reference.split('?')[0]));
      if (!target.startsWith(`${WEB}/`) || !existsSync(target) || !statSync(target).isFile()) continue;
      const entry = files.get(target) || { keys: new Set(), referencedFrom: new Set() };
      entry.keys.add(key);
      entry.referencedFrom.add(source);
      files.set(target, entry);
    }
  }
  return Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, entry]) => [file, {
    keys: [...entry.keys].sort(),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
  }]));
}

// { unbumped, stale } between the files now and the record.
function compare(current, recorded) {
  const stale = [];
  const unbumped = [];
  for (const [file, entry] of Object.entries(current)) {
    const before = recorded[file];
    if (!before) { stale.push(`${file} (new)`); continue; }
    const sameKeys = JSON.stringify(before.keys) === JSON.stringify(entry.keys);
    if (before.sha256 !== entry.sha256 && sameKeys) unbumped.push(`${file} ?v=${entry.keys.join(', ?v=')}`);
    else if (!sameKeys || before.sha256 !== entry.sha256) stale.push(file);
  }
  for (const file of Object.keys(recorded)) if (!current[file]) stale.push(`${file} (no longer keyed)`);
  return { unbumped, stale };
}

test('every keyed asset changes its ?v= key whenever its content changes', () => {
  const current = currentVersions();
  if (process.env.ATLAS_UPDATE_ASSET_VERSIONS === '1') {
    writeFileSync(RECORD, `${JSON.stringify(current, null, 2)}\n`);
  }
  const recorded = JSON.parse(readFileSync(RECORD, 'utf8'));
  assert.ok(Object.keys(current).length > 60, 'the scan finds the shell scripts and stylesheets');
  assert.ok(current[`${WEB}/assets/css/team-messages.css`]?.keys.length === 1, 'one key for a stylesheet linked from index.html, config.js and the guard');
  const { unbumped, stale } = compare(current, recorded);
  assert.deepEqual(unbumped, [], 'These files changed but kept their ?v= key, so installed apps would keep the old copy. Bump the key where they are referenced, then refresh the record.');
  assert.deepEqual(stale, [], 'The key record is out of date. Run: ATLAS_UPDATE_ASSET_VERSIONS=1 node --test tests/node/asset-version-ratchet.test.js');
});

test('the ratchet tells an unbumped edit from a bumped one', () => {
  const now = { 'apps/web/assets/js/home.js': { keys: ['k2'], sha256: 'b' }, 'apps/web/assets/js/shell.js': { keys: ['k1'], sha256: 'b' } };
  const record = { 'apps/web/assets/js/home.js': { keys: ['k1'], sha256: 'a' }, 'apps/web/assets/js/shell.js': { keys: ['k1'], sha256: 'a' }, 'apps/web/gone.js': { keys: ['k1'], sha256: 'a' } };
  assert.deepEqual(compare(now, record), {
    unbumped: ['apps/web/assets/js/shell.js ?v=k1'],
    stale: ['apps/web/assets/js/home.js', 'apps/web/gone.js (no longer keyed)']
  });
  assert.deepEqual(compare(now, now), { unbumped: [], stale: [] });
});
