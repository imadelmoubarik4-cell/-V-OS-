const DIACRITICS = /[\u0300-\u036f]/g;
const SPACE = /\s+/g;

export function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(SPACE, ' ')
    .trim();
}

export function canonicalText(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(SPACE, ' ')
    .trim();
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

export function tokens(value) {
  return new Set(canonicalText(value).split(' ').filter(Boolean));
}
