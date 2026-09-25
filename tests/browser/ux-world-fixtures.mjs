// One fixture world per page family, composed from the module fixtures, for
// the cross-page UX acceptance checks (ux-acceptance.browser.test.mjs):
// A = Home, Operations, Settings · INV = Inventory, stock count, Purchasing ·
// C = Recipes, Reports, Marketing, Data · P = Messages, Shifts, Team, Knowledge.
import { USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';
import { teamAFixtures, VIEWER } from './team-a-fixtures.mjs';
import { inventoryWorld, itemMasterBackend, IDS as INV } from './inventory-fixtures.mjs';
import { teamCBackend, IDS as TC } from './teamc-fixtures.mjs';
import { messagesBackend, shiftsBackend, teamBackend, knowledgeBackend } from './people-fixtures.mjs';
import { atlasAiBackend, decisionsBackend } from './atlas-ai-fixtures.mjs';

export { INV, TC, VIEWER };

export function uxWorld(user = USERS.admin, { group = 'A' } = {}) {
  const a = teamAFixtures({ user });
  const im = itemMasterBackend();
  const inv = inventoryWorld({ itemMaster: im.handler });
  const c = teamCBackend({ user });
  const ai = atlasAiBackend();
  const aiSettings = a.functions['atlas-ai'];
  const functions = {
    ...emptyFunctions(),
    ...a.functions,
    ...inv.fixtures.functions,
    'atlas-settings': a.functions['atlas-settings'],
    'atlas-operations-checkpoint-a': a.functions['atlas-operations-checkpoint-a'],
    'atlas-item-master': (entry) => {
      const action = entry.action || entry.body?.action;
      if (['item_dependencies', 'set_item_active', 'create-item', 'catalog-request'].includes(action)) return im.handler(entry);
      return c.fixtures.functions['atlas-item-master'](entry);
    },
    'atlas-sprint3-review': c.fixtures.functions['atlas-sprint3-review'],
    'atlas-reports': c.fixtures.functions['atlas-reports'],
    'atlas-marketing-workspace': c.fixtures.functions['atlas-marketing-workspace'],
    'atlas-team-messages': messagesBackend({ user }).handler,
    'atlas-shifts': shiftsBackend({ user }).handler,
    'atlas-team-profiles': teamBackend({ user }).handler,
    'atlas-knowledge': knowledgeBackend({ user }).handler,
    'atlas-team-profile-photos': { photos: [], staff: { id: user.id, can_manage_team: user.role === 'admin' } },
    'atlas-ai': async (entry) => {
      if (entry.action === 'settings' || entry.action === 'preferences') {
        const result = aiSettings(entry);
        return entry.action === 'settings' ? { ...result, configured: true, key_present: true } : result;
      }
      return ai.handler(entry);
    },
    'atlas-phase3-brain': decisionsBackend()
  };
  const tables = group === 'INV' ? { ...a.tables, ...inv.fixtures.tables } : group === 'C' ? { ...a.tables, ...c.fixtures.tables } : { ...a.tables };
  const rpc = { ...a.rpc, ...c.fixtures.rpc, ...inv.fixtures.rpc };
  if (group === 'C') functions['atlas-stock-counts'] = c.fixtures.functions['atlas-stock-counts'];
  else if (group !== 'INV') functions['atlas-stock-counts'] = a.functions['atlas-stock-counts'];
  return { tables, rpc, functions, profiles: [USERS.admin, USERS.bartender, VIEWER] };
}
