// atlas-ai request handling, with every side effect injected:
//   env(name)          -> string | undefined     (Deno.env.get in production)
//   fetchImpl(url,init)-> Response                (Auth, PostgREST, Storage, OpenAI)
//   now()              -> epoch milliseconds
//   sdk, z             -> @openai/agents and zod (v4) modules
//   gateway            -> _shared/ai-tools/index.mjs (Tool Gateway)
//   modelProvider()    -> Agents SDK ModelProvider (OpenAIProvider in production)
//   resolveActor(req)  -> optional override of _shared/auth.mjs resolveActor
//   services           -> optional override of createServices() (tests)
// index.ts wires these for the Edge runtime; tests pass fakes.

import { resolveActor as sharedResolveActor, AuthError, MANAGER_ROLES } from "../_shared/auth.mjs";
import { loadConfig, openaiApiKey } from "./config.mjs";
import {
  ApiError,
  CORS_HEADERS,
  NOT_CONFIGURED,
  createServices,
  errorResponse,
  jsonResponse,
  readJsonBody,
  requireUuid,
  uuidOrNull,
} from "./http.mjs";
import { prepareChatTurn, streamChatTurn, validateChatBody, runAskAtlas, startRun, finishRun, safeRpc } from "./chat.mjs";
import {
  AUDIO_TYPES,
  buildRealtimeSession,
  createMintThrottle,
  mintRealtimeSecret,
  normaliseAudioMime,
  synthesiseSpeech,
  transcribeAudio,
  transcriptionKeywords,
  voiceToolOutput,
} from "./voice.mjs";
import { historyItemsFor } from "./session.mjs";
import { redactArguments, redactSecrets } from "./guardrails.mjs";
import { TurnState } from "./turn.mjs";
import { refreshSignals, runMaintenance } from "./signals.mjs";

export const UPLOAD_TYPES = Object.freeze({
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/png": { kind: "image", ext: "png" },
  "image/webp": { kind: "image", ext: "webp" },
  "image/heic": { kind: "image", ext: "heic" },
  "image/heif": { kind: "image", ext: "heif" },
  "application/pdf": { kind: "pdf", ext: "pdf" },
  "text/plain": { kind: "document", ext: "txt" },
  "text/csv": { kind: "document", ext: "csv" },
  "audio/webm": { kind: "audio", ext: "webm" },
  "audio/ogg": { kind: "audio", ext: "ogg" },
  "audio/mp4": { kind: "audio", ext: "m4a" },
  "audio/mpeg": { kind: "audio", ext: "mp3" },
  "audio/wav": { kind: "audio", ext: "wav" },
});

function normaliseUploadMime(type) {
  const base = String(type ?? "").split(";")[0].trim().toLowerCase();
  if (base === "image/jpg") return "image/jpeg";
  if (base === "application/csv" || base === "text/comma-separated-values") return "text/csv";
  return normaliseAudioMime(base);
}

// Light content sniffing so a renamed binary is not accepted as a photo, PDF
// or text document.
export function contentMatches(mime, bytes) {
  const b = bytes;
  const ascii = (start, text) => [...text].every((ch, index) => b[start + index] === ch.charCodeAt(0));
  switch (mime) {
    case "image/jpeg": return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png": return b[0] === 0x89 && ascii(1, "PNG");
    case "image/webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "image/heic":
    case "image/heif": return ascii(4, "ftyp");
    case "application/pdf": return ascii(0, "%PDF-");
    case "text/plain":
    case "text/csv":
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, 65536));
        return !text.includes("\u0000");
      } catch {
        return false;
      }
    default: return true;
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  let diff = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}

async function readMultipart(request, maxBytes) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes + 1024 * 1024) throw new ApiError(413, "too_large", "Files can be up to 25 MB.");
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError(400, "invalid_request", "Send the file as multipart form data.");
  }
  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    throw new ApiError(400, "invalid_request", "Attach a file in the \"file\" field.");
  }
  if (file.size > maxBytes) throw new ApiError(413, "too_large", "Files can be up to 25 MB.");
  if (file.size === 0) throw new ApiError(400, "invalid_request", "The file is empty.");
  return { form, file };
}

function sseHeaders() {
  return {
    ...CORS_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  };
}

export function createAtlasAiHandler(deps) {
  const env = (name) => {
    const value = deps.env(name);
    return value === undefined || value === null ? undefined : String(value);
  };
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetchImpl;
  const services = deps.services ?? createServices({ env, fetchImpl });
  const config = loadConfig(env);
  const runtime = {
    ...deps,
    env,
    now,
    fetchImpl,
    services,
    config,
  };
  const throttle = createMintThrottle(config.limits.voiceMintsPerMinute);
  const resolve = deps.resolveActor ?? ((request) => sharedResolveActor(request, { get: env }, fetchImpl));

  const actorArgs = (actor) => ({ p_actor_id: actor.userId, p_actor_role: actor.role });

  async function requireAi(actor, { count = true } = {}) {
    if (!openaiApiKey(env) || !deps.sdk || !deps.gateway) throw NOT_CONFIGURED();
    const rate = await services.rpc("atlas_ai_rate_check", actorArgs(actor));
    if (!rate?.enabled) throw NOT_CONFIGURED();
    if (count && !rate.allowed) {
      throw new ApiError(429, "rate_limited", "You've reached today's Atlas AI limit. It resets within 24 hours.", { resets_at: rate.resets_at ?? null });
    }
    return rate;
  }

  function gatewayOrUnavailable() {
    if (!deps.gateway) throw NOT_CONFIGURED();
    return deps.gateway;
  }

  // --- Conversations ------------------------------------------------------

  async function conversations(request, actor) {
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200) || null;
    return services.rpc("atlas_ai_conversations_list", {
      ...actorArgs(actor),
      p_query: query,
      p_include_archived: url.searchParams.get("include_archived") === "true",
      p_limit: limit,
      p_offset: offset,
    });
  }

  async function conversation(request, actor) {
    const url = new URL(request.url);
    return services.rpc("atlas_ai_conversation_get", {
      p_conversation_id: requireUuid(url.searchParams.get("id") ?? url.searchParams.get("conversation_id"), "id"),
      ...actorArgs(actor),
      p_limit: Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50)),
      p_before_id: uuidOrNull(url.searchParams.get("before_id"), "before_id"),
      p_include_items: false,
    });
  }

  function titleFrom(value) {
    if (value === undefined || value === null) return null;
    const title = String(value).trim().slice(0, 200);
    return title || null;
  }

  async function create(body, actor) {
    return services.rpc("atlas_ai_conversation_create", { ...actorArgs(actor), p_title: titleFrom(body.title), p_context: {} });
  }

  async function rename(body, actor) {
    const title = titleFrom(body.title);
    if (!title) throw new ApiError(400, "invalid_request", "Give the conversation a title.");
    return services.rpc("atlas_ai_conversation_rename", {
      p_conversation_id: requireUuid(body.conversation_id, "conversation_id"), ...actorArgs(actor), p_title: title,
    });
  }

  async function pin(body, actor) {
    return services.rpc("atlas_ai_conversation_pin", {
      p_conversation_id: requireUuid(body.conversation_id, "conversation_id"), ...actorArgs(actor), p_pinned: body.pinned !== false,
    });
  }

  async function archive(body, actor) {
    return services.rpc("atlas_ai_conversation_archive", {
      p_conversation_id: requireUuid(body.conversation_id, "conversation_id"), ...actorArgs(actor), p_archived: body.archived !== false,
    });
  }

  async function remove(body, actor) {
    const result = await services.rpc("atlas_ai_conversation_delete", {
      p_conversation_id: requireUuid(body.conversation_id, "conversation_id"), ...actorArgs(actor),
    });
    const media = Array.isArray(result?.media_marked_for_purge) ? result.media_marked_for_purge : [];
    let removed = 0;
    if (media.length) {
      try {
        await services.removeObjects(media.map((entry) => entry.path));
        const confirmed = await services.rpc("atlas_ai_media_purge_confirm", { p_media_ids: media.map((entry) => entry.id) });
        removed = Number(confirmed?.confirmed) || media.length;
      } catch {
        // Marked expired: the maintenance job removes them later.
      }
    }
    return { deleted: true, conversation_id: result?.conversation_id ?? body.conversation_id, media_removed: removed, media_pending: media.length - removed };
  }

  // --- Preferences / settings ---------------------------------------------

  async function preferences(request, actor) {
    if (request.method === "GET") return services.rpc("atlas_ai_preferences_get", actorArgs(actor));
    const body = await readJsonBody(request, config.limits.jsonBodyBytes);
    const patch = body.patch && typeof body.patch === "object" ? body.patch : body;
    const allowed = {};
    for (const key of ["reply_length", "speak_answers", "voice_enabled", "language"]) if (key in patch) allowed[key] = patch[key];
    return services.rpc("atlas_ai_preferences_set", { ...actorArgs(actor), p_patch: allowed });
  }

  async function settings(request, actor) {
    if (request.method === "GET") {
      const value = await services.rpc("atlas_ai_settings_get", actorArgs(actor));
      return { ...value, configured: Boolean(value?.enabled) && Boolean(openaiApiKey(env)), key_present: Boolean(openaiApiKey(env)) };
    }
    const body = await readJsonBody(request, config.limits.jsonBodyBytes);
    const patch = body.patch && typeof body.patch === "object" ? body.patch : body;
    const allowed = {};
    for (const key of ["enabled", "media_retention_days", "audio_retention", "daily_turn_limit_per_user"]) if (key in patch) allowed[key] = patch[key];
    return services.rpc("atlas_ai_settings_set", { ...actorArgs(actor), p_patch: allowed });
  }

  // --- Chat (SSE) -----------------------------------------------------------

  async function chat(request, actor) {
    const body = await readJsonBody(request, config.limits.jsonBodyBytes);
    const input = validateChatBody(body, config.limits);
    await requireAi(actor, { count: true });
    const prepared = await prepareChatTurn({ deps: runtime, config, actor, input });

    const encoder = new TextEncoder();
    const abort = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) abort.abort();
      else request.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }
    let closed = false;
    let keepAlive = null;
    const stream = new ReadableStream({
      start(controller) {
        const send = (event, data) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };
        keepAlive = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch { closed = true; }
        }, 15000);
        streamChatTurn({ deps: runtime, config, actor, input, prepared, send, signal: abort.signal })
          .catch((error) => {
            const friendly = error instanceof ApiError ? error : null;
            if (!friendly) console.warn("[atlas-ai] chat stream failed", error?.name ?? "Error");
            send("error", {
              code: friendly?.code ?? "internal",
              message: friendly?.message ?? "Atlas AI could not finish that answer. Please try again.",
              conversation_id: prepared.conversationId ?? null,
            });
          })
          .finally(() => {
            clearInterval(keepAlive);
            if (!closed) {
              closed = true;
              try { controller.close(); } catch { /* already closed */ }
            }
          });
      },
      cancel() {
        closed = true;
        clearInterval(keepAlive);
        abort.abort();
      },
    });
    return new Response(stream, { status: 200, headers: sseHeaders() });
  }

  // --- Actions --------------------------------------------------------------

  async function appendNote(actor, conversationId, content, requestId) {
    if (!conversationId) return null;
    const appended = await safeRpc(services, "atlas_ai_messages_append", {
      p_conversation_id: conversationId,
      ...actorArgs(actor),
      p_messages: [{ role: "system_note", content, items: historyItemsFor({ role: "system_note", content }), client_request_id: requestId }],
    });
    return appended?.messages?.[0]?.id ?? null;
  }

  function boundedResult(value) {
    const redacted = redactArguments(value ?? null);
    const text = JSON.stringify(redacted ?? null);
    return text.length > 200000 ? { truncated: true } : redacted;
  }

  async function executeAction(body, actor) {
    const gateway = gatewayOrUnavailable();
    const actionId = requireUuid(body.action_id, "action_id");
    let transition;
    try {
      transition = await services.rpc("atlas_ai_action_transition", {
        p_action_id: actionId, p_to_status: "executing", ...actorArgs(actor), p_result: null, p_error: null,
      });
    } catch (error) {
      if (error?.code === "conflict") throw new ApiError(409, "conflict", "This proposal was already handled or has expired.");
      if (error?.code === "forbidden") throw new ApiError(403, "forbidden", "Your Atlas role cannot approve this proposal.");
      throw error;
    }
    const action = transition.action;
    const turn = new TurnState({
      services, gateway, actor, env, fetchImpl, now, venue: config.venue,
      conversationId: action.conversation_id ?? null, toolOutputChars: config.limits.toolOutputChars,
    });
    let outcome;
    try {
      outcome = await gateway.executeProposal(action.kind, transition.command, turn.gatewayCtx);
    } catch {
      outcome = { ok: false, error: { code: "failed", message: "The action could not be completed." } };
    }
    const ok = outcome?.ok === true;
    const errorMessage = ok ? null : redactSecrets(String(outcome?.error?.message ?? "The action could not be completed.")).slice(0, 500);
    const finished = await services.rpc("atlas_ai_action_transition", {
      p_action_id: actionId,
      p_to_status: ok ? "executed" : "failed",
      ...actorArgs(actor),
      p_result: ok ? boundedResult(outcome.result ?? {}) : null,
      p_error: errorMessage,
    });
    await safeRpc(services, "atlas_ai_record_decision", {
      p_action_id: actionId, p_decision: "approve", ...actorArgs(actor), p_notes: ok ? null : `Execution failed: ${errorMessage}`,
    });
    const summary = ok && typeof outcome.result?.summary === "string" ? ` ${redactSecrets(outcome.result.summary).slice(0, 300)}` : "";
    const note = ok
      ? `Approved by ${actor.label}: ${action.title}. Done.${summary}`
      : `Approved by ${actor.label}: ${action.title}. It could not be completed: ${errorMessage}`;
    const noteId = await appendNote(actor, action.conversation_id, note, `action:${actionId}:${ok ? "executed" : "failed"}`);
    return {
      ok,
      action: finished?.action ?? action,
      result: ok ? boundedResult(outcome.result ?? {}) : null,
      error: ok ? null : { code: String(outcome?.error?.code ?? "failed").slice(0, 60), message: errorMessage },
      note_message_id: noteId,
    };
  }

  async function rejectAction(body, actor) {
    const actionId = requireUuid(body.action_id, "action_id");
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    let transition;
    try {
      transition = await services.rpc("atlas_ai_action_transition", {
        p_action_id: actionId, p_to_status: "rejected", ...actorArgs(actor), p_result: null, p_error: reason || null,
      });
    } catch (error) {
      if (error?.code === "conflict") throw new ApiError(409, "conflict", "This proposal was already handled or has expired.");
      throw error;
    }
    await safeRpc(services, "atlas_ai_record_decision", {
      p_action_id: actionId, p_decision: "reject", ...actorArgs(actor), p_notes: reason || null,
    });
    const action = transition.action;
    const noteId = await appendNote(actor, action.conversation_id,
      `Rejected by ${actor.label}: ${action.title}.${reason ? ` Reason: ${reason}` : ""}`, `action:${actionId}:rejected`);
    return { ok: true, action, note_message_id: noteId };
  }

  // --- Media ----------------------------------------------------------------

  async function upload(request, actor) {
    const { form, file } = await readMultipart(request, config.limits.uploadBytes);
    const mime = normaliseUploadMime(file.type);
    const type = UPLOAD_TYPES[mime];
    if (!type) throw new ApiError(415, "unsupported_type", "Atlas AI accepts photos, PDFs, text or CSV files and voice notes.");
    const conversationId = uuidOrNull(form.get("conversation_id"), "conversation_id");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > config.limits.uploadBytes) throw new ApiError(413, "too_large", "Files can be up to 25 MB.");
    if (!contentMatches(mime, bytes)) throw new ApiError(415, "unsupported_type", "The file content does not match its type.");
    const path = `${actor.userId}/${conversationId ?? "unsorted"}/${crypto.randomUUID()}.${type.ext}`;
    await services.uploadObject(path, bytes, mime);
    try {
      const media = await services.rpc("atlas_ai_media_register", {
        ...actorArgs(actor),
        p_conversation_id: conversationId,
        p_path: path,
        p_mime: mime,
        p_bytes: bytes.byteLength,
        p_kind: type.kind,
        p_sha256: await sha256Hex(bytes),
        p_bucket: "atlas-ai-media",
      });
      return { media };
    } catch (error) {
      await services.removeObjects([path]).catch(() => null);
      throw error;
    }
  }

  async function mediaUrl(request, actor) {
    const url = new URL(request.url);
    const media = await services.rpc("atlas_ai_media_get", { p_media_id: requireUuid(url.searchParams.get("id"), "id"), ...actorArgs(actor) });
    const expiresIn = 300;
    return { url: await services.signObject(media.path, expiresIn), expires_in: expiresIn, mime: media.mime, kind: media.kind };
  }

  // --- Voice ----------------------------------------------------------------

  async function transcribe(request, actor) {
    await requireAi(actor, { count: true });
    const { form, file } = await readMultipart(request, config.limits.transcribeBytes);
    const mime = normaliseAudioMime(file.type);
    if (!AUDIO_TYPES[mime]) throw new ApiError(415, "unsupported_type", "Record voice notes as WebM, Ogg, MP4, MPEG or WAV audio.");
    const conversationId = uuidOrNull(form.get("conversation_id"), "conversation_id");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const keywords = await transcriptionKeywords(services, actor, config.limits.transcriptionKeywords);
    const runId = await startRun(services, actor, conversationId, "voice_note", { transcribe: config.models.transcribe });
    let transcript;
    try {
      transcript = await transcribeAudio(runtime, openaiApiKey(env), { bytes, mime, keywords });
    } catch (error) {
      await finishRun(services, actor, runId, { status: "failed", errorCode: error?.code ?? "provider_error" });
      throw error;
    }
    await finishRun(services, actor, runId, { status: "completed", models: { transcribe: config.models.transcribe } });
    // Audio is kept only when the owner chose keep_with_media.
    let media = null;
    const settingsValue = await safeRpc(services, "atlas_ai_settings_get", actorArgs(actor));
    if (settingsValue?.audio_retention === "keep_with_media") {
      const type = UPLOAD_TYPES[mime];
      const path = `${actor.userId}/${conversationId ?? "unsorted"}/${crypto.randomUUID()}.${type.ext}`;
      try {
        await services.uploadObject(path, bytes, mime);
        media = await services.rpc("atlas_ai_media_register", {
          ...actorArgs(actor), p_conversation_id: conversationId, p_path: path, p_mime: mime,
          p_bytes: bytes.byteLength, p_kind: "audio", p_sha256: await sha256Hex(bytes), p_bucket: "atlas-ai-media",
        });
      } catch {
        await services.removeObjects([path]).catch(() => null);
        media = null;
      }
    }
    return {
      text: transcript.text,
      duration: transcript.duration,
      source: "voice_note",
      media_id: media?.id ?? null,
      audio_retained: Boolean(media),
    };
  }

  async function ensureConversation(actor, conversationId) {
    if (conversationId) return conversationId;
    const created = await services.rpc("atlas_ai_conversation_create", { ...actorArgs(actor), p_title: "Voice conversation", p_context: {} });
    return created.id;
  }

  async function voiceSession(body, actor) {
    const gateway = gatewayOrUnavailable();
    await requireAi(actor, { count: true });
    if (!throttle(actor.userId, now())) {
      throw new ApiError(429, "rate_limited", "Too many voice sessions started. Please wait a minute.");
    }
    const conversationId = await ensureConversation(actor, uuidOrNull(body.conversation_id, "conversation_id"));
    if (body.conversation_id) {
      // Ownership check before minting.
      await services.rpc("atlas_ai_conversation_get", {
        p_conversation_id: conversationId, ...actorArgs(actor), p_limit: 1, p_before_id: null, p_include_items: false,
      });
    }
    const preferencesValue = (await safeRpc(services, "atlas_ai_preferences_get", actorArgs(actor))) ?? {};
    const keywords = await transcriptionKeywords(services, actor, 60);
    const session = buildRealtimeSession({
      config, actor, gateway, keywords, preferences: preferencesValue, nowIso: new Date(now()).toISOString(), conversationId,
    });
    const runId = await startRun(services, actor, conversationId, "voice", { realtime: config.models.realtime });
    let minted;
    try {
      minted = await mintRealtimeSecret(runtime, openaiApiKey(env), session, config.limits.realtimeSecretSeconds);
    } catch (error) {
      await finishRun(services, actor, runId, { status: "failed", errorCode: error?.code ?? "provider_error" });
      throw error;
    }
    await finishRun(services, actor, runId, { status: "completed", models: { realtime: config.models.realtime, voice: config.voice } });
    return {
      client_secret: minted.value,
      expires_at: minted.expires_at ?? null,
      model: config.models.realtime,
      voice: config.voice,
      session_id: minted.session?.id ?? null,
      conversation_id: conversationId,
      run_id: runId,
    };
  }

  function parseToolArguments(value) {
    if (value === undefined || value === null || value === "") return {};
    if (typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value === "string" && value.length <= 32768) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch { /* fall through */ }
    }
    throw new ApiError(400, "invalid_request", "arguments must be a JSON object.");
  }

  async function voiceTool(body, actor) {
    const gateway = gatewayOrUnavailable();
    const conversationId = requireUuid(body.conversation_id, "conversation_id");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!/^[a-z][a-z0-9_.]{0,119}$/.test(name)) throw new ApiError(400, "invalid_request", "Unknown voice tool.");
    const args = parseToolArguments(body.arguments);
    const voiceSessionId = typeof body.voice_session_id === "string" ? body.voice_session_id.slice(0, 120) : null;

    if (name === "ask_atlas") {
      await requireAi(actor, { count: true });
      const request = String(args.request ?? "").trim().slice(0, config.limits.messageChars);
      if (!request) throw new ApiError(400, "invalid_request", "ask_atlas needs a request.");
      const runId = await startRun(services, actor, conversationId, "voice", { orchestrator: config.models.orchestrator, voice_session_id: voiceSessionId });
      const proposals = [];
      const { text, turn, usage } = await runAskAtlas({
        deps: runtime, config, actor, conversationId, request, runId, emitProposal: (proposal) => proposals.push(proposal),
      });
      await finishRun(services, actor, runId, {
        status: "completed", tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, toolCalls: turn.toolCalls,
        models: { orchestrator: config.models.orchestrator },
      });
      return { output: text.slice(0, 4000), proposal: proposals.at(-1) ?? null, proposals, records: turn.records, evidence: turn.evidence };
    }

    await requireAi(actor, { count: false });
    const entry = (gateway.toolsForRole(actor.role, { levels: ["read", "draft"] }) ?? [])
      .find((candidate) => candidate && candidate.level !== "execute" && (candidate.fnName === name || candidate.name === name));
    if (!entry) throw new ApiError(403, "forbidden", "That is not available for your Atlas role.");
    const runId = await startRun(services, actor, conversationId, "voice_tool", { voice_session_id: voiceSessionId, call_id: String(body.call_id ?? "").slice(0, 120) });
    const conv = await services.rpc("atlas_ai_conversation_get", {
      p_conversation_id: conversationId, ...actorArgs(actor), p_limit: 1, p_before_id: null, p_include_items: false,
    });
    const turn = new TurnState({
      services, gateway, actor, env, fetchImpl, now, venue: config.venue, conversationId, messageId: null, runId,
      context: conv?.conversation?.context ?? {}, toolOutputChars: config.limits.toolOutputChars,
    });
    const { result, proposal } = await turn.runTool(entry, args);
    if (Object.keys(turn.contextPatch).length) {
      await safeRpc(services, "atlas_ai_conversation_context_merge", {
        p_conversation_id: conversationId, ...actorArgs(actor), p_patch: turn.contextPatch,
      });
    }
    await finishRun(services, actor, runId, { status: result.ok ? "completed" : "failed", toolCalls: 1, errorCode: result.ok ? null : String(result.error?.code ?? "failed").slice(0, 120) });
    return { output: voiceToolOutput(result, proposal), proposal, records: turn.records, evidence: turn.evidence };
  }

  async function voiceAppend(body, actor) {
    const conversationId = requireUuid(body.conversation_id, "conversation_id");
    if (!Array.isArray(body.turns) || !body.turns.length || body.turns.length > config.limits.voiceTurns) {
      throw new ApiError(400, "invalid_request", `Send 1 to ${config.limits.voiceTurns} transcript turns.`);
    }
    const messages = body.turns.map((turn) => {
      const role = turn?.role === "assistant" ? "assistant" : turn?.role === "user" ? "user" : null;
      const content = redactSecrets(String(turn?.text ?? "").trim()).slice(0, config.limits.voiceTurnChars);
      const requestId = typeof turn?.client_request_id === "string" ? turn.client_request_id.trim() : "";
      if (!role || !content || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
        throw new ApiError(400, "invalid_request", "Each turn needs a role (user or assistant), text and a client_request_id.");
      }
      return { role, content, source: "live_voice", items: historyItemsFor({ role, content, status: "complete" }), client_request_id: requestId };
    });
    return services.rpc("atlas_ai_messages_append", { p_conversation_id: conversationId, ...actorArgs(actor), p_messages: messages });
  }

  async function speak(body, actor) {
    const text = typeof body.text === "string" ? redactSecrets(body.text.trim()) : "";
    if (!text) throw new ApiError(400, "invalid_request", "There is nothing to read aloud.");
    if (text.length > config.limits.speakChars) throw new ApiError(400, "too_long", `Read-aloud is limited to ${config.limits.speakChars} characters.`);
    await requireAi(actor, { count: true });
    const runId = await startRun(services, actor, null, "voice", { speech: config.models.speech, voice: config.voice });
    let audio;
    try {
      audio = await synthesiseSpeech(runtime, openaiApiKey(env), text);
    } catch (error) {
      await finishRun(services, actor, runId, { status: "failed", errorCode: error?.code ?? "provider_error" });
      throw error;
    }
    await finishRun(services, actor, runId, { status: "completed", models: { speech: config.models.speech } });
    return new Response(audio, {
      status: 200,
      headers: { ...CORS_HEADERS, "content-type": "audio/mpeg", "content-length": String(audio.byteLength) },
    });
  }

  // --- Background -------------------------------------------------------------

  async function serviceActor(request) {
    const secret = env("ATLAS_AI_SERVICE_SECRET");
    const provided = request.headers.get("x-atlas-ai-service-secret");
    if (!secret || secret.length < 32 || !provided || !timingSafeEqual(secret, provided)) return null;
    return { service: true };
  }

  async function backgroundActor() {
    const id = env("ATLAS_AI_BACKGROUND_ACTOR_ID");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(503, "not_configured", "Background signals need ATLAS_AI_BACKGROUND_ACTOR_ID.");
    const profile = await services.profileById(id);
    if (!profile || profile.active !== true || !MANAGER_ROLES.includes(profile.role)) {
      throw new ApiError(503, "not_configured", "The background actor must be an active manager or administrator.");
    }
    const label = profile.display_name || profile.email || "Atlas background";
    return { userId: profile.id, role: profile.role, active: true, displayName: profile.display_name ?? null, label, email: profile.email ?? null, token: null, background: true };
  }

  async function signals(actor) {
    const gateway = gatewayOrUnavailable();
    const runId = await startRun(services, actor, null, "background", { signals: "deterministic" });
    try {
      const result = await refreshSignals({ deps: { ...runtime, gateway }, config, actor, runId });
      await finishRun(services, actor, runId, { status: "completed", toolCalls: result.tool_calls });
      return result;
    } catch (error) {
      await finishRun(services, actor, runId, { status: "failed", errorCode: error?.code ?? "failed" });
      throw error;
    }
  }

  // --- Routing ----------------------------------------------------------------

  const JSON_ROUTES = {
    conversations: { methods: ["GET"], run: (request, actor) => conversations(request, actor) },
    conversation: { methods: ["GET"], run: (request, actor) => conversation(request, actor) },
    create: { methods: ["POST"], body: true, run: (body, actor) => create(body, actor) },
    rename: { methods: ["POST"], body: true, run: (body, actor) => rename(body, actor) },
    pin: { methods: ["POST"], body: true, run: (body, actor) => pin(body, actor) },
    archive: { methods: ["POST"], body: true, run: (body, actor) => archive(body, actor) },
    delete: { methods: ["POST"], body: true, run: (body, actor) => remove(body, actor) },
    preferences: { methods: ["GET", "POST"], run: (request, actor) => preferences(request, actor) },
    settings: { methods: ["GET", "POST"], run: (request, actor) => settings(request, actor) },
    "execute-action": { methods: ["POST"], body: true, run: (body, actor) => executeAction(body, actor) },
    "reject-action": { methods: ["POST"], body: true, run: (body, actor) => rejectAction(body, actor) },
    upload: { methods: ["POST"], run: (request, actor) => upload(request, actor) },
    "media-url": { methods: ["GET"], run: (request, actor) => mediaUrl(request, actor) },
    transcribe: { methods: ["POST"], run: (request, actor) => transcribe(request, actor) },
    "voice-session": { methods: ["POST"], body: true, run: (body, actor) => voiceSession(body, actor) },
    "voice-tool": { methods: ["POST"], body: true, run: (body, actor) => voiceTool(body, actor) },
    "voice-append": { methods: ["POST"], body: true, run: (body, actor) => voiceAppend(body, actor) },
  };

  return async function handle(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get("action") ?? "";

      if (action === "maintenance" || action === "refresh-signals") {
        if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Use POST for this action.");
        const service = await serviceActor(request);
        if (action === "maintenance") {
          if (!service) throw new ApiError(401, "unauthorized", "This action is for the Atlas scheduler only.");
          return jsonResponse(await runMaintenance({ services }));
        }
        const actor = service ? await backgroundActor() : await resolve(request);
        if (!service && !MANAGER_ROLES.includes(actor.role)) {
          throw new ApiError(403, "forbidden", "Background signals can be refreshed by managers and administrators.");
        }
        return jsonResponse(await signals(actor));
      }

      if (action === "chat" || action === "speak") {
        if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Use POST for this action.");
        const actor = await resolve(request);
        if (action === "chat") return await chat(request, actor);
        const body = await readJsonBody(request, config.limits.jsonBodyBytes);
        return await speak(body, actor);
      }

      const route = JSON_ROUTES[action];
      if (!route) throw new ApiError(404, "unknown_action", "Unknown Atlas AI action.");
      if (!route.methods.includes(request.method)) throw new ApiError(405, "method_not_allowed", `Use ${route.methods.join(" or ")} for this action.`);
      const actor = await resolve(request);
      const value = route.body
        ? await route.run(await readJsonBody(request, config.limits.jsonBodyBytes), actor)
        : await route.run(request, actor);
      return jsonResponse(value ?? {});
    } catch (error) {
      if (error instanceof AuthError || error instanceof ApiError) return errorResponse(error);
      return errorResponse(error);
    }
  };
}
