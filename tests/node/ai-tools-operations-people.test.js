// Atlas AI operations, briefing, shifts, team, knowledge, settings, decision
// memory, data quality, marketing, integrations and navigation tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { BUSINESS_DATE, createBackend, IDS, makeCtx } from './helpers/ai-tools-fixtures.js';

const run = async (role, name, args, options) => runTool(name, args, makeCtx(role, options).ctx);

test('operations status uses the venue business date and the shared server checklists', async () => {
  const backend = createBackend();
  const result = await run('bartender', 'operations.status', { date: null }, { backend });
  assert.equal(result.data.business_date, BUSINESS_DATE);
  assert.deepEqual(result.data.routines.map((routine) => [routine.name, routine.status]), [['Bar opening checks', 'completed'], ['Clean coffee machine', 'overdue']]);
  assert.equal(result.data.checklists.opening.status, 'completed');
  assert.match(result.summary, /1 of 2 routines completed, 1 overdue/);
  assert.equal(backend.calls.find((call) => call.name === 'atlas_operations_today').args.p_local_date, BUSINESS_DATE);
  assert.ok(backend.calls.some((call) => call.name === 'atlas_settings_venue_clock'));
  const venue = await run('bartender', 'operations.status', { date: null }, { venue: { timezone: 'Atlantic/Reykjavik', businessDate: '2026-09-23' } });
  assert.equal(venue.data.business_date, '2026-09-23', 'ctx.venue from the runtime wins');
});

test('alerts compose trusted stock/recipe alerts, routine alerts and overdue deliveries (managers)', async () => {
  const manager = await run('manager', 'operations.alerts', {});
  const keys = manager.data.alerts.map((alert) => alert.key);
  assert.ok(keys.includes('inventory-out-stock') && keys.includes('inventory-below-par'));
  assert.ok(keys.includes('recipes-unavailable') && keys.includes('recipes-incomplete'));
  assert.ok(keys.includes(`routine:${IDS.routineCoffee}`));
  assert.ok(keys.includes('purchasing-overdue'));
  assert.equal(manager.unknown.count, 3, 'items without a current count cannot raise stock alerts');
  const staff = await run('viewer', 'operations.alerts', {});
  assert.ok(!staff.data.alerts.some((alert) => alert.key === 'purchasing-overdue'));
});

test('briefing is role-shaped and never invents opening hours', async () => {
  const manager = await run('manager', 'briefing.today', {});
  assert.equal(manager.data.hours, null);
  assert.match(manager.summary, /Opening hours are not set/);
  assert.equal(manager.evidence[0].kind, 'missing');
  assert.equal(manager.data.purchasing.suggested_items, 1);
  assert.deepEqual(manager.data.data_quality.map((issue) => issue.count), [234, 1]);
  const staff = await run('bartender', 'briefing.today', {});
  assert.equal(staff.data.purchasing, undefined);
  assert.equal(staff.data.data_quality, undefined);
  const hours = { weekday: 4, is_open: true, open_time: '16:00:00', close_time: '01:00:00', close_next_day: true, last_order_time: '00:30:00' };
  const backend = createBackend({ venueClock: { timezone: 'Atlantic/Reykjavik', hours_configured: true, business_hours: [hours], offers: [], venue_date: BUSINESS_DATE, business_date: BUSINESS_DATE } });
  const open = await run('viewer', 'briefing.today', {}, { backend });
  assert.match(open.summary, /Open 16:00–01:00/);
});

test('who is working: venue business date, today/tomorrow, unpublished flagged for managers only', async () => {
  const today = await run('bartender', 'shifts.who_is_working', { day: 'today', date: null });
  assert.equal(today.data.date, BUSINESS_DATE);
  assert.deepEqual(today.data.shifts.map((shift) => [shift.name, shift.start, shift.end]), [['Anna', '17:00', '01:00']]);
  const managerTomorrow = await run('manager', 'shifts.who_is_working', { day: 'tomorrow', date: null });
  assert.equal(managerTomorrow.data.date, '2026-09-25');
  assert.deepEqual(managerTomorrow.data.shifts.map((shift) => [shift.name, shift.unpublished_change]), [['Bjarni', true]]);
  const staffTomorrow = await run('bartender', 'shifts.who_is_working', { day: 'tomorrow', date: null });
  assert.equal(staffTomorrow.data.shifts.length, 0, 'staff only see the published rota');
  const schedule = await run('manager', 'shifts.schedule', { week_start: '2026-09-24' });
  assert.equal(schedule.data.week_start, '2026-09-21');
  assert.equal(schedule.data.unpublished_changes, 1);
  assert.equal(schedule.data.days.length, 7);
  assert.deepEqual(schedule.data.gaps, [], 'no opening hours → gaps cannot be judged');
  assert.ok(schedule.evidence.some((entry) => entry.kind === 'missing' && entry.label === 'Staffing gaps'));
  const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_open: weekday !== 1, open_time: '16:00:00', close_time: '23:00:00' }));
  const backend = createBackend({ venueClock: { timezone: 'Atlantic/Reykjavik', hours_configured: true, business_hours: hours, offers: [], venue_date: BUSINESS_DATE, business_date: BUSINESS_DATE } });
  const withHours = await run('manager', 'shifts.schedule', { week_start: null }, { backend });
  assert.deepEqual(withHours.data.gaps.map((gap) => gap.subject_key), ['2026-09-26', '2026-09-27'], 'open days from today on with nobody scheduled');
});

test('shift drafts: resolved person, overnight end, warnings, never published', async () => {
  const backend = createBackend();
  const result = await run('manager', 'shifts.prepare_draft', { person_id: null, person_query: 'bjarni', date: '2026-09-26', start_time: '20:00', end_time: '02:00', role_name: null, break_minutes: 30, note: null }, { backend });
  const { proposal } = result;
  assert.equal(proposal.kind, 'shift.draft');
  assert.deepEqual([proposal.command.starts_local, proposal.command.ends_local], ['2026-09-26T20:00', '2026-09-27T02:00']);
  assert.equal(proposal.command.week_start, '2026-09-21');
  assert.equal(proposal.command.role_name, 'Floor');
  assert.ok(result.data.warnings.some((warning) => /unavailable on Saturdays/.test(warning)));
  assert.ok(result.data.warnings.some((warning) => /already published/.test(warning)));
  assert.ok(proposal.preview.will_not_change.some((line) => /not published/.test(line)));
  assert.deepEqual(backend.writes, []);
  assert.equal((await run('bartender', 'shifts.prepare_draft', { person_id: null, person_query: 'bjarni', date: '2026-09-26', start_time: '20:00', end_time: '02:00', role_name: null, break_minutes: null, note: null })).error.code, 'forbidden');
});

test('team profiles are role-shaped: emergency contacts for managers only', async () => {
  const bartenderSelf = await run('bartender', 'team.get_profile', { profile_id: null, query: null });
  assert.equal(bartenderSelf.data.profile.name, 'Birta');
  assert.equal(bartenderSelf.data.profile.training.percent, 75, 'own training is visible');
  assert.ok(!('emergency_contacts' in bartenderSelf.data.profile), 'even your own emergency contacts are not given to the model');
  const colleague = await run('bartender', 'team.get_profile', { profile_id: null, query: 'anna' });
  assert.ok(!('email' in colleague.data.profile) && !('training' in colleague.data.profile));
  const manager = await run('manager', 'team.get_profile', { profile_id: IDS.anna, query: null });
  assert.deepEqual(manager.data.profile.emergency_contacts, [{ name: 'Pabbi', relationship: 'Father', phone: '+354 555 9999' }]);
});

test('team message drafts: exact text and channel; announcements are manager-only', async () => {
  const result = await run('bartender', 'team.prepare_message', { channel_key: 'shift-handover', body: 'Ice machine is leaking.', link_type: 'inventory_item', link_key: IDS.angelo, link_label: 'Angelo' });
  assert.equal(result.proposal.kind, 'team_message.send');
  assert.deepEqual(result.proposal.required_roles, ['admin', 'manager', 'bartender']);
  assert.equal(result.proposal.command.body, 'Ice machine is leaking.');
  assert.equal(result.proposal.preview.lines[0].detail, 'Ice machine is leaking.');
  const announce = await run('bartender', 'team.prepare_message', { channel_key: 'announcements', body: 'Hi', link_type: null, link_key: null, link_label: null });
  assert.equal(announce.error.code, 'forbidden');
  const managerAnnounce = await run('manager', 'team.prepare_message', { channel_key: 'announcements', body: 'Hi', link_type: null, link_key: null, link_label: null });
  assert.deepEqual(managerAnnounce.proposal.required_roles, ['admin', 'manager']);
  assert.equal((await run('viewer', 'team.prepare_message', { channel_key: 'general', body: 'Hi', link_type: null, link_key: null, link_label: null })).error.code, 'forbidden');
});

test('knowledge: search via atlas_knowledge_search with the verified actor, cited, drafts never published', async () => {
  const backend = createBackend();
  const search = await run('viewer', 'knowledge.search', { query: 'closing', limit: 3 }, { backend });
  const call = backend.calls.find((entry) => entry.name === 'atlas_knowledge_search');
  assert.deepEqual(call.args, { p_query: 'closing', p_actor_id: IDS.viewer, p_actor_role: 'viewer', p_limit: 3 });
  assert.equal(search.data.results[0].version_id, IDS.articleVersion);
  assert.equal(search.records[0].route, `#knowledge?article=${IDS.article}`);
  const get = await run('viewer', 'knowledge.get', { article_id: IDS.article }, { backend });
  assert.equal(get.data.version.number, 2);
  assert.equal(backend.calls.find((entry) => entry.name === 'atlas_knowledge_article_detail').args.p_prefer_draft, false);
  const draft = await run('manager', 'knowledge.prepare_draft', { article_id: null, title: 'Glass washer', summary: null, content: 'Empty the filter.', category_id: null, category_query: 'bar', article_type: 'sop', target_roles: null, required: null, change_note: null }, { backend });
  assert.equal(draft.proposal.command.category_id, IDS.categoryBar);
  assert.deepEqual(draft.proposal.command.target_roles, ['all']);
  assert.ok(draft.proposal.preview.will_not_change.some((line) => /not published/.test(line)));
  assert.deepEqual(backend.writes, []);
});

test('settings are read only and hours are reported as not set', async () => {
  const read = await run('viewer', 'settings.read', { section: null });
  assert.equal(read.data.hours_configured, false);
  assert.deepEqual(read.data.business_hours, []);
  assert.equal(read.unknown.reason, 'Opening hours are not set');
  assert.equal((await run('viewer', 'settings.read', { section: 'all' })).error.code, 'forbidden');
  const all = await run('manager', 'settings.read', { section: 'all' });
  assert.equal(all.data.sections[0].key, 'venue');
  const suggestion = await run('manager', 'settings.suggest_change', { section: 'hours', change: 'Set Friday 16:00–01:00', reason: null });
  assert.equal(suggestion.proposal.kind, 'settings.suggestion');
  assert.equal(suggestion.proposal.executable, false);
  assert.equal(suggestion.proposal.route, '#settings?tab=hours');
});

test('decision memory, data quality and par suggestions are manager-only', async () => {
  const memory = await run('manager', 'decisions.history', { query: 'Angelo', subject_type: null, subject_key: null, limit: null });
  assert.equal(memory.data.decisions[0].action, 'defer');
  assert.equal(memory.data.decisions[0].reason, 'delivery_expected');
  assert.equal((await run('manager', 'decisions.history', { query: null, subject_type: null, subject_key: null, limit: null })).error.code, 'invalid_arguments');
  const review = await run('manager', 'data_quality.review_list', { issue: null, limit: null, offset: null });
  assert.equal(review.data.issues[0].count, 234);
  const rows = await run('manager', 'data_quality.review_list', { issue: 'recipe.ingredient_unlinked', limit: null, offset: null });
  assert.equal(rows.records[0].route, `#recipes?recipe=${IDS.margarita}`);
  const par = await run('manager', 'data_quality.par_suggestions', { item_ids: null, cover_days: 7, limit: null });
  assert.equal(par.proposal.kind, 'par_level.suggestion');
  assert.equal(par.proposal.executable, false);
  assert.deepEqual(par.proposal.command.items.map((item) => [item.item_name, item.suggested_par]), [['Tanqueray Gin', 4]]);
  assert.equal(par.unknown.count, 1);
  const noCover = await run('manager', 'data_quality.par_suggestions', { item_ids: null, cover_days: null, limit: null });
  assert.equal(noCover.proposal, null);
  for (const role of ['bartender', 'viewer']) {
    for (const name of ['decisions.history', 'data_quality.review_list', 'data_quality.par_suggestions', 'integrations.status']) {
      const args = { 'decisions.history': { query: 'x', subject_type: null, subject_key: null, limit: null }, 'data_quality.review_list': { issue: null, limit: null, offset: null }, 'data_quality.par_suggestions': { item_ids: null, cover_days: null, limit: null }, 'integrations.status': {} }[name];
      assert.equal((await run(role, name, args)).error.code, 'forbidden', `${role} ${name}`);
    }
  }
});

test('marketing ideas are labelled as seeded; integrations report true states and POS not connected', async () => {
  const marketing = await run('bartender', 'marketing.suggestions', { date: null });
  assert.equal(marketing.data.basis, 'Seeded recurring templates');
  assert.match(marketing.summary, /seeded templates/);
  const integrations = await run('manager', 'integrations.status', {});
  assert.deepEqual(integrations.data.providers.map((provider) => [provider.key, provider.state]), [['google_business_profile', 'connected'], ['tripadvisor', 'not_configured']]);
  assert.equal(integrations.data.pos.state, 'not_connected');
  assert.ok(integrations.evidence.some((entry) => entry.kind === 'missing' && /Point of sale/.test(entry.label)));
});

test('app.open returns a route and reads no data', async () => {
  const backend = createBackend();
  const result = await run('viewer', 'app.open', { target: 'recipes', record_type: 'recipe', record_id: IDS.margarita, label: 'Margarita' }, { backend });
  assert.equal(result.data.route, `#recipes?recipe=${IDS.margarita}`);
  assert.equal(backend.calls.length, 0);
  assert.equal((await run('viewer', 'app.open', { target: 'purchase_orders', record_type: null, record_id: null, label: null })).error.code, 'forbidden');
  assert.equal((await run('viewer', 'app.open', { target: 'home', record_type: 'purchase_order', record_id: IDS.po1, label: null })).error.code, 'forbidden');
  assert.equal((await run('viewer', 'app.open', { target: 'home', record_type: null, record_id: 'x/../y', label: null })).error.code, 'invalid_arguments');
});
