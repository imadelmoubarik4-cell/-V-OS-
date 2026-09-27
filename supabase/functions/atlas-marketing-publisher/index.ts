import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createPublisherHandler } from "./handler.mjs";
import { openPublishingCredential } from "../_shared/integrations/credentials.mjs";
// Gateway contract (edge-auth-contract.test.js): every function imports the
// shared auth module. This worker has no user caller, so it never calls
// resolveActor: it is woken by pg_cron/pg_net (and the Marketing gateway's
// publish-now) and authenticates with the x-atlas-publisher-secret header,
// compared in constant time in handler.mjs. AuthError is the shared type for
// a refused caller.
import { AuthError } from "../_shared/auth.mjs";

// atlas-marketing-publisher (S94C): claims due marketing deliveries and
// publishes them through the provider adapters in _shared/publishing.
// verify_jwt=false (supabase/config.toml).
//
// Secrets (function secrets only): ATLAS_MARKETING_PUBLISHER_SECRET (≥ 32 bytes,
// also held in Vault for the tick), optional ATLAS_MARKETING_PUBLISHER_SECRET_NEXT
// (rotation), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, the integration KEK read
// by the credential module, ATLAS_META_GRAPH_VERSION (optional).
// Kill switch: ATLAS_MARKETING_PUBLISHER_ENABLED=false.

const handle = createPublisherHandler({
  env: (name: string) => Deno.env.get(name),
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  now: () => Date.now(),
  random: () => Math.random(),
  credentials: { openPublishingCredential },
});

Deno.serve(async (request: Request) => {
  try {
    return await handle(request);
  } catch (error) {
    const status = error instanceof AuthError ? 401 : 500;
    return new Response(JSON.stringify({ error: status === 401 ? "unauthorized" : "worker_error" }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
});
