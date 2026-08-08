import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";
const FUNCTION_VERSION = "0.1.0";
const GITHUB_BRANCH_URL = "https://api.github.com/repos/imadelmoubarik4-cell/-V-OS-/commits/agent/sprint-4-phase-3-atlas-brain";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

const MANAGER_ROLES = new Set(["admin", "manager"]);

type AtlasProfile = {
  id: string;
  email?: string | null;
  display_name?: string | null;
  role: string;
  active: boolean;
  updated_at?: string | null;
};

type AtlasContext = {
  token: string;
  user: { id: string; email?: string | null };
  profile: AtlasProfile;
};

type ProductionSource = {
  source_key: string;
  label: string;
  status: "connected" | "partial" | "not_connected" | "no_records" | "stale" | "unknown";
  record_count: number;
  last_record_at: string | null;
  is_live: boolean;
  is_historical: boolean;
  trusted_for_brain: boolean;
  note: string | null;
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-system-version": FUNCTION_VERSION,
    },
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
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
  if (!userResponse.ok) throw new ApiError(401, "Your Atlas session has expired.");
  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.");

  const profileUrl = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${user.id}`);
  profileUrl.searchParams.set("select", "id,email,display_name,role,active,updated_at");
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, { headers });
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas staff profile could not be verified.");
  const profiles = await profileResponse.json() as AtlasProfile[];
  const profile = profiles[0];
  if (!profile?.active) throw new ApiError(403, "This Atlas profile is inactive. System access has been removed.");
  if (!MANAGER_ROLES.has(profile.role)) throw new ApiError(403, "System is available only to managers and administrators.");

  return { token, user: { id: user.id, email: user.email }, profile };
}

function productionHeaders(context: AtlasContext, extra: Record<string, string> = {}) {
  return {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${context.token}`,
    accept: "application/json",
    "cache-control": "no-store",
    ...extra,
  };
}

async function productionProfiles(context: AtlasContext): Promise<AtlasProfile[]> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  url.searchParams.set("select", "id,email,display_name,role,active,updated_at");
  url.searchParams.set("order", "active.desc,display_name.asc.nullslast,email.asc");
  url.searchParams.set("limit", "500");
  const response = await fetch(url, { headers: productionHeaders(context) });
  if (!response.ok) throw new ApiError(403, "Production profile context could not be read.");
  const rows = await response.json();
  return Array.isArray(rows) ? rows as AtlasProfile[] : [];
}

function exactCount(contentRange: string | null): number | null {
  const match = String(contentRange || "").match(/\/(\d+|\*)$/);
  if (!match || match[1] === "*") return null;
  const count = Number(match[1]);
  return Number.isFinite(count) ? count : null;
}

async function productionSource(
  context: AtlasContext,
  definition: {
    sourceKey: string;
    label: string;
    table: string;
    latestColumn: string;
    trustedForBrain: boolean;
  },
): Promise<ProductionSource> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/${definition.table}`);
  url.searchParams.set("select", `id,${definition.latestColumn}`);
  url.searchParams.set("order", `${definition.latestColumn}.desc.nullslast`);
  url.searchParams.set("limit", "1");

  try {
    const response = await fetch(url, {
      headers: productionHeaders(context, {
        Prefer: "count=exact",
        Range: "0-0",
      }),
    });
    const rows = await response.json().catch(() => []);
    if (!response.ok) {
      return {
        source_key: definition.sourceKey,
        label: definition.label,
        status: "partial",
        record_count: 0,
        last_record_at: null,
        is_live: true,
        is_historical: false,
        trusted_for_brain: false,
        note: `Source check failed (${response.status}).`,
      };
    }

    const count = exactCount(response.headers.get("content-range")) ?? (Array.isArray(rows) ? rows.length : 0);
    const latest = Array.isArray(rows) && rows[0] ? rows[0][definition.latestColumn] ?? null : null;
    return {
      source_key: definition.sourceKey,
      label: definition.label,
      status: count > 0 ? "connected" : "no_records",
      record_count: count,
      last_record_at: latest,
      is_live: true,
      is_historical: false,
      trusted_for_brain: definition.trustedForBrain && count > 0,
      note: count > 0 ? null : "Source is connected but contains no visible records.",
    };
  } catch (error) {
    return {
      source_key: definition.sourceKey,
      label: definition.label,
      status: "partial",
      record_count: 0,
      last_record_at: null,
      is_live: true,
      is_historical: false,
      trusted_for_brain: false,
      note: error instanceof Error ? error.message : "Source check failed.",
    };
  }
}

function latestProfileUpdate(profiles: AtlasProfile[]): string | null {
  return profiles
    .map((profile) => profile.updated_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
}

async function productionSources(context: AtlasContext, profiles: AtlasProfile[]): Promise<ProductionSource[]> {
  const definitions = [
    { sourceKey: "production-inventory", label: "Production inventory", table: "inventory_items", latestColumn: "updated_at", trustedForBrain: true },
    { sourceKey: "production-recipes", label: "Production recipes", table: "recipes", latestColumn: "updated_at", trustedForBrain: true },
    { sourceKey: "production-suppliers", label: "Production suppliers", table: "suppliers", latestColumn: "updated_at", trustedForBrain: true },
    { sourceKey: "production-movements", label: "Production inventory movements", table: "inventory_movements", latestColumn: "created_at", trustedForBrain: true },
  ];

  const values = await Promise.all(definitions.map((definition) => productionSource(context, definition)));
  values.unshift({
    source_key: "production-profiles",
    label: "Production team profiles",
    status: profiles.length ? "connected" : "no_records",
    record_count: profiles.length,
    last_record_at: latestProfileUpdate(profiles),
    is_live: true,
    is_historical: false,
    trusted_for_brain: profiles.length > 0,
    note: profiles.length ? null : "No active or inactive profiles were visible.",
  });
  return values;
}

async function githubBranchHead(): Promise<{ sha: string | null; date: string | null; status: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(GITHUB_BRANCH_URL, {
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "atlas-system-health/0.1",
        "x-github-api-version": "2022-11-28",
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { sha: null, date: null, status: `unavailable_${response.status}` };
    return {
      sha: typeof payload?.sha === "string" ? payload.sha : null,
      date: typeof payload?.commit?.committer?.date === "string" ? payload.commit.committer.date : null,
      status: "connected",
    };
  } catch {
    return { sha: null, date: null, status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

function safeClientUrl(url: URL): { hostname: string | null; fullUrl: string | null } {
  const hostname = (url.searchParams.get("client_host") || "").trim().toLowerCase();
  const clientUrl = (url.searchParams.get("client_url") || "").trim();
  const hostAllowed = hostname === "localhost"
    || hostname.endsWith(".netlify.app")
    || hostname.endsWith(".vabar.is")
    || hostname === "vabar.is";

  let fullUrl: string | null = null;
  if (clientUrl) {
    try {
      const parsed = new URL(clientUrl);
      if (hostAllowed && parsed.hostname.toLowerCase() === hostname) fullUrl = parsed.origin;
    } catch {
      fullUrl = null;
    }
  }
  return { hostname: hostAllowed ? hostname : null, fullUrl };
}

function branchCredentials() {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !serviceRoleKey) throw new ApiError(500, "The private System service is unavailable.");
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
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String(parsed.message)
      : typeof parsed === "string" && parsed
      ? parsed
      : "The private System snapshot failed.";
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireManagerProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";
    if (request.method !== "GET") throw new ApiError(405, "Checkpoint I System is view-only.");
    if (action !== "snapshot") throw new ApiError(404, "Unknown System action.");

    const profiles = await productionProfiles(context);
    const [sources, github] = await Promise.all([
      productionSources(context, profiles),
      githubBranchHead(),
    ]);
    const client = safeClientUrl(url);
    const branchUrl = Deno.env.get("SUPABASE_URL") || "";
    const projectRef = (() => {
      try { return new URL(branchUrl).hostname.split(".")[0] || null; }
      catch { return null; }
    })();

    const runtime = {
      auth_verified: true,
      system_gateway: true,
      function_version: FUNCTION_VERSION,
      project_ref: projectRef,
      runtime_region: Deno.env.get("SB_REGION") || null,
      deployment_id: Deno.env.get("DENO_DEPLOYMENT_ID") || null,
      client_hostname: client.hostname,
      client_url: client.fullUrl,
      github_commit_sha: github.sha,
      github_commit_date: github.date,
      github_status: github.status,
    };

    const workspace = await branchRpc("atlas_system_snapshot", {
      p_profiles: profiles,
      p_production_sources: sources,
      p_runtime: runtime,
      p_actor_id: context.user.id,
      p_actor_role: context.profile.role,
    });

    return jsonResponse({
      workspace,
      staff: {
        id: context.user.id,
        label: profileLabel(context.profile),
        role: context.profile.role,
        active: true,
        can_view_system: true,
      },
      policy: {
        view_only: true,
        retries_enabled: false,
        incident_mutation_enabled: false,
        rollback_enabled: false,
        production_promotion_enabled: false,
        secrets_returned: false,
        tokens_returned: false,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("System API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The System service is temporarily unavailable." }, 500);
  }
});
