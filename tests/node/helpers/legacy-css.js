// S88 split the retired override stylesheets into per-module fragments
// (apps/web/assets/css/legacy/<source>--<module>.css), linked consecutively at
// the source's old position. Tests that pin rules of a retired stylesheet read
// its fragments through these helpers, in cascade (link) order.
import { readFileSync, readdirSync } from 'node:fs';

const WEB = 'apps/web';
const LEGACY = `${WEB}/assets/css/legacy`;

export function stylesheetHrefs() {
  const index = readFileSync(`${WEB}/index.html`, 'utf8');
  return [...index.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((match) => match[1].split('?')[0]);
}

export function legacyFragments(source) {
  const files = readdirSync(LEGACY).filter((name) => name.startsWith(`${source}--`) && name.endsWith('.css'));
  const order = stylesheetHrefs();
  return files
    .map((name) => `assets/css/legacy/${name}`)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** The concatenated rules that used to live in assets/css/<source>.css. */
export function legacyCss(source) {
  const files = legacyFragments(source);
  if (!files.length) throw new Error(`no legacy fragments for ${source}`);
  return files.map((file) => readFileSync(`${WEB}/${file}`, 'utf8')).join('\n');
}

/** Position of a stylesheet (or of the first/last fragment of a retired one) in index.html. */
export function linkPosition(nameOrSource, which = 'first') {
  const order = stylesheetHrefs();
  const direct = order.indexOf(`assets/css/${nameOrSource}`);
  if (direct >= 0) return direct;
  const fragments = legacyFragments(nameOrSource).map((file) => order.indexOf(file)).filter((i) => i >= 0);
  if (!fragments.length) return -1;
  return which === 'last' ? Math.max(...fragments) : Math.min(...fragments);
}

/** The cascade layer a stylesheet's rules are in (first @layer block), or null. */
export function layerOf(relPath) {
  const text = readFileSync(`${WEB}/assets/css/${relPath}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return text.match(/@layer\s+([\w.-]+)\s*\{/)?.[1] ?? null;
}
