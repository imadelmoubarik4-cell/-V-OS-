// Voice: transcription of voice notes, optional read-aloud, and live voice
// (server-built Realtime session config + short-lived client secret, tool
// calls executed through the same Tool Gateway, transcript continuity).

import { ApiError } from "./http.mjs";
import { SPEECH_INSTRUCTIONS, voiceInstructions } from "./instructions.mjs";
import { redactSecrets } from "./guardrails.mjs";

export const AUDIO_TYPES = Object.freeze({
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
});

export function normaliseAudioMime(type) {
  const base = String(type ?? "").split(";")[0].trim().toLowerCase();
  if (base === "audio/x-wav" || base === "audio/wave") return "audio/wav";
  if (base === "video/webm") return "audio/webm";
  if (base === "audio/m4a" || base === "audio/x-m4a") return "audio/mp4";
  return base;
}

export const ASK_ATLAS_TOOL = Object.freeze({
  type: "function",
  name: "ask_atlas",
  description: "Hand a multi-step or cross-area question (reports, costing, 'prepare Friday', anything needing several checks) to the full Atlas assistant. Returns a short spoken-style answer.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", description: "The user's request in their own words, with any details already given." },
    },
    required: ["request"],
    additionalProperties: false,
  },
});

// Realtime function tools for the actor's role: read and draft tools only.
export function realtimeTools(gateway, role) {
  const entries = (gateway.toolsForRole(role, { levels: ["read", "draft"] }) ?? [])
    .filter((entry) => entry && entry.level !== "execute" && entry.fnName);
  return [
    ...entries.map((entry) => ({
      type: "function",
      name: entry.fnName,
      description: String(entry.description ?? entry.name).slice(0, 1000),
      parameters: entry.parameters ?? { type: "object", properties: {}, additionalProperties: false },
    })),
    ASK_ATLAS_TOOL,
  ];
}

export function buildRealtimeSession({ config, actor, gateway, keywords, preferences, nowIso, conversationId }) {
  return {
    type: "realtime",
    model: config.models.realtime,
    instructions: voiceInstructions({ actor, venue: config.venue, nowIso, preferences }),
    output_modalities: ["audio"],
    max_output_tokens: 1024,
    audio: {
      input: {
        noise_reduction: { type: "far_field" },
        transcription: {
          model: config.models.realtimeTranscribe,
          languages: ["en", "is"],
          ...(keywords.length ? { keywords } : {}),
        },
        turn_detection: { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true },
      },
      output: { voice: config.voice },
    },
    tools: realtimeTools(gateway, actor.role),
    tool_choice: "auto",
    tracing: config.tracing.disabled ? null : { workflow_name: "atlas-voice", group_id: conversationId },
    truncation: "auto",
  };
}

// Bounded vocabulary for transcription: item, supplier and staff names read
// with the caller's own JWT (RLS applies). Failures yield an empty list.
export async function transcriptionKeywords(services, actor, limit) {
  const [items, suppliers, staff] = await Promise.all([
    services.restAsUser(actor, "inventory_catalog", "name", 200),
    services.restAsUser(actor, "suppliers", "name", 80),
    services.restAsUser(actor, "profiles", "display_name", 80),
  ]);
  const words = ["Atlas"];
  for (const row of [...staff, ...suppliers, ...items]) {
    const value = String(row?.name ?? row?.display_name ?? "").trim();
    if (value && value.length <= 40 && !words.includes(value)) words.push(value);
    if (words.length >= limit) break;
  }
  return words;
}

async function openaiFetch(deps, apiKey, path, init) {
  let response;
  try {
    response = await deps.fetchImpl(`${deps.config.openaiBaseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError(503, "provider_unavailable", "Atlas AI could not reach its voice service. Please try again.");
  }
  if (!response.ok) {
    console.warn("[atlas-ai] provider request failed", path, response.status);
    if (response.status === 429) throw new ApiError(429, "busy", "Atlas AI is busy right now. Please try again in a moment.");
    throw new ApiError(502, "provider_error", "The voice service could not complete that request.");
  }
  return response;
}

export async function mintRealtimeSecret(deps, apiKey, session, seconds) {
  const response = await openaiFetch(deps, apiKey, "/realtime/client_secrets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expires_after: { anchor: "created_at", seconds }, session }),
  });
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload.value !== "string") {
    throw new ApiError(502, "provider_error", "The voice service did not return a session.");
  }
  return payload;
}

export async function transcribeAudio(deps, apiKey, { bytes, mime, keywords }) {
  const extension = AUDIO_TYPES[mime] ?? "webm";
  const form = new FormData();
  form.append("file", new File([bytes], `voice-note.${extension}`, { type: mime }));
  form.append("model", deps.config.models.transcribe);
  form.append("response_format", "json");
  form.append("languages[]", "en");
  form.append("languages[]", "is");
  for (const keyword of keywords) form.append("keywords[]", keyword);
  const response = await openaiFetch(deps, apiKey, "/audio/transcriptions", { method: "POST", body: form });
  const payload = await response.json().catch(() => null);
  const text = redactSecrets(String(payload?.text ?? "")).trim();
  const seconds = payload?.usage?.type === "duration" ? Number(payload.usage.seconds) : Number(payload?.duration);
  return { text, duration: Number.isFinite(seconds) ? seconds : null };
}

export async function synthesiseSpeech(deps, apiKey, text) {
  const response = await openaiFetch(deps, apiKey, "/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: deps.config.models.speech,
      input: text,
      voice: deps.config.voice,
      instructions: SPEECH_INSTRUCTIONS,
      response_format: "mp3",
    }),
  });
  return new Uint8Array(await response.arrayBuffer());
}

// Concise string for the Realtime model from a tool result.
export function voiceToolOutput(result, proposal) {
  if (!result || result.ok !== true) {
    return redactSecrets(`Could not check that: ${String(result?.error?.message ?? "unavailable right now").slice(0, 200)}. Tell the user plainly; do not guess.`);
  }
  const parts = [String(result.summary ?? "").slice(0, 1200)];
  const evidence = (result.evidence ?? []).slice(0, 6)
    .map((item) => `${item.label}: ${typeof item.value === "string" ? item.value : JSON.stringify(item.value)} (${item.kind})`);
  if (evidence.length) parts.push(`Evidence: ${evidence.join("; ")}`.slice(0, 1200));
  if (result.unknown) parts.push(`Unknown: ${JSON.stringify(result.unknown).slice(0, 300)}. Say this plainly; never infer.`);
  if (proposal) parts.push(`Prepared "${proposal.title}" as a proposal card on screen. Nothing has changed; ask the user to review and tap Approve.`);
  else if (result.proposal) parts.push("The proposal could not be saved; tell the user it was not prepared.");
  return redactSecrets(parts.filter(Boolean).join("\n")).slice(0, 4000);
}

// In-memory per-isolate throttle for minting client secrets (the daily run
// limit in atlas_ai_rate_check is the durable limit).
export function createMintThrottle(perMinute) {
  const hits = new Map();
  return (userId, nowMs) => {
    const recent = (hits.get(userId) ?? []).filter((at) => nowMs - at < 60000);
    if (recent.length >= perMinute) return false;
    recent.push(nowMs);
    hits.set(userId, recent);
    return true;
  };
}
