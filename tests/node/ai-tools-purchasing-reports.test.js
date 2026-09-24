// Atlas AI purchasing and reports tools: canonical order suggestions, draft
// purchase orders and delivery comparison as proposals, cost changes,
// truthful not-connected sales and unknown (not zero) values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, validateCommand } from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { orderSuggestions, projectStock } from '../../supabase/functions/_shared/atlas-domain.mjs';
import { balanceRows, createBackend, IDS, inventoryRows, makeCtx, movementRows, NOW, purchaseOrderRows } from './helpers/ai-tools-fixtures.js';

const run = async (role, name, args, options) => runTool(name, args, makeCtx(role, options).ctx);

test('order suggestions come from the canonical orderSuggestions, grouped by supplier, open orders counted', async () => {
  const result = await run('manager', 'purchasing.suggest', { supplier_id: null, include_ordered: null });
  assert.equal(result.ok, true);
  assert.equal(result.data.groups.length, 1);
  const [group] = result.data.groups;
  assert.equal(group.supplier, 'Vínbúð Heildsala');
  assert.deepEqual(group.lines.map((line) => [line.name, line.order_quantity, line.cases, line.shortfall]), [['Angelo Pinot Grigio', 18, 3, 14]]);
  assert.equal(result.data.estimated_total, 54000);
  assert.deepEqual(result.data.already_ordered.map((entry) => entry.name), ['Aperol'], 'Aperol is on a placed order');
  assert.deepEqual(result.data.counts, { suggested: 1, already_ordered: 1, missing_par: 3, par_but_unknown_stock: 2 });
  assert.equal(result.unknown.count, 5);
  const canonical = orderSuggestions(projectStock(inventoryRows(), balanceRows(), movementRows(), NOW).filter((item) => item.active !== false), { purchaseOrders: purchaseOrderRows() });
  assert.deepEqual(canonical.map((entry) => [entry.id, entry.orderQuantity, entry.ordered]), [[IDS.angelo, 18, false], [IDS.aperol, 6, true]]);
  assert.ok(result.evidence.some((entry) => entry.kind === 'estimate' && entry.value === '54,000 ISK'));
  assert.ok(result.evidence.some((entry) => entry.kind === 'calculation' && /verified 10 bottle < par 12; target 24, shortfall 14, 3 case\(s\) = 18/.test(entry.value)));
  const withOrdered = await run('manager', 'purchasing.suggest', { supplier_id: null, include_ordered: true });
  assert.equal(withOrdered.data.groups.flatMap((entry) => entry.lines).length, 2);
});

test('draft purchase order is a proposal with a pre-generated p_id and the exact v2 create command', async () => {
  const backend = createBackend();
  const result = await run('manager', 'purchasing.prepare_draft_po', { supplier_id: null, supplier_query: 'vínbúð', use_suggestions: true, lines: null, note: null, expected_delivery_date: '2026-09-26' }, { backend });
  assert.equal(result.ok, true);
  const { proposal } = result;
  assert.equal(proposal.kind, 'purchase_order.create');
  assert.deepEqual(proposal.required_roles, ['admin', 'manager']);
  assert.equal(proposal.executable, true);
  assert.equal(proposal.command.p_action, 'create');
  assert.match(proposal.command.p_id, /^[0-9a-f-]{36}$/);
  assert.equal(proposal.command.p_supplier_id, IDS.supplierVin);
  assert.deepEqual(proposal.command.p_lines, [{ item_id: IDS.angelo, quantity: 18, unit_cost: 3000 }]);
  assert.equal(proposal.command.p_expected_delivery_date, '2026-09-26');
  assert.equal(validateCommand('purchase_order.create', proposal.command).ok, true);
  assert.equal(proposal.preview.totals.estimated_total, 54000);
  assert.deepEqual(proposal.preview.lines, [{ label: 'Angelo Pinot Grigio', detail: '18 bottle × 3,000 ISK = 54,000 ISK' }]);
  assert.ok(proposal.preview.will_not_change.some((line) => /not placed/.test(line)));
  assert.equal(proposal.subject_type, 'purchase_order');
  assert.deepEqual(backend.writes, [], 'drafting writes nothing');
  assert.ok(!backend.calls.some((call) => call.name === 'atlas_purchase_order_command_v2'));
});

test('draft purchase order asks instead of guessing, and enforces date and spend caps', async () => {
  const ambiguous = await run('manager', 'purchasing.prepare_draft_po', { supplier_id: IDS.supplierGlobus, supplier_query: null, use_suggestions: null, lines: [{ item_id: null, item_query: 'pinot', quantity: 6, unit_cost: null }], note: null, expected_delivery_date: null });
  assert.equal(ambiguous.proposal, null);
  assert.equal(ambiguous.data.needs_clarification[0].status, 'ambiguous');
  const past = await run('manager', 'purchasing.prepare_draft_po', { supplier_id: IDS.supplierGlobus, supplier_query: null, use_suggestions: null, lines: [{ item_id: IDS.tanqueray, item_query: null, quantity: 6, unit_cost: null }], note: null, expected_delivery_date: '2026-09-01' });
  assert.equal(past.error.code, 'invalid_arguments');
  const huge = await run('manager', 'purchasing.prepare_draft_po', { supplier_id: IDS.supplierGlobus, supplier_query: null, use_suggestions: null, lines: [{ item_id: IDS.tanqueray, item_query: null, quantity: 5000, unit_cost: null }], note: null, expected_delivery_date: null });
  assert.equal(huge.error.code, 'limit_exceeded');
  const crossSupplier = await run('manager', 'purchasing.prepare_draft_po', { supplier_id: IDS.supplierGlobus, supplier_query: null, use_suggestions: null, lines: [{ item_id: IDS.angelo, item_query: null, quantity: 6, unit_cost: 2900 }], note: null, expected_delivery_date: null });
  assert.equal(crossSupplier.proposal.command.p_lines[0].unit_cost, 2900);
  assert.ok(crossSupplier.data.warnings[0].includes('normally supplied by Vínbúð Heildsala'));
  const noLines = await run('manager', 'purchasing.prepare_draft_po', { supplier_id: IDS.supplierGlobus, supplier_query: null, use_suggestions: null, lines: null, note: null, expected_delivery_date: null });
  assert.equal(noLines.error.code, 'invalid_arguments');
});

test('compare delivery: matches and discrepancies, receiving proposal only for what arrived', async () => {
  const backend = createBackend();
  const result = await run('manager', 'purchasing.compare_delivery', {
    purchase_order_id: IDS.po1,
    observed: [
      { item_id: null, name: 'Tequila', quantity: 6, unit_cost: 4800 },
      { item_id: null, name: 'Aperol', quantity: 4, unit_cost: null },
      { item_id: null, name: 'Campari', quantity: 2, unit_cost: null },
    ],
    note: 'Checked at the back door',
  }, { backend });
  assert.equal(result.ok, true);
  const lines = Object.fromEntries(result.data.lines.map((line) => [line.name, line]));
  assert.equal(lines['Tequila Blanco'].status, 'match');
  assert.equal(lines['Tequila Blanco'].price_changed, true);
  assert.equal(lines.Aperol.status, 'short');
  assert.deepEqual(result.data.unexpected, [{ item_id: null, name: 'Campari', quantity: 2 }]);
  assert.deepEqual(result.data.discrepancies.map((entry) => [entry.item, entry.issue, entry.price]), [
    ['Tequila Blanco', 'quantity matches', 'unit cost 4,800 ISK vs ordered 4,500 ISK'],
    ['Aperol', 'short by 2', null],
    ['Campari', 'not on this order (2 delivered)', null],
  ]);
  const { proposal } = result;
  assert.equal(proposal.kind, 'purchase_order.receive');
  assert.equal(proposal.command.p_action, 'receive_lines');
  assert.equal(proposal.command.p_version, 3);
  assert.match(proposal.command.p_request_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(proposal.command.p_receipt.map((line) => [line.item_id, line.quantity, line.unit_cost]), [[IDS.tequila, 6, 4800], [IDS.aperol, 4, null]]);
  assert.ok(proposal.preview.will_not_change.some((line) => /Unexpected items/.test(line)));
  assert.deepEqual(backend.writes, [], 'stock only changes on approval');
});

test('compare delivery refuses to prepare receiving for an order that is not placed', async () => {
  const orders = purchaseOrderRows();
  orders[0].status = 'draft';
  const result = await run('manager', 'purchasing.compare_delivery', { purchase_order_id: IDS.po1, observed: [{ item_id: IDS.tequila, name: null, quantity: 6, unit_cost: null }], note: null }, { backend: createBackend({ purchaseOrders: orders }) });
  assert.equal(result.proposal, null);
  assert.match(result.data.receiving_note, /cannot be received yet/);
});

test('order status lists open orders with expected delivery dates and overdue flags', async () => {
  const result = await run('manager', 'purchasing.order_status', { status: null, supplier_id: null, limit: null });
  assert.equal(result.data.orders.length, 1);
  assert.equal(result.data.orders[0].supplier, 'Globus');
  assert.equal(result.data.orders[0].overdue, true);
  assert.equal(result.data.orders[0].total, 48000);
  const received = await run('manager', 'purchasing.order_status', { status: 'received', supplier_id: null, limit: null });
  assert.equal(received.data.orders[0].id, IDS.po2);
});

test('supplier detail flags missing contact information', async () => {
  const result = await run('manager', 'purchasing.get_supplier', { supplier_id: IDS.supplierVin, supplier_query: null });
  assert.equal(result.data.items.length, 2);
  assert.deepEqual(result.evidence.filter((entry) => entry.kind === 'missing').map((entry) => entry.label), ['Email', 'Phone', 'Contact person']);
});

test('cost changes come from receipt movements, with single receipts counted as unknown', async () => {
  const result = await run('manager', 'purchasing.cost_changes', { days: null, min_increase_percent: null, limit: null });
  assert.equal(result.data.increases.length, 1);
  const [increase] = result.data.increases;
  assert.equal(increase.name, 'Tanqueray Gin');
  assert.equal(Math.round(increase.change_percent * 10) / 10, 11.1);
  assert.deepEqual(result.evidence.map((entry) => entry.kind), ['fact', 'fact', 'calculation']);
  assert.equal(result.evidence[1].source.type, 'movement');
  assert.deepEqual(result.unknown, { count: 1, reason: 'Only one costed receipt in the period, nothing to compare with' });
  const strict = await run('manager', 'purchasing.cost_changes', { days: null, min_increase_percent: 20, limit: null });
  assert.equal(strict.data.increases.length, 0);
});

test('sales are not connected: the tool says so for every role', async () => {
  for (const role of ['admin', 'manager', 'bartender', 'viewer']) {
    const result = await run(role, 'reports.sales', { period: 'week' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not_connected');
    assert.match(result.error.message, /not connected/);
  }
});

test('inventory value is unknown (null), never zero, with a lower bound and counts', async () => {
  const result = await run('manager', 'reports.inventory_value', { category: null });
  assert.equal(result.data.value, null);
  assert.equal(result.data.known_value, 51600);
  assert.equal(result.data.unknown_items, 3);
  assert.equal(result.unknown.breakdown.unknown_stock, 3);
  assert.ok(result.evidence.some((entry) => entry.kind === 'missing' && entry.label === 'Total stock value'));
  assert.ok(result.evidence.some((entry) => entry.kind === 'estimate' && entry.value === '51,600 ISK'));
  const mixers = await run('manager', 'reports.inventory_value', { category: 'Mixers' });
  assert.equal(mixers.data.value, 1600);
  assert.equal(mixers.unknown, null);
});

test('spend, margin and waste reports', async () => {
  const spend = await run('manager', 'reports.spend', { days: 30 });
  assert.equal(spend.data.total, 66000);
  assert.equal(spend.data.uncosted_receipts, 1);
  assert.deepEqual(spend.data.by_supplier, [{ supplier: 'Vínbúð Heildsala', amount: 36000 }, { supplier: 'Globus', amount: 30000 }]);
  const margin = await run('manager', 'reports.margin', { query: null, menu_only: true, limit: 2 });
  assert.equal(margin.data.assessed, 3);
  assert.equal(margin.data.not_assessed, 1);
  assert.equal(margin.data.highest[0].name, 'Gin & Tonic');
  assert.equal(margin.data.lowest[0].name, 'Aperol Spritz');
  const managerWaste = await run('manager', 'reports.waste', { days: 30 });
  assert.equal(managerWaste.data.entries, 1);
  assert.equal(managerWaste.data.estimated_cost, 3000);
  const staffWaste = await run('bartender', 'reports.waste', { days: 30 });
  assert.equal(staffWaste.data.items[0].name, 'Angelo Pinot Grigio');
  assert.ok(!('estimated_cost' in staffWaste.data));
  assert.equal((await run('bartender', 'reports.spend', { days: 30 })).error.code, 'forbidden');
});
