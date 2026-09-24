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
  "purchase_order.receive": { roles: MANAGERS, executable: true, subject: "purchase_order" },
  "stock_count.draft": { roles: OPERATIONAL, executable: true, subject: "stock_count" },
  "shift.draft": { roles: MANAGERS, executable: true, subject: "shift_week" },
  "team_message.send": { roles: OPERATIONAL, executable: true, subject: "team_channel" },
  "knowledge.draft": { roles: MANAGERS, executable: true, subject: "knowledge_article" },
  "settings.suggestion": { roles: MANAGERS, executable: false, subject: "settings" },
  "par_level.suggestion": { roles: MANAGERS, executable: false, subject: "par_levels" },
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

function serviceFailure(error) {
  if (error instanceof ServiceError) {
    const code = error.status === 403 ? "forbidden" : error.status === 404 ? "not_found"
      : error.status === 409 ? "conflict" : error.status === 400 ? "invalid_arguments" : "unavailable";
    return failure(code, error.message);
  }
  return failure("unavailable", "Atlas could not complete this action right now. Nothing was confirmed.");
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
      notSaved.push({ item_id: entry.item_id, item_name: entry.item_name, reason: error instanceof Error ? error.message : "Save failed" });
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
  const services = ctx.services || createServices({ fetch: ctx.fetch, env: ctx.env, actor, now: ctx.now });
  try {
    switch (kind) {
      case "purchase_order.create": {
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
      default:
        return failure("not_executable", "Atlas does not run this kind of action.");
    }
  } catch (error) {
    return serviceFailure(error);
  }
}

export { UUID_PATTERN };
