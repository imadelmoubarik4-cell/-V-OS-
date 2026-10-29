/*
 * KANEL Pricing & Profitability — canonical calculation engine (one source of truth).
 *
 * Pure, dependency-free, decimal-safe. Runs in the browser (window.KanelPricing)
 * and in Node (module.exports) so the UI and the test suite share identical maths.
 *
 * Design rules (from the KANEL spec):
 *  - Financial margins are computed on NET sales (revenue excluding output VAT),
 *    never on the VAT-inclusive guest price. Icelandic served F&B menu prices
 *    include 11% VAT, so margin-on-menu-price overstates profit.
 *  - Operational materials (ice, garnish, cups, disposables) carry real costs;
 *    nothing is silently treated as zero.
 *  - The loan collection is a FINANCING cash outflow, separated from operating
 *    costs. Its base is configurable (gross incl VAT / net ex VAT / card only / settlement).
 *  - Monthly overhead is allocated across the expected sales mix and reconciles back
 *    to the whole-business overhead; it is never charged 100% to every product.
 *  - All figures ISK unless stated. Currency outputs are rounded half-up to whole ISK
 *    at posting boundaries; intermediate maths keeps full precision.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KanelPricing = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  // ---------- decimal-safe money ----------

  // Round half away from zero to whole ISK, correcting binary-float drift.
  // 0.5 -> 1, 2.5 -> 3, -0.5 -> -1. The 1e-9 nudge rescues values that binary
  // floating point stores just under a .5 boundary (e.g. 2.4999999996 for 2.5).
  function roundIsk(value) {
    if (!Number.isFinite(value)) return NaN;
    const sign = value >= 0 ? 1 : -1;
    return sign * Math.floor(Math.abs(value) + 0.5 + 1e-9);
  }
  // Round to n decimals, float-drift safe.
  function round(value, places = 2) {
    if (!Number.isFinite(value)) return NaN;
    const f = Math.pow(10, places);
    return Math.round((value * f) + (value >= 0 ? 1e-6 : -1e-6)) / f;
  }
  function num(value, fallback = 0) {
    const n = typeof value === 'string' ? Number(value.replace(/[^0-9.+-]/g, '')) : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  // Menu-friendly rounding to an ending (e.g. 90): round to the nearest N0 ending,
  // but NEVER below the floor — if rounding down would breach it, round up.
  function roundToMenuEnding(value, ending = 90, step = 100) {
    if (!Number.isFinite(value)) return NaN;
    const base = Math.floor(value / step) * step;
    let candidate = base + ending;
    if (candidate < value) candidate += step;      // ending below value -> next band
    return candidate;
  }

  // ---------- VAT ----------

  // Net (ex-VAT) revenue from a VAT-inclusive guest price. (Formula A)
  function netFromGross(grossPrice, vatRate) {
    return num(grossPrice) / (1 + num(vatRate));
  }
  function grossFromNet(netPrice, vatRate) {
    return num(netPrice) * (1 + num(vatRate));
  }
  function outputVat(grossPrice, vatRate) {
    const g = num(grossPrice);
    return g - g / (1 + num(vatRate));
  }
  // Split a supplier amount into net + VAT, whether the amount is entered gross or net.
  // recoverable=false (e.g. insurance, some foreign/reverse-charge) keeps VAT in cost.
  function purchaseVat({ amount, vatRate = 0.24, includesVat = true, recoverable = true } = {}) {
    const a = num(amount);
    const rate = num(vatRate);
    const net = includesVat ? a / (1 + rate) : a;
    const vat = includesVat ? a - net : a * rate;
    const gross = net + vat;
    const recoverableVat = recoverable ? vat : 0;
    const nonRecoverableVat = recoverable ? 0 : vat;
    return {
      net: round(net), vat: round(vat), gross: round(gross),
      recoverableVat: round(recoverableVat), nonRecoverableVat: round(nonRecoverableVat),
      // Economic cost = net + any VAT you cannot reclaim.
      effectiveCost: round(net + nonRecoverableVat)
    };
  }

  // ---------- portion / pack conversions ----------

  const ML = { ml: 1, cl: 10, l: 1000, litre: 1000, liter: 1000 };
  const G = { g: 1, kg: 1000, gram: 1, grams: 1 };

  // Cost per serving from a pack/bottle price. Handles bottle->pour, keg->pour,
  // wine bottle->glass, with yield loss (keg line loss, wine wastage, prep loss).
  function costPerServing({
    packCost,                 // price of the pack/bottle/keg (as entered)
    includesVat = false, vatRate = 0.24, recoverable = true,
    packSize, packUnit = 'ml',// size of the pack in packUnit (e.g. 700 ml, 30000 ml keg, 1000 g)
    servingSize,              // size of one serving in the same measure family
    servingUnit = 'ml',
    unitsPerPack = 1,         // e.g. items per case
    yieldFactor = 1,          // usable fraction after losses (0.95 = 5% loss)
    wastePerServing = 0,      // extra direct waste cost already in ISK per serving
    disposablesPerServing = 0 // cup, lid, straw, napkin, etc. ISK per serving
  } = {}) {
    const v = purchaseVat({ amount: packCost, vatRate, includesVat, recoverable });
    const toBase = (q, u) => {
      const key = String(u || '').toLowerCase();
      if (ML[key]) return num(q) * ML[key];
      if (G[key]) return num(q) * G[key];
      return num(q); // count / items
    };
    const packBase = toBase(packSize, packUnit) * num(unitsPerPack, 1);
    const servingBase = toBase(servingSize, servingUnit);
    const usableBase = packBase * num(yieldFactor, 1);
    const servingsPerPack = servingBase > 0 ? usableBase / servingBase : num(unitsPerPack, 1) * num(yieldFactor, 1);
    const costPerServeRaw = servingsPerPack > 0 ? v.effectiveCost / servingsPerPack : NaN;
    const effective = num(costPerServeRaw, 0) + num(wastePerServing) + num(disposablesPerServing);
    return {
      packNetCost: v.net,
      packEffectiveCost: v.effectiveCost,
      recoverableVat: v.recoverableVat,
      nonRecoverableVat: v.nonRecoverableVat,
      servingsPerPack: round(servingsPerPack, 4),
      costPerServing: round(effective),
      incomplete: !(servingsPerPack > 0)
    };
  }

  // Batch / clarification cost: total prep cost / ACTUAL usable portions (not theoretical).
  // E.g. LIE loses liquid in milk clarification; lost liquid still costs every usable serving.
  function batchCostPerServing({ ingredients = [], usablePortions } = {}) {
    const totalCost = ingredients.reduce((sum, ing) => sum + num(ing.cost), 0);
    const portions = num(usablePortions);
    return {
      totalBatchCost: round(totalCost),
      usablePortions: portions,
      costPerServing: portions > 0 ? round(totalCost / portions) : NaN,
      incomplete: !(portions > 0)
    };
  }

  // ---------- the pricing ladder for one product (formulas A..N) ----------

  /*
   * priceProduct({ guestPrice, productCost, profile, overrides })
   * productCost = effective direct cost per finished serving (ingredients ex-recoverable-VAT
   *               + non-recoverable VAT + landed + waste + prep loss + direct disposables).
   */
  function priceProduct(input = {}, profile = DEFAULT_PROFILE) {
    const p = withDefaults(profile);
    const guestPrice = num(input.guestPrice);
    const salesVat = num(input.salesVatRate, p.salesVatRate);
    const productCost = num(input.productCost);

    // A. net sales (ex output VAT)
    const netSales = netFromGross(guestPrice, salesVat);
    const vatCollected = guestPrice - netSales;

    // C/D/E. raw cost %, gross profit, raw gross margin
    const grossProfit = netSales - productCost;
    const rawCostPct = netSales > 0 ? productCost / netSales : NaN;
    const grossMarginPct = netSales > 0 ? grossProfit / netSales : NaN;

    // F. variable selling costs
    const turnoverRent = netSales * p.turnoverRentPctOfNet;          // on net sales
    const cardFee = guestPrice * p.cardShare * p.merchantFeePct;     // on card takings (incl VAT)
    const packaging = num(input.packagingPerServing, 0);
    const variableLabor = num(input.variableLaborPerServing, 0);
    const variableSelling = turnoverRent + cardFee + packaging + variableLabor;

    // G. operating contribution before financing
    const operatingContribution = netSales - productCost - variableSelling;

    // H. loan collection (financing cash outflow) on the configured base
    const loanBaseAmount = loanBase(p.loanCollectionBase, { guestPrice, netSales, cardTakings: guestPrice * p.cardShare });
    const loanCollection = loanBaseAmount * p.loanCollectionPct;

    // I. cash contribution before fixed overhead
    const cashContribution = operatingContribution - loanCollection;

    // J. allocated operating + cash overhead (net-revenue share allocation, reconciles to whole)
    const opOverheadRate = p.monthlyNetSales > 0 ? monthlyOperatingOverhead(p) / p.monthlyNetSales : 0;
    const cashOverheadRate = p.monthlyNetSales > 0 ? monthlyCashOverhead(p) / p.monthlyNetSales : 0;
    const allocatedOperatingOverhead = netSales * opOverheadRate;
    const allocatedCashOverhead = netSales * cashOverheadRate;

    // K. allocated operating profit (finance interest handled in non-operating section)
    const allocatedOperatingProfit = operatingContribution - allocatedOperatingOverhead;

    // L. fully allocated cash contribution (overhead cash + financing already via loan)
    const allocatedCashContribution = cashContribution - allocatedCashOverhead;

    // minimum sustainable price: covers product + variable selling + allocated OPERATING overhead
    const minimumPrice = solveGuestPrice({ productCost, targetNetMarginOfNet: 0, profile: p, includeOverhead: true, includeLoan: false, includeSurplus: false });
    // recommended price: hits the business cash-surplus target (a share of net), guarded against absurdity
    const rec = recommendedPrice({ productCost, profile: p });

    return {
      inputs: { guestPrice: roundIsk(guestPrice), salesVatRate: salesVat, productCost: roundIsk(productCost) },
      netSales: roundIsk(netSales),
      vatCollected: roundIsk(vatCollected),
      grossProfit: roundIsk(grossProfit),
      rawCostPct: round(rawCostPct * 100, 1),
      grossMarginPct: round(grossMarginPct * 100, 1),
      turnoverRent: roundIsk(turnoverRent),
      cardFee: roundIsk(cardFee),
      variableSelling: roundIsk(variableSelling),
      operatingContribution: roundIsk(operatingContribution),
      loanCollection: roundIsk(loanCollection),
      loanBase: p.loanCollectionBase,
      cashContribution: roundIsk(cashContribution),
      allocatedOperatingOverhead: roundIsk(allocatedOperatingOverhead),
      allocatedOperatingProfit: roundIsk(allocatedOperatingProfit),
      allocatedOperatingProfitPct: netSales > 0 ? round((allocatedOperatingProfit / netSales) * 100, 1) : NaN,
      allocatedCashOverhead: roundIsk(allocatedCashOverhead),
      allocatedCashContribution: roundIsk(allocatedCashContribution),
      minimumPrice: minimumPrice != null ? roundToMenuEnding(minimumPrice, p.menuEnding, p.menuStep) : null,
      minimumPriceExact: minimumPrice != null ? roundIsk(minimumPrice) : null,
      recommendedPrice: rec.price,
      recommendedPriceExact: rec.exact,
      recommendedAchievable: rec.achievable,
      warnings: productWarnings({ productCost, netSales, grossMargin: grossMarginPct, allocatedOperatingProfit, allocatedCashContribution, guestPrice, minimumPrice, p })
    };
  }

  function loanBase(kind, { guestPrice, netSales, cardTakings }) {
    switch (kind) {
      case 'net_ex_vat': return netSales;
      case 'card_only': return cardTakings;
      case 'settlement': return cardTakings; // until provider settlement deductions are wired
      case 'gross_incl_vat':
      default: return guestPrice;
    }
  }

  // `grossMargin` here is a FRACTION (e.g. 0.78), consistent with the engine's
  // internal ratios — not a 0–100 percentage.
  function productWarnings({ productCost, netSales, grossMargin, allocatedOperatingProfit, allocatedCashContribution, guestPrice, minimumPrice, p }) {
    const w = [];
    if (!(productCost > 0)) w.push({ level: 'error', code: 'missing_cost', text: 'No product cost — cannot price reliably.' });
    if (!(guestPrice > 0)) w.push({ level: 'error', code: 'missing_price', text: 'No guest price entered.' });
    if (Number.isFinite(grossMargin) && grossMargin < 0) w.push({ level: 'error', code: 'negative_gross', text: 'Negative gross margin — price is below ingredient cost.' });
    else if (Number.isFinite(grossMargin) && grossMargin < p.lowGrossMarginPct) w.push({ level: 'warn', code: 'low_gross', text: `Gross margin below ${Math.round(p.lowGrossMarginPct * 100)}%.` });
    if (Number.isFinite(allocatedOperatingProfit) && allocatedOperatingProfit < 0) w.push({ level: 'warn', code: 'below_allocated_overhead', text: 'Price does not cover this item’s share of operating overhead.' });
    if (Number.isFinite(allocatedCashContribution) && allocatedCashContribution < 0) w.push({ level: 'warn', code: 'cash_negative', text: 'After loan collection and cash overhead, this item is cash-negative.' });
    if (minimumPrice != null && guestPrice > 0 && guestPrice < minimumPrice) w.push({ level: 'warn', code: 'below_minimum', text: 'Guest price is below the minimum sustainable price.' });
    return w;
  }

  // Solve the guest price P that leaves (allocated operating profit or cash) == target.
  // Linear in P, so solved directly rather than iterated.
  function solveGuestPrice({ productCost, targetNetMarginOfNet = 0, profile, includeOverhead = true, includeLoan = false, includeSurplus = false }) {
    const p = profile;
    const vat = p.salesVatRate;
    const inv = 1 / (1 + vat);                       // net = P * inv
    const opRate = includeOverhead && p.monthlyNetSales > 0 ? monthlyOperatingOverhead(p) / p.monthlyNetSales : 0;
    const surplus = includeSurplus ? p.targetCashSurplusPctOfNet : 0;
    // net - cost - rent*net - card*P - [overhead*net] - [loan*loanfactor*P] - [surplus*net] - target*net = 0
    // Only gross/card loan base is linear in P here; for net base fold into net terms.
    let loanOnP = 0, loanOnNet = 0;
    if (includeLoan) {
      if (p.loanCollectionBase === 'net_ex_vat') loanOnNet = p.loanCollectionPct;
      else if (p.loanCollectionBase === 'card_only' || p.loanCollectionBase === 'settlement') loanOnP = p.loanCollectionPct * p.cardShare;
      else loanOnP = p.loanCollectionPct; // gross incl vat
    }
    // Coefficient of P:
    const coeffP = inv * (1 - p.turnoverRentPctOfNet - opRate - surplus - targetNetMarginOfNet - loanOnNet)
      - (p.cardShare * p.merchantFeePct) - loanOnP;
    if (!(coeffP > 0)) return null; // unsolvable at any realistic price
    return productCost / coeffP;
  }

  function recommendedPrice({ productCost, profile }) {
    const p = profile;
    // Price to hit the business cash-surplus target (a share of net) after overhead + loan.
    const target = solveGuestPrice({ productCost, profile: p, includeOverhead: true, includeLoan: true, includeSurplus: true });
    // Floor: minimum sustainable (operating break-even for the item).
    const floor = solveGuestPrice({ productCost, profile: p, includeOverhead: true, includeLoan: false, includeSurplus: false });
    if (target == null) {
      return { price: floor != null ? roundToMenuEnding(floor, p.menuEnding, p.menuStep) : null, exact: floor != null ? roundIsk(floor) : null, achievable: false };
    }
    const absurd = floor != null && target > floor * p.absurdPriceMultiple;
    const chosen = absurd ? floor : target;
    return {
      price: roundToMenuEnding(chosen, p.menuEnding, p.menuStep),
      exact: roundIsk(chosen),
      achievable: !absurd
    };
  }

  // ---------- whole-business model ----------

  function monthlyOperatingOverhead(profile) {
    const p = withDefaults(profile);
    if (Number.isFinite(p.monthlyOperatingOverheadOverride)) return p.monthlyOperatingOverheadOverride;
    return (p.expenses || []).reduce((sum, e) => sum + num(e.monthlyEffective, 0), 0);
  }
  function monthlyCashOverhead(profile) {
    const p = withDefaults(profile);
    if (Number.isFinite(p.monthlyCashOverheadOverride)) return p.monthlyCashOverheadOverride;
    return (p.expenses || []).reduce((sum, e) => sum + num(e.monthlyCash, e.monthlyEffective || 0), 0);
  }

  // M. break-even on the expected mix.
  function businessModel(profile = DEFAULT_PROFILE, scenario = {}) {
    const p = withDefaults(profile);
    const netSales = num(scenario.monthlyNetSales, p.monthlyNetSales);
    const grossReceipts = grossFromNet(netSales, p.salesVatRate);
    const productCostPct = num(scenario.blendedProductCostPct, p.blendedProductCostPct);
    const productCost = netSales * productCostPct;
    const turnoverRent = netSales * p.turnoverRentPctOfNet;
    const cardFees = grossReceipts * p.cardShare * p.merchantFeePct;
    const variableSelling = turnoverRent + cardFees;
    const fixedOverhead = monthlyOperatingOverhead(p);
    const cashOverhead = monthlyCashOverhead(p);
    const operatingContribution = netSales - productCost - variableSelling;
    const operatingProfit = operatingContribution - fixedOverhead;
    // loan collection (financing)
    const loanBaseAmount = loanBase(p.loanCollectionBase, { guestPrice: grossReceipts, netSales, cardTakings: grossReceipts * p.cardShare });
    const loanCollection = loanBaseAmount * p.loanCollectionPct;
    const cashAfterLoan = operatingContribution - loanCollection;
    const cashAfterOverhead = cashAfterLoan - cashOverhead;
    // contribution margin ratio for break-even (operating, excludes financing)
    const contributionMarginRatio = (netSales - productCost - variableSelling) / netSales;
    const breakEvenNet = contributionMarginRatio > 0 ? fixedOverhead / contributionMarginRatio : NaN;
    // cash break-even additionally must service the loan collection (as a % of net-equivalent base)
    const loanRatioOfNet = netSales > 0 ? loanCollection / netSales : 0;
    const cashMarginRatio = contributionMarginRatio - loanRatioOfNet;
    const cashBreakEvenNet = cashMarginRatio > 0 ? cashOverhead / cashMarginRatio : NaN;
    return {
      monthlyNetSales: roundIsk(netSales),
      grossReceipts: roundIsk(grossReceipts),
      outputVat: roundIsk(grossReceipts - netSales),
      productCost: roundIsk(productCost),
      turnoverRent: roundIsk(turnoverRent),
      cardFees: roundIsk(cardFees),
      variableSelling: roundIsk(variableSelling),
      fixedOverhead: roundIsk(fixedOverhead),
      cashOverhead: roundIsk(cashOverhead),
      operatingContribution: roundIsk(operatingContribution),
      operatingProfit: roundIsk(operatingProfit),
      operatingProfitPct: round((operatingProfit / netSales) * 100, 1),
      loanCollection: roundIsk(loanCollection),
      cashAfterLoan: roundIsk(cashAfterLoan),
      cashRemaining: roundIsk(cashAfterOverhead),
      contributionMarginRatio: round(contributionMarginRatio * 100, 1),
      breakEvenNetRevenue: roundIsk(breakEvenNet),
      breakEvenPctOfPlan: Number.isFinite(breakEvenNet) ? round((breakEvenNet / netSales) * 100, 1) : NaN,
      cashBreakEvenNetRevenue: roundIsk(cashBreakEvenNet),
      covered: operatingProfit >= 0,
      cashCovered: cashAfterOverhead >= 0
    };
  }

  function scenarioLaunch(profile = DEFAULT_PROFILE) {
    const p = withDefaults(profile);
    // Launch planning: 10% more units, 15% higher realized average price.
    const net = p.monthlyNetSales * 1.10 * 1.15;
    return businessModel(p, { monthlyNetSales: net });
  }

  // ---------- profile ----------

  function withDefaults(profile) {
    if (profile && profile.__normalized) return profile;
    const p = Object.assign({}, DEFAULT_PROFILE, profile || {});
    p.__normalized = true;
    return p;
  }

  if (typeof module !== 'undefined' && module.exports) {
    // expose internals for tests
    module.exports.__internals = { roundIsk, round, roundToMenuEnding, netFromGross, outputVat, purchaseVat, costPerServing, batchCostPerServing, monthlyOperatingOverhead, monthlyCashOverhead, solveGuestPrice };
  }

  // The engine object (DEFAULT_PROFILE attached after its definition below).
  var engine = {
    version: '1.0.0',
    roundIsk, round, num, roundToMenuEnding,
    netFromGross, grossFromNet, outputVat, purchaseVat,
    costPerServing, batchCostPerServing,
    priceProduct, recommendedPrice, solveGuestPrice,
    businessModel, scenarioLaunch,
    monthlyOperatingOverhead, monthlyCashOverhead,
    withDefaults
  };

  // ---------- neutral defaults ----------
  // Only public rules live here: the Icelandic VAT rates and the menu rounding.
  // Every business input (rates, sales, expenses) is zero/empty until a manager-
  // authorised server profile supplies it; no business figures ship to the browser.
  var DEFAULT_PROFILE = {
    currency: 'ISK',
    salesVatRate: 0.11,                 // served F&B
    standardPurchaseVatRate: 0.24,
    reducedPurchaseVatRate: 0.11,
    employerCostPct: 0,
    turnoverRentPctOfNet: 0,
    loanCollectionPct: 0,
    loanCollectionBase: 'gross_incl_vat',
    cardShare: 0,
    merchantFeePct: 0,
    blendedProductCostPct: 0,
    targetCashSurplusPctOfNet: 0,
    monthlyNetSales: 0,                 // overhead denominator; 0 = no overhead allocation
    historicalMonthlyNetSales: 0,
    wastePct: 0,
    garnishPerServing: 0,
    menuEnding: 90, menuStep: 100,      // round recommended prices up to xx90
    lowGrossMarginPct: 0.60,
    absurdPriceMultiple: 2.5,           // flag "recommended" if > 2.5x the floor
    expenses: [],
    historicalReconciliations: []
  };

  engine.DEFAULT_PROFILE = DEFAULT_PROFILE;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.DEFAULT_PROFILE = DEFAULT_PROFILE;
    Object.assign(module.exports, engine);
  }
  return engine;
});
