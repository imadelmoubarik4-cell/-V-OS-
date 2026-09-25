// Deterministic backend fixtures for Recipes, Reports, Marketing and Data
// (spec §7.7, §7.12–§7.14). Shaped like the production payloads of the
// atlas-reports, atlas-marketing-workspace, atlas-item-master (catalogue
// governance), atlas-sprint3-review and data-review RPC contracts.
import { emptyFunctions, venueClockBackend, weekHours } from './fixtures.mjs';

export const NOW = '2026-09-24T16:00:00.000Z';
const day = 86400000;
const iso = (offsetDays) => new Date(Date.parse(NOW) + offsetDays * day).toISOString();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const IDS = {
  campari: uuid(1), gin: uuid(2), tonic: uuid(3), lime: uuid(4), aperol: uuid(5), prosecco: uuid(6), vodka: uuid(7), coffee: uuid(8),
  negroni: uuid(101), gt: uuid(102), spritz: uuid(103), espresso: uuid(104), old: uuid(105),
  batchFailed: uuid(201), batchReady: uuid(202), batchDone: uuid(203),
  requestAlias: uuid(301), requestDuplicate: uuid(302), requestNew: uuid(303)
};

export const inventory = [
  { id: IDS.campari, name: 'Campari', category: 'Aperitif', unit: 'bottles', size_ml: 1000, par_level: 4, supplier: 'Globus', active: true, cost_price: 3900, updated_at: iso(-3) },
  { id: IDS.gin, name: 'Tanqueray London Dry', category: 'Gin', unit: 'bottles', size_ml: 1000, par_level: 6, supplier: 'Globus', active: true, cost_price: 4200, updated_at: iso(-3) },
  { id: IDS.tonic, name: 'Fever-Tree Tonic', category: 'Mixer', unit: 'bottles', size_ml: 200, par_level: 72, supplier: 'Ölgerðin', active: true, cost_price: 190, updated_at: iso(-3) },
  { id: IDS.lime, name: 'Limes', category: 'Fresh fruit', unit: 'each', par_level: null, supplier: 'Mata', active: true, cost_price: 60, updated_at: iso(-3) },
  { id: IDS.aperol, name: 'Aperol', category: 'Aperitif', unit: 'bottles', size_ml: 1000, par_level: 4, supplier: 'Globus', active: true, cost_price: 3300, updated_at: iso(-3) },
  { id: IDS.prosecco, name: 'Prosecco', category: 'Wine', unit: 'bottles', size_ml: 750, par_level: 12, supplier: 'Vínkaup', active: true, cost_price: 1900, updated_at: iso(-3) },
  { id: IDS.vodka, name: 'Absolut Vodka', category: 'Vodka', unit: 'bottles', size_ml: 700, par_level: 4, supplier: 'Globus', active: true, cost_price: 4100, updated_at: iso(-3) },
  { id: IDS.coffee, name: 'Espresso beans', category: 'Coffee', unit: 'kg', par_level: 2, supplier: 'Te & Kaffi', active: true, cost_price: 5200, updated_at: iso(-3) }
];

const balance = (id, quantity) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: iso(-1), expires_at: iso(10) });
export const balances = [balance(IDS.campari, 0), balance(IDS.gin, 3), balance(IDS.tonic, 48), balance(IDS.aperol, 2), balance(IDS.prosecco, 20), balance(IDS.vodka, 5)];

const ingredient = (id, itemId, name, quantity, unit) => ({ id: `ri-${id}`, item_id: itemId, item_name: name, quantity, unit });
export const recipes = [
  { id: IDS.negroni, name: 'Negroni', type: 'classic-cocktail', active: true, yield_quantity: 1, yield_unit: 'serving', menu_price: 2900, glassware: 'Rocks', garnish: 'Orange peel', method: 'Stir with ice for 20 seconds\nStrain over a large cube\nExpress the orange peel', show_on_menu: true, updated_at: iso(-5), recipe_ingredients: [ingredient('n1', IDS.gin, 'Tanqueray London Dry', 30, 'ml'), ingredient('n2', IDS.campari, 'Campari', 30, 'ml')] },
  { id: IDS.gt, name: 'Gin and tonic', type: 'classic-cocktail', active: true, yield_quantity: 1, yield_unit: 'serving', menu_price: 2500, glassware: 'Highball', garnish: 'Lime wheel', method: 'Build over ice\nTop with tonic', show_on_menu: true, updated_at: iso(-5), recipe_ingredients: [ingredient('g1', IDS.gin, 'Tanqueray London Dry', 40, 'ml'), ingredient('g2', IDS.tonic, 'Fever-Tree Tonic', 200, 'ml')] },
  { id: IDS.spritz, name: 'Aperol spritz', type: 'spritz', active: true, yield_quantity: 1, yield_unit: 'serving', menu_price: 2700, glassware: 'Wine glass', garnish: 'Orange slice', method: 'Build over ice: prosecco, Aperol, soda', show_on_menu: true, updated_at: iso(-5), recipe_ingredients: [ingredient('s1', IDS.aperol, 'Aperol', 60, 'ml'), ingredient('s2', IDS.prosecco, 'Prosecco', 90, 'ml')] },
  { id: IDS.espresso, name: 'Espresso martini', type: 'signature-cocktail', active: true, yield_quantity: 1, yield_unit: 'serving', menu_price: null, glassware: 'Coupe', garnish: 'Three coffee beans', method: 'Shake hard with ice\nDouble strain', show_on_menu: true, updated_at: iso(-5), recipe_ingredients: [ingredient('e1', IDS.vodka, 'Absolut Vodka', 40, 'ml'), ingredient('e2', IDS.coffee, 'Espresso beans', 18, 'g')] },
  { id: IDS.old, name: 'Old special', type: 'signature-cocktail', active: false, yield_quantity: 1, yield_unit: 'serving', menu_price: 2200, glassware: 'Coupe', method: '', show_on_menu: false, updated_at: iso(-30), recipe_ingredients: [] }
];

export const dataReviewSummary = {
  generated_at: NOW,
  issues: [
    ['inventory.missing_supplier', 'inventory_item', 'No supplier linked', 0],
    ['inventory.supplier_text_unlinked', 'inventory_item', 'Supplier name typed but not linked', 2],
    ['inventory.missing_cost', 'inventory_item', 'No unit or case cost', 1],
    ['inventory.missing_reference', 'inventory_item', 'No SKU, barcode or supplier reference', 0],
    ['inventory.package_missing', 'inventory_item', 'No package size', 1],
    ['inventory.package_unreadable', 'inventory_item', 'Package size cannot be read', 0],
    ['inventory.missing_par', 'inventory_item', 'No par level', 1],
    ['inventory.flagged_needs_review', 'inventory_item', 'Flagged for review', 0],
    ['recipe.missing_price', 'recipe', 'Recipe has no menu price', 1],
    ['recipe.no_ingredients', 'recipe', 'Recipe has no ingredients', 0],
    ['recipe.ingredient_unlinked', 'recipe_ingredient', 'Ingredient not linked to stock', 0],
    ['recipe.ingredient_inactive_item', 'recipe_ingredient', 'Ingredient uses an inactive item', 0],
    ['inventory.possible_duplicate', 'inventory_item', 'Possible duplicate item', 2],
    ['catalog.pending_approval', 'catalog_change_request', 'Waiting for approval', 3],
    ['catalog.code_collision', 'inventory_item', 'Barcode or code used by two items', 0],
    ['inventory.category_unmapped', 'inventory_item', 'Category not in the product list', 1]
  ].map(([code, entity_type, label, count]) => ({ code, entity_type, label, count }))
};

export const dataReviewRows = {
  'inventory.supplier_text_unlinked': [
    { entity_type: 'inventory_item', entity_id: IDS.lime, name: 'Limes', category: 'Fresh fruit', detail: { supplier_text: 'Mata' }, fix: 'item_master' },
    { entity_type: 'inventory_item', entity_id: IDS.coffee, name: 'Espresso beans', category: 'Coffee', detail: { supplier_text: 'Te & Kaffi' }, fix: 'item_master' }
  ],
  'inventory.missing_cost': [{ entity_type: 'inventory_item', entity_id: IDS.coffee, name: 'Espresso beans', category: 'Coffee', detail: {}, fix: 'item_master' }],
  'inventory.package_missing': [{ entity_type: 'inventory_item', entity_id: IDS.coffee, name: 'Espresso beans', category: 'Coffee', detail: {}, fix: 'item_master' }],
  'inventory.missing_par': [{ entity_type: 'inventory_item', entity_id: IDS.lime, name: 'Limes', category: 'Fresh fruit', detail: { unit: 'each' }, fix: 'par_levels' }],
  'recipe.missing_price': [{ entity_type: 'recipe', entity_id: IDS.espresso, name: 'Espresso martini', category: 'signature-cocktail', detail: {}, fix: 'recipe' }],
  'inventory.possible_duplicate': [
    { entity_type: 'inventory_item', entity_id: IDS.vodka, name: 'Absolut Vodka', category: 'Vodka', detail: { other_item_id: IDS.gin, other_item_name: 'Absolut Vodka 70cl', score: 0.91, code_collision: false }, fix: 'catalog_duplicates' },
    { entity_type: 'inventory_item', entity_id: IDS.gin, name: 'Absolut Vodka 70cl', category: 'Vodka', detail: { other_item_id: IDS.vodka, other_item_name: 'Absolut Vodka', score: 0.91, code_collision: false }, fix: 'catalog_duplicates' }
  ],
  'catalog.pending_approval': [{ entity_type: 'catalog_change_request', entity_id: IDS.requestAlias, name: 'Campari', category: 'alias', detail: { kind: 'alias', source: 'recognition', requested_by_label: 'Sara Jónsdóttir', requested_at: iso(-0.2), version: 1 }, fix: 'catalog_queue' }],
  'inventory.category_unmapped': [{ entity_type: 'inventory_item', entity_id: IDS.coffee, name: 'Espresso beans', category: 'Coffee', detail: { category: 'Coffee' }, fix: 'item_master' }]
};

const observation = (at, quantity, unit) => ({ at, quantity, unit, source: 'verified_count' });
export function parEvidence(cover = null) {
  return {
    generated_at: NOW,
    rule: { min_observations: 3, min_span_days: 14, window_days: 120, sources: ['verified_count', 'owner_confirmation'] },
    items: inventory.map((item, index) => {
      const eligible = index % 2 === 0;
      const avg = [1.4, null, 6.2, null, 0.9, null, 0.6, null][index];
      return {
        item_id: item.id, name: item.name, category: item.category, unit: item.unit, par_level: item.par_level,
        critical_minimum: null, units_per_case: item.unit === 'bottles' ? 6 : null, updated_at: item.updated_at,
        observations: eligible ? 5 : 2, span_days: eligible ? 32 : 6, avg_daily_usage: eligible ? avg : null,
        eligible, reason: eligible ? null : 'insufficient_observations',
        evidence: eligible ? [observation(iso(-32), 8, item.unit), observation(iso(-16), 5, item.unit), observation(iso(-1), 3, item.unit)] : [],
        intervals: [], evidence_digest: `digest-${index}`,
        suggestion: eligible && cover ? { cover_days: cover, par_level: Math.ceil(avg * cover), cases: item.unit === 'bottles' ? Math.ceil(Math.ceil(avg * cover) / 6) : null, saved: false } : null
      };
    })
  };
}

export const importBatches = [
  { id: IDS.batchFailed, file_name: 'Globus invoice September.pdf', file_extension: 'pdf', file_size: 482133, entity_scope: 'invoice', status: 'failed', current_stage: 'failed', record_counts: {}, created_at: iso(-0.3), updated_at: iso(-0.25), last_error: 'pdf parse error at object 12', storage_bucket: 'atlas-imports', storage_path: 'a/b.pdf', created_by: 'b9a22f65-e180-429b-8531-008fd08d31aa' },
  { id: IDS.batchReady, file_name: 'Stock count back bar.csv', file_extension: 'csv', file_size: 18211, entity_scope: 'inventory', status: 'ready', current_stage: 'ready', record_counts: { rows: 42 }, created_at: iso(-1), updated_at: iso(-0.9), storage_bucket: 'atlas-imports', storage_path: 'a/c.csv', created_by: 'b9a22f65-e180-429b-8531-008fd08d31aa' },
  { id: IDS.batchDone, file_name: 'Supplier price list.xlsx', file_extension: 'xlsx', file_size: 91822, entity_scope: 'supplier', status: 'completed', current_stage: 'completed', record_counts: { rows: 118 }, created_at: iso(-6), updated_at: iso(-6), storage_bucket: 'atlas-imports', storage_path: 'a/d.xlsx', created_by: '7d3c1f10-0000-4000-8000-000000000002' }
];

export const catalogQueue = {
  status: 'pending', kind: null, counts: { alias: 1, duplicate_resolution: 1, new_item: 1 }, total: 3,
  rows: [
    { id: IDS.requestAlias, kind: 'alias', status: 'pending', version: 1, source: 'recognition', subject_item_id: IDS.campari, subject_item: { id: IDS.campari, name: 'Campari', active: true, category: 'Aperitif' }, related_items: [], payload: { alias: 'Campari Bitter 1L', alias_kind: 'label' }, evidence: {}, requested_by_label: 'Sara Jónsdóttir', requested_at: iso(-0.2) },
    { id: IDS.requestDuplicate, kind: 'duplicate_resolution', status: 'pending', version: 1, source: 'data_review', subject_item_id: IDS.vodka, subject_item: { id: IDS.vodka, name: 'Absolut Vodka', active: true, category: 'Vodka' }, related_items: [{ id: IDS.gin, name: 'Absolut Vodka 70cl', active: true }], payload: { keep_item_id: IDS.vodka, retire_item_id: IDS.gin, mode: 'retire_into' }, evidence: {}, requested_by_label: 'Imad El Moubarik', requested_at: iso(-1) },
    { id: IDS.requestNew, kind: 'new_item', status: 'pending', version: 2, source: 'ai_proposal', subject_item_id: null, subject_item: null, related_items: [], payload: { values: { name: 'Giffard Vanille Syrup', category: 'Syrup', unit: 'bottles', unit_size_quantity: 1000, unit_size_base: 'ml' } }, duplicate_check: { candidates: [{ item_id: IDS.coffee, name: 'Monin Vanilla Syrup', score: 0.62, active: true }] }, evidence: {}, requested_by_label: 'Atlas AI for Imad', requested_at: iso(-2) }
  ]
};

export const reviewRows = {
  rows: [
    { row_kind: 'inventory', row_id: 'r1', display_name: 'Campari 1L', entity_scope: 'inventory', review_status: 'pending', proposed_action: 'merge', issues: ['possible_duplicate'], source_file: 'Stock count back bar.csv', source_page: null },
    { row_kind: 'inventory', row_id: 'r2', display_name: 'Monin Vanilla', entity_scope: 'inventory', review_status: 'pending', proposed_action: 'create', issues: [], source_file: 'Stock count back bar.csv', source_page: null },
    { row_kind: 'entity', row_id: 'r3', display_name: 'Globus hf.', entity_scope: 'supplier', review_status: 'held', proposed_action: 'link', issues: ['missing_reference', 'name_variant'], source_file: 'Supplier price list.xlsx', source_page: 2 }
  ],
  total: 3
};
export const reviewSummary = { totals: { pending: 2, held: 1, source_checked: 0 }, progress: [], top_issues: [] };
export const reviewDetail = {
  row_kind: 'inventory',
  row: { id: 'r1', review_status: 'pending', proposed_action: 'merge', entity_scope: 'inventory', matched_item_id: IDS.campari, issues: ['possible_duplicate'], normalized_data: { name: 'Campari 1L', quantity: 3, unit: 'bottles', supplier: 'Globus' }, raw_data: { Product: 'CAMPARI 1L', Qty: '3' } },
  issue_records: [], history: []
};

export function reportsSnapshot({ preset = 'last_30_days', start = '2026-08-26', end = '2026-09-24', comparison = { start: '2026-07-27', end: '2026-08-25' } } = {}) {
  const sections = [
    ['overview', 'Overview', 'connected'], ['sales', 'Sales', 'not_connected'], ['inventory', 'Stock', 'partial'], ['recipes', 'Recipes', 'connected'],
    ['purchasing', 'Purchasing', 'connected'], ['suppliers', 'Suppliers', 'connected'], ['waste', 'Waste', 'no_records'], ['labour', 'Labour', 'connected'],
    ['operations', 'Operations', 'connected'], ['knowledge', 'Knowledge', 'connected'], ['saved', 'Saved', 'connected'], ['exports', 'Exports', 'connected']
  ].map(([key, name, status]) => ({ key, name, status, description: '' }));
  return {
    workspace: {
      generated_at: NOW, timezone: 'Atlantic/Reykjavik', currency: 'ISK',
      period: { start, end, label: `${start} – ${end}`, preset },
      comparison: comparison ? { enabled: true, start: comparison.start, end: comparison.end } : { enabled: false },
      sections,
      kpis: [
        { key: 'purchasing_spend', label: 'Purchasing spend', value: 412300, unit: 'ISK', section: 'purchasing', status: 'connected', change_value: 44100, change_percent: 12, trend: 'up', detail: '' },
        { key: 'waste', label: 'Waste', value: null, unit: 'ISK', section: 'waste', status: 'no_records', detail: '' }
      ],
      attention: [
        { title: 'Campari is out of stock', detail: 'Negroni and Boulevardier can’t be served.', section: 'inventory', tone: 'danger', source: 'Stock' },
        { title: '2 items have no cost', detail: 'Recipe costs and stock value are incomplete.', section: 'inventory', tone: 'warn', source: 'Stock' }
      ],
      data_sources: [
        { key: 'inventory', name: 'Stock counts', status: 'partial', note: '6 of 8 items counted this week', records_included: 6, records_excluded: 2, last_refreshed_at: NOW },
        { key: 'purchasing', name: 'Deliveries', status: 'connected', note: '', records_included: 14, records_excluded: 0, last_refreshed_at: NOW },
        { key: 'sales', name: 'Sales (POS)', status: 'not_connected', note: 'No point-of-sale system is connected.', records_included: 0, records_excluded: 0, last_refreshed_at: null },
        { key: 'labour', name: 'Shifts', status: 'connected', note: '', records_included: 21, records_excluded: 0, last_refreshed_at: NOW }
      ],
      reports: {
        overview: { summary: {} },
        sales: { message: 'No point-of-sale system is connected.' },
        inventory: { summary: { active_items: 8, current_items: 6, estimated_value: null, below_par: 3, out_of_stock: 1, needs_current_count: 2, missing_cost: 0 }, categories: [{ category: 'Aperitif', estimated_value: 6600 }, { category: 'Gin', estimated_value: 12600 }], rows: [] },
        recipes: { summary: { active_recipes: 4, ready: 1, needs_attention: 1, unavailable: 1, incomplete_setup: 1 }, rows: [] },
        purchasing: { summary: { spend: 412300, movement_count: 14 }, rows: [
          { id: 'm1', created_at: iso(-2), item_name: 'Tanqueray London Dry', movement_type: 'restock', supplier: 'Globus', quantity_change: 6, unit_cost: 4200, total_cost: 25200, note: '' },
          { id: 'm2', created_at: iso(-4), item_name: 'Fever-Tree Tonic', movement_type: 'restock', supplier: 'Ölgerðin', quantity_change: 48, unit_cost: 190, total_cost: 9120, note: '' }
        ], price_changes: [] },
        suppliers: { summary: { active_suppliers: 4, supplier_rows: 3 }, rows: [
          { id: 's1', supplier: 'Globus', active_item_count: 4, movement_count: 9, spend: 301200, last_movement_at: iso(-2) },
          { id: 's2', supplier: 'Ölgerðin', active_item_count: 1, movement_count: 3, spend: 71100, last_movement_at: iso(-4) },
          { id: 's3', supplier: 'Vínkaup', active_item_count: 1, movement_count: 2, spend: 40000, last_movement_at: iso(-9) }
        ] },
        waste: { summary: { recorded_waste_count: 0, estimated_waste_value: null }, rows: [] },
        labour: { summary: { shift_count: 21, scheduled_hours: 168.5, unpublished_shift_entries: 2 }, rows: [] }
      }
    },
    staff: { id: 'b9a22f65-e180-429b-8531-008fd08d31aa', role: 'admin' },
    policy: {},
    controls: { selected_preset: preset, selected_comparison: 'custom' }
  };
}

export function marketingWorkspace() {
  return {
    workspace: {
      venue_date: '2026-09-24',
      stats: { total_items: 3, drafts: 1, awaiting_approval: 1, overdue_reminders: 0, published: 1, completed: 0 },
      content_items: [
        { id: 'c1', title: 'Friday quiz night reel', content_type: 'reel', status: 'pending_approval', platforms: ['instagram'], scheduled_for: '2026-09-26T17:00:00.000Z', reminder_at: null, can_edit: true, can_approve: true, created_by_label: 'Sara Jónsdóttir', caption_draft: 'Quiz night is back — teams of four, first round at 20:00.' },
        { id: 'c2', title: 'New autumn cocktail menu', content_type: 'post', status: 'draft', platforms: ['instagram', 'facebook'], scheduled_for: '2026-10-01T12:00:00.000Z', reminder_at: '2026-09-30T10:00:00.000Z', can_edit: true, can_approve: true, created_by_label: 'Imad El Moubarik' },
        { id: 'c3', title: 'Happy hour story', content_type: 'story', status: 'published', platforms: ['instagram'], scheduled_for: '2026-09-20T16:00:00.000Z', can_edit: false, can_approve: false, created_by_label: 'Imad El Moubarik' }
      ],
      campaigns: [{ id: 'k1', name: 'Autumn menu launch', campaign_type: 'seasonal', status: 'active', platforms: ['instagram'], start_date: '2026-09-28', end_date: '2026-10-12', description: 'Introduce the six new autumn drinks.' }],
      recommendations: [{ id: 'rec1', title: 'Happy hour reminder story', summary: 'Weekday happy hour runs 16:00–18:00; a story at 15:30 reaches people deciding where to go.', content_type: 'story', platforms: ['instagram'], suggested_format: 'Three-frame story', suggested_time: null, is_due_today: true, recurrence: 'weekly', available_for_today: true, confidence_score: 0.72 }],
      connections: [
        { provider_key: 'instagram', label: 'Instagram', display_status: 'not_connected' },
        { provider_key: 'facebook', label: 'Facebook', display_status: 'not_connected' }
      ],
      reminders: [],
      history: [{ event_type: 'approval_submitted', actor_label: 'Sara Jónsdóttir', created_at: iso(-0.5), payload: { title: 'Friday quiz night reel' } }]
    },
    staff: { can_create: true, can_approve: true, can_mark_published: true },
    members: [{ id: 'b9a22f65-e180-429b-8531-008fd08d31aa', label: 'Imad El Moubarik', role: 'admin' }]
  };
}

/** A complete mocked backend for the Team C pages. */
export function teamCBackend({ user, clock = venueClockBackend({ hours: weekHours() }), overrides = {} } = {}) {
  const calls = { rpc: [], item: [], review: [], reports: [], marketing: [] };
  const state = { queue: structuredClone(catalogQueue), batches: structuredClone(importBatches) };
  const functions = {
    ...emptyFunctions(),
    'atlas-settings': clock.handler,
    'atlas-stock-counts': { counts: { verified_balances: balances } },
    'atlas-item-master': (entry) => {
      calls.item.push(entry);
      if (entry.action === 'catalog-queue') {
        const status = new URL(`http://x${entry.search}`).searchParams.get('status') || 'pending';
        return { queue: { ...state.queue, status, rows: status === 'pending' ? state.queue.rows.filter((row) => row.status === 'pending') : state.queue.rows }, stock_changed: false };
      }
      if (entry.body?.action === 'catalog-decide') {
        const row = state.queue.rows.find((request) => request.id === entry.body.id);
        if (!row) return { __status: 404, body: { error: 'Request not found', code: 'not_found' } };
        if (row.version !== entry.body.expected_version) return { __status: 409, body: { error: 'This request changed. Refresh before deciding.', code: 'stale_request' } };
        row.status = entry.body.decision === 'approve' ? 'applied' : 'rejected';
        row.version += 1;
        row.decided_by_label = user?.display_name || 'Manager';
        row.decided_at = NOW;
        row.decision_note = entry.body.note;
        return { request: row, stock_changed: false };
      }
      if (entry.body?.action === 'catalog-backfill') return { proposals: { created: 4, skipped: 3, stock_changed: false }, stock_changed: false };
      if (entry.body?.action === 'catalog-request') return { request: { id: uuid(399), kind: entry.body.kind, status: 'applied', version: 2 }, stock_changed: false };
      return {};
    },
    'atlas-sprint3-review': (entry) => {
      calls.review.push(entry);
      if (entry.action === 'summary') return reviewSummary;
      if (entry.action === 'rows') return reviewRows;
      if (entry.action === 'detail') return reviewDetail;
      if (entry.action === 'decision') return { detail: { ...reviewDetail, row: { ...reviewDetail.row, review_status: entry.body.decision === 'approve' ? 'approved' : 'rejected' } } };
      return {};
    },
    'atlas-reports': (entry) => {
      calls.reports.push(entry);
      const params = new URL(`http://x${entry.search}`).searchParams;
      return reportsSnapshot({
        preset: params.get('preset') || 'last_30_days',
        start: params.get('start_date') || '2026-08-26',
        end: params.get('end_date') || '2026-09-24',
        comparison: params.get('comparison') === 'none' ? null : { start: params.get('comparison_start_date') || '2026-07-27', end: params.get('comparison_end_date') || '2026-08-25' }
      });
    },
    'atlas-marketing-workspace': (entry) => { calls.marketing.push(entry); return marketingWorkspace(); },
    ...(overrides.functions || {})
  };
  const rpc = {
    atlas_data_review_summary: dataReviewSummary,
    atlas_data_review_rows: (body) => {
      const rows = dataReviewRows[body.p_issue] || [];
      calls.rpc.push({ name: 'atlas_data_review_rows', body });
      return { issue: body.p_issue, label: '', entity_type: 'inventory_item', total: rows.length, limit: body.p_limit, offset: body.p_offset, rows };
    },
    atlas_par_level_evidence: (body) => { calls.rpc.push({ name: 'atlas_par_level_evidence', body }); return parEvidence(body.p_cover_days); },
    atlas_apply_par_levels: (body) => { calls.rpc.push({ name: 'atlas_apply_par_levels', body }); return { status: 'applied', request_id: body.p_request_id, changed: body.p_changes.map((change) => ({ item_id: change.item_id, from: change.expected_par_level, to: change.par_level })), unchanged: [], conflicts: [], replayed: false }; },
    ...(overrides.rpc || {})
  };
  const tables = { inventory_items: inventory, recipes, suppliers: [], recipe_categories: [], import_batches: () => state.batches, ...(overrides.tables || {}) };
  return { fixtures: { tables, rpc, functions, writes: overrides.writes }, calls, state };
}
