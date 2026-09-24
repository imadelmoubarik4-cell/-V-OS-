import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const scope = {window: {}};
vm.runInNewContext(fs.readFileSync(new URL('../../apps/web/assets/js/atlas-stock-truth.js', import.meta.url), 'utf8'), scope);
const truth = scope.window.AtlasStockTruth;
test('legacy quantities including zero never establish verified stock', () => {
  for (const quantity of [0, 42, null]) {
    const item = truth.project([{id:'a', quantity}], [])[0];
    assert.equal(item.quantity, null);
    assert.equal(truth.known(item), false);
  }
});
test('verified zero is distinct from unknown and expired stock', () => {
  const balance = {inventory_item_id:'a', verified_quantity:0, freshness_state:'current'};
  assert.equal(truth.project([{id:'a'}], [balance])[0].quantity, 0);
  for (const invalid of [{verified_quantity:null}, {verified_quantity:''}, {freshness_state:'historical'}, {expires_at:'2000-01-01'}, {expires_at:'invalid'}]) {
    assert.equal(truth.project([{id:'a'}], [{...balance,...invalid}])[0].quantity, null);
  }
});
test('valid balance maps by item identity and does not mutate source', () => {
  const source = {id:'a',quantity:999};
  const balances = [{inventory_item_id:'b', verified_quantity:10, freshness_state:'current'}, {inventory_item_id:'a', verified_quantity:2.8, freshness_state:'current',expires_at:'2099-01-01'}];
  assert.equal(truth.project([source],balances)[0].quantity,2.8);
  assert.equal(source.quantity,999);
});

test('newer owner-confirmed physical count overrides an older verified balance', () => {
  const now = Date.parse('2026-09-24T09:00:00Z');
  const item = {
    id:'angelo',
    quantity:10,
    source_type:'owner_confirmed',
    source_confidence:100,
    updated_at:'2026-09-23T22:14:07Z'
  };
  const balance = {
    inventory_item_id:'angelo',
    verified_quantity:0,
    freshness_state:'current',
    verified_at:'2026-09-21T19:36:22Z',
    expires_at:'2026-09-28T19:36:22Z'
  };
  const projected = truth.project([item],[balance],[],now)[0];
  assert.equal(projected.quantity,10);
  assert.equal(projected.verified_quantity,10);
  assert.equal(projected.freshness_state,'current');
  assert.equal(projected.stock_source,'owner_confirmed');
});

test('audited movements after the authoritative baseline adjust current stock', () => {
  const now = Date.parse('2026-09-24T09:00:00Z');
  const item = {
    id:'a',
    quantity:10,
    source_type:'owner_confirmed_supplier_price',
    source_confidence:100,
    updated_at:'2026-09-23T20:00:00Z'
  };
  const balance = {
    inventory_item_id:'a',
    verified_quantity:8,
    freshness_state:'current',
    verified_at:'2026-09-22T12:00:00Z',
    expires_at:'2026-09-29T12:00:00Z'
  };
  const movements = [
    {item_id:'a',movement_type:'sale',quantity_change:-2,created_at:'2026-09-23T21:00:00Z'},
    {item_id:'a',movement_type:'restock',quantity_change:1,created_at:'2026-09-24T08:00:00Z'},
    {item_id:'a',movement_type:'count',quantity_change:99,created_at:'2026-09-24T08:30:00Z'}
  ];
  assert.equal(truth.project([item],[balance],movements,now)[0].quantity,9);
});

test('older owner-confirmed metadata never overrides a newer verified count', () => {
  const now = Date.parse('2026-09-24T09:00:00Z');
  const item = {
    id:'a',
    quantity:10,
    source_type:'owner_confirmed',
    source_confidence:100,
    updated_at:'2026-09-20T20:00:00Z'
  };
  const balance = {
    inventory_item_id:'a',
    verified_quantity:4,
    freshness_state:'current',
    verified_at:'2026-09-22T12:00:00Z',
    expires_at:'2026-09-29T12:00:00Z'
  };
  assert.equal(truth.project([item],[balance],[],now)[0].quantity,4);
});
