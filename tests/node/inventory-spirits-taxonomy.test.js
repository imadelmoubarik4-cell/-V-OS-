// Atlas Inventory — Spirits taxonomy (canonical types + strict, stored-first
// classification). Regression for the bug where "Bailey's Original" and
// "Brennivín Original" classified as Gin because /gin/ matched the substring
// "ori(gin)al" in the product name. The real classifier is extracted from
// apps/web/assets/js/atlas-inventory.js and exercised directly, then the app's
// own filter predicate (group + subcategory strict equality) is replayed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('apps/web/assets/js/atlas-inventory.js', 'utf8');
// Self-contained region: GROUPS … inventorySubcategory (no closure deps).
const start = src.indexOf('const GROUPS = [');
const end = src.indexOf('const groupLabel =');
assert.ok(start !== -1 && end !== -1 && end > start, 'taxonomy region not found');
const region = src.slice(start, end);
// eslint-disable-next-line no-new-func
const api = new Function(`${region}\n return { inventoryGroup, inventorySubcategory, spiritsLabel, SPIRIT_TYPES, WINE_TYPES };`)();
const { inventoryGroup, inventorySubcategory, SPIRIT_TYPES } = api;

const sub = (item) => inventorySubcategory(item);
// The app's list filter (atlas-inventory.js filtered()): an item passes a
// Spirits → <type> selection only when it is in the spirits group AND its
// canonical subcategory equals the selected type.
const passes = (item, type) => inventoryGroup(item) === 'spirits' && inventorySubcategory(item) === type;

const I = {
  gin: { name: 'Bombay Sapphire Gin', category: 'Gin', subcategory: 'Gin' },
  ginOriginal: { name: 'Tanqueray Original', category: 'Gin', subcategory: 'Gin' },
  baileys: { name: 'Bailey’s Original', category: 'Liqueur', subcategory: 'Cream Liqueur' },
  cointreau: { name: 'Cointreau', category: 'Liqueur', subcategory: 'Orange Liqueur' },
  cartron: { name: 'Cartron Crème de Cassis', category: 'Liqueur', subcategory: 'Fruit Liqueur' },
  kahlua: { name: 'Kahlúa', category: 'Liqueur', subcategory: 'Coffee Liqueur' },
  brennivin: { name: 'Brennivín Original', category: 'Aquavit / Brennivín', subcategory: 'Brennivín' },
  aperol: { name: 'Aperol Aperitivo', category: 'Vermouth', subcategory: 'Aperitivo' },
  campari: { name: 'Campari', category: 'Vermouth', subcategory: 'Aperitivo' },
  sarti: { name: 'Sarti Rosa', category: 'Vermouth', subcategory: 'Aperitivo' },
  antica: { name: 'Antica Formula Vermouth', category: 'Vermouth', subcategory: 'Vermouth' },
  dolin: { name: 'Dolin Vermouth', category: 'Vermouth', subcategory: 'Vermouth' },
  tequila: { name: 'Olmeca Altos Plata', category: 'Tequila', subcategory: 'Tequila' },
  mezcal: { name: 'Del Maguey Vida', category: 'Mezcal', subcategory: 'Mezcal' },
  cognac: { name: 'Hennessy VS', category: 'Cognac', subcategory: 'Cognac' },
  // wine / beer for the "unchanged" regression
  redWine: { name: 'House Red', category: 'Red Wine', subcategory: 'Red' },
  champagne: { name: 'Moët & Chandon', category: 'Champagne', subcategory: '' },
  rose: { name: 'Whispering Angel', category: 'Rosé Wine', subcategory: 'Rosé' },
  lager: { name: 'Gull Lager', category: 'Beer', subcategory: '' },
  keg: { name: 'Gull 30L Keg', category: 'Beer', subcategory: '' },
};

test('canonical Spirits taxonomy is present in display order', () => {
  assert.deepEqual(SPIRIT_TYPES, ['Gin', 'Vodka', 'Rum', 'Whiskey', 'Tequila & Mezcal', 'Brandy & Cognac', 'Aquavit / Brennivín', 'Liqueurs', 'Aperitifs', 'Vermouth', 'Shots']);
});

test('stored subcategory/category classify to canonical labels', () => {
  assert.equal(sub(I.gin), 'Gin');
  assert.equal(sub(I.baileys), 'Liqueurs');
  assert.equal(sub(I.cointreau), 'Liqueurs');
  assert.equal(sub(I.cartron), 'Liqueurs');
  assert.equal(sub(I.kahlua), 'Liqueurs');
  assert.equal(sub(I.brennivin), 'Aquavit / Brennivín');
  assert.equal(sub(I.aperol), 'Aperitifs');
  assert.equal(sub(I.campari), 'Aperitifs');
  assert.equal(sub(I.sarti), 'Aperitifs');
  assert.equal(sub(I.antica), 'Vermouth');
  assert.equal(sub(I.dolin), 'Vermouth');
  assert.equal(sub(I.tequila), 'Tequila & Mezcal');
  assert.equal(sub(I.mezcal), 'Tequila & Mezcal');
  assert.equal(sub(I.cognac), 'Brandy & Cognac');
});

test('1. Gin excludes Bailey’s and Brennivín (no "ori(gin)al" false match)', () => {
  assert.equal(passes(I.gin, 'Gin'), true);
  assert.equal(passes(I.ginOriginal, 'Gin'), true);
  assert.equal(passes(I.baileys, 'Gin'), false);
  assert.equal(passes(I.brennivin, 'Gin'), false);
});

test('2. Liqueurs excludes Aperol/Campari/Vermouth', () => {
  for (const k of ['baileys', 'cointreau', 'cartron', 'kahlua']) assert.equal(passes(I[k], 'Liqueurs'), true, k);
  for (const k of ['aperol', 'campari', 'antica', 'dolin', 'gin']) assert.equal(passes(I[k], 'Liqueurs'), false, k);
});

test('3. Aperitifs includes Aperol/Campari/Sarti and excludes ordinary liqueurs', () => {
  for (const k of ['aperol', 'campari', 'sarti']) assert.equal(passes(I[k], 'Aperitifs'), true, k);
  for (const k of ['baileys', 'cointreau', 'antica', 'dolin']) assert.equal(passes(I[k], 'Aperitifs'), false, k);
});

test('4. Vermouth includes Dolin/Antica and excludes Aperol', () => {
  assert.equal(passes(I.antica, 'Vermouth'), true);
  assert.equal(passes(I.dolin, 'Vermouth'), true);
  assert.equal(passes(I.aperol, 'Vermouth'), false);
  assert.equal(passes(I.baileys, 'Vermouth'), false);
});

test('5. Aquavit / Brennivín includes Brennivín and excludes Gin', () => {
  assert.equal(passes(I.brennivin, 'Aquavit / Brennivín'), true);
  assert.equal(passes(I.gin, 'Aquavit / Brennivín'), false);
});

test('6. Wine and Beer classification is unchanged', () => {
  assert.equal(inventoryGroup(I.redWine), 'wine');
  assert.equal(sub(I.redWine), 'Red');
  assert.equal(sub(I.champagne), 'Sparkling');
  assert.equal(sub(I.rose), 'Rosé');
  assert.equal(inventoryGroup(I.lager), 'beer');
  assert.equal(sub(I.lager), 'Bottles');
  assert.equal(sub(I.keg), 'Kegs');
  // A spirits type selection never leaks wine/beer.
  for (const k of ['redWine', 'champagne', 'lager', 'keg']) {
    assert.equal(passes(I[k], 'Gin'), false, k);
    assert.equal(passes(I[k], 'Liqueurs'), false, k);
  }
});

test('7. Stored subcategory wins over product-name inference', () => {
  // Name says "Aperol" (would infer Aperitifs) but the stored subcategory is
  // authoritative → Vermouth. And a name containing "Original" never wins as Gin.
  assert.equal(sub({ name: 'Aperol', category: 'Vermouth', subcategory: 'Vermouth' }), 'Vermouth');
  assert.equal(sub({ name: 'Something Original', category: 'Liqueur', subcategory: 'Herbal Liqueur' }), 'Liqueurs');
  // With no meaningful stored classification, name inference is the fallback.
  assert.equal(sub({ name: 'London Dry Gin', category: '', subcategory: '' }), 'Gin');
});
