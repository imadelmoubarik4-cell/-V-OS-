// S88: supabase/functions/_shared holds the canonical server domain layer.
// Shared modules stay plain ESM (Node tests import them directly), every
// relative import resolves inside supabase/functions (the Supabase bundler's
// ../_shared convention), and every reviewed-source manifest that packages an
// importing function also pins the shared files it imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FUNCTIONS = path.join(ROOT, 'supabase/functions');
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function sourceFiles() {
  const files = [];
  for (const entry of fs.readdirSync(FUNCTIONS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of fs.readdirSync(path.join(FUNCTIONS, entry.name))) {
      if (/\.(ts|mjs|js)$/.test(file)) files.push(path.join(FUNCTIONS, entry.name, file));
    }
  }
  return files;
}

function relativeImports(file) {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+["'](\.{1,2}\/[^"']+)["']/g)]
    .map((match) => path.resolve(path.dirname(file), match[1]));
}

// Transitive local imports of a function entry file.
function localClosure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...relativeImports(file));
  }
  return seen;
}

test('shared modules are dependency-free ESM without Deno APIs', () => {
  const shared = fs.readdirSync(path.join(FUNCTIONS, '_shared'));
  // S88: ai-tools/ holds the Atlas AI Tool Gateway (checked file by file in
  // tests/node/ai-tools-registry.test.js with the same rules).
  assert.deepEqual(shared.sort(), ['ai-tools', 'atlas-domain.mjs', 'auth.mjs', 'stock-provenance.mjs']);
  for (const file of shared.filter((name) => name.endsWith('.mjs'))) {
    const source = fs.readFileSync(path.join(FUNCTIONS, '_shared', file), 'utf8');
    assert.doesNotMatch(source, /\bDeno\./, `${file} must not use Deno APIs`);
    assert.doesNotMatch(source, /from\s+["'](?:jsr:|npm:|https?:)/, `${file} must not import remote packages`);
    assert.doesNotMatch(source, /\blocalStorage\b|\bwindow\./, `${file} must not read browser state`);
  }
});

test('every relative import resolves inside supabase/functions', () => {
  for (const file of sourceFiles()) {
    for (const target of relativeImports(file)) {
      assert.ok(fs.existsSync(target), `${rel(file)} imports missing ${rel(target)}`);
      assert.ok(target.startsWith(FUNCTIONS + path.sep), `${rel(file)} imports outside supabase/functions`);
      const insideShared = target.startsWith(path.join(FUNCTIONS, '_shared') + path.sep);
      const sameFunction = path.dirname(target) === path.dirname(file);
      assert.ok(insideShared || sameFunction, `${rel(file)} may import only its own files or ../_shared`);
    }
  }
  assert.ok(!fs.existsSync(path.join(FUNCTIONS, 'atlas-reports/stock-provenance.mjs')), 'the Reports copy moved to _shared');
  assert.match(fs.readFileSync(path.join(FUNCTIONS, 'atlas-reports/index.ts'), 'utf8'), /from "\.\.\/_shared\/stock-provenance\.mjs"/);
});

test('reviewed-source manifests pin every shared file a packaged function imports', () => {
  const manifests = [
    'docs/release/Atlas_S35_Combined_Isolated_Staging_Manifest.json',
    'docs/release/Atlas_S41_Production_Function_Addendum.json',
  ].map((file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')));
  let checked = 0;
  for (const manifest of manifests) {
    for (const fn of manifest.functions) {
      const sources = new Set(Object.keys(fn.sources));
      for (const source of Object.keys(fn.sources)) {
        if (!/\.(ts|mjs)$/.test(source) || source.includes('/_shared/')) continue;
        for (const file of localClosure(path.join(ROOT, source))) {
          assert.ok(sources.has(rel(file)), `${fn.name} must pin ${rel(file)}`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 0);
});
