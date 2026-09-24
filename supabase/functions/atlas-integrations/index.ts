import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ApiError, createIntegrationsHandler, rpcFailure } from "./handler.mjs";

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

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";

type AtlasProfile = {
  id: string;
  email?: string | null;
  display_name?: string | null;
  role: string;
  active: boolean;
};

async function authenticate(request: Request) {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  const headers = {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${match[1]}`,
    accept: "application/json",
    "cache-control": "no-store",
  };
  const userResponse = await fetch(`${AUTH_PROJECT_URL}/auth/v1/user`, { headers });
  if (!userResponse.ok) throw new ApiError(401, "Your Atlas session has expired.");
  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.");

  const profileUrl = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${user.id}`);
  profileUrl.searchParams.set("select", "id,email,display_name,role,active");
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, { headers });
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas staff profile could not be verified.");
  const profile = (await profileResponse.json() as AtlasProfile[])[0];
  if (!profile?.active) throw new ApiError(403, "This Atlas profile is inactive.");
  return { user: { id: user.id, email: user.email ?? null }, profile };
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
