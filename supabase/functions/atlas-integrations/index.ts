import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ApiError, createIntegrationsHandler, rpcFailure } from "./handler.mjs";
import { AuthError, resolveActor } from "../_shared/auth.mjs";

// atlas-integrations: server-side OAuth / API-key connections for Google
// Business Profile, Google Drive, Facebook, Instagram, TikTok and Tripadvisor.
//
// verify_jwt=false (supabase/config.toml): the production Auth project issues
// the JWT, so the handler validates it and the active manager/admin profile
// itself (same pattern as atlas-settings). The provider callback carries no
// JWT; the single-use hashed state row identifies the manager who started it.
//
// Secrets (function secrets only, never in apps/web):
//   ATLAS_INTEGRATION_KEK_V1 (base64 32 bytes), ATLAS_INTEGRATION_KEK_CURRENT_VERSION,
//   ATLAS_INTEGRATIONS_APP_ORIGINS, ATLAS_INTEGRATIONS_PUBLIC_URL, ATLAS_INTEGRATIONS_CALLBACK_HOSTS,
//   ATLAS_GOOGLE_OAUTH_CLIENT_ID/SECRET, ATLAS_META_APP_ID/SECRET, ATLAS_META_GRAPH_VERSION,
//   ATLAS_TIKTOK_CLIENT_KEY/SECRET, ATLAS_TRIPADVISOR_VERIFY_URL, ATLAS_TRIPADVISOR_LOCATION_ID.
// The caller check is the shared gateway module (_shared/auth.mjs): its Auth
// project and publishable key come only from ATLAS_AUTH_PROJECT_URL /
// ATLAS_AUTH_PUBLISHABLE_KEY (or the managed Supabase values).

async function authenticate(request: Request) {
  try {
    const actor = await resolveActor(request, Deno.env, fetch, { inactiveMessage: "This Atlas profile is inactive." });
    return { user: { id: actor.userId }, profile: actor.profile };
  } catch (error) {
    if (error instanceof AuthError) throw new ApiError(error.status, error.message);
    throw error;
  }
}

async function rpc(name: string, payload: Record<string, unknown>): Promise<unknown> {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !serviceRoleKey) throw new ApiError(503, "The private integrations service is unavailable.");
  const response = await fetch(`${branchUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!response.ok) {
    // Never the raw PostgREST text: a fixed message and code; the SQLSTATE
    // is logged without the payload.
    const code = parsed && typeof parsed === "object" && "code" in parsed ? String((parsed as { code: unknown }).code) : "";
    const message = parsed && typeof parsed === "object" && "message" in parsed ? String((parsed as { message: unknown }).message) : "";
    console.warn("[atlas-integrations] rpc failed", name, response.status, code || "-");
    throw rpcFailure(response.status, code, message);
  }
  return parsed;
}

const handle = createIntegrationsHandler({
  env: (name: string) => Deno.env.get(name),
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  rpc,
  authenticate,
  now: () => Date.now(),
});

Deno.serve(handle);
