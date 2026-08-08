import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";
const FUNCTION_VERSION = "0.1.0";
const MANAGER_ROLES = new Set(["admin", "manager"]);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-atlas-request-id",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

type AtlasProfile = {
  id: string;
  email?: string | null;
  display_name?: string | null;
  role: string;
  active: boolean;
};

type AtlasContext = {
  token: string;
  user: { id: string; email?: string | null };
  profile: AtlasProfile;
};

class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = "REQUEST_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requestId(request: Request): string {
  const supplied = request.headers.get("x-atlas-request-id")?.trim();
  if (supplied && /^[0-9a-f-]{36}$/i.test(supplied)) return supplied;
  return crypto.randomUUID();
}

function jsonResponse(result: unknown, status = 200, id = crypto.randomUUID()): Response {
  return new Response(JSON.stringify({
    connection: {
      provider: "atlas-read-sources",
      state: status < 500 ? "healthy" : "degraded",
      checked_at: new Date().toISOString(),
      version: FUNCTION_VERSION,
    },
    result,
    request_id: id,
  }), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-read-sources-version": FUNCTION_VERSION,
      "x-atlas-request-id": id,
    },
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.", "AUTHENTICATION_REQUIRED");
  return match[1];
}

function profileLabel(profile: Partial<AtlasProfile> | null | undefined): string {
  return profile?.display_name?.trim()
    || profile?.email?.trim()
    || "Atlas manager";
}

async function requireManagerProfile(request: Request): Promise<AtlasContext> {
  const token = bearerToken(request);
  const headers = {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "cache-control": "no-store",
  };

  const userResponse = await fetch(`${AUTH_PROJECT_URL}/auth/v1/user`, { headers });
  if (!userResponse.ok) {
    throw new ApiError(401, "Your Atlas session has expired.", "AUTHENTICATION_EXPIRED");
  }
  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.", "AUTHENTICATION_EXPIRED");

  const profileUrl = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${user.id}`);
  profileUrl.searchParams.set("select", "id,email,display_name,role,active");
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, { headers });
  if (!profileResponse.ok) {
    throw new ApiError(403, "Your Atlas staff profile could not be verified.", "PERMISSION_DENIED");
  }
  const profiles = await profileResponse.json() as AtlasProfile[];
  const profile = profiles[0];
  if (!profile?.active) {
    throw new ApiError(403, "This Atlas profile is inactive. Source access has been removed.", "PERMISSION_DENIED");
  }
  if (!MANAGER_ROLES.has(profile.role)) {
    throw new ApiError(403, "Read-only Source Center is available only to managers and administrators.", "PERMISSION_DENIED");
  }
  return { token, user: { id: user.id, email: user.email }, profile };
}

function branchCredentials() {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "The private source service is unavailable.", "PRIVATE_SERVICE_UNAVAILABLE");
  }
  return { branchUrl, serviceRoleKey };
}

async function branchRpc(name: string, payload: Record<string, unknown>): Promise<any> {
  const { branchUrl, serviceRoleKey } = branchCredentials();
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
    console.error("Read Source RPC failed", name, response.status);
    throw new ApiError(500, "The private source snapshot failed.", "PRIVATE_RPC_FAILED");
  }
  return parsed;
}

Deno.serve(async (request: Request) => {
  const id = requestId(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireManagerProfile(request);
    if (request.method !== "GET") {
      throw new ApiError(405, "P2.2 Source Center is read-only.", "METHOD_NOT_ALLOWED");
    }
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";
    if (action !== "snapshot") throw new ApiError(404, "Unknown source action.", "NOT_FOUND");
    const requestedLimit = Number(url.searchParams.get("limit") || 200);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(500, Math.max(1, Math.trunc(requestedLimit)))
      : 200;

    const workspace = await branchRpc("atlas_read_sources_snapshot", {
      p_actor_id: context.user.id,
      p_actor_role: context.profile.role,
      p_limit: limit,
    });

    return jsonResponse({
      workspace,
      staff: {
        id: context.user.id,
        label: profileLabel(context.profile),
        role: context.profile.role,
        active: true,
        can_view_sources: true,
      },
      policy: {
        read_only: true,
        source_bodies_returned: false,
        private_urls_returned: false,
        credentials_returned: false,
        automatic_sync_enabled: false,
        production_source_mutation: false,
      },
    }, 200, id);
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse({ error: error.message, error_code: error.code }, error.status, id);
    }
    console.error("Read Source API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({
      error: "The read-only Source Center is temporarily unavailable.",
      error_code: "SERVICE_UNAVAILABLE",
    }, 500, id);
  }
});
