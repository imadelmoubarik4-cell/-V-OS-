// S89 product identity: the JS module and its SQL twin must agree on every
// corpus string. Vectors in tests/fixtures/product-identity/sql-vectors.json
// are generated from SQL (scripts/generate_product_identity_vectors.mjs); with
// ATLAS_PARITY_PGDATABASE set (a replayed loopback database) the SQL runs live.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as identity from '../../supabase/functions/_shared/product-identity.mjs';
import { productIdentityConstants, migrationConstants } from '../../scripts/product_identity_constants.mjs';
import { runVectorQuery } from '../../scripts/generate_product_identity_vectors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/product-identity/corpus.json'), 'utf8'));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/product-identity/sql-vectors.json'), 'utf8'));

// JSON numbers from SQL may be 1000 or 1000.0; compare numerically.
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  if (typeof value === 'number') return Number(value.toFixed(6));
  return value;
}

function jsPackage(pkg) {
  const { source, ...rest } = pkg;
  return source === undefined ? rest : { ...rest, source };
}

function assertParity(vectors, label) {
  assert.equal(vectors.version, identity.PRODUCT_IDENTITY_VERSION, `${label}: version`);
  assert.equal(vectors.texts.length, corpus.texts.length);
  vectors.texts.forEach((row, index) => {
    const text = corpus.texts[index];
    assert.equal(row.text, text);
    assert.equal(identity.foldText(text), row.fold, `${label} fold ${JSON.stringify(text)}`);
    assert.equal(identity.searchFoldText(text), row.search_fold, `${label} search fold ${JSON.stringify(text)}`);
    assert.deepEqual(identity.nameTokens(text), row.name_tokens, `${label} name tokens ${JSON.stringify(text)}`);
    assert.deepEqual(identity.matchTokens(text), row.match_tokens, `${label} match tokens ${JSON.stringify(text)}`);
    assert.equal(identity.nameKey(text), row.name_key, `${label} name key ${JSON.stringify(text)}`);
    assert.equal(identity.matchKey(text), row.match_key, `${label} match key ${JSON.stringify(text)}`);
    assert.deepEqual(normalize(identity.parsePackageText(text)), normalize(row.package), `${label} package ${JSON.stringify(text)}`);
  });
  vectors.items.forEach((row, index) => {
    const item = corpus.items[index];
    assert.deepEqual(normalize(jsPackage(identity.parsePackage(item))), normalize(row.package), `${label} item package ${JSON.stringify(item)}`);
    assert.equal(identity.packKey(item), row.pack_key, `${label} pack key ${JSON.stringify(item)}`);
    assert.equal(identity.nameKey(item), row.name_key, `${label} item name key ${JSON.stringify(item)}`);
    assert.equal(identity.matchKey(item), row.match_key, `${label} item match key ${JSON.stringify(item)}`);
    assert.equal(identity.identityKey(item), row.identity_key, `${label} identity key ${JSON.stringify(item)}`);
  });
  vectors.codes.forEach((row, index) => {
    const input = corpus.codes[index];
    assert.deepEqual(normalize(identity.normalizeCode(input.raw, input)), normalize(row.result), `${label} code ${JSON.stringify(input)}`);
  });
  vectors.duplicates.forEach((row, index) => {
    const entry = corpus.duplicates[index];
    const draft = identity.duplicateKeys(entry.draft);
    const item = identity.duplicateKeys(entry.item);
    assert.deepEqual(normalize(draft), normalize(row.draft_keys), `${label} draft keys ${index}`);
    assert.deepEqual(normalize(item), normalize(row.item_keys), `${label} item keys ${index}`);
    assert.deepEqual(normalize(identity.duplicateScore(draft, item)), normalize(row.result), `${label} duplicate score ${index}`);
  });
}

test('the migration embeds exactly the shared module constants', () => {
  const found = migrationConstants();
  assert.ok(found, 'a migration defines atlas_private.product_identity_constants()');
  assert.deepEqual(found.value, productIdentityConstants());
});

test('committed SQL vectors cover the whole corpus', () => {
  assert.ok(corpus.texts.length >= 200, 'at least 200 parity strings');
  assert.equal(committed.texts.length, corpus.texts.length, 'regenerate sql-vectors.json after changing the corpus');
  assert.equal(committed.items.length, corpus.items.length);
  assert.equal(committed.codes.length, corpus.codes.length);
  assert.equal(committed.duplicates.length, corpus.duplicates.length);
});

test('JS matches the SQL twin on the committed vectors', () => {
  assertParity(committed, 'vectors');
});

test('JS matches the SQL twin live on the replay database', { skip: !process.env.ATLAS_PARITY_PGDATABASE }, () => {
  const live = runVectorQuery(corpus, { ...process.env, PGDATABASE: process.env.ATLAS_PARITY_PGDATABASE });
  assertParity(live, 'live');
  assert.deepEqual(normalize(live), normalize(committed), 'committed vectors are current');
});
