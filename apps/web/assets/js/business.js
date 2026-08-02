(function () {
  'use strict';

  const state = {
    initialized: false,
    periodDays: 30
  };

  const dom = {};

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatIsk(value, fallback = '—') {
    if (!Number.isFinite(value)) return fallback;
    return `${Math.round(value).toLocaleString('en-US')} ISK`;
  }

  function formatPercent(value, digits = 0, fallback = '—') {
    if (!Number.isFinite(value)) return fallback;
    return `${value.toFixed(digits)}%`;
  }

  function sourceItems() {
    return typeof items !== 'undefined' && Array.isArray(items) ? items : [];
  }

  function sourceRecipes() {
    return typeof recipes !== 'undefined' && Array.isArray(recipes) ? recipes : [];
  }

  function sourceMovements() {
    return typeof restockLog !== 'undefined' && Array.isArray(restockLog) ? restockLog : [];
  }

  function sourceSuppliers() {
    return typeof suppliers !== 'undefined' && Array.isArray(suppliers) ? suppliers : [];
  }

  function activeItems() {
    return sourceItems().filter((item) => item.active !== false);
  }

  function activeRecipes() {
    return sourceRecipes().filter((recipe) => recipe.active !== false);
  }

  function periodStart() {
    if (!Number.isFinite(state.periodDays)) return null;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - state.periodDays + 1);
    return start;
  }

  function movementsInPeriod() {
    const start = periodStart();
    if (!start) return sourceMovements();
    return sourceMovements().filter((movement) => new Date(movement.created_at) >= start);
  }

  function normalizeUnit(unit) {
    const value = String(unit || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!value) return 'each';
    if (['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters'].includes(value)) return 'ml';
    if (['l', 'lt', 'liter', 'liters', 'litre', 'litres'].includes(value)) return 'l';
    if (['g', 'gr', 'gram', 'grams'].includes(value)) return 'g';
    if (['kg', 'kilogram', 'kilograms'].includes(value)) return 'kg';
    if (['bottle', 'bottles'].includes(value)) return 'bottle';
    if (['can', 'cans'].includes(value)) return 'can';
    if (['piece', 'pieces', 'pc', 'pcs', 'unit', 'units', 'each', 'ea'].includes(value)) return 'each';
    return value;
  }

  function parsePackSize(item) {
    if (number(item?.size_ml) > 0) return { quantity: number(item.size_ml), unit: 'ml' };
    const text = String(item?.unit || '').trim().toLowerCase();
    const match = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*(ml|l|lt|g|kg)\b/i);
    if (match) {
      const quantity = Number(match[1].replace(',', '.'));
      const unit = normalizeUnit(match[2]);
      if (unit === 'l') return { quantity: quantity * 1000, unit: 'ml' };
      if (unit === 'kg') return { quantity: quantity * 1000, unit: 'g' };
      return { quantity, unit };
    }
    const normalized = normalizeUnit(text);
    if (['bottle', 'can', 'each'].includes(normalized)) return { quantity: 1, unit: normalized };
    return null;
  }

  function convertQuantity(quantity, unit) {
    const normalized = normalizeUnit(unit);
    if (normalized === 'l') return { quantity: quantity * 1000, unit: 'ml' };
    if (normalized === 'kg') return { quantity: quantity * 1000, unit: 'g' };
    return { quantity, unit: normalized };
  }

  function ingredientCost(ingredient) {
    const item = activeItems().find((candidate) => candidate.id === ingredient.item_id);
    const purchaseCost = number(item?.cost_price, NaN);
    if (!item || !Number.isFinite(purchaseCost) || purchaseCost <= 0) return null;
    const pack = parsePackSize(item);
    const requested = convertQuantity(number(ingredient.quantity), ingredient.unit);
    if (!pack || requested.quantity <= 0) return null;
    if (pack.unit === requested.unit) return purchaseCost * (requested.quantity / pack.quantity);
    const eachLike = new Set(['each', 'bottle', 'can']);
    if (eachLike.has(pack.unit) && eachLike.has(requested.unit)) return purchaseCost * requested.quantity;
    return null;
  }

  function recipeFinancials(recipe) {
    const ingredients = recipe?.recipe_ingredients || [];
    const recipeYield = Math.max(.0001, number(recipe?.yield_quantity, 1));
    const menuPrice = number(recipe?.menu_price, NaN);
    let total = 0;
    let incomplete = 0;
    ingredients.forEach((ingredient) => {
      const value = ingredientCost(ingredient);
      if (value == null) incomplete += 1;
      else total += value;
    });
    const perServing = total / recipeYield;
    const profit = Number.isFinite(menuPrice) ? menuPrice - perServing : NaN;
    const margin = Number.isFinite(menuPrice) && menuPrice > 0 ? (profit / menuPrice) * 100 : NaN;
    const costPercent = Number.isFinite(menuPrice) && menuPrice > 0 ? (perServing / menuPrice) * 100 : NaN;
    const complete = ingredients.length > 0 && incomplete === 0 && Number.isFinite(menuPrice) && menuPrice > 0;
    return { total, perServing, profit, margin, costPercent, incomplete, complete };
  }

  function recipeEconomics() {
    return activeRecipes().map((recipe) => ({ recipe, financials: recipeFinancials(recipe) }));
  }

  function inventoryValue() {
    return activeItems().reduce((sum, item) => {
      const quantity = Math.max(0, number(item.quantity));
      const cost = number(item.cost_price, NaN);
      return sum + (Number.isFinite(cost) && cost > 0 ? quantity * cost : 0);
    }, 0);
  }

  function periodSpend() {
    return movementsInPeriod().reduce((sum, movement) => sum + Math.max(0, number(movement.total_cost)), 0);
  }

  function orderExposure() {
    const suggestions = window.AtlasOperations?.orderSuggestions?.() || [];
    return suggestions.filter((entry) => !entry.ordered).reduce((sum, entry) => sum + Math.max(0, number(entry.estimatedCost)), 0);
  }

  function inventoryCompleteness() {
    const list = activeItems();
    if (!list.length) return { score: 0, cost: 0, par: 0, supplier: 0 };
    const cost = list.filter((item) => number(item.cost_price) > 0).length / list.length * 100;
    const par = list.filter((item) => item.par_level != null && number(item.par_level) > 0).length / list.length * 100;
    const supplier = list.filter((item) => String(item.supplier || '').trim()).length / list.length * 100;
    return { score: (cost + par + supplier) / 3, cost, par, supplier };
  }

  function recipeCompleteness() {
    const entries = recipeEconomics();
    if (!entries.length) return { score: 0, complete: 0, total: 0, averageMargin: NaN, averageCost: NaN };
    const complete = entries.filter((entry) => entry.financials.complete);
    const averageMargin = complete.length
      ? complete.reduce((sum, entry) => sum + entry.financials.margin, 0) / complete.length
      : NaN;
    const averageCost = complete.length
      ? complete.reduce((sum, entry) => sum + entry.financials.perServing, 0) / complete.length
      : NaN;
    return {
      score: complete.length / entries.length * 100,
      complete: complete.length,
      total: entries.length,
      averageMargin,
      averageCost
    };
  }

  function supplierCompleteness() {
    const list = activeItems();
    if (!list.length) return 0;
    return list.filter((item) => String(item.supplier || '').trim()).length / list.length * 100;
  }

  function readinessScore() {
    return number(window.AtlasOperations?.readinessData?.().score, 0);
  }

  function businessHealth() {
    const inventory = inventoryCompleteness();
    const recipesData = recipeCompleteness();
    const supplier = supplierCompleteness();
    const readiness = readinessScore();
    const score = Math.round(readiness * .35 + inventory.score * .30 + recipesData.score * .25 + supplier * .10);
    let label = 'Foundation required';
    let tone = 'danger';
    if (score >= 85) { label = 'Strong operating foundation'; tone = 'good'; }
    else if (score >= 65) { label = 'Developing business intelligence'; tone = 'warn'; }
    return { score, label, tone, readiness, inventory, recipes: recipesData, supplier };
  }

  function categoryValues() {
    const groups = new Map();
    activeItems().forEach((item) => {
      const category = String(item.category || 'Uncategorised').trim() || 'Uncategorised';
      const cost = number(item.cost_price, NaN);
      const value = Number.isFinite(cost) && cost > 0 ? Math.max(0, number(item.quantity)) * cost : 0;
      groups.set(category, (groups.get(category) || 0) + value);
    });
    return Array.from(groups, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }

  function monthKey(dateValue) {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthLabel(key) {
    const [year, month] = key.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  }

  function spendTrend() {
    const map = new Map();
    sourceMovements().forEach((movement) => {
      const key = monthKey(movement.created_at);
      if (!key) return;
      map.set(key, (map.get(key) || 0) + Math.max(0, number(movement.total_cost)));
    });
    const now = new Date();
    const result = [];
    for (let offset = 5; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      result.push({ key, label: monthLabel(key), value: map.get(key) || 0 });
    }
    return result;
  }

  function supplierStats() {
    const names = new Set([
      ...sourceSuppliers().map((supplier) => supplier.name).filter(Boolean),
      ...activeItems().map((item) => item.supplier).filter(Boolean),
      ...sourceMovements().map((movement) => movement.suppliers?.name).filter(Boolean)
    ]);
    const movements = movementsInPeriod();
    const total = periodSpend();
    return Array.from(names).map((name) => {
      const relevant = movements.filter((movement) => movement.suppliers?.name === name);
      const spend = relevant.reduce((sum, movement) => sum + Math.max(0, number(movement.total_cost)), 0);
      const lastOrder = relevant.map((movement) => new Date(movement.created_at)).filter((date) => !Number.isNaN(date.getTime())).sort((a, b) => b - a)[0] || null;
      return {
        name,
        itemCount: activeItems().filter((item) => item.supplier === name).length,
        spend,
        share: total > 0 ? spend / total * 100 : 0,
        lastOrder
      };
    }).sort((a, b) => b.spend - a.spend || b.itemCount - a.itemCount || a.name.localeCompare(b.name));
  }

  function topCapitalItems() {
    return activeItems().map((item) => {
      const cost = number(item.cost_price, NaN);
      return {
        item,
        value: Number.isFinite(cost) && cost > 0 ? Math.max(0, number(item.quantity)) * cost : 0
      };
    }).filter((entry) => entry.value > 0).sort((a, b) => b.value - a.value).slice(0, 6);
  }

  function insights() {
    const result = [];
    const inventory = inventoryCompleteness();
    const recipesData = recipeCompleteness();
    const supplierRows = supplierStats();
    const lowMargin = recipeEconomics()
      .filter((entry) => entry.financials.complete && entry.financials.margin < 65)
      .sort((a, b) => a.financials.margin - b.financials.margin)[0];
    const missingCosts = activeItems().filter((item) => number(item.cost_price) <= 0).length;
    const missingPar = activeItems().filter((item) => item.par_level == null || number(item.par_level) <= 0).length;

    if (missingCosts) {
      result.push({ icon: 'circle-dollar-sign', tone: 'danger', title: `${missingCosts} inventory ${missingCosts === 1 ? 'item needs' : 'items need'} a cost price`, detail: 'Complete item costs to improve inventory valuation, recipe costing and purchasing estimates.', target: 'inventory', action: 'Open Inventory' });
    }
    if (recipesData.total && recipesData.complete < recipesData.total) {
      const count = recipesData.total - recipesData.complete;
      result.push({ icon: 'badge-percent', tone: 'warn', title: `${count} active ${count === 1 ? 'recipe is' : 'recipes are'} not fully costed`, detail: 'Add missing menu prices, package sizes or ingredient costs to complete profitability analysis.', target: 'recipes', action: 'Review Recipes' });
    }
    if (missingPar) {
      result.push({ icon: 'gauge', tone: 'warn', title: `${missingPar} inventory ${missingPar === 1 ? 'item has' : 'items have'} no par level`, detail: 'Par levels are required for meaningful stock-risk and purchasing recommendations.', target: 'inventory', action: 'Set Par Levels' });
    }
    if (lowMargin) {
      result.push({ icon: 'trending-down', tone: 'danger', title: `${lowMargin.recipe.name} has the lowest complete margin`, detail: `Current estimated margin is ${formatPercent(lowMargin.financials.margin, 0)} at ${formatIsk(lowMargin.financials.perServing)} cost per serve.`, target: 'recipes', action: 'Review Recipe' });
    }
    if (supplierRows.length && supplierRows[0].share >= 70 && supplierRows[0].spend > 0) {
      result.push({ icon: 'landmark', tone: 'warn', title: `${supplierRows[0].name} represents ${formatPercent(supplierRows[0].share, 0)} of period purchasing`, detail: 'High supplier concentration is not necessarily negative, but it is worth monitoring for pricing and continuity risk.', target: 'suppliers', action: 'View Purchasing' });
    }
    if (!sourceMovements().length) {
      result.push({ icon: 'receipt-text', tone: 'neutral', title: 'Purchasing history is not yet available', detail: 'Log restocks with supplier and cost data to unlock spend trends and supplier analysis.', target: 'inventory', action: 'Log Restock' });
    }
    if (!result.length) {
      result.push({ icon: 'circle-check-big', tone: 'good', title: 'Core business data is in good shape', detail: `Inventory configuration is ${formatPercent(inventory.score, 0)} complete and recipe costing coverage is ${formatPercent(recipesData.score, 0)}.`, target: 'brain', action: 'Open Atlas Brain' });
    }
    return result.slice(0, 6);
  }

  function topHomeInsight() {
    return insights()[0] || null;
  }

  function periodLabel() {
    return Number.isFinite(state.periodDays) ? `Last ${state.periodDays} days` : 'All recorded time';
  }

  function periodControlsMarkup() {
    return [
      { value: 7, label: '7 days' },
      { value: 30, label: '30 days' },
      { value: 90, label: '90 days' },
      { value: Infinity, label: 'All time' }
    ].map((entry) => `<button type="button" data-business-period="${Number.isFinite(entry.value) ? entry.value : 'all'}" class="${state.periodDays === entry.value ? 'active' : ''}">${entry.label}</button>`).join('');
  }

  function metricMarkup(icon, value, label, detail, tone = '') {
    return `<article class="business-metric" ${tone ? `data-tone="${escape(tone)}"` : ''}><div class="business-metric-icon"><i data-lucide="${escape(icon)}"></i></div><strong>${escape(value)}</strong><span>${escape(label)}</span><small>${escape(detail)}</small></article>`;
  }

  function healthMarkup(health) {
    const rows = [
      { label: 'Service readiness', value: health.readiness },
      { label: 'Inventory data', value: health.inventory.score },
      { label: 'Recipe costing', value: health.recipes.score },
      { label: 'Supplier assignment', value: health.supplier }
    ];
    return rows.map((row) => `<div class="business-health-row"><div><span>${escape(row.label)}</span><strong>${formatPercent(row.value, 0)}</strong></div><div class="business-meter"><span style="width:${Math.max(0, Math.min(100, row.value))}%"></span></div></div>`).join('');
  }

  function spendTrendMarkup() {
    const trend = spendTrend();
    const max = Math.max(1, ...trend.map((entry) => entry.value));
    if (!trend.some((entry) => entry.value > 0)) return '<div class="business-empty">No costed restock movements are available yet.</div>';
    return `<div class="business-chart" aria-label="Purchasing spend by month">${trend.map((entry) => `<div class="business-chart-column"><div class="business-chart-value">${entry.value > 0 ? escape(formatIsk(entry.value)) : ''}</div><div class="business-chart-track"><span style="height:${entry.value / max * 100}%"></span></div><strong>${escape(entry.label)}</strong></div>`).join('')}</div>`;
  }

  function categoryMarkup() {
    const rows = categoryValues().slice(0, 8);
    if (!rows.length || !rows.some((row) => row.value > 0)) return '<div class="business-empty">Add inventory costs to unlock category valuation.</div>';
    const max = Math.max(1, ...rows.map((row) => row.value));
    return rows.map((row) => `<div class="business-bar-row"><div class="business-bar-copy"><strong>${escape(row.name)}</strong><span>${escape(formatIsk(row.value))}</span></div><div class="business-bar"><span style="width:${row.value / max * 100}%"></span></div></div>`).join('');
  }

  function profitabilityMarkup() {
    const entries = recipeEconomics().filter((entry) => entry.financials.complete).sort((a, b) => b.financials.margin - a.financials.margin);
    if (!entries.length) return '<div class="business-empty">Complete recipe prices, ingredient costs and package sizes to unlock profitability rankings.</div>';
    return `<div class="business-table-wrap"><table class="business-table"><thead><tr><th>Recipe</th><th>Cost / serve</th><th>Menu price</th><th>Margin</th><th>Profit / serve</th></tr></thead><tbody>${entries.slice(0, 10).map((entry) => `<tr><td><strong>${escape(entry.recipe.name)}</strong></td><td>${escape(formatIsk(entry.financials.perServing))}</td><td>${escape(formatIsk(number(entry.recipe.menu_price, NaN)))}</td><td><span class="business-margin ${entry.financials.margin < 65 ? 'low' : entry.financials.margin >= 75 ? 'high' : ''}">${escape(formatPercent(entry.financials.margin, 0))}</span></td><td>${escape(formatIsk(entry.financials.profit))}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function supplierMarkup() {
    const rows = supplierStats().slice(0, 8);
    if (!rows.length) return '<div class="business-empty">No suppliers are assigned yet.</div>';
    return rows.map((row) => `<div class="business-supplier-row"><div class="business-supplier-copy"><strong>${escape(row.name)}</strong><span>${row.itemCount} linked ${row.itemCount === 1 ? 'item' : 'items'}${row.lastOrder ? ` · Last restock ${escape(row.lastOrder.toLocaleDateString('en-GB'))}` : ''}</span></div><div class="business-supplier-values"><strong>${escape(formatIsk(row.spend, '0 ISK'))}</strong><span>${row.spend > 0 ? `${formatPercent(row.share, 0)} of period spend` : 'No period spend'}</span></div></div>`).join('');
  }

  function capitalMarkup() {
    const rows = topCapitalItems();
    if (!rows.length) return '<div class="business-empty">Add cost prices to inventory items to identify where working capital is held.</div>';
    const total = inventoryValue();
    return rows.map((entry) => `<div class="business-capital-row"><div><strong>${escape(entry.item.name)}</strong><span>${escape(entry.item.category || 'Uncategorised')} · ${number(entry.item.quantity)} ${escape(entry.item.unit || 'units')}</span></div><div><strong>${escape(formatIsk(entry.value))}</strong><span>${total > 0 ? `${formatPercent(entry.value / total * 100, 0)} of inventory value` : ''}</span></div></div>`).join('');
  }

  function insightMarkup() {
    return insights().map((entry) => `<div class="business-insight" data-tone="${escape(entry.tone)}"><div class="business-insight-icon"><i data-lucide="${escape(entry.icon)}"></i></div><div><strong>${escape(entry.title)}</strong><span>${escape(entry.detail)}</span></div><button type="button" data-business-target="${escape(entry.target)}">${escape(entry.action)}</button></div>`).join('');
  }

  function coverageMarkup() {
    const rows = [
      { name: 'Inventory valuation', connected: activeItems().some((item) => number(item.cost_price) > 0), note: 'Live from inventory items' },
      { name: 'Recipe profitability', connected: recipeCompleteness().complete > 0, note: 'Live from recipes and inventory costs' },
      { name: 'Supplier purchasing', connected: sourceMovements().some((movement) => number(movement.total_cost) > 0), note: 'Live from costed restock movements' },
      { name: 'Sales and product mix', connected: false, note: 'POS integration required' },
      { name: 'Bookings and guest forecast', connected: false, note: 'Booking integration required' },
      { name: 'Labour and wage analysis', connected: false, note: 'Team and payroll integration required' }
    ];
    return rows.map((row) => `<div class="business-coverage-row"><div><strong>${escape(row.name)}</strong><span>${escape(row.note)}</span></div><span class="business-coverage-state ${row.connected ? 'connected' : 'pending'}"><i></i>${row.connected ? 'Connected' : 'Not connected'}</span></div>`).join('');
  }

  function render() {
    if (!dom.shell) return;
    const health = businessHealth();
    const recipesData = recipeCompleteness();
    const missingCosts = activeItems().filter((item) => number(item.cost_price) <= 0).length;
    const orderCount = (window.AtlasOperations?.orderSuggestions?.() || []).filter((entry) => !entry.ordered).length;

    dom.shell.innerHTML = `
      <header class="business-hero">
        <div class="business-hero-copy">
          <span class="business-kicker"><i data-lucide="chart-no-axes-combined"></i>Atlas Alpha 0.6</span>
          <h1>Business Intelligence</h1>
          <p>Understand the financial and operational signals already available inside Atlas without inventing sales, bookings or labour data that has not yet been connected.</p>
          <div class="business-period-control" aria-label="Business intelligence period">${periodControlsMarkup()}</div>
        </div>
        <aside class="business-health-card" data-tone="${escape(health.tone)}">
          <span>Business health</span>
          <strong>${health.score}%</strong>
          <p>${escape(health.label)}</p>
          <div class="business-health-ring" style="--health:${health.score * 3.6}deg"><span>${health.score}</span></div>
        </aside>
      </header>

      <section class="business-metric-grid" aria-label="Business intelligence summary">
        ${metricMarkup('boxes', formatIsk(inventoryValue()), 'Inventory value', `${missingCosts} ${missingCosts === 1 ? 'item is' : 'items are'} missing cost data`, missingCosts ? 'warn' : 'good')}
        ${metricMarkup('receipt-text', formatIsk(periodSpend(), '0 ISK'), 'Purchasing spend', periodLabel(), periodSpend() > 0 ? 'neutral' : 'warn')}
        ${metricMarkup('shopping-cart', formatIsk(orderExposure(), '0 ISK'), 'Suggested order exposure', `${orderCount} current ${orderCount === 1 ? 'item' : 'items'}`, orderCount ? 'warn' : 'good')}
        ${metricMarkup('badge-percent', formatPercent(recipesData.averageMargin, 0), 'Average recipe margin', `${recipesData.complete}/${recipesData.total} active recipes fully costed`, recipesData.score < 100 ? 'warn' : 'good')}
        ${metricMarkup('chef-hat', formatIsk(recipesData.averageCost), 'Average cost per serve', 'Based only on complete recipe costs', recipesData.complete ? 'neutral' : 'warn')}
      </section>

      <div class="business-layout">
        <div class="business-stack">
          <section class="business-card">
            <header class="business-card-head"><div><h2>Business insights</h2><p>Actions generated from the currently connected business data.</p></div><button type="button" class="business-card-action" data-business-refresh>Refresh analysis</button></header>
            <div class="business-insight-list">${insightMarkup()}</div>
          </section>

          <section class="business-card">
            <header class="business-card-head"><div><h2>Recipe profitability</h2><p>Complete recipes ranked by estimated gross margin.</p></div><button type="button" class="business-card-action" data-business-target="recipes">Open Recipes</button></header>
            ${profitabilityMarkup()}
          </section>

          <section class="business-card">
            <header class="business-card-head"><div><h2>Purchasing spend trend</h2><p>Costed restock movements recorded across the latest six calendar months.</p></div></header>
            ${spendTrendMarkup()}
          </section>
        </div>

        <aside class="business-stack">
          <section class="business-card">
            <header class="business-card-head"><div><h2>Business health components</h2><p>The current score is based on operational readiness and data completeness.</p></div></header>
            <div class="business-health-list">${healthMarkup(health)}</div>
          </section>

          <section class="business-card">
            <header class="business-card-head"><div><h2>Inventory value by category</h2><p>Estimated capital held in current stock.</p></div></header>
            <div class="business-bar-list">${categoryMarkup()}</div>
          </section>

          <section class="business-card">
            <header class="business-card-head"><div><h2>Supplier performance</h2><p>${escape(periodLabel())} based on costed restock movements.</p></div><button type="button" class="business-card-action" data-business-target="suppliers">Open Purchasing</button></header>
            <div class="business-supplier-list">${supplierMarkup()}</div>
          </section>

          <section class="business-card">
            <header class="business-card-head"><div><h2>Working capital concentration</h2><p>Inventory items currently holding the most estimated value.</p></div></header>
            <div class="business-capital-list">${capitalMarkup()}</div>
          </section>

          <section class="business-card">
            <header class="business-card-head"><div><h2>Intelligence coverage</h2><p>Atlas shows only what the current data can genuinely support.</p></div></header>
            <div class="business-coverage-list">${coverageMarkup()}</div>
          </section>
        </aside>
      </div>`;

    bindRenderedEvents();
    if (window.lucide) window.lucide.createIcons();
  }

  function navigate(target) {
    if (target === 'inventory-restock') {
      if (typeof openRestockModal === 'function') openRestockModal();
      return;
    }
    setActiveView(target);
  }

  function bindRenderedEvents() {
    dom.shell.querySelectorAll('[data-business-period]').forEach((button) => button.addEventListener('click', () => {
      state.periodDays = button.dataset.businessPeriod === 'all' ? Infinity : Number(button.dataset.businessPeriod);
      render();
    }));
    dom.shell.querySelectorAll('[data-business-target]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.businessTarget)));
    dom.shell.querySelector('[data-business-refresh]')?.addEventListener('click', render);
  }

  function ensureMarkup() {
    const main = document.querySelector('.atlas-content.standard-view main');
    if (!main || document.getElementById('business-view')) return;

    const view = document.createElement('div');
    view.id = 'business-view';
    view.style.display = 'none';
    view.innerHTML = '<section class="business-shell" id="business-shell"></section>';
    const reportsView = document.getElementById('reports-view');
    main.insertBefore(view, reportsView || document.getElementById('settings-view') || null);

    const groups = Array.from(document.querySelectorAll('.atlas-nav .nav-group'));
    const insightsGroup = groups.find((group) => group.querySelector('.nav-label')?.textContent?.trim() === 'INSIGHTS');
    if (insightsGroup && !document.querySelector('[data-view="business"]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nav-item';
      button.dataset.view = 'business';
      button.innerHTML = '<i data-lucide="chart-no-axes-combined"></i><span>Business Intelligence</span>';
      const reportsButton = insightsGroup.querySelector('[data-view="reports"]');
      if (reportsButton) insightsGroup.insertBefore(button, reportsButton);
      else insightsGroup.appendChild(button);
      button.addEventListener('click', () => setActiveView('business'));
    }

    const fabMenu = document.getElementById('fab-menu');
    if (fabMenu && !document.getElementById('fab-open-business')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'fab-open-business';
      button.innerHTML = '<i data-lucide="chart-no-axes-combined"></i><span>Open Business Intelligence</span>';
      fabMenu.appendChild(button);
      button.addEventListener('click', () => {
        fabMenu.classList.remove('open');
        document.getElementById('fab-btn')?.classList.remove('open');
        setActiveView('business');
      });
    }

    dom.view = view;
    dom.shell = document.getElementById('business-shell');
  }

  function renderHomeAugmentation() {
    const focusList = document.getElementById('focus-list');
    if (!focusList) return;
    focusList.querySelectorAll('[data-atlas-business-focus]').forEach((row) => row.remove());
    const insight = topHomeInsight();
    if (!insight) return;
    focusList.insertAdjacentHTML('beforeend', `<div class="focus-row" data-target="business" data-atlas-business-focus><span class="focus-dot"></span><span>Business Intelligence: ${escape(insight.title)}.</span></div>`);
    if (typeof bindHomeLinks === 'function') bindHomeLinks();
  }

  function patchApplication() {
    if (typeof viewMap !== 'undefined') viewMap.business = dom.view;
    if (typeof titleMap !== 'undefined') titleMap.business = 'Business Intelligence';

    if (typeof setActiveView === 'function' && !setActiveView.__atlasBusinessPatched) {
      const originalSetActiveView = setActiveView;
      const patchedSetActiveView = function (view) {
        originalSetActiveView(view);
        if (view === 'business') render();
      };
      patchedSetActiveView.__atlasBusinessPatched = true;
      setActiveView = patchedSetActiveView;
    }

    if (typeof loadAll === 'function' && !loadAll.__atlasBusinessPatched) {
      const originalLoadAll = loadAll;
      const patchedLoadAll = async function () {
        await originalLoadAll();
        render();
        renderHomeAugmentation();
      };
      patchedLoadAll.__atlasBusinessPatched = true;
      loadAll = patchedLoadAll;
    }

    if (typeof renderAtlasHome === 'function' && !renderAtlasHome.__atlasBusinessPatched) {
      const originalRenderAtlasHome = renderAtlasHome;
      const patchedRenderAtlasHome = function () {
        originalRenderAtlasHome();
        renderHomeAugmentation();
      };
      patchedRenderAtlasHome.__atlasBusinessPatched = true;
      renderAtlasHome = patchedRenderAtlasHome;
    }

    document.getElementById('global-search')?.addEventListener('input', (event) => {
      const query = event.target.value.toLowerCase();
      if (query.includes('business') || query.includes('profit') || query.includes('margin') || query.includes('spend') || query.includes('intelligence')) {
        setActiveView('business');
      }
    });
  }

  function init() {
    if (state.initialized) return;
    ensureMarkup();
    if (!dom.view || !dom.shell) return;
    patchApplication();
    state.initialized = true;
    render();
    renderHomeAugmentation();
    if (window.lucide) window.lucide.createIcons();
  }

  window.AtlasBusiness = {
    init,
    render,
    businessHealth,
    insights,
    inventoryValue,
    periodSpend
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
