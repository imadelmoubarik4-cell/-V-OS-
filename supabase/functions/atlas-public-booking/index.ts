import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createPublicBookingHandler } from "./handler.mjs";

// atlas-public-booking (S107): the narrowly scoped PUBLIC (guest) booking service
// for the KANEL website — separate from the staff atlas-bookings function. All
// logic lives in handler.mjs; this file only wires the Edge runtime.
//
// verify_jwt=false (supabase/config.toml): guests are unauthenticated. The handler
// is gated by the independent server flag PUBLIC_BOOKING_ENABLED (it behaves as if
// absent while off) and forwards to the service-role public.atlas_public_booking_*
// RPCs, which re-check the database flag (booking_settings.public_online_enabled)
// and enforce every approved rule (party cap, Bar-only, hours, horizon, buffer,
// section contiguity, 'requested' status, expiring holds, idempotency, rate limit).
// The service-role key never leaves the server; only minimal JSON is returned.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Config: PUBLIC_BOOKING_ENABLED ("true" to enable), PUBLIC_BOOKING_ORIGINS
// (comma-separated CORS allowlist), PUBLIC_BOOKING_SALT (MANDATORY strong
// fingerprint salt, >=16 chars — the function fails safe without it),
// PUBLIC_BOOKING_TRUSTED_HOPS (trusted proxy hops for X-Forwarded-For; default 1).

const handle = createPublicBookingHandler({
  env: (name: string) => Deno.env.get(name),
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
});

Deno.serve((request: Request) => handle(request));
