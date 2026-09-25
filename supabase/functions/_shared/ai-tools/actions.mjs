import { nowMillis } from "./helpers.mjs";
// Atlas AI proposals: the Draft → Execute boundary.
//
// Draft tools call `buildProposal(kind, command, meta)`; nothing changes.
// The atlas-ai runtime stores the proposal (atlas_ai_action_create) and, when
// a person taps Approve, re-loads the stored command
// (atlas_ai_action_transition proposed → executing) and calls
// `executeProposal(kind, storedCommand, ctx)`. The model has no path to this
// function: it is not in the tool registry.
//
// executeProposal re-validates the stored command against the kind's strict
// schema, re-checks the verified actor's role against the kind's required
// roles, and runs the normal Atlas command with the user's own JWT (or the
// owning Atlas gateway), so every database and gateway check still applies.

import { S, UUID_PATTERN, validateArgs } from "./schema.mjs";
import { createServices, ServiceError } from "./services.mjs";
import { formatIsk, formatNumber, record, routeFor } from "./result.mjs";

const MANAGERS = ["admin", "manager"];
const OPERATIONAL = ["admin", "manager", "bartender"];

export const COUNT_UNITS = Object.freeze(["inventory", "bottle", "case", "unit", "litre", "millilitre", "kilogram", "gram"]);
export const TEAM_CHANNELS = Object.freeze(["general", "operations", "shift-handover", "announcements", "marketing"]);
export const MESSAGE_LINK_TYPES = Object.freeze(["none", "inventory_item", "routine", "shift"]);
export const ARTICLE_TYPES = Object.freeze(["policy", "sop", "checklist", "training", "reference", "live_resource"]);
export const TARGET_ROLES = Object.freeze(["all", "admin", "manager", "bartender", "viewer"]);

const nullableText = (max) => S.nullable(S.string(null, { minLength: 0, maxLength: max }));

const COMMAND_SCHEMAS = {
  "purchase_order.create": S.object({
    p_id: S.uuid(),
    p_action: S.enum(["create"]),
    p_supplier_id: S.uuid(),
    p_lines: S.array(S.object({
      item_id: S.uuid(),
      quantity: S.number(null, { minimum: 0.0001, maximum: 1000000 }),
      unit_cost: S.number(null, { minimum: 0, maximum: 100000000 }),
    }), null, { minItems: 1, maxItems: 100 }),
    p_note: S.string(null, { minLength: 0, maxLength: 2000 }),
    p_expected_delivery_date: S.nullable(S.date()),
  }),
  // Adds lines to the supplier's existing Draft instead of a second draft.
  // p_lines is the draft's full line set after the change (update replaces
  // lines); p_version guards against a draft that changed since preparing.
  "purchase_order.update_draft": S.object({
    p_id: S.uuid(),
    p_action: S.enum(["update"]),
    p_version: S.integer(null, { minimum: 1 }),
    p_supplier_id: S.uuid(),
    p_lines: S.array(S.object({
      item_id: S.uuid(),
      quantity: S.number(null, { minimum: 0.0001, maximum: 1000000 }),
      unit_cost: S.number(null, { minimum: 0, maximum: 100000000 }),
    }), null, { minItems: 1, maxItems: 100 }),
    p_note: S.string(null, { minLength: 0, maxLength: 2000 }),
    p_expected_delivery_date: S.nullable(S.date()),
  }),
  "purchase_order.receive": S.object({
    p_id: S.uuid(),
    p_action: S.enum(["receive_lines"]),
    p_version: S.integer(null, { minimum: 1 }),
    p_receipt: S.array(S.object({
      item_id: S.uuid(),
      quantity: S.number(null, { minimum: 0.0001, maximum: 1000000 }),
      unit_cost: S.nullable(S.number(null, { minimum: 0, maximum: 100000000 })),
      note: nullableText(1000),
    }), null, { minItems: 1, maxItems: 100 }),
    p_request_id: S.uuid(),
  }),
  "stock_count.draft": S.object({
    title: S.string(null, { maxLength: 220 }),
    scope_type: S.enum(["all", "category", "location"]),
    scope_value: nullableText(220),
    notes: nullableText(3000),
    client_request_id: S.uuid(),
    entries: S.array(S.object({
      item_id: S.uuid(),
      item_name: S.string(null, { maxLength: 300 }),
      quantity: S.number(null, { minimum: 0, maximum: 1000000 }),
      unit: S.enum(COUNT_UNITS),
      note: nullableText(2000),
    }), null, { minItems: 1, maxItems: 100 }),
  }),
  "shift.draft": S.object({
    week_start: S.date(),
    person_id: S.uuid(),
    person_name: S.string(null, { maxLength: 200 }),
    role_name: nullableText(120),
    starts_local: S.localDateTime(),
    ends_local: S.localDateTime(),
    break_minutes: S.integer(null, { minimum: 0, maximum: 720 }),
    note: nullableText(3000),
  }),
  "team_message.send": S.object({
    channel_key: S.enum(TEAM_CHANNELS),
    body: S.string(null, { maxLength: 4000 }),
    link_type: S.enum(MESSAGE_LINK_TYPES),
    link_key: nullableText(200),
    link_label: nullableText(200),
    client_request_id: S.uuid(),
  }),
  "knowledge.draft": S.object({
    article_id: S.nullable(S.uuid()),
    title: S.string(null, { maxLength: 220 }),
    summary: nullableText(3000),
    content: S.string(null, { maxLength: 250000 }),
    category_id: S.uuid(),
    category_name: nullableText(200),
    article_type: S.enum(ARTICLE_TYPES),
    target_roles: S.array(S.enum(TARGET_ROLES), null, { minItems: 1, maxItems: 5 }),
    required: S.boolean(),
    change_note: nullableText(3000),
  }),
  "settings.suggestion": S.object({
    section: S.string(null, { maxLength: 60 }),
    change: S.string(null, { maxLength: 1000 }),
    reason: nullableText(1000),
  }),
  "catalog.alias": S.object({
    request_id: S.uuid(),
    item_id: S.uuid(),
    item_name: S.string(null, { maxLength: 300 }),
    alias: S.string(null, { maxLength: 200 }),
    alias_kind: S.enum(["product_name", "supplier_name", "ocr_variant", "legacy_name"]),
    language: S.nullable(S.enum(["is", "en", "fr", "other"])),
    reason: nullableText(500),
    recognition_request_id: S.nullable(S.uuid()),
  }),
  "catalog.new_item": S.object({
    request_id: S.uuid(),
    values: S.object({
      name: S.string(null, { maxLength: 200 }),
      brand: S.nullable(S.string(null, { maxLength: 120 })),
      variant: S.nullable(S.string(null, { maxLength: 120 })),
      category: S.nullable(S.string(null, { maxLength: 120 })),
      item_class: S.nullable(S.string(null, { maxLength: 40 })),
      packaging_type: S.nullable(S.string(null, { maxLength: 40 })),
      unit: S.nullable(S.string(null, { maxLength: 40 })),
      unit_size_quantity: S.nullable(S.number(null, { minimum: 0.001, maximum: 1000000 })),
      unit_size_base: S.nullable(S.enum(["ml", "g", "count"])),
      units_per_case: S.nullable(S.integer(null, { minimum: 1, maximum: 1000 })),
    }),
    codes: S.array(S.object({ kind: S.enum(["gtin", "sku", "other_barcode"]), code: S.string(null, { maxLength: 64 }) }), null, { minItems: 0, maxItems: 5 }),
    notes: nullableText(1000),
    duplicate_candidates: S.array(S.uuid(), null, { minItems: 0, maxItems: 10 }),
    recognition_request_id: S.nullable(S.uuid()),
  }),
  "catalog.wrong_match": S.object({
    request_id: S.uuid(),
    item_id: S.uuid(),
    item_name: S.string(null, { maxLength: 300 }),
    suggested_item_id: S.nullable(S.uuid()),
    suggested_item_name: nullableText(300),
    note: S.string(null, { maxLength: 1000 }),
    recognition_request_id: S.nullable(S.uuid()),
  }),
  "par_level.suggestion": S.object({
    cover_days: S.number(null, { minimum: 1, maximum: 60 }),
    items: S.array(S.object({
      item_id: S.uuid(),
      item_name: S.string(null, { maxLength: 300 }),
      current_par: S.nullable(S.number()),
      suggested_par: S.number(null, { minimum: 0 }),
      cases: S.nullable(S.number()),
    }), null, { minItems: 1, maxItems: 100 }),
  }),
};

// Per kind: who may approve/execute, and whether Atlas runs anything at all.
export const PROPOSAL_KINDS = Object.freeze({
  "purchase_order.create": { roles: MANAGERS, executable: true, subject: "purchase_order" },
  "purchase_order.update_draft": { roles: MANAGERS, executable: true, subject: "purchase_order" },
  "purchase_order.receive": { roles: MANAGERS, executable: true, subject: "purchase_order" },
  "stock_count.draft": { roles: OPERATIONAL, executable: true, subject: "stock_count" },
  "shift.draft": { roles: MANAGERS, executable: true, subject: "shift_week" },
  "team_message.send": { roles: OPERATIONAL, executable: true, subject: "team_channel" },
  "knowledge.draft": { roles: MANAGERS, executable: true, subject: "knowledge_article" },
  "settings.suggestion": { roles: MANAGERS, executable: false, subject: "settings" },
  "par_level.suggestion": { roles: MANAGERS, executable: false, subject: "par_levels" },
  // Catalogue proposals: approving the card only submits a PENDING request
  // (atlas_catalog_request_create, source ai_proposal); a manager decides it
  // in the approval queue. Nothing is created, linked or merged here.
  "catalog.alias": { roles: OPERATIONAL, executable: true, subject: "inventory_item" },
  "catalog.new_item": { roles: OPERATIONAL, executable: true, subject: "inventory_item" },
  "catalog.wrong_match": { roles: OPERATIONAL, executable: true, subject: "inventory_item" },
});

// Roles that may execute this exact command (announcements are manager-only).
export function requiredRolesFor(kind, command) {
  const definition = PROPOSAL_KINDS[kind];
  if (!definition) return [];
  if (kind === "team_message.send" && command?.channel_key === "announcements") return [...MANAGERS];
  return [...definition.roles];
}

export function validateCommand(kind, command) {
  const schema = COMMAND_SCHEMAS[kind];
  if (!schema) return { ok: false, errors: [`unknown proposal kind ${kind}`] };
  return validateArgs(schema, command);
}

// ---------------------------------------------------------------------------
// Previews: exactly what will and will not change, in plain language.
// ---------------------------------------------------------------------------

export function buildPreview(kind, command, extras = {}) {
  switch (kind) {
    case "purchase_order.create": {
      const names = extras.itemNames || {};
      const total = command.p_lines.reduce((sum, line) => sum + line.quantity * line.unit_cost, 0);
      return {
        headline: `Draft purchase order for ${extras.supplierName || "the supplier"}`,
        lines: command.p_lines.map((line) => ({
          label: names[line.item_id] || line.item_id,
          detail: `${formatNumber(line.quantity)} ${extras.itemUnits?.[line.item_id] || "units"} × ${formatIsk(line.unit_cost)} = ${formatIsk(line.quantity * line.unit_cost)}`,
        })),
        totals: { lines: command.p_lines.length, estimated_total: total, estimated_total_label: formatIsk(total) },
        recipients: [],
        will_change: ["A new purchase order is saved in Purchasing with status Draft."],
        will_not_change: [
          "The order is not placed or sent to the supplier.",
          "Stock and item costs do not change.",
        ],
        route: routeFor("purchase_order", command.p_id),
      };
    }
    case "purchase_order.update_draft": {
      const names = extras.itemNames || {};
      const units = extras.itemUnits || {};
      const before = extras.previousQuantities || {};
      const total = command.p_lines.reduce((sum, line) => sum + line.quantity * line.unit_cost, 0);
      const addedCount = command.p_lines.filter((line) => !Object.hasOwn(before, line.item_id)).length;
      const changedCount = command.p_lines.filter((line) => Object.hasOwn(before, line.item_id) && before[line.item_id] !== line.quantity).length;
      return {
        headline: `Add to the draft purchase order for ${extras.supplierName || "the supplier"}`,
        lines: command.p_lines.map((line) => {
          const was = Object.hasOwn(before, line.item_id) ? before[line.item_id] : null;
          const marker = was === null ? "new line: " : was !== line.quantity ? `was ${formatNumber(was)}, now ` : "unchanged: ";
          return {
            label: names[line.item_id] || line.item_id,
            detail: `${marker}${formatNumber(line.quantity)} ${units[line.item_id] || "units"} × ${formatIsk(line.unit_cost)} = ${formatIsk(line.quantity * line.unit_cost)}`,
          };
        }),
        totals: {
          lines: command.p_lines.length,
          estimated_total: total,
          estimated_total_label: formatIsk(total),
          previous_total: Number.isFinite(extras.previousTotal) ? extras.previousTotal : null,
          previous_total_label: Number.isFinite(extras.previousTotal) ? formatIsk(extras.previousTotal) : null,
        },
        recipients: [],
        will_change: [
          `The existing Draft order for ${extras.supplierName || "the supplier"} is updated: ${[addedCount ? `${addedCount} ${addedCount === 1 ? "line" : "lines"} added` : null, changedCount ? `${changedCount} ${changedCount === 1 ? "line" : "lines"} changed` : null].filter(Boolean).join(", ") || "no line changes"}. It stays a Draft.`,
        ],
        will_not_change: [
          "No second order is created.",
          "The order is not placed or sent to the supplier.",
          "Stock and item costs do not change.",
          "If the draft was changed in Purchasing after this was prepared, nothing is saved; prepare it again.",
        ],
        route: routeFor("purchase_order", command.p_id),
      };
    }
    case "purchase_order.receive": {
      const names = extras.itemNames || {};
      return {
        headline: `Receive delivery against purchase order ${extras.orderLabel || ""}`.trim(),
        lines: command.p_receipt.map((line) => ({
          label: names[line.item_id] || line.item_id,
          detail: `${formatNumber(line.quantity)} ${extras.itemUnits?.[line.item_id] || "units"} received${line.unit_cost == null ? "" : ` at ${formatIsk(line.unit_cost)}`}`,
        })),
        discrepancies: extras.discrepancies || [],
        recipients: [],
        will_change: [
          "Received quantities are added to stock through the normal receiving command (a restock movement per line).",
          extras.costUpdates ? "Item costs follow the purchasing receipt-cost rule." : "Item costs follow the purchasing receipt-cost rule for any line with a unit cost.",
          "The order moves to partially received or received.",
        ],
        will_not_change: [
          "Items not listed here are not received.",
          "Unexpected items found in the delivery are not added.",
        ],
        route: routeFor("purchase_order", command.p_id),
      };
    }
    case "stock_count.draft":
      return {
        headline: `New stock count with ${command.entries.length} counted ${command.entries.length === 1 ? "line" : "lines"}`,
        lines: command.entries.map((entry) => ({
          label: entry.item_name,
          detail: `${formatNumber(entry.quantity)} ${entry.unit === "inventory" ? "(inventory unit)" : entry.unit}${entry.note ? ` — ${entry.note}` : ""}`,
        })),
        recipients: [],
        will_change: [
          `A new count session "${command.title}" (scope: ${command.scope_type}${command.scope_value ? ` ${command.scope_value}` : ""}) is started in Stock count.`,
          "The counted quantities above are saved as count lines; other lines stay pending.",
        ],
        will_not_change: [
          "Stock does not change now. The count must be submitted and verified by a manager in Stock count first.",
          "No direct stock adjustment is made.",
        ],
        route: routeFor("stock_count"),
      };
    case "shift.draft":
      return {
        headline: `Draft shift for ${command.person_name}`,
        lines: [{
          label: command.person_name,
          detail: `${command.starts_local.replace("T", " ")} – ${command.ends_local.slice(11)}${command.role_name ? ` · ${command.role_name}` : ""}${command.break_minutes ? ` · ${command.break_minutes} min break` : ""}`,
        }],
        recipients: [],
        will_change: [`The shift is saved in the rota for the week of ${command.week_start} as an unpublished change.`],
        will_not_change: [
          "The week is not published and nobody is notified.",
          "Staff keep seeing the last published rota until a manager publishes in Shifts.",
        ],
        warnings: extras.warnings || [],
        route: routeFor("shift_week", command.week_start),
      };
    case "team_message.send":
      return {
        headline: `Message to #${command.channel_key}`,
        lines: [{ label: "Message", detail: command.body }],
        recipients: extras.recipients || [`Everyone with access to #${command.channel_key}`],
        will_change: [
          `The message is posted to #${command.channel_key} under your name.`,
          "Active team members receive the usual Atlas message notification.",
        ],
        will_not_change: ["Nothing else is changed."],
        route: routeFor("team_channel", command.channel_key),
      };
    case "knowledge.draft":
      return {
        headline: `${command.article_id ? "Update draft of" : "New draft article"} "${command.title}"`,
        lines: [
          { label: "Category", detail: command.category_name || command.category_id },
          { label: "Type", detail: command.article_type },
          { label: "Audience", detail: command.target_roles.join(", ") },
          { label: "Summary", detail: command.summary || "—" },
          { label: "Content", detail: `${command.content.length} characters` },
        ],
        recipients: [],
        will_change: ["The article is saved in Knowledge as a draft."],
        will_not_change: [
          "It is not published; staff cannot see it until a manager publishes it in Knowledge.",
          "Nobody is asked to read or acknowledge it.",
        ],
        route: command.article_id ? routeFor("knowledge_article", command.article_id) : routeFor("knowledge"),
      };
    case "settings.suggestion":
      return {
        headline: `Suggested change in Settings (${command.section})`,
        lines: [{ label: "Suggestion", detail: command.change }, ...(command.reason ? [{ label: "Why", detail: command.reason }] : [])],
        recipients: [],
        will_change: [],
        will_not_change: ["Atlas never changes settings. Open Settings to make the change yourself."],
        route: routeFor("settings", command.section),
      };
    case "par_level.suggestion":
      return {
        headline: `Par level suggestions for ${command.items.length} ${command.items.length === 1 ? "item" : "items"} (${formatNumber(command.cover_days)} days cover)`,
        lines: command.items.map((item) => ({
          label: item.item_name,
          detail: `current par ${item.current_par ?? "not set"} → suggested ${formatNumber(item.suggested_par)}${item.cases ? ` (${formatNumber(item.cases)} cases)` : ""}`,
        })),
        recipients: [],
        will_change: [],
        will_not_change: ["Nothing is saved. Open the par editor to review and apply the suggestions."],
        route: routeFor("par_levels"),
      };
    case "catalog.alias":
      return {
        headline: `Add "${command.alias}" as another name for ${command.item_name}`,
        lines: [
          { label: "Item", detail: command.item_name },
          { label: "Other name", detail: `${command.alias} (${command.alias_kind.replace(/_/g, " ")}${command.language ? `, ${command.language}` : ""})` },
          ...(command.reason ? [{ label: "Why", detail: command.reason }] : []),
        ],
        recipients: [],
        will_change: ["A request to add this name is sent to a manager for approval."],
        will_not_change: [
          "Nothing changes until a manager approves it.",
          "Stock, items, costs and suppliers do not change.",
        ],
        route: routeFor("inventory_item", command.item_id),
      };
    case "catalog.new_item": {
      const v = command.values;
      const size = v.unit_size_quantity ? `${formatNumber(v.unit_size_quantity)} ${v.unit_size_base}` : null;
      return {
        headline: `Request a new product: ${v.name}`,
        lines: [
          { label: "Product", detail: [v.brand, v.name, v.variant].filter(Boolean).join(" · ") },
          ...(v.category || v.item_class ? [{ label: "Type", detail: [v.category, v.item_class].filter(Boolean).join(" · ") }] : []),
          ...(size || v.packaging_type ? [{ label: "Package", detail: [v.packaging_type, size, v.units_per_case ? `${v.units_per_case} per case` : null].filter(Boolean).join(" · ") }] : []),
          ...(command.codes.length ? [{ label: "Barcode", detail: command.codes.map((code) => code.code).join(", ") }] : []),
          ...((extras.duplicates ?? []).length ? [{ label: "Possible existing matches", detail: extras.duplicates.join(", ") }] : []),
          ...(command.notes ? [{ label: "Notes", detail: command.notes }] : []),
        ],
        recipients: [],
        will_change: ["A new-product request is sent to a manager, who checks the possible existing matches before creating anything."],
        will_not_change: [
          "No item is created until a manager approves it; it then starts with no stock (not counted).",
          "Stock, costs and suppliers do not change.",
        ],
        route: routeFor("inventory_item"),
      };
    }
    case "catalog.wrong_match":
      return {
        headline: `Report a wrong match: ${command.item_name}`,
        lines: [
          { label: "Matched", detail: command.item_name },
          ...(command.suggested_item_name ? [{ label: "Should be", detail: command.suggested_item_name }] : []),
          { label: "Note", detail: command.note },
        ],
        recipients: [],
        will_change: ["A wrong-match report is sent to a manager to review."],
        will_not_change: ["No code, name, item or stock changes."],
        route: routeFor("inventory_item", command.item_id),
      };
    default:
      return { headline: kind, lines: [], recipients: [], will_change: [], will_not_change: [], route: null };
  }
}

// Proposal object a draft tool returns (the runtime stores it with
// atlas_ai_action_create). Throws on an invalid command: a draft tool must
// never hand the runtime something the executor would reject.
export function buildProposal(kind, command, { title, summary = null, subjectType = null, subjectKey = null, evidence = [], extras = {} } = {}) {
  const definition = PROPOSAL_KINDS[kind];
  if (!definition) throw new Error(`Unknown proposal kind ${kind}`);
  const checked = validateCommand(kind, command);
  if (!checked.ok) throw new Error(`Invalid ${kind} command: ${checked.errors.join("; ")}`);
  const preview = buildPreview(kind, command, extras);
  return {
    kind,
    title: String(title || preview.headline).slice(0, 200),
    summary: summary || preview.headline,
    preview,
    command,
    required_roles: requiredRolesFor(kind, command),
    executable: definition.executable,
    subject_type: subjectType || definition.subject,
    subject_key: subjectKey,
    evidence: evidence.slice(0, 20),
    route: preview.route,
    expires_in_seconds: 86400,
  };
}

// ---------------------------------------------------------------------------
// Execution (human-approved only).
// ---------------------------------------------------------------------------

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

// Fixed messages per code: downstream gateway or database text is never
// passed on (it can name tables, constraints or provider details).
const SERVICE_FAILURE_MESSAGES = Object.freeze({
  forbidden: "Your Atlas role cannot run this action.",
  not_found: "Something this action needs could not be found. Nothing was changed.",
  conflict: "The record changed since this was prepared. Nothing was changed; prepare it again.",
  invalid_arguments: "Atlas refused the details of this action. Nothing was changed.",
  unavailable: "Atlas could not complete this action right now. Nothing was confirmed.",
});

function serviceFailure(error) {
  if (error instanceof ServiceError) {
    const code = error.status === 403 ? "forbidden" : error.status === 404 ? "not_found"
      : error.status === 409 ? "conflict" : error.status === 400 ? "invalid_arguments" : "unavailable";
    return failure(code, SERVICE_FAILURE_MESSAGES[code]);
  }
  return failure("unavailable", SERVICE_FAILURE_MESSAGES.unavailable);
}

async function executeStockCount(command, services) {
  const started = await services.stockCountStart({
    scope_type: command.scope_type,
    scope_value: command.scope_value,
    title: command.title,
    notes: command.notes,
    client_request_id: command.client_request_id,
  });
  const detail = started?.result || started?.detail || {};
  const sessionId = detail?.session?.id;
  if (!sessionId) return failure("unavailable", "The count session could not be confirmed. Check Stock count before retrying.");
  const lines = Array.isArray(detail.lines) ? detail.lines : [];
  const saved = [];
  const notSaved = [];
  for (const entry of command.entries) {
    const line = lines.find((candidate) => String(candidate.inventory_item_id) === entry.item_id);
    if (!line) {
      notSaved.push({ item_id: entry.item_id, item_name: entry.item_name, reason: "Not part of this count session scope" });
      continue;
    }
    try {
      await services.stockCountSaveLine({
        session_id: sessionId,
        line_id: line.id,
        line_status: "counted",
        observed_input_quantity: entry.quantity,
        observed_input_unit: entry.unit,
        count_method: "manual",
        note: entry.note,
        expected_version: Number(line.version) || 1,
        evidence: { source: "atlas_ai", proposal_kind: "stock_count.draft" },
      });
      saved.push({ item_id: entry.item_id, item_name: entry.item_name, quantity: entry.quantity, unit: entry.unit });
    } catch (error) {
      const code = error instanceof ServiceError && error.status === 409 ? "conflict" : "not_saved";
      notSaved.push({ item_id: entry.item_id, item_name: entry.item_name, reason: code === "conflict" ? "The count line changed; save it in Stock count." : "Could not be saved; enter it in Stock count.", code });
    }
  }
  return {
    ok: true,
    result: {
      summary: `Count session started with ${saved.length} of ${command.entries.length} counted lines saved. It now needs submitting and manager verification in Stock count; stock has not changed.`,
      data: { session_id: sessionId, saved, not_saved: notSaved, stock_changed: false },
      records: [record("stock_count", sessionId, command.title)],
    },
  };
}

// Catalogue proposals become PENDING requests in the approval queue, linked
// to the Atlas AI action so the manager's decision is recorded in the Brain.
const UUID_RE = new RegExp(UUID_PATTERN);

async function executeCatalogRequest(kind, command, services, ctx) {
  const common = {
    p_source: "ai_proposal",
    p_ai_action_id: typeof ctx?.actionId === "string" && UUID_RE.test(ctx.actionId) ? ctx.actionId : null,
    p_recognition_request_id: command.recognition_request_id ?? null,
    p_media_id: null,
    p_request_id: `atlas-ai:${command.request_id}`,
    p_self_approve: false,
  };
  let args;
  if (kind === "catalog.alias") {
    args = { ...common, p_kind: "alias", p_subject_item_id: command.item_id,
      p_payload: { item_id: command.item_id, alias: command.alias, alias_kind: command.alias_kind, ...(command.language && command.language !== "other" ? { language: command.language } : {}) },
      p_evidence: { source: "atlas_ai", reason: command.reason } };
  } else if (kind === "catalog.new_item") {
    const values = Object.fromEntries(Object.entries(command.values).filter(([, value]) => value !== null && value !== undefined));
    args = { ...common, p_kind: "new_item", p_subject_item_id: null,
      p_payload: { values, codes: command.codes, aliases: [] },
      p_evidence: { source: "atlas_ai", notes: command.notes, duplicate_candidates_at_draft: command.duplicate_candidates } };
  } else {
    args = { ...common, p_kind: "wrong_match_report", p_subject_item_id: command.item_id,
      p_payload: { item_id: command.item_id, ...(command.suggested_item_id ? { suggested_item_id: command.suggested_item_id } : {}), note: command.note },
      p_evidence: { source: "atlas_ai" } };
  }
  const request = await services.catalogRequestCreate(args);
  const label = kind === "catalog.alias" ? `Name "${command.alias}" for ${command.item_name}`
    : kind === "catalog.new_item" ? `New product ${command.values.name}` : `Wrong match ${command.item_name}`;
  return {
    ok: true,
    result: {
      summary: `${label} sent to a manager for approval (${request?.status ?? "pending"}). Nothing changes until a manager approves it.`,
      data: { change_request_id: request?.id ?? null, status: request?.status ?? "pending", kind: request?.kind ?? args.p_kind, stock_changed: false },
      records: command.item_id ? [record("inventory_item", command.item_id, command.item_name)] : [],
    },
  };
}

// Runs an approved proposal. `storedCommand` is the command returned by
// atlas_ai_action_transition (never a client payload).
export async function executeProposal(kind, storedCommand, ctx) {
  const definition = PROPOSAL_KINDS[kind];
  if (!definition) return failure("not_found", "This kind of action is not known to Atlas.");
  const actor = ctx?.actor;
  if (!actor || actor.active !== true) return failure("forbidden", "An active Atlas profile is required.");
  const checked = validateCommand(kind, storedCommand);
  if (!checked.ok) return failure("invalid_arguments", "The stored action is not valid and was not run.");
  const command = checked.value;
  if (!requiredRolesFor(kind, command).includes(actor.role)) {
    return failure("forbidden", "Your Atlas role cannot approve this action.");
  }
  if (!definition.executable) {
    return failure("not_executable", "Atlas does not make this change. Open the linked screen to review it yourself.");
  }
  // Gateway services only (tests inject them); the runtime's ctx.services
  // ({ rpc } for the Atlas AI tables) is never used to run Atlas commands.
  const services = ctx.services && typeof ctx.services.stockCountStart === "function"
    ? ctx.services
    : createServices({ fetch: ctx.fetch, env: ctx.env, actor, now: nowMillis(ctx) });
  try {
    switch (kind) {
      case "purchase_order.create": {
        // One draft per supplier: another proposal may have saved a draft for
        // this supplier after this one was prepared. A retry of this same
        // order (same p_id) is still allowed through.
        const orders = await services.purchaseOrders();
        const otherDraft = (Array.isArray(orders) ? orders : []).find((order) => order.status === "draft"
          && String(order.supplier_id) === String(command.p_supplier_id)
          && String(order.id) !== String(command.p_id));
        if (otherDraft) {
          return failure("draft_exists", "This supplier already has a Draft order in Purchasing, so Atlas did not create a second one. Ask Atlas again to add these lines to that draft.");
        }
        const order = await services.purchaseOrderCommand({
          p_id: command.p_id,
          p_action: "create",
          p_supplier_id: command.p_supplier_id,
          p_lines: command.p_lines,
          p_note: command.p_note,
          p_expected_delivery_date: command.p_expected_delivery_date,
        });
        return {
          ok: true,
          result: {
            summary: "Draft purchase order saved in Purchasing. It has not been placed with the supplier.",
            data: { order_id: order?.id ?? command.p_id, status: order?.status ?? "draft", version: order?.version ?? null },
            records: [record("purchase_order", order?.id ?? command.p_id, "Draft purchase order")],
          },
        };
      }
      case "purchase_order.update_draft": {
        const order = await services.purchaseOrderCommand({
          p_id: command.p_id,
          p_action: "update",
          p_version: command.p_version,
          p_supplier_id: command.p_supplier_id,
          p_lines: command.p_lines,
          p_note: command.p_note,
          p_expected_delivery_date: command.p_expected_delivery_date,
        });
        return {
          ok: true,
          result: {
            summary: `Draft purchase order updated in Purchasing (${command.p_lines.length} ${command.p_lines.length === 1 ? "line" : "lines"}). It is still a Draft and has not been placed with the supplier.`,
            data: { order_id: order?.id ?? command.p_id, status: order?.status ?? "draft", version: order?.version ?? null, lines: command.p_lines.length },
            records: [record("purchase_order", order?.id ?? command.p_id, "Draft purchase order")],
          },
        };
      }
      case "purchase_order.receive": {
        const receipt = command.p_receipt.map((line) => {
          const entry = { item_id: line.item_id, quantity: line.quantity };
          if (line.unit_cost !== null) entry.unit_cost = line.unit_cost;
          if (line.note) entry.note = line.note;
          return entry;
        });
        const order = await services.purchaseOrderCommand({
          p_id: command.p_id,
          p_action: "receive_lines",
          p_version: command.p_version,
          p_receipt: receipt,
          p_request_id: command.p_request_id,
        });
        return {
          ok: true,
          result: {
            summary: `Delivery received: ${receipt.length} ${receipt.length === 1 ? "line" : "lines"} posted to stock. Order status is now ${order?.status ?? "updated"}.`,
            data: { order_id: command.p_id, status: order?.status ?? null, version: order?.version ?? null, lines_received: receipt.length },
            records: [record("purchase_order", command.p_id, "Purchase order")],
          },
        };
      }
      case "stock_count.draft":
        return await executeStockCount(command, services);
      case "shift.draft": {
        const saved = await services.shiftSave({
          shift_id: null,
          week_start: command.week_start,
          person_id: command.person_id,
          role_name: command.role_name,
          starts_local: command.starts_local,
          ends_local: command.ends_local,
          break_minutes: command.break_minutes,
          note: command.note,
        });
        const shiftId = saved?.result?.shift?.id ?? saved?.result?.id ?? null;
        return {
          ok: true,
          result: {
            summary: `Shift saved for ${command.person_name} as an unpublished change. The week has not been published.`,
            data: { shift_id: shiftId, week_start: command.week_start, published: false },
            records: [record("shift_week", command.week_start, `Week of ${command.week_start}`)],
          },
        };
      }
      case "team_message.send": {
        const sent = await services.teamMessageSend({
          channel_key: command.channel_key,
          body: command.body,
          link_type: command.link_type,
          link_key: command.link_type === "none" ? null : command.link_key,
          client_request_id: command.client_request_id,
        });
        return {
          ok: true,
          result: {
            summary: `Message posted to #${command.channel_key}.`,
            data: { message_id: sent?.result?.message_id ?? null, duplicate: sent?.result?.duplicate === true },
            records: [record("team_channel", command.channel_key, `#${command.channel_key}`)],
          },
        };
      }
      case "knowledge.draft": {
        const saved = await services.knowledgeSaveDraft({
          article_id: command.article_id,
          title: command.title,
          summary: command.summary,
          content: command.content,
          category_id: command.category_id,
          article_type: command.article_type,
          target_roles: command.target_roles,
          required: command.required,
          change_note: command.change_note,
        });
        const articleId = saved?.result?.article?.id ?? saved?.article?.id ?? command.article_id;
        return {
          ok: true,
          result: {
            summary: `"${command.title}" saved in Knowledge as a draft. It is not published.`,
            data: { article_id: articleId ?? null, published: false },
            records: articleId ? [record("knowledge_article", articleId, command.title)] : [],
          },
        };
      }
      case "catalog.alias":
      case "catalog.new_item":
      case "catalog.wrong_match":
        return await executeCatalogRequest(kind, command, services, ctx);
      default:
        return failure("not_executable", "Atlas does not run this kind of action.");
    }
  } catch (error) {
    return serviceFailure(error);
  }
}

export { UUID_PATTERN };
