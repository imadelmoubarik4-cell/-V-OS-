(function(root) {
  'use strict';

  // Pre-S84 compatibility only; the database decides which workflows create evidence.
  const LEGACY_OWNER_TYPES = new Set(['owner_confirmed', 'owner_confirmed_supplier_price', 'owner_confirmed_prep', 'owner_verified_count']);
  const DEFAULT_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function millis(value) {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function known(item) {
    return item?.freshness_state === 'current' && item.verified_quantity != null
      && item.verified_quantity !== '' && Number.isFinite(Number(item.verified_quantity));
  }

  function managerBaseline(balance, nowMillis) {
    if (!balance || typeof balance !== 'object') return null;
    const state = String(balance.freshness_state || balance.verification_status || '').toLowerCase();
    const quantity = numberOrNull(balance.verified_quantity);
    const verifiedAt = millis(balance.verified_at);
    const expiresAt = millis(balance.expires_at);
    if (state !== 'current' || quantity === null) return null;
    if (balance.expires_at && expiresAt === null) return null;
    if (expiresAt !== null && expiresAt <= nowMillis) return null;
    return {
      quantity,
      at: verifiedAt ?? 0,
      expiresAt,
      recountDueAt: expiresAt,
      source: 'manager_verified_count'
    };
  }

  function has(item, key) {
    return Boolean(item) && Object.prototype.hasOwnProperty.call(item, key);
  }

  // Owner confirmation evidence. The database writes source_confirmed_* only
  // for trusted owner workflows, so present evidence is trusted as-is; the
  // staff catalogue carries the same evidence as owner_confirmed_*. Rows read
  // before the S84 columns exist fall back to the legacy source_type rule.
  function ownerConfirmation(item) {
    if (has(item, 'source_confirmed_at') || has(item, 'source_confirmed_quantity')) {
      return { quantity: numberOrNull(item.source_confirmed_quantity), at: millis(item.source_confirmed_at) };
    }
    if (has(item, 'owner_confirmed_at') || has(item, 'owner_confirmed_quantity')) {
      return { quantity: numberOrNull(item.owner_confirmed_quantity), at: millis(item.owner_confirmed_at) };
    }
    const sourceType = String(item?.source_type || '').toLowerCase();
    if (!LEGACY_OWNER_TYPES.has(sourceType) || Number(item?.source_confidence) !== 100) return null;
    return { quantity: numberOrNull(item.quantity), at: millis(item.updated_at) };
  }

  function ownerBaseline(item, balance) {
    const confirmation = ownerConfirmation(item);
    if (!confirmation || confirmation.quantity === null || confirmation.quantity < 0 || confirmation.at === null) return null;

    // Any recorded manager count at or after the confirmation supersedes it,
    // including one that has since expired or been revoked.
    const balanceAt = millis(balance?.verified_at);
    if (balanceAt !== null && confirmation.at <= balanceAt) return null;

    // Owner confirmations do not expire; after the count freshness window they
    // stay authoritative (plus audited movements) and are flagged for recount.
    const balanceExpires = millis(balance?.expires_at);
    const freshnessWindow = balanceAt !== null && balanceExpires !== null && balanceExpires > balanceAt
      ? balanceExpires - balanceAt
      : DEFAULT_FRESHNESS_MS;

    return {
      quantity: confirmation.quantity,
      at: confirmation.at,
      expiresAt: null,
      recountDueAt: confirmation.at + freshnessWindow,
      source: 'owner_confirmed'
    };
  }

  function movementDelta(movements, itemId, afterMillis, nowMillis) {
    return (movements || []).reduce((sum, movement) => {
      if (movement?.item_id !== itemId) return sum;
      if (String(movement?.movement_type || '').toLowerCase() === 'count') return sum;
      const createdAt = millis(movement?.created_at);
      const delta = numberOrNull(movement?.quantity_change);
      if (createdAt === null || delta === null || createdAt <= afterMillis || createdAt > nowMillis) return sum;
      return sum + delta;
    }, 0);
  }

  function effectiveStock(item, balance, movements = [], nowMillis = Date.now()) {
    const manager = managerBaseline(balance, nowMillis);
    const owner = ownerBaseline(item, balance);
    const baseline = owner && (!manager || owner.at > manager.at) ? owner : manager;
    if (!baseline) return null;

    const delta = movementDelta(movements, item.id, baseline.at, nowMillis);
    return {
      quantity: Math.max(0, baseline.quantity + delta),
      baselineAt: baseline.at,
      expiresAt: baseline.expiresAt,
      source: baseline.source,
      movementDelta: delta,
      recountDue: baseline.recountDueAt !== null && baseline.recountDueAt !== undefined && baseline.recountDueAt <= nowMillis
    };
  }

  function project(items, balances, movements = [], nowMillis = Date.now()) {
    const byId = new Map((balances || []).map(balance => [balance.inventory_item_id, balance]));
    return (items || []).map(item => {
      const evidence = effectiveStock(item, byId.get(item.id), movements, nowMillis);
      return {
        ...item,
        quantity: evidence ? evidence.quantity : null,
        verified_quantity: evidence ? evidence.quantity : null,
        freshness_state: evidence ? 'current' : 'unknown',
        stock_source: evidence?.source || null,
        stock_baseline_at: evidence?.baselineAt || null,
        stock_movement_delta: evidence?.movementDelta || 0,
        stock_recount_due: evidence?.recountDue === true
      };
    });
  }

  // The par test: verified stock strictly under a positive par level (an
  // item exactly at par is not under par). True for an out item that has a
  // par. Summaries and pills use stockStatus below, which reports out and
  // below par separately.
  function belowPar(item) {
    if (!known(item)) return false;
    const par = numberOrNull(item.par_level);
    const quantity = numberOrNull(item.verified_quantity ?? item.quantity);
    return par !== null && par > 0 && quantity !== null && quantity < par;
  }

  // ---------------------------------------------------------------------------
  // S89 canonical business truth. One rule per question, ported line for line
  // to supabase/functions/_shared/stock-provenance.mjs (stockStatus, hasCost,
  // purchaseReceiptAmount) and atlas-domain.mjs (inventoryValue, purchaseSpend)
  // and parity-tested in tests/node/canonical-truth-s89.test.js. Change both.
  // ---------------------------------------------------------------------------

  // The one stock status. Precedence, first match wins:
  //   'unknown'   no current verified quantity (never counted, expired, stale);
  //   'out'       known and quantity <= 0, with or without a par level;
  //   'below_par' known, par > 0 and quantity strictly under par;
  //   'no_par'    known, quantity > 0 and no positive par (cannot be judged low);
  //   'ok'        known and at or above a positive par.
  // Summaries report 'below_par' and 'out' as separate counts (an out item is
  // never also counted as below par). "Needs ordering" = out + below_par.
  const STOCK_STATUSES = Object.freeze(['unknown', 'out', 'below_par', 'no_par', 'ok']);

  function stockStatus(item) {
    if (!known(item)) return 'unknown';
    const quantity = numberOrNull(item.verified_quantity ?? item.quantity) ?? 0;
    if (quantity <= 0) return 'out';
    const par = numberOrNull(item.par_level);
    if (par === null || par <= 0) return 'no_par';
    return quantity < par ? 'below_par' : 'ok';
  }

  // Why stockStatus() is 'unknown' (null when it is not). An item whose stock
  // was withheld because the shell's inputs (verified balances or movements)
  // failed to load carries stock_unknown_reason 'stock_data_incomplete'; any
  // other unknown item has simply not been counted (or its count expired).
  const INCOMPLETE = 'stock_data_incomplete';
  function unknownReason(item) {
    if (stockStatus(item) !== 'unknown') return null;
    return item?.stock_unknown_reason === INCOMPLETE ? INCOMPLETE : 'not_counted';
  }

  // Withholds stock when its inputs are incomplete: every item becomes
  // unknown with reason 'stock_data_incomplete' instead of a projection from
  // stale counts or no balances (index.html loadItems, AtlasData.health()).
  function withhold(items, reason = INCOMPLETE) {
    return (items || []).map((item) => ({
      ...item, quantity: null, verified_quantity: null, freshness_state: 'unknown', stock_source: null,
      stock_baseline_at: null, stock_movement_delta: 0, stock_recount_due: false, stock_unknown_reason: reason
    }));
  }

  function needsOrdering(item) {
    const status = stockStatus(item);
    return status === 'out' || status === 'below_par';
  }

  // Counts for a list of items (inactive rows are records, not stock).
  function stockCounts(items) {
    const counts = { active: 0, known: 0, unknown: 0, out: 0, below_par: 0, no_par: 0, ok: 0, needs_ordering: 0 };
    for (const item of items || []) {
      if (!item || item.active === false) continue;
      const status = stockStatus(item);
      counts.active += 1;
      counts[status] += 1;
      if (status !== 'unknown') counts.known += 1;
      if (status === 'out' || status === 'below_par') counts.needs_ordering += 1;
    }
    return counts;
  }

  // A usable inventory cost is a finite cost_price above zero. Null, zero,
  // negative or non-numeric cost is "missing cost" everywhere (recipe cost,
  // stock value, order estimates, Reports, Atlas AI).
  function hasCost(item) {
    const cost = numberOrNull(item?.cost_price);
    return cost !== null && cost > 0;
  }

  // Stock value: null (unknown) unless every active item is counted AND
  // costed; known_value is the lower bound over counted, costed items (null
  // when there are none), with the counts of what is missing.
  function inventoryValue(items) {
    const active = (items || []).filter((item) => item && item.active !== false);
    let knownValue = null;
    let unknownItems = 0;
    let missingCostItems = 0;
    for (const item of active) {
      const counted = known(item);
      const costed = hasCost(item);
      if (!counted) unknownItems += 1;
      if (!costed) missingCostItems += 1;
      if (counted && costed) knownValue = (knownValue ?? 0) + Math.max(0, numberOrNull(item.quantity) ?? 0) * Number(item.cost_price);
    }
    const complete = unknownItems === 0 && missingCostItems === 0;
    return {
      value: complete ? (knownValue ?? 0) : null,
      complete,
      known_value: knownValue,
      active_items: active.length,
      unknown_items: unknownItems,
      missing_cost_items: missingCostItems
    };
  }

  // Purchasing spend is costed purchase receipts. The receiving path posts
  // 'restock' (public.adjust_inventory); the other names are accepted for
  // imported history. Only positive quantities are receipts; waste, sales,
  // counts, transfers and adjustments are never spend. The amount is
  // total_cost when positive, else unit_cost x quantity when unit_cost is
  // positive; otherwise the receipt is uncosted (counted, not added).
  const PURCHASE_RECEIPT_TYPES = Object.freeze(['restock', 'purchase', 'delivery', 'receive', 'receipt']);

  function purchaseReceiptAmount(movement) {
    if (!PURCHASE_RECEIPT_TYPES.includes(String(movement?.movement_type || '').trim().toLowerCase())) return undefined;
    const quantity = numberOrNull(movement.quantity_change);
    if (quantity === null || quantity <= 0) return undefined;
    const total = numberOrNull(movement.total_cost);
    if (total !== null && total > 0) return total;
    const unit = numberOrNull(movement.unit_cost);
    return unit !== null && unit > 0 ? unit * quantity : null;
  }

  // { total, receipts, costed, uncosted } over the movements for which
  // `include(movement)` is true (the caller's period test).
  function purchaseSpend(movements, include = () => true) {
    const result = { total: 0, receipts: 0, costed: 0, uncosted: 0 };
    for (const movement of movements || []) {
      const amount = purchaseReceiptAmount(movement);
      if (amount === undefined || !include(movement)) continue;
      result.receipts += 1;
      if (amount === null) result.uncosted += 1;
      else { result.costed += 1; result.total += amount; }
    }
    return result;
  }

  // Movement rows read for projections and reports: the newest 5 000, read in
  // pages of 1 000 (the PostgREST max-rows default). Same number on the server
  // (atlas-domain MOVEMENT_ROW_LIMIT).
  const MOVEMENT_ROW_LIMIT = 5000;
  const MOVEMENT_PAGE_SIZE = 1000;

  root.AtlasStockTruth = Object.freeze({
    known, belowPar, project, effectiveStock,
    STOCK_STATUSES, stockStatus, unknownReason, withhold, needsOrdering, stockCounts, hasCost, inventoryValue,
    PURCHASE_RECEIPT_TYPES, purchaseReceiptAmount, purchaseSpend, MOVEMENT_ROW_LIMIT, MOVEMENT_PAGE_SIZE
  });
})(window);
