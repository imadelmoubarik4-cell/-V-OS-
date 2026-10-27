/*
 * KANEL Pricing & Profitability — Finance › Menu Pricing workspace.
 *
 * A self-contained shell view ('pricing') for #pricing (overview) and
 * #pricing/quick (Quick Price Calculator). It is a CLIENT-SIDE calculation
 * surface over the shared engine (window.KanelPricing): it never writes to live
 * POS/menu prices, invoices or accounting records, and its baseline is the
 * engine's built-in launch baseline (DEFAULT_PROFILE, October 2026 planning
 * figures): nothing is read from a saved profile yet (audit L42), so the copy
 * never calls it "saved". Admin/manager only (the nav already gates it; this adds a
 * defence-in-depth permission state for anyone who reaches the route directly).
 *
 * Margins shown here are computed on NET sales (ex 11% output VAT), never on the
 * VAT-inclusive guest price — the engine owns that maths so the UI and the test
 * suite agree to the króna.
 *
 * Layout (Basalt & Kingfisher): each tab answers one question with its biggest
 * block. Money reads as ladders and tables: right-aligned tabular krónur, one
 * decimal on percentages, the sign in the text (never red on every minus), one
 * status pill per row. A ladder's lines always add up to the subtotals shown:
 * a deduction between two engine subtotals is printed as their difference.
 */
(function () {
  'use strict';

  const VIEW = 'pricing';
  const MANAGER_ROLES = ['admin', 'manager'];

  const SECTIONS = ['dashboard', 'quick', 'locked', 'classics', 'exceptions'];
  const SNAPSHOT_URL = 'assets/data/kanel-price-lock-v07.json';
  // The forecast cash-margin floor every locked and proposed price is held to.
  const CASH_FLOOR = 0.05;

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
  const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;

  // Whole-króna formatting: reuse the app's formatter when present so the whole
  // product reads identically; fall back to a matching local format otherwise.
  // A negative amount carries a true minus sign (U+2212), the same glyph as
  // the ladder's "− Product cost" lines, so the column's signs line up.
  function isk(value) {
    if (!Number.isFinite(value)) return '—';
    if (window.AtlasCalculations?.formatIsk) return window.AtlasCalculations.formatIsk(value).replace(/^-/, '\u2212');
    const n = Math.round(value);
    return `${n < 0 ? '\u2212' : ''}${Math.abs(n).toLocaleString('de-DE')} kr`;
  }
  // Percentages read the way the krónur beside them do (Icelandic: "." groups
  // thousands, "," is the decimal), one decimal, a no-break space before "%"
  // as in Reports and Recipes ("64,0 %", "−2,3 %").
  function pct(value) { return Number.isFinite(value) ? `${value.toFixed(1).replace('.', ',').replace(/^-/, '\u2212')}\u00a0%` : '—'; }
  function fracPct(value) { return Number.isFinite(value) ? pct(value * 100) : '—'; }
  // A share of net sales from the figures on screen (so the percentage and the
  // krónur beside it agree).
  function share(part, whole) { return whole > 0 ? pct((part / whole) * 100) : '—'; }
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  function dateText(value) {
    return window.AtlasVenueClock?.formatDate?.(value, { day: 'numeric', month: 'short', year: 'numeric' }, value) || value;
  }

  function pageHead(opts) { return window.AtlasShell?.pageHead?.(opts) || ''; }

  // Route tabs: links with addresses (#pricing/<section>), underlined on the
  // page's full-width rule. The click is routed through the shell (go()).
  // A count marks only the queue that needs action (the exceptions); the full
  // lists say how long they are on their own tab.
  function tabs() {
    const s = state.snapshot;
    const counts = { exceptions: s?.exceptions?.length };
    const tab = (id, label) => {
      const active = state.section === id;
      const count = Number.isFinite(counts[id]) ? ` <span class="count">${counts[id]}</span>` : '';
      return `<a href="#pricing${id === 'dashboard' ? '' : `/${id}`}" class="fp-tab" data-fp-tab="${id}"${active ? ' aria-current="page"' : ''}>${escapeHtml(label)}${count}</a>`;
    };
    return `<nav class="atlas-tabs fp-tabs" aria-label="Menu pricing views">
      ${tab('dashboard', 'Overview')}
      ${tab('quick', 'Quick calculator')}
      ${tab('locked', 'Locked menu')}
      ${tab('classics', 'Classics')}
      ${tab('exceptions', 'Exceptions')}
    </nav>`;
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

  // The block keeps its place while the snapshot loads (flat grey rows at the
  // real row height) and says what failed inside it when it can't load.
  function snapshotPending(label, rows = 6) {
    if (state.snapshotState === 'error') {
      return `<div class="atlas-alert atlas-alert--danger fp-error" role="alert">${icon('circle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__title">Couldn’t load the ${escapeHtml(label)}</p><p class="atlas-alert__body">The owner price snapshot is bundled with the app. Nothing was changed.</p></div><div class="atlas-alert__actions"><button type="button" class="atlas-btn atlas-btn--secondary atlas-btn--sm" data-fp-retry>Try again</button></div></div>`;
    }
    return `<div class="fp-skeleton" role="status" aria-busy="true" aria-label="Loading the ${escapeHtml(label)}">${'<span class="atlas-skel atlas-skel--row"></span>'.repeat(rows)}</div>`;
  }

  // ---------- status ----------

  // One status mark per row: grey for a price that clears the floor, the
  // warning pair under it, the danger pair when the model loses cash.
  function flagTone(flag) {
    const f = String(flag || '').toUpperCase();
    return f === 'PASS' ? 'pass' : f.includes('NEGATIVE') ? 'negative' : 'under';
  }
  const TONES = {
    pass: { pill: 'neutral', label: 'Clears floor' },
    under: { pill: 'warning', label: 'Under 5% target' },
    negative: { pill: 'danger', label: 'Cash-negative' },
  };
  function tonePill(tone) {
    const t = TONES[tone] || TONES.pass;
    // What is fine stays grey text; only the rows at risk carry a pill.
    if (tone === 'pass') return `<span class="fp-muted">${escapeHtml(t.label)}</span>`;
    return `<span class="atlas-pill atlas-pill--${t.pill}">${escapeHtml(t.label)}</span>`;
  }
  // Phone rows: the pass label is left out (the figures say it), the at-risk pill stays.
  const listPill = (tone) => (tone === 'pass' ? '' : tonePill(tone));

  // The locked menu as one mark per item, ordered from the best cash margin to
  // the worst: the share under the floor is seen, not only read.
  function lockedHealth(list) {
    const items = [...list].sort((a, b) => (b.modeled_cash_margin ?? -Infinity) - (a.modeled_cash_margin ?? -Infinity));
    const tally = { pass: 0, under: 0, negative: 0 };
    const cells = items.map((it) => {
      const tone = flagTone(it.financial_flag);
      tally[tone] += 1;
      return `<span class="fp-strip__cell fp-strip__cell--${tone}" title="${escapeHtml(`${it.product} · ${fracPct(it.modeled_cash_margin)} cash margin`)}"></span>`;
    }).join('');
    const label = `${tally.pass} clear the 5% cash floor, ${tally.under} sit under it, ${tally.negative} lose cash`;
    const legend = (tone, text) => `<li class="fp-legend__item"><span class="fp-legend__swatch fp-strip__cell--${tone}" aria-hidden="true"></span><span class="fp-legend__count">${tally[tone]}</span> ${escapeHtml(text)}</li>`;
    return `<div class="fp-health">
      <div class="fp-strip" role="img" aria-label="${escapeHtml(label)}">${cells}</div>
      <ul class="fp-legend">
        ${legend('pass', 'clear the floor')}
        ${legend('under', 'under the 5% target')}
        ${legend('negative', 'cash-negative')}
      </ul>
    </div>`;
  }

  // ---------- tables ----------

  // A desktop table plus its phone list (two-line rows: identity and the key
  // figure on line 1, the other figures in grey on line 2; nothing dropped).
  function tableBlock({ head, body, list, caption = '', wrapClass = '' }) {
    return `<div class="atlas-table-wrap atlas-table-wrap--responsive fp-table-wrap ${wrapClass}">
        <table class="atlas-table fp-table">${caption ? `<caption class="atlas-sr-only">${escapeHtml(caption)}</caption>` : ''}<thead><tr>${head}</tr></thead>${body}</table>
      </div>
      <ul class="atlas-table-list fp-list">${list}</ul>`;
  }
  const th = (label, num = false) => `<th scope="col"${num ? ' class="is-num"' : ''}>${escapeHtml(label)}</th>`;
  const td = (value, cls = '') => `<td class="is-num${cls ? ` ${cls}` : ''}">${value}</td>`;
  function itemCell(name, sub, code = '') {
    const codeHtml = code ? `<span class="fp-code">${escapeHtml(code)}</span>` : '';
    const subHtml = sub ? `${code ? ' · ' : ''}${escapeHtml(sub)}` : '';
    return `<th scope="row" class="fp-item"><span class="fp-item__name">${escapeHtml(name)}</span>${codeHtml || subHtml ? `<span class="fp-item__sub">${codeHtml}${subHtml}</span>` : ''}</th>`;
  }
  function listRow({ title, meta, value, pill = '' }) {
    return `<li class="atlas-table-list__row fp-list__row"><div class="atlas-table-list__body"><p class="atlas-table-list__title">${escapeHtml(title)}</p><p class="atlas-table-list__meta">${escapeHtml(meta)}</p></div><div class="atlas-table-list__value">${value}${pill ? `<br>${pill}` : ''}</div></li>`;
  }
  const groupRow = (label, count, span) => `<tr class="fp-group"><th scope="colgroup" colspan="${span}">${escapeHtml(label)} <span class="fp-group__count">${count}</span></th></tr>`;
  const listGroup = (label, count) => `<li class="fp-list__group">${escapeHtml(label)} <span class="fp-group__count">${count}</span></li>`;
  function groupBy(list, key) {
    const groups = new Map();
    list.forEach((it) => { const k = key(it); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); });
    return [...groups.entries()];
  }

  function sectionHead(title, meta = '', id = '') {
    return `<div class="atlas-section__head fp-section__head"><h2 class="atlas-section__title"${id ? ` id="${id}"` : ''}>${escapeHtml(title)}</h2>${meta ? `<div class="fp-section__meta">${meta}</div>` : ''}</div>`;
  }
  const navLink = (section, label) => `<a class="atlas-section__link" href="#pricing/${section}" data-fp-nav="${section}">${escapeHtml(label)}</a>`;

  // ---------- ladders ----------

  // rows: [label, value, { total, share, sub }]. Deductions print with their
  // minus sign in grey; subtotals in ink on a rule; a negative subtotal is the
  // one place the danger colour appears.
  function ladder(rows, { caption, valueHead, shareHead = '% of net' }) {
    const body = rows.map(([label, value, opt = {}]) => {
      const negative = opt.total && value < 0;
      return `<tr class="${opt.total ? 'fp-ladder__total' : 'fp-ladder__step'}">
        <th scope="row">${escapeHtml(label)}${opt.sub ? `<span class="fp-ladder__sub">${escapeHtml(opt.sub)}</span>` : ''}</th>
        <td class="fp-ladder__value${negative ? ' is-negative' : ''}">${isk(value)}</td>
        <td class="fp-ladder__share">${opt.share || ''}</td>
      </tr>`;
    }).join('');
    return `<table class="fp-ladder"><caption class="atlas-sr-only">${escapeHtml(caption)}</caption>
      <thead><tr><th scope="col"><span class="atlas-sr-only">Line</span></th><th scope="col" class="fp-ladder__value">${escapeHtml(valueHead)}</th><th scope="col" class="fp-ladder__share">${escapeHtml(shareHead)}</th></tr></thead>
      <tbody>${body}</tbody></table>`;
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

  function servingLadder(l) {
    const p = engine().withDefaults(profile());
    const G = l.inputs.guestPrice;
    const N = l.netSales;
    const GM = l.grossProfit;
    const OC = l.operatingContribution;
    const OP = l.allocatedOperatingProfit;
    const CL = l.allocatedCashContribution;
    const vatPct = Math.round((l.inputs.salesVatRate ?? p.salesVatRate) * 100);
    return ladder([
      [`Menu price, incl. ${vatPct}% VAT`, G],
      [`− Sales VAT ${vatPct}%`, -(G - N)],
      ['Net sales', N, { total: true, share: share(N, N) }],
      ['− Product cost', -(N - GM)],
      ['Gross margin', GM, { total: true, share: share(GM, N) }],
      [`− ${Math.round(p.turnoverRentPctOfNet * 100)}% turnover rent`, -l.turnoverRent],
      ['− Card fees', -(GM - l.turnoverRent - OC)],
      ['Operating contribution', OC, { total: true, share: share(OC, N) }],
      ['− Share of operating overhead', -(OC - OP)],
      ['Operating profit', OP, { total: true, share: share(OP, N) }],
      [`− ${Math.round(p.loanCollectionPct * 100)}% loan collection`, -l.loanCollection, { sub: 'financing' }],
      ['− Overhead VAT (cash)', -(OP - l.loanCollection - CL)],
      ['Cash left per serving', CL, { total: true, share: share(CL, N) }],
    ], { caption: 'Per-serving price ladder', valueHead: 'Per serving' });
  }

  function warningsMarkup(warnings) {
    if (!warnings || !warnings.length) {
      return `<p class="fp-verdict">${icon('circle-check')}No pricing warnings on this item.</p>`;
    }
    return `<ul class="fp-warnings" role="list">${warnings.map((w) => (
      `<li class="atlas-alert atlas-alert--${w.level === 'error' ? 'danger' : 'warning'} fp-warn">${icon(w.level === 'error' ? 'octagon-alert' : 'triangle-alert')}<div class="atlas-alert__content"><p class="atlas-alert__body">${escapeHtml(w.text)}</p></div></li>`
    )).join('')}</ul>`;
  }

  function quickMarkup() {
    const q = state.quick;
    const r = quickResult();
    const l = r.ladder;
    const catOptions = ['cocktail', 'spirit', 'wine', 'beer', 'coffee', 'soft drink', 'food', 'other']
      .map((c) => `<option value="${c}"${q.category === c ? ' selected' : ''}>${escapeHtml(c.replace(/^\w/, (m) => m.toUpperCase()))}</option>`).join('');
    const vatOptions = [[0.11, '11% (food and drink)'], [0.24, '24% (standard)'], [0, '0% (exempt)']]
      .map(([v, label]) => `<option value="${v}"${Math.abs(q.vatRate - v) < 1e-9 ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
    const capped = l.recommendedAchievable ? '' : ' · target capped';

    return `<div class="fp-quick">
      <form class="fp-panel fp-form" data-fp-form novalidate aria-labelledby="fp-q-title">
        <h2 class="fp-panel__title" id="fp-q-title">What are you pricing?</h2>
        <p class="fp-panel__sub">Enter what one serving costs you. KANEL’s built-in launch baseline (October 2026 planning figures for rent, card fees, loan, overhead and VAT) does the rest.</p>
        <div class="atlas-field"><label for="fp-q-name">Product name</label><input class="atlas-input" id="fp-q-name" data-fp="name" value="${escapeHtml(q.name)}" maxlength="120"></div>
        <div class="fp-form__row">
          <div class="atlas-field"><label for="fp-q-cat">Category</label><select class="atlas-select" id="fp-q-cat" data-fp="category">${catOptions}</select></div>
          <div class="atlas-field"><label for="fp-q-vat">Purchase VAT rate</label><select class="atlas-select" id="fp-q-vat" data-fp="vatRate">${vatOptions}</select></div>
        </div>
        <div class="fp-form__row">
          <div class="atlas-field"><label for="fp-q-cost">Cost per serving (ISK)</label><input class="atlas-input fp-input--num" id="fp-q-cost" type="number" min="0" step="1" inputmode="numeric" data-fp="cost" value="${escapeHtml(q.cost)}"></div>
          <div class="atlas-field"><label for="fp-q-disp">Disposables per serving</label><input class="atlas-input fp-input--num" id="fp-q-disp" type="number" min="0" step="1" inputmode="numeric" data-fp="disposables" value="${escapeHtml(q.disposables)}" aria-describedby="fp-q-disp-help"><p class="help" id="fp-q-disp-help">Cup, straw, napkin (ISK)</p></div>
        </div>
        <label class="atlas-check-row fp-check"><input type="checkbox" class="atlas-check" data-fp="includesVat"${q.includesVat ? ' checked' : ''}> <span>The cost I entered already includes purchase VAT</span></label>
        <p class="fp-note">${icon('info')}Nothing here is published. This is a calculator: it never changes live menu or POS prices.</p>
      </form>

      <section class="fp-panel fp-result" aria-live="polite" aria-labelledby="fp-r-label">
        <div class="fp-result__head">
          <p class="fp-figure__label" id="fp-r-label">Recommended menu price</p>
          <p class="fp-figure">${isk(l.recommendedPrice)}</p>
          <p class="fp-result__sub"><span class="fp-result__name">${escapeHtml(q.name || 'This item')}</span> · cost ${isk(r.productCost)} · floor ${isk(l.minimumPrice)}${capped}</p>
        </div>
        ${servingLadder(l)}
        ${warningsMarkup(l.warnings)}
      </section>
    </div>`;
  }

  // ---------- overview ----------

  // A small set of worked examples computed live by the engine, so the overview
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

  function modelMarkup() {
    const e = engine();
    const p = e.withDefaults(profile());
    const m = e.businessModel(profile());
    const N = m.monthlyNetSales;
    const C = m.operatingContribution;
    const O = m.operatingProfit;
    const R = m.cashRemaining;
    const L = m.loanCollection;
    const rows = ladder([
      ['Forecast net sales', N, { total: true, share: share(N, N) }],
      [`− Product cost`, -m.productCost, { sub: `${pct(p.blendedProductCostPct * 100)} blended` }],
      ['− Rent and card fees', -(N - m.productCost - C)],
      ['Operating contribution', C, { total: true, share: share(C, N) }],
      ['− Operating overhead', -(C - O)],
      ['Operating profit', O, { total: true, share: share(O, N) }],
      [`− ${Math.round(p.loanCollectionPct * 100)}% loan collection`, -L, { sub: 'financing' }],
      ['− Overhead VAT (cash)', -(O - L - R)],
      ['Cash left', R, { total: true, share: share(R, N) }],
    ], { caption: 'Monthly model ladder', valueHead: 'A month' });
    const tone = R < 0 ? ' is-negative' : '';
    const cashBreakEven = Number.isFinite(m.cashBreakEvenNetRevenue) && N > 0 ? `${isk(m.cashBreakEvenNetRevenue)}<span class="fp-facts__sub">${pct((m.cashBreakEvenNetRevenue / N) * 100)} of forecast</span>` : '—';
    return `<section class="atlas-section fp-section" aria-labelledby="fp-model-title">
      ${sectionHead('Monthly cash', `<span class="atlas-section__meta">Launch baseline</span>`, 'fp-model-title')}
      <div class="fp-panel fp-model">
        <div class="fp-model__lead">
          <p class="fp-figure__label">Cash left each month</p>
          <p class="fp-figure${tone}">${isk(R)}</p>
          <p class="fp-model__note">${share(R, N)} of ${isk(N)} forecast net sales, after the loan collection and overhead paid in cash.</p>
          <dl class="fp-facts">
            <div><dt>Operating break-even</dt><dd>${isk(m.breakEvenNetRevenue)}<span class="fp-facts__sub">${pct(m.breakEvenPctOfPlan)} of forecast</span></dd></div>
            <div><dt>Cash break-even</dt><dd>${cashBreakEven}</dd></div>
            <div><dt>Contribution margin</dt><dd>${pct(m.contributionMarginRatio)}</dd></div>
            <div><dt>VÁ history, net a month</dt><dd>${isk(p.historicalMonthlyNetSales)}<span class="fp-facts__sub">${share(p.historicalMonthlyNetSales, N)} of forecast</span></dd></div>
          </dl>
        </div>
        <div class="fp-model__ladder">${rows}</div>
      </div>
    </section>`;
  }

  function shortfallsMarkup() {
    if (state.snapshotState !== 'ready') return snapshotPending('locked menu', 4);
    const s = state.snapshot;
    const worst = [...s.exceptions].sort((a, b) => (b.gap_isk || 0) - (a.gap_isk || 0)).slice(0, 5);
    const head = [th('Item'), th('Locked price', true), th('5% floor', true), th('Short by', true), th('Cash margin', true), th('Status')].join('');
    const body = `<tbody>${worst.map((x) => `<tr>${itemCell(x.item, x.category)}${td(isk(x.locked_price_isk))}${td(isk(x.cash_5pct_floor_isk))}${td(isk(x.gap_isk), 'fp-strong')}${td(fracPct(x.cash_margin))}<td>${tonePill(flagTone(x.severity))}</td></tr>`).join('')}</tbody>`;
    const list = worst.map((x) => listRow({ title: x.item, meta: `${x.category} · locked ${isk(x.locked_price_isk)} · floor ${isk(x.cash_5pct_floor_isk)} · ${fracPct(x.cash_margin)}`, value: `${isk(x.gap_isk)} short`, pill: tonePill(flagTone(x.severity)) })).join('');
    return `${lockedHealth(s.locked_menu)}
      <h3 class="fp-subhead">Largest shortfalls</h3>
      ${tableBlock({ head, body, list, caption: 'Largest shortfalls against the 5% cash floor' })}`;
  }

  function examplesMarkup() {
    const e = engine();
    const p = profile();
    const rows = demoItems().map((item) => ({ item, l: e.priceProduct({ guestPrice: item.price, productCost: item.cost }, p) }));
    // What is fine stays grey text, as on the locked menu; a mark only where
    // the engine has something to say.
    const status = (l) => (l.warnings.some((w) => w.level === 'error') ? '<span class="atlas-pill atlas-pill--danger">Error</span>'
      : l.warnings.length ? `<span class="atlas-pill atlas-pill--warning">${escapeHtml(plural(l.warnings.length, 'warning', 'warnings'))}</span>` : '<span class="fp-muted">No warnings</span>');
    const head = [th('Item'), th('Cost', true), th('Menu price', true), th('Net', true), th('Gross margin', true), th('Operating', true), th('Cash', true), th('Status')].join('');
    const body = `<tbody>${rows.map(({ item, l }) => `<tr>${itemCell(item.name, item.note)}${td(isk(item.cost))}${td(isk(item.price))}${td(isk(l.netSales))}${td(pct(l.grossMarginPct))}${td(isk(l.operatingContribution))}${td(isk(l.cashContribution), 'fp-strong')}<td>${status(l)}</td></tr>`).join('')}</tbody>`;
    const list = rows.map(({ item, l }) => listRow({ title: item.name, meta: `cost ${isk(item.cost)} · price ${isk(item.price)} · ${pct(l.grossMarginPct)} gross`, value: `${isk(l.cashContribution)} cash`, pill: l.warnings.length ? status(l) : '' })).join('');
    return `<section class="atlas-section fp-section" aria-labelledby="fp-examples-title">
      ${sectionHead('Worked examples', navLink('quick', 'Price a new item'), 'fp-examples-title')}
      ${tableBlock({ head, body, list, caption: 'Worked examples' })}
      <p class="fp-note">${icon('info')}Illustrative calculations over the built-in launch baseline (October 2026 planning figures), not live menu prices. Operating and cash are per serving, before fixed overhead. Recipe costs come from Inventory and Recipes once connected.</p>
    </section>`;
  }

  // The overview answers the line under the title first: how the locked menu
  // sits against the cash floor (the strip, then the worst shortfalls). The
  // monthly model that sets the floor follows; worked examples close.
  function dashboardMarkup() {
    const s = state.snapshot;
    const meta = state.snapshotState === 'ready' ? navLink('exceptions', `All ${s.exceptions.length} exceptions`) : '';
    return `<section class="atlas-section fp-section" aria-labelledby="fp-locked-title">
        ${sectionHead('Locked menu against the 5% cash floor', meta, 'fp-locked-title')}
        ${shortfallsMarkup()}
      </section>
      ${modelMarkup()}
      ${examplesMarkup()}`;
  }

  // ---------- locked menu ----------

  function lockedMarkup() {
    if (state.snapshotState !== 'ready') return `<section class="atlas-section fp-section">${sectionHead('Locked printed menu')}${snapshotPending('locked menu')}</section>`;
    const s = state.snapshot;
    const published = s.locked_menu.some((it) => it.pos_published);
    const span = published ? 7 : 6;
    const head = [th('Item'), th('Locked price', true), th('Modeled cost', true), th('Cash margin', true), th('5% floor', true), th('Status'), published ? th('POS') : ''].join('');
    const groups = groupBy(s.locked_menu, (it) => it.category);
    const body = groups.map(([category, items]) => `<tbody>${groupRow(category, items.length, span)}${items.map((it) => `<tr>${itemCell(it.product, '', it.sku)}${td(isk(it.guest_price_incl_vat_isk), 'fp-strong')}${td(isk(it.modeled_cost_isk))}${td(fracPct(it.modeled_cash_margin))}${td(isk(it.model_5pct_price_floor_isk))}<td>${tonePill(flagTone(it.financial_flag))}</td>${published ? `<td>${it.pos_published ? '<span class="atlas-pill atlas-pill--danger">Published</span>' : '<span class="fp-muted">Not on POS</span>'}</td>` : ''}</tr>`).join('')}</tbody>`).join('');
    const list = groups.map(([category, items]) => listGroup(category, items.length) + items.map((it) => listRow({ title: it.product, meta: `${it.sku} · cost ${isk(it.modeled_cost_isk)} · floor ${isk(it.model_5pct_price_floor_isk)} · ${fracPct(it.modeled_cash_margin)}`, value: isk(it.guest_price_incl_vat_isk), pill: listPill(flagTone(it.financial_flag)) })).join('')).join('');
    const tally = s.locked_menu.reduce((t, it) => { t[flagTone(it.financial_flag)] += 1; return t; }, { pass: 0, under: 0, negative: 0 });
    return `<section class="atlas-section fp-section" aria-labelledby="fp-locked-title">
      ${sectionHead('Locked printed menu', `<span class="fp-lock">${icon('lock')}${s.locked_menu.length} owner-locked · effective ${escapeHtml(dateText(s.effective_date))}</span>`, 'fp-locked-title')}
      <p class="fp-intro">Prices frozen exactly to the owner’s V06/V07 decision. This view is read-only: it never reprices, and nothing here is published to the POS or the printed menu. ${tally.under + tally.negative} items sit below the 5% cash target and ${tally.negative} are negative under the forecast model; see ${navLink('exceptions', 'Exceptions')}.</p>
      ${lockedHealth(s.locked_menu)}
      ${tableBlock({ head, body, list, caption: 'Locked printed menu by category', wrapClass: 'fp-table-wrap--long' })}
      ${published ? '' : '<p class="fp-note">None of these prices is on the POS.</p>'}
    </section>`;
  }

  // ---------- classics ----------

  function classicsMarkup() {
    if (state.snapshotState !== 'ready') return `<section class="atlas-section fp-section">${sectionHead('On-request classics')}${snapshotPending('classics catalogue')}</section>`;
    const s = state.snapshot;
    const scopes = [['Core classics', (c) => /CORE/.test(c.service_scope)], ['Supplementary requests', (c) => !/CORE/.test(c.service_scope)]];
    const thin = (c) => Number.isFinite(c.estimated_cash_margin_after_allocated_overhead) && c.estimated_cash_margin_after_allocated_overhead < CASH_FLOOR;
    // A column whose every row says the same thing moves into the intro.
    const anyThin = s.classics.some(thin);
    const statuses = [...new Set(s.classics.map((c) => c.cost_status || ''))];
    const sameStatus = statuses.length === 1;
    const sentence = (text) => String(text || '').toLowerCase().replace(/^\w/, (m) => m.toUpperCase());
    const span = 6 + (anyThin ? 1 : 0) + (sameStatus ? 0 : 1);
    const head = [th('Classic'), th('Proposed', true), th('5% minimum', true), th('Portion cost', true), th('Raw margin', true), th('Cash margin', true), anyThin ? th('Status') : '', sameStatus ? '' : th('Cost status')].join('');
    const groups = scopes.map(([label, test]) => [label, s.classics.filter(test)]);
    const body = groups.map(([label, items]) => `<tbody>${groupRow(label, items.length, span)}${items.map((c) => `<tr>${itemCell(c.name, c.recipe_provenance || '', c.sku)}${td(isk(c.proposed_price_incl_vat_isk), 'fp-strong')}${td(isk(c.calculated_minimum_5pct_isk))}${td(isk(c.estimated_portion_cost_isk))}${td(fracPct(c.estimated_raw_gross_margin))}${td(fracPct(c.estimated_cash_margin_after_allocated_overhead))}${anyThin ? `<td>${thin(c) ? tonePill('under') : tonePill('pass')}</td>` : ''}${sameStatus ? '' : `<td><span class="atlas-pill atlas-pill--neutral">${escapeHtml(sentence(c.cost_status))}</span></td>`}</tr>`).join('')}</tbody>`).join('');
    const list = groups.map(([label, items]) => listGroup(label, items.length) + items.map((c) => listRow({ title: c.name, meta: `${c.sku} · min ${isk(c.calculated_minimum_5pct_isk)} · cost ${isk(c.estimated_portion_cost_isk)} · ${fracPct(c.estimated_cash_margin_after_allocated_overhead)} cash`, value: isk(c.proposed_price_incl_vat_isk), pill: thin(c) ? tonePill('under') : '' })).join('')).join('');
    return `<section class="atlas-section fp-section" aria-labelledby="fp-classics-title">
      ${sectionHead('On-request classics', `<span class="atlas-pill atlas-pill--info">Draft · needs owner approval</span>`, 'fp-classics-title')}
      <p class="fp-intro">Staff-only, served on request: never on the printed menu and never published to the POS without the owner’s explicit price approval. ${groups[0][1].length} core classics (recomputed from V06) and ${groups[1][1].length} supplementary requests.${sameStatus && statuses[0] ? ` ${escapeHtml(sentence(statuses[0]))} for all of them; confirm costs before publication.` : ' Costs are partly estimated; confirm before publication.'}</p>
      ${tableBlock({ head, body, list, caption: 'On-request classics', wrapClass: 'fp-table-wrap--long' })}
    </section>`;
  }

  // ---------- exceptions ----------

  function exceptionsMarkup() {
    if (state.snapshotState !== 'ready') return `<section class="atlas-section fp-section">${sectionHead('Price exceptions')}${snapshotPending('exceptions register')}</section>`;
    const s = state.snapshot;
    // Cash-negative first, then the largest shortfall: the decisions in order.
    const rank = (x) => (flagTone(x.severity) === 'negative' ? 0 : 1);
    const list = [...s.exceptions].sort((a, b) => rank(a) - rank(b) || (b.gap_isk || 0) - (a.gap_isk || 0));
    const negative = list.filter((x) => rank(x) === 0).length;
    const head = [th('Item'), th('Locked price', true), th('5% floor', true), th('Short by', true), th('Cash margin', true), th('Status')].join('');
    const body = `<tbody>${list.map((x) => `<tr>${itemCell(x.item, x.category, x.sku)}${td(isk(x.locked_price_isk))}${td(isk(x.cash_5pct_floor_isk))}${td(isk(x.gap_isk), 'fp-strong')}${td(fracPct(x.cash_margin))}<td>${tonePill(flagTone(x.severity))}</td></tr>`).join('')}</tbody>`;
    const rows = list.map((x) => listRow({ title: x.item, meta: `${x.category} · locked ${isk(x.locked_price_isk)} · floor ${isk(x.cash_5pct_floor_isk)} · ${fracPct(x.cash_margin)}`, value: `${isk(x.gap_isk)} short`, pill: tonePill(flagTone(x.severity)) })).join('');
    return `<section class="atlas-section fp-section" aria-labelledby="fp-exc-title">
      ${sectionHead('Price exceptions', `<span class="atlas-section__meta">${plural(list.length, 'item', 'items')} · ${negative} cash-negative</span>`, 'fp-exc-title')}
      <p class="fp-intro">Owner-locked items whose price is below the forecast 5% cash-margin floor. Locking the price does <strong>not</strong> clear the warning: each needs a commercial decision (reprice with the owner’s authorization, accept it as a loss-leader, or reduce the cost). Cash-negative items first, then the largest shortfall.</p>
      ${tableBlock({ head, body, list: rows, caption: 'Price exceptions, cash-negative first', wrapClass: 'fp-table-wrap--long' })}
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

  // The line under the title states the tab's finding (counted from the rows
  // on screen) once the snapshot is in; until then, what the tab is for.
  function subline() {
    const s = state.snapshotState === 'ready' ? state.snapshot : null;
    const tally = s ? s.locked_menu.reduce((t, it) => { t[flagTone(it.financial_flag)] += 1; return t; }, { pass: 0, under: 0, negative: 0 }) : null;
    const below = tally ? tally.under + tally.negative : 0;
    switch (state.section) {
      case 'quick': return 'Price any product in seconds against the KANEL baseline';
      case 'locked': return s ? `${below} of ${s.locked_menu.length} locked prices are under the 5% cash floor · read-only, never auto-published` : 'The owner’s frozen printed prices — read-only, never auto-published';
      case 'classics': return s ? `${s.classics.length} staff-only drinks on request · draft prices, owner approval required` : 'Staff-only on-request drinks — draft prices, owner approval required';
      case 'exceptions': return s ? `${s.exceptions.length} locked prices need a decision · ${s.exceptions.filter((x) => flagTone(x.severity) === 'negative').length} lose cash under the forecast` : 'Locked prices sitting below the forecast 5% cash-margin floor';
      default: return s ? `${below} of ${s.locked_menu.length} locked prices are under the 5% cash floor · ${tally.negative} lose cash` : 'Minimum price, margin and real cash — for everything on the menu';
    }
  }

  function paint() {
    if (!state.visible) return;
    const view = host();
    if (!view) return;
    view.classList.remove('placeholder-view');
    view.classList.add('fp-host');

    if (!canView()) { view.innerHTML = deniedMarkup(); paintIcons(); return; }
    if (!engine()) { view.innerHTML = notReadyMarkup(); paintIcons(); ensureEngine(); return; }

    const body = state.section === 'quick' ? quickMarkup()
      : state.section === 'locked' ? lockedMarkup()
      : state.section === 'classics' ? classicsMarkup()
      : state.section === 'exceptions' ? exceptionsMarkup()
      : dashboardMarkup();
    // The calculator is the most frequent job: one click from every other tab.
    const actions = state.section === 'quick' ? [] : [{ label: 'Price an item', icon: 'calculator', variant: 'primary', attrs: { 'data-fp-nav': 'quick' } }];
    view.innerHTML = `<div class="atlas-page fp-page">
      ${pageHead({ title: 'Menu Pricing', sub: subline(), actions })}
      ${tabs()}
      <div class="fp-body" data-fp-section="${state.section}">${body}</div>
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
    // The owner snapshot powers three tabs and the overview counts; load it once.
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
    if (target.closest('[data-fp-retry]')) { state.snapshotState = 'idle'; loadSnapshot(); paint(); }
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
