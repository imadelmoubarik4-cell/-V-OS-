// Shared case handling for the Atlas AI evaluation suites
// (docs/ai/Atlas_AI_Evaluation_Plan.md): loading and validating the case
// files, resolving "@group.key" id aliases against the VÁ world, dotted path
// lookup, matchers, and the Layer 1 (gateway) expectation checks.
//
// Plain ESM; the only Node API used is node:fs / node:path for loading.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDS, ACTORS } from '../fixtures/world.mjs';

export const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const GATEWAY_CATEGORIES = Object.freeze([
  'inventory', 'recipes', 'purchasing', 'reports', 'operations', 'shifts', 'knowledge', 'team', 'settings',
  'ambiguous', 'missing_evidence', 'role_restriction', 'multimodal', 'voice_transcript', 'approval_boundary', 'prompt_injection',
]);
export const EVIDENCE_KINDS = Object.freeze(['fact', 'calculation', 'interpretation', 'estimate', 'missing']);
export const ERROR_CODES = Object.freeze(['forbidden', 'not_found', 'invalid_arguments', 'not_connected', 'unavailable', 'limit_exceeded', 'not_executable', 'conflict']);
export const ACTOR_KEYS = Object.freeze(Object.keys(ACTORS));

// Fields that must never reach bartender/viewer (gateway COMMERCIAL_KEYS plus
// the supplier contact fields of purchasing results).
export const STAFF_FORBIDDEN_KEYS = Object.freeze([
  'cost_price', 'case_cost', 'unit_cost', 'total_cost', 'ordered_unit_cost', 'observed_unit_cost', 'estimated_cost', 'estimated_value',
  'estimated_total', 'known_value', 'inventory_value', 'cost', 'cost_total', 'cost_per_serving', 'cost_percent', 'margin_percent',
  'gross_profit_per_serving', 'financials', 'supplier', 'supplier_id', 'supplier_name', 'suppliers', 'emergency_contacts', 'manager_notes',
]);

export function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort().flatMap((file) => {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const cases = Array.isArray(parsed) ? parsed : parsed.cases;
    if (!Array.isArray(cases)) throw new Error(`${file}: expected an array or {cases: []}`);
    return cases.map((entry) => ({ ...entry, __file: file }));
  });
}

export function loadGatewayCases() {
  return readJsonDir(path.join(EVALS_DIR, 'cases'));
}

export function loadLiveCases() {
  return readJsonDir(path.join(EVALS_DIR, 'live'));
}

// "@item.angelo" → the fixture id; works inside strings ("inventory_item:@item.angelo").
export function resolveAliases(value) {
  if (typeof value === 'string') {
    return value.replace(/@([a-zA-Z]+)\.([A-Za-z0-9@]+)/g, (match, group, key) => {
      const id = IDS[group]?.[key];
      if (!id) throw new Error(`Unknown fixture alias ${match}`);
      return id;
    });
  }
  if (Array.isArray(value)) return value.map(resolveAliases);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveAliases(entry)]));
  return value;
}

// All aliases used by a value (for dry-run validation).
export function aliasesIn(value, found = new Set()) {
  if (typeof value === 'string') for (const match of value.matchAll(/@([a-zA-Z]+)\.([A-Za-z0-9@]+)/g)) found.add(match[0]);
  else if (Array.isArray(value)) value.forEach((entry) => aliasesIn(entry, found));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => aliasesIn(entry, found));
  return found;
}

export function aliasExists(alias) {
  const match = alias.match(/^@([a-zA-Z]+)\.([A-Za-z0-9@]+)$/);
  return Boolean(match && IDS[match[1]]?.[match[2]]);
}

// "data.items[0].quantity" / "data.groups.length"
export function getPath(object, dotted) {
  const parts = String(dotted).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = object;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (part === 'length' && (Array.isArray(current) || typeof current === 'string')) return current.length;
    current = current[part];
  }
  return current;
}

// Matchers: literal (deep equality), {$approx, $tol}, {$len}, {$gte}, {$lte},
// {$includes} (substring or array element), {$excludes}, {$match} (regex),
// {$absent: true}, {$present: true}, {$some: {field: matcher}} (array of objects),
// {$none: {field: matcher}}, {$every: {field: matcher}}.
export function matches(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const keys = Object.keys(expected);
    if (keys.length && keys.every((key) => key.startsWith('$'))) {
      return keys.every((key) => matchOperator(actual, key, expected[key], expected));
    }
    if (!actual || typeof actual !== 'object') return false;
    return keys.every((key) => matches(getPath(actual, key), expected[key]));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function matchOperator(actual, operator, operand, all) {
  switch (operator) {
    case '$approx': return typeof actual === 'number' && Math.abs(actual - operand) <= (all.$tol ?? 0.05);
    case '$tol': return true;
    case '$len': return (Array.isArray(actual) || typeof actual === 'string') && actual.length === operand;
    case '$gte': return typeof actual === 'number' && actual >= operand;
    case '$lte': return typeof actual === 'number' && actual <= operand;
    case '$includes':
      if (typeof actual === 'string') return actual.toLowerCase().includes(String(operand).toLowerCase());
      if (Array.isArray(actual)) return actual.some((entry) => matches(entry, operand));
      return false;
    case '$excludes':
      if (typeof actual === 'string') return !actual.toLowerCase().includes(String(operand).toLowerCase());
      if (Array.isArray(actual)) return !actual.some((entry) => matches(entry, operand));
      return true;
    case '$match': return typeof actual === 'string' && new RegExp(operand, 'i').test(actual);
    case '$absent': return operand ? actual === undefined || actual === null : actual !== undefined && actual !== null;
    case '$present': return operand ? actual !== undefined && actual !== null : actual === undefined || actual === null;
    case '$some': return Array.isArray(actual) && actual.some((entry) => matches(entry, operand));
    case '$none': return Array.isArray(actual) && !actual.some((entry) => matches(entry, operand));
    case '$every': return Array.isArray(actual) && actual.every((entry) => matches(entry, operand));
    default: throw new Error(`Unknown matcher ${operator}`);
  }
}

export function allKeys(value, keys = new Set()) {
  if (Array.isArray(value)) value.forEach((entry) => allKeys(entry, keys));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      allKeys(entry, keys);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Layer 1 case validation (used by the gateway test and by --dry-run)
// ---------------------------------------------------------------------------

export function validateGatewayCase(entry, toolNames) {
  const errors = [];
  const where = entry?.id ?? '(no id)';
  if (!entry || typeof entry !== 'object') return ['case is not an object'];
  if (!/^[a-z0-9-]+$/.test(String(entry.id ?? ''))) errors.push(`${where}: id must be lower-case letters, digits and dashes`);
  if (!GATEWAY_CATEGORIES.includes(entry.category)) errors.push(`${where}: unknown category ${entry.category}`);
  if (typeof entry.question !== 'string' || entry.question.length < 5) errors.push(`${where}: question is required`);
  if (!ACTOR_KEYS.includes(entry.actor)) errors.push(`${where}: unknown actor ${entry.actor}`);
  if (entry.world && !['default', 'hours', 'catalog'].includes(entry.world)) errors.push(`${where}: world must be default, hours or catalog`);
  if (!toolNames.includes(entry.tool)) errors.push(`${where}: unknown tool ${entry.tool}`);
  if (!entry.args || typeof entry.args !== 'object') errors.push(`${where}: args must be an object`);
  if (typeof entry.blocking !== 'boolean') errors.push(`${where}: blocking must be true or false`);
  const expected = entry.expected;
  if (!expected || typeof expected !== 'object') errors.push(`${where}: expected is required`);
  else {
    if (typeof expected.ok !== 'boolean') errors.push(`${where}: expected.ok must be a boolean`);
    if (expected.ok === false && !ERROR_CODES.includes(expected.error)) errors.push(`${where}: expected.error must be an error code`);
    for (const kind of expected.evidence_kinds ?? []) if (!EVIDENCE_KINDS.includes(kind)) errors.push(`${where}: unknown evidence kind ${kind}`);
    if (expected.proposal && typeof expected.proposal.kind !== 'string') errors.push(`${where}: expected.proposal.kind is required`);
  }
  if (entry.execute) {
    if (!ACTOR_KEYS.includes(entry.execute.as)) errors.push(`${where}: execute.as must be an actor`);
    if (typeof entry.execute.expected?.ok !== 'boolean') errors.push(`${where}: execute.expected.ok must be a boolean`);
    if (!expected?.proposal) errors.push(`${where}: execute needs a proposal to execute`);
  }
  for (const alias of aliasesIn(entry)) if (!aliasExists(alias)) errors.push(`${where}: unknown alias ${alias}`);
  return errors;
}

// ---------------------------------------------------------------------------
// Layer 1 checks: one tool result against the case expectations. Returns a
// list of failure strings (empty = pass).
// ---------------------------------------------------------------------------

export function checkGatewayResult(entry, result, { isStaff }) {
  const failures = [];
  const expected = resolveAliases(entry.expected);
  const fail = (message) => failures.push(message);
  if (result.ok !== expected.ok) {
    fail(`ok: expected ${expected.ok}, got ${result.ok}${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}`);
    return failures;
  }
  if (!result.ok) {
    if (result.error?.code !== expected.error) fail(`error: expected ${expected.error}, got ${result.error?.code}`);
    for (const text of expected.message ?? []) if (!String(result.error?.message ?? '').toLowerCase().includes(text.toLowerCase())) fail(`error message lacks "${text}"`);
    return failures;
  }
  for (const text of expected.summary ?? []) if (!result.summary.toLowerCase().includes(String(text).toLowerCase())) fail(`summary lacks "${text}": ${result.summary}`);
  for (const text of expected.summary_excludes ?? []) if (result.summary.toLowerCase().includes(String(text).toLowerCase())) fail(`summary must not contain "${text}": ${result.summary}`);
  for (const [dotted, matcher] of Object.entries(expected.data ?? {})) {
    const actual = getPath(result, dotted);
    if (!matches(actual, matcher)) fail(`${dotted}: expected ${JSON.stringify(matcher)}, got ${JSON.stringify(actual)?.slice(0, 300)}`);
  }
  const kinds = new Set(result.evidence.map((item) => item.kind));
  for (const kind of expected.evidence_kinds ?? []) if (!kinds.has(kind)) fail(`evidence kind ${kind} missing (have ${[...kinds].join(', ')})`);
  for (const kind of expected.evidence_kinds_absent ?? []) if (kinds.has(kind)) fail(`evidence kind ${kind} must be absent`);
  for (const wanted of expected.evidence ?? []) {
    const found = result.evidence.some((item) => (!wanted.kind || item.kind === wanted.kind)
      && (!wanted.label || String(item.label).toLowerCase().includes(wanted.label.toLowerCase()))
      && (!wanted.value || String(item.value ?? '').toLowerCase().includes(wanted.value.toLowerCase()))
      && (!wanted.source || `${item.source?.type}:${item.source?.id}` === wanted.source));
    if (!found) fail(`evidence ${JSON.stringify(wanted)} not found`);
  }
  const records = new Set(result.records.map((item) => `${item.type}:${item.id}`));
  for (const wanted of expected.records ?? []) if (!records.has(wanted)) fail(`record ${wanted} missing`);
  for (const unwanted of expected.records_exclude ?? []) if (records.has(unwanted)) fail(`record ${unwanted} must not be returned`);
  if (Object.hasOwn(expected, 'unknown')) {
    if (expected.unknown === null && result.unknown !== null) fail(`unknown: expected none, got ${JSON.stringify(result.unknown)}`);
    else if (expected.unknown && !matches(result.unknown, expected.unknown)) fail(`unknown: expected ${JSON.stringify(expected.unknown)}, got ${JSON.stringify(result.unknown)}`);
  }
  if (Object.hasOwn(expected, 'proposal')) {
    if (expected.proposal === null && result.proposal !== null) fail(`proposal: expected none, got ${result.proposal?.kind}`);
    if (expected.proposal) {
      if (!result.proposal) fail(`proposal ${expected.proposal.kind} expected, none returned`);
      else {
        if (result.proposal.kind !== expected.proposal.kind) fail(`proposal kind: expected ${expected.proposal.kind}, got ${result.proposal.kind}`);
        if (expected.proposal.required_roles && JSON.stringify(result.proposal.required_roles) !== JSON.stringify(expected.proposal.required_roles)) {
          fail(`required_roles: expected ${expected.proposal.required_roles}, got ${result.proposal.required_roles}`);
        }
        if (Object.hasOwn(expected.proposal, 'executable') && result.proposal.executable !== expected.proposal.executable) fail('proposal executable flag differs');
        for (const [dotted, matcher] of Object.entries(expected.proposal.command ?? {})) {
          const actual = getPath(result.proposal.command, dotted);
          if (!matches(actual, matcher)) fail(`proposal.command.${dotted}: expected ${JSON.stringify(matcher)}, got ${JSON.stringify(actual)}`);
        }
        for (const [dotted, matcher] of Object.entries(expected.proposal.preview ?? {})) {
          const actual = getPath(result.proposal.preview, dotted);
          if (!matches(actual, matcher)) fail(`proposal.preview.${dotted}: expected ${JSON.stringify(matcher)}, got ${JSON.stringify(actual)}`);
        }
      }
    }
  }
  if (isStaff || expected.redacted) {
    const keys = allKeys({ data: result.data, evidence: result.evidence, proposal: result.proposal });
    const leaked = STAFF_FORBIDDEN_KEYS.filter((key) => keys.has(key));
    if (leaked.length) fail(`commercial fields leaked to staff: ${leaked.join(', ')}`);
    const text = JSON.stringify(result.evidence);
    if (/\bISK\b/.test(text)) fail('an ISK amount leaked to staff in evidence');
    if (result.records.some((record) => ['supplier', 'purchase_order', 'movement'].includes(record.type))) fail('a commercial record leaked to staff');
  }
  return failures;
}
