// Recognition, step 2: candidate retrieval.
//
// Production retrieval is the database: atlas_recognition_candidates (codes,
// aliases, identity/name/match keys, full-text or trigram, brand tokens) and
// atlas_recognition_resolve_codes, both running as the NOLOGIN recognition
// definer that has no write grant on any quantity-bearing table.
//
// The recognition service may call ONLY the atlas_recognition_* RPCs listed
// in RECOGNITION_RPCS; guardedRpc() enforces the allow-list at runtime and a
// static test (tests/node/recognition-no-stock-power.test.js) enforces it in
// the source.
//
// localCandidates() is the JavaScript twin of the SQL feature query over an
// in-memory catalogue. It serves the evaluation harness and the Atlas AI
// fallback when the recognition RPC is not deployed yet. It uses the same
// product-identity keys, so both paths produce the same feature object.

import {
  duplicateKeys, identityKey, matchKey, matchTokens, nameKey, normalizeCode, packKey, parsePackage, searchFoldText,
} from "../product-identity.mjs";

export const RECOGNITION_RPCS = Object.freeze([
  "atlas_recognition_resolve_codes",
  "atlas_recognition_candidates",
  "atlas_recognition_register_media",
  "atlas_recognition_record",
  "atlas_recognition_record_outcome",
  "atlas_recognition_propose",
  "atlas_recognition_find_duplicates",
  "atlas_recognition_my_requests",
  "atlas_recognition_limits",
  "atlas_recognition_request_get",
]);

export class RpcNotAllowedError extends Error {
  constructor(name) {
    super(`The recognition service may not call ${name}.`);
    this.name = "RpcNotAllowedError";
    this.code = "forbidden_rpc";
  }
}

// Wraps a raw rpc(name, args) so only the recognition RPCs can be reached.
export function guardedRpc(rpc) {
  if (typeof rpc !== "function") throw new TypeError("rpc must be a function");
  return async function recognitionRpc(name, args) {
    if (!RECOGNITION_RPCS.includes(name)) throw new RpcNotAllowedError(String(name));
    return rpc(name, args);
  };
}

// ---------------------------------------------------------------------------
// Signals for atlas_recognition_candidates(p_signals, ...)
// ---------------------------------------------------------------------------
export function candidateSignals(normalized, context = {}, { includeInactive = true } = {}) {
  const codes = (normalized.codes ?? []).map((code) => ({
    kind: code.kind, normalized: code.normalized, ...(code.supplier_id ? { supplier_id: code.supplier_id } : {}),
  }));
  const cleanContext = {};
  for (const key of ["count_session_id", "purchase_order_id", "supplier_id"]) {
    if (typeof context?.[key] === "string" && context[key]) cleanContext[key] = context[key];
  }
  return {
    texts: normalized.texts ?? [],
    name_keys: normalized.name_key ? [normalized.name_key] : [],
    match_keys: normalized.match_key ? [normalized.match_key] : [],
    identity_keys: normalized.identity_key ? [normalized.identity_key] : [],
    codes,
    brand: normalized.brand ?? null,
    query: normalized.query ?? null,
    context: cleanContext,
    include_inactive: includeInactive,
  };
}

export async function fetchCandidates(rpc, actor, signals, limit = 25) {
  const result = await rpc("atlas_recognition_candidates", {
    p_signals: signals, p_limit: limit, p_actor_id: actor.userId, p_actor_role: actor.role,
  });
  return {
    method: result?.method ?? "fts",
    candidates: Array.isArray(result?.candidates) ? result.candidates : [],
  };
}

export async function resolveCodes(rpc, actor, codes) {
  if (!codes.length) return { codes: [] };
  const result = await rpc("atlas_recognition_resolve_codes", {
    p_codes: codes.slice(0, 20).map((code) => ({
      kind: code.kind, raw: code.raw ?? code.normalized, ...(code.supplier_id ? { supplier_id: code.supplier_id } : {}),
      ...(code.symbology ? { symbology: code.symbology } : {}),
    })),
    p_actor_id: actor.userId,
    p_actor_role: actor.role,
  });
  return { codes: Array.isArray(result?.codes) ? result.codes : [] };
}

// A unique active item across every valid code, with no collision: the fast
// path (no vision call). Returns { item_id, hits } or null.
export function uniqueCodeHit(resolution) {
  const items = new Set();
  let collision = false;
  const hits = [];
  for (const entry of resolution?.codes ?? []) {
    if (entry.collision) collision = true;
    if (entry.unique_active_item_id) {
      items.add(entry.unique_active_item_id);
      hits.push(entry);
    }
  }
  if (collision || items.size !== 1) return null;
  return { item_id: [...items][0], hits };
}

// ---------------------------------------------------------------------------
// Local twin of atlas_private.recognition_candidate_features.
// catalog item: { id, name, brand, product_name, variant, category,
//   subcategory, item_class, unit, size_ml, package_weight_g, package_size,
//   units_per_case, active, canonical_key, supplier_id, image_url,
//   codes: [{ kind, code, pack_level, units_in_pack, supplier_id, status }],
//   aliases: [{ alias, alias_kind, status }] }
// ---------------------------------------------------------------------------

// JS twin of atlas_private.inventory_class_for_category (taxonomy seed).
const TAXONOMY = [
  ["spirit", ["gin", "vodka", "rum", "tequila / mezcal", "tequila", "mezcal", "whiskey", "whisky", "cognac & brandy", "cognac", "brandy", "aquavit / brennivín", "spirits", "whiskey / cognac"]],
  ["liqueur", ["liqueur", "liqueurs", "bitters", "vermouth / aperitivo", "vermouth", "aperitivo"]],
  ["wine", ["red wine", "white wine", "rosé", "wine"]],
  ["sparkling", ["sparkling", "sparkling wine", "champagne"]],
  ["beer_cider", ["beer & cider", "beer", "cider"]],
  ["non_alcoholic", ["soda & mixer", "mixers", "soft drinks", "juice", "water"]],
  ["syrup", ["syrups", "syrup"]],
  ["bar_ingredient", ["bar ingredients"]],
  ["coffee_tea", ["coffee & hot drinks"]],
  ["dairy_alt", ["dairy", "milk"]],
  ["produce", ["fresh fruit", "fresh herbs", "produce", "citrus"]],
  ["garnish", ["garnish"]],
  ["food", ["dessert", "food"]],
  ["consumable", ["consumables"]],
  ["cleaning", ["cleaning"]],
  ["equipment", ["bar equipment"]],
  ["prep", ["prep batches", "prep"]],
  ["reference", ["reference"]],
];
const SUB_CLASSES = [
  ["dairy_alt", "coffee & hot drinks", ["plant milk", "dairy milk"]],
  ["gas", "bar equipment", ["co2 / gas"]],
];

export function classForCategory(category, subcategory = null) {
  const root = String(category ?? "").split("›")[0].trim().toLowerCase();
  const sub = String(String(category ?? "").split("›")[1] ?? subcategory ?? "").trim().toLowerCase();
  for (const [itemClass, rootName, subs] of SUB_CLASSES) {
    if (root === rootName && subs.includes(sub)) return itemClass;
  }
  for (const [itemClass, names] of TAXONOMY) if (names.includes(root)) return itemClass;
  return null;
}

function aliasIsProductEvidence(alias) {
  const status = alias?.status ?? null;
  const kind = alias?.alias_kind ?? null;
  return (status === "approved" && ["product_name", "supplier_name", "ocr_variant", "legacy_name"].includes(kind))
    || (status === null && kind !== "recipe_label");
}

function aliasListed(alias) {
  return alias?.status === null || alias?.status === undefined || alias?.status === "approved";
}

function itemPayload(item, role) {
  const pack = parsePackage(item);
  const payload = {
    id: item.id, name: item.name, brand: item.brand ?? null, product_name: item.product_name ?? null,
    variant: item.variant ?? null, category: item.category ?? null, subcategory: item.subcategory ?? null,
    item_class: item.item_class ?? classForCategory(item.category, item.subcategory),
    item_class_source: item.item_class ? "item" : "category_map",
    packaging_type: item.packaging_type ?? null, unit: item.unit ?? null,
    unit_size_quantity: item.unit_size_quantity ?? null, unit_size_base: item.unit_size_base ?? null,
    size_ml: item.size_ml ?? null, package_weight_g: item.package_weight_g ?? null, package_size: item.package_size ?? null,
    units_per_case: item.units_per_case ?? null, abv_percent: item.abv_percent ?? null, image_url: item.image_url ?? null,
    bin_location: item.bin_location ?? null, par_level: item.par_level ?? null, active: item.active !== false,
    name_key: nameKey(item), pack_key: packKey(item), identity_key: identityKey(item), match_key: matchKey(item),
    brand_key: item.brand ? matchKey(item.brand) : null,
    pack: pack.unit_quantity === null ? null : pack,
  };
  if (role === "admin" || role === "manager") {
    payload.supplier_id = item.supplier_id ?? null;
    payload.supplier_name = item.supplier_name ?? null;
  }
  return payload;
}

function tokenOverlap(queryTokens, itemTokens) {
  if (!queryTokens.length || !itemTokens.length) return 0;
  const right = new Set(itemTokens);
  const shared = new Set(queryTokens.filter((token) => right.has(token))).size;
  return shared / new Set([...queryTokens, ...itemTokens]).size;
}

// Returns { method: 'local', candidates: [...] } in the SQL shape.
export function localCandidates(catalog, signals, { role = "viewer", limit = 25, context = {}, outcomes = [] } = {}) {
  const nameKeys = new Set(signals.name_keys ?? []);
  const matchKeys = new Set(signals.match_keys ?? []);
  const identityKeys = new Set(signals.identity_keys ?? []);
  for (const text of signals.texts ?? []) {
    const nk = nameKey({ name: text });
    const mk = matchKey({ name: text });
    if (nk) nameKeys.add(nk);
    if (mk) matchKeys.add(mk);
  }
  const brandKey = signals.brand ? matchKey(signals.brand) : null;
  const queryTokens = [...new Set(matchTokens([signals.query, ...(signals.texts ?? []), signals.brand].filter(Boolean).join(" ")))];
  const codes = (signals.codes ?? []).filter((code) => code?.normalized);
  const includeInactive = signals.include_inactive !== false;
  const sessionItems = new Set(context.session_item_ids ?? []);
  const countedItems = new Set(context.counted_item_ids ?? []);
  const orderItems = new Set(context.order_item_ids ?? []);
  const supplierId = signals.context?.supplier_id ?? null;

  const rows = [];
  for (const item of catalog) {
    if (String(item.unit ?? "").toLowerCase() === "untracked") continue;
    const itemClass = item.item_class ?? classForCategory(item.category, item.subcategory);
    if (["reference", "prep"].includes(itemClass)) continue;
    if (item.active === false && !includeInactive) continue;
    const keys = duplicateKeys(item);
    const itemNameKey = nameKey(item);
    const itemMatchKey = keys.match_key;
    const itemIdentity = identityKey(item);
    const itemBrandKey = item.brand ? matchKey(item.brand) : null;
    const itemTokens = itemMatchKey ? itemMatchKey.split(" ") : [];

    const codeMatches = [];
    for (const code of item.codes ?? []) {
      const normalized = normalizeCode(code.code ?? code.normalized, { kind: code.kind });
      if (!normalized.valid) continue;
      for (const signal of codes) {
        if (signal.kind !== code.kind || signal.normalized !== normalized.normalized) continue;
        if (code.kind === "supplier_ref" && signal.supplier_id && code.supplier_id && signal.supplier_id !== code.supplier_id) continue;
        codeMatches.push({
          kind: code.kind, pack_level: code.pack_level ?? "unit", units_in_pack: code.units_in_pack ?? null,
          status: code.status ?? "active", origin: code.origin ?? "codes",
          supplier_scoped: code.kind === "supplier_ref" && Boolean(signal.supplier_id),
        });
      }
    }
    const aliasMatches = (item.aliases ?? [])
      .filter((alias) => aliasListed(alias) && matchKeys.has(matchKey({ name: alias.alias })))
      .map((alias) => ({ alias: alias.alias, alias_kind: alias.alias_kind ?? "unclassified", status: alias.status ?? "legacy" }));
    const identityExact = Boolean(itemIdentity) && identityKeys.has(itemIdentity);
    const nameKeyExact = Boolean(itemNameKey) && nameKeys.has(itemNameKey);
    const matchKeyExact = Boolean(itemMatchKey) && matchKeys.has(itemMatchKey);
    const aliasTokens = (item.aliases ?? []).filter(aliasIsProductEvidence).flatMap((alias) => matchTokens(alias.alias));
    const textScore = Math.round(Math.max(tokenOverlap(queryTokens, itemTokens),
      tokenOverlap(queryTokens, [...new Set([...itemTokens, ...aliasTokens])]) * 0.9) * 1000) / 1000;
    const brandMatch = Boolean(brandKey) && (itemBrandKey === brandKey || itemTokens.includes(brandKey));
    const inPool = codeMatches.length || aliasMatches.length || identityExact || nameKeyExact || matchKeyExact
      || textScore >= 0.25 || brandMatch;
    if (!inPool) continue;
    const confirmations = outcomes.filter((outcome) => outcome.item_id === item.id && outcome.match_key && matchKeys.has(outcome.match_key)
      && ["confirmed_preselected", "chose_candidate", "chose_by_search"].includes(outcome.outcome)).length;
    const wrong = outcomes.filter((outcome) => outcome.top_item_id === item.id && outcome.outcome === "wrong_product").length;
    rows.push({
      item_id: item.id,
      item: itemPayload(item, role),
      aliases: (item.aliases ?? []).filter(aliasIsProductEvidence).map((alias) => alias.alias).sort(),
      features: {
        code_matches: codeMatches,
        alias_matches: aliasMatches,
        identity_exact: identityExact,
        name_key_exact: nameKeyExact,
        match_key_exact: matchKeyExact,
        text_score: textScore,
        brand_match: brandMatch,
        in_session: sessionItems.has(item.id),
        counted_in_session: countedItems.has(item.id),
        on_order: orderItems.has(item.id),
        supplier_match: Boolean(supplierId) && item.supplier_id === supplierId,
        prior_confirmations: confirmations,
        prior_wrong: wrong,
        inactive: item.active === false,
      },
    });
  }
  rows.sort((a, b) => b.features.code_matches.length - a.features.code_matches.length
    || Number(b.features.identity_exact) - Number(a.features.identity_exact)
    || Number(b.features.match_key_exact) - Number(a.features.match_key_exact)
    || b.features.text_score - a.features.text_score
    || String(a.item.name).localeCompare(String(b.item.name)));
  return { method: "local", candidates: rows.slice(0, Math.max(1, Math.min(50, limit))) };
}

// Local twin of atlas_recognition_resolve_codes over the same catalogue.
export function localResolveCodes(catalog, codes) {
  return {
    codes: codes.map((entry) => {
      const normalized = normalizeCode(entry.raw ?? entry.normalized, { kind: entry.kind });
      const matches = [];
      if (normalized.valid) {
        for (const item of catalog) {
          for (const code of item.codes ?? []) {
            const stored = normalizeCode(code.code ?? code.normalized, { kind: code.kind });
            if (!stored.valid || code.kind !== normalized.kind || stored.normalized !== normalized.normalized) continue;
            if (code.kind === "supplier_ref" && entry.supplier_id && code.supplier_id && code.supplier_id !== entry.supplier_id) continue;
            matches.push({ item_id: item.id, name: item.name, active: item.active !== false, code_status: code.status ?? "active",
              kind: code.kind, pack_level: code.pack_level ?? "unit", units_in_pack: code.units_in_pack ?? null });
          }
        }
      }
      const active = [...new Set(matches.filter((match) => match.active && match.code_status === "active").map((match) => match.item_id))];
      return {
        input: entry, kind: normalized.kind, normalized: normalized.normalized, valid: normalized.valid, reason: normalized.reason,
        matches, unique_active_item_id: active.length === 1 ? active[0] : null, collision: active.length > 1,
      };
    }),
  };
}

export function foldForSearch(value) {
  return searchFoldText(value);
}
