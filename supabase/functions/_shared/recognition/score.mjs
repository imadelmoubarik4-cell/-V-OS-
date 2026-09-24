// Recognition, step 3: deterministic scoring (design §5.3, SCORER_VERSION).
//
// Points are summed per candidate, then the conflict rules cap them, then
// the capped points are calibrated to a probability (bands.mjs). The rules
// override points:
//   R1 barcode dominates: an exact identifier ranks first.
//   R2 barcode conflict: the code says A but the label reads another brand or
//      flavour -> at most Medium, both shown.
//   R3 size conflict -> cap 55; case vs single unit -> cap 70.
//   R4 flavour/variant conflict -> cap 35 (keeps the Giffard siblings apart).
//   R5 product-type conflict -> cap 45 (syrup vs liqueur).
//   R6 archived item -> cap 60, never pre-selected.
//   R7 one code on several active items -> no pre-selection, Medium.
//   R8 unreadable image -> Low.
//   Brand conflict (explicit brand differs) -> cap 40; brand absent from a
//   brand-less item's name -> cap 55.
// An exact identifier with a conflict is held at Medium (cap 75) so the
// person sees both the coded item and what the label says.

import { matchKey, matchTokens as baseMatchTokens, parsePackage } from "../product-identity.mjs";
import { bandFor, calibrate, percent, preselectFor, SCORER_VERSION } from "./bands.mjs";
import { candidateSentence, evidence, formatPack } from "./explain.mjs";
import { classForCategory } from "./retrieve.mjs";
import { collapseAcronyms, variantSet } from "./extract.mjs";

const matchTokens = (value) => baseMatchTokens(collapseAcronyms(value));

export { SCORER_VERSION };

export const POINTS = Object.freeze({
  code_gtin_client: 95,
  code_gtin_case_client: 92,
  code_gtin_ocr: 80,
  code_other_client: 92,
  code_other_ocr: 70,
  code_supplier_scoped: 92,
  code_supplier_scoped_ocr: 85,
  code_supplier_unscoped: 60,
  code_retired: 20,
  identity: 40,
  name_key: 32,
  match_key: 30,
  alias_approved: 32,
  alias_legacy: 28,
  alias_recipe: 8,
  item_in_label: 24,
  label_in_item: 18,
  typed_exact: 20,
  words: 20,
  brand: 12,
  variant: 8,
  size: 10,
  class: 4,
  text_trigram: 12,
  text_fts: 8,
  in_session: 3,
  on_order: 6,
  supplier: 3,
  prior_confirmations: 6,
  prior_wrong: -5,
});

export const CAPS = Object.freeze({
  size: 55,
  case_vs_unit: 70,
  variant: 35,
  class: 45,
  inactive: 60,
  brand_different: 40,
  brand_absent: 55,
  identifier_conflict: 75,
});

// Product types that labels and the taxonomy legitimately mix up.
const COMPATIBLE_CLASSES = [
  ["spirit", "liqueur"], ["syrup", "bar_ingredient"], ["produce", "garnish"], ["dairy_alt", "coffee_tea"],
  ["wine", "sparkling"], ["non_alcoholic", "beer_cider"], ["food", "bar_ingredient"], ["garnish", "bar_ingredient"],
];
function classesCompatible(a, b) {
  return a === b || COMPATIBLE_CLASSES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

function sameSet(a, b) {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const right = new Set(b);
  const shared = new Set(a.filter((token) => right.has(token))).size;
  return shared / new Set([...a, ...b]).size;
}

function packCompare(read, item) {
  if (!read || !item || read.unit_quantity === null || item.unit_quantity === null) return "unknown";
  if (read.unit_base !== item.unit_base) return "size_conflict";
  const larger = Math.max(read.unit_quantity, item.unit_quantity);
  if (Math.abs(read.unit_quantity - item.unit_quantity) > larger * 0.02) return "size_conflict";
  if ((read.units_per_pack ?? 1) !== (item.units_per_pack ?? 1)) return "case_vs_unit";
  return "same";
}

// Case-level codes make the count unit a case; the pack comparison then
// compares against the case of the item.
function codePack(hit, itemPack) {
  if (!hit || hit.pack_level === "unit" || !itemPack) return null;
  return { ...itemPack, units_per_pack: Number(hit.units_in_pack) || itemPack.units_per_pack };
}

// Exact identifier of a candidate, from its code hits and the code signals
// the detection carried (client scan beats OCR digits).
function identifierFor(normalized, features) {
  const signals = normalized.codes ?? [];
  let best = null;
  for (const hit of features.code_matches ?? []) {
    const matching = signals.filter((signal) => signal.kind === hit.kind);
    const client = matching.some((signal) => signal.source === "client" || signal.source === "typed");
    if (hit.status && hit.status !== "active") {
      const retired = { kind: hit.kind, exact: false, points: POINTS.code_retired, retired: true, hit };
      if (!best || best.points < retired.points) best = retired;
      continue;
    }
    let points;
    let exact = true;
    if (hit.kind === "gtin") {
      points = client ? (hit.pack_level && hit.pack_level !== "unit" ? POINTS.code_gtin_case_client : POINTS.code_gtin_client) : POINTS.code_gtin_ocr;
      if (!client) exact = true;
    } else if (hit.kind === "supplier_ref") {
      if (hit.supplier_scoped) points = client ? POINTS.code_supplier_scoped : POINTS.code_supplier_scoped_ocr;
      else { points = POINTS.code_supplier_unscoped; exact = false; }
    } else {
      points = client ? POINTS.code_other_client : POINTS.code_other_ocr;
      exact = client;
    }
    const candidate = { kind: hit.kind, exact, points, source: client ? "client" : "ocr", hit, supplier_scoped: Boolean(hit.supplier_scoped) };
    if (!best || candidate.points > best.points) best = candidate;
  }
  return best;
}

// Scores one candidate { item_id, item, aliases, features } for a
// normalized detection. method: 'trigram' | 'fts' | 'local'.
export function scoreCandidate(normalized, candidate, { method = "fts" } = {}) {
  const item = candidate.item ?? {};
  const features = candidate.features ?? {};
  const entries = [];
  const caps = [];
  const conflicts = [];
  let points = 0;
  const active = item.active !== false && features.inactive !== true;
  const itemTokens = matchTokens([item.brand, item.product_name, item.variant, item.name].filter(Boolean).join(" "));
  const aliasTokens = (candidate.aliases ?? []).flatMap((alias) => matchTokens(alias));
  const readTokens = normalized.match_tokens ?? [];

  // Codes (R1).
  const identifier = identifierFor(normalized, features);
  if (identifier) {
    points += identifier.points;
    if (identifier.retired) entries.push(evidence.codeRetired());
    else if (!identifier.exact && identifier.kind === "supplier_ref") entries.push(evidence.codeUnscoped());
    else entries.push(evidence.code(identifier.kind, identifier.source, identifier.hit?.pack_level));
  } else if (!normalized.typed) {
    entries.push(evidence.noCode());
  }

  // Name: the strongest of the key, alias and containment tiers.
  let nameTier = 0;
  let nameEntry = null;
  const alias = (features.alias_matches ?? [])[0];
  if (features.identity_exact) { nameTier = POINTS.identity; nameEntry = evidence.name("identity"); }
  else if (features.name_key_exact) { nameTier = POINTS.name_key; nameEntry = evidence.name("name"); }
  else if (features.match_key_exact) { nameTier = POINTS.match_key; nameEntry = evidence.name("match"); }
  if (alias) {
    const weak = alias.alias_kind === "recipe_label";
    const aliasPoints = weak ? POINTS.alias_recipe : alias.status === "approved" ? POINTS.alias_approved : POINTS.alias_legacy;
    if (aliasPoints > nameTier) { nameTier = aliasPoints; nameEntry = evidence.alias(alias.alias, weak); }
    else entries.push(evidence.alias(alias.alias, weak));
  }
  if (!nameTier && readTokens.length) {
    const nameOnly = itemTokens.filter((token) => token);
    const readSet = new Set(readTokens);
    const itemSet = new Set([...nameOnly]);
    const brandRead = normalized.brand && normalized.brand_confidence >= 70 ? matchTokens(normalized.brand) : [];
    const enough = nameOnly.length >= 2 || (nameOnly.length === 1 && brandRead.includes(nameOnly[0]));
    if (enough && nameOnly.every((token) => readSet.has(token))) {
      nameTier = POINTS.item_in_label; nameEntry = evidence.name("item_in_label");
    } else if (readTokens.length >= 2 && readTokens.every((token) => itemSet.has(token) || aliasTokens.includes(token))) {
      nameTier = POINTS.label_in_item; nameEntry = evidence.name("label_in_item");
    } else if (readTokens.length === 1 && readTokens[0].length >= 6 && nameOnly[0] === readTokens[0]
      && !brandRead.includes(readTokens[0])) {
      // One distinctive word that heads the item name ("Kolsýrukútur").
      nameTier = POINTS.label_in_item; nameEntry = evidence.name("label_in_item");
    }
  }
  points += nameTier;
  if (nameEntry) entries.push(nameEntry);
  // Typed text is the person's own words: an exact key or product alias hit
  // stands in for the brand, size and type a label would add.
  const productAlias = alias && alias.alias_kind !== "recipe_label";
  if (normalized.typed && (features.identity_exact || features.name_key_exact || features.match_key_exact || productAlias)) {
    points += POINTS.typed_exact;
  }
  const overlap = Math.max(jaccard(readTokens, itemTokens), jaccard(readTokens, [...new Set([...itemTokens, ...aliasTokens])]) * 0.9);
  if (overlap > 0) {
    points += overlap * POINTS.words;
    if (!nameEntry) entries.push(evidence.words(Math.round(overlap * 100)));
  }
  const textScore = Math.max(0, Number(features.text_score) || 0);
  points += method === "fts" ? Math.min(1, textScore * 10) * POINTS.text_fts : Math.min(1, textScore) * POINTS.text_trigram;

  // Brand.
  if (normalized.brand && normalized.brand_confidence >= 70) {
    const brandTokens = matchTokens(normalized.brand);
    const itemBrandKey = item.brand_key ?? (item.brand ? matchKey(item.brand) : null);
    const inName = brandTokens.length > 0 && brandTokens.every((token) => itemTokens.includes(token) || aliasTokens.includes(token));
    if (inName || (itemBrandKey && itemBrandKey === normalized.brand_key)) {
      points += POINTS.brand;
      entries.push(evidence.brand(normalized.brand));
    } else if (itemBrandKey && normalized.brand_confidence >= 80) {
      caps.push({ cap: CAPS.brand_different, rule: "brand" });
      conflicts.push("brand");
      entries.push(evidence.brandDifferent(normalized.brand, item.brand));
    } else if (normalized.brand_confidence >= 80) {
      caps.push({ cap: CAPS.brand_absent, rule: "brand_absent" });
      entries.push(evidence.brandAbsent(normalized.brand));
    }
  } else if (!normalized.typed && !identifier) {
    entries.push(evidence.brandMissing());
  }

  // Variant (R4).
  const readVariants = normalized.variant_tokens ?? [];
  const itemVariants = variantSet(itemTokens);
  if (readVariants.length && itemVariants.length) {
    if (sameSet(readVariants, itemVariants)) {
      points += POINTS.variant;
      entries.push(evidence.variant(normalized.variant_read ?? readVariants.join(" ")));
    } else {
      caps.push({ cap: CAPS.variant, rule: "variant" });
      conflicts.push("variant");
      entries.push(evidence.variantDifferent(normalized.variant_read ?? readVariants.join(" ")));
    }
  } else if (itemVariants.length && !readVariants.length && !identifier && !normalized.typed) {
    entries.push(evidence.variantMissing());
  }

  // Size (R3).
  const itemPackRaw = parsePackage(item);
  const itemPack = itemPackRaw.unit_quantity === null ? null : itemPackRaw;
  const comparedPack = codePack(identifier?.hit, itemPack) ?? itemPack;
  const read = normalized.pack ?? {};
  const readPack = read.unit_quantity === null || read.unit_quantity === undefined ? null : read;
  const packResult = packCompare(readPack, comparedPack);
  const weakSize = !readPack || read.inferred || (read.confidence ?? 0) < 60;
  if (packResult === "same") {
    if (!features.identity_exact) points += POINTS.size;
    entries.push(evidence.size(formatPack(readPack)));
  } else if (packResult === "size_conflict") {
    if (!weakSize) { caps.push({ cap: CAPS.size, rule: "size" }); conflicts.push("size"); }
    entries.push(evidence.sizeDifferent(formatPack(readPack), formatPack(comparedPack)));
  } else if (packResult === "case_vs_unit") {
    if (!weakSize) { caps.push({ cap: CAPS.case_vs_unit, rule: "case_vs_unit" }); conflicts.push("case_vs_unit"); }
    entries.push(evidence.caseVsUnit(formatPack(readPack), formatPack(comparedPack)));
  } else if (read.inferred) {
    entries.push(evidence.sizeGuessed());
  } else if (!readPack && !normalized.typed && !identifier) {
    entries.push(evidence.sizeMissing());
  }

  // Packaging reading (display only).
  if (normalized.packaging_type && !normalized.typed) entries.push(evidence.packaging(normalized.packaging_type));

  // Product type (R5).
  const itemClass = item.item_class ?? classForCategory(item.category, item.subcategory);
  if (normalized.item_class && itemClass) {
    if (normalized.item_class === itemClass) {
      points += POINTS.class;
    } else if (!classesCompatible(normalized.item_class, itemClass) && normalized.class_confidence >= 60) {
      caps.push({ cap: CAPS.class, rule: "class" });
      conflicts.push("class");
      entries.push(evidence.classDifferent(normalized.item_class, itemClass));
    }
  }

  // Context priors and outcome history.
  if (features.in_session) { points += POINTS.in_session; entries.push(evidence.inSession(features.counted_in_session)); }
  if (features.on_order) { points += POINTS.on_order; entries.push(evidence.onOrder()); }
  if (features.supplier_match) { points += POINTS.supplier; entries.push(evidence.supplier()); }
  const confirmations = Number(features.prior_confirmations) || 0;
  const wrong = Number(features.prior_wrong) || 0;
  if (confirmations >= 2 && wrong === 0) { points += POINTS.prior_confirmations; entries.push(evidence.priorConfirmed(confirmations)); }
  if (wrong > 0) { points += POINTS.prior_wrong; entries.push(evidence.priorWrong(wrong)); }

  // R6 archived.
  if (!active) {
    caps.push({ cap: CAPS.inactive, rule: "inactive" });
    entries.push(evidence.inactive());
  }

  // An exact identifier with a label conflict (R2) stays visible at Medium.
  const LABEL_RULES = ["brand", "brand_absent", "variant", "class", "size", "case_vs_unit"];
  const exact = Boolean(identifier?.exact);
  // A brand missing from a brand-less item name is no conflict for a coded match.
  let effectiveCaps = caps.filter((entry) => !(exact && entry.rule === "brand_absent")).map((entry) => entry.cap);
  const labelConflicts = conflicts.filter((rule) => LABEL_RULES.includes(rule));
  if (exact && labelConflicts.length) {
    effectiveCaps = caps.filter((entry) => !LABEL_RULES.includes(entry.rule)).map((entry) => entry.cap);
    effectiveCaps.push(CAPS.identifier_conflict);
    const readText = [normalized.brand, normalized.variant_read].filter(Boolean).join(" ") || "something else";
    entries.unshift(evidence.codeConflict(item.name, readText));
    conflicts.push("code_conflict");
  }
  // Typed text was not "detected" on a label.
  if (normalized.typed) {
    for (const entry of entries) if (entry.polarity === "for") entry.text = entry.text.replace(/ detected$/, " matches");
  }
  const capped = Math.max(0, Math.min(points, ...(effectiveCaps.length ? effectiveCaps : [Infinity])));
  const p = calibrate(capped);
  return {
    item_id: candidate.item_id ?? item.id,
    item,
    aliases: candidate.aliases ?? [],
    active,
    points: Math.round(points * 10) / 10,
    capped_points: Math.round(capped * 10) / 10,
    caps: caps.map((entry) => entry.rule),
    conflicts: [...new Set(conflicts)],
    exact_identifier: exact ? { kind: identifier.kind, source: identifier.source, pack_level: identifier.hit?.pack_level ?? "unit",
      units_in_pack: identifier.hit?.units_in_pack ?? null, supplier_scoped: identifier.supplier_scoped } : null,
    p,
    percent: percent(p),
    evidence: entries,
    features,
  };
}

// Scores and ranks every candidate. R1: an exact identifier ranks first.
export function rankCandidates(normalized, candidates, options = {}) {
  const scored = (candidates ?? []).map((candidate) => scoreCandidate(normalized, candidate, options));
  scored.sort((a, b) => Number(Boolean(b.exact_identifier) && b.active && !b.conflicts.includes("code_conflict"))
      - Number(Boolean(a.exact_identifier) && a.active && !a.conflicts.includes("code_conflict"))
    || b.p - a.p || b.capped_points - a.capped_points || Number(b.active) - Number(a.active)
    || String(a.item?.name ?? "").localeCompare(String(b.item?.name ?? "")));
  return scored.map((entry, index) => ({ ...entry, rank: index + 1, explanation: candidateSentence(index + 1, entry.item?.name ?? "Item", entry.p, entry.evidence) }));
}

// Band, pre-selection and reason for one detection.
export function decideDetection(normalized, ranked, { mode = "identify", collision = false } = {}) {
  const exactActive = ranked.filter((entry) => entry.exact_identifier && entry.active);
  const codeCollision = collision || new Set(exactActive.filter((entry) => entry.exact_identifier.kind !== "supplier_ref"
    || entry.exact_identifier.supplier_scoped).map((entry) => entry.item_id)).size > 1;
  const decision = bandFor(ranked, { unreadable: !normalized.readable, collision: codeCollision });
  return {
    band: decision.band,
    reason: decision.reason,
    collision: codeCollision,
    preselected_item_id: codeCollision ? null : preselectFor(decision.band, ranked, mode),
  };
}

// ---------------------------------------------------------------------------
// Field-specific confidence (owner §6, design §5.5): 0-100 or null.
// ---------------------------------------------------------------------------
export function fieldConfidence(detection, normalized, ranked, decision, { context = {} } = {}) {
  const top = ranked[0] ?? null;
  const d = detection ?? {};
  const present = [d.brand, d.product_name, d.variant].filter((field) => field?.value).map((field) => field.confidence);
  const codeAgrees = Boolean(top?.exact_identifier) && !top.conflicts.includes("code_conflict");
  let identity = present.length ? Math.min(...present) : null;
  if (codeAgrees) identity = Math.max(identity ?? 0, 95);

  let brand = d.brand?.value ? d.brand.confidence : null;
  if (codeAgrees && d.brand?.value && top.evidence.some((entry) => entry.signal === "brand" && entry.polarity === "for")) brand = 99;

  const variant = d.variant?.value ? d.variant.confidence : null;

  let category = null;
  const topClass = top ? (top.item.item_class ?? classForCategory(top.item.category, top.item.subcategory)) : null;
  if (normalized.item_class && topClass) {
    category = top.conflicts.includes("class") ? Math.min(normalized.class_confidence, 30)
      : normalized.item_class === topClass ? Math.max(normalized.class_confidence, 80) : Math.min(normalized.class_confidence, 70);
  } else if (normalized.item_class) category = normalized.class_confidence;
  else if (codeAgrees && topClass) category = 90;

  const packageType = d.packaging_type?.value ? d.packaging_type.confidence : null;

  let unitSize = d.unit_size && (d.unit_size.quantity !== null || d.unit_size.text) ? d.unit_size.confidence : null;
  if (unitSize !== null && normalized.pack?.inferred) unitSize = Math.min(unitSize, 40);
  if (unitSize !== null && top?.conflicts.includes("size")) unitSize = Math.min(unitSize, 50);

  let packageSize = d.units_per_case?.value ? d.units_per_case.confidence : null;
  if (top?.exact_identifier?.pack_level && top.exact_identifier.pack_level !== "unit") packageSize = 95;

  const clientCode = (normalized.codes ?? []).some((code) => code.source === "client" && code.kind === "gtin");
  const ocrCode = (normalized.codes ?? []).some((code) => code.source === "ocr" && code.kind === "gtin");
  const barcode = clientCode ? 99 : ocrCode ? 70 : 0;

  const inventoryMatch = top ? percent(top.p) : null;

  let supplierMatch = null;
  if (top?.exact_identifier?.kind === "supplier_ref" && top.exact_identifier.supplier_scoped) supplierMatch = 95;
  else if (top && (top.features.on_order || top.features.supplier_match)) supplierMatch = 80;
  else if (top && (context.supplier_id || context.purchase_order_id)) supplierMatch = 45;
  else if (top?.item?.supplier_id) supplierMatch = 50;

  return {
    identity, brand, variant, category, package_type: packageType, unit_size: unitSize, package_size: packageSize,
    barcode, inventory_match: inventoryMatch, supplier_match: supplierMatch,
  };
}
