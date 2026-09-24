// Minimal local stand-in for supabase/functions/_shared/ai-tools/index.mjs
// (the Tool Gateway), with the same interface, for the atlas-ai runtime
// tests only. Every call is recorded so tests can assert that the actor came
// from the server context and never from tool arguments.

const ALL = ['admin', 'manager', 'bartender', 'viewer'];
const MANAGERS = ['admin', 'manager'];

export const TOOL_REGISTRY = [
  {
    name: 'inventory.current_stock', fnName: 'inventory_current_stock', level: 'read', roles: ALL,
    specialist: 'inventory', description: 'Current reconciled stock for an item.', progress: 'Checking stock',
    parameters: {
      type: 'object',
      properties: { query: { type: ['string', 'null'], description: 'Item name' } },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    name: 'purchasing.draft_po', fnName: 'purchasing_draft_po', level: 'draft', roles: ['admin', 'manager', 'bartender'],
    specialist: 'purchasing', description: 'Prepare a draft purchase order for approval.', progress: 'Preparing an order',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', minLength: 1, maxLength: 120 },
        cases: { type: 'integer', minimum: 1, maximum: 50 },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['item', 'cases', 'note'], additionalProperties: false,
    },
  },
  {
    name: 'operations.alerts', fnName: 'operations_alerts', level: 'read', roles: ALL,
    specialist: 'operations', description: 'Operational alerts for today.', progress: "Checking today's operations",
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'shifts.schedule', fnName: 'shifts_schedule', level: 'read', roles: ALL,
    specialist: 'shifts', description: 'Rota for the next days.', progress: 'Looking at the rota',
    parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 31 } }, required: ['days'], additionalProperties: false },
  },
  {
    name: 'data_quality.missing_par', fnName: 'data_quality_missing_par', level: 'read', roles: MANAGERS,
    specialist: 'data_quality', description: 'Items without par levels.', progress: 'Checking data quality',
    parameters: { type: 'object', properties: { limit: { type: ['integer', 'null'] } }, required: ['limit'], additionalProperties: false },
  },
  {
    name: 'reports.margin', fnName: 'reports_margin', level: 'read', roles: MANAGERS,
    specialist: 'reports', description: 'Recipe margin report.', progress: 'Looking at the numbers',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'purchasing.submit_po', fnName: 'purchasing_submit_po', level: 'execute', roles: MANAGERS,
    specialist: 'purchasing', description: 'Submit a purchase order.', progress: 'Submitting',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
];

export const SPECIALISTS = [
  { key: 'inventory', name: 'Inventory', description: 'Stock levels, counts and par.', instructions: 'Answer stock questions from tools.' },
  { key: 'purchasing', name: 'Purchasing', description: 'Suppliers, order suggestions and draft purchase orders.', instructions: 'Prepare drafts only.' },
  { key: 'operations', name: 'Operations', description: 'Alerts and routines.', instructions: 'Summarise alerts.' },
  { key: 'reports', name: 'Reports & Finance', description: 'Margins and values.', instructions: 'Report numbers exactly.' },
];

export const calls = [];
export const executions = [];
export const options = { stockBottles: 10, auditFromGateway: true };

export function reset() {
  calls.length = 0;
  executions.length = 0;
  options.stockBottles = 10;
  options.auditFromGateway = true;
}

function find(nameOrFnName) {
  return TOOL_REGISTRY.find((entry) => entry.name === nameOrFnName || entry.fnName === nameOrFnName);
}

export function toolsForRole(role, { specialist = null, levels = ['read', 'draft'] } = {}) {
  return TOOL_REGISTRY.filter((entry) => entry.roles.includes(role)
    && levels.includes(entry.level) && entry.level !== 'execute'
    && (!specialist || entry.specialist === specialist));
}

export async function runTool(nameOrFnName, rawArgs, ctx) {
  const entry = find(nameOrFnName);
  calls.push({ name: entry?.name ?? nameOrFnName, args: rawArgs, actor: ctx?.actor, conversationId: ctx?.conversationId, runId: ctx?.runId });
  if (!entry || entry.level === 'execute') return { ok: false, error: { code: 'not_found', message: 'Unknown tool' } };
  if (!ctx?.actor?.active || !entry.roles.includes(ctx.actor.role)) {
    return { ok: false, error: { code: 'forbidden', message: 'Not available for your role' } };
  }
  let result;
  switch (entry.name) {
    case 'inventory.current_stock':
      result = {
        ok: true,
        summary: `Angelo Pinot Grigio: ${options.stockBottles} bottles in stock.`,
        data: { item: 'Angelo Pinot Grigio', bottles: options.stockBottles, secret_probe: 'sk-test-abcdefghijklmnopqrstuvwx' },
        evidence: [{ kind: 'fact', label: 'Current reconciled stock', value: `${options.stockBottles} bottles`, source: { type: 'inventory_item', id: 'item-1', label: 'Angelo Pinot Grigio', route: '#inventory?item=item-1' } }],
        records: [{ type: 'inventory_item', id: 'item-1', label: 'Angelo Pinot Grigio', route: '#inventory?item=item-1' }],
        proposal: null,
        unknown: null,
      };
      break;
    case 'purchasing.draft_po': {
      const cases = rawArgs?.cases;
      if (!Number.isInteger(cases) || cases < 1) return { ok: false, error: { code: 'invalid_arguments', message: 'cases must be a whole number' } };
      result = {
        ok: true,
        summary: `Prepared a draft order for ${cases} cases of ${rawArgs.item}.`,
        data: { item: rawArgs.item, cases },
        evidence: [{ kind: 'calculation', label: 'Suggested order', value: `${cases} cases`, source: { type: 'inventory_item', id: 'item-1', label: rawArgs.item } }],
        records: [],
        proposal: {
          kind: 'purchasing.draft_po',
          title: `Draft order: ${cases} cases of ${rawArgs.item}`,
          preview: { summary: `${cases} cases of ${rawArgs.item}`, lines: [{ item: rawArgs.item, cases }] },
          command: { item: rawArgs.item, cases },
          required_roles: ['admin', 'manager'],
          subject_type: 'inventory_item',
          subject_key: 'item-1',
          evidence: [],
        },
        unknown: null,
      };
      break;
    }
    case 'operations.alerts':
      result = { ok: true, summary: '1 alert', data: { alerts: [{ key: 'below_par', title: 'Tanqueray below par', severity: 'high', subject_key: 'item-2', summary: '2 bottles, par 6' }] }, evidence: [], records: [], proposal: null, unknown: null };
      break;
    case 'shifts.schedule':
      result = { ok: true, summary: 'Rota loaded', data: { gaps: [{ key: 'gap', title: 'No bartender on Friday close', severity: 'medium', subject_key: 'friday-close' }] }, evidence: [], records: [], proposal: null, unknown: null };
      break;
    case 'data_quality.missing_par':
      result = { ok: true, summary: '234 items have no par level', data: {}, evidence: [{ kind: 'missing', label: 'Items without a par level', value: '234 items' }], records: [], proposal: null, unknown: { count: 234, reason: 'No par level set' } };
      break;
    default:
      result = { ok: true, summary: 'ok', data: {}, evidence: [], records: [], proposal: null, unknown: null };
  }
  if (options.auditFromGateway && entry.name === 'inventory.current_stock') {
    await ctx.audit({ tool_name: entry.name, level: entry.level, decision: 'allowed', arguments: rawArgs, result_summary: result.summary, evidence_count: result.evidence.length, latency_ms: 1, status: 'ok' });
  }
  return result;
}

export async function executeProposal(kind, storedCommand, ctx) {
  executions.push({ kind, command: storedCommand, actor: ctx?.actor });
  if (!['admin', 'manager'].includes(ctx?.actor?.role)) return { ok: false, error: { code: 'forbidden', message: 'Managers only' } };
  if (kind !== 'purchasing.draft_po') return { ok: false, error: { code: 'not_found', message: 'Unknown proposal' } };
  return { ok: true, result: { summary: `Draft purchase order saved for ${storedCommand.cases} cases.`, purchase_order_id: 'po-1' } };
}

export function buildContextPatch(toolName, toolResult, prevContext) {
  return { last_tool_area: toolName.split('.')[0], last_records: toolResult.records ?? [], turns: (prevContext?.turns ?? 0) + 1 };
}
