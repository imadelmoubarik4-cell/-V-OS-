// KANEL V07 price lock + on-request classics. The committed owner snapshot
// (apps/web/assets/data/kanel-price-lock-v07.json) must preserve the owner's
// decisions EXACTLY — 59 locked printed prices, 41 margin exceptions, 29 draft
// classics (13 core + 16 supplementary) — with nothing flagged for POS and
// nothing repriced. The engine must independently reproduce the documented 5%
// cash-margin floors, and the baseline must use the V07 forecast net sales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const snapshot = JSON.parse(readFileSync(new URL('../../apps/web/assets/data/kanel-price-lock-v07.json', import.meta.url), 'utf8'));

const src = readFileSync(new URL('../../apps/web/assets/js/kanel-pricing-engine.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, console };
vm.runInNewContext(src, sandbox, { filename: 'kanel-pricing-engine.js' });
const engine = sandbox.module.exports;

test('exactly 59 printed prices are locked, imported verbatim', () => {
  assert.equal(snapshot.locked_menu.length, 59);
  assert.equal(snapshot.counts.locked, 59);
  assert.ok(snapshot.immutable === true);
  for (const it of snapshot.locked_menu) {
    assert.equal(it.owner_locked, true, `${it.sku} must stay owner-locked`);
    assert.ok(it.sku && it.product, 'every locked row keeps its SKU and product');
    assert.ok(Number.isFinite(it.guest_price_incl_vat_isk), `${it.sku} keeps its price`);
  }
  // No duplicate SKUs (reconcile by canonical SKU, never duplicate a product).
  const skus = snapshot.locked_menu.map((i) => i.sku);
  assert.equal(new Set(skus).size, skus.length, 'locked SKUs are unique');
});

test('nothing in the snapshot is auto-published to POS', () => {
  for (const it of snapshot.locked_menu) assert.equal(it.pos_published, false, `${it.sku} must not be POS-published`);
  for (const c of snapshot.classics) assert.equal(c.pos_published, false, `${c.sku} must not be POS-published`);
});

test('41 margin exceptions, 21 cash-negative — locking does not clear the warning', () => {
  assert.equal(snapshot.exceptions.length, 41);
  assert.equal(snapshot.counts.exceptions, 41);
  assert.equal(snapshot.counts.negative_cash, 21);
  const negative = snapshot.exceptions.filter((x) => x.cash_margin < 0);
  assert.ok(negative.length >= 1);
  // every exception is also a locked item (exceptions are a view over the 59)
  const locked = new Set(snapshot.locked_menu.map((i) => i.sku));
  for (const x of snapshot.exceptions) assert.ok(locked.has(x.sku), `exception ${x.sku} is a locked item`);
});

test('29 on-request classics: 13 core + 16 supplementary, draft, staff-only, off the printed menu', () => {
  assert.equal(snapshot.classics.length, 29);
  const core = snapshot.classics.filter((c) => /CORE/.test(c.service_scope));
  assert.equal(core.length, 13, 'thirteen core classics');
  assert.equal(snapshot.classics.length - core.length, 16, 'sixteen supplementary');
  for (const c of snapshot.classics) {
    assert.ok(!c.printed_menu, `${c.sku} must never be on the printed menu`);
    assert.match(String(c.price_status), /PROPOSAL|APPROVAL|DRAFT/i, `${c.sku} stays a draft proposal`);
  }
});

test('the engine independently reproduces the documented 5% cash-margin floors', () => {
  const p = engine.DEFAULT_PROFILE;
  // overhead is allocated across the V07 forecast net sales
  assert.equal(p.monthlyNetSales, 7214401);
  assert.ok(Math.abs(engine.monthlyOperatingOverhead(p) / p.monthlyNetSales - 0.4503) < 0.001);
  // Spot-check the floors the workbook documents for several signature cocktails.
  const checks = [
    { sku: 'C_LIE', cost: 642.4, floor: 3290 },
    { sku: 'C_NELE', cost: 723.15, floor: 3690 },
    { sku: 'C_EDEN', cost: 681.71, floor: 3390 },
  ];
  for (const c of checks) {
    const rec = engine.recommendedPrice({ productCost: c.cost, profile: engine.withDefaults(p) });
    assert.equal(rec.price, c.floor, `${c.sku}: engine 5% floor should match the workbook`);
    // cross-check against the committed snapshot's own stored floor
    const row = snapshot.locked_menu.find((i) => i.sku === c.sku);
    assert.equal(row.model_5pct_price_floor_isk, c.floor, `${c.sku}: snapshot floor matches`);
  }
});

test('baseline assumptions in the snapshot match the engine profile', () => {
  const a = snapshot.assumptions;
  const p = engine.DEFAULT_PROFILE;
  assert.equal(a.salesVatRate, p.salesVatRate);
  assert.equal(a.turnoverRentPctOfNet, p.turnoverRentPctOfNet);
  assert.equal(a.loanCollectionPct, p.loanCollectionPct);
  assert.equal(a.cardShare, p.cardShare);
  assert.equal(a.merchantFeePct, p.merchantFeePct);
  assert.equal(a.forecastMonthlyNetIsk, p.monthlyNetSales);
  assert.equal(a.historicalMonthlyNetIsk, p.historicalMonthlyNetSales);
  assert.equal(a.garnishPerServingIsk, p.garnishPerServing);
  assert.equal(a.wastePct, p.wastePct);
});
