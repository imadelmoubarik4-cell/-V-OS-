(function(root) {
  'use strict';

  const OWNER_CONFIRMED_TYPES = new Set(['owner_confirmed', 'owner_confirmed_supplier_price']);
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
    if (expiresAt !== null && expiresAt <= nowMillis) return null;
    return {
      quantity,
      at: verifiedAt ?? 0,
      expiresAt,
      source: 'manager_verified_count'
    };
  }

  function ownerBaseline(item, balance, nowMillis) {
    const sourceType = String(item?.source_type || '').toLowerCase();
    if (!OWNER_CONFIRMED_TYPES.has(sourceType) || Number(item?.source_confidence) < 100) return null;

    const quantity = numberOrNull(item?.quantity);
    const updatedAt = millis(item?.updated_at);
    if (quantity === null || updatedAt === null) return null;

    const balanceAt = millis(balance?.verified_at);
    if (balanceAt !== null && updatedAt <= balanceAt) return null;

    const balanceExpires = millis(balance?.expires_at);
    const freshnessWindow = balanceAt !== null && balanceExpires !== null && balanceExpires > balanceAt
      ? balanceExpires - balanceAt
      : DEFAULT_FRESHNESS_MS;
    const expiresAt = updatedAt + freshnessWindow;
    if (expiresAt <= nowMillis) return null;

    return {
      quantity,
      at: updatedAt,
      expiresAt,
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
    const owner = ownerBaseline(item, balance, nowMillis);
    const baseline = owner && (!manager || owner.at > manager.at) ? owner : manager;
    if (!baseline) return null;

    const delta = movementDelta(movements, item.id, baseline.at, nowMillis);
    return {
      quantity: Math.max(0, baseline.quantity + delta),
      baselineAt: baseline.at,
      expiresAt: baseline.expiresAt,
      source: baseline.source,
      movementDelta: delta
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
        stock_movement_delta: evidence?.movementDelta || 0
      };
    });
  }

  root.AtlasStockTruth = Object.freeze({ known, project, effectiveStock });
})(window);
