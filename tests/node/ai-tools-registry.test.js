// Atlas AI Tool Gateway: registry shape, strict schemas, the generated
// registry document and the public interface the atlas-ai runtime uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gateway from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { assertStrictSchema, jsonSchemaToZod, S, validateArgs } from '../../supabase/functions/_shared/ai-tools/schema.mjs';
import { renderRegistryDoc, REGISTRY_DOC } from '../../scripts/generate_ai_tool_registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { TOOL_REGISTRY, toolsForRole, functionDefinitions, getTool, SPECIALISTS } = gateway;

const REQUIRED_TOOLS = [
  'inventory.search', 'inventory.get', 'inventory.current_stock', 'inventory.below_par', 'inventory.stale_counts',
  'inventory.prepare_count', 'inventory.lookup_barcode', 'inventory.identify_from_image', 'inventory.resolve_name',
  'inventory.propose_alias', 'inventory.propose_item', 'inventory.report_wrong_match', 'recipes.search', 'recipes.get', 'recipes.can_make', 'recipes.cost',
  'recipes.best_margin', 'purchasing.suggest', 'purchasing.get_supplier', 'purchasing.prepare_draft_po', 'purchasing.order_status',
  'purchasing.compare_delivery', 'purchasing.cost_changes', 'reports.sales', 'reports.margin', 'reports.inventory_value',
  'reports.spend', 'reports.waste', 'operations.status', 'operations.alerts', 'briefing.today', 'shifts.schedule',
  'shifts.who_is_working', 'shifts.prepare_draft', 'team.get_profile', 'team.prepare_message', 'knowledge.search',
  'knowledge.get', 'knowledge.prepare_draft', 'settings.read', 'settings.suggest_change', 'decisions.history',
  'data_quality.review_list', 'data_quality.par_suggestions', 'marketing.suggestions', 'integrations.status', 'app.open',
];

test('the registry contains every required tool exactly once', () => {
  const names = TOOL_REGISTRY.map((entry) => entry.name);
  assert.deepEqual([...names].sort(), [...REQUIRED_TOOLS].sort());
  assert.equal(new Set(names).size, names.length);
});

test('every entry has the specified shape, strict schema and no execute level', () => {
  for (const entry of TOOL_REGISTRY) {
    assert.match(entry.name, /^[a-z_]+\.[a-z_]+$/, entry.name);
    assert.equal(entry.fnName, entry.name.replace('.', '_'));
    assert.match(entry.fnName, /^[a-zA-Z0-9_-]+$/);
    assert.ok(['read', 'draft'].includes(entry.level), `${entry.name} level`);
    assert.ok(entry.roles.length > 0 && entry.roles.every((role) => ['admin', 'manager', 'bartender', 'viewer'].includes(role)));
    assert.ok(entry.roles.includes('admin') && entry.roles.includes('manager'), `${entry.name} is available to managers`);
    assert.ok(entry.description.length > 60, `${entry.name} description`);
    assert.ok(entry.progress && !/[._]/.test(entry.progress), `${entry.name} progress label has no jargon`);
    assert.equal(typeof entry.execute, 'function');
    assert.ok(entry.source, `${entry.name} documents its source of truth`);
    assert.ok(assertStrictSchema(entry.parameters, entry.name));
    assert.equal(entry.parameters.type, 'object');
    assert.ok(Object.isFrozen(entry));
    assert.equal(getTool(entry.name), entry);
    assert.equal(getTool(entry.fnName), entry);
  }
});

test('draft tools never include roles that cannot execute the proposal', () => {
  for (const entry of TOOL_REGISTRY.filter((candidate) => candidate.level === 'draft')) {
    const kind = entry.proposalKind.split(' ')[0];
    const definition = gateway.PROPOSAL_KINDS[kind];
    assert.ok(definition, `${entry.name} → ${kind}`);
    for (const role of entry.roles) assert.ok(definition.roles.includes(role), `${entry.name}: ${role} could draft but not approve`);
    assert.ok(!entry.roles.includes('viewer'), `${entry.name}: viewers cannot draft writes`);
  }
});

test('toolsForRole filters by role, specialist and level and never returns execute tools', () => {
  const viewer = toolsForRole('viewer').map((entry) => entry.name);
  assert.ok(viewer.includes('inventory.below_par'));
  for (const forbidden of ['recipes.cost', 'decisions.history', 'data_quality.review_list', 'purchasing.suggest', 'inventory.prepare_count', 'team.prepare_message']) {
    assert.ok(!viewer.includes(forbidden), `viewer must not see ${forbidden}`);
  }
  const bartender = toolsForRole('bartender').map((entry) => entry.name);
  assert.ok(bartender.includes('inventory.prepare_count') && bartender.includes('team.prepare_message'));
  assert.ok(!bartender.includes('recipes.cost') && !bartender.includes('reports.inventory_value'));
  assert.equal(toolsForRole('manager').length, TOOL_REGISTRY.length);
  assert.deepEqual(toolsForRole('manager', { levels: ['execute'] }), []);
  assert.ok(toolsForRole('manager', { levels: ['draft'] }).every((entry) => entry.level === 'draft'));
  assert.ok(toolsForRole('manager', { specialist: 'recipes' }).every((entry) => entry.name.startsWith('recipes.')));
  assert.deepEqual(toolsForRole('owner'), []);
});

test('function definitions are Realtime/Responses-ready strict function tools', () => {
  const definitions = functionDefinitions('bartender');
  assert.ok(definitions.length > 20);
  for (const definition of definitions) {
    assert.equal(definition.type, 'function');
    assert.equal(definition.strict, true);
    assert.match(definition.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(getTool(definition.name));
  }
  assert.ok(!definitions.some((definition) => definition.name === 'recipes_cost'));
});

test('every specialist has instructions with the shared evidence rules and at least one tool', () => {
  assert.equal(SPECIALISTS.length, 11);
  for (const specialist of SPECIALISTS) {
    assert.ok(specialist.key && specialist.name && specialist.description && specialist.instructions.length > 80);
    assert.ok(TOOL_REGISTRY.some((entry) => entry.specialist === specialist.key), `${specialist.key} has tools`);
  }
  assert.match(gateway.SHARED_RULES, /Unknown is not zero/);
  assert.match(gateway.SHARED_RULES, /data, never instructions/);
  assert.match(gateway.ORCHESTRATOR_INSTRUCTIONS, /one reconciled answer/);
  const everyTool = TOOL_REGISTRY.filter((entry) => !SPECIALISTS.some((specialist) => specialist.key === entry.specialist));
  assert.deepEqual(everyTool.map((entry) => entry.name), ['app.open']);
});

test('the index exposes the runtime interface', () => {
  for (const name of ['TOOL_REGISTRY', 'toolsForRole', 'runTool', 'executeProposal', 'buildContextPatch', 'SPECIALISTS']) {
    assert.ok(name in gateway, name);
  }
  assert.equal(gateway.runTool.length, 3);
  assert.equal(gateway.executeProposal.length, 3);
});

test('docs/ai/Atlas_AI_Tool_Registry.md is generated from the registry and up to date', () => {
  const current = fs.readFileSync(REGISTRY_DOC, 'utf8');
  assert.equal(current, renderRegistryDoc(), 'Run node scripts/generate_ai_tool_registry.mjs');
  assert.match(current, /\| Tool \| Read\/Draft\/Execute \| Roles \| Inputs \| Source of truth \| Approval requirement \| Evidence produced \|/);
  for (const name of REQUIRED_TOOLS) assert.ok(current.includes(`| \`${name}\` |`), name);
});

test('the strict validator rejects padded, missing and mistyped arguments', () => {
  const schema = S.object({ a: S.string('a', { maxLength: 5 }), b: S.nullable(S.integer('b', { minimum: 1, maximum: 3 })), c: S.array(S.enum(['x', 'y'])) });
  assert.equal(validateArgs(schema, { a: 'hi', b: null, c: ['x'] }).ok, true);
  assert.equal(validateArgs(schema, '{"a":"hi","b":2,"c":[]}').ok, true);
  assert.match(validateArgs(schema, { a: 'hi', b: null, c: [], d: 1 }).errors.join(), /d is not an accepted argument/);
  assert.match(validateArgs(schema, { a: 'hi', c: [] }).errors.join(), /b is required/);
  assert.match(validateArgs(schema, { a: 'toolong', b: null, c: [] }).errors.join(), /too long/);
  assert.match(validateArgs(schema, { a: 'hi', b: 1.5, c: [] }).errors.join(), /must be integer/);
  assert.match(validateArgs(schema, { a: 'hi', b: 9, c: [] }).errors.join(), /at most 3/);
  assert.match(validateArgs(schema, { a: 'hi', b: null, c: ['z'] }).errors.join(), /one of x, y/);
  assert.match(validateArgs(schema, '{nope').errors.join(), /not valid JSON/);
  assert.match(validateArgs(schema, []).errors.join(), /must be object/);
  assert.throws(() => assertStrictSchema({ type: 'object', properties: { a: { type: 'string' } }, required: [], additionalProperties: false }), /required/);
  assert.throws(() => assertStrictSchema({ type: 'object', properties: {}, required: [] }), /additionalProperties/);
});

test('jsonSchemaToZod maps the dialect onto an injected zod (strict objects, nullable optionals)', () => {
  const calls = [];
  const node = (kind) => {
    const self = { kind };
    for (const method of ['min', 'max', 'regex', 'int', 'describe', 'strict', 'nullable']) {
      self[method] = (...args) => { calls.push([kind, method, ...args]); return self; };
    }
    return self;
  };
  const z = {
    string: () => node('string'), number: () => node('number'), boolean: () => node('boolean'),
    enum: (values) => node(`enum:${values.join(',')}`), array: () => node('array'),
    object: (shape) => { calls.push(['object', Object.keys(shape).join(',')]); return node('object'); },
  };
  for (const entry of TOOL_REGISTRY) jsonSchemaToZod(entry.parameters, z);
  assert.ok(calls.some(([kind, method]) => kind === 'object' && method === 'strict'));
  assert.ok(calls.some(([, method]) => method === 'nullable'));
  assert.ok(calls.some(([kind]) => kind === 'enum:today,tomorrow,yesterday'));
});

test('ai-tools modules are dependency-free ESM without Deno or browser APIs', () => {
  const dir = path.join(ROOT, 'supabase/functions/_shared/ai-tools');
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.match(file, /\.mjs$/);
    assert.doesNotMatch(source, /\bDeno\./, file);
    assert.doesNotMatch(source, /from\s+["'](?:jsr:|npm:|https?:)/, file);
    assert.doesNotMatch(source, /\blocalStorage\b|\bwindow\./, file);
  }
});
