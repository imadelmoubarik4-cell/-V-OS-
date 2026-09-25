// S89 product identity: owner rules and fixtures (JS side; the SQL twin is
// covered by product-identity-parity.test.js and the S89 replay previews).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DUPLICATE_THRESHOLDS,
  ICELANDIC_LETTERS,
  duplicateKeys,
  duplicateScore,
  expandUpcE,
  foldText,
  gtinCheckDigitValid,
  identityKey,
  matchKey,
  nameKey,
  normalizeCode,
  packKey,
  parsePackage,
  parsePackageText,
  searchFoldText,
} from '../../supabase/functions/_shared/product-identity.mjs';
import {
  canonicalKey,
  canonicalText,
  normalizeInventoryRow,
  matchInventoryRecord,
  slug,
} from '../../packages/import-engine/index.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/visual-inventory/duplicate-guard-cases.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// Icelandic letters (owner rule 4): every letter, every path.
// ---------------------------------------------------------------------------
const LOWER = { Á: 'á', Ð: 'ð', É: 'é', Í: 'í', Ó: 'ó', Ú: 'ú', Ý: 'ý', Þ: 'þ', Æ: 'æ', Ö: 'ö' };

test('the owner list covers exactly the twenty Icelandic letters', () => {
  assert.equal(ICELANDIC_LETTERS.length, 20);
  for (const [upper, lower] of Object.entries(LOWER)) {
    assert.ok(ICELANDIC_LETTERS.includes(upper) && ICELANDIC_LETTERS.includes(lower));
  }
});

for (const letter of ICELANDIC_LETTERS) {
  const lower = LOWER[letter] ?? letter;
  test(`Icelandic ${letter} survives normalisation, keys, import, aliases, search and export`, () => {
    const name = `Ka${letter}fi ${letter}lfur`;
    // normalisation: case-folded, never transliterated
    assert.equal(foldText(name), `ka${lower}fi ${lower}lfur`);
    assert.ok(nameKey(name).includes(lower), 'stored name key keeps the letter');
    assert.ok(identityKey({ name, size_ml: 700 }).includes(lower), 'identity key keeps the letter');
    // import canonicalize: stored canonical text and key keep the letter
    assert.ok(canonicalText(name).includes(lower));
    assert.ok(canonicalKey(name, '700 ml').startsWith(`ka${lower}fi ${lower}lfur|`));
    assert.ok(slug(name).includes(lower));
    // import row: the stored name is byte-identical (export round trip)
    const row = normalizeInventoryRow({ Item: name, Category: 'Syrups', Unit: '700ml' });
    assert.equal(row.name, name);
    assert.equal(Buffer.from(JSON.parse(JSON.stringify(row)).name, 'utf8').toString('utf8'), name);
    assert.ok(row.canonicalKey.includes(lower));
    // alias matching: an alias spelled with the letter matches its item key
    assert.equal(nameKey(`${letter}lfur Ka${letter}fi`), nameKey(name));
    // search: accent-free typing finds it through the search-only key only
    const typed = searchFoldText(name);
    assert.equal(matchKey(typed), matchKey(name));
    assert.ok(!/[áðéíóúýþæö]/.test(typed), 'the search key is the only transliterated form');
    assert.notEqual(nameKey(typed), nameKey(name), 'accent-free text is not the same stored identity');
  });
}

test('the pre-S89 Icelandic letter loss is fixed in import canonicalize', () => {
  assert.equal(canonicalText('Þurrkaður Ananas'), 'þurrkaður ananas');
  assert.equal(canonicalText('Kristall án bragðefna'), 'kristall án bragðefna');
  assert.equal(canonicalKey('Patrón Reposado', '700 ml'), 'patrón reposado|700 ml');
});

test('import duplicate matching is accent-insensitive but keys keep letters', () => {
  const candidates = [{ id: 'lemons', name: 'Sítrónur', unit: '15kg' }, { id: 'lime', name: 'Límónur', unit: '5kg' }];
  const result = matchInventoryRecord({ name: 'Sitronur', unit: '15kg' }, candidates);
  assert.equal(result.candidate?.id, 'lemons');
  assert.equal(canonicalKey('Sítrónur', '15kg'), 'sítrónur|15kg');
});

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------
test('GTIN check digits for EAN-8, UPC-A, EAN-13 and ITF-14', () => {
  for (const valid of ['96385074', '012345678905', '4006381333931', '5000299223017', '10012345678902']) {
    assert.ok(gtinCheckDigitValid(valid), valid);
  }
  for (const invalid of ['96385075', '012345678904', '4006381333932', '5000299223018', '12345', 'ABC']) {
    assert.ok(!gtinCheckDigitValid(invalid), invalid);
  }
});

test('UPC-A and EAN-13 of one product normalise to the same GTIN-14', () => {
  const upc = normalizeCode('012345678905');
  const ean = normalizeCode('0012345678905');
  assert.equal(upc.kind, 'gtin');
  assert.equal(upc.normalized, '00012345678905');
  assert.equal(ean.normalized, upc.normalized);
  assert.equal(normalizeCode('5 000299 223017').normalized, '05000299223017');
});

test('UPC-E expands to UPC-A before validation', () => {
  assert.equal(expandUpcE('01234565'), '012345000065');
  assert.equal(normalizeCode('01234565', { symbology: 'UPC-E' }).normalized, '00012345000065');
});

test('an invalid check digit is never an exact code; other codes keep hyphens', () => {
  assert.deepEqual({ ...normalizeCode('5000299223018') }, { kind: 'gtin', normalized: null, valid: false, symbology: 'unknown', reason: 'check_digit' });
  assert.equal(normalizeCode('ab-12 x', { kind: 'sku' }).normalized, 'AB-12X');
  assert.equal(normalizeCode('AB', { kind: 'sku' }).valid, false);
  assert.equal(normalizeCode('ÞÓR-123', { kind: 'sku' }).normalized, 'ÞÓR-123', 'non-ASCII letters are not altered');
});

// ---------------------------------------------------------------------------
// Pack parsing: every inventory class
// ---------------------------------------------------------------------------
const PACKS = [
  ['700ml', 'single', 700, 'ml', null],
  ['70cl', 'single', 700, 'ml', null],
  ['5 dl', 'single', 500, 'ml', null],
  ['1L', 'single', 1000, 'ml', null],
  ['1,5 l', 'single', 1500, 'ml', null],
  ['0,7 L', 'single', 700, 'ml', null],
  ['25 L keg', 'single', 25000, 'ml', null],
  ['2 lítrar', 'single', 2000, 'ml', null],
  ['500 g', 'single', 500, 'g', null],
  ['1 kg', 'single', 1000, 'g', null],
  ['1 kíló', 'single', 1000, 'g', null],
  ['100 grömm', 'single', 100, 'g', null],
  ['1250 pcs', 'count', 1250, 'count', null],
  ['1000 stk', 'count', 1000, 'count', null],
  ['20 tea bags', 'count', 20, 'count', null],
  ['24 x 330ml', 'multipack', 330, 'ml', 24],
  ['24 x 330 ml', 'multipack', 330, 'ml', 24],
  ['6 x 1L', 'multipack', 1000, 'ml', 6],
  ['12 x 1 L (1 L carton)', 'multipack', 1000, 'ml', 12],
  ['25 x 2g tea bags', 'multipack', 2, 'g', 25],
  ['6 x 20 bags', 'multipack', 20, 'count', 6],
  ['24×330ml', 'multipack', 330, 'ml', 24],
];
for (const [text, kind, quantity, base, units] of PACKS) {
  test(`pack "${text}"`, () => {
    const pack = parsePackageText(text);
    assert.equal(pack.kind, kind);
    assert.equal(pack.unit_quantity, quantity);
    assert.equal(pack.unit_base, base);
    assert.equal(pack.units_per_pack, units);
  });
}

test('ambiguous and unreadable packs are never guessed', () => {
  assert.equal(parsePackageText('1,000 ml').kind, 'ambiguous');
  assert.equal(parsePackageText('priced per kg').kind, 'none');
  assert.equal(parsePackageText('keg').kind, 'none');
  assert.equal(packKey({ name: 'Milk', package_size: '1,000 ml' }), '?');
});

test('case and unit are different identities; the case prefix needs a case unit', () => {
  assert.equal(packKey({ name: 'Tonic', package_size: '24 x 200 ml', unit: 'cases' }), '24x200ml');
  assert.equal(packKey({ name: 'Tonic', package_size: '24 x 200 ml', unit: 'bottles', size_ml: 200 }), '200ml');
  assert.equal(packKey({ name: 'Lemons', package_size: '15 kg', unit: 'Kassi' }), '15000g');
  assert.equal(parsePackage({ name: 'Syrup', unit_size_quantity: 1, unit_size_base: 'count' }).unit_base, 'count');
});

// ---------------------------------------------------------------------------
// Giffard, aliases and Icelandic/English pairs
// ---------------------------------------------------------------------------
test('Giffard name variants share one stored name key', () => {
  const key = nameKey('Giffard Vanille Syrup');
  assert.equal(nameKey('Vanille Giffard Syrup 1L'), key);
  assert.equal(nameKey('GIFFARD VANILLE SYRUP'), key);
  assert.equal(identityKey({ name: 'Giffard Vanille Syrup 1L' }), identityKey({ name: 'Giffard Vanille Syrup', size_ml: 1000 }));
  // French label and English alias meet only in the search-only match key
  assert.equal(matchKey('GIFFARD SIROP VANILLE 1L'), matchKey('Giffard Vanille Syrup'));
  assert.notEqual(nameKey('GIFFARD SIROP VANILLE'), key);
  assert.equal(matchKey('Giffard Vanilla'), 'giffard vanilla');
});

test('Icelandic and English pairs meet in the search-only key', () => {
  for (const [is, en] of [
    ['Sítrónur 15kg', 'Lemons 15 kg'],
    ['Haframjólk Natrue Barista', 'Natrue Barista Oat Milk'],
    ['BOTANICA Þurrkaður Ananas', 'BOTANICA Dried Pineapple'],
    ['Don Simon trönuberjasafi', 'Don Simon Cranberry Juice'],
    ['Möndlusíróp', 'Almond syrup'],
    ['Sódavatn', 'Soda water'],
    ['Áfengislaus bjór', 'Alcohol free bjór'],
  ]) {
    assert.equal(matchKey(is), matchKey(en), `${is} ~ ${en}`);
    assert.notEqual(nameKey(is), nameKey(en), 'stored keys stay distinct');
  }
});

// ---------------------------------------------------------------------------
// Duplicate guard on the design fixture cases (JS twin of the SQL guard)
// ---------------------------------------------------------------------------
function catalogKeys() {
  return fixture.catalog.map((item) => ({
    ...item,
    active: item.active !== false,
    keys: duplicateKeys({ ...item, codes: [...(item.codes ?? []), ...(fixture.catalog_extra_codes[item.id] ?? [])] }),
  }));
}

function runCase(entry, catalog) {
  const draft = duplicateKeys(entry.draft);
  return catalog
    .map((item) => ({ id: item.id, ...duplicateScore(draft, item.keys) }))
    .filter((row) => row.score >= DUPLICATE_THRESHOLDS.listed || row.code_collision)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

test('fixture codes are valid GTINs where they look like one', () => {
  for (const code of ['3180290000007', '5060108450010']) assert.ok(normalizeCode(code).valid, code);
});

test('duplicate guard recall is 100 % on the fixture cases', () => {
  const catalog = catalogKeys();
  const missed = [];
  for (const entry of fixture.cases.filter((c) => c.expected)) {
    const hit = runCase(entry, catalog).find((row) => row.id === entry.expected);
    if (!hit || hit.score < DUPLICATE_THRESHOLDS.possible) missed.push(`${entry.id}:${hit?.score ?? 'none'}`);
  }
  assert.deepEqual(missed, []);
});

test('duplicate guard false merges are 0 on the fixture cases', () => {
  const catalog = catalogKeys();
  const merges = [];
  for (const entry of fixture.cases) {
    const rows = runCase(entry, catalog);
    const expectedRank = rows.findIndex((row) => row.id === entry.expected);
    rows.forEach((row, rank) => {
      if (!entry.must_not.includes(row.id)) return;
      if (row.score >= DUPLICATE_THRESHOLDS.strong || (expectedRank >= 0 && rank < expectedRank)) {
        merges.push(`${entry.id}:${row.id}:${row.score}`);
      }
    });
  }
  assert.deepEqual(merges, []);
});

test('the inactive historical item is found, codes are certain, siblings stay apart', () => {
  const catalog = catalogKeys();
  const caramel = runCase(fixture.cases.find((c) => c.id === 'G-07'), catalog);
  assert.equal(caramel[0].id, 'gif-caramel');
  const straws = runCase(fixture.cases.find((c) => c.id === 'O-01'), catalog);
  assert.equal(straws[0].id, 'straws');
  assert.equal(straws[0].code_collision, true);
  const banane = runCase(fixture.cases.find((c) => c.id === 'G-08'), catalog);
  assert.ok(banane.every((row) => row.score < DUPLICATE_THRESHOLDS.possible));
  const demerara = runCase(fixture.cases.find((c) => c.id === 'N-01'), catalog);
  assert.ok(demerara.some((row) => row.id === 'sugar-cube'));
  assert.ok(demerara.every((row) => row.score < DUPLICATE_THRESHOLDS.possible));
});
