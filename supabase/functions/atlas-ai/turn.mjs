// Per-run state shared by the chat stream, voice tools and background runs:
// the server-built gateway context, tool-call audit, evidence/records
// collection, structured-context patches and proposal persistence.
//
// Tool arguments never change the actor: the gateway context is built here
// from the verified actor, and every tool call goes through gateway.runTool.

import { redactArguments, redactSecrets } from "./guardrails.mjs";

const EVIDENCE_KINDS = new Set(["fact", "calculation", "interpretation", "estimate", "missing"]);
const MAX_EVIDENCE = 40;
const MAX_RECORDS = 40;

function text(value, max) {
  return String(value ?? "").slice(0, max);
}

function cleanSource(source) {
  if (!source || typeof source !== "object") return null;
  return {
    type: text(source.type, 60) || null,
    id: source.id === undefined || source.id === null ? null : text(source.id, 120),
    label: text(source.label, 200) || null,
    route: typeof source.route === "string" && source.route.startsWith("#") ? text(source.route, 300) : null,
  };
}

export function cleanEvidence(item) {
  if (!item || typeof item !== "object") return null;
  const kind = EVIDENCE_KINDS.has(item.kind) ? item.kind : "interpretation";
  return {
    kind,
    label: redactSecrets(text(item.label, 240)),
    value: item.value === undefined || item.value === null ? null : redactSecrets(text(typeof item.value === "string" ? item.value : JSON.stringify(item.value), 500)),
    source: cleanSource(item.source),
  };
}

export function cleanRecord(item) {
  if (!item || typeof item !== "object" || !item.type) return null;
  return {
    type: text(item.type, 60),
    id: item.id === undefined || item.id === null ? null : text(item.id, 120),
    label: text(item.label, 200) || null,
    route: typeof item.route === "string" && item.route.startsWith("#") ? text(item.route, 300) : null,
  };
}

function evidenceKey(item) {
  return `${item.kind}|${item.label}|${item.value}|${item.source?.type}|${item.source?.id}`;
}

// The compact JSON string a model receives for a tool result.
export function toolOutputForModel(result, proposal, maxChars) {
  if (!result || result.ok !== true) {
    const error = result?.error ?? {};
    return JSON.stringify({
      ok: false,
      error: { code: text(error.code || "unavailable", 60), message: redactSecrets(text(error.message || "This check is unavailable right now.", 300)) },
      instruction: "Tell the user plainly what could not be checked. Do not invent a result.",
    });
  }
  const payload = {
    ok: true,
    summary: redactSecrets(text(result.summary, 2000)),
    evidence: (result.evidence ?? []).slice(0, 20).map(cleanEvidence).filter(Boolean)
      .map((item) => ({ kind: item.kind, label: item.label, value: item.value, source: item.source?.label ?? item.source?.type ?? null })),
    unknown: result.unknown ?? null,
    records: (result.records ?? []).slice(0, 20).map(cleanRecord).filter(Boolean).map((record) => ({ type: record.type, label: record.label })),
  };
  if (proposal) {
    payload.proposal = {
      status: "awaiting_approval",
      title: proposal.title,
      note: "A proposal card is shown to the user. Nothing has changed; it runs only if a person approves it.",
    };
  } else if (result.proposal) {
    payload.proposal = { status: "not_created", note: "The proposal could not be saved. Tell the user it was not prepared." };
  }
  let data = result.data ?? null;
  let serialised = JSON.stringify({ ...payload, data });
  if (serialised.length > maxChars) {
    const room = Math.max(0, maxChars - JSON.stringify(payload).length - 80);
    const dataText = JSON.stringify(data ?? null);
    serialised = JSON.stringify({ ...payload, data_preview: dataText.slice(0, room), data_truncated: true });
  }
  return redactSecrets(serialised);
}

export class TurnState {
  constructor({ services, gateway, actor, env, fetchImpl, now, venue, conversationId = null, messageId = null, runId = null, context = {}, emit = () => {}, toolOutputChars = 12000 }) {
    this.services = services;
    this.gateway = gateway;
    this.actor = actor;
    this.conversationId = conversationId;
    this.messageId = messageId;
    this.runId = runId;
    this.context = { ...(context || {}) };
    this.contextPatch = {};
    this.emitFn = emit;
    this.toolOutputChars = toolOutputChars;
    this.evidence = [];
    this.records = [];
    this.proposals = [];
    this.results = [];
    this.verified = false;
    this.toolCalls = 0;
    this.auditCount = 0;
    this.lastProgress = null;
    this.pending = [];
    const self = this;
    this.gatewayCtx = {
      actor,
      env: { get: (name) => (typeof env === "function" ? env(name) : env?.get?.(name)) },
      fetch: fetchImpl,
      now: () => new Date(now()),
      venue,
      conversationId,
      get runId() { return self.runId; },
      audit: (record) => self.audit(record),
      // Data access is created by the gateway from fetch/env/actor (user JWT + verified actor).
    };
  }

  setMessageId(id) {
    this.messageId = id;
  }

  setRunId(id) {
    this.runId = id;
  }

  emit(event, data) {
    try { this.emitFn(event, data); } catch { /* the stream may be closed */ }
  }

  progress(label) {
    const value = text(label, 80).trim();
    if (!value || value === this.lastProgress) return;
    this.lastProgress = value;
    this.emit("progress", { label: value });
  }

  // ctx.audit → atlas_ai_tool_call_record. Arguments are redacted here even
  // if the caller already redacted them. Never throws.
  async audit(record = {}) {
    this.auditCount += 1;
    if (!this.runId) return null;
    const name = String(record.tool_name ?? record.tool ?? record.name ?? "");
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(name)) return null;
    const status = ["ok", "failed", "denied", "timeout"].includes(record.status) ? record.status : "ok";
    try {
      return await this.services.rpc("atlas_ai_tool_call_record", {
        p_actor_id: this.actor.userId,
        p_actor_role: this.actor.role,
        p_run_id: this.runId,
        p_conversation_id: this.conversationId,
        p_tool_name: name.slice(0, 120),
        p_level: ["read", "draft", "execute"].includes(record.level) ? record.level : "read",
        p_decision: record.decision === "denied" || status === "denied" ? "denied" : "allowed",
        p_arguments_redacted: redactArguments(record.arguments_redacted ?? record.arguments ?? {}) ?? {},
        p_result_summary: record.result_summary || record.summary ? redactSecrets(text(record.result_summary ?? record.summary, 2000)) : null,
        p_evidence_count: Math.max(0, Number(record.evidence_count) || 0),
        p_latency_ms: Number.isFinite(record.latency_ms) ? Math.max(0, Math.round(record.latency_ms)) : null,
        p_status: status,
        p_error_code: record.error_code ? text(record.error_code, 120) : null,
      });
    } catch {
      return null;
    }
  }

  // Runs one registry tool with the server actor and records everything.
  // Returns {result, proposal, output} where output is the model string.
  async runTool(entry, args) {
    this.toolCalls += 1;
    this.progress(entry.progress || "Checking Atlas");
    const started = Date.now();
    const auditsBefore = this.auditCount;
    let result;
    try {
      result = await this.gateway.runTool(entry.name, args ?? {}, this.gatewayCtx);
    } catch {
      result = { ok: false, error: { code: "unavailable", message: "That check is unavailable right now." } };
    }
    if (!result || typeof result !== "object") {
      result = { ok: false, error: { code: "unavailable", message: "That check is unavailable right now." } };
    }
    if (this.auditCount === auditsBefore) {
      const code = result.ok ? null : String(result.error?.code ?? "failed");
      await this.audit({
        tool_name: entry.name,
        level: entry.level,
        decision: code === "forbidden" ? "denied" : "allowed",
        arguments: args,
        result_summary: result.ok ? result.summary : result.error?.message,
        evidence_count: Array.isArray(result.evidence) ? result.evidence.length : 0,
        latency_ms: Date.now() - started,
        status: result.ok ? "ok" : code === "forbidden" ? "denied" : "failed",
        error_code: code,
      });
    }
    const proposal = await this.accept(entry, result, args);
    return { result, proposal, output: toolOutputForModel(result, proposal, this.toolOutputChars) };
  }

  async accept(entry, result, args = null) {
    this.results.push({ tool: entry.name, ok: result.ok === true });
    if (result.ok !== true) return null;
    this.verified = true;
    const seen = new Set(this.evidence.map(evidenceKey));
    for (const raw of result.evidence ?? []) {
      const item = cleanEvidence(raw);
      if (!item || this.evidence.length >= MAX_EVIDENCE) continue;
      const key = evidenceKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      this.evidence.push(item);
    }
    const recordKeys = new Set(this.records.map((record) => `${record.type}|${record.id}`));
    for (const raw of result.records ?? []) {
      const record = cleanRecord(raw);
      if (!record || this.records.length >= MAX_RECORDS) continue;
      const key = `${record.type}|${record.id}`;
      if (recordKeys.has(key)) continue;
      recordKeys.add(key);
      this.records.push(record);
    }
    try {
      const patch = this.gateway.buildContextPatch?.(entry.name, result, this.context, parseArgs(args));
      if (patch && typeof patch === "object" && !Array.isArray(patch)) {
        Object.assign(this.contextPatch, patch);
        Object.assign(this.context, patch);
      }
    } catch {
      // A context patch is a convenience; never fail the tool for it.
    }
    if (result.proposal && typeof result.proposal === "object") {
      return await this.createProposal(entry, result);
    }
    return null;
  }

  async createProposal(entry, result) {
    const proposal = result.proposal;
    const actor = this.actor;
    let action;
    try {
      action = await this.services.rpc("atlas_ai_action_create", {
        p_actor_id: actor.userId,
        p_actor_role: actor.role,
        p_conversation_id: this.conversationId,
        p_message_id: this.messageId,
        p_kind: String(proposal.kind ?? ""),
        p_title: text(proposal.title || "Proposal", 200),
        p_preview: proposal.preview && typeof proposal.preview === "object" ? proposal.preview : { summary: text(proposal.preview, 2000) },
        p_command: proposal.command,
        p_required_roles: Array.isArray(proposal.required_roles) && proposal.required_roles.length ? proposal.required_roles : ["admin", "manager"],
      });
    } catch {
      console.warn("[atlas-ai] proposal could not be stored");
      return null;
    }
    const evidenceSource = Array.isArray(proposal.evidence) && proposal.evidence.length ? proposal.evidence : result.evidence ?? [];
    const evidence = evidenceSource.slice(0, 20).map((item) => {
      const clean = cleanEvidence(item);
      return clean ? { tool: entry.name, ...clean } : null;
    }).filter(Boolean);
    try {
      await this.services.rpc("atlas_ai_record_proposal", {
        p_action_id: action.id,
        p_actor_id: actor.userId,
        p_actor_role: actor.role,
        p_evidence: evidence,
        p_subject_type: proposal.subject_type ? text(proposal.subject_type, 120) : null,
        p_subject_key: proposal.subject_key ? text(proposal.subject_key, 240) : null,
        p_summary: text(result.summary || proposal.title, 2000) || null,
      });
    } catch {
      console.warn("[atlas-ai] proposal could not be recorded in Brain");
    }

    const previous = this.context.atlas_last_proposal;
    let supersedes = null;
    if (previous?.id && previous.id !== action.id && previous.kind === action.kind) {
      supersedes = await this.supersede(previous.id, action.id);
    }
    const summary = {
      id: action.id,
      kind: action.kind,
      title: action.title,
      preview: action.preview,
      required_roles: action.required_roles,
      expires_at: action.expires_at,
      status: action.status ?? "proposed",
      supersedes,
    };
    this.proposals.push(summary);
    const patch = { atlas_last_proposal: { id: action.id, kind: action.kind, tool: entry.name, title: action.title } };
    Object.assign(this.contextPatch, patch);
    Object.assign(this.context, patch);
    this.emit("proposal", summary);
    return summary;
  }

  // A revised proposal replaces the previous open one of the same kind.
  async supersede(previousId, nextId) {
    try {
      const transition = await this.services.rpc("atlas_ai_action_transition", {
        p_action_id: previousId,
        p_to_status: "rejected",
        p_actor_id: this.actor.userId,
        p_actor_role: this.actor.role,
        p_result: null,
        p_error: "Superseded by a revised proposal.",
      });
      if (transition?.action?.brain_recommendation_id) {
        await this.services.rpc("atlas_ai_record_decision", {
          p_action_id: previousId,
          p_decision: "reject",
          p_actor_id: this.actor.userId,
          p_actor_role: this.actor.role,
          p_notes: `Superseded by revised proposal ${nextId}.`,
        }).catch(() => null);
      }
      return previousId;
    } catch {
      // Already decided or expired: nothing to supersede.
      return null;
    }
  }
}

// Tool arguments arrive as an object or a JSON string; follow-ups need the object.
function parseArgs(args) {
  if (args && typeof args === "object") return args;
  if (typeof args === "string") {
    try { const parsed = JSON.parse(args); return parsed && typeof parsed === "object" ? parsed : null; } catch { return null; }
  }
  return null;
}
