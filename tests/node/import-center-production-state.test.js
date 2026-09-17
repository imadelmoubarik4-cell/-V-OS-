import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('apps/web/index.html', 'utf8');
const config = readFileSync('apps/web/config.js', 'utf8');
const importCenter = readFileSync('apps/web/assets/js/import-center.js', 'utf8');

test('production Import Queue states that automatic processing is paused', () => {
  assert.match(config, /IMPORT_WORKER_API:\s*""/);
  assert.match(app, /Automatic processing is paused/);
  assert.match(app, /Production stores uploads privately but does not run Read, Extract or Match/);
  assert.doesNotMatch(app, /will automatically move uploaded files through Read, Extract and Match/);
});

test('disabled processing stages are distinguishable from private upload', () => {
  assert.match(app, /data-stage="uploaded"/);
  for (const stage of ['reading', 'extracting', 'matching', 'ready', 'importing']) {
    assert.match(app, new RegExp(`data-stage="${stage}" aria-disabled="true"`));
  }
  assert.match(app, /Production does not process the batch automatically/);
  assert.match(app, /Awaiting processing/);
});

test('worker actions remain fail-closed when the endpoint is absent', () => {
  assert.match(importCenter, /if\(!workerEndpoint\(\)\|\|workerBusy\.has\(batch\.id\)\)return ''/);
  assert.match(importCenter, /if\(!endpoint\)throw new Error\('CSV processing is not enabled in this environment\.'\)/);
});
