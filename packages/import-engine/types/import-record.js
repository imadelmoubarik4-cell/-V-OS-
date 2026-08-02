/** @typedef {'create'|'merge'|'skip'|'review'} ProposedAction */
/** @typedef {'pending'|'approved'|'rejected'|'imported'} ReviewStatus */

export const PROPOSED_ACTIONS = Object.freeze(['create', 'merge', 'skip', 'review']);
export const REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'imported']);

/**
 * @typedef {Object} NormalizedInventoryRecord
 * @property {Record<string, unknown>} rawData
 * @property {string} name
 * @property {string} canonicalKey
 * @property {string|null} category
 * @property {string|null} subcategory
 * @property {string|null} unit
 * @property {number|null} packageQuantity
 * @property {string|null} packageUnit
 * @property {number|null} quantity
 * @property {number|null} costPrice
 * @property {string|null} supplier
 * @property {string|null} sku
 * @property {string|null} barcode
 * @property {string|null} sourceUpdatedAt
 * @property {string[]} issues
 */
