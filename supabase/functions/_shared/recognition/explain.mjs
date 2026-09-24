// Recognition evidence wording (owner §7). Every sentence comes from these
// templates; the vision model never writes an explanation. English,
// sentence case (redesign §5.9 and owner gate G8).

import { percent } from "./bands.mjs";

export function formatSize(quantity, base) {
  if (quantity === null || quantity === undefined || !base) return null;
  if (base === "ml") return quantity >= 1000 && quantity % 100 === 0 ? `${trim(quantity / 1000)} L` : `${trim(quantity)} ml`;
  if (base === "g") return quantity >= 1000 && quantity % 100 === 0 ? `${trim(quantity / 1000)} kg` : `${trim(quantity)} g`;
  return `${trim(quantity)} pcs`;
}

function trim(value) {
  return String(Math.round(Number(value) * 1000) / 1000);
}

export function formatPack(pack) {
  if (!pack || pack.unit_quantity === null || pack.unit_quantity === undefined) return null;
  const size = formatSize(pack.unit_quantity, pack.unit_base);
  return pack.units_per_pack ? `${trim(pack.units_per_pack)} x ${size}` : size;
}

const quote = (value) => `"${String(value ?? "").replace(/"/g, "'").slice(0, 80)}"`;

// Evidence entries: { signal, polarity: 'for' | 'against' | 'missing', text }.
export const evidence = Object.freeze({
  code: (kind, source, packLevel) => ({
    signal: "code", polarity: "for",
    text: kind === "gtin"
      ? `${source === "ocr" ? "barcode digits read from the label" : "barcode scanned"} and linked to this item${packLevel && packLevel !== "unit" ? ` (${packLevel} barcode)` : ""}`
      : kind === "supplier_ref" ? "supplier product number matches" : kind === "sku" ? "SKU matches" : "code matches this item",
  }),
  codeUnscoped: () => ({ signal: "code", polarity: "for", text: "supplier product number matches, supplier not confirmed" }),
  codeRetired: () => ({ signal: "code", polarity: "against", text: "this code was linked to the item before and is retired" }),
  codeConflict: (itemName, read) => ({ signal: "code_conflict", polarity: "against", text: `The barcode is linked to ${itemName}, but the label reads ${quote(read)}` }),
  codeCollision: () => ({ signal: "code_collision", polarity: "against", text: "the same code is linked to more than one item" }),
  noCode: () => ({ signal: "code", polarity: "missing", text: "no readable barcode" }),
  brand: (read) => ({ signal: "brand", polarity: "for", text: `${quote(String(read).toUpperCase())} detected` }),
  brandDifferent: (read, itemBrand) => ({ signal: "brand", polarity: "against", text: `different brand (label reads ${quote(read)}${itemBrand ? `, item is ${itemBrand}` : ""})` }),
  brandAbsent: (read) => ({ signal: "brand", polarity: "against", text: `brand ${quote(read)} is not in this item's name` }),
  brandMissing: () => ({ signal: "brand", polarity: "missing", text: "no brand visible" }),
  variant: (read) => ({ signal: "variant", polarity: "for", text: `${quote(String(read).toUpperCase())} detected` }),
  variantDifferent: (read) => ({ signal: "variant", polarity: "against", text: `different flavour (label reads ${quote(read)})` }),
  variantMissing: () => ({ signal: "variant", polarity: "missing", text: "flavour or variant not readable" }),
  name: (kind) => ({
    signal: "name", polarity: "for",
    text: kind === "identity" ? "name and package match this item" : kind === "name" ? "name matches this item"
      : kind === "match" ? "name matches in another spelling or language" : kind === "item_in_label" ? "every word of the item name is on the label"
        : "the words read are all in this item's name",
  }),
  alias: (alias, weak) => ({ signal: "alias", polarity: "for", text: weak ? `matches a recipe label (${quote(alias)}), weak evidence` : `existing inventory alias matched (${quote(alias)})` }),
  words: (share) => ({ signal: "words", polarity: "for", text: `${share}% of the words agree` }),
  size: (text) => ({ signal: "size", polarity: "for", text: `${text} detected` }),
  sizeDifferent: (read, item) => ({ signal: "size", polarity: "against", text: `different size (${read} vs ${item})` }),
  caseVsUnit: (read, item) => ({ signal: "size", polarity: "against", text: `case and single unit (${read} vs ${item})` }),
  sizeGuessed: () => ({ signal: "size", polarity: "missing", text: "size not printed (guessed from the shape)" }),
  sizeMissing: () => ({ signal: "size", polarity: "missing", text: "size not readable" }),
  packaging: (type) => ({ signal: "packaging", polarity: "for", text: `${type} packaging detected` }),
  classAgrees: () => ({ signal: "class", polarity: "for", text: "same kind of product" }),
  classDifferent: (read, item) => ({ signal: "class", polarity: "against", text: `different kind of product (${read.replace(/_/g, " ")} vs ${String(item).replace(/_/g, " ")})` }),
  inactive: () => ({ signal: "inactive", polarity: "against", text: "matches an archived item" }),
  inSession: (counted) => ({ signal: "context", polarity: "for", text: counted ? "already counted in this session" : "part of this count" }),
  onOrder: () => ({ signal: "context", polarity: "for", text: "on this purchase order" }),
  supplier: () => ({ signal: "context", polarity: "for", text: "from this supplier" }),
  priorConfirmed: (count) => ({ signal: "history", polarity: "for", text: `confirmed for this label ${count} times before` }),
  priorWrong: (count) => ({ signal: "history", polarity: "against", text: `reported as a wrong match ${count} ${count === 1 ? "time" : "times"}` }),
});

// "Candidate 1 — Giffard Vanille Syrup, 91%: "GIFFARD" detected · ..."
export function candidateSentence(rank, name, p, entries) {
  const parts = (entries ?? []).map((entry) => entry.text).filter(Boolean);
  return `Candidate ${rank} — ${name}, ${percent(p)}%${parts.length ? `: ${parts.join(" · ")}` : ""}`.slice(0, 2000);
}

export function detectionSummary(band, top, reason) {
  if (band === "high" && top) return `Likely ${top.item.name}. Check it and confirm before using it.`;
  if (band === "medium" && top) return `Possible matches found. Choose the right product${reason === "code_conflict" ? "; the barcode and the label disagree" : ""}.`;
  if (reason === "unreadable") return "No confident Atlas inventory match found. The photo could not be read clearly.";
  return "No confident Atlas inventory match found.";
}

// Actions per band and mode (owner §8, §12, §13). Labels in sentence case.
export function actionsFor(band, mode) {
  if (mode === "count") {
    return band === "low"
      ? ["retry_scan", "search_inventory", "view_possible_matches", "create_new_product_draft"]
      : ["save_and_scan_next", "open_item", "wrong_product"];
  }
  if (mode === "add_product") return ["use_existing_item", "review_draft"];
  if (mode === "receiving") return band === "low" ? ["search_inventory", "view_possible_matches"] : ["use_for_receiving", "wrong_product"];
  return band === "low"
    ? ["retry_scan", "search_inventory", "view_possible_matches", "ask_atlas", "create_new_product_draft"]
    : ["open_item", "count_item", "view_recipes", "ask_atlas", "wrong_product"];
}
