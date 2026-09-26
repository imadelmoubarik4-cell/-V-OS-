#!/usr/bin/env node
// S94C: builds the browser copy of the platform rules.
//   source: supabase/functions/_shared/publishing/rules.mjs (pure ESM, no imports)
//   output: apps/web/assets/js/marketing-platform-rules.js (classic script that
//           defines window.AtlasPlatformRules with the same functions; no exports)
// Usage: node scripts/build_platform_rules.mjs [--check]
// --check exits 1 when the committed browser file differs from a fresh build.
// tests/node/platform-rules-s94.test.js asserts byte identity (parity).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RULES_SOURCE = 'supabase/functions/_shared/publishing/rules.mjs';
export const RULES_BROWSER = 'apps/web/assets/js/marketing-platform-rules.js';

export function buildPlatformRulesBrowser(source) {
  const text = String(source).replace(/\r\n/g, '\n');
  if (/^\s*import\s/m.test(text)) throw new Error('rules.mjs must not import anything');
  if (/^export\s+(default|\{|\*)/m.test(text)) throw new Error('rules.mjs may only use `export const` / `export function`');
  const names = [...text.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  if (!names.includes('validate')) throw new Error('rules.mjs must export validate');
  const body = text.replace(/^export\s+/gm, '').trimEnd();
  const indented = body.split('\n').map((line) => (line ? `  ${line}` : '')).join('\n');
  return [
    '// GENERATED FILE - do not edit. Built by scripts/build_platform_rules.mjs from',
    `// ${RULES_SOURCE} (the server copy is the source of truth).`,
    '// Classic script: defines window.AtlasPlatformRules.',
    '(function () {',
    "  'use strict';",
    '',
    indented,
    '',
    `  window.AtlasPlatformRules = Object.freeze({ ${names.join(', ')} });`,
    '})();',
    '',
  ].join('\n');
}

function main() {
  const source = fs.readFileSync(path.join(ROOT, RULES_SOURCE), 'utf8');
  const built = buildPlatformRulesBrowser(source);
  const target = path.join(ROOT, RULES_BROWSER);
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== built) {
      console.error(`${RULES_BROWSER} is out of date; run node scripts/build_platform_rules.mjs`);
      process.exit(1);
    }
    return;
  }
  fs.writeFileSync(target, built);
  console.log(`wrote ${RULES_BROWSER}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
