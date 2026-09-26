import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createMarketingMediaHandler } from "./handler.mjs";

// atlas-marketing-media (S94A): the Marketing media library. All logic lives
// in handler.mjs (the caller is resolved with _shared/auth.mjs resolveActor
// and must be an active manager or administrator); this file only wires the
// Edge runtime.
//
// verify_jwt=false (supabase/config.toml): the production Auth project issues
// the JWT, so the handler validates it and the active profile itself.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ATLAS_AUTH_PROJECT_URL,
// ATLAS_AUTH_PUBLISHABLE_KEY; optional ATLAS_MARKETING_MEDIA_TUS_URL (the TUS
// endpoint browsers upload large files to; default the project's direct
// storage host). No bytes pass through this function on upload: browsers get
// a one-time signed upload token for one server-chosen path.

const handle = createMarketingMediaHandler({
  env: (name: string) => Deno.env.get(name),
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  now: () => Date.now(),
});

Deno.serve((request: Request) => handle(request));
