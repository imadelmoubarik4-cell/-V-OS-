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

import { resolveActor as sharedResolveActor, actorLabel, AuthError, MANAGER_ROLES, safeDisplayName } from "../_shared/auth.mjs";
import { loadConfig, openaiApiKey } from "./config.mjs";
import {
  ApiError,
  CORS_HEADERS,
  NOT_CONFIGURED,
  createServices,
  errorResponse,
  jsonResponse,
  readBodyBytes,
  readJsonBody,
  requireUuid,
  uuidOrNull,
} from "./http.mjs";
import { prepareChatTurn, streamChatTurn, validateChatBody, runAskAtlas, startRun, finishRun, safeRpc, resolveVenue } from "./chat.mjs";
import {
  AUDIO_TYPES,
  buildRealtimeSession,
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

// Content sniffing so a renamed file is not accepted as a photo, PDF, text
// document or audio: every allowed type is checked against its magic bytes
// (unknown types are refused).
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "heif", "mif2", "avif", "avis"]);
const MP4_AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P ", "mp41", "mp42", "isom", "iso2", "iso4", "iso5", "iso6", "dash", "3gp4", "3gp5", "3gp6", "3g2a", "f4a "]);

// Major and compatible brands of an ISO-BMFF "ftyp" box, or null.
function ftypBrands(b) {
  const ascii4 = (start) => String.fromCharCode(b[start], b[start + 1], b[start + 2], b[start + 3]);
  if (b.length < 12 || ascii4(4) !== "ftyp") return null;
  const size = (b[0] * 16777216) + (b[1] << 16) + (b[2] << 8) + b[3];
  const end = Math.min(b.length, size >= 16 && size <= 4096 ? size : 16);
  const brands = [ascii4(8)];
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(ascii4(offset));
  return brands;
}

export function contentMatches(mime, bytes) {
  const b = bytes;
  if (!b || typeof b.length !== "number" || b.length < 4) return false;
  const ascii = (start, text) => [...text].every((ch, index) => b[start + index] === ch.charCodeAt(0));
  switch (mime) {
    case "image/jpeg": return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png": return b[0] === 0x89 && ascii(1, "PNG");
    case "image/webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "image/heic":
    case "image/heif": {
      // ISO-BMFF whose major brand is a HEIF image brand, or a HEIF brand
      // among the compatible brands of a file that is not an MP4 container.
      const brands = ftypBrands(b);
      if (!brands) return false;
      if (HEIF_BRANDS.has(brands[0])) return true;
      return !MP4_AUDIO_BRANDS.has(brands[0]) && !["qt  ", "avc1", "mp4v"].includes(brands[0])
        && brands.slice(1).some((brand) => HEIF_BRANDS.has(brand));
    }
    case "application/pdf": return ascii(0, "%PDF-");
    case "text/plain":
    case "text/csv":
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, 65536));
        return !text.includes("\u0000");
      } catch {
        return false;
      }
    // EBML (WebM/Matroska), Ogg, RIFF/WAVE, MP3 (ID3 tag or MPEG frame sync)
    // and MP4 audio (ISO-BMFF with an MP4 brand and no HEIF brand).
    case "audio/webm": return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case "audio/ogg": return ascii(0, "OggS");
    case "audio/wav": return b.length >= 12 && ascii(0, "RIFF") && ascii(8, "WAVE");
    case "audio/mpeg": return ascii(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case "audio/mp4": {
      const brands = ftypBrands(b);
      return Boolean(brands) && !brands.some((brand) => HEIF_BRANDS.has(brand))
        && brands.some((brand) => MP4_AUDIO_BRANDS.has(brand));
    }
    default: return false;
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

// Multipart bodies are read with a byte limit (a declared length over the
// limit is refused before reading; a streamed body is cut off at the limit)
// and only then parsed.
async function readMultipart(request, maxBytes, overheadBytes) {
  const tooLarge = `Files can be up to ${Math.round(maxBytes / (1024 * 1024))} MB.`;
  const raw = await readBodyBytes(request, maxBytes + overheadBytes, { message: tooLarge });
  let form;
  try {
    form = await new Response(raw, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new ApiError(400, "invalid_request", "Send the file as multipart form data.");
  }
  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    throw new ApiError(400, "invalid_request", "Attach a file in the \"file\" field.");
  }
  if (file.size > maxBytes) throw new ApiError(413, "too_large", tooLarge);
  if (file.size === 0) throw new ApiError(400, "invalid_request", "The file is empty.");
  return { form, file };
}

// Model-influenced text (proposal titles) and user text (rejection reasons)
// is flattened before it is written into a system note: no markup, control
// characters or line breaks. Notes are replayed to the model as data.
export function noteText(value, max = 160) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, max);
}

// Fixed browser-facing messages for approved actions that failed. Gateway or
// downstream error text is never returned; the code is logged instead.
const ACTION_ERROR_MESSAGES = Object.freeze({
  forbidden: "Your Atlas role cannot run this action.",
  not_found: "Something this action needs could not be found. Nothing was changed.",
  conflict: "The record changed since this was prepared. Nothing was changed; prepare it again.",
  draft_exists: "This supplier already has a Draft order in Purchasing, so Atlas did not create a second one. Ask Atlas again to add these lines to that draft.",
  invalid_arguments: "The stored action is not valid and was not run.",
  not_executable: "Atlas does not make this change. Open the linked screen to review it yourself.",
  unavailable: "Atlas could not complete this action right now. Nothing was confirmed.",
  failed: "The action could not be completed.",
});

function actionError(outcome) {
  const raw = String(outcome?.error?.code ?? "failed");
  const code = Object.hasOwn(ACTION_ERROR_MESSAGES, raw) ? raw : "failed";
  return { code, message: ACTION_ERROR_MESSAGES[code] };
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
    for (const key of [
      "enabled", "media_retention_days", "audio_retention", "daily_turn_limit_per_user",
      "voice_sessions_per_day", "voice_minutes_per_day", "max_concurrent_voice_sessions",
      "upload_bytes_per_day", "upload_files_per_day",
    ]) if (key in patch) allowed[key] = patch[key];
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
      // The action id links catalogue requests to this proposal (Brain decisions).
      outcome = await gateway.executeProposal(action.kind, transition.command, { ...turn.gatewayCtx, actionId });
    } catch {
      outcome = { ok: false, error: { code: "failed", message: "The action could not be completed." } };
    }
    const ok = outcome?.ok === true;
    const failure = ok ? null : actionError(outcome);
    if (!ok) console.warn("[atlas-ai] approved action failed", action.kind, failure.code);
    const errorMessage = ok ? null : failure.message;
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
    const summary = ok && typeof outcome.result?.summary === "string" ? noteText(redactSecrets(outcome.result.summary), 300) : "";
    const title = noteText(action.title) || "Proposal";
    const note = ok
      ? `Approved by ${noteText(actor.label, 120)}: ${title}. Done.${summary ? ` ${summary}` : ""}`
      : `Approved by ${noteText(actor.label, 120)}: ${title}. It could not be completed: ${errorMessage}`;
    const noteId = await appendNote(actor, action.conversation_id, note, `action:${actionId}:${ok ? "executed" : "failed"}`);
    return {
      ok,
      action: finished?.action ?? action,
      result: ok ? boundedResult(outcome.result ?? {}) : null,
      error: ok ? null : { code: failure.code, message: errorMessage },
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
    const noteReason = noteText(reason, 300);
    const noteId = await appendNote(actor, action.conversation_id,
      `Rejected by ${noteText(actor.label, 120)}: ${noteText(action.title) || "Proposal"}.${noteReason ? ` Reason: ${noteReason}` : ""}`, `action:${actionId}:rejected`);
    return { ok: true, action, note_message_id: noteId };
  }

  // --- Media ----------------------------------------------------------------

  async function upload(request, actor) {
    // Uploads follow the Atlas AI switch (not the turn limit); the per-user
    // daily byte and file quotas are enforced atomically in
    // atlas_ai_media_register.
    await requireAi(actor, { count: false });
    const { form, file } = await readMultipart(request, config.limits.uploadBytes, config.limits.multipartOverheadBytes);
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
    const { form, file } = await readMultipart(request, config.limits.transcribeBytes, config.limits.multipartOverheadBytes);
    const mime = normaliseAudioMime(file.type);
    if (!AUDIO_TYPES[mime]) throw new ApiError(415, "unsupported_type", "Record voice notes as WebM, Ogg, MP4, MPEG or WAV audio.");
    const conversationId = uuidOrNull(form.get("conversation_id"), "conversation_id");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!contentMatches(mime, bytes)) throw new ApiError(415, "unsupported_type", "The recording content does not match its audio type.");
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

  // Live voice (F1/F11): the mint is reserved atomically in the database
  // (enabled, durable per-minute throttle, daily turn limit, daily voice
  // sessions, concurrency and the estimated minutes budget) before the
  // provider is called. The returned voice_session_id (or the provider
  // session_id) must accompany voice-tool, voice-append and voice-heartbeat
  // calls. S91: the reservation has a short idle lease the connected client
  // renews (voice-heartbeat); `takeover: true` ("Continue here") ends the
  // same person's other live voice sessions in the same transaction.
  async function voiceSession(body, actor) {
    const gateway = gatewayOrUnavailable();
    await requireAi(actor, { count: true });
    const conversationId = await ensureConversation(actor, uuidOrNull(body.conversation_id, "conversation_id"));
    if (body.conversation_id) {
      // Ownership check before minting.
      await services.rpc("atlas_ai_conversation_get", {
        p_conversation_id: conversationId, ...actorArgs(actor), p_limit: 1, p_before_id: null, p_include_items: false,
      });
    }
    const preferencesValue = (await safeRpc(services, "atlas_ai_preferences_get", actorArgs(actor))) ?? {};
    const keywords = await transcriptionKeywords(services, actor, 60);
    const venue = await resolveVenue(services, config, actor);
    const session = buildRealtimeSession({
      config, actor, gateway, keywords, preferences: preferencesValue, nowIso: new Date(now()).toISOString(), conversationId, venue,
    });
    const reserved = await services.rpc("atlas_ai_voice_session_start", {
      ...actorArgs(actor),
      p_conversation_id: conversationId,
      p_models: { realtime: config.models.realtime },
      p_mints_per_minute: config.limits.voiceMintsPerMinute,
      p_takeover: body.takeover === true,
      p_lease_seconds: config.limits.voiceLeaseSeconds,
    });
    const voiceSessionId = reserved?.voice_session_id ?? null;
    const runId = reserved?.run_id ?? null;
    let minted;
    try {
      minted = await mintRealtimeSecret(runtime, openaiApiKey(env), session, config.limits.realtimeSecretSeconds);
    } catch (error) {
      if (voiceSessionId) {
        await safeRpc(services, "atlas_ai_voice_session_touch", {
          p_voice_session_id: voiceSessionId, ...actorArgs(actor), p_event: "mint_failed", p_provider_session_id: null,
        });
      }
      await finishRun(services, actor, runId, { status: "failed", errorCode: error?.code ?? "provider_error" });
      throw error;
    }
    await finishRun(services, actor, runId, { status: "completed", models: { realtime: config.models.realtime, voice: config.voice } });
    const providerSessionId = typeof minted.session?.id === "string" ? minted.session.id.slice(0, 120) : null;
    if (voiceSessionId && providerSessionId) {
      await safeRpc(services, "atlas_ai_voice_session_touch", {
        p_voice_session_id: voiceSessionId, ...actorArgs(actor), p_event: "activate", p_provider_session_id: providerSessionId,
      });
    }
    return {
      client_secret: minted.value,
      expires_at: minted.expires_at ?? null,
      model: config.models.realtime,
      voice: config.voice,
      session_id: providerSessionId,
      voice_session_id: voiceSessionId,
      voice_session_expires_at: reserved?.hard_expires_at ?? null,
      lease_seconds: Number(reserved?.lease_seconds) || config.limits.voiceLeaseSeconds,
      heartbeat_seconds: config.limits.voiceHeartbeatSeconds,
      replaced_sessions: Number(reserved?.replaced_sessions) || 0,
      conversation_id: conversationId,
      run_id: runId,
    };
  }

  // The live voice session owned by the actor (Atlas voice_session_id, or the
  // provider session_id returned by voice-session). Throws
  // voice_session_inactive when it is missing, unknown or over, and
  // voice_session_replaced when another device took the call over.
  async function touchVoiceSession(actor, body, event) {
    const raw = typeof body.voice_session_id === "string" && body.voice_session_id.trim()
      ? body.voice_session_id
      : typeof body.session_id === "string" ? body.session_id : "";
    const key = raw.trim().slice(0, 120);
    if (!key) throw new ApiError(409, "voice_session_inactive", "This live voice session has ended. Start a new one to continue.");
    return services.rpc("atlas_ai_voice_session_touch", {
      p_voice_session_id: key, ...actorArgs(actor), p_event: event, p_provider_session_id: null,
    });
  }

  function assertVoiceConversation(voice, conversationId) {
    if (voice?.conversation_id && voice.conversation_id !== conversationId) {
      throw new ApiError(400, "invalid_request", "This voice session belongs to another conversation.");
    }
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

    if (name === "ask_atlas") {
      await requireAi(actor, { count: true });
      const voice = await touchVoiceSession(actor, body, "tool");
      assertVoiceConversation(voice, conversationId);
      const voiceSessionId = voice?.voice_session_id ?? null;
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
    const voice = await touchVoiceSession(actor, body, "tool");
    assertVoiceConversation(voice, conversationId);
    const voiceSessionId = voice?.voice_session_id ?? null;
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
    const voice = await touchVoiceSession(actor, body, "append");
    assertVoiceConversation(voice, conversationId);
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
      // Transcripts come from the browser: stored as client-transcribed and
      // untrusted, with no evidence, records or proposals (security G5).
      // Assistant-role turns replay to the model only as quoted transcript.
      const metadata = { source: "live_voice_client", untrusted: true };
      return {
        role, content, source: "live_voice", metadata, evidence: [], records: [], proposals: [],
        items: historyItemsFor({ role, content, source: "live_voice", metadata, status: "complete" }),
        client_request_id: requestId,
      };
    });
    const appended = await services.rpc("atlas_ai_messages_append", { p_conversation_id: conversationId, ...actorArgs(actor), p_messages: messages });
    if (body.ended === true) await touchVoiceSession(actor, body, "end");
    return appended;
  }

  // The connected live client renews its idle lease (about every 45 s). A
  // session whose page died without voice-end then frees its slot within
  // the lease instead of blocking the next call.
  async function voiceHeartbeat(body, actor) {
    const voice = await touchVoiceSession(actor, body, "heartbeat");
    return {
      live: voice?.live === true,
      voice_session_id: voice?.voice_session_id ?? null,
      lease_expires_at: voice?.lease_expires_at ?? null,
      hard_expires_at: voice?.hard_expires_at ?? null,
    };
  }

  // Ends a live voice session: frees the concurrency slot and stops Atlas
  // serving its tools. The browser closes the Realtime call itself; the
  // server cannot force-close an established call.
  async function voiceEnd(body, actor) {
    const voice = await touchVoiceSession(actor, body, "end");
    return { ended: true, voice_session_id: voice?.voice_session_id ?? null, ended_at: voice?.ended_at ?? null };
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
    const label = actorLabel(profile, "Atlas background");
    return { userId: profile.id, role: profile.role, active: true, displayName: safeDisplayName(profile.display_name), label, email: profile.email ?? null, token: null, background: true };
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
    "voice-heartbeat": { methods: ["POST"], body: true, run: (body, actor) => voiceHeartbeat(body, actor) },
    "voice-end": { methods: ["POST"], body: true, run: (body, actor) => voiceEnd(body, actor) },
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
