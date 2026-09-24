// Shared Atlas caller authentication for Edge Functions.
//
// Same pattern every Atlas gateway uses: the caller's JWT is checked against
// `${ATLAS_AUTH_PROJECT_URL}/auth/v1/user`, then the caller's own profile row
// is read from `/rest/v1/profiles` with that JWT (RLS applies). Only an
// active profile with a known staff role is accepted. The service-role RPCs
// trust the actor id and role a gateway passes, so this is the authorization
// boundary: fail closed on anything unexpected.
//
// Plain ESM with no Deno APIs. `env` and `fetchImpl` are injected so the
// module is unit-testable in Node.

// public.staff_role, in privilege order.
export const ATLAS_ROLES = Object.freeze(["admin", "manager", "bartender", "viewer"]);
export const MANAGER_ROLES = Object.freeze(["admin", "manager"]);
export const WRITE_ROLES = Object.freeze(["admin", "manager", "bartender"]);

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function envValue(env, name) {
  if (!env) return undefined;
  if (typeof env.get === "function") return env.get(name) ?? undefined;
  return env[name] ?? undefined;
}

// The Auth project and its publishable key. No hard-coded fallbacks: a
// function without explicit configuration refuses every request.
export function authConfig(env) {
  const projectUrl = String(envValue(env, "ATLAS_AUTH_PROJECT_URL") ?? envValue(env, "SUPABASE_URL") ?? "")
    .trim().replace(/\/+$/, "");
  let publishableKey = String(envValue(env, "ATLAS_AUTH_PUBLISHABLE_KEY") ?? "").trim();
  if (!publishableKey) {
    try {
      publishableKey = String(JSON.parse(envValue(env, "SUPABASE_PUBLISHABLE_KEYS") ?? "{}")?.default ?? "").trim();
    } catch {
      publishableKey = "";
    }
  }
  if (!/^https:\/\/[^/\s]+$/.test(projectUrl) || !publishableKey) {
    throw new AuthError(500, "Atlas authentication is not configured.");
  }
  return { projectUrl, publishableKey };
}

// Bearer token from a Request (or anything with headers.get / a headers object).
export function bearerToken(request) {
  const headers = request?.headers;
  const value = typeof headers?.get === "function"
    ? headers.get("authorization")
    : headers?.authorization ?? headers?.Authorization;
  const match = String(value ?? "").match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) throw new AuthError(401, "A valid Atlas session is required.");
  return match[1];
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Resolves the calling user to an Atlas actor:
// { userId, email, role, active, displayName, label, token }.
// Throws AuthError 401 for a missing or expired session and 403 for a missing,
// inactive or unknown-role profile. Pass { allowInactive: true } to receive an
// inactive actor (active: false) instead of a 403.
export async function resolveActor(request, env, fetchImpl = globalThis.fetch, options = {}) {
  const token = bearerToken(request);
  const { projectUrl, publishableKey } = authConfig(env);
  if (typeof fetchImpl !== "function") throw new AuthError(500, "Atlas authentication is not configured.");
  const headers = {
    apikey: publishableKey,
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "cache-control": "no-store",
  };

  let userResponse;
  try {
    userResponse = await fetchImpl(`${projectUrl}/auth/v1/user`, { headers });
  } catch {
    throw new AuthError(503, "Atlas authentication is temporarily unavailable.");
  }
  if (!userResponse?.ok) throw new AuthError(401, "Your Atlas session has expired.");
  const user = await readJson(userResponse);
  const userId = typeof user?.id === "string" ? user.id : "";
  if (!userId) throw new AuthError(401, "Your Atlas account could not be verified.");

  const profileUrl = new URL(`${projectUrl}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${userId}`);
  profileUrl.searchParams.set("select", "id,email,display_name,role,active");
  profileUrl.searchParams.set("limit", "1");

  let profileResponse;
  try {
    profileResponse = await fetchImpl(profileUrl.toString(), { headers });
  } catch {
    throw new AuthError(503, "Atlas authentication is temporarily unavailable.");
  }
  if (!profileResponse?.ok) throw new AuthError(403, "Your Atlas staff profile could not be verified.");
  const profiles = await readJson(profileResponse);
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  if (!profile || typeof profile !== "object" || profile.id !== userId) {
    throw new AuthError(403, "Your Atlas staff profile could not be verified.");
  }
  if (!ATLAS_ROLES.includes(profile.role)) {
    throw new AuthError(403, "This Atlas profile cannot access Atlas.");
  }
  const active = profile.active === true;
  if (!active && options.allowInactive !== true) {
    throw new AuthError(403, "This Atlas profile is inactive. Atlas access has been removed.");
  }

  const displayName = typeof profile.display_name === "string" && profile.display_name.trim()
    ? profile.display_name.trim()
    : null;
  const email = typeof profile.email === "string" && profile.email.trim()
    ? profile.email.trim()
    : typeof user.email === "string" && user.email.trim() ? user.email.trim() : null;
  return {
    userId,
    email,
    role: profile.role,
    active,
    displayName,
    label: displayName || email || "Atlas team member",
    token,
  };
}

// Throws 403 unless the actor is active and holds one of `roles`.
export function requireRole(actor, roles, message = "This action is not available for your Atlas role.") {
  const allowed = roles instanceof Set ? roles : new Set(roles || []);
  if (!actor || actor.active !== true || !allowed.has(actor.role)) {
    throw new AuthError(403, message);
  }
  return actor;
}

export function isManager(actor) {
  return Boolean(actor && actor.active === true && MANAGER_ROLES.includes(actor.role));
}
