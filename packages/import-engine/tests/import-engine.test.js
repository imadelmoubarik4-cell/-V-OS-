import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalHeader,
  canonicalKey,
  matchInventoryRecord,
  normalizeCategory,
  normalizeInventoryRow,
  parseMoney,
  parsePackage,
} from '../index.js';

test('canonicalization removes accents and normalizes package spacing', () => {
  assert.equal(canonicalKey('Patrón Reposado', '700 ml'), 'patron reposado|700 ml');
  assert.deepEqual(parsePackage('1L'), { label: '1000ml', quantity: 1000, unit: 'ml', container: null });
  assert.deepEqual(parsePackage('330ml can'), { label: '330ml can', quantity: 330, unit: 'ml', container: 'can' });
});

test('headers and known category typos normalize deterministically', () => {
  assert.equal(canonicalHeader('Qty in Stock'), 'quantity');
  assert.equal(normalizeCategory('Liquen'), 'Liqueur');
  assert.equal(normalizeCategory('Leaves fresh'), 'Fresh Herbs');
});

test('money parsing preserves integer Icelandic prices', () => {
  assert.equal(parseMoney('12,345 ISK').value, 12345);
  assert.equal(parseMoney('1.234 kr.').value, 1234);
  assert.equal(parseMoney('1234.50').value, 1234.5);
});

test('annotated quantities retain their parsed value and a review issue', () => {
  const row = normalizeInventoryRow({
    Category: 'Beer & Cider',
    Item: 'Strawberry Breezer',
    Unit: '275ml',
    'Qty in Stock': '5***',
    'Last Updated': '19/07/2026',
  }, { sourcePrefix: 'inventory-pdf' });
  assert.equal(row.quantity, 5);
  assert.equal(row.sourceUpdatedAt, '2026-07-19');
  assert.ok(row.issues.some(issue => issue.startsWith('numeric_annotation:')));
});

test('duplicate matching prioritizes exact identifiers', () => {
  const candidates = [
    { id: 'one', name: 'Bombay Sapphire', sku: 'GIN-001', unit: '700ml' },
    { id: 'two', name: 'Bombay Bramble', sku: 'GIN-002', unit: '700ml' },
  ];
  const result = matchInventoryRecord({ name: 'Different source spelling', sku: 'gin-001' }, candidates);
  assert.equal(result.action, 'merge');
  assert.equal(result.strategy, 'sku');
  assert.equal(result.candidate.id, 'one');
});

test('generic and ambiguous names remain in review', () => {
  const candidates = [
    { id: 'one', name: 'Gordon London Dry Gin', unit: '700ml' },
    { id: 'two', name: 'Tanqueray London Dry Gin', unit: '700ml' },
  ];
  const result = matchInventoryRecord({ name: 'London Dry Gin', unit: '700ml' }, candidates);
  assert.equal(result.action, 'review');
});
