// Atlas product identity: one normalisation for every inventory path.
//
// Plain dependency-free ESM so Edge Functions (Deno), the import engine and the
// Node test suite import the same file. Every function here has a SQL twin in
// supabase/migrations/20260927090000_s89_visual_inventory_foundation.sql:
//
//   foldText          atlas_private.product_text_fold(text)
//   searchFoldText    atlas_private.product_search_fold(text)
//   nameTokens        atlas_private.product_name_tokens(text)
//   matchTokens       atlas_private.product_match_tokens(text)
//   nameKey           atlas_private.product_name_key(brand, product_name, variant, name)
//   matchKey          atlas_private.product_match_key(brand, product_name, variant, name)
//   parsePackageText  atlas_private.product_parse_package(text)
//   parsePackage      atlas_private.product_parse_item_package(...)
//   packKey           atlas_private.product_pack_key(...)
//   identityKey       atlas_private.product_identity_key(...)
//   normalizeCode     atlas_private.product_code_normalize(kind, raw, symbology)
//   duplicateScore    atlas_private.catalog_duplicate_score(draft, item)
//
// Parity is enforced by tests/node/product-identity-parity.test.js against the
// replay database and against committed vectors generated from SQL
// (tests/fixtures/product-identity/sql-vectors.json). Change both together and
// bump PRODUCT_IDENTITY_VERSION.
//
// Owner rules (S89 gate):
// * Stored names, aliases and identity keys keep every letter. Icelandic
//   Á á Ð ð É é Í í Ó ó Ú ú Ý ý Þ þ Æ æ Ö ö are case-folded (Þ -> þ) and never
//   transliterated. foldText/nameKey/identityKey are the stored forms.
// * Accent-insensitive recall ("Sitronur" finds "Sítrónur") and bilingual
//   synonyms ("Sítrónur" ~ "Lemons") exist only as search keys: searchFoldText,
//   matchTokens and matchKey. They are never written back to item or alias
//   rows and never used as an identity key.
// * Name keys are sorted unique tokens with pack expressions, pack words and
//   stop words removed: "Vanille Giffard Syrup 1L" and "Giffard Vanille Syrup"
//   give the same key. Identity keys add the pack: case and unit differ.
// * "1,000" stays ambiguous (the S86.1 rule): never read as 1000 or 1.
// * GTIN family codes are validated by check digit and stored as GTIN-14, so
//   UPC-A and EAN-13 of the same product agree. An invalid check digit is never
//   an exact match. Other codes keep hyphens; only whitespace is removed and
//   ASCII letters are upper-cased.

export const PRODUCT_IDENTITY_VERSION = "pi-1";

// ---------------------------------------------------------------------------
// Identity folding (stored form): lower case, every Latin letter kept.
// ---------------------------------------------------------------------------
// The letter tables cover Latin-1 Supplement and Latin Extended-A
// (U+00C0-U+017F). They are built here once and embedded verbatim in the SQL
// twin, so folding never depends on the database locale.
function latinLetters() {
  const upper = [];
  const lower = [];
  const keep = [];
  for (let codePoint = 0xc0; codePoint <= 0x17f; codePoint += 1) {
    const char = String.fromCodePoint(codePoint);
    if (!/\p{L}/u.test(char)) continue;
    const folded = char.toLowerCase();
    if (folded !== char && [...folded].length === 1) {
      upper.push(char);
      lower.push(folded);
    } else if (folded === char) {
      keep.push(char);
    }
  }
  // Turkish dotted capital I lower-cases to "i" + combining dot in Unicode;
  // Atlas folds it to plain "i". Capital sharp s folds to ß.
  upper.push("İ", "ẞ");
  lower.push("i", "ß");
  return { upper: upper.join(""), lower: lower.join(""), keep: keep.join("") };
}
const LATIN = latinLetters();
// Upper -> lower for non-ASCII Latin letters (ASCII A-Z is handled apart).
export const CASE_UPPER = LATIN.upper;
export const CASE_LOWER = LATIN.lower;
// Letters kept besides a-z. Everything else except 0-9 . , becomes a space.
export const KEEP_LETTERS = LATIN.keep;
// Removed without a space so "Daniel's" is "daniels".
export const FOLD_DROP = "'’`´ʼ";
// The Icelandic letters the owner named; every one must survive foldText.
export const ICELANDIC_LETTERS = Object.freeze(["Á", "á", "Ð", "ð", "É", "é", "Í", "í", "Ó", "ó", "Ú", "ú", "Ý", "ý", "Þ", "þ", "Æ", "æ", "Ö", "ö"]);

if ([...CASE_UPPER].length !== [...CASE_LOWER].length) throw new Error("product-identity: case map lengths differ");
const CASE_MAP = new Map([...CASE_UPPER].map((char, index) => [char, [...CASE_LOWER][index]]));
const DROP_SET = new Set([...FOLD_DROP]);
const NOT_KEPT = new RegExp(`[^a-z0-9.,${KEEP_LETTERS}]+`, "gu");

export function foldText(value) {
  if (value === null || value === undefined) return "";
  let out = "";
  // NFKC also turns ligatures and full-width letters into plain letters.
  for (const char of String(value).normalize("NFKC")) {
    if (DROP_SET.has(char)) continue;
    // Combining marks NFKC could not compose are dropped, not spaced.
    if (char >= "̀" && char <= "ͯ") continue;
    if (char === "&") { out += " and "; continue; }
    if (char === "×") { out += " x "; continue; }
    if (char >= "A" && char <= "Z") { out += char.toLowerCase(); continue; }
    out += CASE_MAP.get(char) ?? char;
  }
  return out.replace(NOT_KEPT, " ").trim();
}

// ---------------------------------------------------------------------------
// Search folding (search-only): accents removed, þ -> th, ð -> d, æ -> ae.
// ---------------------------------------------------------------------------
// Letters without a canonical decomposition get an explicit ASCII form.
const SEARCH_SPECIAL = {
  þ: "th", ð: "d", æ: "ae", œ: "oe", ß: "ss", ø: "o", đ: "d", ħ: "h", ı: "i", ĳ: "ij",
  ŀ: "l", ł: "l", ŋ: "n", ŧ: "t", ſ: "s", ĸ: "k", ŉ: "n",
};
function searchTables() {
  const multi = [];
  const from = [];
  const to = [];
  for (const char of KEEP_LETTERS) {
    const special = SEARCH_SPECIAL[char];
    const base = special ?? char.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (!/^[a-z]+$/.test(base)) throw new Error(`product-identity: no search form for ${char}`);
    if (base.length > 1) multi.push([char, base]);
    else { from.push(char); to.push(base); }
  }
  return { multi, from: from.join(""), to: to.join("") };
}
const SEARCH = searchTables();
export const SEARCH_MULTI = Object.freeze(SEARCH.multi);
export const SEARCH_FROM = SEARCH.from;
export const SEARCH_TO = SEARCH.to;
const SEARCH_MULTI_MAP = new Map(SEARCH_MULTI);
const SEARCH_MAP = new Map([...SEARCH_FROM].map((char, index) => [char, SEARCH_TO[index]]));

export function searchFoldText(value) {
  let out = "";
  for (const char of foldText(value)) out += SEARCH_MULTI_MAP.get(char) ?? SEARCH_MAP.get(char) ?? char;
  return out;
}

// ---------------------------------------------------------------------------
// Package parsing (all inventory classes)
// ---------------------------------------------------------------------------
export const MEASURE_UNITS = Object.freeze({
  millilitres: ["ml", 1], milliliters: ["ml", 1], millilitre: ["ml", 1], milliliter: ["ml", 1], ml: ["ml", 1],
  cl: ["ml", 10], dl: ["ml", 100],
  litres: ["ml", 1000], liters: ["ml", 1000], litre: ["ml", 1000], liter: ["ml", 1000],
  lítrar: ["ml", 1000], litrar: ["ml", 1000], lítra: ["ml", 1000], litra: ["ml", 1000],
  lítri: ["ml", 1000], litri: ["ml", 1000], ltr: ["ml", 1000], lt: ["ml", 1000], l: ["ml", 1000],
  kilograms: ["g", 1000], kilogram: ["g", 1000], kilos: ["g", 1000], kíló: ["g", 1000], kilo: ["g", 1000], kg: ["g", 1000],
  grams: ["g", 1], gram: ["g", 1], grömm: ["g", 1], gromm: ["g", 1], gr: ["g", 1], g: ["g", 1],
});
export const COUNT_UNITS = Object.freeze([
  "tea bags", "teabags", "pieces", "piece", "stykki", "stk", "pcs", "pc", "bags", "bag", "sachets", "sachet",
  "cups", "cup", "lids", "lid", "napkins", "napkin", "straws", "units", "unit", "count", "ct",
]);

// Longest alternatives first so JavaScript (first match) and PostgreSQL
// (longest match) pick the same unit word.
function alternation(words) {
  return [...words].sort((a, b) => [...b].length - [...a].length || (a < b ? -1 : a > b ? 1 : 0)).join("|");
}

const MEASURE_ALT = alternation(Object.keys(MEASURE_UNITS));
const COUNT_ALT = alternation(COUNT_UNITS);
const ANY_ALT = alternation([...Object.keys(MEASURE_UNITS), ...COUNT_UNITS]);
const NUM = "([0-9]+(?:[.,][0-9]+)?)";
const WORD_END = `(?![a-z0-9${KEEP_LETTERS}])`;
// Source strings are shared with the SQL twin (atlas_private.product_pack_pattern()).
export const PACK_PATTERNS = Object.freeze({
  multipack: `(?:^| )([0-9]+) ?x ?${NUM} ?(${ANY_ALT})${WORD_END}`,
  measure: `(?:^| )${NUM} ?(${MEASURE_ALT})${WORD_END}`,
  count: `(?:^| )${NUM} ?(${COUNT_ALT})${WORD_END}`,
});
const MULTIPACK_RE = new RegExp(PACK_PATTERNS.multipack, "u");
const MEASURE_RE = new RegExp(PACK_PATTERNS.measure, "u");
const COUNT_RE = new RegExp(PACK_PATTERNS.count, "u");
const PACK_STRIP_RE = new RegExp(`${PACK_PATTERNS.multipack}|${PACK_PATTERNS.measure}|${PACK_PATTERNS.count}`, "gu");

// Inventory units that count cases or boxes rather than single containers
// (compared on the search-folded unit text).
export const CASE_UNITS = Object.freeze(["case", "cases", "box", "boxes", "pack", "packs", "kassi", "kassar", "crate", "crates", "tray", "trays"]);
const CASE_UNIT_SET = new Set(CASE_UNITS);

// "1,000" is a thousands separator or a decimal comma: ambiguous (S86.1).
function parseDecimal(text) {
  const match = /^([0-9]+)(?:([.,])([0-9]+))?$/.exec(text);
  if (!match) return { value: null, ambiguous: false };
  if (match[2] === "," && match[3].length === 3 && match[1] !== "0") return { value: null, ambiguous: true };
  return { value: Number(`${match[1]}${match[3] !== undefined ? `.${match[3]}` : ""}`), ambiguous: false };
}

export function roundQuantity(value) {
  return Math.round(value * 1000) / 1000;
}

export function formatQuantity(value) {
  return String(roundQuantity(value));
}

function unitFor(word) {
  if (Object.prototype.hasOwnProperty.call(MEASURE_UNITS, word)) return MEASURE_UNITS[word];
  if (COUNT_UNITS.includes(word)) return ["count", 1];
  return null;
}

function emptyPackage(kind = "none", packText = null, reason = null) {
  return { kind, unit_quantity: null, unit_base: null, units_per_pack: null, pack_text: packText, ambiguous_reason: reason };
}

// First pack expression in free text:
//   "24 x 330ml" -> multipack 24 x 330 ml, "25 L keg" -> 25000 ml,
//   "1250 pcs" -> 1250 count, "1,000 ml" -> ambiguous.
export function parsePackageText(value) {
  const folded = foldText(value);
  if (!folded) return emptyPackage();
  const multipack = MULTIPACK_RE.exec(folded);
  if (multipack) {
    const units = Number(multipack[1]);
    const inner = parseDecimal(multipack[2]);
    const [base, factor] = unitFor(multipack[3]);
    if (inner.ambiguous) return emptyPackage("ambiguous", multipack[0].trim(), "decimal_comma_or_thousands");
    if (units > 0 && inner.value > 0) {
      return {
        kind: "multipack", unit_quantity: roundQuantity(inner.value * factor), unit_base: base,
        units_per_pack: units, pack_text: multipack[0].trim(), ambiguous_reason: null,
      };
    }
  }
  const chosen = MEASURE_RE.exec(folded) ?? COUNT_RE.exec(folded);
  if (!chosen) return emptyPackage();
  const amount = parseDecimal(chosen[1]);
  if (amount.ambiguous) return emptyPackage("ambiguous", chosen[0].trim(), "decimal_comma_or_thousands");
  if (!(amount.value > 0)) return emptyPackage();
  const [base, factor] = unitFor(chosen[2]);
  return {
    kind: base === "count" ? "count" : "single", unit_quantity: roundQuantity(amount.value * factor), unit_base: base,
    units_per_pack: null, pack_text: chosen[0].trim(), ambiguous_reason: null,
  };
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Structured pack of an item or a draft. Evidence order:
// unit_size_quantity/base > size_ml > package_weight_g > package_size text >
// a pack expression in the name. The multipack prefix is kept only when the
// row counts cases (unit is case-like), so a case of 6 x 1 L counted in cases
// is a different identity from the 1 L carton. Read-only: nothing is stored.
export function parsePackage(input) {
  if (input === null || input === undefined) return emptyPackage();
  if (typeof input !== "object") return parsePackageText(input);
  const unitSizeQuantity = positiveNumber(input.unit_size_quantity);
  const unitSizeBase = ["ml", "g", "count"].includes(input.unit_size_base) ? input.unit_size_base : null;
  const sizeMl = positiveNumber(input.size_ml);
  const weightG = positiveNumber(input.package_weight_g);
  const text = parsePackageText(input.package_size);
  const fromName = parsePackageText(input.name);
  const caseRow = CASE_UNIT_SET.has(searchFoldText(input.unit));

  let quantity = null;
  let base = null;
  let source = null;
  if (unitSizeQuantity !== null && unitSizeBase) { quantity = unitSizeQuantity; base = unitSizeBase; source = "unit_size"; }
  else if (sizeMl !== null) { quantity = sizeMl; base = "ml"; source = "size_ml"; }
  else if (weightG !== null) { quantity = weightG; base = "g"; source = "package_weight_g"; }
  else if (text.unit_quantity !== null) { quantity = text.unit_quantity; base = text.unit_base; source = "package_size"; }
  else if (fromName.unit_quantity !== null) { quantity = fromName.unit_quantity; base = fromName.unit_base; source = "name"; }

  if (quantity === null) {
    const reason = text.kind === "ambiguous" ? text.ambiguous_reason
      : fromName.kind === "ambiguous" ? fromName.ambiguous_reason : null;
    return { ...emptyPackage(reason ? "ambiguous" : "none", null, reason), source: null };
  }
  let unitsPerPack = null;
  if (caseRow) {
    if (text.kind === "multipack") unitsPerPack = text.units_per_pack;
    else if (fromName.kind === "multipack") unitsPerPack = fromName.units_per_pack;
  }
  return {
    kind: unitsPerPack ? "multipack" : base === "count" ? "count" : "single",
    unit_quantity: roundQuantity(quantity),
    unit_base: base,
    units_per_pack: unitsPerPack,
    pack_text: text.pack_text ?? fromName.pack_text ?? null,
    ambiguous_reason: null,
    source,
  };
}

// "1000ml", "6x1000ml", "1250count" or "?" when unknown.
export function packKey(input) {
  const pack = parsePackage(input);
  if (pack.unit_quantity === null) return "?";
  const inner = `${formatQuantity(pack.unit_quantity)}${pack.unit_base}`;
  return pack.units_per_pack ? `${formatQuantity(pack.units_per_pack)}x${inner}` : inner;
}

export function packFromKey(key) {
  const match = /^(?:([0-9.]+)x)?([0-9.]+)(ml|g|count)$/.exec(String(key ?? ""));
  if (!match) return null;
  return { units_per_pack: match[1] ? Number(match[1]) : null, unit_quantity: Number(match[2]), unit_base: match[3] };
}

// ---------------------------------------------------------------------------
// Lexicon (search-only). Keys are search-folded; values are canonical English
// concept tokens. It never changes a stored name, alias or identity key.
// ---------------------------------------------------------------------------
export const LEXICON = Object.freeze({
  version: "lex-1",
  phrases: Object.freeze({
    "noix de coco": "coconut",
    "passion fruit": "passionfruit",
    "alcohol free": "alcoholfree",
    "non alcoholic": "alcoholfree",
    "sugar free": "sugarfree",
    "tea bags": "tea",
  }),
  tokens: Object.freeze({
    vanille: "vanilla", vanilla: "vanilla", vanillu: "vanilla", vainilla: "vanilla",
    sirop: "syrup", syrup: "syrup", sirup: "syrup", siropur: "syrup", siropi: "syrup", syrups: "syrup",
    sitrona: "lemon", sitronur: "lemon", sitronu: "lemon", sitronusafi: "lemon juice", lemons: "lemon", lemon: "lemon", citron: "lemon",
    limes: "lime", lime: "lime", limur: "lime",
    haframjolk: "oat milk", hafra: "oat",
    tronuber: "cranberry", tronuberja: "cranberry", tronuberjasafi: "cranberry juice", cranberries: "cranberry", cranberry: "cranberry", canneberge: "cranberry",
    safi: "juice", jus: "juice", juices: "juice",
    ananas: "pineapple", pineapples: "pineapple", pineapple: "pineapple",
    thurrkadur: "dried", thurrkud: "dried", thurrkadir: "dried", thurrkadar: "dried", dried: "dried", dehydrated: "dried",
    kirsuber: "cherry", cherries: "cherry", cherry: "cherry", cerise: "cherry", cerises: "cherry",
    coco: "coconut", kokos: "coconut", coconut: "coconut",
    puree: "puree", pure: "puree", mauk: "puree",
    mynta: "mint", myntu: "mint", mint: "mint", menthe: "mint",
    sykur: "sugar", sugar: "sugar", sucre: "sugar",
    banane: "banana", banani: "banana", bananas: "banana", banana: "banana",
    fraise: "strawberry", jardarber: "strawberry", strawberries: "strawberry", strawberry: "strawberry",
    peche: "peach", ferskja: "peach", ferskju: "peach", peaches: "peach", peach: "peach",
    mangue: "mango", mangos: "mango", mangoes: "mango", mango: "mango",
    pistache: "pistachio", pistachios: "pistachio", pistasiu: "pistachio", pistachio: "pistachio",
    karamella: "caramel", karamellu: "caramel", caramel: "caramel",
    amande: "almond", mondlu: "almond", mondlur: "almond", almonds: "almond", almond: "almond",
    mondlusirop: "almond syrup",
    mjolk: "milk", milk: "milk", lait: "milk",
    kaffi: "coffee", cafe: "coffee", coffee: "coffee",
    appelsina: "orange", appelsinur: "orange", appelsinu: "orange", appelsinusafi: "orange juice", oranges: "orange", orange: "orange",
    epli: "apple", pomme: "apple", apples: "apple", apple: "apple",
    engifer: "ginger", gingembre: "ginger", ginger: "ginger",
    hunang: "honey", miel: "honey", honey: "honey",
    vatn: "water", eau: "water", water: "water",
    sodavatn: "soda water",
    rjomi: "cream", creme: "cream", cream: "cream",
    bitter: "bitters", bitters: "bitters",
    likjor: "liqueur", liqueur: "liqueur", liquor: "liqueur",
    greipaldin: "grapefruit", pamplemousse: "grapefruit", grapefruit: "grapefruit",
    hindber: "raspberry", framboise: "raspberry", raspberries: "raspberry", raspberry: "raspberry",
    blaber: "blueberry", myrtille: "blueberry", blueberries: "blueberry", blueberry: "blueberry",
    passionfruit: "passionfruit", maracuja: "passionfruit", passionsaldin: "passionfruit",
    afengislaus: "alcoholfree", afengislaust: "alcoholfree", alcoholfree: "alcoholfree",
    kanill: "cinnamon", cannelle: "cinnamon", cinnamon: "cinnamon",
    heslihneta: "hazelnut", noisette: "hazelnut", hazelnuts: "hazelnut", hazelnut: "hazelnut",
    sukkuladi: "chocolate", chocolat: "chocolate", chocolate: "chocolate",
    salt: "salt", sel: "salt",
    te: "tea", tea: "tea",
  }),
  // Dropped from name keys (compared search-folded).
  stop: Object.freeze(["and", "og", "de", "du", "des", "la", "le", "les", "of", "the", "a", "an", "en", "et", "with", "med", "i"]),
  // Container and pack words (compared search-folded): packaging, not product.
  packaging: Object.freeze([
    "bottle", "bottles", "flaska", "floskur", "can", "cans", "dos", "dosir", "carton", "cartons", "ferna",
    "keg", "kegs", "kutur", "box", "boxes", "kassi", "kassar", "case", "cases", "pack", "packs", "pakki",
    "jar", "jars", "tub", "tubs", "pouch", "pouches", "tray", "trays", "bag", "bags", "poki", "pokar",
    "sachet", "sachets", "pcs", "pc", "stk", "stykki", "pieces", "piece", "ct",
  ]),
  // Flavour / style / expression words (match tokens). Different variant sets
  // on similar names are different products (Giffard Vanille vs Caramel).
  variants: Object.freeze([
    "vanilla", "caramel", "salted", "banana", "strawberry", "peach", "mango", "pistachio", "almond", "orgeat",
    "coconut", "pineapple", "cherry", "lemon", "lime", "orange", "passionfruit", "mint", "ginger", "cranberry",
    "apple", "grapefruit", "raspberry", "blackberry", "blueberry", "elderflower", "hazelnut", "chocolate",
    "cinnamon", "lavender", "rose", "watermelon", "pear", "plum", "apricot", "maple", "spiced", "smoked",
    "silver", "gold", "reposado", "anejo", "blanco", "dark", "white", "red", "pink", "vsop", "xo", "zero",
    "diet", "alcoholfree", "sugarfree",
  ]),
});

const PHRASES = new Map(Object.entries(LEXICON.phrases));
const TOKEN_MAP = new Map(Object.entries(LEXICON.tokens));
const STOP = new Set(LEXICON.stop);
const PACKAGING = new Set(LEXICON.packaging);
const VARIANTS = new Set(LEXICON.variants);

function trimPunctuation(token) {
  return token.replace(/^[.,]+|[.,]+$/g, "");
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Stored-form tokens in reading order: letters kept, pack expressions, stop
// words and packaging words removed.
export function nameTokens(value) {
  const folded = foldText(value);
  if (!folded) return [];
  return folded.replace(PACK_STRIP_RE, " ").split(" ").map(trimPunctuation)
    .filter((token) => token && !STOP.has(searchFoldText(token)) && !PACKAGING.has(searchFoldText(token)));
}

// Search-only tokens: name tokens search-folded, then lexicon synonyms.
export function matchTokens(value) {
  const raw = nameTokens(value).map(searchFoldText);
  const mapped = [];
  for (let index = 0; index < raw.length;) {
    let matched = false;
    for (const length of [3, 2]) {
      if (index + length > raw.length) continue;
      const phrase = raw.slice(index, index + length).join(" ");
      if (PHRASES.has(phrase)) {
        mapped.push(...PHRASES.get(phrase).split(" "));
        index += length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    mapped.push(...(TOKEN_MAP.get(raw[index]) ?? raw[index]).split(" "));
    index += 1;
  }
  return mapped.filter((token) => token && !STOP.has(token) && !PACKAGING.has(token));
}

export function tokens(value) {
  return sortedUnique(nameTokens(value));
}

export function variantTokens(tokenList) {
  return sortedUnique([...tokenList].filter((token) => VARIANTS.has(token)));
}

function nameParts(parts) {
  if (parts === null || parts === undefined) return [];
  if (typeof parts !== "object") return [parts];
  const main = foldText(parts.product_name) ? parts.product_name : parts.name;
  return [parts.brand, main, parts.variant];
}

// Stored identity name key: sorted unique name tokens of brand + (product
// name or name) + variant. Keeps every letter.
export function nameKey(parts) {
  const all = [];
  for (const part of nameParts(parts)) all.push(...nameTokens(part));
  return sortedUnique(all).join(" ") || null;
}

// Search-only key: accent-insensitive and lexicon-mapped.
export function matchKey(parts) {
  const all = [];
  for (const part of nameParts(parts)) all.push(...matchTokens(part));
  return sortedUnique(all).join(" ") || null;
}

export function identityKey(item) {
  const key = nameKey(item);
  return key ? `${key}|${packKey(item)}` : null;
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------
export const CODE_KINDS = Object.freeze(["gtin", "sku", "supplier_ref", "internal", "other_barcode"]);
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);
const CODE_WHITESPACE = /[ \t\n\r ]/g;

export function gtinCheckDigitValid(digits) {
  const text = String(digits ?? "");
  if (!/^[0-9]+$/.test(text) || !GTIN_LENGTHS.has(text.length)) return false;
  let sum = 0;
  const body = text.slice(0, -1);
  for (let index = 0; index < body.length; index += 1) {
    sum += Number(body[body.length - 1 - index]) * (index % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(text[text.length - 1]);
}

// UPC-E (8 digits: number system, six digits, check) to UPC-A (12 digits).
export function expandUpcE(code) {
  const text = String(code ?? "");
  if (!/^[01][0-9]{7}$/.test(text)) return null;
  const d = text.slice(1, 7);
  const last = d[5];
  let body;
  if (last === "0" || last === "1" || last === "2") body = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  else if (last === "3") body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  else if (last === "4") body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  else body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
  return `${text[0]}${body}${text[7]}`;
}

export function normalizeSymbology(value) {
  const folded = String(value ?? "")
    .replace(/[A-Z]/g, (char) => char.toLowerCase())
    .replace(/[ \t\n\r -]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return folded || "unknown";
}

// { kind, normalized, valid, symbology, reason }. Pass `kind` (gtin, sku,
// supplier_ref, internal, other_barcode) when known; without it digit-only
// GTIN-length codes are GTINs and everything else is other_barcode.
export function normalizeCode(raw, options = {}) {
  const requestedKind = CODE_KINDS.includes(options.kind) ? options.kind : null;
  const symbology = normalizeSymbology(options.symbology);
  const compact = String(raw ?? "").replace(CODE_WHITESPACE, "");
  if (!compact) return { kind: requestedKind ?? "other_barcode", normalized: null, valid: false, symbology, reason: "empty" };
  const digits = compact.replace(/-/g, "");
  const gtinCandidate = requestedKind === null || requestedKind === "gtin";
  if (gtinCandidate && /^[0-9]+$/.test(digits)) {
    const candidate = symbology === "upc_e" && digits.length === 8 ? (expandUpcE(digits) ?? digits) : digits;
    if (GTIN_LENGTHS.has(candidate.length)) {
      return gtinCheckDigitValid(candidate)
        ? { kind: "gtin", normalized: candidate.padStart(14, "0"), valid: true, symbology, reason: null }
        : { kind: "gtin", normalized: null, valid: false, symbology, reason: "check_digit" };
    }
    if (requestedKind === "gtin") return { kind: "gtin", normalized: null, valid: false, symbology, reason: "length" };
  } else if (requestedKind === "gtin") {
    return { kind: "gtin", normalized: null, valid: false, symbology, reason: "not_numeric" };
  }
  const kind = requestedKind ?? "other_barcode";
  const normalized = compact.replace(/[a-z]/g, (char) => char.toUpperCase());
  if ([...normalized].length < 3 || [...normalized].length > 128) {
    return { kind, normalized: null, valid: false, symbology, reason: "length" };
  }
  return { kind, normalized, valid: true, symbology, reason: null };
}

// ---------------------------------------------------------------------------
// Duplicate guard (SQL twin: atlas_private.catalog_duplicate_score)
// ---------------------------------------------------------------------------
// possible: shown as "Possible existing matches" and must be acknowledged by
// a manager with a reason before creation. strong: "Likely the same item".
export const DUPLICATE_THRESHOLDS = Object.freeze({ possible: 0.6, strong: 0.85, listed: 0.3 });

function packCompare(a, b) {
  if (!a || !b) return "unknown";
  if (a.unit_base !== b.unit_base) return "size_conflict";
  const larger = Math.max(a.unit_quantity, b.unit_quantity);
  if (Math.abs(a.unit_quantity - b.unit_quantity) > larger * 0.02) return "size_conflict";
  if ((a.units_per_pack ?? 1) !== (b.units_per_pack ?? 1)) return "case_vs_unit";
  return "same";
}

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const right = new Set(b);
  const shared = new Set(a.filter((token) => right.has(token))).size;
  return (2 * shared) / (new Set(a).size + right.size);
}

function sameSet(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// Supplier references are scoped to their supplier; an unknown supplier on
// either side still counts as the same reference (the guard is conservative).
export function sameCode(a, b) {
  if (!a?.normalized || !b?.normalized || a.kind !== b.kind || a.normalized !== b.normalized) return false;
  if (a.kind !== "supplier_ref") return true;
  return !a.supplier_id || !b.supplier_id || a.supplier_id === b.supplier_id;
}

function splitKey(key) {
  return key ? String(key).split(" ").filter(Boolean) : [];
}

// Draft and item shapes (stored keys or the functions above):
//   { name_key, match_key, pack_key, brand_key, item_class, legacy_key,
//     codes: [{ kind, normalized }], alias_keys: [match keys of aliases] }
// legacy_key is the match key of the item's legacy canonical_key column.
// Returns { score 0..1, points, caps, evidence[], code_collision }.
export function duplicateScore(draft, item) {
  const evidence = [];
  const caps = [];
  const draftCodes = (draft.codes ?? []).filter((code) => code?.normalized);
  if ((item.codes ?? []).some((code) => draftCodes.some((other) => sameCode(other, code)))) {
    evidence.push({ signal: "code", polarity: "for", text: "Same barcode, SKU or supplier reference" });
    return { score: 1, points: 100, caps, evidence, code_collision: true };
  }

  const draftTokens = splitKey(draft.match_key);
  const itemTokens = splitKey(item.match_key);
  const itemAliases = (item.alias_keys ?? []).filter(Boolean);
  const draftAliases = (draft.alias_keys ?? []).filter(Boolean);
  const identityExact = Boolean(draft.name_key) && draft.name_key === item.name_key
    && Boolean(draft.pack_key) && draft.pack_key !== "?" && draft.pack_key === item.pack_key;
  let points;
  if (identityExact) {
    points = 99;
    evidence.push({ signal: "identity_key", polarity: "for", text: "Same name and package" });
  } else if (draft.name_key && draft.name_key === item.name_key) {
    points = 90;
    evidence.push({ signal: "name_key", polarity: "for", text: "Same name" });
  } else if (draft.match_key && draft.match_key === item.match_key) {
    points = 90;
    evidence.push({ signal: "match_key", polarity: "for", text: "Same name in another spelling or language" });
  } else if ((draft.match_key && itemAliases.includes(draft.match_key))
    || (item.match_key && draftAliases.includes(item.match_key))) {
    points = 90;
    evidence.push({ signal: "alias", polarity: "for", text: "Matches an alias of this item" });
  } else if (draft.match_key && item.legacy_key && draft.match_key === item.legacy_key) {
    points = 80;
    evidence.push({ signal: "legacy_key", polarity: "for", text: "Matches this item's canonical key" });
  } else {
    let best = dice(draftTokens, itemTokens);
    for (const alias of itemAliases) best = Math.max(best, dice(draftTokens, splitKey(alias)));
    points = Math.round(80 * best);
    if (best > 0) evidence.push({ signal: "tokens", polarity: "for", text: `${Math.round(best * 100)}% of the name words agree` });
  }

  const pack = packCompare(packFromKey(draft.pack_key), packFromKey(item.pack_key));
  if (pack === "same" && !identityExact) {
    points += 10;
    evidence.push({ signal: "pack", polarity: "for", text: "Same package size" });
  } else if (pack === "size_conflict") {
    caps.push(55);
    evidence.push({ signal: "pack", polarity: "against", text: "Different package size" });
  } else if (pack === "case_vs_unit") {
    caps.push(70);
    evidence.push({ signal: "pack", polarity: "against", text: "Case and single unit" });
  }
  if (draft.brand_key && item.brand_key) {
    if (draft.brand_key === item.brand_key) {
      points += 10;
      evidence.push({ signal: "brand", polarity: "for", text: "Same brand" });
    } else {
      caps.push(40);
      evidence.push({ signal: "brand", polarity: "against", text: "Different brand" });
    }
  }
  const draftVariants = variantTokens(draftTokens);
  const itemVariants = variantTokens(itemTokens);
  if (draftVariants.length && itemVariants.length && !sameSet(draftVariants, itemVariants)) {
    caps.push(35);
    evidence.push({ signal: "variant", polarity: "against", text: "Different flavour or variant" });
  }
  if (draft.item_class && item.item_class && draft.item_class !== item.item_class) {
    caps.push(45);
    evidence.push({ signal: "class", polarity: "against", text: "Different product type" });
  }
  // Only a shared code is certain; every other signal stops at 0.99.
  const capped = Math.max(0, Math.min(points, 99, ...caps));
  return { score: capped / 100, points, caps, evidence, code_collision: false };
}

// Keys of a draft or item for duplicateScore.
export function duplicateKeys(input) {
  const source = input ?? {};
  return {
    name_key: nameKey(source),
    match_key: matchKey(source),
    pack_key: packKey(source),
    brand_key: source.brand ? matchKey(source.brand) : null,
    item_class: source.item_class || null,
    legacy_key: source.canonical_key ? matchKey(String(source.canonical_key).replace(/[-_:]+/g, " ")) : null,
    codes: (source.codes ?? [])
      .map((code) => ({
        ...normalizeCode(code.code ?? code.normalized ?? code.raw, { kind: code.kind, symbology: code.symbology }),
        supplier_id: code.supplier_id ?? null,
      }))
      .filter((code) => code.valid),
    alias_keys: (source.aliases ?? []).map((alias) => matchKey(typeof alias === "string" ? alias : alias?.alias)).filter(Boolean),
  };
}
