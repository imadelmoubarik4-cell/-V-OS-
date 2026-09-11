import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const workflow = read('.github/workflows/s34-visual-evidence.yml');
const capture = read('scripts/capture_s34_visual_evidence.mjs');

test('S34 evidence workflow is PR-scoped, read-only, and uploads one review artifact', () => {
  assert.match(workflow, /pull_request:\s*\n\s*branches:\s*\n\s*- claude\/recipes-gallery-v2/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /playwright@1\.55\.0/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /name: atlas-s34-synthetic-visual-evidence/);
  assert.match(workflow, /retention-days: 30/);
  assert.doesNotMatch(workflow, /(?:run:|uses:)[^\n]*(?:supabase|deploy|migration|production)/i);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./i);
});

test('S34 capture covers all 12 modules at the reviewed desktop and mobile sizes', () => {
  for (const moduleName of [
    'home', 'operations', 'inventory', 'stock', 'recipes', 'purchasing',
    'messages', 'team', 'shifts', 'knowledge', 'brain', 'settings'
  ]) {
    assert.match(capture, new RegExp(`'${moduleName}'`));
  }
  assert.match(capture, /name: 'desktop', width: 1440, height: 900/);
  assert.match(capture, /name: 'mobile', width: 390, height: 844/);
  assert.match(capture, /capture_count: captures\.length/);
  assert.match(capture, /sha256/);
});

test('S34 evidence remains synthetic, local, and network-blocked', () => {
  assert.match(capture, /pathToFileURL\(fixturePath\)/);
  assert.match(capture, /serviceWorkers: 'block'/);
  assert.match(capture, /route\.abort\('blockedbyclient'\)/);
  assert.match(capture, /remote_requests_allowed: false/);
  assert.match(capture, /hosted_changes: false/);
  assert.match(capture, /production_changes: false/);
  assert.match(capture, /failed the synthetic-data gate/);
});
