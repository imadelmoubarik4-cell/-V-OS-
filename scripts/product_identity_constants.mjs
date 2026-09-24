// Prints the product-identity constants as the JSON literal embedded in
// atlas_private.product_identity_constants() (S89 foundation migration).
//
//   node scripts/product_identity_constants.mjs            # print JSON
//   node scripts/product_identity_constants.mjs --check    # exit 1 if the migration differs
//
// tests/node/product-identity-parity.test.js runs the --check comparison, so
// a lexicon or unit change in supabase/functions/_shared/product-identity.mjs
// fails CI until a new migration carries the same constants.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as identity from '../supabase/functions/_shared/product-identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function productIdentityConstants() {
  return {
    version: identity.PRODUCT_IDENTITY_VERSION,
    case_upper: identity.CASE_UPPER,
    case_lower: identity.CASE_LOWER,
    keep_letters: identity.KEEP_LETTERS,
    fold_drop: identity.FOLD_DROP,
    search_multi: Object.fromEntries(identity.SEARCH_MULTI),
    search_from: identity.SEARCH_FROM,
    search_to: identity.SEARCH_TO,
    pack_patterns: identity.PACK_PATTERNS,
    measure_units: identity.MEASURE_UNITS,
    count_units: identity.COUNT_UNITS,
    case_units: identity.CASE_UNITS,
    lexicon: identity.LEXICON,
    duplicate_thresholds: identity.DUPLICATE_THRESHOLDS,
  };
}

// The newest migration that defines the constants function wins.
export function migrationConstants() {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  let found = null;
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    const match = source.match(/function atlas_private\.product_identity_constants\(\)[\s\S]*?\$json\$([\s\S]*?)\$json\$/);
    if (match) found = { file: name, value: JSON.parse(match[1]) };
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const constants = productIdentityConstants();
  const writeIndex = process.argv.indexOf('--write');
  if (writeIndex > 0) {
    // --write <migration.sql>: replace the $json$ literal (or the placeholder).
    const file = path.resolve(process.argv[writeIndex + 1]);
    const source = fs.readFileSync(file, 'utf8');
    const next = source.replace(/(function atlas_private\.product_identity_constants\(\)[\s\S]*?\$json\$)([\s\S]*?)(\$json\$)/,
      (_, head, __, tail) => `${head}${JSON.stringify(constants)}${tail}`);
    if (next === source && !source.includes(JSON.stringify(constants))) {
      console.error(`no product_identity_constants() literal found in ${file}`);
      process.exit(1);
    }
    fs.writeFileSync(file, next);
    console.log(`wrote product identity constants into ${path.relative(ROOT, file)}`);
  } else if (process.argv.includes('--check')) {
    const found = migrationConstants();
    const same = found && JSON.stringify(found.value) === JSON.stringify(constants);
    if (!same) {
      console.error(`product identity constants differ from ${found ? found.file : 'the migrations'}`);
      process.exit(1);
    }
    console.log(`product identity constants match ${found.file}`);
  } else {
    console.log(JSON.stringify(constants));
  }
}
