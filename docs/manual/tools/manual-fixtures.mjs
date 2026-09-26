// Demo venue for the Atlas User Guide screenshots.
//
// Builds one believable bar ("Harbour Room", Reykjavík, Thursday 24 September
// 2026 late afternoon) on top of the browser-test fixture sets in
// tests/browser/*fixtures*.mjs, so every page of the guide shows the same
// venue, the same people and the same stock. Everything here is synthetic:
// the people are invented, addresses use the reserved .example domain, and no
// key, token or production record appears. Only data is added; the UI shown in
// the screenshots is the real apps/web code served by the test harness.
import { USERS, fixtureTime } from '../../../tests/browser/harness.mjs';
import { compositeWorld, VIEWER } from '../../../tests/browser/composite-fixtures.mjs';
import { settingsWorkspace } from '../../../tests/browser/fixtures.mjs';
import { countBackend, purchasingBackend, recognitionBackend, IDS as INV } from '../../../tests/browser/inventory-fixtures.mjs';
import { messagesBackend, shiftsBackend, teamBackend, PEOPLE } from '../../../tests/browser/people-fixtures.mjs';
import { reportsSnapshot, marketingWorkspace, importBatches } from '../../../tests/browser/teamc-fixtures.mjs';
import { atlasAiBackend, decisionsBackend, negroniMessages, orderProposal, IDS as AI_IDS } from '../../../tests/browser/atlas-ai-fixtures.mjs';

// The guide's frozen clock: Thursday 24 September 2026, 16:40 in Reykjavík
// (UTC+0 all year), twenty minutes before doors open.
export const MANUAL_NOW = '2026-09-24T16:40:00.000Z';
const DAY = 86400000;
const iso = (days) => fixtureTime(days * DAY);
const dateKey = (days = 0) => iso(days).slice(0, 10);
const uuid = (n) => `6d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---------- people ----------

// Demo staff. The ids of the first three match the harness users so the
// mocked session, rosters and messages agree.
export const PEOPLE_NAMES = {
  owner: 'Katrín Magnúsdóttir',
  sara: 'Sara Jónsdóttir',
  gunnar: 'Gunnar Karlsson',
  elin: 'Elín Hauksdóttir',
  jon: 'Jón Gunnarsson',
  vala: 'Vala Stefánsdóttir',
  dagur: 'Dagur Pálsson'
};

export const DEMO_USERS = {
  admin: { ...USERS.admin, email: 'katrin@harbourroom.example', display_name: PEOPLE_NAMES.owner },
  bartender: { ...USERS.bartender, email: 'sara@harbourroom.example', display_name: PEOPLE_NAMES.sara },
  viewer: { ...VIEWER, email: 'vala@harbourroom.example', display_name: PEOPLE_NAMES.vala }
};

const GUNNAR_ID = 'c0ffee00-0000-4000-8000-000000000003';
const ELIN_ID = 'c0ffee00-0000-4000-8000-000000000005';
const DAGUR_ID = 'c0ffee00-0000-4000-8000-000000000006';

// Names, venue and handles that the shared test fixtures carry, which the
// guide replaces so no screenshot shows a production-looking name. They are
// read from the fixtures themselves rather than repeated here.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FIXTURE_OWNER = USERS.admin.display_name;
const FIXTURE_OWNER_FIRST = FIXTURE_OWNER.split(' ')[0];
const FIXTURE_OWNER_SURNAME = FIXTURE_OWNER.split(' ').slice(1).join(' ');
const FIXTURE_VENUE = settingsWorkspace().sections.find((section) => section.section_key === 'venue').value;
const RENAMES = [
  [new RegExp(escapeRegExp(FIXTURE_OWNER), 'g'), PEOPLE_NAMES.owner],
  [new RegExp(`\\b[\\p{L}]+ ${escapeRegExp(FIXTURE_OWNER_SURNAME)}`, 'gu'), 'Einar Magnússon'],
  [new RegExp(`\\b${escapeRegExp(FIXTURE_OWNER_FIRST)}\\b`, 'g'), 'Katrín'],
  [/Gunnar Kristjánsson/g, PEOPLE_NAMES.gunnar],
  [/Vala Viewer/g, PEOPLE_NAMES.vala],
  [new RegExp(escapeRegExp(FIXTURE_VENUE.legal_name), 'g'), 'Harbour Room ehf.'],
  [new RegExp(escapeRegExp(FIXTURE_VENUE.business_name), 'g'), 'Harbour Room'],
  [/@[a-z]+\.rvk\b/g, '@harbourroom.rvk'],
  [/[a-z.]+@example\.test/g, (address) => `${{ owner: 'katrin' }[address.split('@')[0]] || address.split('@')[0].split('.')[0]}@harbourroom.example`],
  [/atlas-ai\/s\d+/g, 'atlas-ai'],
  // The shared test fixtures name real Icelandic wholesalers; the guide shows
  // invented suppliers instead.
  [/Ölgerðin Egill Skallagrímsson hf\./g, 'Bay Drinks ehf.'],
  [/Ölgerðin/g, 'Bay Drinks'],
  [/Globus/g, 'Northwind'],
  [/\bMata\b/g, 'Greenleaf'],
  [/Vínkaup/g, 'Cellar Door'],
  [/Kaffibrennslan|Te & Kaffi/g, 'Bean Street'],
  [/@(?:pantanir\.)?(globus|olgerdin|mata|vinkaup|kaffi)\.example/g, (address, key) => `@${{ globus: 'northwind', olgerdin: 'baydrinks', mata: 'greenleaf', vinkaup: 'cellardoor', kaffi: 'beanstreet' }[key]}.example`],
  // The shared test fixtures use Icelandic 555 numbers, a real landline range.
  // The guide shows numbers that cannot be assigned (Icelandic numbers never
  // start with 0), so no screenshot carries a number someone might own.
  [/(?<![\w-])(?:\+354[ -]?)?555[ -]?(\d{4})(?![\w-])/g, (number, last) => `+354 000 ${last}`]
];

export function rename(value) {
  if (typeof value === 'string') return RENAMES.reduce((text, [pattern, next]) => text.replace(pattern, next), value);
  if (Array.isArray(value)) return value.map(rename);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rename(entry)]));
  }
  return value;
}

const renamed = (handler) => async (...args) => rename(await (typeof handler === 'function' ? handler(...args) : handler));

// Soft illustrated avatars (no real photographs): a tinted circle with a
// head-and-shoulders shape, as an SVG data URL the photo snapshot can serve.
function avatar(background, skin, hair) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${background}"/><circle cx="48" cy="40" r="17" fill="${skin}"/><path d="M31 38c0-12 8-20 17-20s17 8 17 20c-3-7-9-10-17-10s-14 3-17 10z" fill="${hair}"/><path d="M16 96c2-19 15-29 32-29s30 10 32 29z" fill="${hair}" opacity=".85"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
export const PHOTOS = [
  { profile_id: USERS.bartender.id, signed_url: avatar('#dbe7f7', '#f1c9a5', '#6b4a2f'), version: 'demo-1' },
  { profile_id: GUNNAR_ID, signed_url: avatar('#e4efe7', '#e8b98f', '#2f2a26'), version: 'demo-1' }
];

// ---------- suppliers, stock and recipes ----------

const S = { globus: INV.globus, olgerdin: INV.olgerdin, mata: INV.mata, vinkaup: uuid(901), kaffi: uuid(902) };
export const suppliers = [
  { id: S.globus, name: 'Northwind', contact_name: 'Anna', email: 'orders@northwind.example', phone: '+354 000 1234', active: true, lead_time_days: 1, order_cutoff: '18:00' },
  { id: S.olgerdin, name: 'Bay Drinks', contact_name: 'Jón', email: 'orders@baydrinks.example', phone: '+354 000 2200', active: true },
  { id: S.mata, name: 'Greenleaf', contact_name: 'Rakel', email: 'orders@greenleaf.example', active: true },
  { id: S.vinkaup, name: 'Cellar Door', email: 'orders@cellardoor.example', active: true },
  { id: S.kaffi, name: 'Bean Street', email: 'orders@beanstreet.example', active: true }
];
const supplierName = (id) => suppliers.find((row) => row.id === id)?.name;

const ID = {
  ...INV,
  vodka: uuid(1), brennivin: uuid(2), rum: uuid(3), bourbon: uuid(4), tequila: uuid(5), cointreau: uuid(6), kahlua: uuid(7),
  vermouth: uuid(8), prosecco: uuid(9), ale: uuid(10), lager: uuid(11), lemons: uuid(12), mint: uuid(13), coffee: uuid(14),
  simple: uuid(15), soda: uuid(16), ginger: uuid(17), whisky: uuid(18)
};
export { ID as ITEM_IDS };

const item = (id, name, category, unit, par, supplierId, cost, extra = {}) => ({
  id, name, category, unit, par_level: par, supplier: supplierName(supplierId), supplier_id: supplierId, active: true, cost_price: cost, updated_at: iso(-3), ...extra
});

export const items = [
  item(ID.campari, 'Campari', 'Aperitif', 'bottles', 4, S.globus, 3900, { size_ml: 1000, bin_location: 'Back bar', barcode: '8000070012345', units_per_case: 6 }),
  item(ID.aperol, 'Aperol', 'Aperitif', 'bottles', 4, S.globus, 3300, { size_ml: 1000, bin_location: 'Back bar', units_per_case: 6 }),
  item(ID.tanq, 'Tanqueray London Dry', 'Gin', 'bottles', 6, S.globus, 4200, { size_ml: 1000, bin_location: 'Back bar', units_per_case: 6 }),
  item(ID.vodka, 'Absolut Vodka', 'Vodka', 'bottles', 4, S.globus, 4100, { size_ml: 1000, bin_location: 'Back bar', units_per_case: 6 }),
  item(ID.brennivin, 'Brennivín', 'Akvavit', 'bottles', 3, S.globus, 4600, { size_ml: 700, bin_location: 'Freezer' }),
  item(ID.rum, 'Havana Club 3 Años', 'Rum', 'bottles', 3, S.globus, 3800, { size_ml: 1000, bin_location: 'Back bar' }),
  item(ID.bourbon, 'Buffalo Trace Bourbon', 'Whiskey', 'bottles', 2, S.globus, 6200, { size_ml: 700, bin_location: 'Back bar' }),
  item(ID.whisky, 'Jameson Irish Whiskey', 'Whiskey', 'bottles', 2, S.globus, 5400, { size_ml: 1000, bin_location: 'Back bar' }),
  item(ID.tequila, 'Olmeca Blanco Tequila', 'Tequila', 'bottles', 2, S.globus, 5200, { size_ml: 1000, bin_location: 'Back bar' }),
  item(ID.cointreau, 'Cointreau', 'Liqueur', 'bottles', 2, S.globus, 4900, { size_ml: 700, bin_location: 'Back bar' }),
  item(ID.kahlua, 'Kahlúa', 'Liqueur', 'bottles', 2, S.globus, 3600, { size_ml: 700, bin_location: 'Back bar' }),
  item(ID.vermouth, 'Martini Rosso', 'Vermouth', 'bottles', 3, S.globus, 2200, { size_ml: 1000, bin_location: 'Back bar fridge' }),
  item(ID.ango, 'Angostura Bitters', 'Bitters', 'bottles', 2, S.globus, 2900, { size_ml: 200, bin_location: 'Back bar' }),
  item(ID.giffard, 'Giffard Vanille Syrup', 'Syrups', 'bottles', 2, S.globus, 2400, { size_ml: 1000, bin_location: 'Back bar' }),
  item(ID.prosecco, 'Prosecco DOC', 'Wine', 'bottles', 12, S.vinkaup, 1900, { size_ml: 750, bin_location: 'Wine fridge', units_per_case: 6 }),
  item(ID.tonic, 'Fever-Tree Tonic', 'Mixer', 'bottles', 72, S.olgerdin, 190, { size_ml: 200, bin_location: 'Store room', units_per_case: 24 }),
  item(ID.soda, 'Soda water', 'Mixer', 'bottles', 48, S.olgerdin, 120, { size_ml: 250, bin_location: 'Store room', units_per_case: 24 }),
  item(ID.ginger, 'Ginger beer', 'Mixer', 'bottles', 24, S.olgerdin, 210, { size_ml: 200, bin_location: 'Store room', units_per_case: 24 }),
  item(ID.ale, 'Einstök White Ale', 'Beer', 'bottles', 48, S.olgerdin, 290, { size_ml: 330, bin_location: 'Beer fridge', units_per_case: 24 }),
  item(ID.lager, 'Gull Lager', 'Beer', 'bottles', 48, S.olgerdin, 250, { size_ml: 330, bin_location: 'Beer fridge', units_per_case: 24 }),
  item(ID.limes, 'Limes', 'Fresh fruit', 'each', 40, S.mata, 60, { bin_location: 'Walk-in fridge' }),
  item(ID.lemons, 'Lemons', 'Fresh fruit', 'each', 30, S.mata, 55, { bin_location: 'Walk-in fridge' }),
  item(ID.mint, 'Fresh mint', 'Fresh herbs', 'bunches', 4, S.mata, 450, { bin_location: 'Walk-in fridge' }),
  item(ID.sugar, 'Demerara Sugar Cube', 'Bar Ingredients', 'kg', 2, S.mata, 900, { bin_location: 'Store room' }),
  item(ID.simple, 'Simple syrup (house)', 'Syrups', 'l', 2, S.mata, 300, { bin_location: 'Back bar fridge' }),
  item(ID.coffee, 'Espresso beans', 'Coffee', 'kg', 2, S.kaffi, 5200, { bin_location: 'Store room' }),
  { ...item(ID.old, 'Old Tom Gin', 'Gin', 'bottles', 0, S.globus, 4800), active: false, updated_at: iso(-30) }
];

const balance = (id, quantity, days = 2) => ({ inventory_item_id: id, verified_quantity: quantity, freshness_state: 'current', verified_at: iso(-days), expires_at: iso(7 - days) });
export const balances = [
  balance(ID.campari, 1), balance(ID.aperol, 2), balance(ID.tanq, 3), balance(ID.vodka, 5), balance(ID.brennivin, 4), balance(ID.rum, 4),
  balance(ID.bourbon, 2), balance(ID.whisky, 3), balance(ID.tequila, 0), balance(ID.cointreau, 1), balance(ID.kahlua, 2), balance(ID.vermouth, 4),
  balance(ID.ango, 1), balance(ID.giffard, 3), balance(ID.prosecco, 18), balance(ID.tonic, 48), balance(ID.soda, 60), balance(ID.ginger, 30),
  balance(ID.ale, 30), balance(ID.lager, 61), balance(ID.limes, 14), balance(ID.lemons, 32), balance(ID.mint, 5), balance(ID.coffee, 1), balance(ID.simple, 2), balance(ID.sugar, 3)
];

// Newest first, as the movement history lists them.
export const movements = [
  { id: 'mv5', item_id: ID.mint, item_name: 'Fresh mint', movement_type: 'waste', quantity_change: -1, note: 'Spoilage: wilted', created_at: iso(-0.9), created_by_label: PEOPLE_NAMES.sara },
  { id: 'mv2', item_id: ID.limes, item_name: 'Limes', movement_type: 'waste', quantity_change: -6, note: 'Spoilage: soft limes', created_at: iso(-1.2), created_by_label: PEOPLE_NAMES.gunnar },
  { id: 'mv4', item_id: ID.prosecco, item_name: 'Prosecco DOC', movement_type: 'restock', quantity_change: 12, total_cost: 22800, supplier_id: S.vinkaup, suppliers: { name: 'Cellar Door' }, note: 'Delivery', created_at: iso(-2.2), created_by_label: PEOPLE_NAMES.owner },
  { id: 'mv3', item_id: ID.campari, item_name: 'Campari', movement_type: 'adjustment', quantity_change: -1, note: 'Breakage', created_at: iso(-3.5), created_by_label: PEOPLE_NAMES.sara },
  { id: 'mv1', item_id: ID.tonic, item_name: 'Fever-Tree Tonic', movement_type: 'restock', quantity_change: 24, total_cost: 4560, supplier_id: S.olgerdin, suppliers: { name: 'Bay Drinks' }, note: 'Delivery', created_at: iso(-4), created_by_label: PEOPLE_NAMES.sara },
  { id: 'mv6', item_id: ID.tanq, item_name: 'Tanqueray London Dry', movement_type: 'restock', quantity_change: 6, total_cost: 25200, supplier_id: S.globus, suppliers: { name: 'Northwind' }, note: 'Delivery', created_at: iso(-6), created_by_label: PEOPLE_NAMES.owner }
];

const ing = (key, itemId, quantity, unit) => ({ id: `ri-${key}`, item_id: itemId, item_name: items.find((row) => row.id === itemId)?.name, quantity, unit });
const recipe = (id, name, type, price, glassware, garnish, method, ingredients, extra = {}) => ({
  id, name, type, active: true, yield_quantity: 1, yield_unit: 'serving', menu_price: price, glassware, garnish, method, show_on_menu: true, updated_at: iso(-5), recipe_ingredients: ingredients, ...extra
});
export const RECIPE_IDS = { negroni: uuid(101), spritz: uuid(102), gt: uuid(103), espresso: uuid(104), margarita: uuid(105), mojito: uuid(106), oldfashioned: uuid(107), sour: uuid(108), northern: uuid(109), mule: uuid(110), virgin: uuid(111), old: uuid(112) };
const R = RECIPE_IDS;
export const recipes = [
  recipe(R.northern, 'Northern Lights', 'signature-cocktail', 3200, 'Coupe', 'Lemon twist', 'Shake hard with ice\nDouble strain into a chilled coupe\nExpress the lemon twist over the top', [ing('nl1', ID.brennivin, 45, 'ml'), ing('nl2', ID.cointreau, 15, 'ml'), ing('nl3', ID.lemons, 1, 'each'), ing('nl4', ID.simple, 15, 'ml')]),
  recipe(R.espresso, 'Espresso Martini', 'signature-cocktail', 3100, 'Coupe', 'Three coffee beans', 'Pull a fresh espresso\nShake hard with vodka, Kahlúa and syrup\nDouble strain and garnish', [ing('e1', ID.vodka, 40, 'ml'), ing('e2', ID.kahlua, 20, 'ml'), ing('e3', ID.coffee, 18, 'g'), ing('e4', ID.giffard, 10, 'ml')]),
  recipe(R.negroni, 'Negroni', 'classic-cocktail', 2900, 'Rocks', 'Orange peel', 'Stir with ice for 20 seconds\nStrain over a large cube\nExpress the orange peel', [ing('n1', ID.tanq, 30, 'ml'), ing('n2', ID.campari, 30, 'ml'), ing('n3', ID.vermouth, 30, 'ml')]),
  recipe(R.margarita, 'Margarita', 'classic-cocktail', 2900, 'Coupe', 'Lime wheel, half salt rim', 'Shake with ice\nStrain into a salt-rimmed coupe', [ing('m1', ID.tequila, 50, 'ml'), ing('m2', ID.cointreau, 20, 'ml'), ing('m3', ID.limes, 1, 'each')]),
  recipe(R.oldfashioned, 'Old Fashioned', 'classic-cocktail', 3000, 'Rocks', 'Orange peel', 'Stir sugar and bitters\nAdd bourbon and ice, stir 30 seconds\nExpress the orange peel', [ing('o1', ID.bourbon, 60, 'ml'), ing('o2', ID.sugar, 0.005, 'kg'), ing('o3', ID.ango, 2, 'ml')]),
  recipe(R.sour, 'Whiskey Sour', 'classic-cocktail', 2800, 'Rocks', 'Angostura drops', 'Dry shake, then shake with ice\nStrain over fresh ice', [ing('w1', ID.whisky, 50, 'ml'), ing('w2', ID.lemons, 1, 'each'), ing('w3', ID.simple, 20, 'ml')]),
  recipe(R.mojito, 'Mojito', 'classic-cocktail', 2700, 'Highball', 'Mint sprig', 'Muddle mint, lime and sugar\nAdd rum and crushed ice\nTop with soda', [ing('j1', ID.rum, 50, 'ml'), ing('j2', ID.limes, 1, 'each'), ing('j3', ID.mint, 0.1, 'bunches'), ing('j4', ID.soda, 1, 'bottles')]),
  recipe(R.gt, 'Gin & Tonic', 'classic-cocktail', 2500, 'Highball', 'Lime wheel', 'Build over ice\nTop with tonic', [ing('g1', ID.tanq, 40, 'ml'), ing('g2', ID.tonic, 1, 'bottles'), ing('g3', ID.limes, 0.25, 'each')]),
  recipe(R.mule, 'Moscow Mule', 'classic-cocktail', 2700, 'Copper mug', 'Lime wedge', 'Build over ice\nTop with ginger beer', [ing('mu1', ID.vodka, 45, 'ml'), ing('mu2', ID.ginger, 1, 'bottles'), ing('mu3', ID.limes, 0.5, 'each')]),
  recipe(R.spritz, 'Aperol Spritz', 'spritz', 2700, 'Wine glass', 'Orange slice', 'Build over ice: prosecco, Aperol, soda', [ing('s1', ID.aperol, 60, 'ml'), ing('s2', ID.prosecco, 0.12, 'bottles'), ing('s3', ID.soda, 0.1, 'bottles')]),
  recipe(R.virgin, 'Garden Fizz', 'mocktail', 1600, 'Highball', 'Mint sprig', 'Muddle mint and lime\nAdd syrup and ice\nTop with soda', [ing('v1', ID.mint, 0.1, 'bunches'), ing('v2', ID.limes, 1, 'each'), ing('v3', ID.simple, 20, 'ml'), ing('v4', ID.soda, 1, 'bottles')]),
  { ...recipe(R.old, 'Winter Toddy', 'hot-cocktail', 2200, 'Mug', '', '', []), active: false, show_on_menu: false, updated_at: iso(-60) }
];

// ---------- purchasing: one order in each status ----------

const line = (itemId, quantity) => { const row = items.find((entry) => entry.id === itemId); return { item_id: itemId, item_name: row.name, unit: row.unit, quantity, unit_cost: row.cost_price }; };
export const ORDER_IDS = { draft: uuid(501), approval: INV.po1, approved: uuid(503), ordered: INV.po2, partial: uuid(505), received: uuid(506), cancelled: uuid(507) };
const O = ORDER_IDS;
function orders() {
  return [
    { id: O.draft, supplier_id: S.mata, status: 'draft', version: 1, lines: [line(ID.limes, 60), line(ID.lemons, 30), line(ID.mint, 6)], note: 'Friday delivery please', created_at: iso(-0.05), expected_delivery_date: dateKey(1) },
    { id: O.approval, supplier_id: S.globus, status: 'pending_approval', version: 3, submitted_at: iso(-0.1), lines: [line(ID.campari, 6), line(ID.aperol, 4), line(ID.tequila, 3), line(ID.ango, 2)], note: '', created_at: iso(-0.12), expected_delivery_date: dateKey(1) },
    { id: O.approved, supplier_id: S.vinkaup, status: 'approved', version: 4, lines: [line(ID.prosecco, 12)], note: '', created_at: iso(-1), expected_delivery_date: dateKey(2) },
    { id: O.ordered, supplier_id: S.olgerdin, status: 'ordered', version: 5, lines: [line(ID.tonic, 48), line(ID.ginger, 24), line(ID.lager, 24)], note: 'Deliver before noon', created_at: iso(-2), expected_delivery_date: dateKey(0) },
    { id: O.partial, supplier_id: S.globus, status: 'partially_received', version: 6, lines: [line(ID.whisky, 2), line(ID.vodka, 6), line(ID.bourbon, 2)], note: '', created_at: iso(-5), expected_delivery_date: dateKey(-2), receipts: [{ item_id: ID.whisky, quantity: 2 }, { item_id: ID.vodka, quantity: 4 }], events: [{ id: 'e2', event_type: 'ordered', created_at: iso(-4.8) }, { id: 'e3', event_type: 'received_partial', created_at: iso(-2) }] },
    { id: O.received, supplier_id: S.kaffi, status: 'received', version: 6, lines: [line(ID.coffee, 3)], note: '', created_at: iso(-9), expected_delivery_date: dateKey(-7), receipts: [{ item_id: ID.coffee, quantity: 3 }] },
    { id: O.cancelled, supplier_id: S.mata, status: 'cancelled', version: 3, lines: [line(ID.sugar, 2)], note: 'Duplicate of an earlier order', created_at: iso(-12), expected_delivery_date: dateKey(-10) }
  ];
}

// ---------- messages ----------

const minutesAgo = (minutes) => new Date(Date.parse(MANUAL_NOW) - minutes * 60000).toISOString();
const MEMBERS = [
  { id: USERS.admin.id, label: PEOPLE_NAMES.owner, role: 'admin' },
  { id: USERS.bartender.id, label: PEOPLE_NAMES.sara, role: 'bartender' },
  { id: GUNNAR_ID, label: PEOPLE_NAMES.gunnar, role: 'bartender' },
  { id: ELIN_ID, label: PEOPLE_NAMES.elin, role: 'bartender' },
  { id: DAGUR_ID, label: PEOPLE_NAMES.dagur, role: 'manager' }
];
const who = { owner: MEMBERS[0], sara: MEMBERS[1], gunnar: MEMBERS[2], elin: MEMBERS[3], dagur: MEMBERS[4] };
let messageSeq = 0;
const msg = (person, body, minutes, extra = {}) => ({
  id: `dm-${++messageSeq}`, sender_id: person.id, sender_label: person.label, sender_name: person.label, sender_role: person.role, body, message_type: 'user', created_at: minutesAgo(minutes), read_by: [], read_by_count: 0, ...extra
});
const readers = (...people) => ({ read_by: people.map((person) => ({ user_id: person.id, user_label: person.label.split(' ')[0] })), read_by_count: people.length });

function messages(user) {
  const backend = messagesBackend({ user });
  const t = backend.threads;
  Object.keys(t).forEach((key) => { t[key].length = 0; });
  t.general.push(
    msg(who.dagur, 'Morning all. Quiz night tonight — first round at 20:00, we have 14 teams booked.', 26 * 60, readers(who.sara, who.gunnar, who.elin)),
    msg(who.sara, 'Great. I’ll set up the back tables and the answer sheets before we open.', 25 * 60, readers(who.dagur, who.gunnar)),
    msg(who.gunnar, 'Keg of Einstök changed, the spare is in the walk-in.', 190, readers(who.owner, who.sara)),
    msg(who.owner, 'Thanks. The Northwind order is waiting for approval — Campari and Aperol are on it.', 95, { ...readers(who.sara, who.gunnar), link: { type: 'inventory_item', key: ID.campari, label: 'Campari', route: 'inventory', metadata: {} } }),
    msg(who.elin, 'Ice machine is making that noise again. I put a note on it.', 42),
    msg(who.elin, 'Using the bags from the chest freezer until someone has a look.', 40),
    msg(who.sara, 'Limes are soft in the last box — I logged six as waste and moved the good ones to the front.', 18)
  );
  t['shift-handover'].push(
    msg(who.gunnar, 'Closed at 01:10. Till balanced, dishwasher cleaned, bins out. Two Tanqueray opened, one left sealed.', 16 * 60, readers(who.owner, who.sara)),
    msg(who.sara, 'Got it, thanks Gunnar. I’ll pick up the glass polish before opening.', 15 * 60, readers(who.gunnar))
  );
  t.operations.push(
    msg(who.dagur, 'Fridge 2 read 6.1 °C yesterday evening. Please log it again at opening.', 20 * 60, readers(who.sara, who.elin)),
    msg(who.sara, 'Will do — logged 3.8 °C for fridge 1 already.', 35)
  );
  t.announcements.push(
    { id: 'an-1', sender_id: null, sender_label: 'Atlas', sender_role: null, body: 'Knowledge article published\nOpening the bar · Version 3\nRequired reading for assigned staff.', message_type: 'system', created_at: minutesAgo(29 * 60), link: { type: 'knowledge_article', key: 'k-opening', label: 'Opening the bar', route: 'knowledge', metadata: {} } },
    msg(who.owner, 'The autumn menu goes live on 1 October. Tastings for the whole team on Tuesday at 15:00 — please read the cocktail standards before then.', 6 * 60, readers(who.sara, who.gunnar, who.elin, who.dagur))
  );
  t.marketing.push(
    msg(who.dagur, 'Draft reel for Friday quiz night is in Marketing for approval.', 5 * 60, readers(who.owner))
  );
  backend.channels.forEach((entry) => { entry.unread_count = 0; entry.last_read_at = minutesAgo(10); });
  const set = (key, count) => { const found = backend.channels.find((entry) => entry.key === key); found.unread_count = count; found.last_read_at = minutesAgo(60); };
  set('general', 3);
  set('announcements', 1);
  backend.members = MEMBERS;
  return backend;
}

// ---------- shifts ----------

function shifts(user) {
  if (!PEOPLE.some((person) => person.id === 'p-elin')) {
    PEOPLE.push({ id: 'p-elin', profile_id: ELIN_ID, display_name: PEOPLE_NAMES.elin, default_role: 'Floor', active: true, login_enabled: true });
    PEOPLE.push({ id: 'p-dagur', profile_id: DAGUR_ID, display_name: PEOPLE_NAMES.dagur, default_role: 'Manager', active: true, login_enabled: true });
  }
  const backend = shiftsBackend({ user });
  const WEEK = '2026-09-21';
  const add = (id, personId, day, start, end, extra = {}) => {
    const date = new Date(`${WEEK}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + day);
    const key = date.toISOString().slice(0, 10);
    const next = new Date(date); if (end <= start) next.setUTCDate(next.getUTCDate() + 1);
    const endKey = next.toISOString().slice(0, 10);
    const person = PEOPLE.find((entry) => entry.id === personId);
    backend.shifts.push({ id, week_start: WEEK, person_id: personId, person_name: person.display_name, profile_id: person.profile_id, login_enabled: true, role_name: extra.role || person.default_role, starts_at: `${key}T${start}:00Z`, ends_at: `${endKey}T${end}:00Z`, starts_local: `${key}T${start}:00`, ends_local: `${endKey}T${end}:00`, break_minutes: 30, note: extra.note || null, active: true, updated_at: '2026-09-20T10:00:00Z', last_published_revision: 2 });
  };
  add('x1', 'p-elin', 3, '19:00', '01:30', { note: 'Quiz host' });
  add('x2', 'p-elin', 4, '18:00', '02:00');
  add('x3', 'p-elin', 5, '18:00', '03:00');
  add('x4', 'p-dagur', 1, '16:00', '23:00');
  add('x5', 'p-dagur', 4, '17:00', '01:00');
  add('x6', 'p-dagur', 5, '17:00', '01:00');
  add('x7', 'p-imad', 2, '12:00', '18:00', { role: 'Manager', note: 'Supplier meetings' });
  add('x8', 'p-sara', 6, '16:00', '00:00');
  add('x9', 'p-jon', 4, '19:00', '02:00');
  return backend;
}

// ---------- team ----------

function team(user) {
  const backend = teamBackend({ user });
  const manager = ['admin', 'manager'].includes(user.role);
  const extra = (id, name, role, jobTitle, department, employment, start, done) => ({
    id, name, display_name: name, preferred_name: name, email: manager ? `${name.split(' ')[0].toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}@harbourroom.example` : null, role, active: true,
    job_title: jobTitle, department, employment_type: manager ? employment : null, start_date: manager ? start : null, phone: null, phone_visibility: 'managers_only', preferred_language: 'Icelandic',
    can_view_sensitive: manager, can_edit_profile: manager, can_manage_access: manager, can_manage_training: manager, emergency_contacts: [], emergency_contact_count: 0,
    training: manager ? { private: false, total_required: 3, completed_required: done, percent: Math.round((done / 3) * 100), complete: done === 3, tasks: [] } : { private: true },
    profile_completion_percent: manager ? 75 : null, manager_notes: null
  });
  const handler = async (entry) => {
    const result = await backend.handler(entry);
    if (result?.workspace?.profiles) {
      const profiles = result.workspace.profiles;
      const gunnar = profiles.find((row) => row.id === GUNNAR_ID);
      if (gunnar) gunnar.phone = gunnar.can_view_sensitive ? '+354 000 0144' : gunnar.phone;
      const owner = profiles.find((row) => row.id === USERS.admin.id);
      if (owner) owner.job_title = 'Owner & general manager';
      profiles.splice(3, 0,
        extra(DAGUR_ID, PEOPLE_NAMES.dagur, 'manager', 'Bar manager', 'management', 'full_time', '2024-09-01', 3),
        extra(ELIN_ID, PEOPLE_NAMES.elin, 'bartender', 'Floor & bar', 'floor', 'part_time', '2025-11-03', 1));
      result.workspace.summary.active_profiles = profiles.filter((row) => row.active).length;
      if (manager) result.workspace.summary.managers = profiles.filter((row) => ['admin', 'manager'].includes(row.role)).length;
    }
    return result;
  };
  return handler;
}

// ---------- knowledge ----------

const ARTICLE_CONTENT = {
  'k-opening': '# Before doors open\n\nOpening takes about **45 minutes**. Start at 16:15 for a 17:00 opening.\n\n## Steps\n\n1. Switch on the POS, card terminals and the service tablet.\n2. Count the cash float and sign the float sheet.\n3. Check ice production and fill the service wells.\n4. Cut fresh citrus and prepare garnish trays.\n5. Polish and stock glassware at every station.\n6. Log the fridge temperatures in Operations.\n\n## Before you unlock\n\n- [ ] Music and lighting set to the evening scene\n- [ ] Toilets and guest areas checked\n- [ ] Opening checklist complete in Atlas\n\n> If anything is missing or broken, post it in **#operations** so the manager on duty sees it.',
  'k-standards': '# Cocktail standards\n\nEvery drink leaves the bar looking and tasting the same, whoever made it.\n\n## Measuring\n\n- Always use a jigger. No free pouring.\n- Citrus is squeezed fresh each day.\n\n## Ice\n\n- Shake with fresh cubed ice, serve on fresh ice.\n- Stirred drinks go over one large cube.\n\n## Garnish\n\nFollow the recipe card in **Recipes**. Express citrus peel over the glass, then place it.\n\n> Taste with a straw before serving if you are unsure.',
  'k-closing': '# Closing the bar\n\nStart the close after last orders at 00:30.\n\n## Steps\n\n1. Close and reconcile the register.\n2. Record waste in Inventory.\n3. Clean stations, tools and work surfaces.\n4. Secure alcohol and high-value stock.\n5. Post a short handover in **#shift-handover**.\n\n> Ask the manager on duty if the till does not balance.',
  'k-allergens': '# Allergens at the bar\n\nKnow which drinks contain egg white, nuts, dairy or gluten, and always check before you answer.\n\n- Whiskey Sour: egg white (vegan version uses aquafaba)\n- Espresso Martini: may contain traces of nuts from the syrup\n\n> If you are not sure, say so and ask the manager.',
  'k-complaint': '# Handling a complaint\n\nListen, apologise, fix, follow up.\n\n1. Listen without interrupting.\n2. Apologise and thank the guest.\n3. Offer a fix you can deliver now.\n4. Tell the manager on duty.',
  'k-wine': '# Wine service\n\nDraft. How we pour, present and store wine by the glass.'
};

function knowledge(user) {
  const manager = ['admin', 'manager'].includes(user.role);
  const categories = [
    { id: 'cat-open', key: 'opening-closing', name: 'Opening & closing', icon: 'door-open', article_count: 2 },
    { id: 'cat-service', key: 'service', name: 'Service', icon: 'glass-water', article_count: 3 },
    { id: 'cat-safety', key: 'health-safety', name: 'Health & safety', icon: 'shield-check', article_count: 1 }
  ];
  const article = (id, key, title, summary, cat, type, extra = {}) => ({ id, article_key: key, title, summary, category_key: cat.key, category_name: cat.name, category_id: cat.id, article_type: type, status: 'published', required: false, target_roles: ['all'], published_version_number: 1, updated_at: iso(-10), published_at: iso(-10), source_count: 0, ...extra });
  const [open, service, safety] = categories;
  const articles = [
    article('k-opening', 'opening-the-bar', 'Opening the bar', 'Everything to do between 16:15 and doors at 17:00.', open, 'sop', { required: true, required_due: user.role !== 'admin', acknowledged: user.role === 'admin', published_version_number: 3, updated_at: iso(-1.2), published_at: iso(-1.2), source_count: 1 }),
    article('k-closing', 'closing-the-bar', 'Closing the bar', 'Step by step close, cash-up and handover.', open, 'sop', { required: true, required_due: false, acknowledged: true, published_version_number: 2, updated_at: iso(-6), published_at: iso(-6), source_count: 1 }),
    article('k-standards', 'cocktail-standards', 'Cocktail standards', 'Measuring, ice, garnish and tasting — how every drink should leave the bar.', service, 'training', { required: true, required_due: user.role !== 'admin', acknowledged: user.role === 'admin', published_version_number: 2, updated_at: iso(-3), published_at: iso(-3) }),
    article('k-complaint', 'guest-complaint', 'Handling a complaint', 'Listen, apologise, fix, follow up.', service, 'policy', { updated_at: iso(-23), published_at: iso(-23) }),
    article('k-allergens', 'allergens', 'Allergens at the bar', 'Which drinks contain what, and how to answer guests.', safety, 'training', { required: true, required_due: false, acknowledged: true, published_version_number: 3, updated_at: iso(-35), published_at: iso(-35), source_count: 2 }),
    ...(manager ? [article('k-wine', 'wine-service', 'Wine service', 'Draft: pouring, presenting and storing wine by the glass.', service, 'sop', { status: 'draft', draft_available: true, target_roles: ['bartender'], display_version_number: 1, published_version_number: null, updated_at: iso(-0.8), published_at: null })] : [])
  ];
  const detail = (id) => {
    const found = articles.find((entry) => entry.id === id);
    if (!found) return null;
    const draft = found.status === 'draft';
    return {
      article: { ...found },
      version: { id: `${id}-v`, state: draft ? 'draft' : 'published', version_number: found.published_version_number || 1, title: found.title, summary: found.summary, content: ARTICLE_CONTENT[id] || '', published_at: found.published_at, updated_at: found.updated_at, change_note: id === 'k-opening' ? 'Added the temperature log step' : 'Clarified the garnish step' },
      sources: id === 'k-opening' ? [{ id: 'src1', source_type: 'google_drive', source_label: 'Opening procedure (Drive)', source_reference: 'doc-1', source_url: manager ? 'https://drive.example/opening' : undefined, source_version: 'rev 7', connection_status: 'manual_reference', visible_to_staff: true }] : [],
      acknowledgements: manager ? [{ user_label: PEOPLE_NAMES.gunnar, user_role: 'bartender', acknowledged_at: iso(-0.9) }, { user_label: PEOPLE_NAMES.dagur, user_role: 'manager', acknowledged_at: iso(-1) }] : [],
      version_history: manager ? [{ version_number: 3, title: found.title, state: 'published', published_at: iso(-1.2), change_note: 'Added the temperature log step' }, { version_number: 2, title: found.title, state: 'superseded', published_at: iso(-40), change_note: 'New opening time' }, { version_number: 1, title: found.title, state: 'superseded', published_at: iso(-120) }] : [],
      task_links: [], read: false, can_acknowledge: Boolean(found.required && found.required_due)
    };
  };
  const snapshot = () => ({
    workspace: {
      categories, articles,
      summary: { published_articles: articles.filter((entry) => entry.status === 'published').length, required_due: articles.filter((entry) => entry.required_due).length, acknowledged: articles.filter((entry) => entry.acknowledged).length, source_references: 3 },
      training: {
        tasks: [
          { id: 'task-1', title: 'Bar tour', description: 'Walk through stations and storage.', category: 'Service', required: true, completed: true, completed_at: iso(-200), linked_articles: [] },
          { id: 'task-2', title: 'Opening procedure', description: 'Open the bar with a manager.', category: 'Operations', required: true, completed: true, completed_at: iso(-150), linked_articles: [{ article_id: 'k-opening', title: 'Opening the bar' }] },
          { id: 'task-3', title: 'Cocktail standards tasting', description: 'Make the six house classics for a manager.', category: 'Service', required: true, completed: false, linked_articles: [{ article_id: 'k-standards', title: 'Cocktail standards' }] }
        ],
        own_progress: { required_total: 3, required_completed: 2 },
        team: manager ? [{ name: PEOPLE_NAMES.sara, role: 'bartender', required_total: 3, required_completed: 2 }, { name: PEOPLE_NAMES.gunnar, role: 'bartender', required_total: 3, required_completed: 3 }, { name: PEOPLE_NAMES.elin, role: 'bartender', required_total: 3, required_completed: 1 }] : []
      },
      settings: { google_drive_connection_status: 'not_connected' },
      events: manager ? [{ event_type: 'version_published', actor_label: PEOPLE_NAMES.owner, created_at: iso(-1.2) }, { event_type: 'article_acknowledged', actor_label: PEOPLE_NAMES.gunnar, created_at: iso(-0.9) }] : [],
      permissions: { can_manage_articles: manager }
    },
    staff: { id: user.id, role: user.role, can_manage_knowledge: manager },
    onboarding_tasks: [{ id: 'task-1', title: 'Bar tour', category: 'Service' }, { id: 'task-2', title: 'Opening procedure', category: 'Operations' }, { id: 'task-3', title: 'Cocktail standards tasting', category: 'Service' }]
  });
  return async (entry) => {
    const params = new URLSearchParams(entry.search);
    if (entry.method === 'GET' && entry.action === 'snapshot') return snapshot();
    if (entry.method === 'GET' && entry.action === 'detail') {
      const found = detail(params.get('article_id'));
      return found ? { article: found, staff: snapshot().staff } : { __status: 404, body: { error: 'Knowledge article not found.' } };
    }
    if (entry.method === 'GET' && entry.action === 'search') {
      const q = (params.get('q') || '').toLowerCase();
      const results = articles.filter((a) => (manager || a.status === 'published') && `${a.title} ${a.summary}`.toLowerCase().includes(q))
        .map((a) => ({ article_id: a.id, title: a.title, category: a.category_name, required: a.required, status: a.status, version_state: a.status === 'draft' ? 'draft' : 'published', snippet: `${a.title} — ${a.summary}` }));
      return { results, count: results.length, query: params.get('q') };
    }
    if (entry.action === 'mark-read') return { result: { ok: true } };
    return { result: { ok: true }, ...snapshot(), detail: entry.body?.article_id ? detail(entry.body.article_id) : null };
  };
}

// ---------- reports & marketing ----------

function reports() {
  return (entry) => {
    const params = new URL(`http://x${entry.search}`).searchParams;
    const result = reportsSnapshot({
      preset: params.get('preset') || 'last_30_days',
      start: params.get('start_date') || '2026-08-26',
      end: params.get('end_date') || '2026-09-24',
      comparison: params.get('comparison') === 'none' ? null : { start: params.get('comparison_start_date') || '2026-07-27', end: params.get('comparison_end_date') || '2026-08-25' }
    });
    const w = result.workspace;
    w.kpis = [
      { key: 'purchasing_spend', label: 'Purchasing spend', value: 412300, unit: 'ISK', section: 'purchasing', status: 'connected', change_value: 44100, change_percent: 12, trend: 'up', detail: '' },
      { key: 'stock_value', label: 'Stock value', value: 386400, unit: 'ISK', section: 'inventory', status: 'partial', change_value: -12800, change_percent: -3, trend: 'down', detail: '' },
      { key: 'waste', label: 'Waste', value: 7480, unit: 'ISK', section: 'waste', status: 'connected', change_value: -1200, change_percent: -14, trend: 'down', detail: '' },
      { key: 'scheduled_hours', label: 'Scheduled hours', value: 168.5, unit: 'hours', section: 'labour', status: 'connected', change_value: 6, change_percent: 4, trend: 'up', detail: '' }
    ];
    w.sections = w.sections.map((section) => (section.key === 'waste' ? { ...section, status: 'connected' } : section));
    w.attention = [
      { title: 'Olmeca Blanco Tequila is out of stock', detail: 'Margarita can’t be served until the Northwind order arrives.', section: 'inventory', tone: 'danger', source: 'Stock' },
      { title: 'Campari is almost out', detail: '1 of 4 bottles left. It is on the order waiting for approval.', section: 'inventory', tone: 'warn', source: 'Stock' },
      { title: 'Northwind delivery is 2 days late', detail: 'Buffalo Trace Bourbon and 2 Absolut Vodka are still to come.', section: 'purchasing', tone: 'warn', source: 'Purchasing' }
    ];
    w.data_sources[0] = { key: 'inventory', name: 'Stock counts', status: 'partial', note: '25 of 26 items counted this week', records_included: 25, records_excluded: 1, last_refreshed_at: MANUAL_NOW };
    w.reports.inventory = {
      summary: { active_items: 26, current_items: 25, estimated_value: 386400, known_value: 386400, below_par: 5, out_of_stock: 1, needs_current_count: 1, missing_cost: 0 },
      categories: [
        { category: 'Whiskey', estimated_value: 28600 }, { category: 'Gin', estimated_value: 12600 }, { category: 'Beer', estimated_value: 30330 }, { category: 'Wine', estimated_value: 34200 },
        { category: 'Aperitif', estimated_value: 10500 }, { category: 'Vodka', estimated_value: 20500 }, { category: 'Akvavit', estimated_value: 18400 }, { category: 'Mixer', estimated_value: 23640 }
      ],
      rows: items.filter((row) => row.active).slice(0, 12).map((row) => {
        const found = balances.find((entry) => entry.inventory_item_id === row.id);
        const quantity = found?.verified_quantity ?? null;
        return { id: row.id, name: row.name, category: row.category, unit: row.unit, quantity, par_level: row.par_level, cost_price: row.cost_price, estimated_value: quantity == null ? null : quantity * row.cost_price, status: quantity === 0 ? 'out_of_stock' : quantity < row.par_level ? 'below_par' : 'in_stock', last_counted_at: found?.verified_at };
      })
    };
    w.reports.waste = { summary: { recorded_waste_count: 4, estimated_waste_value: 7480 }, rows: [
      { id: 'w1', created_at: iso(-1.2), item_name: 'Limes', movement_type: 'waste', quantity_change: -6, estimated_value: 360, note: 'Spoilage: soft limes' },
      { id: 'w2', created_at: iso(-0.9), item_name: 'Fresh mint', movement_type: 'waste', quantity_change: -1, estimated_value: 450, note: 'Spoilage: wilted' },
      { id: 'w3', created_at: iso(-3.5), item_name: 'Campari', movement_type: 'waste', quantity_change: -1, estimated_value: 3900, note: 'Breakage' }
    ] };
    return result;
  };
}

function marketing() {
  return () => {
    const result = marketingWorkspace();
    const w = result.workspace;
    w.stats = { total_items: 5, drafts: 2, awaiting_approval: 1, overdue_reminders: 0, published: 2, completed: 0 };
    w.content_items.push(
      { id: 'c4', title: 'Espresso Martini Thursday', content_type: 'post', status: 'draft', platforms: ['instagram'], scheduled_for: '2026-10-01T16:00:00.000Z', reminder_at: null, can_edit: true, can_approve: true, created_by_label: PEOPLE_NAMES.dagur, caption_draft: 'Thursdays are for Espresso Martinis.' },
      { id: 'c5', title: 'Behind the bar: Northern Lights', content_type: 'reel', status: 'published', platforms: ['instagram', 'facebook'], scheduled_for: '2026-09-18T18:00:00.000Z', can_edit: false, can_approve: false, created_by_label: PEOPLE_NAMES.sara }
    );
    w.content_items[0].created_by_label = PEOPLE_NAMES.dagur;
    return result;
  };
}

// ---------- Atlas AI ----------

// The pinned demo conversation, restaged on the Harbour Room's own records:
// the answer cites only the verified counts and the recipe it used, and
// mentions the Campari that is already on the Northwind order waiting for
// approval. No sales figure appears anywhere (no till system is connected).
const AI_ANSWER = 'Yes. Campari is what limits you: one bottle left, which makes about 33 Negronis. It is already on the Northwind order waiting for approval, so approve it and mark it as ordered before Northwind’s 18:00 cut-off.\n\nTanqueray is below par too (3 of 6) and isn’t on any open order, so I’ve prepared a draft order for two cases.';
const AI_EVIDENCE = [
  { kind: 'fact', label: 'Campari on hand', value: '1 bottle (1 L)', source: { type: 'stock_count', id: null, label: 'Count · Tue 22 Sep', route: null } },
  { kind: 'calculation', label: 'Negronis from one bottle', value: '1,000 ml ÷ 30 ml ≈ 33', source: { type: 'recipe', id: RECIPE_IDS.negroni, label: 'Recipe · Negroni', route: null } },
  { kind: 'fact', label: 'Tanqueray on hand', value: '3 bottles · par 6', source: { type: 'stock_count', id: null, label: 'Count · Tue 22 Sep', route: null } },
  { kind: 'fact', label: 'Martini Rosso on hand', value: '4 bottles · par 3', source: { type: 'stock_count', id: null, label: 'Count · Tue 22 Sep', route: null } }
];
const AI_RECORDS = [
  { type: 'inventory_item', id: ID.campari, label: 'Campari', route: `#inventory/item/${ID.campari}` },
  { type: 'inventory_item', id: ID.tanq, label: 'Tanqueray London Dry', route: `#inventory/item/${ID.tanq}` },
  { type: 'recipe', id: RECIPE_IDS.negroni, label: 'Negroni', route: `#recipes/${RECIPE_IDS.negroni}` },
  { type: 'supplier', id: S.globus, label: 'Northwind', route: '#purchasing/suppliers' }
];
function aiMessages() {
  const [question, answer] = negroniMessages();
  const proposal = orderProposal({
    title: 'Order from Northwind',
    // Proposals expire 24 hours after Atlas prepares them (16:27 today).
    expires_at: '2026-09-25T16:27:00.000Z',
    preview: {
      headline: 'Draft purchase order for Northwind',
      lines: [{ label: 'Tanqueray London Dry 1 L', detail: '12 bottles × 4.200 kr = 50.400 kr' }],
      totals: { lines: 1, estimated_total: 50400, estimated_total_label: '50.400 kr' },
      recipients: [],
      will_change: ['A new purchase order is saved in Purchasing with status Draft.'],
      will_not_change: ['The order is not placed or sent to the supplier.', 'Stock and item costs do not change.'],
      route: '#purchasing'
    }
  });
  return [
    { ...question, content: 'Can we make Negronis tonight? Is anything for them running low?' },
    { ...answer, content: AI_ANSWER, evidence: AI_EVIDENCE, records: AI_RECORDS, proposals: [proposal] }
  ];
}

function atlasAi() {
  const ai = atlasAiBackend({ messages: aiMessages, overrides: { conversations: (entry, state) => {
    const found = state.conversations.find((row) => row.id === AI_IDS.convNegroni);
    if (found) found.title = 'Negronis tonight';
    const paloma = state.conversations.find((row) => row.id === AI_IDS.convPaloma);
    if (paloma) paloma.title = 'Cost of an Espresso Martini';
    return undefined;
  } } });
  return async (entry) => {
    if (entry.action === 'settings') return { enabled: true, configured: true, key_present: true, media_retention_days: 30, audio_retention: 'delete_after_transcription', daily_turn_limit_per_user: 200, voice_sessions_per_day: 20, voice_minutes_per_day: 60, max_concurrent_voice_sessions: 1, upload_bytes_per_day: 262144000, upload_files_per_day: 100, updated_at: '2026-09-20T10:00:00Z', can_edit: ['admin', 'manager'].includes(entry.user.role) };
    if (entry.action === 'preferences') return { reply_length: 'normal', speak_answers: false, voice_enabled: true, language: 'auto', stored: true };
    return ai.handler(entry);
  };
}

function decisions() {
  const base = decisionsBackend();
  return () => {
    const result = base();
    // Stock evidence only: the demo venue has no sales data to rank drinks by.
    result.snapshot.recommendations.forEach((row) => { if (row.id === 'r-1') row.summary = 'One bottle left against a par of 4; the Negroni needs it.'; });
    result.snapshot.recommendations.push(
      { id: 'r-2', title: 'Raise the Fever-Tree Tonic par to 96', summary: 'You ran below par three Fridays in a row; a higher par covers the weekend.', recommendation_type: 'stock', status: 'active', generated_by: 'atlas-ai', evidence: [{ label: 'Fridays below par', value: { weeks: 3 } }], updated_at: iso(-0.3) }
    );
    return result;
  };
}

// ---------- par levels (Data › Par levels) ----------

// Usage evidence from verified counts for the demo items: most have enough
// counts for a suggestion, a few new ones do not yet.
const USAGE = { [ID.campari]: 0.6, [ID.aperol]: 0.55, [ID.tanq]: 0.8, [ID.vodka]: 0.5, [ID.tonic]: 9.5, [ID.limes]: 6.2, [ID.prosecco]: 1.6, [ID.ale]: 6.8, [ID.lager]: 7.4, [ID.mint]: 0.7 };
function parEvidence(cover = null) {
  const shown = items.filter((row) => row.active && [ID.campari, ID.aperol, ID.tanq, ID.vodka, ID.tonic, ID.limes, ID.prosecco, ID.ale, ID.lager, ID.mint, ID.brennivin, ID.coffee].includes(row.id));
  return {
    generated_at: MANUAL_NOW,
    rule: { min_observations: 3, min_span_days: 14, window_days: 120, sources: ['verified_count', 'owner_confirmation'] },
    items: shown.map((row, index) => {
      const avg = USAGE[row.id] ?? null;
      const eligible = avg != null;
      const par = eligible && cover ? Math.ceil(avg * cover) : null;
      const found = balances.find((entry) => entry.inventory_item_id === row.id);
      return {
        item_id: row.id, name: row.name, category: row.category, unit: row.unit, par_level: row.par_level, critical_minimum: null,
        units_per_case: row.units_per_case || null, updated_at: row.updated_at, verified_quantity: found?.verified_quantity ?? null, quantity: found?.verified_quantity ?? null,
        observations: eligible ? 6 : 2, span_days: eligible ? 42 : 9, avg_daily_usage: avg, eligible, reason: eligible ? null : 'insufficient_observations',
        evidence: [], intervals: [], evidence_digest: `manual-${index}`,
        suggestion: par ? { cover_days: cover, par_level: par, cases: row.units_per_case ? Math.ceil(par / row.units_per_case) : null, saved: false } : null
      };
    })
  };
}

// ---------- the world ----------

/**
 * The guide's demo venue as launchAtlas fixtures for `user` (DEMO_USERS.*).
 * One world serves every page, so names and numbers agree across chapters.
 * `countStatus` sets the state of the in-progress back-bar count (draft, finishing, submitted or verified).
 */
export function manualWorld(user = DEMO_USERS.admin, { countStatus = 'draft' } = {}) {
  const base = compositeWorld(user, { group: 'INV' });
  const counts = countBackend({ status: countStatus === 'finishing' ? 'draft' : countStatus });
  if (countStatus === 'finishing') {
    // Near the end of the back-bar count: most lines counted (Giffard well
    // under its last verified 3), Angostura skipped, limes still to count.
    const plan = {
      [ID.campari]: ['counted', 1, PEOPLE_NAMES.sara], [ID.tanq]: ['counted', 3, PEOPLE_NAMES.sara], [ID.aperol]: ['counted', 2, PEOPLE_NAMES.sara],
      [ID.giffard]: ['counted', 1, PEOPLE_NAMES.sara], [ID.ango]: ['skipped', null, null], [ID.limes]: ['pending', null, null]
    };
    counts.lines.forEach((row) => {
      const [status, quantity, by] = plan[row.inventory_item_id] || ['pending', null, null];
      Object.assign(row, { line_status: status, observed_quantity: quantity, observed_input_quantity: quantity, counted_by_label: by, skipped_reason: status === 'skipped' ? 'Couldn’t reach it' : null });
    });
  } else if (countStatus !== 'draft') {
    // A finished count: every line counted, with two believable differences.
    const observed = { [ID.campari]: 1, [ID.tanq]: 3, [ID.aperol]: 2, [ID.ango]: 1, [ID.giffard]: 2, [ID.limes]: 10 };
    counts.lines.forEach((row) => Object.assign(row, { line_status: 'counted', observed_quantity: observed[row.inventory_item_id], observed_input_quantity: observed[row.inventory_item_id], counted_by_label: row.inventory_item_id === ID.limes ? PEOPLE_NAMES.gunnar : PEOPLE_NAMES.sara }));
  }
  const purchasing = purchasingBackend({ list: orders() });
  const recognition = recognitionBackend();
  const countCatalog = items.filter((row) => row.active).map((row) => {
    const found = balances.find((entry) => entry.inventory_item_id === row.id);
    return { id: row.id, name: row.name, category: row.category, unit: row.unit, par_level: row.par_level, bin_location: row.bin_location, verified_quantity: found?.verified_quantity ?? null, verified_at: found?.verified_at ?? null };
  });
  // Earlier counts, so the Counts tab shows a believable history.
  const history = [
    { id: uuid(801), title: 'Fridges count', scope_type: 'location', scope_value: 'Walk-in fridge', status: 'verified', started_at: iso(-2.2), verified_at: iso(-2), started_by_label: PEOPLE_NAMES.gunnar, summary: { total_lines: 5, counted_lines: 5, skipped_lines: 0, pending_lines: 0, negative_variances: 1, positive_variances: 0 } },
    { id: uuid(802), title: 'Store room count', scope_type: 'location', scope_value: 'Store room', status: 'verified', started_at: iso(-9), verified_at: iso(-8.9), started_by_label: PEOPLE_NAMES.elin, summary: { total_lines: 6, counted_lines: 6, skipped_lines: 0, pending_lines: 0, negative_variances: 0, positive_variances: 1 } },
    { id: uuid(803), title: 'Beer fridge count', scope_type: 'location', scope_value: 'Beer fridge', status: 'cancelled', started_at: iso(-10), started_by_label: PEOPLE_NAMES.sara, summary: { total_lines: 2, counted_lines: 0, skipped_lines: 0, pending_lines: 2, negative_variances: 0, positive_variances: 0 } }
  ];
  const stockCounts = (entry) => {
    const result = counts.handler(entry);
    if (result?.counts) result.counts = { ...result.counts, sessions: [...(result.counts.sessions || []), ...history], verified_balances: balances, catalog: countCatalog };
    return result;
  };
  const settings = base.functions['atlas-settings'];
  const venueDetails = { registration_number: '', location_label: 'Reykjavík', address_line: 'Pier 3, Old Harbour', city: 'Reykjavík', country_code: 'IS', email: 'hello@harbourroom.example', phone: '+354 000 0100', website: 'https://harbourroom.example', booking_url: 'https://harbourroom.example/book' };
  const functions = {
    ...base.functions,
    'atlas-settings': async (entry) => {
      const result = await settings(entry);
      const venue = result?.workspace?.sections?.find((section) => section.section_key === 'venue');
      if (venue) venue.value = { ...venueDetails, ...venue.value };
      if (result?.workspace?.profiles_summary) result.workspace.profiles_summary = { total: 7, active: 6, inactive: 1, roles: { admin: 1, manager: 1, bartender: 3, viewer: 1 } };
      return result;
    },
    'atlas-stock-counts': stockCounts,
    'atlas-inventory-recognition': recognition.handler,
    'atlas-team-messages': messages(user).handler,
    'atlas-shifts': shifts(user).handler,
    'atlas-team-profiles': team(user),
    'atlas-knowledge': knowledge(user),
    'atlas-team-profile-photos': { photos: PHOTOS, staff: { id: user.id, can_manage_team: ['admin', 'manager'].includes(user.role) } },
    'atlas-reports': reports(),
    'atlas-marketing-workspace': marketing(),
    'atlas-ai': atlasAi(),
    'atlas-phase3-brain': decisions(),
    // Integrations as a venue sees them before anything is connected: the
    // providers Atlas offers, none of them connected yet.
    'atlas-integrations': async (entry) => {
      const result = await base.functions['atlas-integrations'](entry);
      if (result?.providers) {
        result.providers = result.providers.map((provider) => (provider.connection_state === 'connected'
          ? { provider_key: provider.provider_key, label: provider.label, auth_kind: provider.auth_kind, connection_state: 'ready', configured: true, can_connect: true, can_save_api_key: false, can_test: false, can_disconnect: false, missing_requirements: [], scopes_granted: [] }
          : provider));
      }
      return result;
    }
  };
  const tables = {
    ...base.tables,
    inventory_items: items,
    inventory_catalog: items.map(({ cost_price, supplier_id, ...rest }) => rest),
    inventory_movements: movements,
    inventory_movement_catalog: movements,
    recipes,
    recipe_catalog: recipes,
    suppliers,
    recipe_categories: [],
    import_batches: () => importBatches,
    ...purchasing.tables
  };
  const rpc = { ...base.rpc, ...purchasing.rpc, atlas_par_level_evidence: (body) => parEvidence(body?.p_cover_days) };
  const wrap = (map) => Object.fromEntries(Object.entries(map).map(([key, value]) => [key, typeof value === 'function' ? renamed(value) : rename(value)]));
  return {
    tables: wrap(tables),
    rpc: wrap(rpc),
    functions: wrap(functions),
    writes: base.writes,
    profiles: [DEMO_USERS.admin, DEMO_USERS.bartender, DEMO_USERS.viewer,
      { id: GUNNAR_ID, email: 'gunnar@harbourroom.example', display_name: PEOPLE_NAMES.gunnar, role: 'bartender', active: true },
      { id: ELIN_ID, email: 'elin@harbourroom.example', display_name: PEOPLE_NAMES.elin, role: 'bartender', active: true },
      { id: DAGUR_ID, email: 'dagur@harbourroom.example', display_name: PEOPLE_NAMES.dagur, role: 'manager', active: true }],
    backends: { counts, purchasing, recognition }
  };
}
