import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Atlas users authenticate against the production VÁ Auth project while the
// Sprint 4 briefing reads only the isolated development branch. The platform
// JWT check is disabled in config.toml because a production-project JWT cannot
// be validated by the branch gateway. This function verifies that JWT directly
// against production Auth, confirms the server-controlled manager/admin profile,
// and only then calls the branch's service-role-only briefing RPC.
const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ManagerContext = {
  user: { id: string; email?: string | null };
  profile: { id: string; email?: string | null; role: string; active: boolean };
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-briefing-version": "0.1.0",
    },
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  return match[1];
}

async function requireManager(request: Request): Promise<ManagerContext> {
  const token = bearerToken(request);
  const authHeaders = {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "cache-control": "no-store",
  };

  const userResponse = await fetch(`${AUTH_PROJECT_URL}/auth/v1/user`, {
    headers: authHeaders,
  });
  if (!userResponse.ok) throw new ApiError(401, "Your Atlas session has expired.");

  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.");

  const profileResponse = await fetch(
    `${AUTH_PROJECT_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,role,active`,
    { headers: authHeaders },
  );
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas role could not be verified.");

  const profiles = await profileResponse.json() as Array<{
    id: string;
    email?: string | null;
    role: string;
    active: boolean;
  }>;
  const profile = profiles[0];
  if (!profile?.active) throw new ApiError(403, "This Atlas profile is inactive.");
  if (profile.role !== "admin" && profile.role !== "manager") {
    throw new ApiError(403, "The Daily Atlas Briefing is limited to managers and administrators.");
  }

  return {
    user: { id: user.id, email: user.email },
    profile,
  };
}

async function branchRpc(name: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const branchUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "Sprint 4 branch credentials are unavailable.");
  }

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
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const message = typeof parsed === "object" && parsed && "message" in parsed
      ? String((parsed as { message: unknown }).message)
      : "The Daily Atlas Briefing database request failed.";
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    if (request.method !== "GET") throw new ApiError(405, "Method not allowed.");
    const context = await requireManager(request);
    const briefing = await branchRpc("atlas_sprint4_daily_briefing");

    return jsonResponse({
      briefing,
      manager: {
        id: context.user.id,
        email: context.profile.email ?? context.user.email ?? null,
        role: context.profile.role,
      },
      policy: {
        deterministic: true,
        ai_generation_used: false,
        automatic_mutation: false,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Daily Atlas Briefing API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Daily Atlas Briefing is temporarily unavailable." }, 500);
  }
});
