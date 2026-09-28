// Shared helpers for the Flavor Intelligence data scripts (S95).
// Pure functions, no I/O. Used by build_flavor_item_links.mjs,
// build_flavor_seed.mjs and tests/node/flavor-migrations.test.js.

import { createHash } from "node:crypto";

// Search key for an alias or an inventory name: lower case, Icelandic letters
// spelled out (þ -> th, ð -> d, æ -> ae), accents stripped, anything that is
// not a letter or digit collapsed to one space. Matches the flavor_aliases
// alias_key check '^[a-z0-9]+( [a-z0-9]+)*$'.
export function aliasKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/þ/g, "th")
    .replace(/ð/g, "d")
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Deterministic UUID: the md5 of a key, formatted as a uuid. Identical to
// SQL md5(key)::uuid, so replays and re-seeds keep the same ids.
export function md5Uuid(key) {
  const hex = createHash("md5").update(String(key), "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const ingredientId = (slug) => md5Uuid(`flavor:${slug}`);
export const preparationId = (slug) => md5Uuid(`flavor-prep:${slug}`);
export const edgeId = ({ a, a_prep = null, b, b_prep = null, relation, evidence_type }) =>
  md5Uuid(`flavor-edge:${a}|${a_prep ?? ""}|${b}|${b_prep ?? ""}|${relation}|${evidence_type}`);

export const RELATIONS = Object.freeze(["complement", "contrast", "bridge", "substitute"]);
export const EVIDENCE_TYPES = Object.freeze(["scientific", "culinary", "atlas_learned", "ai_interpretation"]);
export const USES = Object.freeze(["cocktail", "mocktail", "coffee", "dessert", "food"]);
export const TASTE_KEYS = Object.freeze(["sweet", "sour", "bitter", "salty", "umami", "fat", "alcohol", "astringency"]);
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ALIAS_KEY_RE = /^[a-z0-9]+( [a-z0-9]+)*$/;

export function stableJson(value) {
  return JSON.stringify(value, null, 1) + "\n";
}
