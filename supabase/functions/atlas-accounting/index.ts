import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createAccountingHandler } from "./handler.mjs";

// atlas-accounting (S92): supplier invoices, receipts and staff
// reimbursements for administrators. All logic lives in handler.mjs (the
// caller is resolved with _shared/auth.mjs resolveActor and must be an active
// admin) and extract.mjs; this file only wires the Edge runtime.
//
// verify_jwt=false (supabase/config.toml): the production Auth project issues
// the JWT, so the handler validates it and the active profile itself.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ATLAS_AUTH_PROJECT_URL,
// ATLAS_AUTH_PUBLISHABLE_KEY; optional OPENAI_API_KEY (without it, or while
// Atlas AI is switched off, documents are typed in by hand),
// ATLAS_RECOGNITION_MODEL_VISION / ATLAS_AI_MODEL_VISION and
// ATLAS_AI_OPENAI_BASE_URL.

const handle = createAccountingHandler({
  env: (name: string) => Deno.env.get(name),
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  newId: () => crypto.randomUUID(),
});

Deno.serve((request: Request) => handle(request));
