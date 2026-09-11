// Bounded UTF-8 inventory CSV parser. Raw fields and decimal strings are preserved.
export const MAX_BYTES = 1024 * 1024;
export const MAX_ROWS = 1000;
const FIELDS = new Set(['name', 'unit', 'quantity', 'cost_price', 'category', 'sku', 'par_level']);
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(n => n.toString(16).padStart(2, '0')).join('');
}
export function parseCSV(bytes) {
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('CSV must be between 1 byte and 1 MiB.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('CSV contains a null character.');
  const records = [];
  let row = [], cell = '', quoted = false, closed = false, started = false;
  const field = () => { row.push(cell); cell = ''; closed = false; started = false; };
  const record = () => { field(); records.push(row); row = []; if (records.length > MAX_ROWS + 1) throw new Error('CSV exceeds 1,000 rows.'); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ',') field();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; record(); }
    else if (c === '"' && !started && !closed) { quoted = true; started = true; }
    else { if (closed || c === '"') throw new Error('Malformed CSV quotation.'); cell += c; started = true; }
    if (cell.length > 500) throw new Error('CSV fields must be at most 500 characters.');
  }
  if (quoted) throw new Error('Unclosed CSV quotation.');
  if (cell || row.length || started || closed) record();
  const headers = (records.shift() || []).map(h => h.trim().toLowerCase());
  if (new Set(headers).size !== headers.length || headers.some(h => !FIELDS.has(h)) ||
      ['name', 'unit', 'quantity'].some(h => !headers.includes(h))) {
    throw new Error('Use unique name, unit, quantity headers; optional: cost_price, category, sku, par_level.');
  }
  if (!records.length) throw new Error('CSV has no inventory rows.');
  const names = new Set(), skus = new Set();
  return records.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Row ${index + 1}: column count differs from the header.`);
    const raw_data = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    const value = name => raw_data[name]?.trim() || null;
    const number = (name, required, max) => {
      const v = value(name);
      if (v === null && !required) return null;
      if (v === null || !/^\d{1,10}(\.\d{1,6})?$/.test(v) || Number(v) > max) {
        throw new Error(`Row ${index + 1}: ${name} must be a non-negative decimal using a dot.`);
      }
      return v;
    };
    const name = value('name'), unit = value('unit'), sku = value('sku');
    if (!name || name.length > 160 || !unit || unit.length > 32 || (sku && sku.length > 100)) {
      throw new Error(`Row ${index + 1}: name and unit are required and must fit the field limits.`);
    }
    if (names.has(name.toLowerCase()) || (sku && skus.has(sku.toLowerCase()))) {
      throw new Error(`Row ${index + 1}: duplicate name or SKU requires review before upload.`);
    }
    names.add(name.toLowerCase()); if (sku) skus.add(sku.toLowerCase());
    return { row_number: index + 1, raw_data, normalized_data: {
      name, unit, sku, category: value('category'),
      quantity: number('quantity', true, 1000000),
      cost_price: number('cost_price', false, 1000000000),
      par_level: number('par_level', false, 1000000),
    }};
  });
}

export async function extractCSV(bytes) {
  const rows = parseCSV(bytes);
  for (const row of rows) row.source_hash = await sha256(new TextEncoder().encode(JSON.stringify(row.raw_data)));
  let binary='';
  for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return { source_hash: await sha256(bytes), source_base64: btoa(binary), extractor_version: 'atlas-csv-1', rows };
}
