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

  const INVENTORY_MASTER_FIELDS = Object.freeze([
    'name',
    'category',
    'unit',
    'par_level',
    'supplier',
    'supplier_id',
    'sku',
    'barcode',
    'bin_location',
    'units_per_case',
    'case_cost',
    'cost_price',
    'discount_percent',
    'size_ml',
    'package_size',
    'sell_price',
    'image_url',
    'active'
  ]);

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

  let configuredClient = null;

  function configure(nextClient) {
    if (!nextClient?.from || !nextClient?.rpc || !nextClient?.auth) {
      throw new AtlasDataError(
        'configure',
        new Error('A complete shared Atlas Supabase client is required.')
      );
    }
    configuredClient = nextClient;
    return global.AtlasData;
  }

  function getClient() {
    const client = configuredClient || global.atlasSupabase;
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

  function pickFields(payload, allowedFields) {
    const source = payload && typeof payload === 'object' ? payload : {};
    return allowedFields.reduce((record, field) => {
      if (Object.prototype.hasOwnProperty.call(source, field)) record[field] = source[field];
      return record;
    }, {});
  }

  async function getActiveProfile(userId) {
    if (!userId) throw new AtlasDataError('getActiveProfile', new Error('userId is required'));
    const result = await getClient()
      .from('profiles')
      .select('id,email,display_name,role,active')
      .eq('id', userId)
      .maybeSingle();
    return fail('getActiveProfile', result, { userId });
  }

  async function getItems({ canManageCommercial = false } = {}) {
    const relation = canManageCommercial ? 'inventory_items' : 'inventory_catalog';
    const result = await getClient()
      .from(relation)
      .select('*')
      .order('category', { ascending: true })
      .order('name', { ascending: true });
    return fail('getItems', result, { relation }) || [];
  }

  async function getInventoryMovements({
    canManageCommercial = false,
    movementType = 'restock'
  } = {}) {
    const relation = canManageCommercial
      ? 'inventory_movements'
      : 'inventory_movement_catalog';
    let query = getClient().from(relation);
    query = canManageCommercial
      ? query.select('*, suppliers(name)')
      : query.select('*');
    if (movementType) query = query.eq('movement_type', movementType);
    const result = await query.order('created_at', { ascending: false });
    return fail('getInventoryMovements', result, { relation, movementType }) || [];
  }

  async function getRecipes({ canManageCommercial = false } = {}) {
    const client = getClient();
    if (canManageCommercial) {
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

    // Compatibility remains limited to operational, non-commercial columns.
    if (result.error) {
      result = await client
        .from('recipes')
        .select(STAFF_RECIPE_COLUMNS)
        .order('name', { ascending: true });
    }
    return fail('getRecipes', result, { relation: 'recipe_catalog' }) || [];
  }

  async function getSuppliers({ canManageCommercial = false } = {}) {
    if (!canManageCommercial) return [];
    const result = await getClient()
      .from('suppliers')
      .select('*')
      .order('name', { ascending: true });
    return fail('getSuppliers', result, { relation: 'suppliers' }) || [];
  }

  async function saveItem({ id = null, payload = {} } = {}) {
    const client = getClient();
    const record = pickFields(payload, INVENTORY_MASTER_FIELDS);
    if (!record.name) {
      throw new AtlasDataError('saveItem', new Error('name is required'), { id });
    }

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
    itemId,
    quantityChange,
    movementType,
    unitCost = null,
    supplierId = null,
    note = null
  } = {}) {
    const result = await getClient().rpc('adjust_inventory', {
      p_item_id: itemId,
      p_quantity_change: quantityChange,
      p_movement_type: movementType,
      p_unit_cost: unitCost,
      p_supplier_id: supplierId,
      p_note: note
    });
    return fail('adjustInventory', result, { itemId, movementType });
  }

  async function findSupplierByName(name) {
    const normalizedName = cleanText(name);
    if (!normalizedName) return null;
    const result = await getClient()
      .from('suppliers')
      .select('id,name')
      .ilike('name', normalizedName)
      .maybeSingle();
    return fail('findSupplierByName', result, { name: normalizedName });
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

    // Older hosted supplier tables may contain only the name column.
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
    const normalizedName = cleanText(name);
    if (!normalizedName) return null;
    const existing = await findSupplierByName(normalizedName);
    if (existing?.id) return existing;
    return createSupplier({ name: normalizedName });
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
    INVENTORY_MASTER_FIELDS,
    configure,
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
