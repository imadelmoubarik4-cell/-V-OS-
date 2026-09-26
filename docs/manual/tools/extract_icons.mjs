#!/usr/bin/env node
// Extracts the Lucide icons the manual uses into docs/manual/assets/icons/.
//
// Atlas loads Lucide 0.454.0 (index.html). This script reads the same version
// from a local npm install (ATLAS_BROWSER_LIBS, like tests/browser/harness.mjs,
// or a node_modules folder next to the repo) and writes one plain SVG per icon,
// plus the Lucide ISC licence. Add a name to ICONS and re-run to add an icon:
//
//   ATLAS_BROWSER_LIBS=/path/to/node_modules node docs/manual/tools/extract_icons.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const OUT = path.resolve(here, '../assets/icons');

export const ICONS = [
  // Navigation (same icons as the Atlas side bar, index.html)
  'house', 'sparkles', 'messages-square', 'clipboard-check', 'package', 'martini', 'truck',
  'calendar-days', 'users', 'book-open', 'chart-no-axes-column', 'megaphone', 'database', 'settings',
  // Shell
  'search', 'bell', 'plus', 'panel-left', 'chevron-down', 'chevron-left', 'chevron-right', 'ellipsis',
  'arrow-right', 'arrow-left', 'log-out', 'menu',
  // Manual components
  'lightbulb', 'circle-alert', 'triangle-alert', 'shield-check', 'shield', 'check', 'x', 'info',
  'clock', 'hourglass', 'circle-check', 'circle-x', 'minus', 'eye', 'lock', 'workflow', 'list-checks',
  // Common subjects
  'clipboard-list', 'boxes', 'scale', 'receipt', 'file-text', 'store', 'user', 'user-cog', 'mail',
  'message-circle', 'mic', 'paperclip', 'image', 'camera', 'thermometer', 'calculator', 'filter',
  'download', 'upload', 'refresh-cw', 'history', 'badge-check', 'pencil', 'trash-2', 'key-round',
  'smartphone', 'monitor', 'layout-grid', 'star', 'zap', 'send', 'share-2', 'link', 'wine', 'beer',
  'glass-water', 'flask-conical', 'chef-hat', 'utensils', 'wallet', 'banknote', 'shopping-cart',
  'barcode', 'scan-line', 'tag', 'calendar-check', 'timer', 'sun', 'moon', 'map-pin', 'phone',
  'globe', 'languages', 'bookmark', 'folder', 'graduation-cap', 'heart-handshake', 'party-popper'
];

function findLucide() {
  const bases = [process.env.ATLAS_BROWSER_LIBS, path.join(ROOT, 'node_modules'), path.join(ROOT, 'tests/browser/node_modules')].filter(Boolean);
  for (const base of bases) {
    const dir = path.join(base, 'lucide');
    if (existsSync(path.join(dir, 'dist/esm/icons/house.js'))) return dir;
  }
  throw new Error('Lucide not found. Set ATLAS_BROWSER_LIBS to a node_modules folder containing lucide@0.454.0.');
}

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function serialize([tag, attrs, children = []]) {
  const attrText = Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${escapeAttr(value)}"`).join('');
  const inner = children.map(serialize).join('');
  return inner ? `<${tag}${attrText}>${inner}</${tag}>` : `<${tag}${attrText}/>`;
}

async function main() {
  const lucide = findLucide();
  const version = JSON.parse(readFileSync(path.join(lucide, 'package.json'), 'utf8')).version;
  mkdirSync(OUT, { recursive: true });
  const missing = [];
  for (const name of ICONS) {
    const file = path.join(lucide, 'dist/esm/icons', `${name}.js`);
    if (!existsSync(file)) { missing.push(name); continue; }
    const node = (await import(pathToFileURL(file).href)).default;
    const svg = `<!-- Lucide ${version} "${name}" (ISC licence, see LICENSE-lucide.txt) -->\n${serialize(node)}\n`;
    writeFileSync(path.join(OUT, `${name}.svg`), svg);
  }
  const licence = readFileSync(path.join(lucide, 'LICENSE'), 'utf8');
  writeFileSync(path.join(OUT, 'LICENSE-lucide.txt'),
    `Icons in this folder are from Lucide ${version} (https://lucide.dev), the icon set Atlas uses.\n` +
    'They are unmodified exports of the Lucide icon definitions.\n\n' + licence);
  if (missing.length) {
    console.error(`Not in Lucide ${version}: ${missing.join(', ')}`);
    process.exitCode = 1;
  }
  console.log(`Wrote ${ICONS.length - missing.length} icons to ${path.relative(process.cwd(), OUT)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
