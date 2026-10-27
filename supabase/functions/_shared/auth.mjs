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

// S96 MFA policy for privileged roles (admin, manager), kept as a deployment
// override: ATLAS_REQUIRE_PRIVILEGED_MFA=true makes aal2 mandatory for every
// privileged caller, whatever the database policy says.
function privilegedMfaMandatory(env) {
  return String(envValue(env, "ATLAS_REQUIRE_PRIVILEGED_MFA") ?? "").trim().toLowerCase() === "true";
}

// S114 staff MFA at the edge, the same rule as the database's
// private.staff_session_ok() / privileged_session_ok() (S96, S99). Service-role
// RPCs called from gateways skip those database checks, so the gateway applies
// them here for every active staff member:
//   * anyone with a verified second factor must present an aal2 session;
//   * private.auth_policy.require_all_staff_mfa: aal2 for every staff member;
//   * private.auth_policy.require_privileged_mfa: aal2 for admin and manager.
// The flags are read through the existing atlas_auth_policy RPC with the
// caller's own token, only when a password-only session would otherwise pass,
// and cached briefly per isolate. An unreachable, missing (404) or malformed
// policy fails closed (503) and is not cached.
const AUTH_POLICY_TTL_MS = 30_000;
let authPolicyCache = null;

export function resetAuthPolicyCache() {
  authPolicyCache = null;
}

async function readAuthPolicy(projectUrl, headers, fetchImpl, signalInit, nowMs) {
  if (authPolicyCache && nowMs - authPolicyCache.at < AUTH_POLICY_TTL_MS) return authPolicyCache.value;
  let response;
  try {
    response = await fetchImpl(`${projectUrl}/rest/v1/rpc/atlas_auth_policy`, {
      ...signalInit(),
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    throw new AuthError(503, "Atlas authentication is temporarily unavailable.");
  }
  // Every failure refuses (fails closed), including a missing policy function:
  // S99 is a prerequisite of this code (the S114 pre-flight checks it).
  if (response?.status === 401) throw new AuthError(401, "Your Atlas session has expired.");
  if (!response?.ok) throw new AuthError(503, "Atlas authentication is temporarily unavailable.");
  const body = await readJson(response);
  if (!body || typeof body !== "object" || Array.isArray(body)
      || typeof body.require_all_staff_mfa !== "boolean" || typeof body.require_privileged_mfa !== "boolean") {
    throw new AuthError(503, "Atlas authentication is temporarily unavailable.");
  }
  const value = { allStaff: body.require_all_staff_mfa, privileged: body.require_privileged_mfa };
  authPolicyCache = { at: nowMs, value };
  return value;
}

function mfaRequired(message) {
  const error = new AuthError(403, message);
  error.code = "mfa_required";
  return error;
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
  // S114: every active staff role. An inactive caller (allowInactive: an
  // invitee mid-setup, before their authenticator exists) is not staff yet;
  // the setup actions apply their own checks (_shared/staff-access.mjs).
  if (active && aal !== "aal2") {
    if (mfaEnrolled) {
      throw mfaRequired("Confirm your sign-in with your authenticator app to continue.");
    }
    const privileged = MANAGER_ROLES.includes(profile.role);
    if (privileged && privilegedMfaMandatory(env)) {
      throw mfaRequired("Confirm your sign-in with your authenticator app to use manager tools.");
    }
    const policy = await readAuthPolicy(projectUrl, headers, fetchImpl, () => {
      const init = requestInit();
      return init.signal ? { signal: init.signal } : {};
    }, Date.now());
    if (policy.allStaff || (privileged && policy.privileged)) {
      throw mfaRequired("Set up two-factor sign-in with an authenticator app to continue using Alcedo.");
    }
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
    // Auth's own app_metadata for this user (server-controlled; users cannot
    // write it). The account-setup guards read their markers from it.
    appMetadata: user.app_metadata && typeof user.app_metadata === "object" && !Array.isArray(user.app_metadata)
      ? user.app_metadata
      : {},
    profile: { ...profile, active },
  };
}

// S96 step-up for high-risk actions (role/active changes, invitations,
// integration disconnects, accounting exports): the most recent sign-in or
// second-factor check must be at most `maxAgeSeconds` old. Throws 401 with
// code "reauthentication_required" so the app can ask the person to confirm
// (TOTP challenge, or password) and retry.
export const MFA_METHODS = Object.freeze(["totp", "mfa/totp", "phone", "mfa/phone", "webauthn", "mfa/webauthn"]);
const REAUTH_METHODS = Object.freeze(["password", "otp", ...MFA_METHODS]);

// S96 step-up. Someone with a verified second factor (or an aal2 session, or when
// options.requireMfa is set) must have completed a second-factor check recently:
// a fresh password alone does not count for them. Everyone else needs a fresh
// sign-in. Email-link methods (recovery, invite, magiclink) never count: they
// prove mailbox access, not the person at the keyboard.
export function requireRecentAuth(actor, maxAgeSeconds = 900, nowMs = Date.now(), options = {}) {
  const needsMfa = options.requireMfa === true || actor?.mfaEnrolled === true || actor?.aal === "aal2";
  const accepted = needsMfa ? MFA_METHODS : REAUTH_METHODS;
  const stamps = (Array.isArray(actor?.amr) ? actor.amr : [])
    .filter((entry) => entry && accepted.includes(entry.method))
    .map((entry) => Number(entry.timestamp))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= nowMs / 1000 + 60);
  const latest = stamps.length ? Math.max(...stamps) : 0;
  if (!latest || nowMs / 1000 - latest > maxAgeSeconds) {
    const error = new AuthError(401, needsMfa
      ? "Confirm it is you with your authenticator code to continue with this action."
      : "Confirm it is you to continue with this action.");
    error.code = needsMfa ? "mfa_reauthentication_required" : "reauthentication_required";
    throw error;
  }
  return actor;
}

// Step-up for a high-impact action, configured per deployment:
// ATLAS_REQUIRE_STEP_UP=true turns it on; ATLAS_STEP_UP_MAX_AGE_SECONDS sets the
// window (default 900). ATLAS_REQUIRE_PRIVILEGED_MFA=true also demands a recent
// second factor from every manager/admin, enrolled or not.
export function requireStepUp(actor, env = globalThis.Deno?.env, nowMs = Date.now()) {
  if (String(envValue(env, "ATLAS_REQUIRE_STEP_UP") ?? "").trim().toLowerCase() !== "true") return actor;
  const configured = Number(envValue(env, "ATLAS_STEP_UP_MAX_AGE_SECONDS") || 900);
  const maxAge = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 3600) : 900;
  const privileged = MANAGER_ROLES.includes(actor?.role ?? actor?.profile?.role);
  return requireRecentAuth(actor, maxAge, nowMs, { requireMfa: privileged && privilegedMfaMandatory(env) });
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
