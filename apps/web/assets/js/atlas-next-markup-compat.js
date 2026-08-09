(() => {
  'use strict';

  let initialized = false;

  function recipeModalMarkup() {
    return `<section class="atlas-modal-panel" data-modal-panel role="dialog" aria-modal="true" aria-labelledby="recipe-modal-title">
      <div class="atlas-modal-header">
        <div><h2 id="recipe-modal-title">New recipe</h2><p id="recipe-modal-subtitle">Build a service-ready recipe connected to live inventory.</p></div>
        <button type="button" class="atlas-modal-close" data-modal-close aria-label="Close recipe editor">×</button>
      </div>
      <form id="recipe-form" style="display:flex;flex-direction:column;min-height:0;">
        <input type="hidden" id="recipe-id" />
        <div class="atlas-modal-body">
          <section class="atlas-form-section">
            <div class="atlas-section-heading"><div><h3>Recipe details</h3><p>The information your team needs to identify and serve the recipe.</p></div></div>
            <div class="atlas-form-grid">
              <div class="atlas-field"><label for="recipe-name">Recipe name *</label><input type="text" id="recipe-name" required placeholder="e.g. Espresso Martini" /></div>
              <div class="atlas-field"><label for="recipe-category-id">Category *</label><select id="recipe-category-id" required></select></div>
              <div class="atlas-field"><label for="recipe-glassware">Glassware</label><input type="text" id="recipe-glassware" placeholder="e.g. Coupe" /></div>
              <div class="atlas-field"><label for="recipe-garnish">Garnish</label><input type="text" id="recipe-garnish" placeholder="e.g. 3 coffee beans" /></div>
              <div class="atlas-field full"><label for="recipe-image-url">Image URL</label><input type="url" id="recipe-image-url" placeholder="https://…" /></div>
            </div>
          </section>
          <section class="atlas-form-section">
            <div class="atlas-section-heading"><div><h3>Inventory-linked ingredients</h3><p>Select real inventory items. Atlas keeps the recipe connected when stock data changes.</p></div></div>
            <div class="ingredient-builder-v2">
              <div class="ingredient-column"><label for="ingredient-item">Inventory item</label><select id="ingredient-item"></select></div>
              <div class="ingredient-column"><label for="ingredient-qty">Quantity</label><input type="number" id="ingredient-qty" min="0" step="0.01" placeholder="45" /></div>
              <div class="ingredient-column"><label for="ingredient-unit">Unit</label><select id="ingredient-unit"><option value="ml">ml</option><option value="g">g</option><option value="each">each</option><option value="bottle">bottle</option><option value="can">can</option><option value="dash">dash</option><option value="tsp">tsp</option></select></div>
              <button type="button" class="ingredient-add-button" id="add-ingredient-btn">Add ingredient</button>
            </div>
            <div id="ingredient-list" class="ingredient-list-v2"></div>
          </section>
          <section class="atlas-form-section">
            <div class="atlas-section-heading"><div><h3>Service specification</h3><p>Method, yield and the details that create consistency during service.</p></div></div>
            <div class="atlas-form-grid">
              <div class="atlas-field full"><label for="recipe-method">Method</label><textarea id="recipe-method" placeholder="Shake hard with ice, then fine strain into a chilled coupe."></textarea></div>
              <div class="atlas-field"><label for="recipe-yield-qty">Recipe yield</label><input type="number" id="recipe-yield-qty" min="0.01" step="0.01" value="1" /></div>
              <div class="atlas-field"><label for="recipe-yield-unit">Yield unit</label><input type="text" id="recipe-yield-unit" value="serving" /></div>
              <div class="atlas-field full"><label for="recipe-notes">Service notes</label><textarea id="recipe-notes" placeholder="Allergens, substitutions, prep notes or service guidance."></textarea></div>
            </div>
          </section>
          <section class="atlas-form-section">
            <div class="atlas-section-heading"><div><h3>Pricing and availability</h3><p>Costing uses the linked inventory cost and package size where available.</p></div></div>
            <div class="atlas-form-grid">
              <div class="atlas-field"><label for="recipe-menu-price">Menu price (ISK)</label><input type="number" id="recipe-menu-price" min="0" step="1" placeholder="3290" /></div>
              <div class="atlas-field"><label>Availability</label><div class="recipe-toggle-row"><label class="recipe-check"><input type="checkbox" id="recipe-active" checked />Active for service</label><label class="recipe-check"><input type="checkbox" id="recipe-show-on-menu" checked />Show on public menu</label></div></div>
            </div>
            <div class="recipe-cost-strip">
              <div class="recipe-cost-box"><span>Total recipe cost</span><strong id="calc-total-cost">0 ISK</strong></div>
              <div class="recipe-cost-box"><span>Cost per serving</span><strong id="calc-cost-per-serving">0 ISK</strong></div>
              <div class="recipe-cost-box"><span>Cost percentage</span><strong id="calc-cost-pct">—</strong></div>
              <div class="recipe-cost-box"><span>Profit per serving</span><strong id="calc-profit">—</strong></div>
            </div>
            <p class="recipe-cost-note" id="recipe-cost-note">Add linked ingredients to calculate the recipe cost.</p>
            <div class="recipe-availability-note" id="recipe-availability-note"><i data-lucide="package-check"></i><span>Add linked ingredients to calculate current service availability.</span></div>
          </section>
        </div>
        <div class="atlas-modal-footer">
          <span class="recipe-save-state" id="recipe-save-state"></span>
          <div class="atlas-modal-actions"><button type="button" class="atlas-modal-secondary" data-modal-close>Cancel</button><button type="submit" class="atlas-modal-primary">Save recipe</button></div>
        </div>
      </form>
    </section>`;
  }

  function normalizeRecipeModal() {
    const root = document.getElementById('recipe-overlay');
    if (!root) return;
    root.setAttribute('data-atlas-modal', '');
    root.setAttribute('aria-hidden', 'true');
    root.hidden = true;
    root.innerHTML = recipeModalMarkup();
  }

  function replaceOptions(select, entries) {
    if (!select) return;
    select.innerHTML = entries.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  }

  function normalizeImportCenter() {
    const view = document.getElementById('imports-view');
    if (!view) return;

    const hero = view.querySelector('.import-queue-hero');
    const refresh = document.getElementById('import-queue-refresh');
    if (hero && refresh && !document.getElementById('import-queue-upload-button')) {
      const actions = document.createElement('div');
      actions.className = 'atlas-purchasing-actions';
      const upload = document.createElement('button');
      upload.type = 'button';
      upload.id = 'import-queue-upload-button';
      upload.className = 'atlas-button';
      upload.innerHTML = '<i data-lucide="file-up"></i>Upload files';
      refresh.replaceWith(actions);
      actions.append(upload, refresh);
    }

    replaceOptions(document.getElementById('import-entity-scope'), [
      ['inventory', 'Inventory'], ['recipe', 'Recipes'], ['supplier', 'Suppliers'],
      ['menu', 'Menus'], ['invoice', 'Invoices'], ['purchase', 'Purchases'], ['image', 'Images'],
    ]);
    replaceOptions(document.getElementById('import-queue-filter'), [
      ['all', 'All statuses'], ['active', 'In progress'], ['uploaded', 'Uploaded'],
      ['ready', 'Ready for review'], ['complete', 'Completed'], ['failed', 'Needs attention'],
    ]);

    const tableHead = document.querySelector('#imports-view .atlas-purchasing-table thead tr');
    if (tableHead && tableHead.children.length === 5) {
      const action = document.createElement('th');
      action.textContent = 'Actions';
      tableHead.appendChild(action);
    }

    const pipeline = document.getElementById('import-pipeline');
    if (pipeline) {
      pipeline.innerHTML = '<span data-stage="uploaded">Uploaded</span><span data-stage="reading">Reading</span><span data-stage="extracting">Extracting</span><span data-stage="matching">Matching</span><span data-stage="ready">Review</span><span data-stage="importing">Importing</span>';
    }
  }

  function ensureFocusList() {
    const host = document.getElementById('home-focus');
    if (!host) return null;
    let list = document.getElementById('focus-list');
    if (list?.parentElement === host) return list;
    list = document.createElement('div');
    list.id = 'focus-list';
    list.className = 'focus-list';
    while (host.firstChild) list.appendChild(host.firstChild);
    host.appendChild(list);
    return list;
  }

  function augmentHomeWithBrain() {
    const list = ensureFocusList();
    if (!list || !window.AtlasBrain?.recommendations) return;
    list.querySelectorAll('[data-atlas-brain-focus]').forEach((row) => row.remove());
    const recommendation = window.AtlasBrain.recommendations()[0];
    if (!recommendation) return;
    const row = document.createElement('div');
    row.className = 'focus-row';
    row.dataset.atlasBrainFocus = 'true';
    row.innerHTML = `<span class="focus-dot" style="background:var(--atlas-accent)"></span><div><strong>Atlas Brain</strong><span></span></div><span class="status-pill">Open</span>`;
    row.querySelector('span:nth-child(2)');
    const copy = row.querySelector('div span');
    if (copy) copy.textContent = `${recommendation.title}. ${recommendation.detail}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('click', () => window.AtlasNext?.navigate?.('brain'));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        window.AtlasNext?.navigate?.('brain');
      }
    });
    list.prepend(row);
  }

  function bindCompatibilityNav() {
    const nav = document.querySelector('.atlas-nav.atlas-next-compatibility');
    if (!nav || nav.dataset.atlasBound === 'true') return;
    nav.dataset.atlasBound = 'true';
    nav.addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (!button || button.dataset.itemMasterL2 === 'true') return;
      event.preventDefault();
      if (button.dataset.subview === 'Stock count') window.AtlasNextStockCounts?.open?.();
      else window.AtlasNextWorkspaces?.navigateLegacy?.(button.dataset.view);
    });
  }

  function normalize() {
    normalizeRecipeModal();
    normalizeImportCenter();
    ensureFocusList();
    bindCompatibilityNav();
    window.lucide?.createIcons?.();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    normalize();
    document.addEventListener('atlas:data', () => {
      ensureFocusList();
      window.requestAnimationFrame(augmentHomeWithBrain);
    });
    document.addEventListener('atlas:navigate', (event) => {
      if (event.detail?.view === 'home') window.requestAnimationFrame(augmentHomeWithBrain);
    });
  }

  window.AtlasNextMarkupCompat = Object.freeze({ normalize, augmentHomeWithBrain });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
