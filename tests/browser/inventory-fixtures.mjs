// Inventory, stock count, Visual Inventory and Purchasing fixtures (S88 Team B),
// shaped like the production payloads of atlas-stock-counts, atlas-item-master,
// atlas-inventory-recognition and the purchasing v2 RPCs.
import { emptyFunctions } from './fixtures.mjs';
import { fixtureTime } from './harness.mjs';

const DAY = 86400000;
export const iso = (offsetDays) => fixtureTime(offsetDays * DAY);
export const dateKey = (offsetDays = 0) => fixtureTime(offsetDays * DAY).slice(0, 10);

export const IDS = Object.freeze({
  campari: '11111111-1111-4111-8111-111111111111', limes: '22222222-2222-4222-8222-222222222222',
  tanq: '33333333-3333-4333-8333-333333333333', aperol: '44444444-4444-4444-8444-444444444444',
  tonic: '55555555-5555-4555-8555-555555555555', ango: '66666666-6666-4666-8666-666666666666',
  giffard: '77777777-7777-4777-8777-777777777777', sugar: '88888888-8888-4888-8888-888888888888',
  old: '99999999-9999-4999-8999-999999999999',
  globus: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', olgerdin: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', mata: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  session: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', verified: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
  po1: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', po2: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  request: '12121212-1212-4212-8212-121212121212', detection: '13131313-1313-4313-8313-131313131313', outcome: '14141414-1414-4414-8414-141414141414'
});

export const items = [
  { id: IDS.campari, name: 'Campari', category: 'Aperitif', unit: 'bottles', par_level: 4, supplier: 'Globus', supplier_id: IDS.globus, active: true, cost_price: 3900, size_ml: 1000, bin_location: 'Back bar', barcode: '8000070012345', updated_at: iso(-3) },
  { id: IDS.limes, name: 'Limes', category: 'Fresh fruit', unit: 'each', par_level: 40, supplier: 'Mata', supplier_id: IDS.mata, active: true, cost_price: 60, bin_location: 'Walk-in fridge', updated_at: iso(-3) },
  { id: IDS.tanq, name: 'Tanqueray London Dry', category: 'Gin', unit: 'bottles', par_level: 6, supplier: 'Globus', supplier_id: IDS.globus, active: true, cost_price: 4200, size_ml: 1000, bin_location: 'Back bar', updated_at: iso(-3) },
  { id: IDS.aperol, name: 'Aperol', category: 'Aperitif', unit: 'bottles', par_level: 4, supplier: 'Globus', supplier_id: IDS.globus, active: true, cost_price: 3300, size_ml: 1000, bin_location: 'Back bar', updated_at: iso(-3) },
  { id: IDS.tonic, name: 'Fever-Tree Tonic', category: 'Mixer', unit: 'bottles', par_level: 72, supplier: 'Ölgerðin', supplier_id: IDS.olgerdin, active: true, cost_price: 190, size_ml: 200, bin_location: 'Store room', units_per_case: 24, updated_at: iso(-3) },
  { id: IDS.ango, name: 'Angostura Bitters', category: 'Bitters', unit: 'bottles', par_level: 2, supplier: 'Globus', supplier_id: IDS.globus, active: true, cost_price: 2900, size_ml: 200, bin_location: 'Back bar', updated_at: iso(-3) },
  { id: IDS.giffard, name: 'Giffard Vanille Syrup', category: 'Syrups', unit: 'bottles', par_level: 2, supplier: 'Globus', supplier_id: IDS.globus, active: true, cost_price: 2400, size_ml: 1000, bin_location: 'Back bar', updated_at: iso(-3) },
  { id: IDS.sugar, name: 'Demerara Sugar Cube', category: 'Bar Ingredients', unit: 'kg', par_level: 2, supplier: 'Mata', supplier_id: IDS.mata, active: true, cost_price: 900, bin_location: 'Store room', updated_at: iso(-3) },
  { id: IDS.old, name: 'Old Tom Gin', category: 'Gin', unit: 'bottles', par_level: 0, supplier: 'Globus', supplier_id: IDS.globus, active: false, cost_price: 4800, updated_at: iso(-30) }
];

const balance = (id, quantity, days = 2) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: iso(-days), expires_at: iso(7 - days) });
export const balances = [balance(IDS.campari, 1), balance(IDS.limes, 0), balance(IDS.tanq, 3), balance(IDS.aperol, 2), balance(IDS.tonic, 48), balance(IDS.ango, 1), balance(IDS.giffard, 3)];

export const suppliers = [
  { id: IDS.globus, name: 'Globus', contact_name: 'Anna', email: 'orders@globus.example', phone: '555 1234', active: true },
  { id: IDS.olgerdin, name: 'Ölgerðin', contact_name: 'Jón', email: 'pantanir@olgerdin.example', active: true },
  { id: IDS.mata, name: 'Mata', active: true }
];

export const movements = [
  { id: 'm1', item_id: IDS.tonic, item_name: 'Fever-Tree Tonic', movement_type: 'restock', quantity_change: 24, total_cost: 4560, supplier_id: IDS.olgerdin, suppliers: { name: 'Ölgerðin' }, note: 'Delivery', created_at: iso(-4) },
  { id: 'm2', item_id: IDS.limes, item_name: 'Limes', movement_type: 'waste', quantity_change: -5, note: 'Spoilage: soft limes', created_at: iso(-3) },
  { id: 'm3', item_id: IDS.campari, item_name: 'Campari', movement_type: 'adjustment', quantity_change: -1, note: 'Breakage', created_at: iso(-3.5) }
];

export const recipes = [
  { id: 'r1', name: 'Negroni', active: true, recipe_ingredients: [{ item_id: IDS.campari, item_name: 'Campari', quantity: 30, unit: 'ml' }, { item_id: IDS.tanq, item_name: 'Tanqueray London Dry', quantity: 30, unit: 'ml' }] },
  { id: 'r2', name: 'Aperol Spritz', active: true, recipe_ingredients: [{ item_id: IDS.aperol, item_name: 'Aperol', quantity: 60, unit: 'ml' }] }
];

const countLine = (id, item, status = 'pending', quantity = null) => ({
  id, session_id: IDS.session, inventory_item_id: item.id, item_name: item.name, category: item.category, inventory_unit: item.unit,
  bin_location: item.bin_location, expected_quantity: 0, observed_quantity: quantity, observed_input_quantity: quantity, observed_input_unit: 'inventory',
  line_status: status, version: 1, source_kind: 'production_observation', supported_count_units: ['inventory'],
  counted_by_label: status === 'counted' ? 'Sara Jónsdóttir' : null
});

/** A stateful atlas-stock-counts mock (snapshot, detail, save-line, add-line, submit, verify, reject, cancel, start). */
export function countBackend({ status = 'draft', empty = false } = {}) {
  const byId = (id) => items.find((item) => item.id === id);
  const lines = empty ? [] : [
    countLine('a1111111-0000-4000-8000-000000000001', byId(IDS.campari), 'counted', 1),
    countLine('a1111111-0000-4000-8000-000000000002', byId(IDS.tanq), 'counted', 3),
    countLine('a1111111-0000-4000-8000-000000000003', byId(IDS.aperol)),
    countLine('a1111111-0000-4000-8000-000000000004', byId(IDS.ango)),
    countLine('a1111111-0000-4000-8000-000000000005', byId(IDS.giffard)),
    countLine('a1111111-0000-4000-8000-000000000006', byId(IDS.limes))
  ];
  const session = { id: IDS.session, title: 'Back bar count', scope_type: 'location', scope_value: 'Back bar', status, started_at: iso(-0.1), started_by_label: 'Sara Jónsdóttir' };
  const summary = () => ({
    total_lines: lines.length,
    counted_lines: lines.filter((line) => line.line_status === 'counted').length,
    skipped_lines: lines.filter((line) => line.line_status === 'skipped').length,
    pending_lines: lines.filter((line) => line.line_status === 'pending').length
  });
  const catalog = items.filter((item) => item.active).map((item) => {
    const found = balances.find((entry) => entry.inventory_item_id === item.id);
    return { id: item.id, name: item.name, category: item.category, unit: item.unit, par_level: item.par_level, bin_location: item.bin_location, verified_quantity: found?.verified_quantity ?? null, verified_at: found?.verified_at ?? null };
  });
  const sessions = () => empty ? [] : [
    { ...session, summary: summary() },
    { id: IDS.verified, title: 'Full count', scope_type: 'all', status: 'verified', started_at: iso(-3), verified_at: iso(-2), started_by_label: 'Imad El Moubarik', summary: { total_lines: 8, counted_lines: 8, skipped_lines: 0, pending_lines: 0, negative_variances: 1, positive_variances: 0 } }
  ];
  const snapshot = () => ({ sessions: sessions(), catalog, verified_balances: balances, summary: {}, permissions: { can_start: true }, settings: { variance_tolerance_percent: 10 } });
  const detail = () => ({
    session: { ...session }, summary: summary(), lines: lines.map((line) => ({ ...line })),
    permissions: { can_edit: session.status === 'draft', can_submit: session.status === 'draft', can_verify: session.status === 'submitted', can_reject: session.status === 'submitted', can_cancel: true }
  });
  const calls = [];
  const handler = (entry) => {
    calls.push(entry);
    if (entry.method === 'GET' && entry.action === 'detail') return { count: detail() };
    if (entry.method === 'GET') return { counts: snapshot() };
    if (entry.action === 'save-line') {
      const line = lines.find((row) => row.id === entry.body.line_id);
      if (!line || line.version !== entry.body.expected_version) return { __status: 409, body: { error: 'Count line version changed. Refresh before saving.' } };
      line.line_status = entry.body.line_status;
      line.observed_quantity = entry.body.observed_input_quantity ?? null;
      line.observed_input_quantity = entry.body.observed_input_quantity ?? null;
      line.count_method = entry.body.count_method;
      line.version += 1;
    }
    if (entry.action === 'add-line') {
      const item = byId(entry.body.item_id);
      if (!lines.some((row) => row.inventory_item_id === item.id)) lines.push(countLine(`a1111111-0000-4000-8000-00000000000${lines.length + 1}`, item));
    }
    if (entry.action === 'submit') session.status = 'submitted';
    if (entry.action === 'verify') session.status = 'verified';
    if (entry.action === 'reject') session.status = 'draft';
    return { counts: snapshot(), detail: detail() };
  };
  return { handler, calls, lines, session };
}

export const orders = () => [
  { id: IDS.po1, supplier_id: IDS.globus, status: 'pending_approval', version: 3, lines: [{ item_id: IDS.campari, item_name: 'Campari', unit: 'bottles', quantity: 6, unit_cost: 3900 }, { item_id: IDS.aperol, item_name: 'Aperol', unit: 'bottles', quantity: 4, unit_cost: 3300 }], note: '', created_at: iso(-1), expected_delivery_date: dateKey(2) },
  { id: IDS.po2, supplier_id: IDS.olgerdin, status: 'ordered', version: 5, lines: [{ item_id: IDS.tonic, item_name: 'Fever-Tree Tonic', unit: 'bottles', quantity: 48, unit_cost: 190 }], note: 'Deliver before noon', created_at: iso(-3), expected_delivery_date: dateKey(0) }
];

export const policy = { approval_required: true, approval_threshold_isk: 20000, approval_separate_approver: false, approval_approver_role: 'manager', over_receipt_tolerance_percent: 0, short_close_enabled: true, receipt_cost_mode: 'update_item_cost', delivery_date_required_on_place: false, staff_receiving_enabled: false, venue_date: dateKey(0) };

/** A stateful purchasing v2 mock over the RPCs. */
export function purchasingBackend({ list = orders(), policyOverrides = {} } = {}) {
  const calls = [];
  const state = { orders: list, policy: { ...policy, ...policyOverrides } };
  const detail = (order) => {
    const received = (order.receipts || []);
    return {
      order, total: order.lines.reduce((sum, line) => sum + line.quantity * line.unit_cost, 0), approval_needed: state.policy.approval_required,
      lines: order.lines.map((line) => {
        const got = received.filter((entry) => entry.item_id === line.item_id).reduce((sum, entry) => sum + entry.quantity, 0);
        return { ...line, received_quantity: got, remaining_quantity: Math.max(0, line.quantity - got) };
      }),
      receipts: received, events: [{ id: 'e1', event_type: 'created', created_at: order.created_at }, ...(order.events || [])], policy: state.policy
    };
  };
  const command = (body) => {
    calls.push(body);
    let order = state.orders.find((entry) => entry.id === body.p_id);
    if (body.p_action === 'create') {
      // Like the server, create is idempotent on the order id: a retry of a
      // create that committed returns the same draft.
      if (order) return order;
      order = { id: body.p_id, supplier_id: body.p_supplier_id, status: 'draft', version: 1, lines: body.p_lines.map((line) => ({ ...line, item_name: items.find((item) => item.id === line.item_id)?.name, unit: items.find((item) => item.id === line.item_id)?.unit })), note: body.p_note, created_at: iso(0), expected_delivery_date: body.p_expected_delivery_date };
      state.orders.unshift(order);
      return order;
    }
    if (!order) return { __status: 400, body: { message: 'Order not found' } };
    if (body.p_version !== order.version) return { __status: 400, body: { message: 'Order changed. Refresh before continuing' } };
    const next = { submit: 'pending_approval', approve: 'approved', reject: 'draft', place: 'ordered', cancel: 'cancelled', receive: 'received', close_short: 'received' }[body.p_action];
    if (body.p_action === 'receive_lines') {
      order.receipts = [...(order.receipts || []), ...body.p_receipt.map((entry) => ({ ...entry, request_id: body.p_request_id }))];
      const complete = order.lines.every((line) => order.receipts.filter((entry) => entry.item_id === line.item_id).reduce((sum, entry) => sum + entry.quantity, 0) >= line.quantity);
      order.status = complete ? 'received' : 'partially_received';
    } else if (next) order.status = next;
    if (body.p_action === 'set_delivery_date') order.expected_delivery_date = body.p_expected_delivery_date;
    order.version += 1;
    order.events = [...(order.events || []), { id: `e${order.version}`, event_type: { place: 'ordered', receive_lines: 'received_partial' }[body.p_action] || body.p_action, created_at: iso(0), payload: body.p_reason ? { reason: body.p_reason } : {} }];
    return order;
  };
  return {
    calls, state,
    tables: { purchase_orders: () => state.orders },
    rpc: {
      atlas_purchase_order_policy: () => state.policy,
      atlas_purchase_order_detail: (body) => detail(state.orders.find((entry) => entry.id === body.p_id)),
      atlas_purchase_order_command_v2: command
    }
  };
}

/** A recognition detection (owner §§5–7) for mocks. */
export function detection({ band = 'high', itemId = IDS.giffard, candidates = null, read = {} } = {}) {
  const item = items.find((entry) => entry.id === itemId);
  const list = candidates || [{
    rank: 1, item_id: itemId, item: { ...item }, score: band === 'high' ? 0.97 : band === 'medium' ? 0.78 : 0.4, percent: band === 'high' ? 97 : band === 'medium' ? 78 : 40,
    explanation: `Candidate 1 — ${item.name}`, evidence: [{ signal: 'code', polarity: 'for', text: 'barcode scanned and linked to this item' }, { signal: 'size', polarity: 'for', text: '1 L detected' }],
    flags: {}
  }];
  return {
    detection_id: IDS.detection, detection_index: 0, band, band_label: { high: 'Sure', medium: 'Check', low: 'Not sure' }[band],
    summary: band === 'low' ? 'No confident Atlas inventory match found.' : `Likely ${item.name}.`, in_atlas: band !== 'low',
    preselected_item_id: band === 'high' ? itemId : null,
    read: { brand: { value: 'Giffard', confidence: 99 }, product_name: { value: 'Vanille syrup', confidence: 93 }, unit_size: { quantity: 1, unit: 'l', text: '1 L', confidence: 72 }, ...read },
    field_confidence: { identity: 96, brand: 99, variant: 91, category: 80, package_type: 90, unit_size: 72, barcode: band === 'high' ? 99 : null, inventory_match: band === 'high' ? 94 : 60, supplier_match: 45 },
    candidates: band === 'low' && !candidates ? [] : list, more_candidates: 0, actions: []
  };
}

/** A stateful atlas-inventory-recognition mock. */
export function recognitionBackend({ result = () => ({ detections: [detection()] }) } = {}) {
  const calls = [];
  const handler = (entry) => {
    calls.push(entry);
    if (entry.action === 'identify') {
      const body = typeof entry.body === 'string' ? { multipart: true } : entry.body;
      const payload = result(body, entry);
      return { __status: 201, body: { request_id: IDS.request, client_request_id: body?.client_request_id || null, replayed: false, mode: body?.mode || 'identify', method: body?.multipart ? 'vision' : 'barcode', status: 'ok', vision: { configured: true, used: Boolean(body?.multipart) }, media: body?.multipart ? { media_id: '15151515-1515-4515-8515-151515151515' } : null, stock_changed: false, ...payload } };
    }
    if (entry.action === 'outcome') return { __status: 201, body: { outcome: { outcome_id: IDS.outcome, replayed: false, stock_changed: false }, stock_changed: false } };
    if (entry.action === 'search') return { candidates: [detection().candidates[0]], stock_changed: false };
    if (entry.action === 'duplicates') return { duplicates: { candidates: [{ item_id: IDS.sugar, name: 'Demerara Sugar Cube', active: true, score: 0.72, band: 'possible', requires_ack: true, evidence: [{ signal: 'name', polarity: 'for', text: 'name and package match this item' }, { signal: 'variant', polarity: 'against', text: 'different product form: cube vs raw' }] }], requires_ack: [IDS.sugar], code_conflicts: [], alias_conflicts: [], identity_conflict: null }, stock_changed: false };
    if (entry.action === 'propose' || entry.action === 'report') return { __status: 201, body: { id: '16161616-1616-4616-8616-161616161616', status: 'pending', duplicates: null, stock_changed: false } };
    return { stock_changed: false };
  };
  return { handler, calls };
}

/**
 * A stateful atlas-item-master mock: item_dependencies, set_item_active,
 * create-item (duplicate guard: 'suspected' needs an acknowledgement with a
 * reason, 'code' is a hard conflict) and catalog-request.
 */
export function itemMasterBackend({ duplicate = null, blockers = [] } = {}) {
  const calls = [];
  const candidate = { item_id: IDS.sugar, name: 'Demerara Sugar Cube', active: true, score: 0.82, band: 'likely', requires_ack: true, evidence: [{ signal: 'name', polarity: 'for', text: 'name and package match this item' }] };
  const handler = (entry) => {
    const action = entry.action || entry.body?.action;
    calls.push({ ...entry, action });
    if (action === 'item_dependencies') {
      const id = new URLSearchParams(entry.search).get('item_id');
      const item = items.find((row) => row.id === id);
      return { dependencies: { item: item ? { id, name: item.name, active: item.active, updated_at: item.updated_at } : null, blockers, warnings: [], can_deactivate: !blockers.length, can_reactivate: true, recipes: [], open_orders: [] } };
    }
    if (action === 'set_item_active') return { result: { item_id: entry.body.item_id, active: entry.body.active, changed: true } };
    if (action === 'create-item') {
      const acknowledged = entry.body?.duplicate_ack?.acknowledged || [];
      if (duplicate === 'code') return { __status: 409, body: { error: 'That code belongs to another item.', code: 'code_conflict', duplicate_check: { candidates: [{ ...candidate, score: 1, band: 'code', requires_ack: false }], requires_ack: [], code_conflicts: [{ code: '5000000000001', item_id: IDS.sugar, name: 'Demerara Sugar Cube' }], alias_conflicts: [], identity_conflict: null } } };
      if (duplicate === 'suspected' && !acknowledged.some((ack) => ack.item_id === IDS.sugar && String(ack.reason || '').trim().length >= 3)) {
        return { __status: 409, body: { error: 'Possible duplicate.', code: 'duplicate_suspected', duplicate_check: { candidates: [candidate], requires_ack: [IDS.sugar], code_conflicts: [], alias_conflicts: [], identity_conflict: null } } };
      }
      return { __status: 201, body: { result: { item_id: '17171717-1717-4717-8717-171717171717', item: { id: '17171717-1717-4717-8717-171717171717', name: entry.body.values?.name, quantity: 0 } } } };
    }
    if (action === 'catalog-request') return { __status: 201, body: { request: { id: '18181818-1818-4818-8818-181818181818', status: 'applied' } } };
    return { __status: 400, body: { error: 'unknown action', code: 'invalid_request' } };
  };
  return { handler, calls };
}

/** The realistic Team B world. */
export function inventoryWorld({ counts = countBackend(), purchasing = purchasingBackend(), recognition = recognitionBackend(), itemMaster = null, tables = {}, rpc = {}, functions = {} } = {}) {
  return {
    counts, purchasing, recognition,
    fixtures: {
      tables: {
        inventory_items: items, inventory_catalog: items.map(({ cost_price, supplier_id, ...rest }) => rest), inventory_movements: movements,
        inventory_movement_catalog: movements, recipes, suppliers, recipe_categories: [], ...purchasing.tables, ...tables
      },
      rpc: { ...purchasing.rpc, ...rpc },
      functions: { ...emptyFunctions(), 'atlas-stock-counts': counts.handler, 'atlas-inventory-recognition': recognition.handler, ...(itemMaster ? { 'atlas-item-master': itemMaster } : {}), ...functions }
    }
  };
}

/** A fake rear camera (canvas stream) and BarcodeDetector for Playwright initScript. */
export function fakeCameraScript() {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 480;
  const context = canvas.getContext('2d');
  let frame = 0;
  setInterval(() => { context.fillStyle = '#334155'; context.fillRect(0, 0, 640, 480); context.fillStyle = '#f8fafc'; context.fillRect(160 + (frame++ % 20), 180, 320, 120); }, 50);
  window.__fakeBarcodes = [];
  navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(15);
  window.BarcodeDetector = class {
    static async getSupportedFormats() { return ['ean_13', 'ean_8', 'code_128', 'qr_code']; }
    async detect() { const next = window.__fakeBarcodes.shift(); return next ? [{ rawValue: next, format: 'ean_13' }] : []; }
  };
}
