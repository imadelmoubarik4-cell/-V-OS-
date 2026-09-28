// S96 (webstore, N6): browser CSV exports (Inventory, Reports) neutralise
// cells a spreadsheet would evaluate as formulas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function extract(file, signature) {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${file}: ${signature}`);
  let depth = 0; let end = source.indexOf('{', start);
  for (let i = end; i < source.length; i += 1) { if (source[i] === '{') depth += 1; if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } } }
  return source.slice(start, end);
}
const DANGEROUS = ['=HYPERLINK("https://example.invalid","x")', '+1+2', '-1+2', '@SUM(A1:A2)', '\t=1', '\r=1'];

test('Reports CSV cells never start with a formula trigger', () => {
  const escapeCsv = new Function(`${extract('apps/web/assets/js/reports-workspace.js', 'function escapeCsv(value)')}; return escapeCsv;`)();
  for (const value of DANGEROUS) assert.doesNotMatch(escapeCsv(value).replace(/^"/, ''), /^[=+\-@\t\r]/, JSON.stringify(value));
  assert.equal(escapeCsv(-12), '-12', 'negative numbers stay numbers');
  assert.equal(escapeCsv('Campari'), 'Campari');
});

test('Inventory CSV cells never start with a formula trigger', () => {
  const body = extract('apps/web/assets/js/atlas-inventory.js', 'function exportCsv()');
  const line = body.split('\n').find((row) => row.includes('const cell = '));
  const cell = new Function(`${line.trim()} return cell;`)();
  for (const value of DANGEROUS) assert.doesNotMatch(cell(value).replace(/^"/, ''), /^[=+\-@\t\r]/, JSON.stringify(value));
  assert.equal(cell('Campari'), '"Campari"');
});
