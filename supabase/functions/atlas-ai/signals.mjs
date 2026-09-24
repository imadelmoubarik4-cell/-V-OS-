// Background intelligence (docs/ai/Atlas_AI_Architecture.md §12a) and
// maintenance. Deterministic: signals come from Tool Gateway results, never
// from a model call, and are stored as shadow Brain recommendations with a
// fingerprint so the same signal is refreshed instead of repeated.

import { TurnState } from "./turn.mjs";

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const STAFF_PREFIXES = ["operations.", "shifts."];

function signalType(toolName, raw) {
  const declared = String(raw?.type ?? raw?.category ?? "");
  if (["data_quality", "shortage", "purchase", "menu", "waste", "operations", "governance"].includes(declared)) return declared;
  if (toolName.startsWith("data_quality.")) return "data_quality";
  if (/par|stock|shortage|below/i.test(`${raw?.kind ?? ""} ${raw?.title ?? raw?.label ?? ""}`)) return "shortage";
  return "operations";
}

function slug(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

// Stable FNV-1a hash (hex) of a JSON value with sorted keys.
export function fingerprint(value) {
  const stable = (input) => {
    if (Array.isArray(input)) return `[${input.map(stable).join(",")}]`;
    if (input && typeof input === "object") {
      return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stable(input[key])}`).join(",")}}`;
    }
    return JSON.stringify(input ?? null);
  };
  let hash = 0x811c9dc5;
  const text = stable(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Converts one ToolResult into signals. Accepts data.signals | data.alerts |
// data.issues | data.gaps arrays; "missing" evidence becomes a data-quality
// signal. Unknown shapes produce nothing rather than a guess.
export function signalsFromResult(toolName, result) {
  if (!result || result.ok !== true) return [];
  const data = result.data ?? {};
  const lists = [data.signals, data.alerts, data.issues, data.gaps].filter(Array.isArray);
  const signals = [];
  for (const list of lists) {
    for (const raw of list.slice(0, 50)) {
      if (!raw || typeof raw !== "object") continue;
      const title = String(raw.title ?? raw.label ?? raw.message ?? "").trim();
      if (!title) continue;
      const subjectKey = String(raw.subject_key ?? raw.id ?? raw.key ?? title).slice(0, 200);
      const severity = SEVERITIES.has(raw.severity) ? raw.severity : "medium";
      const summary = String(raw.summary ?? raw.detail ?? raw.description ?? title).slice(0, 1500);
      const basis = { title, summary, severity, value: raw.value ?? null, count: raw.count ?? null };
      signals.push({
        key: slug(`${toolName}:${raw.key ?? raw.kind ?? "item"}:${subjectKey}`) || slug(`${toolName}:${fingerprint(basis)}`),
        type: signalType(toolName, raw),
        severity,
        audience: STAFF_PREFIXES.some((prefix) => toolName.startsWith(prefix)) && raw.audience !== "manager" ? "staff" : "manager",
        title: title.slice(0, 200),
        summary,
        subject_type: String(raw.subject_type ?? raw.type ?? "atlas_ai_signal").slice(0, 100),
        subject_key: subjectKey,
        fingerprint: fingerprint(basis),
        source_tool: toolName,
        evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).slice(0, 10).filter((item) => item && typeof item === "object"),
      });
    }
  }
  if (!signals.length) {
    const missing = (result.evidence ?? []).filter((item) => item?.kind === "missing").slice(0, 10);
    for (const item of missing) {
      const title = String(item.label ?? "").trim();
      if (!title) continue;
      const basis = { title, value: item.value ?? null };
      signals.push({
        key: slug(`${toolName}:missing:${title}`),
        type: "data_quality",
        severity: "medium",
        audience: "manager",
        title: title.slice(0, 200),
        summary: `${title}${item.value ? `: ${item.value}` : ""}`.slice(0, 1500),
        subject_type: String(item.source?.type ?? "atlas_ai_signal").slice(0, 100),
        subject_key: String(item.source?.id ?? title).slice(0, 200),
        fingerprint: fingerprint(basis),
        source_tool: toolName,
        evidence: [item],
      });
    }
  }
  return signals;
}

// Arguments for a registry tool when it is run in the background: nullable
// fields are null; a few known inputs get defaults. Tools with other required
// inputs are skipped.
export function backgroundArgs(entry) {
  const schema = entry.parameters ?? {};
  const args = {};
  const defaults = { days: 7, horizon_days: 7, limit: 50, include_resolved: false };
  for (const key of schema.required ?? Object.keys(schema.properties ?? {})) {
    const property = schema.properties?.[key] ?? {};
    const types = Array.isArray(property.type) ? property.type : [property.type];
    const nullable = types.includes("null") || (property.anyOf ?? []).some((variant) => variant?.type === "null");
    if (key in defaults) args[key] = defaults[key];
    else if (nullable) args[key] = null;
    else return null;
  }
  return args;
}

export function signalSources(gateway, role) {
  return (gateway.toolsForRole(role, { levels: ["read"] }) ?? []).filter((entry) =>
    entry.name === "operations.alerts" || entry.name === "shifts.schedule" || entry.name.startsWith("data_quality."));
}

export async function refreshSignals({ deps, config, actor, runId }) {
  const turn = new TurnState({
    services: deps.services, gateway: deps.gateway, actor, env: deps.env, fetchImpl: deps.fetchImpl,
    now: deps.now, venue: config.venue, runId, toolOutputChars: config.limits.toolOutputChars,
  });
  const signals = [];
  const checked = [];
  for (const entry of signalSources(deps.gateway, actor.role)) {
    const args = backgroundArgs(entry);
    if (!args) continue;
    const { result } = await turn.runTool(entry, args);
    checked.push({ tool: entry.name, ok: result.ok === true });
    signals.push(...signalsFromResult(entry.name, result));
  }
  const unique = [...new Map(signals.map((signal) => [signal.key, signal])).values()].slice(0, 100);
  let stored = { count: 0, created: 0, refreshed: 0 };
  if (unique.length) {
    stored = await deps.services.rpc("atlas_ai_signals_upsert", {
      p_actor_id: actor.userId,
      p_actor_role: actor.role,
      p_signals: unique,
    });
  }
  return {
    checked,
    signals: unique.map((signal) => ({ key: signal.key, severity: signal.severity, audience: signal.audience, title: signal.title })),
    stored: { count: stored.count ?? 0, created: stored.created ?? 0, refreshed: stored.refreshed ?? 0 },
    tool_calls: turn.toolCalls,
  };
}

// Service job: expire stale proposals and purge expired media objects.
export async function runMaintenance({ services }) {
  const expired = await services.rpc("atlas_ai_actions_expire", {});
  const purge = await services.rpc("atlas_ai_media_purge_expired", { p_limit: 200 });
  const media = Array.isArray(purge?.media) ? purge.media : [];
  let confirmed = 0;
  if (media.length) {
    try {
      await services.removeObjects(media.map((entry) => entry.path));
      const result = await services.rpc("atlas_ai_media_purge_confirm", { p_media_ids: media.map((entry) => entry.id) });
      confirmed = Number(result?.confirmed) || 0;
    } catch {
      // Objects stay marked expired and are retried on the next run.
    }
  }
  return { actions_expired: Number(expired?.expired) || 0, media_found: media.length, media_purged: confirmed };
}
