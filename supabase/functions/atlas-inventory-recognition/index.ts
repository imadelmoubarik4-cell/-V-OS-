import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createRecognitionHandler } from "./handler.mjs";

// atlas-inventory-recognition: visual inventory recognition (identify,
// search, outcomes, proposals, duplicate check, my requests). It returns
// candidates, bands, field confidence and evidence; it never changes stock,
// items, codes or aliases. All logic lives in handler.mjs and
// _shared/recognition/*; this file only wires the Edge runtime.
//
// verify_jwt=false (supabase/config.toml): the production Auth project
// issues the JWT, so the handler validates it and the active profile itself
// (_shared/auth.mjs), like the other Atlas functions.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ATLAS_AUTH_PROJECT_URL,
// ATLAS_AUTH_PUBLISHABLE_KEY; optional OPENAI_API_KEY (without it, barcode
// and search still work and photos answer not_configured),
// ATLAS_RECOGNITION_MODEL_VISION (default: ATLAS_AI_MODEL_VISION, then the
// Atlas AI vision default) and ATLAS_AI_OPENAI_BASE_URL.

const handle = createRecognitionHandler({
  env: (name: string) => Deno.env.get(name),
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
});

Deno.serve((request: Request) => handle(request));
