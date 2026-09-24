// Deterministic backend data for style-snapshot.mjs. Richer than the per-test
// fixtures so that most module markup actually renders, and pinned to a frozen
// clock so that dates and relative labels are identical between runs.
import { USERS } from '../harness.mjs';
import { emptyFunctions, settingsWorkspace } from '../fixtures.mjs';

export const FROZEN_NOW = Date.parse('2026-09-24T12:00:00Z');
const iso = (days) => new Date(FROZEN_NOW + days * 86400000).toISOString();
const day = (days) => iso(days).slice(0, 10);

const inventory = [
  { id: 'pinot', name: 'Angelo Pinot Grigio 750ml', category: 'Wine', unit: 'bottles', par_level: 6, supplier: 'Globus', active: true, cost_price: 2100, units_per_case: 6 },
  { id: 'tequila', name: 'Olmeca Blanco Tequila 1L', category: 'Tequila & Mezcal', unit: 'bottles', par_level: 2, supplier: 'Globus', active: true, cost_price: 5200 },
  { id: 'lime', name: 'Lime juice', category: 'Juices', unit: 'l', par_level: 2, supplier: 'Mata', active: true, cost_price: 900 },
  { id: 'triple', name: 'Triple Sec', category: 'Liqueurs', unit: 'bottles', par_level: 2, supplier: 'Globus', active: true, cost_price: 3000 },
  { id: 'agave', name: 'Agave syrup', category: 'Syrups', unit: 'bottles', par_level: 1, supplier: 'Mata', active: true, cost_price: 1500 },
  { id: 'lager', name: 'Gull Lager 33cl', category: 'Beer', unit: 'bottles', par_level: 24, supplier: 'Ölgerðin', active: true, cost_price: 250 }
];
const balance = (id, quantity) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: iso(-1), expires_at: iso(10) });
const recipes = [
  { id: 'margarita', name: 'Margarita', active: true, yield_quantity: 1, menu_price: 2990, glassware: 'Coupe', garnish: 'Lime wheel', method: 'Shake', recipe_ingredients: [
    { id: 'r1', item_id: 'tequila', item_name: 'Olmeca Blanco Tequila 1L', quantity: 50, unit: 'ml' },
    { id: 'r2', item_id: 'lime', item_name: 'Lime juice', quantity: 25, unit: 'ml' },
    { id: 'r3', item_id: 'triple', item_name: 'Triple Sec', quantity: 20, unit: 'ml' }
  ] },
  { id: 'lime-soda', name: 'Lime Soda', active: true, yield_quantity: 1, menu_price: 1500, recipe_ingredients: [{ id: 'l1', item_id: 'lime', item_name: 'Lime juice', quantity: 25, unit: 'ml' }] },
  { id: 'paloma', name: 'Paloma', active: true, yield_quantity: 1, recipe_ingredients: [{ id: 'p1', item_id: 'agave', item_name: 'Agave syrup', quantity: 10, unit: 'ml' }] },
  { id: 'old', name: 'Old Special', active: false, yield_quantity: 1, recipe_ingredients: [] }
];
const suppliers = [
  { id: 's1', name: 'Globus', email: 'orders@globus.example', phone: '+354 555 0101', active: true },
  { id: 's2', name: 'Mata', email: 'pantanir@mata.example', active: true }
];

function shifts(user) {
  const people = [
    { id: 'p-sara', display_name: 'Sara Jónsdóttir', active: true, login_enabled: true },
    { id: 'p-jon', display_name: 'Jón Gunnarsson', active: true, login_enabled: false }
  ];
  const permissions = { can_manage_schedule: user.role === 'admin' };
  return (entry) => {
    if (entry.action === 'month-snapshot') {
      const monthStart = new URLSearchParams(entry.search).get('month_start') || `${day(0).slice(0, 7)}-01`;
      return { workspace: { month: { month_start: monthStart, status: 'draft' }, people, permissions, shifts: [
        { id: 'm1', person_id: 'p-sara', starts_local: `${day(1)}T17:00:00`, ends_local: `${day(1)}T23:30:00`, role_name: 'Bartender' }
      ] }, staff: permissions };
    }
    return { workspace: {
      week: { status: 'published', week_start: day(-3) },
      people, permissions,
      shifts: [{ id: 'sh1', person_id: 'p-sara', starts_local: `${day(1)}T17:00:00`, ends_local: `${day(1)}T23:30:00`, role_name: 'Bartender' }],
      availability: [], time_off: [], responses: []
    }, staff: permissions };
  };
}

function teamMessages(user) {
  const members = [
    { id: USERS.admin.id, label: 'Imad El Moubarik', role: 'admin' },
    { id: USERS.bartender.id, label: 'Sara Jónsdóttir', role: 'bartender' }
  ];
  const messages = [
    { id: 'm1', sender_id: USERS.bartender.id, sender_label: 'Sara Jónsdóttir', sender_role: 'bartender', body: 'Lime juice is running low.', message_type: 'user', created_at: iso(-0.2), is_own: user.id === USERS.bartender.id },
    { id: 'm2', sender_id: USERS.admin.id, sender_label: 'Imad El Moubarik', sender_role: 'admin', body: 'Ordered from Mata.', message_type: 'user', created_at: iso(-0.1), is_own: user.id === USERS.admin.id }
  ];
  return () => ({
    snapshot: { channels: [{ key: 'general', name: 'General', unread_count: 0 }], messages, selected_channel_key: 'general', summary: { total_unread: 0, active_members: 2 } },
    members,
    staff: { id: user.id, label: user.display_name, role: user.role }
  });
}

export function captureFixtures(user = USERS.admin) {
  return {
    tables: { inventory_items: inventory, recipes, suppliers, recipe_categories: [], purchase_orders: [], import_batches: [] },
    functions: {
      ...emptyFunctions(),
      'atlas-stock-counts': { counts: { verified_balances: [balance('pinot', 4), balance('tequila', 3), balance('lime', 1), balance('triple', 2), balance('lager', 30)] } },
      'atlas-knowledge': { workspace: { articles: [{ id: 'k1', title: 'Opening checklist', category_name: 'Checklists', summary: 'Before doors open' }] } },
      'atlas-shifts': shifts(user),
      'atlas-team-messages': teamMessages(user),
      'atlas-settings': () => ({ workspace: settingsWorkspace(), staff: { id: user.id, label: user.display_name, role: user.role, active: true } })
    }
  };
}
