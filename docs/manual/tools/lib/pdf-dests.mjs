// Reads named destinations (in-page link targets) from a Chromium-generated
// PDF and returns { id: pageNumber } (1-based). Used for the two-pass table of
// contents: Chromium writes a named destination for every element an
// <a href="#id"> points at. Zero dependencies: Chromium's PDF writer keeps the
// catalog, page tree and destination dictionary as plain (uncompressed)
// objects; only content streams are compressed.

function decodeName(name) {
  return name.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeLiteral(str) {
  return str.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => {
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    return map[e] ?? String.fromCharCode(parseInt(e, 8));
  });
}

export function parseObjects(text) {
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\b([\s\S]*?)\bendobj/g;
  let m;
  while ((m = re.exec(text))) {
    let body = m[2];
    const stream = body.indexOf('stream');
    if (stream !== -1) body = body.slice(0, stream); // dictionary only
    objects.set(Number(m[1]), body);
  }
  return objects;
}

function pageOrder(objects) {
  let catalog = null;
  for (const body of objects.values()) if (/\/Type\s*\/Catalog\b/.test(body)) { catalog = body; break; }
  if (!catalog) throw new Error('PDF catalog not found');
  const root = Number(catalog.match(/\/Pages\s+(\d+)\s+0\s+R/)[1]);
  const pages = [];
  const walk = (num, guard = 0) => {
    const body = objects.get(num) || '';
    if (guard > 64) return;
    if (/\/Type\s*\/Pages\b/.test(body)) {
      const kids = body.match(/\/Kids\s*\[([^\]]*)\]/);
      if (kids) for (const k of kids[1].matchAll(/(\d+)\s+0\s+R/g)) walk(Number(k[1]), guard + 1);
    } else if (/\/Type\s*\/Page\b/.test(body)) pages.push(num);
  };
  walk(root);
  return { catalog, pages };
}

/** Returns a Map of destination name -> 1-based page number. */
export function namedDestinations(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  const objects = parseObjects(text);
  const { catalog, pages } = pageOrder(objects);
  const pageIndex = new Map(pages.map((num, k) => [num, k + 1]));
  const sources = [];
  // /Dests either inline in the catalog or as a referenced dictionary
  const ref = catalog.match(/\/Dests\s+(\d+)\s+0\s+R/);
  if (ref) sources.push(objects.get(Number(ref[1])) || '');
  else {
    const inline = catalog.match(/\/Dests\s*<<([\s\S]*)>>/);
    if (inline) sources.push(inline[1]);
  }
  // or a /Names name tree (strings as keys): scan every /Names array
  for (const body of objects.values()) if (/\/Names\s*\[/.test(body) && !/\/Type\s*\/Catalog/.test(body)) sources.push(body);
  const out = new Map();
  for (const src of sources) {
    for (const m of src.matchAll(/\/([^\s/[\]<>()]+)\s*\[\s*(\d+)\s+0\s+R/g)) {
      const page = pageIndex.get(Number(m[2]));
      if (page) out.set(decodeName(m[1]), page);
    }
    for (const m of src.matchAll(/\(((?:\\.|[^\\)])*)\)\s*\[\s*(\d+)\s+0\s+R/g)) {
      const page = pageIndex.get(Number(m[2]));
      if (page) out.set(decodeLiteral(m[1]), page);
    }
  }
  return { dests: out, pageCount: pages.length };
}
