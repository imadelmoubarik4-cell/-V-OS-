/*
 * KANEL Pricing & Profitability — Finance › Menu Pricing workspace.
 *
 * A self-contained shell view ('pricing') for #pricing (dashboard) and
 * #pricing/quick (Quick Price Calculator). It is a CLIENT-SIDE calculation
 * surface over the shared engine (window.KanelPricing): it never writes to live
 * POS/menu prices, invoices or accounting records, and it reads only the
 * published baseline. Admin/manager only (the nav already gates it; this adds a
 * defence-in-depth permission state for anyone who reaches the route directly).
 *
 * Margins shown here are computed on NET sales (ex 11% output VAT), never on the
 * VAT-inclusive guest price — the engine owns that maths so the UI and the test
 * suite agree to the króna.
 */
(function () {
  'use strict';

  const VIEW = 'pricing';
  const MANAGER_ROLES = ['admin', 'manager'];

  const SECTIONS = ['dashboard', 'quick', 'locked', 'classics', 'exceptions'];
  const SNAPSHOT_URL = 'assets/data/kanel-price-lock-v07.json';

  const state = {
    initialized: false,
    visible: false,
    section: 'dashboard',
    // Quick calculator form (seeded with the LIE so the page is useful on open).
    quick: { name: 'Lie (signature)', category: 'cocktail', cost: 642, includesVat: false, vatRate: 0.11, disposables: 0 },
    snapshot: null,
    snapshotState: 'idle', // idle | loading | ready | error
  };

  // ---------- engine ----------

  function engine() { return window.KanelPricing || null; }

  function profile() {
    const e = engine();
    return e ? e.DEFAULT_PROFILE : null;
  }

  // ---------- helpers ----------

  function host() { return document.getElementById('pricing-view'); }

  function role() {
    try { return window.AtlasShell?.profile?.()?.role || null; } catch { return null; }
  }

  function canView() { return MANAGER_ROLES.includes(role()); }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function paintIcons() { window.lucide?.createIcons?.(); }

  // Whole-króna formatting: reuse the app's formatter when present so the whole
  // product reads identically; fall back to a matching local format otherwise.
  function isk(value) {
    if (!Number.isFinite(value)) return '—';
    if (window.AtlasCalculations?.formatIsk) return window.AtlasCalculations.formatIsk(value);
    const n = Math.round(value);
    return `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('de-DE')} kr`;
  }
  function pct(value) { return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'; }

  function pageHead(opts) { return window.AtlasShell?.pageHead?.(opts) || ''; }

  function tabs() {
    const tab = (id, label, icon) => {
      const active = state.section === id;
      return `<button type="button" class="atlas-segmented__btn fp-tab" role="tab" aria-selected="${active}" data-fp-tab="${id}"><i data-lucide="${icon}" aria-hidden="true"></i>${escapeHtml(label)}</button>`;
    };
    const excCount = state.snapshot ? ` (${state.snapshot.counts.exceptions})` : '';
    return `<div class="atlas-segmented fp-tabs" role="tablist" aria-label="Menu pricing views">
      ${tab('dashboard', 'Dashboard', 'gauge')}
      ${tab('quick', 'Quick calculator', 'calculator')}
      ${tab('locked', 'Locked menu', 'lock')}
      ${tab('classics', 'Classics', 'wine')}
      ${tab('exceptions', `Exceptions${excCount}`, 'triangle-alert')}
    </div>`;
  }

  // ---------- owner price-lock snapshot (V07) ----------

  function loadSnapshot() {
    if (state.snapshotState === 'loading' || state.snapshotState === 'ready') return;
    state.snapshotState = 'loading';
    fetch(SNAPSHOT_URL, { credentials: 'same-origin' })
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then((data) => { state.snapshot = data; state.snapshotState = 'ready'; if (state.visible) paint(); })
      .catch(() => { state.snapshotState = 'error'; if (state.visible) paint(); });
  }

  function snapshotPending(label) {
    if (state.snapshotState === 'error') {
      return `<div class="atlas-empty"><div class="atlas-empty__icon"><i data-lucide="unplug" aria-hidden="true"></i></div><h2 class="atlas-empty__title">Couldn’t load the ${escapeHtml(label)}</h2><p class="atlas-empty__text">The owner price snapshot didn’t load. It is bundled with the app — try reloading.</p></div>`;
    }
    return `<p class="atlas-view-loading" role="status">Loading the ${escapeHtml(label)}…</p>`;
  }

  // ---------- quick calculator ----------

  function quickResult() {
    const e = engine();
    const q = state.quick;
    // Effective direct cost per serving = entered cost reduced to net if it was
    // entered VAT-inclusive (recoverable), plus any direct disposables.
    const vat = e.purchaseVat({ amount: q.cost, vatRate: q.vatRate, includesVat: q.includesVat, recoverable: true });
    const productCost = vat.effectiveCost + Number(q.disposables || 0);
    // Price the item at its own recommended price so the ladder is self-consistent
    // and demonstrates the full engine, then also report that recommendation.
    const rec = e.recommendedPrice({ productCost, profile: e.withDefaults(profile()) });
    const guestPrice = rec.price || e.priceProduct({ guestPrice: 0, productCost }).minimumPrice || productCost * 4;
    const ladder = e.priceProduct({ guestPrice, productCost }, profile());
    return { productCost, vat, ladder, rec };
  }

  function statLine(label, value, opts = {}) {
    const tone = opts.tone ? ` fp-stat--${opts.tone}` : '';
    const hint = opts.hint ? `<span class="fp-stat__hint">${escapeHtml(opts.hint)}</span>` : '';
    return `<div class="fp-stat${tone}"><dt class="fp-stat__label">${escapeHtml(label)}${hint}</dt><dd class="fp-stat__value">${value}</dd></div>`;
  }

  function warningsMarkup(warnings) {
    if (!warnings || !warnings.length) {
      return `<p class="fp-note fp-note--ok"><i data-lucide="check-circle-2" aria-hidden="true"></i>No pricing warnings on this item.</p>`;
    }
    return `<ul class="fp-warnings" role="list">${warnings.map((w) => (
      `<li class="fp-warn fp-warn--${escapeHtml(w.level)}"><i data-lucide="${w.level === 'error' ? 'octagon-alert' : 'triangle-alert'}" aria-hidden="true"></i><span>${escapeHtml(w.text)}</span></li>`
    )).join('')}</ul>`;
  }

  function quickMarkup() {
    const q = state.quick;
    const r = quickResult();
    const l = r.ladder;
    const catOptions = ['cocktail', 'spirit', 'wine', 'beer', 'coffee', 'soft drink', 'food', 'other']
      .map((c) => `<option value="${c}"${q.category === c ? ' selected' : ''}>${escapeHtml(c.replace(/^\w/, (m) => m.toUpperCase()))}</option>`).join('');
    const vatOptions = [[0.11, '11% — served food & drink'], [0.24, '24% — standard goods'], [0, '0% — exempt / reverse-charge']]
      .map(([v, label]) => `<option value="${v}"${Math.abs(q.vatRate - v) < 1e-9 ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');

    return `<div class="fp-grid fp-grid--split">
      <form class="fp-card fp-form" data-fp-form novalidate>
        <h2 class="fp-card__title">What are you pricing?</h2>
        <p class="fp-card__sub">Enter what one serving costs you. KANEL's saved baseline (rent, card fees, loan, overhead, VAT) does the rest.</p>
        <div class="atlas-field"><label for="fp-q-name">Product name</label><input class="atlas-input" id="fp-q-name" data-fp="name" value="${escapeHtml(q.name)}" maxlength="120"></div>
        <div class="fp-form__row">
          <div class="atlas-field"><label for="fp-q-cat">Category</label><select class="atlas-select" id="fp-q-cat" data-fp="category">${catOptions}</select></div>
          <div class="atlas-field"><label for="fp-q-vat">VAT rate</label><select class="atlas-select" id="fp-q-vat" data-fp="vatRate">${vatOptions}</select></div>
        </div>
        <div class="fp-form__row">
          <div class="atlas-field"><label for="fp-q-cost">Cost per serving (ISK)</label><input class="atlas-input" id="fp-q-cost" type="number" min="0" step="1" inputmode="numeric" data-fp="cost" value="${escapeHtml(q.cost)}"></div>
          <div class="atlas-field"><label for="fp-q-disp">Disposables / serving <span class="optional">cup, straw…</span></label><input class="atlas-input" id="fp-q-disp" type="number" min="0" step="1" inputmode="numeric" data-fp="disposables" value="${escapeHtml(q.disposables)}"></div>
        </div>
        <label class="atlas-check-row fp-check"><input type="checkbox" class="atlas-check" data-fp="includesVat"${q.includesVat ? ' checked' : ''}> <span>The cost I entered already includes purchase VAT</span></label>
        <p class="fp-note"><i data-lucide="info" aria-hidden="true"></i>Nothing here is published. This is a calculator — it never changes live menu or POS prices.</p>
      </form>

      <div class="fp-card fp-result" aria-live="polite">
        <div class="fp-result__head">
          <div>
            <h2 class="fp-card__title">${escapeHtml(q.name || 'This item')}</h2>
            <p class="fp-card__sub">Effective cost ${isk(r.productCost)} · priced at its recommended ${isk(l.inputs.guestPrice)}</p>
          </div>
          <div class="fp-reco">
            <span class="fp-reco__label">Recommended price</span>
            <span class="fp-reco__value">${isk(l.recommendedPrice)}</span>
            <span class="fp-reco__floor">Floor ${isk(l.minimumPrice)}${l.recommendedAchievable ? '' : ' · target capped'}</span>
          </div>
        </div>
        <dl class="fp-stats">
          ${statLine('Net sales (ex 11% VAT)', isk(l.netSales), { hint: 'margins are on this, not the menu price' })}
          ${statLine('Raw cost', pct(l.rawCostPct))}
          ${statLine('Gross margin', pct(l.grossMarginPct), { tone: l.grossMarginPct < 0 ? 'bad' : l.grossMarginPct < 60 ? 'warn' : 'good' })}
          ${statLine('− 9% turnover rent', isk(-l.turnoverRent))}
          ${statLine('− Card fee', isk(-l.cardFee))}
          ${statLine('Operating contribution', isk(l.operatingContribution), { tone: l.operatingContribution < 0 ? 'bad' : 'good' })}
          ${statLine('− 15% loan collection', isk(-l.loanCollection), { hint: 'financing' })}
          ${statLine('Cash contribution', isk(l.cashContribution), { tone: l.cashContribution < 0 ? 'bad' : 'good' })}
          ${statLine('− Allocated overhead', isk(-l.allocatedOperatingOverhead))}
          ${statLine('Fully-allocated profit', isk(l.allocatedOperatingProfit), { tone: l.allocatedOperatingProfit < 0 ? 'warn' : 'good' })}
        </dl>
        ${warningsMarkup(l.warnings)}
      </div>
    </div>`;
  }

  // ---------- dashboard ----------

  // A small set of worked examples computed live by the engine, so the dashboard
  // demonstrates cocktail (batch/clarified), wine (bottle→glass) and coffee
  // (beans+milk+cup) costing end-to-end. These are illustrations, not saved menu
  // prices.
  function demoItems() {
    const e = engine();
    const wine = e.costPerServing({ packCost: 2480, includesVat: true, vatRate: 0.24, packSize: 750, packUnit: 'ml', servingSize: 150, servingUnit: 'ml', disposablesPerServing: 0 });
    const coffee = e.costPerServing({ packCost: 4960, includesVat: true, vatRate: 0.24, packSize: 1, packUnit: 'kg', servingSize: 18, servingUnit: 'g', wastePerServing: 45, disposablesPerServing: 25 });
    return [
      { name: 'Lie', note: 'milk-clarified, 8 usable portions', cost: 642, price: 3190 },
      { name: 'House wine (glass)', note: '750 ml bottle → 150 ml', cost: wine.costPerServing, price: 1690 },
      { name: 'Flat white', note: '1 kg beans → 18 g + milk + cup', cost: coffee.costPerServing, price: 690 },
    ];
  }

  function dashboardMarkup() {
    const e = engine();
    const p = profile();
    const model = e.businessModel(p);
    const overheadMonthly = e.monthlyOperatingOverhead(p);

    const kpis = `<dl class="fp-stats fp-stats--kpi">
      ${statLine('Planned monthly net sales', isk(model.monthlyNetSales))}
      ${statLine('Monthly operating overhead', isk(overheadMonthly))}
      ${statLine('Contribution margin', pct(model.contributionMarginRatio))}
      ${statLine('Operating break-even', isk(model.breakEvenNetRevenue), { hint: `${pct(model.breakEvenPctOfPlan)} of plan`, tone: model.breakEvenNetRevenue > model.monthlyNetSales ? 'warn' : 'good' })}
      ${statLine('Operating profit / month', isk(model.operatingProfit), { tone: model.operatingProfit < 0 ? 'bad' : 'good' })}
      ${statLine('Cash remaining / month', isk(model.cashRemaining), { hint: 'after 15% loan + cash overhead', tone: model.cashRemaining < 0 ? 'bad' : 'good' })}
    </dl>`;

    const rows = demoItems().map((item) => {
      const l = e.priceProduct({ guestPrice: item.price, productCost: item.cost }, p);
      const tone = l.cashContribution < 0 ? 'bad' : l.operatingContribution < 0 ? 'warn' : 'good';
      const flag = l.warnings.some((w) => w.level === 'error') ? 'error' : l.warnings.length ? 'warn' : 'ok';
      return `<tr>
        <th scope="row"><span class="fp-item">${escapeHtml(item.name)}</span><span class="fp-item__note">${escapeHtml(item.note)}</span></th>
        <td>${isk(item.cost)}</td>
        <td>${isk(item.price)}</td>
        <td>${isk(l.netSales)}</td>
        <td class="fp-num fp-num--${l.grossMarginPct < 60 ? 'warn' : 'good'}">${pct(l.grossMarginPct)}</td>
        <td>${isk(l.operatingContribution)}</td>
        <td class="fp-num fp-num--${tone}">${isk(l.cashContribution)}</td>
        <td><span class="fp-dot fp-dot--${flag}" title="${flag === 'ok' ? 'No warnings' : 'Has warnings'}"></span></td>
      </tr>`;
    }).join('');

    return `<div class="fp-grid">
      <section class="fp-card">
        <h2 class="fp-card__title">KANEL business model</h2>
        <p class="fp-card__sub">Seeded from the launch baseline. Margins and break-even are computed on net sales; the 15% loan collection is treated as financing, separate from operating costs.</p>
        ${kpis}
      </section>
      <section class="fp-card">
        <div class="fp-card__headrow">
          <h2 class="fp-card__title">Menu profitability (worked examples)</h2>
          <a class="atlas-btn atlas-btn--secondary atlas-btn--sm" href="#pricing/quick" data-fp-nav="quick"><i data-lucide="calculator" aria-hidden="true"></i>Price a new item</a>
        </div>
        <div class="fp-tablewrap">
          <table class="fp-table">
            <thead><tr><th scope="col">Item</th><th scope="col">Cost</th><th scope="col">Guest price</th><th scope="col">Net</th><th scope="col">Gross margin</th><th scope="col">Operating</th><th scope="col">Cash</th><th scope="col"><span class="atlas-sr-only">Status</span></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="fp-note"><i data-lucide="info" aria-hidden="true"></i>Illustrative calculations over the saved baseline — not live menu prices. Recipe-level costs come from Inventory & Recipes once connected.</p>
      </section>
    </div>`;
  }

  function fracPct(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—'; }

  function flagPill(flag) {
    const f = String(flag || '').toUpperCase();
    const tone = f === 'PASS' ? 'ok' : f.includes('NEGATIVE') ? 'error' : 'warn';
    return `<span class="fp-tag fp-tag--${tone}">${escapeHtml(flag || '—')}</span>`;
  }

  function lockedMarkup() {
    if (state.snapshotState !== 'ready') return `<div class="fp-card">${snapshotPending('locked menu')}</div>`;
    const s = state.snapshot;
    const rows = s.locked_menu.map((it) => {
      const below = Number.isFinite(it.modeled_cash_margin) && it.modeled_cash_margin < 0.05;
      return `<tr class="${below ? 'fp-row--flag' : ''}">
        <th scope="row"><span class="fp-item">${escapeHtml(it.product)}</span><span class="fp-item__note">${escapeHtml(it.sku)} · ${escapeHtml(it.category)}</span></th>
        <td class="fp-num">${isk(it.guest_price_incl_vat_isk)}</td>
        <td class="fp-num">${isk(it.modeled_cost_isk)}</td>
        <td class="fp-num fp-num--${below ? 'warn' : 'good'}">${fracPct(it.modeled_cash_margin)}</td>
        <td class="fp-num">${isk(it.model_5pct_price_floor_isk)}</td>
        <td>${flagPill(it.financial_flag)}</td>
        <td><span class="fp-tag ${it.pos_published ? 'fp-tag--error' : 'fp-tag--muted'}">${it.pos_published ? 'PUBLISHED' : 'Not on POS'}</span></td>
      </tr>`;
    }).join('');
    return `<section class="fp-card">
      <div class="fp-card__headrow">
        <h2 class="fp-card__title">Locked printed menu</h2>
        <span class="fp-tag fp-tag--lock"><i data-lucide="lock" aria-hidden="true"></i>${s.counts.locked} owner-locked</span>
      </div>
      <p class="fp-card__sub">Prices frozen exactly to the owner’s V06/V07 decision (effective ${escapeHtml(s.effective_date)}). This view is read-only — it never reprices and nothing here is published to POS or the printed menu. ${s.counts.below_5pct_cash} items sit below the 5% cash target and ${s.counts.negative_cash} are negative under the forecast model: see Exceptions.</p>
      <div class="fp-tablewrap">
        <table class="fp-table fp-table--dense">
          <thead><tr><th scope="col">Item</th><th scope="col">Locked price</th><th scope="col">Modeled cost</th><th scope="col">Cash margin</th><th scope="col">5% floor</th><th scope="col">Flag</th><th scope="col">POS</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
  }

  function classicsMarkup() {
    if (state.snapshotState !== 'ready') return `<div class="fp-card">${snapshotPending('classics catalogue')}</div>`;
    const s = state.snapshot;
    const group = (scope) => s.classics.filter((c) => (scope === 'core' ? /CORE/.test(c.service_scope) : !/CORE/.test(c.service_scope)));
    const rowsFor = (list) => list.map((c) => {
      const thin = Number.isFinite(c.estimated_cash_margin_after_allocated_overhead) && c.estimated_cash_margin_after_allocated_overhead < 0.05;
      return `<tr class="${thin ? 'fp-row--flag' : ''}">
        <th scope="row"><span class="fp-item">${escapeHtml(c.name)}</span><span class="fp-item__note">${escapeHtml(c.sku)} · ${escapeHtml(c.recipe_provenance || '')}</span></th>
        <td class="fp-num">${isk(c.proposed_price_incl_vat_isk)}</td>
        <td class="fp-num">${isk(c.calculated_minimum_5pct_isk)}</td>
        <td class="fp-num">${isk(c.estimated_portion_cost_isk)}</td>
        <td class="fp-num">${fracPct(c.estimated_raw_gross_margin)}</td>
        <td class="fp-num fp-num--${thin ? 'warn' : 'good'}">${fracPct(c.estimated_cash_margin_after_allocated_overhead)}</td>
        <td><span class="fp-tag fp-tag--muted">${escapeHtml(c.cost_status || '')}</span></td>
      </tr>`;
    }).join('');
    const head = `<thead><tr><th scope="col">Classic</th><th scope="col">Proposed</th><th scope="col">5% min</th><th scope="col">Cost</th><th scope="col">Raw margin</th><th scope="col">Cash margin</th><th scope="col">Cost status</th></tr></thead>`;
    return `<section class="fp-card">
      <div class="fp-card__headrow">
        <h2 class="fp-card__title">On-request classics</h2>
        <span class="fp-tag fp-tag--draft"><i data-lucide="pencil-ruler" aria-hidden="true"></i>Draft — needs owner approval</span>
      </div>
      <p class="fp-card__sub">Staff-only, served on request — never on the printed menu and never published to POS without the owner’s explicit price approval. ${group('core').length} core classics (recomputed from V06) and ${group('supplement').length} supplementary requests. Costs are partly estimated; confirm before publication.</p>
      <h3 class="fp-subhead">Core classics · ${group('core').length}</h3>
      <div class="fp-tablewrap"><table class="fp-table fp-table--dense">${head}<tbody>${rowsFor(group('core'))}</tbody></table></div>
      <h3 class="fp-subhead">Supplementary requests · ${group('supplement').length}</h3>
      <div class="fp-tablewrap"><table class="fp-table fp-table--dense">${head}<tbody>${rowsFor(group('supplement'))}</tbody></table></div>
    </section>`;
  }

  function exceptionsMarkup() {
    if (state.snapshotState !== 'ready') return `<div class="fp-card">${snapshotPending('exceptions register')}</div>`;
    const s = state.snapshot;
    const rows = s.exceptions.map((x) => `<tr>
        <th scope="row"><span class="fp-item">${escapeHtml(x.item)}</span><span class="fp-item__note">${escapeHtml(x.sku)} · ${escapeHtml(x.category)}</span></th>
        <td class="fp-num">${isk(x.locked_price_isk)}</td>
        <td class="fp-num">${isk(x.cash_5pct_floor_isk)}</td>
        <td class="fp-num fp-num--warn">${isk(x.gap_isk)}</td>
        <td class="fp-num fp-num--${x.cash_margin < 0 ? 'bad' : 'warn'}">${fracPct(x.cash_margin)}</td>
        <td><span class="fp-tag fp-tag--${/NEGATIVE/.test(x.severity) ? 'error' : 'warn'}">${escapeHtml(x.severity)}</span></td>
      </tr>`).join('');
    return `<section class="fp-card">
      <div class="fp-card__headrow">
        <h2 class="fp-card__title">Price exceptions</h2>
        <span class="fp-tag fp-tag--warn">${s.counts.exceptions} below 5% cash</span>
      </div>
      <p class="fp-card__sub">Owner-locked items whose price is below the forecast 5% cash-margin floor. Locking the price does <strong>not</strong> clear the warning — these need a commercial decision (reprice via owner authorization, accept as a loss-leader, or reduce cost). ${s.counts.negative_cash} are cash-negative under the model.</p>
      <div class="fp-tablewrap">
        <table class="fp-table fp-table--dense">
          <thead><tr><th scope="col">Item</th><th scope="col">Locked price</th><th scope="col">5% floor</th><th scope="col">Gap</th><th scope="col">Cash margin</th><th scope="col">Severity</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
  }

  // ---------- render ----------

  function notReadyMarkup() {
    return `<div class="atlas-page fp-page">${pageHead({ title: 'Menu Pricing' })}<p class="atlas-view-loading" role="status">Loading the pricing engine…</p></div>`;
  }

  function deniedMarkup() {
    return `<div class="atlas-page fp-page">${pageHead({ title: 'Menu Pricing' })}
      <div class="atlas-empty atlas-empty--page"><div class="atlas-empty__icon"><i data-lucide="lock" aria-hidden="true"></i></div>
      <h2 class="atlas-empty__title">Menu Pricing is for managers</h2>
      <p class="atlas-empty__text">Supplier costs, margins and financing are visible to admins and managers only.</p>
      <div class="atlas-empty__actions"><a class="atlas-btn atlas-btn--secondary" href="#home">Go to Home</a></div></div></div>`;
  }

  function paint() {
    if (!state.visible) return;
    const view = host();
    if (!view) return;
    view.classList.remove('placeholder-view');
    view.classList.add('fp-host');

    if (!canView()) { view.innerHTML = deniedMarkup(); paintIcons(); return; }
    if (!engine()) { view.innerHTML = notReadyMarkup(); paintIcons(); ensureEngine(); return; }

    const subs = {
      dashboard: 'Minimum price, margin and real cash — for everything on the menu',
      quick: 'Price any product in seconds against the KANEL baseline',
      locked: 'The owner’s 59 frozen printed prices — read-only, never auto-published',
      classics: 'Staff-only on-request drinks — draft prices, owner approval required',
      exceptions: 'Locked prices sitting below the forecast 5% cash-margin floor',
    };
    const sub = subs[state.section] || subs.dashboard;
    const body = state.section === 'quick' ? quickMarkup()
      : state.section === 'locked' ? lockedMarkup()
      : state.section === 'classics' ? classicsMarkup()
      : state.section === 'exceptions' ? exceptionsMarkup()
      : dashboardMarkup();
    view.innerHTML = `<div class="atlas-page fp-page">
      ${pageHead({ title: 'Menu Pricing', sub })}
      ${tabs()}
      <div class="fp-body">${body}</div>
    </div>`;
    paintIcons();
  }

  // The engine is lazy-loaded; if it is not ready yet, poll briefly then repaint.
  let enginePolls = 0;
  function ensureEngine() {
    if (engine() || enginePolls > 40) return;
    enginePolls += 1;
    window.setTimeout(() => { if (state.visible && !engine()) ensureEngine(); else if (state.visible) paint(); }, 100);
  }

  function render(params = {}) {
    state.visible = true;
    const rawSection = params.section != null ? String(params.section) : '';
    state.section = SECTIONS.includes(rawSection) ? rawSection : 'dashboard';
    // The owner snapshot powers three tabs and the dashboard counts; load it once.
    if (state.snapshotState === 'idle') loadSnapshot();
    paint();
    window.scrollTo?.(0, 0);
  }

  function onHide() { state.visible = false; }

  // ---------- navigation ----------

  function go(section) {
    window.AtlasShell?.show?.(VIEW, section ? { section } : {}, { source: 'route', route: section ? `#pricing/${section}` : '#pricing' });
  }

  // ---------- events ----------

  function handleClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target)) return;
    const tab = target.closest('[data-fp-tab]');
    if (tab) { event.preventDefault(); const s = tab.dataset.fpTab; go(s === 'dashboard' ? '' : s); return; }
    const nav = target.closest('[data-fp-nav]');
    if (nav) { event.preventDefault(); go(nav.dataset.fpNav); return; }
  }

  function readForm() {
    const view = host();
    if (!view) return;
    const q = state.quick;
    view.querySelectorAll('[data-fp]').forEach((el) => {
      const key = el.dataset.fp;
      if (key === 'includesVat') q.includesVat = el.checked;
      else if (key === 'vatRate') q.vatRate = Number(el.value);
      else if (key === 'cost' || key === 'disposables') q[key] = Math.max(0, Number(el.value) || 0);
      else q[key] = el.value;
    });
  }

  // Recompute the result panel live without rebuilding the form (so focus and
  // caret position are never disturbed while typing).
  function repaintResult() {
    const view = host();
    if (!view || state.section !== 'quick' || !engine()) return;
    const panel = view.querySelector('.fp-result');
    if (!panel) { paint(); return; }
    const fresh = document.createElement('div');
    fresh.innerHTML = quickMarkup();
    const next = fresh.querySelector('.fp-result');
    if (next) { panel.replaceWith(next); paintIcons(); }
  }

  function handleInput(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !host()?.contains(target) || !target.closest('[data-fp]')) return;
    readForm();
    repaintResult();
  }

  // ---------- registration ----------

  function registerWithShell() {
    const shell = window.AtlasShell;
    if (!shell?.registerView) return;
    shell.registerView(VIEW, { root: () => host(), title: 'Menu Pricing', render, onHide });
    shell.actions?.register?.({
      id: 'pricing.open', label: 'Open Menu Pricing', icon: 'badge-percent', roles: MANAGER_ROLES,
      keywords: ['price', 'pricing', 'margin', 'profit', 'cost'], contexts: ['home'], run: () => go('')
    });
    shell.actions?.register?.({
      id: 'pricing.quick', label: 'Quick price calculator', icon: 'calculator', roles: MANAGER_ROLES,
      keywords: ['price', 'calculator', 'margin', 'cost', 'quick'], contexts: ['home', 'pricing'], run: () => go('quick')
    });
    if (shell.current?.() === VIEW) render(shell.params?.() || {});
  }

  function init() {
    if (state.initialized || !host()) return;
    state.initialized = true;
    document.addEventListener('click', handleClick);
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleInput);
    registerWithShell();
  }

  window.AtlasFinancePricing = {
    open: () => go(''),
    openQuick: () => go('quick'),
    section: () => state.section,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
