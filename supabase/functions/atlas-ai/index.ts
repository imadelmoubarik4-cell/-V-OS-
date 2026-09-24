import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as agents from "npm:@openai/agents@0.18.0";
import { z } from "npm:zod@4";
import { createAtlasAiHandler } from "./handler.mjs";
import { loadConfig } from "./config.mjs";

// atlas-ai: the Atlas AI gateway (docs/ai/Atlas_AI_Architecture.md).
// Conversations, streamed chat (SSE), proposals and approvals, media,
// voice notes, live-voice credentials and tools, read-aloud, background
// signals and maintenance. All logic lives in handler.mjs and its modules;
// this file only wires the Edge runtime.
//
// verify_jwt=false (supabase/config.toml): the production Auth project issues
// the JWT, so the handler validates it and the active profile itself
// (_shared/auth.mjs), like the other Atlas functions.
//
// Secrets (function secrets only, never in apps/web): OPENAI_API_KEY,
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ATLAS_AUTH_PROJECT_URL,
// ATLAS_AUTH_PUBLISHABLE_KEY, optional ATLAS_AI_MODEL_* / ATLAS_AI_VOICE /
// ATLAS_AI_TRACING / ATLAS_AI_GUARDRAIL_CLASSIFIER, and for scheduled calls
// ATLAS_AI_SERVICE_SECRET (≥ 32 chars) + ATLAS_AI_BACKGROUND_ACTOR_ID.

const env = (name: string) => Deno.env.get(name);

// The Tool Gateway (_shared/ai-tools). If it cannot be loaded, model-backed
// actions answer 503 not_configured while conversation history keeps working.
const gateway = await import("../_shared/ai-tools/index.mjs").catch((error) => {
  console.error("[atlas-ai] Tool Gateway unavailable", error?.name ?? "Error");
  return null;
});
const config = loadConfig(env);

// OpenAI tracing stays off unless ATLAS_AI_TRACING=openai; sensitive data is
// never included in traces (the Runner sets traceIncludeSensitiveData=false).
agents.setTracingDisabled(config.tracing.disabled);

let provider: agents.OpenAIProvider | null = null;
function modelProvider() {
  if (!provider) {
    provider = new agents.OpenAIProvider({ apiKey: Deno.env.get("OPENAI_API_KEY") ?? "", useResponses: true });
  }
  return provider;
}

const handle = createAtlasAiHandler({
  env,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  now: () => Date.now(),
  sdk: agents,
  z,
  gateway,
  modelProvider,
});

Deno.serve(async (request: Request) => {
  const response = await handle(request);
  if (!config.tracing.disabled) {
    // Flush traces after the response without holding it back.
    // @ts-ignore EdgeRuntime is provided by Supabase Edge Functions.
    globalThis.EdgeRuntime?.waitUntil?.(agents.getGlobalTraceProvider().forceFlush());
  }
  return response;
});
