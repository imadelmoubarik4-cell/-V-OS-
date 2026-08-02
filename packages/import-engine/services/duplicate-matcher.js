import { canonicalKey, canonicalText, normalizeIdentifier, tokens } from '../utils/canonicalize.js';

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

export function tokenSimilarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  const intersection = intersectionSize(a, b);
  return intersection / (a.size + b.size - intersection);
}

export function editSimilarity(left, right) {
  const a = canonicalText(left);
  const b = canonicalText(right);
  if (a === b) return 1;
  if (!a || !b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

export function nameSimilarity(left, right) {
  return (tokenSimilarity(left, right) * 0.65) + (editSimilarity(left, right) * 0.35);
}

function candidateValue(candidate, camel, snake) {
  return candidate?.[camel] ?? candidate?.[snake] ?? null;
}

export function matchInventoryRecord(record, candidates, options = {}) {
  const automaticThreshold = options.automaticThreshold ?? 0.94;
  const reviewThreshold = options.reviewThreshold ?? 0.72;
  const list = Array.isArray(candidates) ? candidates : [];
  const recordSku = normalizeIdentifier(record.sku);
  const recordBarcode = normalizeIdentifier(record.barcode);
  const recordSourceKey = record.sourceKey || record.source_key || null;

  const identifierRules = [
    ['barcode', recordBarcode, candidate => normalizeIdentifier(candidateValue(candidate, 'barcode', 'barcode'))],
    ['sku', recordSku, candidate => normalizeIdentifier(candidateValue(candidate, 'sku', 'sku'))],
    ['source_key', recordSourceKey, candidate => candidateValue(candidate, 'sourceKey', 'source_key')],
  ];
  for (const [strategy, value, getter] of identifierRules) {
    if (!value) continue;
    const matches = list.filter(candidate => getter(candidate) === value);
    if (matches.length === 1) return { action: 'merge', candidate: matches[0], strategy, score: 1 };
    if (matches.length > 1) return { action: 'review', candidate: null, candidates: matches, strategy: `${strategy}_collision`, score: 1 };
  }

  const recordKey = record.canonicalKey || record.canonical_key || canonicalKey(record.name, record.unit || record.package_size);
  const exact = list.filter(candidate => {
    const key = candidateValue(candidate, 'canonicalKey', 'canonical_key') || canonicalKey(candidate.name, candidate.unit || candidate.package_size);
    return key === recordKey;
  });
  if (recordKey && exact.length === 1) return { action: 'merge', candidate: exact[0], strategy: 'canonical_key', score: 1 };
  if (exact.length > 1) return { action: 'review', candidate: null, candidates: exact, strategy: 'canonical_key_collision', score: 1 };

  const ranked = list
    .map(candidate => ({ candidate, score: nameSimilarity(record.name, candidate.name) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < reviewThreshold) return { action: 'create', candidate: null, strategy: 'no_match', score: best?.score || 0 };

  const second = ranked[1];
  const ambiguous = second && Math.abs(best.score - second.score) < 0.03;
  if (best.score >= automaticThreshold && !ambiguous) {
    return { action: 'merge', candidate: best.candidate, strategy: 'name_high_confidence', score: best.score };
  }
  return {
    action: 'review',
    candidate: best.candidate,
    candidates: ranked.slice(0, 3).map(item => item.candidate),
    strategy: ambiguous ? 'name_ambiguous' : 'name_similarity',
    score: best.score,
  };
}
