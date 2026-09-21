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
