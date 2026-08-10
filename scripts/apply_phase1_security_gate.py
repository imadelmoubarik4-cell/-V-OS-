from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(content: str, old: str, new: str, label: str) -> str:
    if new in content:
        return content
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one source match, found {count}")
    return content.replace(old, new, 1)


def regex_replace_once(content: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.DOTALL)
    if count != 1:
        raise RuntimeError(f"{label}: expected one regex match, found {count}")
    return updated


def patch_index() -> None:
    path = "apps/web/index.html"
    content = read(path)
    if "PHASE1_SECURITY_GATE_UI" in content:
        return

    content = replace_once(
        content,
        '<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>\n'
        '<script src="https://unpkg.com/lucide@latest"></script>',
        '<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"\n'
        '        integrity="sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw"\n'
        '        crossorigin="anonymous"></script>\n'
        '<script src="https://unpkg.com/lucide@0.454.0/dist/umd/lucide.min.js"\n'
        '        integrity="sha384-m/CoPp6wBQz6MoZXP+VveuxfvSx0NGXiQyyakzXVOVHgG1fP5bM/UiO4pSNPV6PT"\n'
        '        crossorigin="anonymous"></script>',
        "pin XLSX and Lucide",
    )

    content = replace_once(
        content,
        "  const SUPABASE_CDN_URLS = [\n"
        "    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',\n"
        "    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js'\n"
        "  ];",
        "  const SUPABASE_CDN_URLS = [\n"
        "    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',\n"
        "    'https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'\n"
        "  ];\n"
        "  const SUPABASE_SRI = 'sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug';",
        "pin Supabase client",
    )

    content = replace_once(
        content,
        "      script.crossOrigin = 'anonymous';\n      script.onload = () => {",
        "      script.crossOrigin = 'anonymous';\n"
        "      script.integrity = SUPABASE_SRI;\n"
        "      script.onload = () => {",
        "attach Supabase SRI",
    )

    role_css = """
  /* PHASE1_SECURITY_GATE_UI
     Commercial controls are hidden unless the verified profile is manager/admin.
     Database grants and RLS remain the authoritative boundary. */
  body:not(.atlas-commercial-manager) [data-commercial-only],
  body:not(.atlas-commercial-manager) [data-default="suppliers"],
  body:not(.atlas-commercial-manager) [data-view="suppliers"],
  body:not(.atlas-commercial-manager) [data-view="imports"],
  body:not(.atlas-commercial-manager) [data-service-action="restock"],
  body:not(.atlas-commercial-manager) [data-service-action="add-item"],
  body:not(.atlas-commercial-manager) #add-item-btn,
  body:not(.atlas-commercial-manager) #add-supplier-btn,
  body:not(.atlas-commercial-manager) #add-recipe-btn,
  body:not(.atlas-commercial-manager) #recipe-library-add,
  body:not(.atlas-commercial-manager) .fab-wrap,
  body:not(.atlas-commercial-manager) .row-actions,
  body:not(.atlas-commercial-manager) .step-btn,
  body:not(.atlas-commercial-manager) [data-edit-recipe],
  body:not(.atlas-commercial-manager) [data-empty-create],
  body:not(.atlas-commercial-manager) .recipe-library-item-finance,
  body:not(.atlas-commercial-manager) .recipe-profile-ingredient > div:last-child,
  body:not(.atlas-commercial-manager) .recipe-insight-metrics > div:nth-child(-n+5),
  body:not(.atlas-commercial-manager) .recipe-featured-card,
  body:not(.atlas-commercial-manager) .recipe-cost-strip,
  body:not(.atlas-commercial-manager) .recipe-cost-note,
  body:not(.atlas-commercial-manager) .ingredient-cost-v2 {
    display:none!important;
  }
  body:not(.atlas-commercial-manager) #inventory-view .qty-input {
    pointer-events:none;
    opacity:.72;
  }
"""
    content = replace_once(
        content,
        "</style>\n  <link rel=\"stylesheet\" href=\"assets/css/operations.css\">",
        role_css + "</style>\n  <link rel=\"stylesheet\" href=\"assets/css/operations.css\">",
        "add role-aware UI CSS",
    )

    content = replace_once(
        content,
        '<div class="stat-card"><div class="label">Spent this month</div>',
        '<div class="stat-card" data-commercial-only><div class="label">Spent this month</div>',
        "mark monthly spend commercial",
    )
    content = replace_once(
        content,
        '<div class="stat-card"><div class="label">Suppliers</div>',
        '<div class="stat-card" data-commercial-only><div class="label">Suppliers</div>',
        "mark suppliers metric commercial",
    )
    content = replace_once(
        content,
        '<div class="panel"><h3>Spend by month</h3>',
        '<div class="panel" data-commercial-only><h3>Spend by month</h3>',
        "mark monthly spend panel commercial",
    )
    content = replace_once(
        content,
        '<div class="panel"><h3>Spend by supplier — this month</h3>',
        '<div class="panel" data-commercial-only><h3>Spend by supplier — this month</h3>',
        "mark supplier spend panel commercial",
    )
    content = replace_once(
        content,
        '<div class="form-field"><label for="item-quantity">Quantity</label><input type="number" id="item-quantity" step="0.1" required /></div>',
        '<div class="form-field"><label for="item-quantity">Quantity (controlled stock workflow)</label><input type="number" id="item-quantity" step="0.1" value="0" disabled /></div>',
        "lock item-master quantity field",
    )

    content = replace_once(
        content,
        "  let currentUser = null;\n  let items = [];",
        "  let currentUser = null;\n"
        "  let currentProfile = null;\n"
        "\n"
        "  function canManageCommercial() {\n"
        "    return ['admin', 'manager'].includes(currentProfile?.role);\n"
        "  }\n"
        "\n"
        "  window.atlasCanManageCommercial = canManageCommercial;\n"
        "\n"
        "  function requireCommercialManager(action = 'This action') {\n"
        "    if (canManageCommercial()) return true;\n"
        "    alert(`${action} is limited to managers and administrators.`);\n"
        "    return false;\n"
        "  }\n"
        "\n"
        "  function applyRoleVisibility() {\n"
        "    document.body.classList.toggle('atlas-commercial-manager', canManageCommercial());\n"
        "    window.atlasCurrentProfile = currentProfile\n"
        "      ? { id: currentProfile.id, role: currentProfile.role, active: currentProfile.active }\n"
        "      : null;\n"
        "    window.dispatchEvent(new CustomEvent('atlas:profile-ready', { detail: window.atlasCurrentProfile }));\n"
        "  }\n"
        "\n"
        "  function showDataBoundaryError(label) {\n"
        "    const banner = document.getElementById('low-stock-banner');\n"
        "    const copy = document.getElementById('low-stock-text');\n"
        "    if (banner && copy) {\n"
        "      banner.style.display = 'flex';\n"
        "      copy.textContent = `${label} is unavailable until the Phase 1 security migration is published.`;\n"
        "    }\n"
        "  }\n"
        "\n"
        "  let items = [];",
        "add profile role state",
    )

    old_signed_in = """  async function onSignedIn(session) {
    currentUser = session.user;
    userEmailEl.textContent = currentUser.email;
    document.getElementById('profile-name').textContent = currentUser.email.split('@')[0];
    document.getElementById('greeting-name').textContent = currentUser.email.split('@')[0];
    document.getElementById('user-avatar').textContent = currentUser.email.charAt(0).toUpperCase();
    loginScreen.style.display = 'none';
    appScreen.style.display = 'block';
    await loadAll();
    setActiveView('dashboard');
    if (window.lucide) window.lucide.createIcons();
  }
"""
    new_signed_in = """  async function loadActiveProfile(session) {
    const { data, error } = await sb
      .from('profiles')
      .select('id,email,display_name,role,active')
      .eq('id', session.user.id)
      .maybeSingle();

    const allowedRoles = new Set(['admin', 'manager', 'bartender', 'viewer']);
    if (error || !data?.active || !allowedRoles.has(data.role)) {
      await sb.auth.signOut().catch(() => null);
      throw new Error('This account is not an active VÁ staff profile. Ask an administrator to review access.');
    }
    currentProfile = data;
    applyRoleVisibility();
    return data;
  }

  async function onSignedIn(session) {
    currentUser = session.user;
    const profile = await loadActiveProfile(session);
    const displayName = profile.display_name?.trim() || currentUser.email.split('@')[0];
    userEmailEl.textContent = currentUser.email;
    document.getElementById('profile-name').textContent = displayName;
    document.getElementById('greeting-name').textContent = displayName.split(' ')[0];
    document.getElementById('user-avatar').textContent = displayName.charAt(0).toUpperCase();
    loginScreen.style.display = 'none';
    appScreen.style.display = 'block';
    await loadAll();
    setActiveView('dashboard');
    if (window.lucide) window.lucide.createIcons();
  }
"""
    content = replace_once(content, old_signed_in, new_signed_in, "verify active profile on sign-in")
    content = replace_once(content, "      onSignedIn(data.session);", "      await onSignedIn(data.session);", "await sign-in activation")

    old_load_items = """  async function loadItems() {
    const { data, error } = await sb
      .from('inventory_items')
      .select('*')
      .order('category', { ascending: true })
      .order('name', { ascending: true });
    if (error) {
      console.error(error);
      return;
    }
    items = data;
    renderTabs();
    renderTable();
  }
"""
    new_load_items = """  async function loadItems() {
    const relation = canManageCommercial() ? 'inventory_items' : 'inventory_catalog';
    const { data, error } = await sb
      .from(relation)
      .select('*')
      .order('category', { ascending: true })
      .order('name', { ascending: true });
    if (error) {
      console.error(`${relation} could not be loaded`, error);
      items = [];
      showDataBoundaryError('Inventory');
      renderTabs();
      renderTable();
      return;
    }
    items = data || [];
    renderTabs();
    renderTable();
  }
"""
    content = replace_once(content, old_load_items, new_load_items, "route inventory through redacted catalogue")

    old_load_restock = """  async function loadRestockLog() {
    const { data, error } = await sb
      .from('inventory_movements')
      .select('*, suppliers(name)')
      .eq('movement_type', 'restock')
      .order('created_at', { ascending: false });
    if (error) {
      console.error(error);
      return;
    }
    restockLog = data;
  }
"""
    new_load_restock = """  async function loadRestockLog() {
    const relation = canManageCommercial() ? 'inventory_movements' : 'inventory_movement_catalog';
    let query = sb.from(relation);
    query = canManageCommercial()
      ? query.select('*, suppliers(name)').eq('movement_type', 'restock')
      : query.select('*').eq('movement_type', 'restock');
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) {
      console.error(`${relation} could not be loaded`, error);
      restockLog = [];
      return;
    }
    restockLog = data || [];
  }
"""
    content = replace_once(content, old_load_restock, new_load_restock, "route movement history through redacted catalogue")

    old_load_recipes = """  async function loadRecipes() {
    const { data, error } = await sb
      .from('recipes')
      .select('*, recipe_ingredients(*)')
      .order('name', { ascending: true });
    if (error) {
      console.error(error);
      return;
    }
    recipes = data || [];
  }
"""
    new_load_recipes = """  async function loadRecipes() {
    if (canManageCommercial()) {
      const { data, error } = await sb
        .from('recipes')
        .select('*, recipe_ingredients(*)')
        .order('name', { ascending: true });
      if (error) {
        console.error(error);
        recipes = [];
        return;
      }
      recipes = data || [];
      return;
    }

    let result = await sb
      .from('recipe_catalog')
      .select('*')
      .order('name', { ascending: true });

    // Compatibility fallback for the draft preview before production migration.
    // It requests only operational columns and is removed as a usable path once
    // the canonical recipe tables become manager-only in production RLS.
    if (result.error) {
      result = await sb
        .from('recipes')
        .select('id,category_id,name,type,method,yield_quantity,yield_unit,menu_price,active,show_on_menu,glassware,garnish,notes,image_url,updated_at,recipe_ingredients(id,recipe_id,item_id,item_name,quantity,unit)')
        .order('name', { ascending: true });
    }
    if (result.error) {
      console.error('The staff recipe catalogue could not be loaded', result.error);
      recipes = [];
      return;
    }
    recipes = result.data || [];
  }
"""
    content = replace_once(content, old_load_recipes, new_load_recipes, "route recipes through redacted catalogue")

    old_load_suppliers = """  async function loadSuppliersData() {
    const { data, error } = await sb
      .from('suppliers')
      .select('*')
      .order('name', { ascending: true });
    if (error) {
      console.warn('Supplier list could not be loaded:', error.message);
      suppliers = [];
      return;
    }
    suppliers = data || [];
  }
"""
    new_load_suppliers = """  async function loadSuppliersData() {
    if (!canManageCommercial()) {
      suppliers = [];
      return;
    }
    const { data, error } = await sb
      .from('suppliers')
      .select('*')
      .order('name', { ascending: true });
    if (error) {
      console.warn('Supplier list could not be loaded:', error.message);
      suppliers = [];
      return;
    }
    suppliers = data || [];
  }
"""
    content = replace_once(content, old_load_suppliers, new_load_suppliers, "manager-only supplier loading")

    content = replace_once(
        content,
        '            <input type="number" step="0.1" class="qty-input mono" value="${item.quantity}" data-id="${item.id}" />',
        '            <input type="number" step="0.1" class="qty-input mono" value="${item.quantity}" data-id="${item.id}" ${canManageCommercial() ? \'\' : \'disabled\'} />',
        "disable direct quantity input for staff",
    )
    content = replace_once(
        content,
        "    async function applyQuantityChange(id, newQty) {\n      if (isNaN(newQty) || newQty < 0) return;",
        "    async function applyQuantityChange(id, newQty) {\n"
        "      if (!requireCommercialManager('Direct inventory adjustment')) return;\n"
        "      if (isNaN(newQty) || newQty < 0) return;",
        "guard direct quantity updates",
    )
    content = replace_once(
        content,
        "      btn.addEventListener('click', async () => {\n        if (!confirm('Remove this item from inventory?')) return;",
        "      btn.addEventListener('click', async () => {\n"
        "        if (!requireCommercialManager('Inventory deletion')) return;\n"
        "        if (!confirm('Remove this item from inventory?')) return;",
        "guard inventory deletion",
    )
    content = replace_once(
        content,
        "  function openModal(item) {\n    document.getElementById('modal-title').textContent = item ? 'Edit item' : 'Add item';",
        "  function openModal(item) {\n"
        "    if (!requireCommercialManager('Inventory master editing')) return;\n"
        "    document.getElementById('modal-title').textContent = item ? 'Edit item' : 'Add item';",
        "guard inventory editor",
    )
    content = replace_once(
        content,
        "    document.getElementById('item-quantity').value = item ? item.quantity : '';",
        "    document.getElementById('item-quantity').value = item ? item.quantity : 0;",
        "default item quantity to zero",
    )
    content = replace_once(
        content,
        "  itemForm.addEventListener('submit', async (e) => {\n    e.preventDefault();",
        "  itemForm.addEventListener('submit', async (e) => {\n"
        "    e.preventDefault();\n"
        "    if (!requireCommercialManager('Inventory master editing')) return;",
        "guard item form",
    )
    content = replace_once(
        content,
        "      quantity: parseFloat(document.getElementById('item-quantity').value),\n",
        "",
        "remove item quantity from master payload",
    )
    content = replace_once(
        content,
        "      discount_percent: document.getElementById('item-discount').value === '' ? 0 : parseFloat(document.getElementById('item-discount').value),\n      updated_by: currentUser.id,",
        "      discount_percent: document.getElementById('item-discount').value === '' ? 0 : parseFloat(document.getElementById('item-discount').value),",
        "remove browser-controlled inventory audit identity",
    )
    content = replace_once(
        content,
        "      await sb.from('inventory_items').insert(payload);",
        "      await sb.from('inventory_items').insert({ ...payload, quantity: 0 });",
        "start new inventory items at zero",
    )

    content = replace_once(
        content,
        "  function setActiveView(view) {\n    activeView = view;",
        "  function setActiveView(view) {\n"
        "    if (!canManageCommercial() && ['suppliers', 'imports'].includes(view)) {\n"
        "      alert('This workspace is limited to managers and administrators.');\n"
        "      view = 'dashboard';\n"
        "    }\n"
        "    activeView = view;",
        "guard commercial navigation",
    )
    content = replace_once(
        content,
        "  function openRestockModal() {\n    restockItemSelect.innerHTML = '';",
        "  function openRestockModal() {\n"
        "    if (!requireCommercialManager('Restock logging')) return;\n"
        "    restockItemSelect.innerHTML = '';",
        "guard restock modal",
    )
    content = replace_once(
        content,
        "  restockForm.addEventListener('submit', async (e) => {\n    e.preventDefault();",
        "  restockForm.addEventListener('submit', async (e) => {\n"
        "    e.preventDefault();\n"
        "    if (!requireCommercialManager('Restock logging')) return;",
        "guard restock submission",
    )
    content = replace_once(
        content,
        "  function openSupplierModal(){\n    supplierForm.reset();",
        "  function openSupplierModal(){\n"
        "    if (!requireCommercialManager('Supplier management')) return;\n"
        "    supplierForm.reset();",
        "guard supplier modal",
    )
    content = replace_once(
        content,
        "  supplierForm.addEventListener('submit',async event=>{\n    event.preventDefault();",
        "  supplierForm.addEventListener('submit',async event=>{\n"
        "    event.preventDefault();\n"
        "    if (!requireCommercialManager('Supplier management')) return;",
        "guard supplier submission",
    )

    content = re.sub(
        r"\n\s*updated_by:\s*currentUser(?:\.id|\?\.id)?(?:\s*\|\|\s*null)?,?",
        "",
        content,
    )
    write(path, content)


def patch_recipes() -> None:
    path = "apps/web/assets/js/recipes.js"
    content = read(path)
    if "PHASE1_RECIPE_ROLE_GATE" in content:
        return

    content = replace_once(
        content,
        "  const dom = {};\n",
        "  const dom = {};\n\n"
        "  // PHASE1_RECIPE_ROLE_GATE\n"
        "  function canManageCommercial() {\n"
        "    return typeof window.atlasCanManageCommercial === 'function'\n"
        "      && window.atlasCanManageCommercial();\n"
        "  }\n",
        "add recipe role helper",
    )
    content = replace_once(
        content,
        "  async function openEditor(recipe) {\n    await loadCategories();",
        "  async function openEditor(recipe) {\n"
        "    if (!canManageCommercial()) {\n"
        "      alert('Recipe editing is limited to managers and administrators.');\n"
        "      return;\n"
        "    }\n"
        "    await loadCategories();",
        "guard recipe editor",
    )
    content = replace_once(
        content,
        "  async function saveRecipe(event) {\n    event.preventDefault();",
        "  async function saveRecipe(event) {\n"
        "    event.preventDefault();\n"
        "    if (!canManageCommercial()) {\n"
        "      alert('Recipe editing is limited to managers and administrators.');\n"
        "      return;\n"
        "    }",
        "guard recipe save",
    )
    content = replace_once(
        content,
        "        show_on_menu: document.getElementById('recipe-show-on-menu').checked,\n        updated_by: currentUser?.id || null",
        "        show_on_menu: document.getElementById('recipe-show-on-menu').checked",
        "remove browser-controlled recipe audit identity",
    )
    content = replace_once(
        content,
        "      return `<button type=\"button\" class=\"recipe-library-item ${recipe.id === state.selectedRecipeId ? 'selected' : ''}\" data-recipe-id=\"${escape(recipe.id)}\">\n        <span class=\"recipe-library-item-top\"><strong>${escape(recipe.name)}</strong><span class=\"recipe-health-dot ${status.className}\" aria-label=\"${escape(status.label)}\"></span></span>\n        <span class=\"recipe-library-item-meta\">${escape(category.name)}<span>${Number.isFinite(status.availability.servings) ? `${status.availability.servings} servings` : status.label}</span></span>\n        <span class=\"recipe-library-item-finance\"><span>${financials.incomplete ? 'Cost incomplete' : formatIsk(financials.perServing)}</span><span>${Number.isFinite(financials.margin) && !financials.incomplete ? `${financials.margin.toFixed(0)}% margin` : 'Margin unavailable'}</span></span>\n      </button>`;",
        "      const financeMarkup = canManageCommercial()\n"
        "        ? `<span class=\"recipe-library-item-finance\"><span>${financials.incomplete ? 'Cost incomplete' : formatIsk(financials.perServing)}</span><span>${Number.isFinite(financials.margin) && !financials.incomplete ? `${financials.margin.toFixed(0)}% margin` : 'Margin unavailable'}</span></span>`\n"
        "        : '';\n"
        "      return `<button type=\"button\" class=\"recipe-library-item ${recipe.id === state.selectedRecipeId ? 'selected' : ''}\" data-recipe-id=\"${escape(recipe.id)}\">\n"
        "        <span class=\"recipe-library-item-top\"><strong>${escape(recipe.name)}</strong><span class=\"recipe-health-dot ${status.className}\" aria-label=\"${escape(status.label)}\"></span></span>\n"
        "        <span class=\"recipe-library-item-meta\">${escape(category.name)}<span>${Number.isFinite(status.availability.servings) ? `${status.availability.servings} servings` : status.label}</span></span>\n"
        "        ${financeMarkup}\n"
        "      </button>`;",
        "remove staff recipe finance markup",
    )
    content = replace_once(
        content,
        "      return `<div class=\"recipe-profile-ingredient ${rowClass}\">\n        <div><strong>${escape(ingredient.item_name)}</strong><span>${number(ingredient.quantity)} ${escape(ingredient.unit)} per recipe</span></div>\n        <div><span>Stock</span><strong>${stock}</strong></div>\n        <div><span>Coverage</span><strong>${Number.isFinite(servings) ? `${servings} servings` : escape(availability.reason || 'Unknown')}</strong></div>\n        <div><span>Cost</span><strong>${cost.value == null ? 'Incomplete' : formatIsk(cost.value)}</strong></div>\n      </div>`;",
        "      const costMarkup = canManageCommercial()\n"
        "        ? `<div><span>Cost</span><strong>${cost.value == null ? 'Incomplete' : formatIsk(cost.value)}</strong></div>`\n"
        "        : '';\n"
        "      return `<div class=\"recipe-profile-ingredient ${rowClass}\">\n"
        "        <div><strong>${escape(ingredient.item_name)}</strong><span>${number(ingredient.quantity)} ${escape(ingredient.unit)} per recipe</span></div>\n"
        "        <div><span>Stock</span><strong>${stock}</strong></div>\n"
        "        <div><span>Coverage</span><strong>${Number.isFinite(servings) ? `${servings} servings` : escape(availability.reason || 'Unknown')}</strong></div>\n"
        "        ${costMarkup}\n"
        "      </div>`;",
        "remove staff ingredient cost markup",
    )

    old_metrics = """      <div class="recipe-insight-metrics">
        <div><span>Menu price</span><strong>${Number.isFinite(number(recipe.menu_price, NaN)) ? formatIsk(number(recipe.menu_price)) : 'Not set'}</strong></div>
        <div><span>Cost per serving</span><strong>${financials.incomplete ? 'Incomplete' : formatIsk(financials.perServing)}</strong></div>
        <div><span>Cost percentage</span><strong>${Number.isFinite(financials.costPercent) && !financials.incomplete ? `${financials.costPercent.toFixed(1)}%` : '—'}</strong></div>
        <div><span>Gross margin</span><strong>${Number.isFinite(financials.margin) && !financials.incomplete ? `${financials.margin.toFixed(1)}%` : '—'}</strong></div>
        <div><span>Profit per serving</span><strong>${Number.isFinite(financials.profit) && !financials.incomplete ? formatIsk(financials.profit) : '—'}</strong></div>
        <div><span>Current coverage</span><strong>${Number.isFinite(status.availability.servings) ? `${status.availability.servings} servings` : 'Unknown'}</strong></div>
      </div>
"""
    new_metrics = """      <div class="recipe-insight-metrics">
        ${canManageCommercial() ? `<div><span>Menu price</span><strong>${Number.isFinite(number(recipe.menu_price, NaN)) ? formatIsk(number(recipe.menu_price)) : 'Not set'}</strong></div>
        <div><span>Cost per serving</span><strong>${financials.incomplete ? 'Incomplete' : formatIsk(financials.perServing)}</strong></div>
        <div><span>Cost percentage</span><strong>${Number.isFinite(financials.costPercent) && !financials.incomplete ? `${financials.costPercent.toFixed(1)}%` : '—'}</strong></div>
        <div><span>Gross margin</span><strong>${Number.isFinite(financials.margin) && !financials.incomplete ? `${financials.margin.toFixed(1)}%` : '—'}</strong></div>
        <div><span>Profit per serving</span><strong>${Number.isFinite(financials.profit) && !financials.incomplete ? formatIsk(financials.profit) : '—'}</strong></div>` : ''}
        <div><span>Current coverage</span><strong>${Number.isFinite(status.availability.servings) ? `${status.availability.servings} servings` : 'Unknown'}</strong></div>
      </div>
"""
    content = replace_once(content, old_metrics, new_metrics, "remove staff insight finance markup")
    write(path, content)


def patch_stock_count_edge() -> None:
    path = "supabase/functions/atlas-stock-counts/entrypoint.ts"
    content = read(path)
    if "const commercialAccess = MANAGER_ROLES.has(context.profile.role);" in content:
        return

    replacement = r'''async function productionInventory(context: Context): Promise<JsonObject[]> {
  const commercialAccess = MANAGER_ROLES.has(context.profile.role);
  const safeFields = [
    "id", "name", "category", "quantity", "unit", "par_level", "bin_location", "sku", "barcode",
    "updated_at", "active", "units_per_case", "size_ml", "package_size",
  ].join(",");
  const commercialFields = [
    safeFields,
    "source_updated_at", "source_file", "supplier", "supplier_id", "supplier_product_reference",
    "case_cost", "cost_price", "critical_minimum", "lead_time_days", "minimum_order_quantity",
  ].join(",");

  async function readRelation(relation: string, select: string): Promise<Response> {
    const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/${relation}`);
    url.searchParams.set("select", select);
    url.searchParams.set("active", "eq.true");
    url.searchParams.set("order", "bin_location.asc.nullslast,category.asc,name.asc");
    url.searchParams.set("limit", String(MAX_INVENTORY_ROWS));
    return await fetch(url, {
      headers: {
        apikey: AUTH_PUBLISHABLE_KEY,
        authorization: `Bearer ${context.token}`,
        accept: "application/json",
        "cache-control": "no-store",
        range: `0-${MAX_INVENTORY_ROWS - 1}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
  }

  let response = await readRelation(
    commercialAccess ? "inventory_items" : "inventory_catalog",
    commercialAccess ? commercialFields : safeFields,
  );

  // Draft-preview compatibility before the production security migration. The
  // fallback still selects only redacted columns and disappears once the view exists.
  if (!commercialAccess && !response.ok) {
    response = await readRelation("inventory_items", safeFields);
  }

  const text = await response.text();
  let parsed: unknown = [];
  try { parsed = text ? JSON.parse(text) : []; } catch { parsed = []; }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String((parsed as { message: unknown }).message)
      : "The production inventory catalog could not be read.";
    throw new ApiError(response.status === 401 ? 401 : response.status === 403 ? 403 : 400, message);
  }
  return Array.isArray(parsed)
    ? parsed.filter((row): row is JsonObject => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

function branchCredentials'''
    content = regex_replace_once(
        content,
        r"async function productionInventory\(context: Context\): Promise<JsonObject\[]> \{.*?\n\}\n\nfunction branchCredentials",
        replacement,
        "redact stock-count inventory by role",
    )
    write(path, content)


def patch_scanner_edge() -> None:
    path = "supabase/functions/atlas-inventory-scanner/index.ts"
    content = read(path)
    marker = "requireManager(context);\n\n      if (Math.abs(observedQuantity - previousQuantity)"
    if marker in content:
        return
    content = replace_once(
        content,
        "      }\n\n      if (Math.abs(observedQuantity - previousQuantity) < 0.0000001) {",
        "      }\n\n"
        "      // Shadow observations remain available to operational staff. Any\n"
        "      // production mutation, including a no-change live acknowledgement,\n"
        "      // requires a freshly verified manager/admin profile.\n"
        "      requireManager(context);\n\n"
        "      if (Math.abs(observedQuantity - previousQuantity) < 0.0000001) {",
        "manager-gate scanner live path",
    )
    write(path, content)


def patch_menu() -> None:
    path = "apps/web/menu.html"
    content = read(path)
    if "sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug" in content:
        return
    content = replace_once(
        content,
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"\n'
        '        integrity="sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug"\n'
        '        crossorigin="anonymous"></script>',
        "pin public menu Supabase client",
    )
    write(path, content)


def write_netlify() -> None:
    write(
        "netlify.toml",
        '''[build]
  publish = "apps/web"

[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Strict-Transport-Security = "max-age=63072000; includeSubDomains"
    Permissions-Policy = "camera=(self), microphone=(), geolocation=(), payment=()"
    Content-Security-Policy = "default-src 'self'; script-src 'self' 'unsafe-inline' blob: https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://api.qrserver.com https://dnefgcmjcgxlynycxkts.supabase.co https://uhbamqetppqmygesoeeh.supabase.co; connect-src 'self' https://dnefgcmjcgxlynycxkts.supabase.co wss://dnefgcmjcgxlynycxkts.supabase.co https://uhbamqetppqmygesoeeh.supabase.co wss://uhbamqetppqmygesoeeh.supabase.co; worker-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'self' https://xn--vbar-5na.is; base-uri 'self'; form-action 'self'; object-src 'none'"
''',
    )


def patch_workflow() -> None:
    path = ".github/workflows/atlas-verify.yml"
    content = read(path)
    if "node --check apps/web/assets/js/recipes.js" not in content:
        content = replace_once(
            content,
            "          node --check apps/web/assets/js/system-workspace.js\n",
            "          node --check apps/web/assets/js/system-workspace.js\n"
            "          node --check apps/web/assets/js/recipes.js\n"
            "          node --check apps/web/assets/js/import-center.js\n",
            "extend browser syntax checks",
        )
    write(path, content)


def write_tests() -> None:
    write(
        "tests/node/security-supply-chain.test.js",
        r'''import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const index = readFileSync('apps/web/index.html', 'utf8');
const menu = readFileSync('apps/web/menu.html', 'utf8');
const config = readFileSync('apps/web/config.js', 'utf8');
const netlify = readFileSync('netlify.toml', 'utf8');
const browser = index + menu + config;

const SUPABASE_SRI = 'sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug';
const LUCIDE_SRI = 'sha384-m/CoPp6wBQz6MoZXP+VveuxfvSx0NGXiQyyakzXVOVHgG1fP5bM/UiO4pSNPV6PT';
const XLSX_SRI = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';

test('browser dependencies are pinned with reviewed integrity hashes', () => {
  assert.doesNotMatch(browser, /@latest|supabase-js@2(?:[/'\"])/i);
  assert.match(index, /xlsx@0\.18\.5/);
  assert.match(index, /lucide@0\.454\.0/);
  assert.match(index + menu, /supabase-js@2\.45\.4/g);
  for (const hash of [SUPABASE_SRI, LUCIDE_SRI, XLSX_SRI]) assert.ok(browser.includes(hash), `Missing reviewed SRI hash ${hash}`);
  assert.match(index, /script\.integrity\s*=\s*SUPABASE_SRI/);
  assert.match(browser, /crossorigin="anonymous"/i);
});

test('no service-role credential is shipped to the browser', () => {
  assert.doesNotMatch(browser, /SUPABASE_SERVICE_ROLE_KEY|service_role\s*[:=]\s*['"][A-Za-z0-9._-]+/i);
  assert.doesNotMatch(browser, /sb_secret_[A-Za-z0-9_-]+/i);
});

test('Netlify headers cover transport, browser capabilities and both Supabase projects', () => {
  assert.match(netlify, /Strict-Transport-Security/);
  assert.match(netlify, /Permissions-Policy\s*=\s*"camera=\(self\), microphone=\(\), geolocation=\(\), payment=\(\)"/);
  assert.match(netlify, /Content-Security-Policy/);
  assert.match(netlify, /dnefgcmjcgxlynycxkts\.supabase\.co/);
  assert.match(netlify, /uhbamqetppqmygesoeeh\.supabase\.co/);
  assert.match(netlify, /frame-ancestors 'self' https:\/\/xn--vbar-5na\.is/);
  assert.match(netlify, /script-src[^\n]*blob:/);
  assert.doesNotMatch(netlify, /X-Frame-Options/);
});

test('commercial browser paths are profile-gated and use redacted staff catalogues', () => {
  assert.match(index, /loadActiveProfile/);
  assert.match(index, /inventory_catalog/);
  assert.match(index, /inventory_movement_catalog/);
  assert.match(index, /recipe_catalog/);
  assert.match(index, /atlas-commercial-manager/);
  assert.doesNotMatch(index, /updated_by:\s*currentUser(?:\.id|\?\.id)?/);
});
''',
    )

    write(
        "tests/python/test_phase1_security_gate.py",
        r'''from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
PHASE1 = (ROOT / "supabase/migrations/20260806104705_atlas_phase1_profiles_security_gate.sql").read_text()
RECIPES = (ROOT / "supabase/migrations/20260806105543_atlas_phase1_recipe_catalog_gate.sql").read_text()
INDEX = (ROOT / "apps/web/index.html").read_text()
STOCK_EDGE = (ROOT / "supabase/functions/atlas-stock-counts/entrypoint.ts").read_text()
SCANNER_EDGE = (ROOT / "supabase/functions/atlas-inventory-scanner/index.ts").read_text()
VERIFY_SQL = (ROOT / "scripts/verify_phase1_security_gate.sql").read_text()


class Phase1SecurityGateTests(unittest.TestCase):
    def test_profiles_is_the_only_authorization_registry(self):
        self.assertIn("public.profiles", PHASE1)
        self.assertIn("public.staff must not coexist", PHASE1)
        self.assertIn("'viewer'::public.staff_role", PHASE1)
        self.assertRegex(PHASE1, r"alter column active set default false")
        self.assertNotIn("create table public.staff", PHASE1.lower())

    def test_accidental_signup_never_creates_active_operational_access(self):
        self.assertIn("create or replace function public.handle_new_user", PHASE1)
        self.assertIn("'viewer'::public.staff_role", PHASE1)
        self.assertIn("false", PHASE1)
        self.assertIn("profiles_preserve_active_admin", PHASE1)

    def test_all_public_tables_are_rls_enabled_and_default_grants_are_closed(self):
        self.assertIn("alter table public.%I enable row level security", PHASE1)
        self.assertIn("revoke all privileges on table public.%I from public, anon, authenticated", PHASE1)
        self.assertIn("alter default privileges for role postgres in schema public", PHASE1)
        self.assertIn("grant all on tables to service_role", PHASE1)

    def test_commercial_tables_are_manager_only_and_staff_use_redacted_views(self):
        for table in ("inventory_items", "inventory_movements", "suppliers"):
            self.assertIn(table, PHASE1)
        self.assertIn("active managers read inventory items", PHASE1)
        self.assertIn("active managers read suppliers", PHASE1)
        self.assertIn("public.inventory_catalog", PHASE1)
        self.assertIn("public.inventory_movement_catalog", PHASE1)
        for field in ("cost_price", "case_cost", "supplier_id", "supplier_product_reference"):
            self.assertIn(field, PHASE1)
        self.assertIn("Existing inventory_catalog exposes forbidden columns", PHASE1)

    def test_recipe_cost_fields_are_hidden_behind_a_staff_catalogue(self):
        self.assertIn("active managers read recipes", RECIPES)
        self.assertIn("active managers read recipe ingredients", RECIPES)
        self.assertIn("private.read_recipe_catalog", RECIPES)
        self.assertIn("public.recipe_catalog", RECIPES)
        self.assertNotIn("unit_cost", RECIPES)
        self.assertNotIn("total_cost", RECIPES)

    def test_stock_count_views_are_split_by_sensitivity(self):
        self.assertIn("public.stock_count_summary", PHASE1)
        self.assertIn("public.stock_count_manager_summary", PHASE1)
        self.assertIn("No verifier identity, variance, supplier or cost fields", PHASE1)
        self.assertIn("Stock-count verification evidence is manager-only", PHASE1)
        self.assertGreaterEqual(PHASE1.count("security_invoker = true"), 4)

    def test_public_menu_is_the_explicit_four_column_exception(self):
        self.assertIn("security_invoker = false", PHASE1)
        self.assertIn("array['id', 'name', 'type', 'menu_price']", PHASE1)
        self.assertIn("grant select on table public.public_menu to anon", PHASE1)

    def test_inventory_adjustments_and_audit_identity_are_server_controlled(self):
        self.assertIn("Controlled inventory adjustments require an active manager", PHASE1)
        self.assertIn("atlas.allow_inventory_quantity_change", PHASE1)
        self.assertIn("insert into public.inventory_movements", PHASE1)
        self.assertIn("alter column updated_by set default", PHASE1)
        self.assertNotIn("updated_by: currentUser", INDEX)

    def test_staff_edge_payloads_are_redacted_and_live_scanner_is_manager_gated(self):
        self.assertIn("commercialAccess = MANAGER_ROLES.has", STOCK_EDGE)
        self.assertIn("inventory_catalog", STOCK_EDGE)
        self.assertIn("safeFields", STOCK_EDGE)
        live_gate = SCANNER_EDGE.index("requireManager(context);")
        live_apply = SCANNER_EDGE.index("applyLiveCount(context")
        self.assertLess(live_gate, live_apply)

    def test_verification_script_checks_tables_views_functions_and_fingerprint(self):
        for token in (
            "tables_without_rls",
            "unsafe_non_public_views",
            "browser_function_exposure",
            "inventory_records",
            "inventory_movements",
        ):
            self.assertIn(token, VERIFY_SQL)


if __name__ == "__main__":
    unittest.main()
''',
    )


def write_verification_sql() -> None:
    write(
        "scripts/verify_phase1_security_gate.sql",
        '''-- Read-only Phase 1 security verification. Safe to run before and after
-- production migration. Any non-empty exception list is a release blocker.

with public_tables as (
  select c.oid, c.relname, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
), public_views as (
  select c.oid, c.relname, coalesce(c.reloptions, array[]::text[]) as reloptions
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
), browser_functions as (
  select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (
      has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute')
    )
    and p.proname <> 'adjust_inventory'
), fingerprint as (
  select
    count(*) as inventory_records,
    count(*) filter (where active) as active_inventory_records,
    coalesce(sum(quantity), 0) as total_quantity,
    (select count(*) from public.inventory_movements) as inventory_movements
  from public.inventory_items
)
select jsonb_build_object(
  'checked_at', now(),
  'canonical_registry', jsonb_build_object(
    'profiles_exists', to_regclass('public.profiles') is not null,
    'staff_exists', to_regclass('public.staff') is not null,
    'active_admins', (select count(*) from public.profiles where active and role::text = 'admin')
  ),
  'tables_without_rls', coalesce((
    select jsonb_agg(relname order by relname)
    from public_tables
    where not relrowsecurity
  ), '[]'::jsonb),
  'unsafe_non_public_views', coalesce((
    select jsonb_agg(jsonb_build_object(
      'view', relname,
      'security_invoker', 'security_invoker=true' = any(reloptions),
      'anon_select', has_table_privilege('anon', oid, 'select')
    ) order by relname)
    from public_views
    where relname <> 'public_menu'
      and (
        not ('security_invoker=true' = any(reloptions))
        or has_table_privilege('anon', oid, 'select')
      )
  ), '[]'::jsonb),
  'public_menu', (
    select jsonb_build_object(
      'columns', (select jsonb_agg(column_name order by ordinal_position)
                  from information_schema.columns
                  where table_schema = 'public' and table_name = 'public_menu'),
      'anon_select', has_table_privilege('anon', oid, 'select'),
      'security_invoker', 'security_invoker=true' = any(reloptions)
    )
    from public_views where relname = 'public_menu'
  ),
  'browser_function_exposure', coalesce((
    select jsonb_agg(jsonb_build_object('function', proname, 'args', args) order by proname, args)
    from browser_functions
  ), '[]'::jsonb),
  'redacted_views', jsonb_build_object(
    'inventory_catalog', to_regclass('public.inventory_catalog') is not null,
    'inventory_movement_catalog', to_regclass('public.inventory_movement_catalog') is not null,
    'recipe_catalog', to_regclass('public.recipe_catalog') is not null,
    'stock_count_summary', to_regclass('public.stock_count_summary') is not null,
    'stock_count_manager_summary', to_regclass('public.stock_count_manager_summary') is not null
  ),
  'fingerprint', (select to_jsonb(fingerprint) from fingerprint)
) as phase1_security_gate;
''',
    )


def write_docs() -> None:
    write(
        "docs/PHASE1_SECURITY_GATE.md",
        '''# Phase 1 — VÁ OS / Atlas security gate

## Decision

`public.profiles` is the single authorization registry. The business owner maps
to `admin`; `manager` and `bartender` remain operational roles; `viewer` is
retained as read-only compatibility. `public.staff` must not coexist.

The database is the authoritative boundary. Browser hiding is usability only.

## Preview implementation

The isolated Atlas Supabase branch contains:

- `20260806104705_atlas_phase1_profiles_security_gate.sql`
- `20260806105543_atlas_phase1_recipe_catalog_gate.sql`

Together they default new profiles to inactive viewers, protect the final active
administrator, enable RLS across all public base tables, reset grants and default
grants, install active-role policies, route staff through redacted inventory,
movement, recipe and stock-count views, and keep direct commercial tables
manager-only.

`public.public_menu` is the deliberate exception. It exposes exactly `id`,
`name`, `type` and `menu_price` to anonymous visitors.

Production application is intentionally paused.

## Manual authentication gates — required before production SQL

Record evidence for each item:

- [ ] Supabase Email signup disabled.
- [ ] Email confirmation enabled.
- [ ] Five staff invited manually.
- [ ] Leaked-password protection enabled.
- [ ] Minimum password length is at least 10.
- [ ] JWT expiry and Auth rate limits reviewed.
- [ ] 2FA enabled on Supabase, GitHub and Netlify.
- [ ] GitHub Secret scanning and Push protection enabled.
- [ ] Netlify environment variables and build hooks reviewed.

Do not apply the production migration until these are checked.

## Back up before production

Save outside the public repository:

1. schema-only database dump;
2. exports of every affected table;
3. migration ledger;
4. policy and grant inventory;
5. public view definitions;
6. deployed commit SHA;
7. current role/profile list;
8. output of `scripts/verify_phase1_security_gate.sql`.

Expected pre-migration production fingerprint:

- inventory records: 49
- summed quantity: 131.2
- inventory movements: 12

## Production order

1. Confirm all manual authentication gates.
2. Verify `imadelmoubarik4@gmail.com` is active `admin`.
3. Create the backups above.
4. Apply `20260806104705_atlas_phase1_profiles_security_gate.sql`.
5. Apply `20260806105543_atlas_phase1_recipe_catalog_gate.sql`.
6. Run `scripts/verify_phase1_security_gate.sql`.
7. Deploy the browser and Netlify hardening commit.
8. Run the role matrix below.
9. Re-run the fingerprint and compare it with the baseline.
10. Keep PR #5 draft until every result is recorded.

## Role acceptance matrix

| Test | Expected |
|---|---|
| Logged-out visitor opens `menu.html` | Allowed |
| Anonymous inventory query | Denied |
| Unlisted or inactive account | No Atlas access |
| Bartender reads inventory | Redacted `inventory_catalog` only |
| Bartender reads recipe | Redacted `recipe_catalog` only |
| Bartender reads cost, supplier terms or variance identity | Denied |
| Bartender records an L1 observation | Allowed |
| Bartender directly changes live quantity | Denied |
| Bartender changes cost or deletes an item | Denied |
| Manager reads commercial fields | Allowed |
| Manager publishes an approved count | Controlled L1 publication only |
| Browser calls private L1/L2 tables | Denied |
| Preview publication | Blocked |
| L2 publication changes quantity or creates a movement | Never |

## Rollback

Do not restore the old permissive policies as an emergency shortcut. Roll back
the web deployment first, then restore the pre-migration schema/policy snapshot
inside a maintenance window. The database migration is deliberately designed to
fail before changing policy if no active administrator exists.
''',
    )


if __name__ == "__main__":
    patch_index()
    patch_recipes()
    patch_stock_count_edge()
    patch_scanner_edge()
    patch_menu()
    write_netlify()
    patch_workflow()
    write_verification_sql()
    write_docs()
    write_tests()
    print("Phase 1 security gate repository hardening applied.")
