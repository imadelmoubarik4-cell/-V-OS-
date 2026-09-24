// Atlas AI runtime configuration.
//
// Models are configuration, not code (docs/ai/Atlas_AI_Architecture.md §3):
// every model and the voice can be overridden with a function secret. The
// defaults follow the OpenAI recommendations current when this was built;
// switching models is an environment change followed by the evaluation suite.
//
// Plain ESM with no Deno APIs so Node and Deno tests can import it.

export const DEFAULT_MODELS = Object.freeze({
  orchestrator: "gpt-5.6-sol",
  specialist: "gpt-5.6-luna",
  vision: "gpt-5.6-sol",
  transcribe: "gpt-transcribe",
  realtime: "gpt-realtime-2.1",
  realtimeTranscribe: "gpt-live-transcribe",
  speech: "gpt-4o-mini-tts",
});

export const DEFAULT_VOICE = "marin";

// Voices the speech and Realtime APIs accept (openai@7.23 types).
export const KNOWN_VOICES = Object.freeze([
  "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar",
]);

export const LIMITS = Object.freeze({
  messageChars: 8000,
  attachments: 6,
  uploadBytes: 25 * 1024 * 1024,
  transcribeBytes: 25 * 1024 * 1024,
  speakChars: 1000,
  voiceTurns: 50,
  voiceTurnChars: 8000,
  jsonBodyBytes: 64 * 1024,
  maxTurns: 12,
  // History sent to the model: newest turns first until this budget
  // (estimated at 4 characters per token) is used.
  historyTokenBudget: 12000,
  historyMessages: 40,
  toolOutputChars: 12000,
  documentChars: 20000,
  modelAttachmentBytes: 20 * 1024 * 1024,
  // Total bytes of the attachments sent to the model in one turn (images and
  // PDFs are base64-inlined, so this bounds memory and input cost per turn).
  turnAttachmentBytes: 20 * 1024 * 1024,
  // Multipart overhead allowed above the file limit before the body is cut off.
  multipartOverheadBytes: 1024 * 1024,
  // Starts a Realtime session only; the call itself can last up to the
  // provider's session limit. Live usage is metered by atlas_ai_voice_session_*.
  realtimeSecretSeconds: 60,
  // Durable (database) mint throttle per user per minute.
  voiceMintsPerMinute: 6,
  // Realtime per-response and per-turn input bounds (client_secrets session).
  realtimeMaxOutputTokens: 1024,
  realtimeRetentionRatio: 0.8,
  realtimePostInstructionTokens: 16000,
  transcriptionKeywords: 100,
  pageContextChars: 400,
});

// Estimated USD per 1M tokens. ESTIMATES ONLY: collected from search
// snippets on 2026-09-24 because the official pricing page could not be
// opened; sources conflict for some models. ai_runs.est_cost_usd is labelled
// an estimate everywhere it is shown. Confirm on the official pricing page.
export const PRICE_TABLE_USD_PER_MTOK = Object.freeze({
  "gpt-6-astra": { input: 10, output: 50 },
  "gpt-6-sol": { input: 2, output: 10 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-5.6-sol": { input: 5, output: 30 },
  "gpt-5.6-terra": { input: 2.5, output: 15 },
  "gpt-5.6-luna": { input: 1, output: 6 },
  "gpt-realtime-2.1": { input: 4, output: 24 },
  "gpt-realtime-2.1-mini": { input: 0.6, output: 2.4 },
  "gpt-4o-mini-tts": { input: 0.6, output: 12 },
});
export const PRICE_TABLE_NOTE = "Estimated cost from an unverified price table; confirm on the official OpenAI pricing page.";

function read(env, name) {
  if (!env) return undefined;
  const value = typeof env.get === "function" ? env.get(name) : typeof env === "function" ? env(name) : env[name];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

function model(env, name, fallback) {
  const value = read(env, name);
  return value && MODEL_NAME.test(value) ? value : fallback;
}

export function loadConfig(env) {
  const tracingMode = (read(env, "ATLAS_AI_TRACING") || "off").toLowerCase() === "openai" ? "openai" : "off";
  const voice = read(env, "ATLAS_AI_VOICE");
  const classifier = (read(env, "ATLAS_AI_GUARDRAIL_CLASSIFIER") || "off").toLowerCase() === "model";
  const apiKey = read(env, "OPENAI_API_KEY") || "";
  return Object.freeze({
    models: Object.freeze({
      orchestrator: model(env, "ATLAS_AI_MODEL_ORCHESTRATOR", DEFAULT_MODELS.orchestrator),
      specialist: model(env, "ATLAS_AI_MODEL_SPECIALIST", DEFAULT_MODELS.specialist),
      vision: model(env, "ATLAS_AI_MODEL_VISION", DEFAULT_MODELS.vision),
      transcribe: model(env, "ATLAS_AI_MODEL_TRANSCRIBE", DEFAULT_MODELS.transcribe),
      realtime: model(env, "ATLAS_AI_MODEL_REALTIME", DEFAULT_MODELS.realtime),
      realtimeTranscribe: model(env, "ATLAS_AI_MODEL_REALTIME_TRANSCRIBE", DEFAULT_MODELS.realtimeTranscribe),
      speech: model(env, "ATLAS_AI_MODEL_SPEECH", DEFAULT_MODELS.speech),
    }),
    voice: voice && KNOWN_VOICES.includes(voice.toLowerCase()) ? voice.toLowerCase() : DEFAULT_VOICE,
    tracing: Object.freeze({
      mode: tracingMode,
      disabled: tracingMode !== "openai",
      // Even when tracing is on, tool and model inputs/outputs stay out of traces.
      includeSensitiveData: false,
    }),
    guardrailClassifier: classifier,
    openaiBaseUrl: (read(env, "ATLAS_AI_OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKeyPresent: Boolean(apiKey),
    venue: Object.freeze({
      name: read(env, "ATLAS_VENUE_NAME") || "VÁ",
      timezone: read(env, "ATLAS_VENUE_TIMEZONE") || "Atlantic/Reykjavik",
    }),
    limits: LIMITS,
  });
}

// The key is read on demand and never stored on the config object, so a
// config that is logged or serialised cannot leak it.
export function openaiApiKey(env) {
  return read(env, "OPENAI_API_KEY") || "";
}

export function estimateCostUsd(modelName, tokensIn, tokensOut) {
  const price = PRICE_TABLE_USD_PER_MTOK[modelName];
  if (!price) return null;
  const input = Math.max(0, Number(tokensIn) || 0);
  const output = Math.max(0, Number(tokensOut) || 0);
  return Math.round(((input * price.input + output * price.output) / 1e6) * 1e6) / 1e6;
}

export { read as readEnv };
