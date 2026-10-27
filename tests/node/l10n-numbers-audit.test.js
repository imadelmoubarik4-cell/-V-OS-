// Audit l10n-numbers (M16, M17, L30, L31, L33, L34): one browser rule for
// typed numbers, quantity display, search folding and name order
// (AtlasFormat in apps/web/assets/js/atlas-venue-clock.js), the CSV cells of
// the Inventory and Reports exports, and the public menu's prices and order.
// Browser behaviour: tests/browser/l10n-numbers.browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const CLOCK = new URL('../../apps/web/assets/js/atlas-venue-clock.js', import.meta.url).pathname;
const MENU = new URL('../../apps/web/assets/js/public-menu.js', import.meta.url).pathname;

function format() {
  const context = { Date, Intl, Number, Math, Map, Set, String, Array, Object, JSON, Promise, RegExp, Error, URL, setTimeout, clearTimeout };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(CLOCK, 'utf8'), context);
  return context.AtlasFormat;
}

function extract(file, signature) {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${file}: ${signature}`);
  let depth = 0; let end = source.indexOf('{', start);
  for (let i = end; i < source.length; i += 1) { if (source[i] === '{') depth += 1; if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } } }
  return source.slice(start, end);
}

test('M16: money reads the Icelandic and the plain form, and never guesses', () => {
  const { parseAmount } = format();
  const cases = [['4.500', 4500], ['4.500,5', 4500.5], ['4,5', 4.5], ['12 345', 12345], ['4500', 4500], ['4.5', 4.5], ['0.500', 0.5], ['3.900 kr', 3900], ['1.250.000', 1250000]];
  for (const [text, expected] of cases) assert.equal(parseAmount(text), expected, text);
  for (const text of ['abc', '4,500.50', '1.2.3', '4,5,6', '12-3']) assert.ok(Number.isNaN(parseAmount(text)), text);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('   '), null);
});

test('M16: a stored amount shown in a money field reads back unchanged', () => {
  const { parseAmount, amountInputValue } = format();
  for (const value of [0, 4500, 4.5, 1.125, 3900, 1250.75]) assert.equal(parseAmount(amountInputValue(value)), value, String(value));
  assert.equal(amountInputValue(1.125), '1,125', 'never "1.125", which is 1125');
  assert.equal(amountInputValue(null), '');
});

test('M16/L30: quantities take one decimal mark, refuse grouping and ask about "1,250"', () => {
  const { parseQuantity, quantityIsAmbiguous, ambiguousQuantityText } = format();
  for (const [text, expected] of [['1,5', 1.5], ['1.5', 1.5], ['12', 12], ['.5', 0.5], ['0,250', 0.25]]) assert.equal(parseQuantity(text), expected, text);
  for (const text of ['1 250', '1.250,5', '1,250.5', 'x', '1..2']) assert.ok(Number.isNaN(parseQuantity(text)), text);
  assert.equal(parseQuantity(''), null);
  for (const text of ['1,250', '1.250', '12.500', '999,000']) assert.ok(quantityIsAmbiguous(text), text);
  for (const text of ['1,5', '1.25', '0,250', '1250', '1.2500']) assert.ok(!quantityIsAmbiguous(text), text);
  assert.equal(ambiguousQuantityText('1,250'), '“1,250” could mean 1250 or 1.25. Type 1250 or 1.25.');
  assert.equal(ambiguousQuantityText('1.000'), '“1.000” could mean 1000 or 1. Type 1000 or 1.');
  // Three decimals stay enterable: the suggested decimal is not ambiguous itself.
  assert.equal(ambiguousQuantityText('1.125'), '“1.125” could mean 1125 or 1.125. Type 1125 or 1.1250.');
  assert.equal(ambiguousQuantityText('12,375'), '“12,375” could mean 12375 or 12.375. Type 12375 or 12.3750.');
  for (const raw of ['1.125', '1,250', '12,375', '1.000']) {
    const suggested = ambiguousQuantityText(raw).match(/Type (\S+) or (\S+)\.$/).slice(1);
    for (const answer of suggested) assert.equal(quantityIsAmbiguous(answer), false, `${raw} → ${answer}`);
    assert.equal(parseQuantity(suggested[1]), Number(raw.replace(',', '.')), `${raw} decimal answer`);
  }
});

test('L30: quantities are shown without a thousands separator', () => {
  const { formatQuantity } = format();
  assert.equal(formatQuantity(1250), '1250');
  assert.equal(formatQuantity(1234567.5), '1234567.5');
  assert.equal(formatQuantity(1.2345), '1.235');
  assert.equal(formatQuantity(null), '—');
  for (const file of ['atlas-purchasing.js', 'atlas-inventory.js']) {
    const source = readFileSync(new URL(`../../apps/web/assets/js/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /toLocaleString\('en-GB', \{ maximumFractionDigits: 3 \}\)/, `${file} shows quantities through AtlasFormat.formatQuantity`);
  }
});

test('L31: search folds case, accents and þ/ð/æ like the server', () => {
  const { fold, searchKey, foldIncludes } = format();
  assert.equal(fold('Þristur'), 'thristur');
  assert.equal(fold('Ölgerðin'), 'olgerdin');
  assert.equal(fold('Ægir'), 'aegir');
  assert.equal(fold('Brennivín'), 'brennivin');
  assert.equal(searchKey('Ægir — Brennivín 1L'), 'aegir brennivin 1l');
  assert.ok(foldIncludes('Ölgerðin Egill Skallagrímsson', 'olgerdin'));
  assert.ok(foldIncludes('Ölgerðin', 'ÖLGERÐ'));
  // The palette provider uses the same fold, with a fallback that keeps þ/ð/æ.
  const normalize = new Function('window', `${extract('apps/web/assets/js/atlas-search.js', 'function normalize(value)')}; return normalize;`);
  assert.equal(normalize({ AtlasFormat: format() })('Þristur'), 'thristur');
  assert.equal(normalize({})('Þristur Ölgerðin'), 'thristur olgerdin');
});

test('L34: names sort in the venue language whatever the device language', () => {
  const probe = `
    const vm = require('node:vm');
    const fs = require('node:fs');
    const context = { Date, Intl, Number, Math, Map, Set, String, Array, Object, JSON, Promise, RegExp, Error, URL, setTimeout, clearTimeout };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(${JSON.stringify(CLOCK)}, 'utf8'), context);
    process.stdout.write(JSON.stringify(['Ölgerðin', 'Zebra', 'Þristur', 'item 10', 'Ásgeir', 'agnes', 'item 2', 'Bónus'].sort(context.AtlasFormat.compareNames)));`;
  const run = (LC_ALL) => JSON.parse(execFileSync(process.execPath, ['-e', probe], { env: { ...process.env, LC_ALL, LANG: LC_ALL }, encoding: 'utf8' }));
  const expected = ['agnes', 'Ásgeir', 'Bónus', 'item 2', 'item 10', 'Zebra', 'Þristur', 'Ölgerðin'];
  for (const locale of ['en_US.UTF-8', 'de_DE.UTF-8', 'is_IS.UTF-8']) assert.deepEqual(run(locale), expected, locale);
  for (const file of ['atlas-inventory.js', 'atlas-purchasing.js', 'recipes.js']) {
    const source = readFileSync(new URL(`../../apps/web/assets/js/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.localeCompare\(String\(b\.name|localeCompare\(String\(b\?\.code \|\| ''\), 'en'|a\.name\.localeCompare\(b\.name\)/, `${file} sorts names through compareNames`);
  }
});

test('M17: Inventory CSV number cells use the format\'s decimal mark and stay formula-safe', () => {
  const body = extract('apps/web/assets/js/atlas-inventory.js', 'function exportCsv(');
  const line = body.split('\n').find((row) => row.includes('const cell = '));
  const cell = new Function(`${line.trim()} return cell;`)();
  assert.equal(cell(4500.5, ','), '4500,5');
  assert.equal(cell(4500.5), '4500.5');
  assert.equal(cell(-2), '-2', 'a negative number is a number, not a formula');
  assert.equal(cell('=1+1', ','), '"\'=1+1"');
  assert.match(body, /\\ufeff/, 'BOM');
  assert.match(body, /join\('\\r\\n'\)\}\\r\\n/, 'CRLF');
  assert.match(readFileSync('apps/web/assets/js/atlas-inventory.js', 'utf8'), /const CSV_FORMATS = \{ standard: \{ separator: ',', decimal: '\.' \}, icelandic: \{ separator: ';', decimal: ',' \} \};/);
  assert.match(body, /CSV_FORMATS\[arguments\[0\]\]/);
  assert.match(body, /venueDate/, 'the count date is YYYY-MM-DD');
});

test('M17: Reports CSV lines in both variants: numbers, decimal commas, quoted separators', () => {
  const source = readFileSync('apps/web/assets/js/reports-workspace.js', 'utf8');
  const formats = source.match(/const CSV_FORMATS = [^\n]+/)[0];
  const csvLine = new Function(`${extract('apps/web/assets/js/reports-workspace.js', 'function escapeCsv(value)')}\n${formats}\n${extract('apps/web/assets/js/reports-workspace.js', 'function csvLine(values')}; return { csvLine, CSV_FORMATS };`)();
  assert.equal(csvLine.csvLine(['Brennivín', 1.5, 'a;b', '=HYPERLINK("x")'], csvLine.CSV_FORMATS.icelandic), 'Brennivín;1,5;"a;b";"\'=HYPERLINK(""x"")"');
  assert.equal(csvLine.csvLine(['Brennivín', 1.5, 'a,b', -3], csvLine.CSV_FORMATS.standard), 'Brennivín,1.5,"a,b",-3');
  assert.match(source, /data-reports-export="csv-icelandic"/);
  assert.match(source, /\\ufeff\$\{lines\.join\('\\r\\n'\)\}\\r\\n/);
});

function renderMenu(rows, { LC_ALL } = {}) {
  const probe = `
    const vm = require('node:vm');
    const fs = require('node:fs');
    const nodes = {};
    const element = (id) => (nodes[id] ||= { id, innerHTML: '' });
    const document = { getElementById: element, querySelectorAll: () => [] };
    const client = { from: () => ({ select: async () => ({ data: ${JSON.stringify(rows)}, error: null }) }) };
    const context = { window: { VABAR_CONFIG: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' }, supabase: { createClient: () => client } }, document, console };
    context.window.document = document;
    vm.createContext(context);
    vm.runInContext('var window = this.window; ' + fs.readFileSync(${JSON.stringify(MENU)}, 'utf8'), context);
    setImmediate(() => process.stdout.write(JSON.stringify({ list: nodes['menu-list'].innerHTML, tabs: nodes['menu-tabs'].innerHTML })));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', probe], { env: { ...process.env, LC_ALL, LANG: LC_ALL }, encoding: 'utf8' }));
}

test('L33: the guest menu shows "3.900 ISK" and the same order on every phone', () => {
  const rows = [
    { id: 3, name: 'Ölgerðin Pils', type: 'beer', menu_price: 1290 },
    { id: 1, name: 'Zombie', type: 'cocktail', menu_price: 3900 },
    { id: 2, name: 'Þristur', type: 'cocktail', menu_price: 12500.4 },
    { id: 4, name: 'Aperol Spritz', type: 'cocktail', menu_price: null }
  ];
  const outputs = ['en_US.UTF-8', 'de_DE.UTF-8', 'sv_SE.UTF-8'].map((LC_ALL) => renderMenu(rows, { LC_ALL }));
  for (const output of outputs) {
    const names = [...output.list.matchAll(/<span class="name">([^<]*)<\/span>/g)].map((match) => match[1]);
    const prices = [...output.list.matchAll(/<span class="price">([^<]*)<\/span>/g)].map((match) => match[1]);
    assert.deepEqual(names, ['Aperol Spritz', 'Zombie', 'Þristur', 'Ölgerðin Pils']);
    assert.deepEqual(prices, ['', '3.900 ISK', '12.500 ISK', '1.290 ISK']);
    assert.deepEqual([...output.tabs.matchAll(/data-type="([^"]*)"/g)].map((match) => match[1]), ['all', 'beer', 'cocktail']);
  }
  assert.equal(outputs[0].list, outputs[1].list);
});
