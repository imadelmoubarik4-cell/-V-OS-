// The recognition pipeline, shared by the atlas-inventory-recognition Edge
// Function (browser: stock count, identify, add product, receiving) and the
// Atlas AI tools (in process). Every dependency is injected:
//
//   deps.rpc(name, args)       guarded: atlas_recognition_* only (retrieve.mjs)
//   deps.actor                 { userId, role, label } — the verified actor
//   deps.vision(input) | null  { imageDataUrl, mode } -> callVision() result;
//                              null when photo recognition is not configured
//   deps.visionReason          why vision is null ('not_configured', 'disabled', ...)
//
// It returns candidates, bands, field confidence and evidence. It never
// saves a count, links a code, creates an alias or item, or changes stock:
// the only write is the recognition audit (atlas_recognition_record), and
// every response carries stock_changed: false.

import { BAND_COPY, EXTRACTOR_VERSION, fieldState, SCORER_VERSION } from "./bands.mjs";
import {
  codeSignals, emptyDetection, normalizeClientBarcode, normalizeDetection, RECOGNITION_MODES, RecognitionError,
  textDetection,
} from "./extract.mjs";
import { actionsFor, detectionSummary } from "./explain.mjs";
import { candidateSignals, fetchCandidates, resolveCodes, uniqueCodeHit } from "./retrieve.mjs";
import { decideDetection, fieldConfidence, rankCandidates } from "./score.mjs";
import { matchTokens } from "../product-identity.mjs";

export { RecognitionError };

export const MODE_ALIASES = Object.freeze({ stock_count: "count", count: "count", identify: "identify", add_product: "add_product", receiving: "receiving", ai: "ai", search: "search" });
export const RESPONSE_CANDIDATES = 5;
const RECORDED_CANDIDATES = 10;
const MAX_CLIENT_BARCODES = 10;

export function normalizeMode(value) {
  const mode = MODE_ALIASES[String(value ?? "identify").trim().toLowerCase()];
  if (!mode || !RECOGNITION_MODES.includes(mode)) throw new RecognitionError("invalid_request", "Mode must be stock_count, identify, add_product, receiving or ai.", 400);
  return mode;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizeContext(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const context = {};
  for (const key of ["count_session_id", "purchase_order_id", "supplier_id", "conversation_id"]) {
    if (source[key] === undefined || source[key] === null || source[key] === "") continue;
    if (typeof source[key] !== "string" || !UUID.test(source[key])) throw new RecognitionError("invalid_request", `${key} must be an Atlas id.`, 400);
    context[key] = source[key].toLowerCase();
  }
  if (typeof source.location === "string" && source.location.trim()) context.location = source.location.trim().slice(0, 80);
  return context;
}

function compactNormalized(normalized) {
  return {
    name_key: normalized.name_key, match_key: normalized.match_key, identity_key: normalized.identity_key,
    brand_key: normalized.brand_key, variant_tokens: normalized.variant_tokens, item_class: normalized.item_class,
    pack_key: normalized.pack_key, codes: normalized.codes.map(({ kind, normalized: code, source }) => ({ kind, normalized: code, source })),
    code_conflict: normalized.code_conflict, readable: normalized.readable, typed: normalized.typed,
  };
}

function candidateView(entry) {
  return {
    rank: entry.rank,
    item_id: entry.item_id,
    item: entry.item,
    score: entry.p,
    percent: entry.percent,
    explanation: entry.explanation,
    evidence: entry.evidence,
    exact_identifier: entry.exact_identifier,
    conflicts: entry.conflicts,
    flags: {
      inactive: !entry.active,
      in_session: entry.features?.in_session === true,
      counted_in_session: entry.features?.counted_in_session === true,
      on_order: entry.features?.on_order === true,
    },
  };
}

function readView(detection, normalized, clientCodes) {
  const client = clientCodes.find((code) => code.valid) ?? null;
  return {
    brand: detection.brand,
    product_name: detection.product_name,
    variant: detection.variant,
    category_class: detection.category_class,
    subcategory: detection.subcategory,
    packaging_type: detection.packaging_type,
    unit_size: detection.unit_size,
    units_per_case: detection.units_per_case,
    barcode: client
      ? { value: client.raw, normalized: client.normalized, source: "scan", confidence: 99 }
      : detection.barcode_digits?.value ? { value: detection.barcode_digits.value, normalized: null, source: "label", confidence: detection.barcode_digits.confidence } : null,
    sku_or_supplier_ref: detection.sku_or_supplier_ref,
    abv_percent: detection.abv_percent,
    language: detection.language,
    visible_units: detection.visible_units ?? { value: null, confidence: 0, evidence: null },
    visible_text: detection.visible_text,
    code_conflict: normalized.code_conflict,
  };
}

// Scores one detection against the catalogue through the recognition RPCs.
async function scoreDetection(deps, detection, normalized, { mode, context, codeResolution, clientCodes }) {
  const signals = candidateSignals(normalized, context);
  const { method, candidates } = await fetchCandidates(deps.rpc, deps.actor, signals, 15);
  const ranked = rankCandidates(normalized, candidates, { method });
  const collision = (codeResolution?.codes ?? []).some((entry) => entry.collision
    && normalized.codes.some((code) => code.kind === entry.kind && code.normalized === entry.normalized));
  const decision = decideDetection(normalized, ranked, { mode, collision });
  const confidence = fieldConfidence(detection, normalized, ranked, decision, { context });
  return { detection, normalized, ranked, decision, confidence, method, clientCodes };
}

function detectionView(scored, index, mode) {
  const { detection, normalized, ranked, decision, confidence, clientCodes } = scored;
  const top = ranked[0] ?? null;
  return {
    detection_id: null,
    detection_index: index,
    bbox: detection.bbox,
    band: decision.band,
    band_label: BAND_COPY[decision.band].label,
    reason: decision.reason,
    summary: detectionSummary(decision.band, top, decision.reason),
    in_atlas: decision.band !== "low",
    preselected_item_id: decision.preselected_item_id,
    read: readView(detection, normalized, clientCodes),
    field_confidence: confidence,
    field_state: Object.fromEntries(Object.entries(confidence).map(([key, value]) => [key, fieldState(value)])),
    candidates: ranked.slice(0, RESPONSE_CANDIDATES).map(candidateView),
    more_candidates: Math.max(0, ranked.length - RESPONSE_CANDIDATES),
    actions: actionsFor(decision.band, mode),
  };
}

function recordDetection(scored, index) {
  const { detection, normalized, ranked, decision, confidence } = scored;
  return {
    detection_index: index,
    bbox: detection.bbox,
    extracted: detection,
    normalized: compactNormalized(normalized),
    field_confidence: confidence,
    band: decision.band,
    preselected_item_id: decision.preselected_item_id,
    candidates: ranked.slice(0, RECORDED_CANDIDATES).map((entry) => ({
      rank: entry.rank,
      item_id: entry.item_id,
      score: entry.p,
      features: {
        ...entry.features,
        points: entry.points, capped_points: entry.capped_points, caps: entry.caps, conflicts: entry.conflicts,
        exact_identifier: entry.exact_identifier, evidence: entry.evidence,
      },
      explanation: entry.explanation,
    })),
  };
}

// Attaches client barcodes to vision detections: a single detection takes
// them all; with several, a code goes to the detection whose printed digits
// match and the rest become their own barcode-only detection.
function assignCodes(detections, clientCodes) {
  const assigned = detections.map(() => []);
  const leftovers = [];
  if (detections.length === 1) return { assigned: [clientCodes], leftovers };
  for (const code of clientCodes) {
    const target = detections.findIndex((detection) => {
      const digits = String(detection.barcode_digits?.value ?? "").replace(/[^0-9]/g, "");
      return digits && code.raw && digits === String(code.raw).replace(/[^0-9]/g, "");
    });
    if (target >= 0) assigned[target].push(code);
    else leftovers.push(code);
  }
  return { assigned, leftovers };
}

// The identify pipeline. input = { client_request_id, mode, context,
// client_barcodes, image: { dataUrl } | null, media: { media_id, expires_at }
// | null }.
export async function identify(deps, input) {
  const mode = normalizeMode(input.mode);
  const context = normalizeContext(input.context);
  const clientRequestId = String(input.client_request_id ?? "");
  if (!UUID.test(clientRequestId)) throw new RecognitionError("invalid_request", "client_request_id must be an Atlas id.", 400);
  const rawCodes = Array.isArray(input.client_barcodes) ? input.client_barcodes : [];
  if (rawCodes.length > MAX_CLIENT_BARCODES) throw new RecognitionError("invalid_request", `Send at most ${MAX_CLIENT_BARCODES} barcodes.`, 400);
  const clientCodes = rawCodes.map(normalizeClientBarcode).filter((code) => code.raw);
  const hasImage = Boolean(input.image?.dataUrl);
  if (!clientCodes.length && !hasImage) throw new RecognitionError("invalid_request", "Send a photo or a barcode.", 400);
  const supplierId = context.supplier_id ?? null;

  const vision = { configured: typeof deps.vision === "function", used: false, model: null, reason: typeof deps.vision === "function" ? null : (deps.visionReason ?? "not_configured"), ms: null };
  const codeInputs = clientCodes.flatMap((code) => codeSignals(code.raw, { source: "client", supplierId, format: code.format }));
  let codeResolution = { codes: [] };
  if (codeInputs.length) codeResolution = await resolveCodes(deps.rpc, deps.actor, codeInputs);

  let method = "barcode";
  let status = "completed";
  let failureCode = null;
  let imageQuality = null;
  const scoredDetections = [];

  // Fast path: a client barcode that resolves to one active item. No vision
  // call (unless a new product is being added: attributes must be read).
  // With a photo as well, the photo is read so a label that contradicts the
  // code (R2) is caught; the browser sends codes alone for the fast path.
  const hit = uniqueCodeHit(codeResolution);
  if (hit && mode !== "add_product" && !(hasImage && typeof deps.vision === "function")) {
    const detection = emptyDetection(0);
    const normalized = normalizeDetection(detection, { clientCodes, supplierId });
    const scored = await scoreDetection(deps, detection, normalized, { mode, context, codeResolution, clientCodes });
    if (scored.decision.band === "high" || !hasImage) {
      scoredDetections.push(scored);
      status = "barcode_only";
    }
  }

  if (!scoredDetections.length) {
    let extraction = null;
    if (hasImage && vision.configured) {
      try {
        const result = await deps.vision({ imageDataUrl: input.image.dataUrl, mode });
        extraction = result.extraction;
        vision.used = true;
        vision.model = result.model ?? null;
        vision.ms = result.ms ?? null;
        vision.cost_usd = result.cost_usd ?? null;
        method = "vision";
      } catch (error) {
        if (!(error instanceof RecognitionError)) throw error;
        vision.reason = error.code;
        failureCode = error.code;
      }
    } else if (hasImage) {
      failureCode = vision.reason;
    }
    if (extraction) {
      imageQuality = extraction.image_quality;
      const { assigned, leftovers } = assignCodes(extraction.detections, clientCodes);
      for (const [index, detection] of extraction.detections.entries()) {
        const normalized = normalizeDetection(detection, { clientCodes: assigned[index], imageQuality, supplierId });
        scoredDetections.push(await scoreDetection(deps, detection, normalized, { mode, context, codeResolution, clientCodes: assigned[index] }));
      }
      if (leftovers.length && scoredDetections.length < 12) {
        const detection = emptyDetection(scoredDetections.length);
        const normalized = normalizeDetection(detection, { clientCodes: leftovers, supplierId });
        scoredDetections.push(await scoreDetection(deps, detection, normalized, { mode, context, codeResolution, clientCodes: leftovers }));
      }
      if (!extraction.detections.length && !leftovers.length && !clientCodes.length) {
        const detection = emptyDetection(0);
        const normalized = normalizeDetection(detection, { imageQuality: imageQuality ?? { usable: false, issues: ["no_product"] } });
        scoredDetections.push(await scoreDetection(deps, detection, normalized, { mode, context, codeResolution, clientCodes: [] }));
      }
    } else if (clientCodes.length) {
      const detection = emptyDetection(0);
      const normalized = normalizeDetection(detection, { clientCodes, supplierId });
      scoredDetections.push(await scoreDetection(deps, detection, normalized, { mode, context, codeResolution, clientCodes }));
      status = "barcode_only";
    } else {
      status = "failed";
    }
  }

  const detections = scoredDetections.slice(0, 12).map((scored, index) => detectionView(scored, index, mode));
  let recorded = null;
  if (deps.record !== false) {
    recorded = await deps.rpc("atlas_recognition_record", {
      p_request: {
        client_request_id: clientRequestId,
        mode,
        context,
        media_id: input.media?.media_id ?? null,
        client_barcodes: clientCodes,
        image_quality: imageQuality,
        vision_model: vision.used ? vision.model : null,
        vision_ms: vision.used ? vision.ms : null,
        vision_cost_usd: vision.used ? vision.cost_usd ?? null : null,
        extractor_version: vision.used ? EXTRACTOR_VERSION : "none",
        scorer_version: SCORER_VERSION,
        status,
        failure_code: failureCode,
        detections: scoredDetections.slice(0, 12).map((scored, index) => recordDetection(scored, index)),
      },
      p_actor_id: deps.actor.userId,
      p_actor_label: deps.actor.label ?? null,
      p_actor_role: deps.actor.role,
    });
    for (const entry of recorded?.detections ?? []) {
      const view = detections.find((detection) => detection.detection_index === Number(entry.detection_index));
      if (view) view.detection_id = entry.detection_id;
    }
  }
  return {
    request_id: recorded?.request_id ?? null,
    client_request_id: clientRequestId,
    replayed: recorded?.replayed === true,
    mode,
    method: scoredDetections.length ? method : "none",
    status,
    failure_code: failureCode,
    vision: { configured: vision.configured, used: vision.used, model: vision.used ? vision.model : null, reason: vision.reason },
    image_quality: imageQuality,
    media: input.media ? { media_id: input.media.media_id, expires_at: input.media.expires_at ?? null } : null,
    detections,
    scorer_version: SCORER_VERSION,
    extractor_version: vision.used ? EXTRACTOR_VERSION : null,
    stock_changed: false,
  };
}

// ---------------------------------------------------------------------------
// Text: the "Search inventory" box and Atlas AI name resolution. Typed text
// is the person's own words; a typed code is treated like a scan.
// ---------------------------------------------------------------------------
const CODE_LIKE = /^[A-Za-z0-9-]{4,40}$/;

export function textNormalized(query, { supplierId = null } = {}) {
  const detection = textDetection(query);
  const normalized = normalizeDetection(detection, { typed: true, supplierId });
  const text = String(query ?? "").trim();
  if (CODE_LIKE.test(text) && /[0-9]/.test(text)) {
    normalized.codes = codeSignals(text, { source: "typed", supplierId });
  }
  return { detection, normalized };
}

// provider(signals) -> { method, candidates } (the RPC or the local twin).
export async function searchText(provider, query, { mode = "search", context = {}, limit = 10 } = {}) {
  const { detection, normalized } = textNormalized(query, { supplierId: context.supplier_id ?? null });
  const { method, candidates } = await provider(candidateSignals(normalized, context));
  const ranked = rankCandidates(normalized, candidates, { method });
  const decision = decideDetection(normalized, ranked, { mode });
  return { detection, normalized, ranked: ranked.slice(0, limit), decision, method };
}

function strongName(entry) {
  if (!entry || !entry.active || entry.conflicts.length) return false;
  if (entry.exact_identifier) return true;
  const f = entry.features ?? {};
  const productAlias = (f.alias_matches ?? []).some((alias) => alias.alias_kind !== "recipe_label");
  return Boolean(f.identity_exact || f.name_key_exact || f.match_key_exact || productAlias);
}

// Canonical name resolution for Atlas AI (inventory.resolve_name,
// inventory.prepare_count, purchasing.compare_delivery). Never guesses
// between several candidates.
//   status: 'unique' | 'ambiguous' | 'none'
export async function resolveName(provider, query, { universe = null, context = {}, limit = 5 } = {}) {
  const text = String(query ?? "").trim();
  if (!text) return { status: "none", match: null, candidates: [], ranked: [], reason: "empty" };
  const result = await searchText(provider, text, { mode: "search", context, limit: 25 });
  const allowed = universe ? new Set(universe.map((row) => String(row.id))) : null;
  const ranked = allowed ? result.ranked.filter((entry) => allowed.has(String(entry.item_id))) : result.ranked;
  const active = ranked.filter((entry) => entry.active);
  const lowerText = text.toLowerCase();
  const exactNames = active.filter((entry) => String(entry.item?.name ?? "").trim().toLowerCase() === lowerText);
  if (exactNames.length === 1) return { status: "unique", match: exactNames[0], candidates: [exactNames[0]], ranked, reason: "exact_name" };

  const strong = active.filter(strongName);
  if (strong.length === 1 || (strong.length > 1 && strong[0].p - strong[1].p >= 0.15)) {
    return { status: "unique", match: strong[0], candidates: [strong[0]], ranked, reason: strong[0].exact_identifier ? "code" : "name_key" };
  }
  if (strong.length > 1) return { status: "ambiguous", match: null, candidates: strong.slice(0, limit), ranked, reason: "several_exact" };

  // Every word of the query in exactly one item's name (the former
  // matchByName rule, on accent- and language-aware tokens).
  const queryTokens = [...new Set(matchTokens(text))];
  const containing = queryTokens.length
    ? active.filter((entry) => {
      const tokens = new Set([
        ...matchTokens([entry.item?.brand, entry.item?.name].filter(Boolean).join(" ")),
        ...(entry.aliases ?? []).flatMap((alias) => matchTokens(alias)),
      ]);
      return queryTokens.every((token) => tokens.has(token));
    })
    : [];
  const clean = containing.filter((entry) => !entry.conflicts.length);
  if (clean.length === 1) return { status: "unique", match: clean[0], candidates: clean, ranked, reason: "all_words" };
  if (containing.length > 0) {
    const sorted = [...containing].sort((a, b) => String(a.item?.name ?? "").length - String(b.item?.name ?? "").length);
    return { status: "ambiguous", match: null, candidates: sorted.slice(0, limit), ranked, reason: clean.length ? "several_contain" : "conflict" };
  }
  const possible = active.filter((entry) => entry.p >= 0.35);
  if (possible.length) return { status: "ambiguous", match: null, candidates: possible.slice(0, limit), ranked, reason: "possible" };
  return { status: "none", match: null, candidates: [], ranked, reason: "no_match" };
}
