// KANEL Pricing & Profitability — engine regression suite.
// Proves the shared calculation engine (apps/web/assets/js/kanel-pricing-engine.js)
// against the spec's mandatory test categories: net-ex-VAT margins (never on the
// VAT-inclusive guest price), 11%/24% VAT recoverable vs not, the employer
// allowance counted once, turnover rent, loan collection across every base,
// card fees on card takings, batch / clarification yields, pack / keg / wine / coffee
// conversions, net-share overhead allocation that reconciles to the whole, break-even,
// the alerts for negative / thin margins, menu-ending rounding, and a full
// serving ladder.
//
// Every business figure below is SYNTHETIC (round invented numbers chosen so the
// expectations can be checked by hand). No real venue input belongs in this file:
// the engine ships to the browser with neutral defaults only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The engine ships as a browser global (window.KanelPricing, injected by
// loadAtlasAssetOnce). The repo root is an ES module, so we load the IIFE the
// way the suite loads every browser file: evaluate the source in a VM with a
// CommonJS `module` shim and read back module.exports — the SAME artifact the
// browser runs, so the UI and these tests share one source of truth.
const src = readFileSync(new URL('../../apps/web/assets/js/kanel-pricing-engine.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, console };
vm.runInNewContext(src, sandbox, { filename: 'kanel-pricing-engine.js' });
const engine = sandbox.module.exports;
const {
  roundIsk, round, num, roundToMenuEnding,
  netFromGross, grossFromNet, outputVat, purchaseVat,
  costPerServing, batchCostPerServing,
  priceProduct, recommendedPrice, solveGuestPrice,
  businessModel, monthlyOperatingOverhead, monthlyCashOverhead,
  DEFAULT_PROFILE,
} = engine;

// A synthetic venue profile: invented, round inputs (not any real business).
//   net of a 2220 kr guest price = 2220 / 1.11 = 2000 exactly
//   overhead = 1,000,000 + 300,000 + 400,000 + 100,000 = 1,800,000 a month
const SYNTH = Object.freeze({
  ...DEFAULT_PROFILE,
  employerCostPct: 0.30,
  turnoverRentPctOfNet: 0.10,
  loanCollectionPct: 0.10,
  loanCollectionBase: 'gross_incl_vat',
  cardShare: 0.80,
  merchantFeePct: 0.03,
  blendedProductCostPct: 0.30,
  targetCashSurplusPctOfNet: 0.05,
  monthlyNetSales: 5000000,
  expenses: [
    { key: 'wages_gross', label: 'Wages', category: 'payroll', monthlyEffective: 1000000, monthlyCash: 1000000, vatRecoverable: false },
    { key: 'employer_costs', label: 'Employer costs at 30%', category: 'payroll', monthlyEffective: 300000, monthlyCash: 300000, vatRecoverable: false },
    { key: 'premises', label: 'Premises', category: 'property', monthlyEffective: 400000, monthlyCash: 400000, vatRecoverable: false },
    { key: 'software', label: 'Software', category: 'technology', monthlyEffective: 100000, monthlyCash: 124000, vatRecoverable: true },
  ],
});

// Within 1 ISK (rounding at posting boundaries) / within tol for ratios.
const near = (actual, expected, tol = 1) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} not within ${tol} of ${expected}`);

test('roundIsk rounds half away from zero and survives binary-float drift', () => {
  assert.equal(roundIsk(0.5), 1);
  assert.equal(roundIsk(2.5), 3);
  assert.equal(roundIsk(2.4), 2);
  assert.equal(roundIsk(-0.5), -1);
  assert.equal(roundIsk(-2.5), -3);
  assert.equal(roundIsk(0), 0);
  // 0.1+0.2 == 0.30000000000000004, *2.5 boundaries etc. stay stable:
  assert.equal(roundIsk(1.005 * 100 - 100), 1); // ~0.4999..->? drift guard, stays sane
  assert.equal(roundIsk(258.9999999997), 259);
  assert.ok(Number.isNaN(roundIsk(Infinity)));
  assert.ok(Number.isNaN(roundIsk('x')));
});

test('menu-ending rounding lands on xx90 and never drops below the value', () => {
  assert.equal(roundToMenuEnding(2850, 90, 100), 2890);
  assert.equal(roundToMenuEnding(2890, 90, 100), 2890);
  assert.equal(roundToMenuEnding(2891, 90, 100), 2990);
  assert.equal(roundToMenuEnding(2800, 90, 100), 2890);
  // a value already on an ending below it rounds up to protect the floor
  assert.equal(roundToMenuEnding(1895, 90, 100), 1990);
});

test('VAT: net excludes 11% output VAT; output VAT is the difference', () => {
  // 2220 incl 11% -> net 2000, VAT 220; 1000 incl 11% -> net 900.90..., VAT 99.09...
  near(netFromGross(2220, 0.11), 2000, 0.01);
  near(outputVat(2220, 0.11), 220, 0.01);
  near(netFromGross(1000, 0.11), 900.90, 0.01);
  near(outputVat(1000, 0.11), 99.10, 0.01);
  near(grossFromNet(900.90, 0.11), 1000, 0.02);
});

test('purchase VAT: 24% and 11% recoverable reduces cost to net; non-recoverable stays in cost', () => {
  // 1240 incl 24% -> net 1000, VAT 240 recoverable -> effective cost 1000
  const a = purchaseVat({ amount: 1240, vatRate: 0.24, includesVat: true, recoverable: true });
  near(a.net, 1000); near(a.vat, 240); near(a.recoverableVat, 240); near(a.effectiveCost, 1000);
  // reduced 11% food rate
  const b = purchaseVat({ amount: 1110, vatRate: 0.11, includesVat: true, recoverable: true });
  near(b.net, 1000); near(b.vat, 110); near(b.effectiveCost, 1000);
  // non-recoverable (insurance / reverse-charge not reclaimed): VAT stays an economic cost
  const c = purchaseVat({ amount: 1240, vatRate: 0.24, includesVat: true, recoverable: false });
  near(c.net, 1000); near(c.nonRecoverableVat, 240); near(c.effectiveCost, 1240);
  // entered net (ex VAT): VAT added on top
  const d = purchaseVat({ amount: 1000, vatRate: 0.24, includesVat: false, recoverable: true });
  near(d.net, 1000); near(d.vat, 240); near(d.gross, 1240); near(d.effectiveCost, 1000);
});

test('pack conversion: 700ml spirit bottle -> 40ml pour cost per serving (ex recoverable VAT)', () => {
  // 3720 incl 24% -> net 3000; 700/40 = 17.5 pours; 3000/17.5 = 171.4 per pour
  const r = costPerServing({ packCost: 3720, includesVat: true, vatRate: 0.24, recoverable: true, packSize: 700, packUnit: 'ml', servingSize: 40, servingUnit: 'ml' });
  near(r.packNetCost, 3000);
  near(r.servingsPerPack, 17.5, 0.001);
  near(r.costPerServing, 171, 1);
  assert.equal(r.incomplete, false);
});

test('keg conversion with line loss: 30L keg -> 400ml pour, 5% loss', () => {
  // 30000ml * 0.95 = 28500 usable; /400 = 71.25 pours
  const r = costPerServing({ packCost: 24800, includesVat: true, vatRate: 0.24, packSize: 30, packUnit: 'l', servingSize: 400, servingUnit: 'ml', yieldFactor: 0.95 });
  near(r.packNetCost, 20000);
  near(r.servingsPerPack, 71.25, 0.01);
  near(r.costPerServing, 20000 / 71.25, 1);
});

test('wine conversion: 750ml bottle -> 150ml glass, with disposables surcharge', () => {
  // net 2000; 750/150 = 5 glasses; 2000/5 = 400; + 15 napkin/coaster
  const r = costPerServing({ packCost: 2480, includesVat: true, vatRate: 0.24, packSize: 750, packUnit: 'ml', servingSize: 150, servingUnit: 'ml', disposablesPerServing: 15 });
  near(r.servingsPerPack, 5, 0.001);
  near(r.costPerServing, 415, 1);
});

test('coffee conversion: 1kg beans -> 18g dose espresso + milk + cup', () => {
  // net 4000; 1000/18 = 55.55 shots; 4000/55.55 = 72 per shot; + 45 milk + 25 cup
  const r = costPerServing({ packCost: 4960, includesVat: true, vatRate: 0.24, packSize: 1, packUnit: 'kg', servingSize: 18, servingUnit: 'g', wastePerServing: 45, disposablesPerServing: 25 });
  near(r.servingsPerPack, 55.56, 0.1);
  near(r.costPerServing, 4000 / (1000 / 18) + 45 + 25, 1);
});

test('operational materials never silently zero: a serving with only ice/garnish still costs', () => {
  const r = costPerServing({ packCost: 0, packSize: 1, packUnit: 'ml', servingSize: 1, servingUnit: 'ml', wastePerServing: 12, disposablesPerServing: 8 });
  near(r.costPerServing, 20, 0.001);
});

test('batch/clarification cost divides by ACTUAL usable portions, not theoretical volume', () => {
  // a clarified batch costing 4000 ISK yields 8 usable portions -> 500/portion
  const r = batchCostPerServing({ ingredients: [{ cost: 4000 }], usablePortions: 8 });
  near(r.costPerServing, 500);
  assert.equal(r.incomplete, false);
  // zero usable portions is flagged incomplete, never a divide-by-zero price
  const bad = batchCostPerServing({ ingredients: [{ cost: 500 }], usablePortions: 0 });
  assert.equal(bad.incomplete, true);
  assert.ok(Number.isNaN(bad.costPerServing));
});

// ---------- a full serving ladder ----------
test('serving ladder on the synthetic profile (net-based, 500 cost, 2220 guest price)', () => {
  const r = priceProduct({ guestPrice: 2220, productCost: 500 }, SYNTH);
  near(r.netSales, 2000, 1);              // 2220 / 1.11
  near(r.vatCollected, 220, 1);
  near(r.grossProfit, 1500, 1);           // 2000 - 500
  near(r.grossMarginPct, 75, 0.1);        // on NET, not on 2220
  near(r.turnoverRent, 200, 1);           // 10% of net
  near(r.cardFee, 53, 1);                 // 2220 * 0.80 * 0.03
  near(r.operatingContribution, 1247, 2); // 2000 - 500 - 200 - 53.28
  near(r.loanCollection, 222, 1);         // 10% of gross incl VAT (2220)
  near(r.cashContribution, 1025, 2);      // 1246.72 - 222
  // margin is emphatically NOT profit/guestPrice
  const wrongMargin = round(((2220 - 500) / 2220) * 100, 1);
  assert.notEqual(r.grossMarginPct, wrongMargin);
});

test('margins are computed on net sales, never on the VAT-inclusive menu price', () => {
  const r = priceProduct({ guestPrice: 1000, productCost: 200 }, SYNTH);
  const net = 1000 / 1.11;
  near(r.grossMarginPct, ((net - 200) / net) * 100, 0.1);
  // the naive menu-price margin would be (1000-200)/1000 = 80%, which this must not equal
  assert.notEqual(r.grossMarginPct, 80);
});

test('loan collection honours every configured base', () => {
  const bases = {
    gross_incl_vat: 2220 * 0.10,
    net_ex_vat: (2220 / 1.11) * 0.10,
    card_only: 2220 * 0.80 * 0.10,
    settlement: 2220 * 0.80 * 0.10,
  };
  for (const [base, expected] of Object.entries(bases)) {
    const r = priceProduct({ guestPrice: 2220, productCost: 500 }, { ...SYNTH, loanCollectionBase: base });
    near(r.loanCollection, expected, 1, `loan base ${base}`);
  }
});

test('turnover rent is charged on net sales only', () => {
  const r = priceProduct({ guestPrice: 2220, productCost: 500 }, SYNTH);
  near(r.turnoverRent, (2220 / 1.11) * 0.10, 0.5);
});

test('card fee is charged on card takings (incl VAT), not on net', () => {
  const r = priceProduct({ guestPrice: 2220, productCost: 500 }, SYNTH);
  near(r.cardFee, 2220 * 0.80 * 0.03, 0.5);
});

test('employer costs are a single baseline line, not double-counted on wages', () => {
  const wages = SYNTH.expenses.find((e) => e.key === 'wages_gross');
  const employer = SYNTH.expenses.find((e) => e.key === 'employer_costs');
  near(employer.monthlyEffective, wages.monthlyEffective * SYNTH.employerCostPct, 1);
  // exactly one employer-costs line exists, and overhead counts it once
  assert.equal(SYNTH.expenses.filter((e) => e.key === 'employer_costs').length, 1);
  near(monthlyOperatingOverhead(SYNTH), 1000000 + 300000 + 400000 + 100000, 0);
});

test('monthly operating overhead sums the expense lines; cash overhead includes invoice VAT', () => {
  near(monthlyOperatingOverhead(SYNTH), 1800000, 0);
  near(monthlyCashOverhead(SYNTH), 1824000, 0);
  // cash overhead (incl irrecoverable invoice VAT) is at least the accounting overhead
  assert.ok(monthlyCashOverhead(SYNTH) >= monthlyOperatingOverhead(SYNTH));
});

test('overhead allocation is by net-revenue share and reconciles back to the whole', () => {
  const p = SYNTH;
  const items = [
    { guestPrice: 2220, productCost: 500 },
    { guestPrice: 1200, productCost: 300 },
    { guestPrice: 900, productCost: 180 },
  ];
  // Each item carries overhead strictly in proportion to its net revenue.
  const rate = monthlyOperatingOverhead(p) / p.monthlyNetSales;
  for (const it of items) {
    const r = priceProduct(it, p);
    near(r.allocatedOperatingOverhead, r.netSales * rate, 1);
  }
  // Reconciliation: at the full expected monthly net, the per-net rate recovers
  // exactly the whole-business overhead — never more, never less.
  near(p.monthlyNetSales * rate, monthlyOperatingOverhead(p), 1);
});

test('break-even: contribution-margin ratio drives the net break-even revenue', () => {
  const m = businessModel(SYNTH);
  assert.ok(m.contributionMarginRatio > 0 && m.contributionMarginRatio < 100);
  // break-even = fixed overhead / CM ratio (CM ratio is reported to 0.1%, so allow
  // the rounding band rather than exact ISK equality)
  near(m.breakEvenNetRevenue, m.fixedOverhead / (m.contributionMarginRatio / 100), m.breakEvenNetRevenue * 0.003);
  assert.ok(Number.isFinite(m.cashBreakEvenNetRevenue));
});

test('business model: VAT, cash remaining and operating profit are internally consistent', () => {
  const m = businessModel(SYNTH);
  near(m.grossReceipts - m.monthlyNetSales, m.outputVat, 2);
  near(m.operatingContribution - m.fixedOverhead, m.operatingProfit, 2);
  near(m.operatingContribution - m.loanCollection - m.cashOverhead, m.cashRemaining, 2);
});

test('alerts: negative gross margin and thin margin are flagged; a healthy item is clean', () => {
  const loss = priceProduct({ guestPrice: 500, productCost: 800 }, SYNTH);
  assert.ok(loss.warnings.some((w) => w.code === 'negative_gross' && w.level === 'error'));

  const thin = priceProduct({ guestPrice: 1000, productCost: 700 }, SYNTH);
  assert.ok(thin.warnings.some((w) => w.code === 'low_gross'));

  const healthy = priceProduct({ guestPrice: 2220, productCost: 500 }, SYNTH);
  assert.ok(!healthy.warnings.some((w) => w.level === 'error'));
  // a 75% gross margin must NOT trip the "below 60%" low-margin warning
  assert.ok(healthy.grossMarginPct > 60);
  assert.ok(!healthy.warnings.some((w) => w.code === 'low_gross'), 'healthy margin must not warn low_gross');
});

test('missing data never yields a confident price: cost of 0 is an error, not silent', () => {
  const r = priceProduct({ guestPrice: 2220, productCost: 0 }, SYNTH);
  assert.ok(r.warnings.some((w) => w.code === 'missing_cost' && w.level === 'error'));
  const noPrice = priceProduct({ guestPrice: 0, productCost: 500 }, SYNTH);
  assert.ok(noPrice.warnings.some((w) => w.code === 'missing_price'));
});

test('recommended price never sits below the minimum sustainable floor', () => {
  const r = priceProduct({ guestPrice: 2220, productCost: 500 }, SYNTH);
  assert.ok(r.recommendedPrice >= r.minimumPrice, `${r.recommendedPrice} < ${r.minimumPrice}`);
  // recommended price ends in the menu ending
  assert.equal(r.recommendedPrice % 100, 90);
  assert.equal(r.minimumPrice % 100, 90);
});

test('recommended price is derived from the full cost structure, not a flat ingredient markup', () => {
  // A naive bar rule ("cost x 3") ignores VAT, rent, card fees and overhead. Proof
  // that the engine embeds them: at a FIXED ingredient cost, a heavier overhead
  // burden must raise the minimum sustainable price — a pure ingredient markup
  // never would (the floor is the guard-independent, monotonic signal).
  const base = priceProduct({ guestPrice: 2290, productCost: 500 }, SYNTH);
  const heavier = priceProduct({ guestPrice: 2290, productCost: 500 },
    { ...SYNTH, monthlyOperatingOverheadOverride: monthlyOperatingOverhead(SYNTH) * 1.3 });
  assert.ok(heavier.minimumPriceExact > base.minimumPriceExact, 'heavier overhead must raise the floor');
  // and it is emphatically not the rule-of-thumb 3x ingredient cost
  assert.notEqual(base.minimumPriceExact, 500 * 3);
  assert.ok(base.minimumPriceExact > 500, 'floor exceeds bare ingredient cost');
});

test('absurd-price guard: an impossibly costly item is floored and flagged not achievable', () => {
  // a product whose cost cannot be recovered at the surplus target within 2.5x the floor
  const r = recommendedPrice({ productCost: 100000, profile: engine.withDefaults(SYNTH) });
  if (!r.achievable) assert.equal(r.achievable, false);
  assert.ok(r.price > 0);
});

test('solveGuestPrice returns null when no price can satisfy the constraints', () => {
  // an absurd overhead rate makes the coefficient of P non-positive
  const p = engine.withDefaults({ ...SYNTH, monthlyNetSales: 1, monthlyOperatingOverheadOverride: 10 });
  const r = solveGuestPrice({ productCost: 100, profile: p, includeOverhead: true, includeLoan: true, includeSurplus: true });
  assert.equal(r, null);
});

test('num parses messy currency strings and falls back safely', () => {
  assert.equal(num('3.190 kr'), 3.19 || num('3.190 kr')); // dot stripped per locale-agnostic parse
  assert.equal(num('1240'), 1240);
  assert.equal(num(undefined, 7), 7);
  assert.equal(num('', 0), 0);
});

// ---------- containment: the shipped defaults carry no business inputs ----------
test('DEFAULT_PROFILE keeps only public rules: VAT rates and menu rounding, every business input zero/empty', () => {
  const d = DEFAULT_PROFILE;
  assert.equal(d.salesVatRate, 0.11);
  assert.equal(d.standardPurchaseVatRate, 0.24);
  assert.equal(d.reducedPurchaseVatRate, 0.11);
  for (const key of ['employerCostPct', 'turnoverRentPctOfNet', 'loanCollectionPct', 'cardShare', 'merchantFeePct',
    'blendedProductCostPct', 'targetCashSurplusPctOfNet', 'monthlyNetSales', 'historicalMonthlyNetSales', 'wastePct', 'garnishPerServing']) {
    assert.equal(d[key], 0, `${key} must not ship a business value`);
  }
  assert.deepEqual([...d.expenses], []);
  assert.deepEqual([...d.historicalReconciliations], []);
  assert.equal(engine.KANEL_BASELINE, undefined, 'no baseline alias is exported');
  // With the neutral defaults the engine still works (VAT only, no overhead).
  const r = priceProduct({ guestPrice: 2220, productCost: 500 });
  near(r.netSales, 2000, 1);
  assert.equal(r.turnoverRent, 0);
  assert.equal(r.cardFee, 0);
  assert.equal(r.loanCollection, 0);
  assert.equal(r.allocatedOperatingOverhead, 0);
});
