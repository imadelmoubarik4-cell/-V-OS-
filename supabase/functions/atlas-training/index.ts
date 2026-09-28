import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createTrainingHandler } from "./handler.mjs";

// atlas-training (S98): private video SOPs built on top of Knowledge — lessons,
// chapters, procedure steps, resume progress and explicit completion. All logic
// lives in handler.mjs (the caller is resolved with _shared/auth.mjs
// resolveActor and must be an active staff profile; manager-only actions are
// enforced by the public.atlas_training_* RPCs); this file only wires the Edge
// runtime.
//
// verify_jwt=false (supabase/config.toml): the production Auth project issues
// the JWT, so the handler validates it and the active profile itself, then
// passes the resolved actor (never a browser-sent id/role) to the service-role
// RPCs. Video bytes never pass through this function: the browser uploads
// straight to the private atlas-training-videos bucket with a one-time signed
// upload URL and plays back through a 5-minute signed URL.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ATLAS_AUTH_PROJECT_URL,
// ATLAS_AUTH_PUBLISHABLE_KEY.

const handle = createTrainingHandler({
  env: (name: string) => Deno.env.get(name),
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
});

Deno.serve((request: Request) => handle(request));
