(function (global) {
  'use strict';

  class AtlasDataError extends Error {
    constructor(operation, cause, context = {}) {
      const message = cause?.message || String(cause || 'Unknown data error');
      super(`${operation} failed: ${message}`);
      this.name = 'AtlasDataError';
      this.operation = operation;
      this.code = cause?.code || null;
      this.status = cause?.status || null;
      this.context = { ...context };
      this.cause = cause || null;
    }
  }

  const STAFF_RECIPE_COLUMNS = [
    'id',
    'category_id',
    'name',
    'type',
    'method',
    'yield_quantity',
    'yield_unit',
    'menu_price',
    'active',
    'show_on_menu',
    'glassware',
    'garnish',
    'notes',
    'image_url',
    'updated_at',
    'recipe_ingredients(id,recipe_id,item_id,item_name,quantity,unit)'
  ].join(',');

  function getClient() {
    const client = global.atlasSupabase;
    if (!client?.from || !client?.rpc || !client?.auth) {
      throw new AtlasDataError(
        'getClient',
        new Error('The shared Atlas Supabase client is not ready.')
      );
    }
    return client;
  }

  function fail(operation, result, context) {
    if (result?.error) throw new AtlasDataError(operation, result.error, context);
    return result?.data ?? null;
  }

  function cleanText(value) {
    const text = String(value ?? '').trim();
    return text || null;
  }

  async function getActiveProfile(user_id) {
    if (!user_id) throw new AtlasDataError('getActiveProfile', new Error('user_id is required'));
    const result = await getClient()
      .from('profiles')
      .select('id,email,display_name,role,active')
      .eq('id', user_id)
      .maybeSingle();
    return fail('getActiveProfile', result, { user_id });
  }

  async function getItems({ can_manage_commercial = false } = {}) {
    const relation = can_manage_commercial ? 'inventory_items' : 'inventory_catalog';
    const result = await getClient()
      .from(relation)
      .select('*')
      .order('category', { ascending: true })
      .order('name', { ascending: true });
    return fail('getItems', result, { relation }) || [];
  }

  async function getInventoryMovements({
    can_manage_commercial = false,
    movement_type = 'restock'
  } = {}) {
    const relation = can_manage_commercial
      ? 'inventory_movements'
      : 'inventory_movement_catalog';
    let query = getClient().from(relation);
    query = can_manage_commercial
      ? query.select('*, suppliers(name)')
      : query.select('*');
    if (movement_type) query = query.eq('movement_type', movement_type);
    const result = await query.order('created_at', { ascending: false });
    return fail('getInventoryMovements', result, { relation, movement_type }) || [];
  }

  async function getRecipes({ can_manage_commercial = false } = {}) {
    const client = getClient();
    if (can_manage_commercial) {
      const result = await client
        .from('recipes')
        .select('*, recipe_ingredients(*)')
        .order('name', { ascending: true });
      return fail('getRecipes', result, { relation: 'recipes' }) || [];
    }

    let result = await client
      .from('recipe_catalog')
      .select('*')
      .order('name', { ascending: true });

    // Compatibility is intentionally limited to operational, non-commercial
    // fields while the production recipe catalogue migration is rolled out.
    if (result.error) {
      result = await client
        .from('recipes')
        .select(STAFF_RECIPE_COLUMNS)
        .order('name', { ascending: true });
    }
    return fail('getRecipes', result, { relation: 'recipe_catalog' }) || [];
  }

  async function getSuppliers({ can_manage_commercial = false } = {}) {
    if (!can_manage_commercial) return [];
    const result = await getClient()
      .from('suppliers')
      .select('*')
      .order('name', { ascending: true });
    return fail('getSuppliers', result, { relation: 'suppliers' }) || [];
  }

  async function saveItem({ id = null, payload = {} } = {}) {
    const client = getClient();
    const record = { ...payload };
    let result;
    if (id) {
      result = await client
        .from('inventory_items')
        .update(record)
        .eq('id', id)
        .select('*')
        .maybeSingle();
    } else {
      result = await client
        .from('inventory_items')
        .insert({ ...record, quantity: 0 })
        .select('*')
        .single();
    }
    return fail('saveItem', result, { id });
  }

  async function deleteItem(id) {
    if (!id) throw new AtlasDataError('deleteItem', new Error('id is required'));
    const result = await getClient()
      .from('inventory_items')
      .delete()
      .eq('id', id);
    fail('deleteItem', result, { id });
    return true;
  }

  async function adjustInventory({
    item_id,
    quantity_change,
    movement_type,
    unit_cost = null,
    supplier_id = null,
    note = null
  } = {}) {
    const result = await getClient().rpc('adjust_inventory', {
      p_item_id: item_id,
      p_quantity_change: quantity_change,
      p_movement_type: movement_type,
      p_unit_cost: unit_cost,
      p_supplier_id: supplier_id,
      p_note: note
    });
    return fail('adjustInventory', result, { item_id, movement_type });
  }

  async function findSupplierByName(name) {
    const normalized_name = cleanText(name);
    if (!normalized_name) return null;
    const result = await getClient()
      .from('suppliers')
      .select('id,name')
      .ilike('name', normalized_name)
      .maybeSingle();
    return fail('findSupplierByName', result, { name: normalized_name });
  }

  async function createSupplier(payload = {}) {
    const normalized = {
      name: cleanText(payload.name),
      contact_name: cleanText(payload.contact_name),
      email: cleanText(payload.email),
      phone: cleanText(payload.phone),
      notes: cleanText(payload.notes)
    };
    if (!normalized.name) {
      throw new AtlasDataError('createSupplier', new Error('name is required'));
    }

    let result = await getClient()
      .from('suppliers')
      .insert(normalized)
      .select('*')
      .single();

    // Older hosted supplier tables may contain only the name column. Preserve
    // the existing compatibility behavior without leaking it into the UI.
    if (result.error) {
      result = await getClient()
        .from('suppliers')
        .insert({ name: normalized.name })
        .select('*')
        .single();
    }
    return fail('createSupplier', result, { name: normalized.name });
  }

  async function ensureSupplier(name) {
    const normalized_name = cleanText(name);
    if (!normalized_name) return null;
    const existing = await findSupplierByName(normalized_name);
    if (existing?.id) return existing;
    return createSupplier({ name: normalized_name });
  }

  async function getPublicMenuItems() {
    const result = await getClient()
      .from('public_menu')
      .select('id,name,type,menu_price')
      .order('type', { ascending: true })
      .order('name', { ascending: true });
    return fail('getPublicMenuItems', result, { relation: 'public_menu' }) || [];
  }

  global.AtlasData = Object.freeze({
    AtlasDataError,
    getActiveProfile,
    getItems,
    getInventoryMovements,
    getRecipes,
    getSuppliers,
    saveItem,
    deleteItem,
    adjustInventory,
    findSupplierByName,
    createSupplier,
    ensureSupplier,
    getPublicMenuItems
  });
})(window);
