// Regenerates the Team page bundles from their sources:
//   apps/web/assets/js/team-profiles.source.js   → team-profiles.bundle.js.gz
//   apps/web/assets/css/team-profiles.source.css → team-profiles.bundle.css.gz
// Deterministic gzip (level 9, no file name, mtime 0 — the same as `gzip -9n`),
// installed at runtime by team-profiles-bootstrap.js. Run after editing a
// source: `node scripts/build_team_profiles_bundle.mjs` (add --check to verify only).
// tests/node/team-profiles-ui.test.js fails when a bundle does not match its source.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

const PAIRS = [
  ['apps/web/assets/js/team-profiles.source.js', 'apps/web/assets/js/team-profiles.bundle.js.gz'],
  ['apps/web/assets/css/team-profiles.source.css', 'apps/web/assets/css/team-profiles.bundle.css.gz']
];
const check = process.argv.includes('--check');
let stale = 0;
for (const [source, bundle] of PAIRS) {
  const text = readFileSync(source);
  let current = null;
  try { current = gunzipSync(readFileSync(bundle)); } catch { current = null; }
  if (current && Buffer.compare(current, text) === 0) continue;
  stale += 1;
  if (check) console.error(`${bundle} does not match ${source}`);
  else {
    writeFileSync(bundle, gzipSync(text, { level: 9 }));
    console.log(`rebuilt ${bundle}`);
  }
}
if (check && stale) process.exit(1);
