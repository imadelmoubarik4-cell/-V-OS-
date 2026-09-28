// Shared Atlas caller authentication for Edge Functions.
//
// Every Atlas gateway authenticates through this module (no function calls
// /auth/v1/user itself; tests/node/edge-auth-contract.test.js): the caller's JWT is checked against
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

// Staff identity (S87, binding): a person is shown by their profile display
// name, otherwise by a neutral label. An email address is never a label — not
// in responses, not in stored actor/decided-by labels, not in model prompts.
export const SAFE_ACTOR_LABEL = "Team member";

// A display name that is safe to show: trimmed, bounded, and never an address.
export function safeDisplayName(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.includes("@")) return null;
  return text.slice(0, 120);
}

// The one canonical label for a staff member, from a profile row
// ({ display_name }) or a resolved actor ({ displayName }).
export function actorLabel(profile, fallback = SAFE_ACTOR_LABEL) {
  const name = safeDisplayName(profile?.display_name) ?? safeDisplayName(profile?.displayName);
  if (name) return name;
  return safeDisplayName(fallback) ?? SAFE_ACTOR_LABEL;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const PROFILE_COLUMNS = ["id", "email", "display_name", "role", "active"];

// S96: claims of a token that Auth has just accepted (/auth/v1/user verified
// its signature, expiry and session). Never call this on an unverified token.
export function verifiedTokenClaims(token) {
  try {
    const part = String(token).split(".")[1] ?? "";
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const text = typeof atob === "function"
      ? atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))
      : "";
    const claims = JSON.parse(text);
    return claims && typeof claims === "object" ? claims : {};
  } catch {
    return {};
  }
}

function hasVerifiedFactor(user) {
  return Array.isArray(user?.factors) && user.factors.some((factor) => factor?.status === "verified");
}

// S96 MFA policy for privileged roles (admin, manager). A privileged caller
// who has a verified second factor must present an aal2 session. With
// ATLAS_REQUIRE_PRIVILEGED_MFA=true every privileged caller must be aal2
// (switch it on only after every administrator and manager has enrolled and
// the app's TOTP challenge step is live). Staff roles are unaffected.
function privilegedMfaMandatory(env) {
  return String(envValue(env, "ATLAS_REQUIRE_PRIVILEGED_MFA") ?? "").trim().toLowerCase() === "true";
}

// Resolves the calling user to an Atlas actor:
// { userId, email, role, active, displayName, label, token, profile }.
// `profile` is the caller's own profile row (plus any `profileColumns` asked
// for); `label` is actorLabel(profile) and never an email address.
// Throws AuthError 401 for a missing or expired session, 403 for a missing,
// inactive or unknown-role profile, 500 when unconfigured and 503 when Auth is
// unreachable. Options:
//   allowInactive: true   return an inactive actor (active: false) instead of a 403
//   inactiveMessage       the 403 text for an inactive profile
//   profileColumns        extra profile columns to read (e.g. ["updated_at"])
//   timeoutMs             abort each Auth/profile lookup after this many ms
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
  // Optional per-request deadline; a timed-out lookup reads as 503.
  const timeoutMs = Number(options.timeoutMs);
  const requestInit = () => (Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal?.timeout === "function"
    ? { headers, signal: AbortSignal.timeout(timeoutMs) }
    : { headers });

  let userResponse;
  try {
    userResponse = await fetchImpl(`${projectUrl}/auth/v1/user`, requestInit());
  } catch {
    throw new AuthError(503, "Atlas authentication is temporarily unavailable.");
  }
  if (userResponse?.status === 429 || Number(userResponse?.status) >= 500) {
    // Auth is busy or down: not a verdict on the session.
    throw new AuthError(503, "Atlas authentication is temporarily unavailable.");
  }
  if (!userResponse?.ok) throw new AuthError(401, "Your Atlas session has expired.");
  const user = await readJson(userResponse);
  const userId = typeof user?.id === "string" ? user.id : "";
  if (!userId) throw new AuthError(401, "Your Atlas account could not be verified.");

  const profileUrl = new URL(`${projectUrl}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${userId}`);
  const extra = Array.isArray(options.profileColumns) ? options.profileColumns : [];
  for (const column of extra) {
    if (typeof column !== "string" || !/^[a-z_]{1,63}$/.test(column)) {
      throw new AuthError(500, "Atlas authentication is not configured.");
    }
  }
  profileUrl.searchParams.set("select", [...new Set([...PROFILE_COLUMNS, ...extra])].join(","));
  profileUrl.searchParams.set("limit", "1");

  let profileResponse;
  try {
    profileResponse = await fetchImpl(profileUrl.toString(), requestInit());
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
    throw new AuthError(403, typeof options.inactiveMessage === "string" && options.inactiveMessage
      ? options.inactiveMessage
      : "This Atlas profile is inactive. Atlas access has been removed.");
  }

  const claims = verifiedTokenClaims(token);
  const aal = claims.aal === "aal2" ? "aal2" : "aal1";
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((entry) => entry && typeof entry.method === "string") : [];
  const mfaEnrolled = hasVerifiedFactor(user);
  if (MANAGER_ROLES.includes(profile.role) && active && aal !== "aal2"
      && (mfaEnrolled || privilegedMfaMandatory(env))) {
    const error = new AuthError(403, "Confirm your sign-in with your authenticator app to use manager tools.");
    error.code = "mfa_required";
    throw error;
  }

  const displayName = safeDisplayName(profile.display_name);
  const email = typeof profile.email === "string" && profile.email.trim()
    ? profile.email.trim()
    : typeof user.email === "string" && user.email.trim() ? user.email.trim() : null;
  return {
    userId,
    email,
    role: profile.role,
    active,
    displayName,
    label: actorLabel(profile),
    token,
    aal,
    amr,
    mfaEnrolled,
    sessionId: typeof claims.session_id === "string" ? claims.session_id : null,
    profile: { ...profile, active },
  };
}

// S96 step-up for high-risk actions (role/active changes, invitations,
// integration disconnects, accounting exports): the most recent sign-in or
// second-factor check must be at most `maxAgeSeconds` old. Throws 401 with
// code "reauthentication_required" so the app can ask the person to confirm
// (TOTP challenge, or password) and retry.
export function requireRecentAuth(actor, maxAgeSeconds = 900, nowMs = Date.now()) {
  const stamps = (Array.isArray(actor?.amr) ? actor.amr : [])
    .filter((entry) => ["password", "totp", "otp", "recovery", "invite"].includes(entry.method))
    .map((entry) => Number(entry.timestamp))
    .filter((value) => Number.isFinite(value) && value > 0);
  const latest = stamps.length ? Math.max(...stamps) : 0;
  if (!latest || nowMs / 1000 - latest > maxAgeSeconds) {
    const error = new AuthError(401, "Confirm it is you to continue with this action.");
    error.code = "reauthentication_required";
    throw error;
  }
  return actor;
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
