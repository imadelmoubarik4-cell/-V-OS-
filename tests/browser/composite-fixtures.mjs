// One venue that feeds every module (S90): the Team A, Inventory, Team C,
// people and Atlas AI fixtures composed into a single world, so a test can
// load a page family with realistic, empty, failing or long Icelandic data.
//
// compositeWorld(user, { group, empty, fail, long })
//   group  'A' (Home, Operations, Settings) · 'INV' (Inventory, Purchasing)
//          · 'C' (Recipes, Reports, Marketing, Data) · 'P' (Messages, Shifts,
//          Team, Knowledge) · 'AI'
//   empty  every table, RPC and snapshot empty
//   fail   every table, RPC and function (except atlas-settings) answers 503
//          with server text the page must never show
//   long   long Icelandic names, categories and supplier names
import { USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';
import { teamAFixtures, VIEWER } from './team-a-fixtures.mjs';
import { inventoryWorld, itemMasterBackend, IDS as INV } from './inventory-fixtures.mjs';
import { teamCBackend, IDS as TC } from './teamc-fixtures.mjs';
import { messagesBackend, shiftsBackend, teamBackend, knowledgeBackend } from './people-fixtures.mjs';
import { atlasAiBackend, decisionsBackend, IDS as AI } from './atlas-ai-fixtures.mjs';

export { INV, TC, AI, VIEWER };

export const RAW_SERVER_TEXT = /upstream|PGRST|Service unavailable|Cannot read|undefined|TypeError|\[object|NaN/;
export const LONG_NAMES = ['Brennivín Íslenskt ákavíti — Þórsmörk sérútgáfa 700 ml (kryddað)', 'Reyka Small Batch Vodka frá Borgarnesi 1 L með Íslensku vatni', 'Flóki Sheep Dung Smoked Reserve Single Malt Whisky 700 ml'];
export const LONG_SUPPLIER = 'Ölgerðin Egill Skallagrímsson hf.';

const unavailable = () => ({ __status: 503, body: { error: 'Service unavailable', message: 'upstream connect error or disconnect/reset before headers', code: 'PGRST000' } });

export function compositeWorld(user = USERS.admin, { group = 'A', empty = false, fail = false, long = false } = {}) {
  const a = teamAFixtures({ user });
  const itemMaster = itemMasterBackend();
  const inventory = inventoryWorld({ itemMaster: itemMaster.handler });
  const c = teamCBackend({ user });
  const ai = atlasAiBackend();
  const aiSettings = a.functions['atlas-ai'];
  const settingsAnswer = (entry) => {
    const answer = aiSettings(entry);
    return entry.action === 'settings' ? { ...answer, configured: true, key_present: true } : answer;
  };
  const functions = {
    ...emptyFunctions(),
    ...a.functions,
    ...inventory.fixtures.functions,
    'atlas-settings': a.functions['atlas-settings'],
    'atlas-operations-checkpoint-a': a.functions['atlas-operations-checkpoint-a'],
    'atlas-item-master': (entry) => {
      const action = entry.action || entry.body?.action;
      if (['item_dependencies', 'set_item_active', 'create-item', 'catalog-request'].includes(action)) return itemMaster.handler(entry);
      return c.fixtures.functions['atlas-item-master'](entry);
    },
    'atlas-sprint3-review': c.fixtures.functions['atlas-sprint3-review'],
    'atlas-reports': c.fixtures.functions['atlas-reports'],
    'atlas-marketing-workspace': c.fixtures.functions['atlas-marketing-workspace'],
    'atlas-team-messages': messagesBackend({ user, empty }).handler,
    'atlas-shifts': shiftsBackend({ user, empty }).handler,
    'atlas-team-profiles': teamBackend({ user, empty }).handler,
    'atlas-knowledge': knowledgeBackend({ user, empty }).handler,
    'atlas-team-profile-photos': { photos: [], staff: { id: user.id, can_manage_team: user.role === 'admin' } },
    'atlas-ai': (entry) => (entry.action === 'settings' || entry.action === 'preferences' ? settingsAnswer(entry) : ai.handler(entry)),
    'atlas-phase3-brain': decisionsBackend()
  };
  const tables = group === 'INV' ? { ...a.tables, ...inventory.fixtures.tables } : group === 'C' ? { ...a.tables, ...c.fixtures.tables } : { ...a.tables };
  const rpc = { ...a.rpc, ...c.fixtures.rpc, ...inventory.fixtures.rpc };
  if (group === 'C') functions['atlas-stock-counts'] = c.fixtures.functions['atlas-stock-counts'];
  else if (group !== 'INV') functions['atlas-stock-counts'] = a.functions['atlas-stock-counts'];
  if (long) {
    for (const key of ['inventory_items', 'inventory_catalog', 'recipes', 'recipe_catalog', 'suppliers']) {
      if (!Array.isArray(tables[key])) continue;
      tables[key] = tables[key].map((row, index) => ({
        ...row,
        name: index < 3 ? LONG_NAMES[index] : row.name,
        category: row.category && index === 0 ? 'Íslenskt brennivín og ákavíti' : row.category,
        supplier: row.supplier ? LONG_SUPPLIER : row.supplier
      }));
    }
  }
  if (empty) {
    for (const key of Object.keys(tables)) tables[key] = [];
    for (const key of ['atlas-stock-counts', 'atlas-reports', 'atlas-marketing-workspace', 'atlas-sprint3-review', 'atlas-operations-checkpoint-a', 'atlas-system', 'atlas-integrations']) functions[key] = {};
    functions['atlas-ai'] = (entry) => (entry.action === 'conversations' ? { conversations: [], total: 0, has_more: false } : entry.action === 'settings' || entry.action === 'preferences' ? settingsAnswer(entry) : ai.handler(entry));
    functions['atlas-phase3-brain'] = { snapshot: { recommendations: [], memory: [] }, manager: { role: user.role } };
    for (const key of Object.keys(rpc)) if (!key.includes('policy')) rpc[key] = typeof rpc[key] === 'function' ? () => [] : (Array.isArray(rpc[key]) ? [] : rpc[key]);
    rpc.atlas_data_review_summary = { generated_at: '2026-09-24T14:00:00Z', issues: [] };
  }
  if (fail) {
    for (const key of Object.keys(functions)) if (key !== 'atlas-settings') functions[key] = unavailable;
    for (const key of Object.keys(tables)) tables[key] = unavailable();
    for (const key of Object.keys(rpc)) rpc[key] = unavailable();
  }
  return { tables, rpc, functions, profiles: [USERS.admin, USERS.bartender, VIEWER], writes: c.fixtures.writes };
}
