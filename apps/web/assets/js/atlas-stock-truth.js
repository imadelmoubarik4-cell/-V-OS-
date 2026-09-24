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

  root.AtlasStockTruth = Object.freeze({ known, project, effectiveStock });
})(window);
