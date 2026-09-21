(function(root) {
  'use strict';
  function known(item) {
    return item?.freshness_state === 'current' && item.verified_quantity != null
      && item.verified_quantity !== '' && Number.isFinite(Number(item.verified_quantity));
  }
  function project(items, balances) {
    const byId = new Map((balances || []).map(balance => [balance.inventory_item_id, balance]));
    return (items || []).map(item => {
      const balance = byId.get(item.id);
      const valid = known(balance) && (!balance.expires_at || Date.parse(balance.expires_at) > Date.now());
      return {...item, quantity: valid ? Number(balance.verified_quantity) : null,
        verified_quantity: valid ? Number(balance.verified_quantity) : null,
        freshness_state: valid ? 'current' : 'unknown'};
    });
  }
  root.AtlasStockTruth = Object.freeze({known, project});
})(window);
