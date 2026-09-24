// Atlas AI Tool Gateway enforcement: order of checks, verified actor, strict
// arguments, caps, failure mapping, role redaction and audit, plus the full
// role matrix over every tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, TOOL_REGISTRY, redactForRole, COMMERCIAL_KEYS } from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { actorFor, allKeys, createBackend, IDS, makeCtx } from './helpers/ai-tools-fixtures.js';

// Valid arguments for every tool (used by the role matrix).
export const SAMPLE_ARGS = {
  'inventory.search': { query: 'pinot', category: null, include_inactive: null, limit: null },
  'inventory.get': { item_id: IDS.angelo },
  'inventory.current_stock': { item_ids: null, query: null, category: null, limit: null },
  'inventory.below_par': { category: null, limit: null },
  'inventory.stale_counts': { category: null, days: null, limit: null },
  'inventory.lookup_barcode': { code: '5000299223017' },
  'inventory.prepare_count': { entries: [{ item_id: null, item_query: 'Tanqueray', quantity: 6, unit: 'bottle', note: null }], title: null, note: null },
  'inventory.identify_from_image': { media_id: IDS.photo, mode: 'identify', purchase_order_id: null, count_session_id: null },
  'inventory.resolve_name': { name: 'Aperol 70cl', limit: null },
  'inventory.propose_alias': { item_id: IDS.campari, alias: 'Campari Bitter', alias_kind: null, language: null, reason: 'Label wording', recognition_request_id: null },
  'inventory.propose_item': { name: 'Monin Lavender Syrup', brand: 'Monin', variant: 'Lavender', category: 'Syrups', item_class: 'syrup', packaging_type: 'bottle', unit: 'bottles', unit_size_quantity: 700, unit_size_base: 'ml', units_per_case: null, barcode: null, notes: null, recognition_request_id: null },
  'inventory.report_wrong_match': { item_id: IDS.tanqueray, suggested_item_id: null, note: 'The photo was a different gin.', recognition_request_id: null },
  'recipes.search': { query: null, status: null, limit: null },
  'recipes.get': { recipe_id: IDS.margarita, recipe_query: null },
  'recipes.can_make': { recipe_id: null, recipe_query: 'Pinot Spritz', servings: 10 },
  'recipes.cost': { recipe_id: IDS.spritz, recipe_query: null },
  'recipes.best_margin': { limit: null, ready_only: null, menu_only: null },
  'purchasing.suggest': { supplier_id: null, include_ordered: null },
  'purchasing.get_supplier': { supplier_id: null, supplier_query: 'Globus' },
  'purchasing.prepare_draft_po': { supplier_id: IDS.supplierVin, supplier_query: null, use_suggestions: true, lines: null, note: null, expected_delivery_date: null },
  'purchasing.order_status': { status: null, supplier_id: null, limit: null },
  'purchasing.compare_delivery': { purchase_order_id: IDS.po1, observed: [{ item_id: IDS.tequila, name: null, quantity: 6, unit_cost: null }], note: null },
  'purchasing.cost_changes': { days: null, min_increase_percent: null, limit: null },
  'reports.sales': { period: 'today' },
  'reports.margin': { query: null, menu_only: null, limit: null },
  'reports.inventory_value': { category: null },
  'reports.spend': { days: null },
  'reports.waste': { days: null },
  'operations.status': { date: null },
  'operations.alerts': {},
  'briefing.today': {},
  'shifts.schedule': { week_start: null },
  'shifts.who_is_working': { day: 'today', date: null },
  'shifts.prepare_draft': { person_id: null, person_query: 'Anna', date: '2026-09-27', start_time: '17:00', end_time: '23:00', role_name: null, break_minutes: null, note: null },
  'team.get_profile': { profile_id: null, query: null },
  'team.prepare_message': { channel_key: 'general', body: 'Delivery arrives at 3pm.', link_type: null, link_key: null, link_label: null },
  'knowledge.search': { query: 'closing', limit: null },
  'knowledge.get': { article_id: IDS.article },
  'knowledge.prepare_draft': { article_id: null, title: 'Glass washer', summary: null, content: 'Empty the filter nightly.', category_id: null, category_query: 'Bar procedures', article_type: 'sop', target_roles: null, required: null, change_note: null },
  'settings.read': { section: null },
  'settings.suggest_change': { section: 'hours', change: 'Set opening hours for Friday', reason: null },
  'decisions.history': { query: 'Angelo', subject_type: null, subject_key: null, limit: null },
  'data_quality.review_list': { issue: null, limit: null, offset: null },
  'data_quality.par_suggestions': { item_ids: null, cover_days: 7, limit: null },
  'marketing.suggestions': { date: null },
  'integrations.status': {},
  'app.open': { target: 'recipes', record_type: 'recipe', record_id: IDS.margarita, label: 'Margarita' },
};

const MANAGER_TABLES = new Set(['inventory_items', 'inventory_movements', 'recipes', 'recipe_ingredients', 'suppliers', 'purchase_orders']);

test('every tool has sample arguments that pass validation', () => {
  assert.deepEqual(Object.keys(SAMPLE_ARGS).sort(), TOOL_REGISTRY.map((entry) => entry.name).sort());
});

for (const role of ['admin', 'manager', 'bartender', 'viewer']) {
  test(`role matrix: ${role}`, async () => {
    const backend = createBackend();
    for (const entry of TOOL_REGISTRY) {
      const { ctx } = makeCtx(role, { backend });
      const result = await runTool(entry.name, SAMPLE_ARGS[entry.name], ctx);
      if (!entry.roles.includes(role)) {
        assert.equal(result.ok, false, `${role} must not run ${entry.name}`);
        assert.equal(result.error.code, 'forbidden', `${entry.name}`);
        continue;
      }
      if (entry.name === 'reports.sales') {
        assert.equal(result.error.code, 'not_connected');
        continue;
      }
      assert.equal(result.ok, true, `${role} ${entry.name}: ${JSON.stringify(result.error)}`);
      assert.equal(typeof result.summary, 'string');
      assert.ok(Array.isArray(result.evidence) && Array.isArray(result.records));
      for (const evidence of result.evidence) {
        assert.ok(['fact', 'calculation', 'interpretation', 'estimate', 'missing'].includes(evidence.kind));
        assert.ok(evidence.label);
      }
      if (result.proposal) assert.ok(result.proposal.required_roles.includes(role), `${entry.name} proposal approvable by ${role}`);
      if (role === 'bartender' || role === 'viewer') {
        const leaked = [...allKeys(result)].filter((key) => COMMERCIAL_KEYS.has(key));
        assert.deepEqual(leaked, [], `${role} ${entry.name} leaked ${leaked}`);
        assert.doesNotMatch(JSON.stringify(result), /ISK|Vínbúð|Globus|cost_price/, `${role} ${entry.name} leaks commercial text`);
      }
    }
    if (role === 'bartender' || role === 'viewer') {
      const managerReads = backend.calls.filter((call) => call.kind === 'rest' && MANAGER_TABLES.has(call.name));
      assert.deepEqual(managerReads, [], `${role} read manager-only tables`);
      assert.ok(!backend.calls.some((call) => call.kind === 'userRpc'), `${role} called manager RPCs`);
      assert.ok(backend.calls.filter((call) => call.kind === 'serviceRpc').every((call) => !call.args?.p_actor_role || call.args.p_actor_role === role));
    }
    assert.deepEqual(backend.writes, [], 'no tool (read or draft) writes anything');
  });
}

test('gateway order: unknown tool, inactive actor, role, then arguments', async () => {
  const { ctx, audits } = makeCtx('viewer');
  assert.equal((await runTool('inventory.nope', {}, ctx)).error.code, 'not_found');
  const inactive = makeCtx('manager', { actor: actorFor('manager', { active: false }) }).ctx;
  assert.equal((await runTool('inventory.below_par', { category: null, limit: null }, inactive)).error.code, 'forbidden');
  const unknownRole = makeCtx('manager', { actor: actorFor('manager', { role: 'owner' }) }).ctx;
  assert.equal((await runTool('inventory.below_par', { category: null, limit: null }, unknownRole)).error.code, 'forbidden');
  // Role is checked before arguments: a viewer learns nothing about recipes.cost's schema.
  const forbidden = await runTool('recipes.cost', { nonsense: true }, ctx);
  assert.equal(forbidden.error.code, 'forbidden');
  assert.ok(audits.some((entry) => entry.tool_name === 'recipes.cost' && entry.decision === 'denied' && entry.status === 'denied'));
  const noActor = await runTool('inventory.below_par', { category: null, limit: null }, { ...ctx, actor: null });
  assert.equal(noActor.error.code, 'forbidden');
});

test('malformed and extra arguments are rejected before any data is read', async () => {
  const backend = createBackend();
  const { ctx } = makeCtx('manager', { backend });
  const extra = await runTool('inventory.below_par', { category: null, limit: null, p_actor_role: 'admin' }, ctx);
  assert.equal(extra.error.code, 'invalid_arguments');
  assert.match(extra.error.message, /p_actor_role is not an accepted argument/);
  assert.equal((await runTool('inventory.below_par', { category: null }, ctx)).error.code, 'invalid_arguments');
  assert.equal((await runTool('inventory.get', { item_id: 'not-a-uuid' }, ctx)).error.code, 'invalid_arguments');
  assert.equal((await runTool('recipes.can_make', { recipe_id: null, recipe_query: 'x', servings: -1 }, ctx)).error.code, 'invalid_arguments');
  assert.equal((await runTool('inventory.below_par', '{not json', ctx)).error.code, 'invalid_arguments');
  assert.equal(backend.calls.length, 0);
  const asJson = await runTool('inventory_below_par', JSON.stringify({ category: null, limit: 5 }), ctx);
  assert.equal(asJson.ok, true, 'function-name form and JSON string arguments are accepted');
});

test('the actor always comes from ctx: arguments cannot choose the role or user', async () => {
  const backend = createBackend();
  const { ctx } = makeCtx('bartender', { backend });
  await runTool('shifts.schedule', { week_start: null }, ctx);
  const rpc = backend.calls.find((call) => call.name === 'atlas_shifts_snapshot');
  assert.equal(rpc.args.p_actor_role, 'bartender');
  assert.equal(rpc.args.p_actor_id, IDS.bartender);
  const knowledge = await runTool('knowledge.search', { query: 'closing', limit: null }, ctx);
  assert.equal(knowledge.ok, true);
  const search = backend.calls.find((call) => call.name === 'atlas_knowledge_search');
  assert.deepEqual([search.args.p_actor_id, search.args.p_actor_role], [IDS.bartender, 'bartender']);
});

test('audit hook receives one redacted record per call and its failure never breaks the tool', async () => {
  const { ctx, audits } = makeCtx('manager');
  await runTool('team.prepare_message', { channel_key: 'general', body: 'x'.repeat(300), link_type: null, link_key: null, link_label: null }, ctx);
  const entry = audits.at(-1);
  assert.equal(entry.tool_name, 'team.prepare_message');
  assert.equal(entry.level, 'draft');
  assert.equal(entry.decision, 'allowed');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.proposal_kind, 'team_message.send');
  assert.equal(entry.arguments_redacted.body, '[300 characters]');
  assert.equal(entry.run_id, 'run-1');
  assert.equal(entry.conversation_id, 'conversation-1');
  assert.ok(entry.evidence_count >= 1);
  const throwing = makeCtx('manager', { audit: async () => { throw new Error('db down'); } }).ctx;
  assert.equal((await runTool('inventory.below_par', { category: null, limit: null }, throwing)).ok, true);
});

test('per-run tool call cap', async () => {
  const { ctx } = makeCtx('manager', { limits: { maxToolCallsPerRun: 2 } });
  const args = { target: 'home', record_type: null, record_id: null, label: null };
  assert.equal((await runTool('app.open', args, ctx)).ok, true);
  assert.equal((await runTool('app.open', args, ctx)).ok, true);
  assert.equal((await runTool('app.open', args, ctx)).error.code, 'limit_exceeded');
});

test('backend failures become plain failures, never invented results', async () => {
  const offline = makeCtx('manager', { fetch: async () => { throw new Error('network'); } }).ctx;
  const result = await runTool('inventory.below_par', { category: null, limit: null }, offline);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unavailable');
  const { ctx } = makeCtx('manager');
  assert.equal((await runTool('inventory.get', { item_id: IDS.po1 }, ctx)).error.code, 'not_found');
  assert.equal((await runTool('knowledge.get', { article_id: IDS.po1 }, ctx)).error.code, 'not_found');
  const noConfig = makeCtx('manager', { env: {} }).ctx;
  assert.equal((await runTool('inventory.below_par', { category: null, limit: null }, noConfig)).error.code, 'unavailable');
});

test('runtime ctx shape: now() returning a Date, env.get, and the runtime\'s own services ({ rpc }) are handled', async () => {
  const backend = createBackend();
  const rpcCalls = [];
  const { ctx } = makeCtx('manager', {
    backend,
    now: () => new Date('2026-09-24T12:00:00Z'),
    env: { get: (name) => ({ SUPABASE_URL: 'https://branch.test', ATLAS_AUTH_PROJECT_URL: 'https://prod.test', ATLAS_AUTH_PUBLISHABLE_KEY: 'pk-test', SUPABASE_SERVICE_ROLE_KEY: 'service-key' })[name] },
    services: { rpc: async (name) => { rpcCalls.push(name); return null; } },
  });
  const result = await runTool('inventory.below_par', { category: null, limit: null }, ctx);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.data.counts.current_items, 4, 'the Date from now() drives the stock projection');
  assert.deepEqual(rpcCalls, [], 'the runtime rpc client is not used for Atlas data');
  const later = makeCtx('manager', { backend, now: () => new Date('2026-10-30T12:00:00Z') }).ctx;
  assert.equal((await runTool('inventory.below_par', { category: null, limit: null }, later)).data.counts.current_items, 0, 'counts expire with the clock');
});

test('a column missing from the production schema is dropped and the read retried', async () => {
  const backend = createBackend({ unsupportedColumns: { inventory_items: ['brand', 'needs_review'] } });
  const result = await runTool('inventory.below_par', { category: null, limit: null }, makeCtx('manager', { backend }).ctx);
  assert.equal(result.ok, true);
  const reads = backend.calls.filter((call) => call.name === 'inventory_items');
  assert.equal(reads.length, 3);
  assert.ok(!reads.at(-1).select.includes('brand') && !reads.at(-1).select.includes('needs_review'));
  assert.equal(result.data.counts.below_par, 1);
});

test('redaction backstop strips commercial fields and evidence for staff exactly like reportSources', () => {
  const leaky = {
    ok: true,
    summary: 's',
    data: { items: [{ name: 'Angelo', cost_price: 3000, supplier: 'Vín', supplier_id: 'x', quantity: 10, nested: { unit_cost: 1, total_cost: 2 } }], estimated_value: 5 },
    evidence: [
      { kind: 'fact', label: 'Stock of Angelo', value: '10 bottle', source: { type: 'inventory_item', id: '1' } },
      { kind: 'fact', label: 'Cost of Angelo', value: '3000 ISK', source: { type: 'inventory_item', id: '1' } },
      { kind: 'fact', label: 'Supplier', value: 'Vín', source: { type: 'supplier', id: 's' } },
    ],
    records: [{ type: 'inventory_item', id: '1' }, { type: 'purchase_order', id: 'p' }],
    proposal: null,
    unknown: null,
  };
  const staff = redactForRole(leaky, 'bartender');
  assert.deepEqual(staff.data, { items: [{ name: 'Angelo', quantity: 10, nested: {} }] });
  assert.deepEqual(staff.evidence.map((entry) => entry.label), ['Stock of Angelo']);
  assert.deepEqual(staff.records.map((entry) => entry.type), ['inventory_item']);
  assert.equal(redactForRole(leaky, 'manager'), leaky);
});
