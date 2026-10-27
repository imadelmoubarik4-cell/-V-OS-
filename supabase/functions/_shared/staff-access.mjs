// S114 staff access lifecycle: who may use the self-service account-setup
// actions (complete-onboarding, and save-details / photo upload while the
// profile is still inactive).
//
// The rule: account setup may ACTIVATE only a fresh invitation that has never
// been active and never been removed, from an inviter who is still active and
// still allowed to grant that role — never a removed, deactivated or demoted
// member — and it never changes the role or access of an account that is
// already active. Evidence, strongest first:
//   1. accessState from atlas_team_profile_access_state (S114 migration): the
//      append-only security audit (S96) shows whether the profile was ever
//      active, whether its role was changed and whether its whole history is
//      recorded ("audited"); the append-only removal audit (S105) shows whether
//      Team removed it; the inviter's current status and role; the
//      invitation's age (Auth invited_at).
//   2. Auth app_metadata markers this module defines: atlas_access_revoked_at
//      (set on every removal path), atlas_onboarding_completed_at (set when
//      setup finishes), and the invitation's atlas_invited_by.
// Anything missing or unknown fails closed.
//
// Plain ESM with no Deno APIs, unit-tested in Node.

export const INVITED_BY_KEY = "atlas_invited_by";
export const INTENDED_ROLE_KEY = "atlas_intended_role";
export const ONBOARDING_COMPLETED_KEY = "atlas_onboarding_completed_at";
export const ACCESS_REVOKED_KEY = "atlas_access_revoked_at";

// A pending invitation older than this needs a manager instead.
export const INVITATION_MAX_AGE_DAYS = 14;

const STAFF_ROLES = Object.freeze(["admin", "manager", "bartender", "viewer"]);
const RANK = Object.freeze({ viewer: 1, bartender: 2, manager: 3, admin: 4 });

const REFUSALS = Object.freeze({
  access_revoked: [403, "This account’s Alcedo access was removed. Ask a manager if you need access again."],
  already_onboarded: [409, "This account is already set up. Sign in to Alcedo instead."],
  not_invited: [403, "This account was not invited to Alcedo. Ask a manager to invite you."],
  invitation_needs_review: [409, "This invitation can’t be finished automatically. Ask a manager to review your access."],
  invitation_expired: [409, "This invitation has expired. Ask a manager to review your access."],
  setup_conflict: [409, "Your access was changed while you were finishing setup. Try again."],
});

/**
 * @typedef {{ ok: true, mode: "activate" | "finish_active", role: string }} AccessAllowed
 * @typedef {{ ok: false, status: number, code: string, message: string }} AccessRefused
 * @typedef {AccessAllowed | AccessRefused} AccessDecision
 */

/** @returns {AccessRefused} */
function refuse(code) {
  const [status, message] = REFUSALS[code];
  return { ok: false, status, code, message };
}

function metadataOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function present(value) {
  return value !== undefined && value !== null && value !== "" && value !== false;
}

// The decision for an account-setup request.
//   profile      the caller's own profile row ({ role, active }), from resolveActor
//   appMetadata  the caller's Auth app_metadata, as Auth returned it
//   accessState  { audited, ever_active, removed, role_changed, inviter_active,
//                inviter_role, invitation_age_days } from
//                atlas_team_profile_access_state, or null when it could not be
//                read (fails closed)
// Returns { ok: true, mode: "activate", role } for a never-active invitation
// (activate it with the invited role), { ok: true, mode: "finish_active",
// role } for an already-active account (finish setup, change nothing about its
// access), or { ok: false, status, code, message }.
/**
 * @param {{ profile?: any, appMetadata?: any, accessState?: any }} [input]
 * @returns {AccessDecision}
 */
export function onboardingDecision({ profile, appMetadata, accessState } = {}) {
  const meta = metadataOf(appMetadata);
  if (present(meta[ACCESS_REVOKED_KEY])) return refuse("access_revoked");
  if (present(meta[ONBOARDING_COMPLETED_KEY])) return refuse("already_onboarded");
  if (!present(meta[INVITED_BY_KEY])) return refuse("not_invited");
  if (!profile || typeof profile !== "object" || !STAFF_ROLES.includes(profile.role)) return refuse("not_invited");

  if (profile.active === true) {
    // Already active (a login member a manager created): setup may record the
    // person's name and mark itself done, but the role stays what a manager set.
    return { ok: true, mode: "finish_active", role: profile.role };
  }

  // Inactive: only an invitation whose full history is known, which has never
  // been active and never been removed may be activated. A removed member is
  // inactive too.
  const state = metadataOf(accessState);
  if (state.ever_active === true || state.removed === true) return refuse("access_revoked");
  if (state.audited !== true || state.ever_active !== false || state.removed !== false) return refuse("invitation_needs_review");
  if (state.role_changed !== true && state.role_changed !== false) return refuse("invitation_needs_review");
  // A role someone set on the pending profile after the invitation wins over
  // the invited role (a manager's later choice, e.g. a downgrade).
  const intended = meta[INTENDED_ROLE_KEY];
  const role = state.role_changed === true
    ? profile.role
    : STAFF_ROLES.includes(intended) ? intended : "viewer";
  const age = state.invitation_age_days;
  if (typeof age !== "number" || !Number.isFinite(age) || age < 0 || age > INVITATION_MAX_AGE_DAYS) {
    return refuse("invitation_expired");
  }
  // The person who invited them must still be active and still allowed to
  // grant this role today: an invitation planted before its inviter was
  // removed or demoted never activates on its own.
  const needed = role === "admin" ? RANK.admin : RANK.manager;
  if (state.inviter_active !== true || !((RANK[state.inviter_role] ?? 0) >= needed)) {
    return refuse("invitation_needs_review");
  }
  return { ok: true, mode: "activate", role };
}

// The refusal for the atomic activation's answer (the S114
// atlas_team_profile_activate_invitation reason) when it did not activate.
/** @returns {AccessRefused} */
export function activationRefusal(reason) {
  if (reason === "access_revoked") return refuse("access_revoked");
  if (reason === "already_active" || reason === "already_onboarded") return refuse("already_onboarded");
  if (reason === "role_changed") return refuse("setup_conflict");
  return refuse("invitation_needs_review");
}

// Inactive callers may use the other self-service setup steps (their own
// details, their own photo) only while they are a genuine pending invitation.
/**
 * @param {{ profile?: any, appMetadata?: any, accessState?: any }} [input]
 * @returns {AccessDecision}
 */
export function pendingInvitationDecision(input = {}) {
  const decision = onboardingDecision(input);
  if (!decision.ok) return decision;
  return decision.mode === "activate" ? decision : refuse("already_onboarded");
}

// app_metadata patches. Auth merges app_metadata keys; a null value removes a key.
export function completionMetadata(nowIso = new Date().toISOString()) {
  return { [ONBOARDING_COMPLETED_KEY]: nowIso, [INTENDED_ROLE_KEY]: null };
}

export function revocationMetadata(nowIso = new Date().toISOString()) {
  return { [ACCESS_REVOKED_KEY]: nowIso, [INTENDED_ROLE_KEY]: null };
}

// A manager restoring someone's access through Team clears the removal marker.
export function reinstatementMetadata() {
  return { [ACCESS_REVOKED_KEY]: null };
}
