import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..', '..');
const readSources = fs.readFileSync(path.join(root, 'apps/web/assets/js/read-sources-p22.js'), 'utf8');
const checkpointM = fs.readFileSync(path.join(root, 'apps/web/assets/js/pos-mapping-checkpoint-m.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'apps/web/assets/js/settings-mount-bridge.js'), 'utf8');


test('P2.2 Source Center uses an authenticated read-only gateway', () => {
  assert.match(readSources, /authorization:\s*`Bearer \$\{session\.access_token\}`/);
  assert.match(readSources, /method:\s*'GET'/);
  assert.match(readSources, /cache:\s*'no-store'/);
  assert.match(readSources, /source bodies, private URLs or credentials/i);
  assert.match(readSources, /Automatic synchronization is off/i);
  assert.doesNotMatch(readSources, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(readSources, /(?:atlasSupabase|supabase|\bsb\b|\bclient\b)\s*\.\s*from\s*\(/i);
  assert.doesNotMatch(readSources, /method:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/);
});


test('P2.2 Source Center mounts only in the Knowledge sources workspace', () => {
  assert.match(readSources, /knowledge-sources-page/);
  assert.match(readSources, /data-p22-source-center/);
  assert.match(readSources, /AtlasReadSourcesP22/);
  assert.match(loader, /read-sources-p22\.js/);
  assert.match(loader, /read-sources-p22\.css/);
});


test('Checkpoint M remains manager-reviewed and sales-disabled', () => {
  assert.match(checkpointM, /authorization:\s*`Bearer \$\{session\.access_token\}`/);
  assert.match(checkpointM, /Sales intelligence remains off/);
  assert.match(checkpointM, /never auto-approved/);
  assert.match(checkpointM, /Sales ingestion remains disabled/);
  assert.match(checkpointM, /Refresh product targets/);
  assert.doesNotMatch(checkpointM, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(checkpointM, /(?:atlasSupabase|supabase|\bsb\b|\bclient\b)\s*\.\s*from\s*\(/i);
  assert.doesNotMatch(checkpointM, /automatic[^\n]{0,30}publishing[^\n]{0,30}true/i);
  assert.doesNotMatch(checkpointM, /automatic[^\n]{0,30}ordering[^\n]{0,30}true/i);
});


test('Checkpoint M mounts in Reports without replacing the reporting workspace', () => {
  assert.match(checkpointM, /reports-view/);
  assert.match(checkpointM, /reports-navigation/);
  assert.match(checkpointM, /data-checkpoint-m-shell/);
  assert.match(checkpointM, /AtlasCheckpointM/);
  assert.match(loader, /pos-mapping-checkpoint-m\.js/);
  assert.match(loader, /pos-mapping-checkpoint-m\.css/);
});