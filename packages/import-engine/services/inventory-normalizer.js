import {
  canonicalKey,
  canonicalText,
  cleanText,
  normalizeIdentifier,
  slug,
} from '../utils/canonicalize.js';

const HEADER_ALIASES = new Map(Object.entries({
  item: 'name',
  'item name': 'name',
  product: 'name',
  'product name': 'name',
  category: 'category',
  subcategory: 'subcategory',
  unit: 'unit',
  size: 'unit',
  'package size': 'unit',
  qty: 'quantity',
  quantity: 'quantity',
  'qty in stock': 'quantity',
  stock: 'quantity',
  supplier: 'supplier',
  vendor: 'supplier',
  sku: 'sku',
  barcode: 'barcode',
  cost: 'costPrice',
  'cost price': 'costPrice',
  'net cost': 'costPrice',
  'last updated': 'lastUpdated',
}));

const CATEGORY_ALIASES = new Map(Object.entries({
  liquen: 'Liqueur',
  liqueurs: 'Liqueur',
  syrup: 'Syrups',
  syrups: 'Syrups',
  'beer cider': 'Beer & Cider',
  'beer and cider': 'Beer & Cider',
  'beer cider keg': 'Beer & Cider (Keg)',
  'soda mixer': 'Soda & Mixer',
  'vermouth aperitivo': 'Vermouth / Aperitivo',
  'tequila mezcal': 'Tequila / Mezcal',
  'whiskey cognac': 'Whiskey / Cognac',
  'puree fresh': 'Purée & Fresh',
  'leaves fresh': 'Fresh Herbs',
  'fresh fruit': 'Fresh Fruit',
}));

export function canonicalHeader(value) {
  const key = canonicalText(value);
  return HEADER_ALIASES.get(key) || key.replace(/\s+(.)/g, (_, character) => character.toUpperCase());
}

export function normalizeCategory(value) {
  const clean = cleanText(value);
  if (!clean) return null;
  return CATEGORY_ALIASES.get(canonicalText(clean)) || clean;
}

export function parseNumber(value) {
  if (value === null || value === undefined || value === '') {
    return { value: null, issue: null };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { value, issue: null }
      : { value: null, issue: 'not_a_number' };
  }

  const raw = cleanText(value);
  const match = raw.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) return { value: null, issue: 'unparsed_number' };
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return { value: null, issue: 'not_a_number' };
  const remainder = raw.replace(match[0], '').trim();
  return { value: parsed, issue: remainder ? `numeric_annotation:${remainder}` : null };
}

export function parseMoney(value) {
  if (value === null || value === undefined || value === '') return { value: null, issue: null };
  if (typeof value === 'number') return Number.isFinite(value)
    ? { value, issue: null }
    : { value: null, issue: 'not_a_number' };

  const raw = cleanText(value).replace(/(?:ISK|kr\.?)/gi, '').replace(/\s/g, '');
  if (!raw) return { value: null, issue: 'unparsed_money' };
  let normalized = raw;
  const comma = raw.lastIndexOf(',');
  const dot = raw.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = Math.max(comma, dot);
    normalized = raw.slice(0, decimal).replace(/[.,]/g, '') + '.' + raw.slice(decimal + 1);
  } else if (/^[+-]?\d{1,3}([.,]\d{3})+$/.test(raw)) {
    normalized = raw.replace(/[.,]/g, '');
  } else {
    normalized = raw.replace(',', '.');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed)
    ? { value: parsed, issue: null }
    : { value: null, issue: 'unparsed_money' };
}

export function parsePackage(value) {
  const raw = cleanText(value);
  if (!raw) return { label: null, quantity: null, unit: null, container: null };
  const match = canonicalText(raw).match(/^(\d+(?:[.,]\d+)?)\s*(ml|l|cl|kg|g|gr)\b(?:\s+(.*))?$/);
  if (!match) {
    const word = canonicalText(raw);
    return { label: raw, quantity: null, unit: null, container: word || null };
  }
  let quantity = Number(match[1].replace(',', '.'));
  let unit = match[2] === 'gr' ? 'g' : match[2];
  if (unit === 'l') {
    quantity *= 1000;
    unit = 'ml';
  } else if (unit === 'cl') {
    quantity *= 10;
    unit = 'ml';
  } else if (unit === 'kg') {
    quantity *= 1000;
    unit = 'g';
  }
  const container = cleanText(match[3] || '') || null;
  return {
    label: `${Number.isInteger(quantity) ? quantity : quantity.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}${unit}${container ? ` ${container}` : ''}`,
    quantity,
    unit,
    container,
  };
}

export function parseSourceDate(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  const match = raw.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return date.toISOString().slice(0, 10);
}

export function remapHeaders(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [canonicalHeader(key), value]));
}

export function normalizeInventoryRow(input, options = {}) {
  const row = remapHeaders(input);
  const issues = [];
  const name = cleanText(row.name);
  const packageInfo = parsePackage(row.unit);
  const quantity = parseNumber(row.quantity);
  const money = parseMoney(row.costPrice);
  if (!name) issues.push('missing_name');
  if (row.quantity !== undefined && quantity.issue) issues.push(quantity.issue);
  if (row.costPrice !== undefined && money.issue) issues.push(money.issue);
  if (!packageInfo.label) issues.push('missing_package');
  const sourceUpdatedAt = parseSourceDate(row.lastUpdated);
  if (row.lastUpdated && !sourceUpdatedAt) issues.push('unparsed_source_date');

  const key = canonicalKey(name, packageInfo.label);
  return {
    rawData: { ...input },
    name,
    canonicalKey: key,
    category: normalizeCategory(row.category),
    subcategory: cleanText(row.subcategory) || null,
    unit: packageInfo.label,
    packageQuantity: packageInfo.quantity,
    packageUnit: packageInfo.unit,
    packageContainer: packageInfo.container,
    quantity: quantity.value,
    costPrice: money.value,
    supplier: cleanText(row.supplier) || null,
    sku: normalizeIdentifier(row.sku),
    barcode: normalizeIdentifier(row.barcode),
    sourceUpdatedAt,
    sourceKey: [options.sourcePrefix || 'source', slug(key)].filter(Boolean).join(':'),
    issues,
  };
}
