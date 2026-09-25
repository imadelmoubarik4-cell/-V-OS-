// Recognition bands, calibration and field-confidence display rules
// (owner requirements §5 and §6; design §5.3-§5.5).
//
// Plain dependency-free ESM shared by the atlas-inventory-recognition Edge
// Function, the Atlas AI tools and the Node evaluation harness.
//
// Bands:
//   high    rank 1 is an active item matched by an exact identifier (barcode,
//           SKU or supplier reference) with no conflict rule, p >= 0.90 and a
//           margin of >= 0.15 to rank 2. Atlas may pre-select it; a person
//           still confirms before anything is counted, received or changed.
//   medium  rank 1 p >= 0.60 but not high. Ranked candidates with evidence;
//           the person chooses. Nothing is selected.
//   low     rank 1 p < 0.60, an unreadable image or no candidates. "No
//           confident Atlas inventory match found." The unknown-item flow.

export const SCORER_VERSION = "rs-1";
export const EXTRACTOR_VERSION = "rx-2";

export const BANDS = Object.freeze(["high", "medium", "low"]);

export const BAND_RULES = Object.freeze({
  high_min_p: 0.9,
  high_min_margin: 0.15,
  medium_min_p: 0.6,
});

// Monotone piecewise-linear map from summed points to a probability
// (design §5.3, version 1). The evaluation harness reports the calibration
// table per bin; a refit is a code change that goes through CI.
export const CALIBRATION = Object.freeze([
  [0, 0], [40, 0.4], [60, 0.65], [80, 0.85], [100, 0.95], [130, 0.99],
]);

export function calibrate(points) {
  const value = Number(points);
  if (!Number.isFinite(value) || value <= 0) return 0;
  for (let index = 1; index < CALIBRATION.length; index += 1) {
    const [x1, y1] = CALIBRATION[index];
    const [x0, y0] = CALIBRATION[index - 1];
    if (value <= x1) return Math.round((y0 + ((value - x0) / (x1 - x0)) * (y1 - y0)) * 1000) / 1000;
  }
  return CALIBRATION[CALIBRATION.length - 1][1];
}

export function percent(p) {
  return Math.round(Math.max(0, Math.min(1, Number(p) || 0)) * 100);
}

// The owner's field list (§6), in display order.
export const FIELD_KEYS = Object.freeze([
  "identity", "brand", "variant", "category", "package_type", "unit_size", "package_size", "barcode",
  "inventory_match", "supplier_match",
]);

// UI rule for every mode (design §5.5): >= 90 plain, 60-89 "check", < 60 not
// shown as fact (drafts leave the field empty and offer the reading as a
// suggestion chip).
export function fieldState(confidence) {
  if (confidence === null || confidence === undefined) return "unknown";
  if (confidence >= 90) return "sure";
  if (confidence >= 60) return "check";
  return "not_sure";
}

export const BAND_COPY = Object.freeze({
  high: { label: "Sure", headline: "Likely match. Check it and confirm." },
  medium: { label: "Check", headline: "Which product is this?" },
  low: { label: "Not sure", headline: "No confident Atlas inventory match found." },
});

// Band for one detection from its ranked, scored candidates.
//   ranked[i] = { item_id, p, active, exact_identifier, conflicts: [...] }
//   options   = { unreadable, collision }
export function bandFor(ranked, { unreadable = false, collision = false } = {}) {
  const top = ranked[0];
  if (unreadable && !(top && top.exact_identifier)) return { band: "low", reason: "unreadable" };
  if (!top) return { band: "low", reason: "no_candidates" };
  const second = ranked[1];
  const margin = top.p - (second ? second.p : 0);
  const conflicted = top.conflicts.length > 0;
  if (top.exact_identifier && !conflicted && !collision && top.active
      && top.p >= BAND_RULES.high_min_p && margin >= BAND_RULES.high_min_margin) {
    return { band: "high", reason: "exact_identifier" };
  }
  if (top.p >= BAND_RULES.medium_min_p) {
    let reason = "strong_text_match";
    if (collision) reason = "code_collision";
    else if (top.exact_identifier && conflicted) reason = "code_conflict";
    else if (!top.active) reason = "archived_item";
    else if (top.exact_identifier && margin < BAND_RULES.high_min_margin) reason = "close_second";
    else if (top.exact_identifier) reason = "identifier_not_decisive";
    return { band: "medium", reason };
  }
  return { band: "low", reason: "weak_match" };
}

// Only the active rank-1 item of a High detection is ever pre-selected, and
// never while adding a new product (that flow must show duplicates).
export function preselectFor(band, ranked, mode) {
  if (band !== "high" || mode === "add_product") return null;
  const top = ranked[0];
  return top && top.active ? top.item_id : null;
}
