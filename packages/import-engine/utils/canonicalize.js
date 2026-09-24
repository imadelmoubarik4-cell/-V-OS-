// Import canonicalization on the shared Atlas product identity rules
// (supabase/functions/_shared/product-identity.mjs, S89).
//
// Stored forms keep every letter: "Þurrkaður Ananas" is "þurrkaður ananas",
// never "urrka ur ananas" (the pre-S89 NFKD strip lost Icelandic letters) and
// never a transliteration. Accent-insensitive comparison is available only
// through searchText()/tokens(), which feed similarity scoring and are never
// written to a stored key.
import {
  foldText,
  identityKey,
  matchKey,
  matchTokens,
  nameKey,
  nameTokens,
  normalizeCode,
  packKey,
  parsePackage as parseProductPackage,
  parsePackageText,
  searchFoldText,
} from '../../../supabase/functions/_shared/product-identity.mjs';

export {
  foldText,
  identityKey,
  matchKey,
  matchTokens,
  nameKey,
  nameTokens,
  normalizeCode,
  packKey,
  parseProductPackage,
  parsePackageText,
  searchFoldText,
};

const SPACE = /\s+/g;

export function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[‘’′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(SPACE, ' ')
    .trim();
}

function withoutPunctuation(value) {
  return value.replace(/[.,]+/g, ' ').replace(SPACE, ' ').trim();
}

// Stored canonical text: case-folded, letters kept (Á á Ð ð É é Í í Ó ó Ú ú
// Ý ý Þ þ Æ æ Ö ö survive), punctuation removed.
export function canonicalText(value) {
  return withoutPunctuation(foldText(cleanText(value)));
}

export function canonicalKey(name, packageSize = '') {
  const item = canonicalText(name);
  const pack = canonicalText(packageSize);
  return [item, pack].filter(Boolean).join('|');
}

export function slug(value) {
  return canonicalText(value).replace(/\s+/g, '-');
}

export function normalizeIdentifier(value) {
  const normalized = cleanText(value).replace(/\s+/g, '').toUpperCase();
  return normalized || null;
}

// Search-only text for similarity scoring (accent-insensitive).
export function searchText(value) {
  return withoutPunctuation(searchFoldText(cleanText(value)));
}

// Search-only token set for similarity scoring.
export function tokens(value) {
  return new Set(searchText(value).split(' ').filter(Boolean));
}
