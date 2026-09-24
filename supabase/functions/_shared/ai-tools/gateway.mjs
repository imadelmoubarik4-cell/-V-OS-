import { nowMillis } from "./helpers.mjs";
// Atlas AI Tool Gateway.
//
// runTool enforces, in order: tool exists → actor active → role allowed →
// strict argument validation → caps → execute (user JWT / service RPC with
// the verified actor) → role redaction → audit. The actor always comes from
// the server-built ctx; arguments can never change who the actor is.
//
// ctx = { actor: { userId, role, active, displayName, label, token },
//         env, fetch, now (ms), venue: { timezone, businessDate } | null,
//         conversationId, runId, audit: async (call) => void,
//         services? (injected adapters, e.g. test fakes), limits?, newId? }

import { ATLAS_ROLES, MANAGER_ROLES } from "../auth.mjs";
import { getTool } from "./registry.mjs";
import { validateArgs } from "./schema.mjs";
import { createServices, ServiceError } from "./services.mjs";
import { EVIDENCE_KINDS, fail, ToolError } from "./result.mjs";

export const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 40;

// Commercial fields stripped for bartender/viewer, matching
// atlas-reports reportSources() (cost_price, supplier_id, supplier; movement
// unit_cost/total_cost/supplier_id) plus the derived cost/value/margin fields.
export const COMMERCIAL_KEYS = Object.freeze(new Set([
  "cost_price", "case_cost", "unit_cost", "total_cost", "ordered_unit_cost", "observed_unit_cost",
  "estimated_cost", "estimatedCost", "estimated_value", "estimated_total", "known_value", "inventory_value",
  "estimated_cost_per_serving", "estimated_gross_profit", "estimated_margin_percent",
  "cost", "cost_total", "cost_per_serving", "cost_percent", "margin_percent", "gross_profit_per_serving", "financials",
  "supplier", "supplier_id", "supplierId", "supplier_name", "supplier_product_reference", "suppliers",
  "lead_time_days", "minimum_order_quantity", "manager_notes", "emergency_contacts", "emergency_contact_count",
]));
const COMMERCIAL_SOURCE_TYPES = new Set(["supplier", "purchase_order", "movement"]);
const COMMERCIAL_LABEL = /\b(cost|costs|supplier|suppliers|margin|spend|value of|stock value|price change|ISK)\b/i;

function stripKeys(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((entry) => stripKeys(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (COMMERCIAL_KEYS.has(key)) continue;
    next[key] = stripKeys(entry, depth + 1);
  }
  return next;
}

// Output redaction for the actor's role. Managers receive the tool output as
// is; staff never receive cost or supplier data, even if a tool leaks it.
export function redactForRole(result, role) {
  if (!result?.ok || MANAGER_ROLES.includes(role)) return result;
  const evidence = (result.evidence || []).filter((entry) => !COMMERCIAL_SOURCE_TYPES.has(entry?.source?.type)
    && !COMMERCIAL_LABEL.test(`${entry?.label ?? ""} ${entry?.value ?? ""}`));
  return {
    ...result,
    data: stripKeys(result.data),
    evidence: evidence.map((entry) => stripKeys(entry)),
    records: (result.records || []).filter((entry) => !COMMERCIAL_SOURCE_TYPES.has(entry?.type)),
    proposal: result.proposal ? stripKeys(result.proposal) : null,
  };
}

// Arguments as stored in ai_tool_calls: long free text is reduced to its size.
export function redactArguments(args) {
  const reduce = (value, depth = 0) => {
    if (depth > 6) return "[nested]";
    if (typeof value === "string") return value.length > 160 ? `[${value.length} characters]` : value;
    if (Array.isArray(value)) return value.slice(0, 50).map((entry) => reduce(entry, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, ["body", "content", "summary", "note"].includes(key) && typeof entry === "string" ? `[${entry.length} characters]` : reduce(entry, depth + 1)]));
    }
    return value;
  };
  return reduce(args ?? {});
}

function normalizeResult(result) {
  if (!result || typeof result !== "object") return fail("unavailable", "The tool returned no result.");
  if (result.ok === false) return fail(result.error?.code, result.error?.message);
  return {
    ok: true,
    summary: String(result.summary || ""),
    data: result.data ?? {},
    evidence: (Array.isArray(result.evidence) ? result.evidence : []).filter((entry) => entry && EVIDENCE_KINDS.includes(entry.kind)),
    records: Array.isArray(result.records) ? result.records : [],
    proposal: result.proposal ?? null,
    unknown: result.unknown ?? null,
  };
}

function errorResult(error, tool) {
  if (error instanceof ToolError) return fail(error.code, error.message);
  if (error instanceof ServiceError) {
    // Database and downstream-function text is replaced with fixed wording;
    // messages written by the gateway's own adapters are kept.
    const own = error.fromBackend !== true;
    if (error.status === 401 || error.status === 403) return fail("forbidden", (own && error.message) || "This is not available for your Atlas role.");
    if (error.status === 404) return fail("not_found", (own && error.message) || "That record could not be found.");
    if (error.status === 400) return fail("invalid_arguments", (own && error.message) || "Atlas refused those details.");
    if (error.status === 409) return fail("conflict", (own && error.message) || "That record changed; check it again.");
    return fail("unavailable", `${tool?.progress ? tool.progress.replace(/…$/, "") : "This information"} is unavailable right now.`);
  }
  return fail("unavailable", "This information is unavailable right now. Atlas did not guess a result.");
}


// Gateway data adapters: injected ones (tests) when they are Tool Gateway
// services, otherwise built once per ctx from env/fetch/actor. The runtime's
// own ctx.services ({ rpc } for the Atlas AI tables) is not used for tool data.
export function servicesFor(ctx) {
  if (ctx.services && typeof ctx.services.stockReport === "function") return ctx.services;
  if (!ctx.__services) {
    Object.defineProperty(ctx, "__services", {
      value: createServices({ fetch: ctx.fetch, env: ctx.env, actor: ctx.actor, now: nowMillis(ctx) }),
      enumerable: false,
      configurable: true,
    });
  }
  return ctx.__services;
}

async function audit(ctx, entry) {
  if (typeof ctx?.audit !== "function") return;
  try {
    await ctx.audit(entry);
  } catch {
    // Auditing must never change a tool result; the runtime logs its own failures.
  }
}

// Runs one tool call. Never throws for expected failures.
export async function runTool(nameOrFnName, rawArgs, ctx) {
  const started = Date.now();
  const tool = getTool(nameOrFnName);
  const actor = ctx?.actor;
  const base = {
    tool_name: tool?.name ?? String(nameOrFnName ?? ""),
    level: tool?.level ?? "read",
    run_id: ctx?.runId ?? null,
    conversation_id: ctx?.conversationId ?? null,
    actor_id: actor?.userId ?? null,
    actor_role: actor?.role ?? null,
  };
  const deny = async (code, message, args = null) => {
    const result = fail(code, message);
    await audit(ctx, { ...base, decision: "denied", arguments_redacted: redactArguments(args), result_summary: message, evidence_count: 0, latency_ms: Date.now() - started, status: "denied", error_code: code });
    return result;
  };

  if (!tool) return deny("not_found", "Atlas has no such tool.");
  if (!actor || actor.active !== true || !ATLAS_ROLES.includes(actor.role) || !actor.userId) {
    return deny("forbidden", "An active Atlas profile is required.");
  }
  if (!tool.roles.includes(actor.role)) {
    return deny("forbidden", `This is not available for your Atlas role (${actor.role}).`);
  }
  const checked = validateArgs(tool.parameters, rawArgs);
  if (!checked.ok) {
    const result = fail("invalid_arguments", `Invalid arguments: ${checked.errors.join("; ")}`);
    await audit(ctx, { ...base, decision: "allowed", arguments_redacted: {}, result_summary: result.error.message, evidence_count: 0, latency_ms: Date.now() - started, status: "failed", error_code: "invalid_arguments" });
    return result;
  }
  const maxCalls = Number(ctx.limits?.maxToolCallsPerRun) || DEFAULT_MAX_TOOL_CALLS_PER_RUN;
  const counter = ctx.__toolCalls ?? 0;
  Object.defineProperty(ctx, "__toolCalls", { value: counter + 1, enumerable: false, configurable: true, writable: true });
  if (counter >= maxCalls) return deny("limit_exceeded", "Atlas has made too many lookups in this answer. Ask a narrower question.", checked.value);

  let result;
  try {
    const services = servicesFor(ctx);
    const toolCtx = Object.create(ctx, {
      services: { value: services, enumerable: true },
      now: { value: nowMillis(ctx), enumerable: true },
    });
    result = normalizeResult(await tool.execute(checked.value, toolCtx));
  } catch (error) {
    result = errorResult(error, tool);
  }
  if (result.ok && result.proposal) {
    // A proposal must be approvable by the proposing role; otherwise it is dropped.
    const required = Array.isArray(result.proposal.required_roles) ? result.proposal.required_roles : [];
    if (tool.level !== "draft" || !required.includes(actor.role)) {
      result = fail("forbidden", "Atlas cannot prepare an action your role cannot approve.");
    }
  }
  result = redactForRole(result, actor.role);
  await audit(ctx, {
    ...base,
    decision: "allowed",
    arguments_redacted: redactArguments(checked.value),
    result_summary: result.ok ? result.summary.slice(0, 500) : result.error.message,
    evidence_count: result.ok ? result.evidence.length : 0,
    proposal_kind: result.ok && result.proposal ? result.proposal.kind : null,
    latency_ms: Date.now() - started,
    status: result.ok ? "ok" : "failed",
    error_code: result.ok ? null : result.error.code,
  });
  return result;
}
