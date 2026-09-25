// Atlas AI Execute side (approved proposals only) and structured
// conversation context / follow-up resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextPatch, contextSummaryForPrompt, executeProposal, modifyProposalArgs, parseQuantity, resolveDateReference,
  resolveFilterReference, resolveFollowUp, runTool,
} from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { createBackend, IDS, makeCtx } from './helpers/ai-tools-fixtures.js';

async function draft(role, name, args, backend) {
  const result = await runTool(name, args, makeCtx(role, { backend }).ctx);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.proposal, `${name} returned a proposal`);
  return result;
}

test('voice note "six Tanqueray and two Campari" → count proposal → approved count session, never a stock adjustment', async () => {
  const backend = createBackend();
  const drafted = await draft('bartender', 'inventory.prepare_count', {
    entries: [
      { item_id: null, item_query: 'Tanqueray', quantity: 6, unit: 'bottle', note: null },
      { item_id: null, item_query: 'campari', quantity: 2, unit: 'bottle', note: null },
    ],
    title: null,
    note: null,
  }, backend);
  const { proposal } = drafted;
  assert.equal(proposal.kind, 'stock_count.draft');
  assert.deepEqual(proposal.command.entries.map((entry) => [entry.item_id, entry.quantity, entry.unit]), [[IDS.tanqueray, 6, 'bottle'], [IDS.campari, 2, 'bottle']]);
  assert.deepEqual([proposal.command.scope_type, proposal.command.scope_value], ['category', 'Spirits']);
  assert.ok(proposal.preview.will_not_change.some((line) => /Stock does not change now/.test(line)));
  assert.deepEqual(backend.writes, [], 'drafting changes nothing');

  const executed = await executeProposal(proposal.kind, proposal.command, makeCtx('bartender', { backend }).ctx);
  assert.equal(executed.ok, true, JSON.stringify(executed.error));
  assert.deepEqual(backend.writes.map((write) => write.name), ['stock-counts:start', 'stock-counts:save-line', 'stock-counts:save-line']);
  const start = backend.writes[0].body;
  assert.equal(start.client_request_id, proposal.command.client_request_id);
  const lines = backend.writes.slice(1).map((write) => write.body);
  assert.deepEqual(lines.map((line) => [line.session_id, line.line_status, line.observed_input_quantity, line.observed_input_unit, line.expected_version]), [
    [IDS.session, 'counted', 6, 'bottle', 1], [IDS.session, 'counted', 2, 'bottle', 1],
  ]);
  assert.equal(executed.result.data.stock_changed, false);
  assert.equal(executed.result.data.saved.length, 2);
  assert.ok(!backend.calls.some((call) => /adjust_inventory|submit|verify|publish/.test(call.name)), 'the count is left for normal verification');
});

test('ambiguous voice-note items produce a clarification, not a proposal', async () => {
  const result = await runTool('inventory.prepare_count', { entries: [{ item_id: null, item_query: 'pinot', quantity: 3, unit: null, note: null }, { item_id: null, item_query: 'vodka', quantity: 1, unit: null, note: null }], title: null, note: null }, makeCtx('manager').ctx);
  assert.equal(result.proposal, null);
  assert.deepEqual(result.data.needs_clarification.map((entry) => [entry.query, entry.status]), [['pinot', 'ambiguous'], ['vodka', 'not_found']]);
  assert.deepEqual(result.data.needs_clarification[0].candidates.map((candidate) => candidate.name).sort(), ['Angelo Pinot Grigio', 'House Pinot Noir']);
});

test('approved draft purchase order runs atlas_purchase_order_command_v2 create with the stored command and the user JWT', async () => {
  const backend = createBackend();
  const { proposal } = await draft('manager', 'purchasing.prepare_draft_po', { supplier_id: IDS.supplierVin, supplier_query: null, use_suggestions: true, lines: null, note: null, expected_delivery_date: null }, backend);
  const executed = await executeProposal(proposal.kind, proposal.command, makeCtx('manager', { backend }).ctx);
  assert.equal(executed.ok, true);
  const call = backend.calls.find((entry) => entry.name === 'atlas_purchase_order_command_v2');
  assert.equal(call.kind, 'userRpc');
  assert.equal(call.role, 'manager');
  assert.equal(call.args.p_id, proposal.command.p_id);
  assert.equal(call.args.p_action, 'create');
  assert.deepEqual(call.args.p_lines, proposal.command.p_lines);
  assert.equal(executed.result.data.status, 'draft');
  assert.equal(executed.result.records[0].route, `#purchasing/order/${proposal.command.p_id}`);
});

test('approved receiving runs receive_lines with version and request id; only what arrived', async () => {
  const backend = createBackend();
  const { proposal } = await draft('manager', 'purchasing.compare_delivery', { purchase_order_id: IDS.po1, observed: [{ item_id: IDS.aperol, name: null, quantity: 4, unit_cost: null }], note: null }, backend);
  const executed = await executeProposal(proposal.kind, proposal.command, makeCtx('admin', { backend }).ctx);
  assert.equal(executed.ok, true);
  const { args } = backend.writes[0];
  assert.deepEqual([args.p_action, args.p_version, args.p_request_id], ['receive_lines', 3, proposal.command.p_request_id]);
  assert.deepEqual(args.p_receipt, [{ item_id: IDS.aperol, quantity: 4 }], 'a null unit cost is omitted so the ordered cost applies');
});

test('execution re-checks the role against the kind, whatever the stored required_roles say', async () => {
  const backend = createBackend();
  const { proposal } = await draft('manager', 'purchasing.prepare_draft_po', { supplier_id: IDS.supplierVin, supplier_query: null, use_suggestions: true, lines: null, note: null, expected_delivery_date: null }, backend);
  for (const role of ['bartender', 'viewer']) {
    const result = await executeProposal(proposal.kind, proposal.command, makeCtx(role, { backend }).ctx);
    assert.equal(result.error.code, 'forbidden', role);
  }
  const announcement = await draft('manager', 'team.prepare_message', { channel_key: 'announcements', body: 'Staff meeting at 14:00', link_type: null, link_key: null, link_label: null }, backend);
  assert.equal((await executeProposal('team_message.send', announcement.proposal.command, makeCtx('bartender', { backend }).ctx)).error.code, 'forbidden');
  const inactive = makeCtx('manager', { backend }).ctx;
  inactive.actor = { ...inactive.actor, active: false };
  assert.equal((await executeProposal(proposal.kind, proposal.command, inactive)).error.code, 'forbidden');
  assert.deepEqual(backend.writes, []);
});

test('tampered or unknown stored commands are refused before anything runs', async () => {
  const backend = createBackend();
  const ctx = makeCtx('manager', { backend }).ctx;
  const { proposal } = await draft('manager', 'purchasing.prepare_draft_po', { supplier_id: IDS.supplierVin, supplier_query: null, use_suggestions: true, lines: null, note: null, expected_delivery_date: null }, backend);
  assert.equal((await executeProposal(proposal.kind, { ...proposal.command, p_action: 'place' }, ctx)).error.code, 'invalid_arguments');
  assert.equal((await executeProposal(proposal.kind, { ...proposal.command, p_actor_role: 'admin' }, ctx)).error.code, 'invalid_arguments');
  assert.equal((await executeProposal(proposal.kind, { ...proposal.command, p_lines: [] }, ctx)).error.code, 'invalid_arguments');
  assert.equal((await executeProposal('inventory.adjust', { item_id: IDS.angelo }, ctx)).error.code, 'not_found');
  assert.deepEqual(backend.writes, []);
});

test('link-only suggestions are never executed', async () => {
  const ctx = makeCtx('manager').ctx;
  const settings = await executeProposal('settings.suggestion', { section: 'hours', change: 'Set hours', reason: null }, ctx);
  assert.equal(settings.error.code, 'not_executable');
  const par = await executeProposal('par_level.suggestion', { cover_days: 7, items: [{ item_id: IDS.tanqueray, item_name: 'Tanqueray Gin', current_par: null, suggested_par: 4, cases: 1 }] }, ctx);
  assert.equal(par.error.code, 'not_executable');
});

test('shift, message and knowledge proposals execute through their gateways and never publish', async () => {
  const backend = createBackend();
  const shift = await draft('manager', 'shifts.prepare_draft', { person_id: IDS.personAnna, person_query: null, date: '2026-09-27', start_time: '17:00', end_time: '23:00', role_name: 'Bar', break_minutes: null, note: null }, backend);
  const message = await draft('bartender', 'team.prepare_message', { channel_key: 'general', body: 'Limes are low.', link_type: null, link_key: null, link_label: null }, backend);
  const article = await draft('admin', 'knowledge.prepare_draft', { article_id: null, title: 'Glass washer', summary: 'Nightly', content: 'Empty the filter.', category_id: IDS.categoryBar, category_query: null, article_type: 'sop', target_roles: ['bartender'], required: true, change_note: null }, backend);
  assert.equal((await executeProposal('shift.draft', shift.proposal.command, makeCtx('manager', { backend }).ctx)).ok, true);
  assert.equal((await executeProposal('team_message.send', message.proposal.command, makeCtx('bartender', { backend }).ctx)).ok, true);
  const saved = await executeProposal('knowledge.draft', article.proposal.command, makeCtx('manager', { backend }).ctx);
  assert.equal(saved.result.data.published, false);
  assert.deepEqual(backend.writes.map((write) => write.name), ['shifts:save-shift', 'team-messages:send', 'knowledge:save-draft']);
  assert.deepEqual(backend.writes[0].body, { shift_id: null, week_start: '2026-09-21', person_id: IDS.personAnna, role_name: 'Bar', starts_local: '2026-09-27T17:00', ends_local: '2026-09-27T23:00', break_minutes: 0, note: null });
  assert.equal(backend.writes[1].body.client_request_id, message.proposal.command.client_request_id);
  assert.ok(!backend.calls.some((call) => /publish/.test(call.name)));
  const failed = await executeProposal('shift.draft', shift.proposal.command, makeCtx('manager', { backend: createBackend(), fetch: async () => { throw new Error('offline'); } }).ctx);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'unavailable', 'an unconfirmed action is never reported as done');
});

test('context patch records last records, date focus, filters and the last proposal', async () => {
  const ctx = makeCtx('manager').ctx;
  const args = { category: 'Wine', limit: null };
  const below = await runTool('inventory.below_par', args, ctx);
  const patch = buildContextPatch('inventory.below_par', below, {}, args);
  assert.equal(patch.last_tool, 'inventory.below_par');
  assert.deepEqual(patch.filters, { category: 'Wine' });
  assert.equal(patch.last_subject.id, IDS.angelo);
  assert.ok(patch.last_evidence.length > 0);
  const who = await runTool('shifts.who_is_working', { day: 'tomorrow', date: null }, ctx);
  assert.equal(buildContextPatch('shifts.who_is_working', who, patch).date_focus, '2026-09-25');
  const poArgs = { supplier_id: IDS.supplierVin, supplier_query: null, use_suggestions: true, lines: null, note: null, expected_delivery_date: null };
  const po = await runTool('purchasing.prepare_draft_po', poArgs, ctx);
  const poPatch = buildContextPatch('purchasing.prepare_draft_po', po, patch, poArgs);
  assert.equal(poPatch.last_proposal.kind, 'purchase_order.create');
  assert.deepEqual(poPatch.last_proposal.lines, [{ item_id: IDS.angelo, name: 'Angelo Pinot Grigio', quantity: 18, units_per_case: 6, unit: 'bottle' }]);
  assert.deepEqual(buildContextPatch('reports.sales', { ok: false, error: { code: 'not_connected' } }, {}), { last_tool: 'reports.sales', last_error: 'not_connected' });
  assert.match(contextSummaryForPrompt({ ...patch, ...poPatch }), /Active filter: category = Wine\..*Last proposal \(not executed unless approved\): purchase_order\.create/);
});

test('follow-ups resolve against the structured context', async () => {
  const ctx = makeCtx('manager').ctx;
  const businessDate = '2026-09-24';
  const whoArgs = { day: 'today', date: null };
  const who = await runTool('shifts.who_is_working', whoArgs, ctx);
  const context = buildContextPatch('shifts.who_is_working', who, {}, whoArgs);
  const tomorrow = resolveFollowUp('What about tomorrow?', context, { businessDate });
  assert.deepEqual(tomorrow, { kind: 'date', date: '2026-09-25', tool: 'shifts.who_is_working', args: { day: null, date: '2026-09-25' } });
  const rerun = await runTool(tomorrow.tool, tomorrow.args, ctx);
  assert.deepEqual(rerun.data.shifts.map((shift) => shift.name), ['Bjarni']);

  const belowArgs = { category: null, limit: null };
  const below = await runTool('inventory.below_par', belowArgs, ctx);
  const onlyWines = resolveFollowUp('Only wines', buildContextPatch('inventory.below_par', below, {}, belowArgs), { businessDate });
  assert.deepEqual(onlyWines, { kind: 'filter', filters: { category: 'Wine' }, tool: 'inventory.below_par', args: { category: 'Wine', limit: null } });
  assert.equal((await runTool(onlyWines.tool, onlyWines.args, ctx)).data.counts.active_items, 2);

  const suggestArgs = { supplier_id: IDS.supplierVin, include_ordered: null };
  const suggest = await runTool('purchasing.suggest', suggestArgs, ctx);
  const prepare = resolveFollowUp('Prepare that', buildContextPatch('purchasing.suggest', suggest, {}, suggestArgs), { businessDate });
  assert.equal(prepare.tool, 'purchasing.prepare_draft_po');
  assert.deepEqual(prepare.needs, []);
  const drafted = await runTool(prepare.tool, prepare.args, ctx);
  assert.equal(drafted.proposal.command.p_lines[0].quantity, 18);

  const change = resolveFollowUp('Change it to three cases', buildContextPatch(prepare.tool, drafted, {}, prepare.args), { businessDate });
  assert.equal(change.kind, 'modify_proposal');
  assert.deepEqual(change.args.lines, [{ item_id: IDS.angelo, item_query: null, quantity: 18, unit_cost: null }]);
  const two = modifyProposalArgs(buildContextPatch(prepare.tool, drafted, {}, prepare.args).last_proposal, 'make it two cases');
  const redrafted = await runTool(two.tool, two.args, ctx);
  assert.equal(redrafted.proposal.command.p_lines[0].quantity, 12);

  const why = resolveFollowUp('Why?', buildContextPatch('purchasing.suggest', suggest, {}, suggestArgs));
  assert.equal(why.kind, 'why');
  assert.ok(why.evidence.length > 0);
  assert.deepEqual(resolveFollowUp('Change it to three cases', {}), { kind: null });
});

test('resolution helpers: dates, filters and spoken quantities', () => {
  const base = { businessDate: '2026-09-24' };
  assert.equal(resolveDateReference('what about tomorrow', base), '2026-09-25');
  assert.equal(resolveDateReference('the day after tomorrow', base), '2026-09-26');
  assert.equal(resolveDateReference('and friday?', base), '2026-09-25');
  assert.equal(resolveDateReference('next thursday', base), '2026-10-01');
  assert.equal(resolveDateReference('nothing here', base), null);
  assert.deepEqual(resolveFilterReference('only wines'), { category: 'Wine' });
  assert.deepEqual(resolveFilterReference('just the beer'), { category: 'Beer' });
  assert.deepEqual(resolveFilterReference('all categories please'), { category: null });
  assert.equal(parseQuantity('six Tanqueray'), 6);
  assert.equal(parseQuantity('3 cases'), 3);
  assert.equal(parseQuantity('a dozen'), 12);
  assert.equal(parseQuantity('some'), null);
  const count = { tool: 'inventory.prepare_count', args: { entries: [{ item_id: IDS.tanqueray, item_query: null, quantity: 6, unit: 'bottle', note: null }, { item_id: IDS.campari, item_query: null, quantity: 2, unit: 'bottle', note: null }], title: null, note: null }, lines: [{ item_id: IDS.tanqueray, name: 'Tanqueray Gin', quantity: 6 }, { item_id: IDS.campari, name: 'Campari', quantity: 2 }] };
  assert.deepEqual(modifyProposalArgs(count, 'change campari to four').args.entries.map((entry) => entry.quantity), [6, 4]);
  assert.deepEqual(modifyProposalArgs(count, 'change it to four').needs, ['which_line']);
});
