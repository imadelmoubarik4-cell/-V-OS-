// S90 (acceptance review P1-1): no raw error text reaches the page. A
// JavaScript error ("Cannot read properties of undefined …") or server text is
// never rendered; modules show their own fixed copy through AtlasApi.message
// (atlas-api.js), which only passes copy Atlas wrote (AtlasApiError /
// AtlasApi.fixed, or an error marked atlasFixed) and otherwise the caller's
// fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const JS_DIR = 'apps/web/assets/js';
const read = (file) => fs.readFileSync(file, 'utf8');
const files = fs.readdirSync(JS_DIR).filter((name) => name.endsWith('.js'));

// Lines that read an error's message without rendering it: console output,
// pattern tests for branching, the fixed-copy gate itself, and Purchasing's
// mapping of database text to its fixed ERRORS table.
const ALLOWED = [
  /console\.\w+\(/,
  /\.test\((String\()?(\[?error|result\.error)/,
  /error\?\.atlasFixed \? error\.message : fallback/,
  /error instanceof (AtlasApiError|CaptureError)/,
  /const text = \[error\?\.message, error\?\.details/,
  // rehearsal-boundary.js replaces a configuration failure with fixed copy.
  /banner\.textContent = failure\?\.message \|\|/
];
const ERRORISH = /\b(error|err|e|ex|failure|caught|problem|cause|reason)\??\.message\b/;

test('no module renders error.message, err.message or String(error)', () => {
  const offences = [];
  for (const file of files) {
    if (file === 'atlas-api.js') continue;
    read(`${JS_DIR}/${file}`).split('\n').forEach((line, index) => {
      const where = `${file}:${index + 1}: ${line.trim().slice(0, 140)}`;
      if (ERRORISH.test(line) && !ALLOWED.some((pattern) => pattern.test(line))) offences.push(where);
      if (/String\((error|err|e|failure|caught)\)/.test(line) && !/console\./.test(line)) offences.push(where);
      if (/\b(error|err)\??\.message\s*\|\|/.test(line) && !ALLOWED.some((pattern) => pattern.test(line))) offences.push(where);
    });
  }
  assert.deepEqual(offences, [], 'render fixed copy with AtlasApi.message(error, fallback) instead');
});

test('module-owned error types are marked as fixed copy', () => {
  const marks = {
    'knowledge-workspace.js': /class KnowledgeError[^}]*this\.atlasFixed = true/,
    'shifts-workspace.js': /class ShiftsError[^}]*this\.atlasFixed = true/,
    'team-messages.js': /class MessagesError[\s\S]{0,160}this\.atlasFixed = true/,
    'team-profiles.source.js': /class TeamError[^}]*this\.atlasFixed = true/,
    'atlas-capture.js': /class CaptureError[\s\S]{0,260}this\.atlasFixed = true/
  };
  for (const [file, pattern] of Object.entries(marks)) assert.match(read(`${JS_DIR}/${file}`), pattern, file);
  for (const file of ['atlas-purchasing.js', 'atlas-inventory.js', 'stock-count-workspace.js']) {
    const source = read(`${JS_DIR}/${file}`);
    assert.doesNotMatch(source, /throw (Object\.assign\()?new Error\(/, `${file} throws unmarked errors`);
    assert.match(source, /root\.AtlasApi\.message\(error, fallback\)/, `${file} renders through AtlasApi.message`);
  }
});

test('AtlasApi.message shows fixed copy and hides JavaScript and server errors', () => {
  const warnings = [];
  const context = { console: { warn: (...args) => warnings.push(args) }, Object, String, Number, Error, URL, CustomEvent: class {}, setTimeout, clearTimeout };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read(`${JS_DIR}/atlas-api.js`), context);
  const api = context.AtlasApi;
  const typeError = vm.runInContext('(() => { try { undefined.supplier_id; } catch (error) { return error; } })()', context);
  assert.equal(api.message(typeError, 'This order couldn’t be loaded.'), 'This order couldn’t be loaded.');
  assert.equal(api.message(new Error('duplicate key value violates unique constraint'), 'Nothing was saved.'), 'Nothing was saved.');
  assert.equal(api.message({ message: 'permission denied for table x', atlasFixed: 'yes' }, 'Fallback.'), 'Fallback.');
  assert.equal(api.message(null, 'Fallback.'), 'Fallback.');
  const fixed = api.fixed('Choose an active supplier.', { code: 'supplier', status: 409, raw: { message: 'x' } });
  assert.equal(api.message(fixed, 'Fallback.'), 'Choose an active supplier.');
  assert.deepEqual([fixed.code, fixed.status, fixed.raw.message], ['supplier', 409, 'x']);
  assert.equal(api.message(Object.assign(new Error('Photo too small.'), { atlasFixed: true }), 'Fallback.'), 'Photo too small.');
  assert.ok(warnings.length >= 2, 'hidden errors are logged to the console');
});

test('Purchasing: a missing or failed order shows a not-found or could-not-load state', () => {
  const source = read(`${JS_DIR}/atlas-purchasing.js`);
  const start = source.indexOf('async function openOrderDetail(');
  const body = source.slice(start, source.indexOf('\n  function bindDetail(', start));
  assert.match(body, /!data\.order \|\| !data\.order\.id/, 'an empty answer is not found, never a crash');
  assert.match(body, /This order no longer exists\./);
  assert.match(body, /Back to orders/);
  assert.match(body, /This order couldn’t be loaded\.', 'Nothing was changed\. Check your connection and try again\.'/);
  assert.doesNotMatch(body, /error\.message/);
});
