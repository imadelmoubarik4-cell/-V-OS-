import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createBookingsHandler } from "./handler.mjs";

// atlas-bookings (S99): the staff booking workspace + the one authoritative
// availability/reservation service. All logic lives in handler.mjs (the caller is
// resolved with _shared/auth.mjs resolveActor and must be an active staff profile;
// manager-only actions — room configuration and availability rules — are enforced by the
// public.atlas_bookings_* RPCs); this file only wires the Edge runtime.
//
// verify_jwt=false (supabase/config.toml): the production Auth project issues the JWT, so
// the handler validates it and the active profile itself, then passes the resolved actor
// (never a browser-sent id/role) into the service-role RPCs, which re-check the actor and
// run the atomic check-and-reserve. Guest contact details and staff notes never leave the
// staff RPCs.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ATLAS_AUTH_PROJECT_URL,
// ATLAS_AUTH_PUBLISHABLE_KEY.

const handle = createBookingsHandler({
  env: (name: string) => Deno.env.get(name),
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
});

Deno.serve((request: Request) => handle(request));
