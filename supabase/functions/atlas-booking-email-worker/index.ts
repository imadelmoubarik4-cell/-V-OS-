import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createEmailWorkerHandler } from "./handler.mjs";
import { createSmtpClient } from "./smtp.mjs";
// Gateway contract (edge-auth-contract.test.js): every function imports the
// shared auth module. This worker has no user caller, so it never calls
// resolveActor: it is woken by pg_cron/pg_net and authenticates with the
// x-atlas-worker-secret header, compared in constant time in handler.mjs.
// AuthError is the shared type for a refused caller.
import { AuthError } from "../_shared/auth.mjs";

// atlas-booking-email-worker (S113): sends the queued KANEL guest booking emails
// from kanel@kanel.is through Google Workspace SMTP. verify_jwt=false
// (supabase/config.toml).
//
// Secrets (function secrets only): BOOKING_EMAIL_SMTP_PASSWORD (Google app
// password; unset -> nothing is sent), optional BOOKING_EMAIL_SMTP_USER /
// _HOST / _PORT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. The worker secret
// itself lives only in Vault (kanel_booking_email_worker_secret).

const handle = createEmailWorkerHandler({
  env: (name: string) => Deno.env.get(name),
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  smtp: createSmtpClient({ connect: (options: { hostname: string; port: number }) => Deno.connectTls(options) }),
  now: () => Date.now(),
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
