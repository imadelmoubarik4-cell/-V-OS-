import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AuthError, actorLabel, authConfig, requireRecentAuth, requireStepUp as requireActorStepUp, resolveActor } from "../_shared/auth.mjs";
import {
  completionMetadata,
  INTENDED_ROLE_KEY,
  onboardingDecision,
  pendingInvitationDecision,
  reinstatementMetadata,
  revocationMetadata,
} from "../_shared/staff-access.mjs";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

const MANAGER_ROLES = new Set(["admin", "manager"]);
const PROFILE_ROLES = new Set(["admin", "manager", "bartender", "viewer"]);
const DEPARTMENTS = new Set(["management", "bar", "kitchen", "service", "operations", "marketing", "other"]);
const EMPLOYMENT_TYPES = new Set(["owner", "full_time", "part_time", "temporary", "contractor", "other"]);
const PHONE_VISIBILITY = new Set(["team", "managers_only"]);
const MAX_BODY_BYTES = 96 * 1024;

type AtlasProfile = {
  id: string;
  email?: string | null;
  display_name?: string | null;
  role: string;
  active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

type AtlasContext = {
  token: string;
  amr: Array<{ method: string; timestamp?: number }>;
  aal: string;
  mfaEnrolled: boolean;
  appMetadata: Record<string, unknown>;
  user: { id: string; email?: string | null };
  profile: AtlasProfile;
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
      "x-atlas-team-profiles-version": "0.1.0",
    },
  });
}

function profileLabel(profile: Partial<AtlasProfile> | null | undefined): string {
  return actorLabel(profile);
}

function isManager(context: AtlasContext): boolean {
  // S99: an inactive caller (e.g. an invitee mid-onboarding, resolved with
  // allowInactive) is never treated as a manager, so self-scoped actions like
  // save-details stay self-only for them.
  return context.profile.active === true && MANAGER_ROLES.has(context.profile.role);
}

function staffPayload(context: AtlasContext) {
  return {
    id: context.user.id,
    label: profileLabel(context.profile),
    role: context.profile.role,
    active: true,
    can_manage_team: isManager(context),
    can_edit_self: true,
    live_training_writes_enabled: true,
    live_profile_writes_enabled: true,
    account_invitations_enabled: true,
  };
}

// The production Auth/REST project and its publishable key come only from the
// function environment (_shared/auth.mjs authConfig); unconfigured fails closed.
function productionAuthUrl(): string {
  return authConfig(Deno.env).projectUrl;
}

function productionPublishableKey(): string {
  return authConfig(Deno.env).publishableKey;
}

async function requireActiveProfile(request: Request, options: { allowInactive?: boolean } = {}): Promise<AtlasContext> {
  // S99: onboarding actions (save-details, complete-onboarding) resolve with
  // allowInactive so an invitee whose profile is still inactive can save their
  // own details before activation. isManager() returns false for such a caller,
  // so those actions remain strictly self-scoped.
  const actor = await resolveActor(request, Deno.env, fetch, {
    inactiveMessage: "This Atlas profile is inactive. Team access has been removed.",
    profileColumns: ["created_at", "updated_at"],
    allowInactive: options.allowInactive === true,
  });
  return { token: actor.token, amr: actor.amr ?? [], aal: actor.aal ?? "aal1", mfaEnrolled: actor.mfaEnrolled === true, appMetadata: (actor.appMetadata ?? {}) as Record<string, unknown>, user: { id: actor.userId }, profile: actor.profile as AtlasProfile };
}

// S96 step-up: role/active changes and account creation/invitations need a
// recent sign-in or second-factor check (ATLAS_REQUIRE_STEP_UP=true, window
// ATLAS_STEP_UP_MAX_AGE_SECONDS, default 900). Enable once the app's
// "confirm it's you" step is live.
function requireStepUp(context: AtlasContext): void {
  requireActorStepUp({ amr: context.amr, aal: context.aal, mfaEnrolled: context.mfaEnrolled, role: context.profile?.role });
}

// Permanent deletion is irreversible, so it is gated harder than ordinary
// step-up: the caller must have an ENROLLED verified second factor, an aal2
// session, AND a RECENT second-factor check (a fresh password never counts).
// This holds regardless of ATLAS_REQUIRE_STEP_UP — that flag can relax other
// actions, but never this one.
function requireFreshMfaForDeletion(context: AtlasContext): void {
  if (context.mfaEnrolled !== true) {
    const error = new ApiError(403, "Set up an authenticator app on your own account before you can permanently delete a team member.");
    (error as { code?: string }).code = "mfa_enrollment_required";
    throw error;
  }
  if (context.aal !== "aal2") {
    const error = new ApiError(403, "Confirm it is you with your authenticator code before permanently deleting a team member.");
    (error as { code?: string }).code = "mfa_required";
    throw error;
  }
  const configured = Number(Deno.env.get("ATLAS_STEP_UP_MAX_AGE_SECONDS") || 900);
  const maxAge = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 3600) : 900;
  // requireMfa:true → only a recent second-factor method satisfies this; a fresh
  // password-only reauthentication is rejected. Throws AuthError (401,
  // mfa_reauthentication_required) which the handler relays.
  requireRecentAuth({ amr: context.amr, aal: context.aal, mfaEnrolled: context.mfaEnrolled }, maxAge, Date.now(), { requireMfa: true });
}

function requireManager(context: AtlasContext): void {
  if (!isManager(context)) {
    throw new ApiError(403, "This action is limited to managers and administrators.");
  }
}

// S114 staff access lifecycle (_shared/staff-access.mjs). The profile's access
// history (ever active, removed, role changed, inviter, invitation age); null
// when it cannot be read, which the guards treat as "refuse" (fail closed).
async function profileAccessState(profileId: string): Promise<Record<string, unknown> | null> {
  try {
    const state = await branchRpc("atlas_team_profile_access_state", { p_profile_id: profileId });
    return state && typeof state === "object" ? state : null;
  } catch (error) {
    console.warn("Profile access state could not be read", error instanceof Error ? error.message : "unknown");
    return null;
  }
}

function accessRefusal(decision: { status: number; code: string; message: string }): ApiError {
  const error = new ApiError(decision.status, decision.message);
  (error as { code?: string }).code = decision.code;
  return error;
}

// An inactive caller may use the self-service setup steps (their own details)
// only while they are a genuine, never-active invitation — never a removed or
// deactivated member.
async function requirePendingInvitationIfInactive(context: AtlasContext): Promise<void> {
  if (context.profile.active === true) return;
  const decision = pendingInvitationDecision({
    profile: context.profile,
    appMetadata: context.appMetadata,
    accessState: await profileAccessState(context.user.id),
  });
  if (!decision.ok) throw accessRefusal(decision);
}

// Auth app_metadata markers (atlas_access_revoked_at and friends). Returns
// whether the marker was written. A revocation marker that cannot be written
// is logged, not fatal, so removing access never waits on Auth: the
// deactivation itself is recorded in the append-only audit in the same
// transaction, and atlas_team_profile_access_state (the primary guard) reads
// it. The pending invitation's role is the exception (updateProfileAccess).
async function updateAccessMarkers(profileId: string, appMetadata: Record<string, unknown>): Promise<boolean> {
  const project = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key || project !== productionAuthUrl()) {
    console.warn("Access markers not written: no service access to the Auth project");
    return false;
  }
  try {
    const admin = createClient(project!, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await admin.auth.admin.updateUserById(profileId, { app_metadata: appMetadata });
    if (error) {
      console.warn("Access markers could not be written", error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("Access markers could not be written", error instanceof Error ? error.message : "unknown");
    return false;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireUuid(value: unknown, label: string): string {
  if (!isUuid(value)) throw new ApiError(400, `${label} is invalid.`);
  return value;
}

function optionalUuid(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requireUuid(value, label);
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, "A text field is invalid.");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new ApiError(400, `Text is limited to ${maxLength} characters.`);
  return normalized;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const normalized = optionalText(value, maxLength);
  if (!normalized) throw new ApiError(400, `${label} is required.`);
  return normalized;
}

function requiredEmail(value: unknown): string {
  const email = requiredText(value, "Email", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "Enter a valid email address.");
  }
  return email;
}

function optionalEnum(value: unknown, label: string, allowed: Set<string>): string | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.has(normalized)) throw new ApiError(400, `${label} is invalid.`);
  return normalized;
}

function requiredEnum(value: unknown, label: string, allowed: Set<string>): string {
  const normalized = optionalEnum(value, label, allowed);
  if (!normalized) throw new ApiError(400, `${label} is required.`);
  return normalized;
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new ApiError(400, `${label} is invalid.`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ApiError(400, `${label} must be true or false.`);
  return value;
}

function integerInRange(value: unknown, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, `${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "Request body is too large.");
  }
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

// S96: database text reaches the browser only when it is an Atlas-authored
// message raised by our SQL, without schema detail (same rule as
// atlas-shifts / atlas-team-messages); anything else becomes the fixed
// fallback and only the SQLSTATE is logged.
const AUTHORED_SQLSTATES = new Set(["P0001", "42501", "22023", "P0002", "55000", "23514"]);
const SCHEMA_DETAIL = /(relation|column|constraint|function\s|schema|syntax|violates|duplicate key|permission denied|operator|does not exist|null value|sqlstate|pg_|atlas_private\.|public\.)/i;

function safeDbMessage(parsed: unknown, fallback: string): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  const body = parsed as { code?: unknown; message?: unknown };
  const code = String(body.code ?? "");
  const message = String(body.message ?? "").trim();
  if (!message || message.length > 300 || !AUTHORED_SQLSTATES.has(code) || SCHEMA_DETAIL.test(message)) return fallback;
  return message;
}

async function branchRpc(name: string, payload: Record<string, unknown> = {}): Promise<any> {
  const branchUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "The private Team Profiles service is unavailable.");
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
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const message = safeDbMessage(parsed, "The private Team Profiles request failed.");
    if (message === "The private Team Profiles request failed.") console.warn("Team Profiles RPC failed", name, response.status, parsed && typeof parsed === "object" ? String(parsed.code ?? "-") : "-");
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

async function productionJson(
  context: AtlasContext,
  url: URL,
  init: RequestInit = {},
): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: productionPublishableKey(),
      authorization: `Bearer ${context.token}`,
      accept: "application/json",
      "cache-control": "no-store",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    // Production PostgREST text is never shown; the status is enough.
    console.warn("Team Profiles production request failed", response.status, parsed && typeof parsed === "object" ? String(parsed.code ?? "-") : "-");
    throw new ApiError(response.status === 401 ? 401 : response.status === 403 ? 403 : 400, "Connected Atlas staff data could not be updated.");
  }
  return parsed;
}

async function profiles(context: AtlasContext): Promise<AtlasProfile[]> {
  const url = new URL(`${productionAuthUrl()}/rest/v1/profiles`);
  url.searchParams.set("select", "id,email,display_name,role,active,created_at,updated_at");
  url.searchParams.set("order", "active.desc,display_name.asc.nullslast,email.asc");
  url.searchParams.set("limit", "500");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows as AtlasProfile[] : [];
}

async function onboardingTasks(context: AtlasContext): Promise<any[]> {
  const url = new URL(`${productionAuthUrl()}/rest/v1/onboarding_tasks`);
  url.searchParams.set("select", "id,title,description,category,sort_order,required,active");
  url.searchParams.set("active", "eq.true");
  url.searchParams.set("order", "sort_order.asc,title.asc");
  url.searchParams.set("limit", "200");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows : [];
}

async function onboardingProgress(context: AtlasContext): Promise<any[]> {
  const url = new URL(`${productionAuthUrl()}/rest/v1/onboarding_progress`);
  url.searchParams.set("select", "id,task_id,user_id,completed_at,completed_by,note");
  if (!isManager(context)) url.searchParams.set("user_id", `eq.${context.user.id}`);
  url.searchParams.set("limit", "5000");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows : [];
}

async function profileById(context: AtlasContext, profileId: string): Promise<AtlasProfile | null> {
  const url = new URL(`${productionAuthUrl()}/rest/v1/profiles`);
  url.searchParams.set("select", "id,email,display_name,role,active,created_at,updated_at");
  url.searchParams.set("id", `eq.${profileId}`);
  url.searchParams.set("limit", "1");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) && rows[0] ? rows[0] as AtlasProfile : null;
}

async function snapshot(context: AtlasContext) {
  const [profileRows, taskRows, progressRows] = await Promise.all([
    profiles(context),
    onboardingTasks(context),
    onboardingProgress(context),
  ]);

  const workspace = await branchRpc("atlas_team_profiles_snapshot", {
    p_profiles: profileRows,
    p_tasks: taskRows,
    p_progress: progressRows,
    p_actor_id: context.user.id,
    p_actor_role: context.profile.role,
  });

  // Admins get the count of orphaned deleted-member photos so Team can surface a
  // one-click cleanup banner. Best-effort: never let it break the snapshot.
  const staff = staffPayload(context);
  if (context.profile.role === "admin") {
    const orphans = await branchRpc("atlas_team_member_list_photo_orphans").catch(() => []);
    (staff as { photo_orphan_count?: number }).photo_orphan_count = Array.isArray(orphans) ? orphans.length : 0;
  }

  return {
    workspace,
    staff,
    policy: {
      inactive_profile_access: "denied_on_every_request",
      emergency_contacts: "self_or_manager",
      role_and_active_controls: "manager_or_admin_except_self",
      self_role_change: false,
      self_deactivation: false,
      account_invitations_enabled: true,
      direct_browser_table_access: false,
    },
  };
}

async function logExternalEvent(
  context: AtlasContext,
  eventType: string,
  profileId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await branchRpc("atlas_team_profile_log_external_event", {
    p_event_type: eventType,
    p_profile_id: profileId,
    p_actor_id: context.user.id,
    p_actor_label: profileLabel(context.profile),
    p_actor_role: context.profile.role,
    p_payload: payload,
  });
}

async function updateProfileAccess(context: AtlasContext, body: Record<string, unknown>) {
  requireManager(context);
  requireStepUp(context);
  const profileId = requireUuid(body.profile_id, "Team profile");
  if (profileId === context.user.id) {
    throw new ApiError(400, "You cannot change your own role or active status from Team Profiles.");
  }

  const desiredRole = requiredEnum(body.role, "Role", PROFILE_ROLES);
  const desiredActive = requiredBoolean(body.active, "Active status");
  const target = await profileById(context, profileId);
  if (!target) throw new ApiError(404, "The selected Atlas profile no longer exists.");

  if (context.profile.role === "manager" && (target.role === "admin" || desiredRole === "admin")) {
    throw new ApiError(403, "Only an administrator can assign or modify the administrator role.");
  }

  if ((target.role === "admin" || target.role === "manager")
      && (desiredRole === "bartender" || desiredRole === "viewer" || !desiredActive)) {
    const allProfiles = await profiles(context);
    const otherActiveManagers = allProfiles.filter((profile) =>
      profile.id !== profileId
      && profile.active
      && (profile.role === "admin" || profile.role === "manager")
    );
    if (otherActiveManagers.length === 0) {
      throw new ApiError(409, "Atlas must retain at least one active manager or administrator.");
    }
  }

  // S114: the role chosen for a still-pending (inactive) invitation is the
  // role it will get, even when the profile row already shows that role (a
  // pending profile shows "viewer" until setup finishes). Recorded before the
  // change, and the change is refused if it cannot be recorded.
  if (target.active !== true && !desiredActive
      && !(await updateAccessMarkers(profileId, { [INTENDED_ROLE_KEY]: desiredRole }))) {
    throw new ApiError(503, "The invitation’s role could not be saved. Try again in a moment.");
  }

  const url = new URL(`${productionAuthUrl()}/rest/v1/profiles`);
  url.searchParams.set("id", `eq.${profileId}`);
  url.searchParams.set("select", "id,email,display_name,role,active,created_at,updated_at");
  const rows = await productionJson(context, url, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ role: desiredRole, active: desiredActive }),
  });
  const updated = Array.isArray(rows) ? rows[0] : null;
  if (!updated) throw new ApiError(409, "The profile access update was not applied.");

  // S114: removing access marks the account so self-service setup can never
  // restore it; a manager restoring access clears that mark.
  if (target.active === true && !desiredActive) {
    await updateAccessMarkers(profileId, revocationMetadata());
  } else if (target.active !== true && desiredActive) {
    await updateAccessMarkers(profileId, reinstatementMetadata());
  }

  if (target.role !== desiredRole) {
    await logExternalEvent(context, "role_changed", profileId, {
      previous_role: target.role,
      role: desiredRole,
    });
  }
  if (target.active !== desiredActive) {
    await logExternalEvent(context, "active_status_changed", profileId, {
      previous_active: target.active,
      active: desiredActive,
      access_effect: desiredActive ? "access_restored" : "access_removed_on_next_request",
    });
  }
  return updated;
}

async function updateOnboarding(context: AtlasContext, body: Record<string, unknown>) {
  requireManager(context);
  const profileId = requireUuid(body.profile_id, "Team profile");
  const taskId = requireUuid(body.task_id, "Onboarding task");
  const completed = requiredBoolean(body.completed, "Completed status");
  const note = optionalText(body.note, 2000);

  const [target, tasks] = await Promise.all([
    profileById(context, profileId),
    onboardingTasks(context),
  ]);
  if (!target) throw new ApiError(404, "The selected Atlas profile no longer exists.");
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new ApiError(404, "The selected onboarding task is no longer active.");

  let result: unknown;
  if (completed) {
    const url = new URL(`${productionAuthUrl()}/rest/v1/onboarding_progress`);
    url.searchParams.set("on_conflict", "task_id,user_id");
    result = await productionJson(context, url, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        task_id: taskId,
        user_id: profileId,
        completed_at: new Date().toISOString(),
        completed_by: context.user.id,
        note,
      }),
    });
  } else {
    const url = new URL(`${productionAuthUrl()}/rest/v1/onboarding_progress`);
    url.searchParams.set("task_id", `eq.${taskId}`);
    url.searchParams.set("user_id", `eq.${profileId}`);
    result = await productionJson(context, url, {
      method: "DELETE",
      headers: { Prefer: "return=representation" },
    });
  }

  await logExternalEvent(context, "onboarding_status_changed", profileId, {
    task_id: taskId,
    task_title: task.title,
    completed,
    note,
  });

  return result;
}

// s90-invite-helpers:start (pure; unit-tested by tests/node/workflow-integrity-s90.test.js)
// The invite link lands on invitation.html (the set-password step) on the
// configured app origin: ATLAS_APP_ORIGIN, else the first
// ATLAS_INTEGRATIONS_APP_ORIGINS entry, else the production site. Only a bare
// https origin is accepted (no credentials, path, query or fragment); Supabase
// Auth still requires the URL on the project's Redirect URLs allow-list.
const DEFAULT_APP_ORIGIN = "https://os-vabar.netlify.app";
function invitationRedirect(...configured: unknown[]): string {
  for (const value of configured) {
    const raw = typeof value === "string" ? value.split(",")[0].trim() : "";
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && raw.replace(/\/$/, "") === url.origin) {
        return `${url.origin}/invitation.html`;
      }
    } catch {
      // Not a URL: fall through to the next configured value.
    }
  }
  return `${DEFAULT_APP_ORIGIN}/invitation.html`;
}
// handle_new_user reads raw_user_meta_data->>'full_name' for the profile name;
// display_name is kept for readers of the older key.
function invitationMetadata(displayName: string | null): Record<string, string> {
  return displayName ? { full_name: displayName, display_name: displayName } : {};
}
// s90-invite-helpers:end

// S99: the manager/admin picks the invitee's role at invite time. A manager may
// invite bartender|viewer|manager; only an administrator may invite an admin.
// The chosen role is stored on the auth user's app_metadata (atlas_intended_role)
// — never on the profile yet — and applied only when the invitee finishes setup
// (complete-onboarding). The account stays inactive until then.
const INVITE_ASSIGNABLE_ROLES = new Set(["manager", "bartender", "viewer", "admin"]);
function resolveInviteRole(context: AtlasContext, value: unknown): string {
  const role = requiredEnum(value, "Role", INVITE_ASSIGNABLE_ROLES);
  if (role === "admin" && context.profile.role !== "admin") {
    throw new ApiError(403, "Only an administrator can invite an administrator.");
  }
  return role;
}

async function inviteAccount(context: AtlasContext, body: Record<string, unknown>) {
  requireManager(context);
  requireStepUp(context);
  const email = requiredText(body.email, "Email", 320).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "Enter a valid email address.");
  const displayName = optionalText(body.display_name, 120);
  const intendedRole = resolveInviteRole(context, body.role ?? "viewer");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw new ApiError(500, "Account invitations are temporarily unavailable.");

  const inviteUrl = new URL(`${productionAuthUrl()}/auth/v1/invite`);
  inviteUrl.searchParams.set("redirect_to", invitationRedirect(Deno.env.get("ATLAS_APP_ORIGIN"), Deno.env.get("ATLAS_INTEGRATIONS_APP_ORIGINS")));
  const response = await fetch(inviteUrl, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      email,
      data: invitationMetadata(displayName),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof result?.msg === "string"
      ? result.msg
      : typeof result?.message === "string"
      ? result.message
      : "Invitation could not be sent.";
    throw new ApiError(response.status === 422 ? 409 : response.status >= 500 ? 503 : 400, detail);
  }
  // Record the intended role and who invited them; the account is NOT activated.
  const invitedId = typeof result?.id === "string" ? result.id
    : typeof result?.user?.id === "string" ? result.user.id : null;
  if (invitedId) {
    const admin = createClient(productionAuthUrl(), serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: markerError } = await admin.auth.admin.updateUserById(invitedId, {
      app_metadata: { atlas_intended_role: intendedRole, atlas_invited_by: context.user.id },
    });
    if (markerError) console.warn("Invite metadata could not be stored", markerError.message);
    await logExternalEvent(context, "active_status_changed", invitedId, {
      previous_active: false, active: false, role: intendedRole, reason: "account_invited",
    }).catch(() => undefined);
  }
  return { invited: true, email, role: intendedRole };
}

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Used only after requireActiveProfile has verified the live account and role.
async function createLoginMember(context: AtlasContext, body: Record<string, unknown>) {
  requireManager(context);
  requireStepUp(context);
  const name = requiredText(body.display_name, "Name", 120);
  const email = requiredText(body.email, "Email", 320).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "Enter a valid email address.");
  const job = requiredText(body.default_role, "Staff role", 120);
  const role = requiredEnum(body.login_role, "Atlas access", new Set(["bartender", "viewer"]));
  const project = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key || project !== productionAuthUrl()) throw new ApiError(503, "Account setup requires the same Atlas authentication project.");
  const admin = createClient(project!, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: existing, error: lookupError } = await admin.from("profiles").select("id").ilike("email", email.replace(/[%_]/g, "\\$&"));
  if (lookupError) throw new ApiError(503, "Could not check existing accounts.");
  if (existing?.length) throw new ApiError(409, "This email already has an Atlas account. Select that member; do not add a duplicate. Use password recovery if they cannot sign in.");
  const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email, options: { data: { full_name: name } } });
  if (error || !data?.user?.id || !data.properties?.hashed_token) throw new ApiError(400, "Account setup could not be created. Check the email or try again.");
  const id = data.user.id;
  const { error: markerError } = await admin.auth.admin.updateUserById(id, { app_metadata: { atlas_invited_by: context.user.id } });
  if (markerError) throw new ApiError(503, "Account created but invitation tracking failed. Ask an administrator to review it.");
  // Auth's trigger creates a disabled viewer. Only the verified manager activates it.
  const { error: profileError } = await admin.from("profiles").update({ display_name: name, role, active: true }).eq("id", id);
  if (profileError) throw new ApiError(503, "Account created but access is not configured. Ask an administrator to review this member before retrying.");
  await branchRpc("atlas_team_profile_upsert_details", {
    p_profile_id: id, p_preferred_name: name, p_job_title: job,
    p_department: null, p_employment_type: null, p_start_date: null,
    p_phone: null, p_phone_visibility: "managers_only", p_preferred_language: null, p_manager_notes: null,
    p_actor_id: context.user.id, p_actor_label: profileLabel(context.profile), p_actor_role: context.profile.role,
  });
  await branchRpc("atlas_shifts_sync_profiles", {
    p_profiles: [{ id, email, display_name: name, role, active: true }],
    p_actor_id: context.user.id, p_actor_label: profileLabel(context.profile), p_actor_role: context.profile.role,
  });
  await logExternalEvent(context, "active_status_changed", id, { previous_active: false, active: true, role, reason: "owner_created_login_member" });
  return { id, email, login_role: role, invitation_token: data.properties.hashed_token, invitation_type: "invite", email_sent: false };
}

async function renewMemberSetup(context: AtlasContext, body: Record<string, unknown>) {
  requireManager(context);
  requireStepUp(context);
  const id = requireUuid(body.profile_id, "Team member");
  const project = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key || project !== productionAuthUrl()) throw new ApiError(503, "Account setup is unavailable.");
  const admin = createClient(project!, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.getUserById(id);
  if (error || !data.user?.app_metadata?.atlas_invited_by || data.user.email_confirmed_at) {
    throw new ApiError(409, "This member has already accepted their invitation or was not created here. They should use Forgot your password on the sign-in page.");
  }
  const profile = await profileById(context, id);
  if (!profile?.active) throw new ApiError(409, "This member is inactive. Review their access before issuing an invitation.");
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "invite", email: data.user.email! });
  if (linkError || !link.properties?.hashed_token) throw new ApiError(400, "Could not renew the setup link.");
  return { id, email: data.user.email, invitation_token: link.properties.hashed_token, email_sent: false };
}

// S105 Team member off-boarding. Two actions, both server-authorized and audited:
//   remove-from-team  — manager+: revoke access (deactivate → s96 session kill) and
//                       archive the roster entry, preserving every record. Reversible.
//   delete-member     — ADMIN only + recent step-up (+ aal2 via resolveActor): a REAL
//                       permanent deletion — deletes the Supabase Auth user, purges
//                       eligible personal data, and hard-deletes or anonymizes the
//                       roster row so historical shifts survive (never silently lost).
// Guards: never your own account, never the last active manager/administrator; a
// typed name-confirmation is re-checked server-side; failures are reported truthfully.

// Shared guard: refuse an action that would remove the last active manager/admin.
async function ensureNotLastActiveManager(context: AtlasContext, profileId: string): Promise<void> {
  const all = await profiles(context);
  const others = all.filter((p) => p.id !== profileId && p.active && (p.role === "admin" || p.role === "manager"));
  if (others.length === 0) throw new ApiError(409, "Alcedo must keep at least one active manager or administrator. Assign another before removing this one.");
}

// Stricter guard for an administrator target: Alcedo must keep at least one OTHER
// active administrator — managers do not count, because admin-only capabilities
// (including this deletion) would otherwise be left with no one to perform them.
async function ensureNotLastActiveAdmin(context: AtlasContext, profileId: string): Promise<void> {
  const all = await profiles(context);
  const otherActiveAdmins = all.filter((p) => p.id !== profileId && p.active && p.role === "admin");
  if (otherActiveAdmins.length === 0) throw new ApiError(409, "Alcedo must keep at least one active administrator. Make someone else an administrator before removing this one.");
}

function normalizeName(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

async function removeFromTeam(context: AtlasContext, body: Record<string, unknown>) {
  requireManager(context);
  requireStepUp(context);
  const profileId = optionalUuid(body.profile_id, "Team profile");
  const personId = optionalUuid(body.person_id, "Roster person");
  if (!profileId && !personId) throw new ApiError(400, "Select a team member to remove.");

  if (profileId) {
    if (profileId === context.user.id) throw new ApiError(400, "You cannot remove your own account.");
    const target = await profileById(context, profileId);
    if (!target) throw new ApiError(404, "The selected team member no longer exists.");
    if (context.profile.role === "manager" && target.role === "admin") throw new ApiError(403, "Only an administrator can remove an administrator.");
    if (target.active) {
      if (target.role === "admin") await ensureNotLastActiveAdmin(context, profileId);
      else if (target.role === "manager") await ensureNotLastActiveManager(context, profileId);
    }
    // Always deactivate (idempotent; also covers a profile activated since it
    // was read) and confirm it: the removal is recorded only once the profile
    // is known to be inactive. The database lets only administrators change
    // another profile's access, so a manager's update matches no row; then the
    // profile is read again and an active one is refused, truthfully.
    const url = new URL(`${productionAuthUrl()}/rest/v1/profiles`);
    url.searchParams.set("id", `eq.${profileId}`);
    url.searchParams.set("select", "id,active");
    const rows = await productionJson(context, url, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ active: false }) });
    const row = Array.isArray(rows) ? rows[0] : null;
    const inactive = row ? row.id === profileId && row.active === false : (await profileById(context, profileId))?.active === false;
    if (!inactive) {
      throw new ApiError(403, "Only an administrator can remove this member’s access. Ask an administrator to remove them.");
    }
    if (target.active) {
      await logExternalEvent(context, "active_status_changed", profileId, { previous_active: true, active: false, role: target.role, reason: "removed_from_team" });
    }
    // S114: removed — including a pending invitation — can never be finished or
    // restored through self-service account setup.
    await updateAccessMarkers(profileId, revocationMetadata());
  }

  const result = await branchRpc("atlas_team_member_remove_from_team", {
    p_profile_id: profileId, p_person_id: personId,
    p_actor_id: context.user.id, p_actor_label: profileLabel(context.profile), p_actor_role: context.profile.role,
  });
  return { removed: true, ...result };
}

// Read-only: what a permanent delete would remove vs keep, so the confirmation
// modal can tell the truth before anything is touched. Manager+ (same gate as
// viewing the Access section); the destructive step itself is admin-only.
async function deletePreview(context: AtlasContext, body: Record<string, unknown>) {
  requireManager(context);
  const profileId = optionalUuid(body.profile_id, "Team profile");
  const personId = optionalUuid(body.person_id, "Roster person");
  if (!profileId && !personId) throw new ApiError(400, "Select a team member.");
  let label = "";
  if (profileId) {
    const target = await profileById(context, profileId);
    if (!target) throw new ApiError(404, "The selected team member no longer exists.");
    label = target.display_name || "";
  }
  const preview = await branchRpc("atlas_team_member_deletion_preview", { p_profile_id: profileId, p_person_id: personId });
  return {
    account_kind: profileId ? "login" : "schedule_only",
    display_name: preview?.display_name || label || "",
    shift_entry_count: Number(preview?.shift_entry_count ?? 0),
    has_shift_history: preview?.has_shift_history === true,
    // 'anonymized_kept_shifts' keeps the shift history on a de-identified row;
    // 'full_delete' removes the person entirely (no shifts to preserve).
    hard_delete_mode: preview?.hard_delete_mode === "anonymized_kept_shifts" ? "anonymized_kept_shifts" : "full_delete",
    can_delete: context.profile.role === "admin" && profileId !== context.user.id,
  };
}

async function deleteMember(context: AtlasContext, body: Record<string, unknown>) {
  if (context.profile.role !== "admin") throw new ApiError(403, "Only an administrator can permanently delete a team member.");
  // Admin + enrolled verified factor + RECENT MFA, server-side, always.
  requireFreshMfaForDeletion(context);

  const profileId = optionalUuid(body.profile_id, "Team profile");
  const personId = optionalUuid(body.person_id, "Roster person");
  // Exactly one identifier — never both, never neither — so the target can't be
  // ambiguous and a login member can't be smuggled in through the roster route.
  if (Boolean(profileId) === Boolean(personId)) {
    throw new ApiError(400, "Select exactly one team member to delete.");
  }
  const confirmName = requiredText(body.confirm_name, "Confirmation name", 160);

  // Resolve the target + name-match + eligibility/guards BEFORE anything is removed.
  let targetLabel = "";
  // Values an administrator may type to confirm. An unaccepted invitation often
  // has no display name yet, so the invite email is also accepted — it is only
  // compared here and never stored as a label (see edge-auth-contract).
  const confirmChoices: string[] = [];
  if (profileId) {
    if (profileId === context.user.id) throw new ApiError(400, "You cannot delete your own account.");
    const target = await profileById(context, profileId);
    if (!target) throw new ApiError(404, "The selected team member no longer exists.");
    targetLabel = target.display_name || "";
    confirmChoices.push(targetLabel);
    if (target.email) confirmChoices.push(String(target.email));
    if (target.active) {
      if (target.role === "admin") await ensureNotLastActiveAdmin(context, profileId);
      else if (target.role === "manager") await ensureNotLastActiveManager(context, profileId);
    }
  } else {
    const preview = await branchRpc("atlas_team_member_deletion_preview", { p_profile_id: null, p_person_id: personId });
    if (!preview?.found) throw new ApiError(404, "The selected team member no longer exists.");
    // The schedule-only route must never reach a login-linked employee — those
    // are deleted through their profile so the account + auth user are handled.
    if (preview.person_profile_id || preview.login_enabled === true) {
      throw new ApiError(409, "This person has an Alcedo login. Open their profile to delete them, not the schedule.");
    }
    targetLabel = preview.display_name || "";
    confirmChoices.push(targetLabel);
  }
  const accepted = confirmChoices.filter(Boolean).map((v) => normalizeName(v));
  if (!accepted.length || !accepted.includes(normalizeName(confirmName))) {
    throw new ApiError(400, "The typed name doesn’t match. Type the member’s name exactly to confirm permanent deletion.");
  }

  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const projectUrl = Deno.env.get("SUPABASE_URL");
  if (!key || projectUrl !== productionAuthUrl()) throw new ApiError(503, "Permanent deletion is unavailable right now.");
  const admin = createClient(projectUrl!, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1. Revoke access first (login member) — FAIL CLOSED. We confirm the correct
  //    profile is now inactive before any personal data is purged. If revocation
  //    fails or can't be confirmed, we stop here: nothing is deleted and the
  //    login is never left active.
  if (profileId) {
    const patch = new URL(`${productionAuthUrl()}/rest/v1/profiles`);
    patch.searchParams.set("id", `eq.${profileId}`);
    patch.searchParams.set("select", "id,active");
    let revoked: any;
    try {
      revoked = await productionJson(context, patch, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ active: false }) });
    } catch (_error) {
      throw new ApiError(502, "The member’s access could not be revoked, so nothing was deleted. Please try again.");
    }
    const row = Array.isArray(revoked) ? revoked[0] : revoked;
    if (!row || row.id !== profileId || row.active !== false) {
      throw new ApiError(502, "The member’s access could not be confirmed as revoked, so nothing was deleted. Please try again.");
    }
    await logExternalEvent(context, "active_status_changed", profileId, { previous_active: true, active: false, reason: "permanently_deleted" }).catch(() => undefined);
    // S114: if a later step fails, the account still cannot be restored through
    // self-service setup.
    await updateAccessMarkers(profileId, revocationMetadata());
  }

  // 2. Purge branch-side personal data + roster (hard-delete or anonymize, keeps
  //    shifts). The RPC refuses an unknown target and a login-linked schedule-only
  //    row, so a silent no-op can never reach here as a false success.
  const purge = await branchRpc("atlas_team_member_purge_branch", {
    p_profile_id: profileId, p_person_id: personId,
    p_actor_id: context.user.id, p_actor_label: profileLabel(context.profile), p_actor_role: context.profile.role,
  });
  if (!purge?.ok) throw new ApiError(502, "The member’s records could not be removed. Please try again.");

  // 3. Remove the profile photo object. The purge already recorded it (atomically,
  //    in the transaction that dropped its DB row), so the path can't be lost. We
  //    mark that record resolved ONLY after Storage confirms deletion; on failure
  //    it stays pending for the in-app cleanup banner. We never claim full erasure
  //    while the object may still exist.
  let photoRemoved = false;
  let orphanPhotoPath: string | null = null;
  let cleanupRecordPending = false;
  if (purge?.photo_storage_path) {
    const path = String(purge.photo_storage_path);
    const { error } = await admin.storage.from("atlas-profile-photos").remove([path]);
    photoRemoved = !error;
    if (error) {
      orphanPhotoPath = path; // stays recorded + pending; the admin finishes it in Alcedo
    } else {
      try {
        const resolved = await branchRpc("atlas_team_member_resolve_photo_orphan", {
          p_storage_path: path, p_actor_id: context.user.id, p_actor_label: profileLabel(context.profile),
        });
        if (resolved?.ok !== true) cleanupRecordPending = true;
      } catch (_error) {
        // The object IS gone, but the cleanup record couldn't be marked resolved.
        // Report it truthfully; the banner will show it and a retry (a no-op
        // Storage delete) will resolve it. The record is never lost.
        cleanupRecordPending = true;
      }
    }
  }

  // 4. Delete the Supabase Auth user (login member) — cascades the profile row,
  //    sessions and MFA factors. Report truthfully if it fails (access is already
  //    revoked and personal data already purged; the step is safe to retry).
  let authDeleted = false;
  if (profileId) {
    const { error } = await admin.auth.admin.deleteUser(profileId);
    authDeleted = !error;
    if (error) {
      return { ok: false, partial: true, mode: purge?.mode, auth_deleted: false, photo_removed: photoRemoved,
        storage_cleanup_required: Boolean(orphanPhotoPath), storage_path: orphanPhotoPath,
        shifts_retained: purge?.shift_entry_count ?? 0,
        message: "Access was revoked and personal data was removed, but deleting the sign-in account failed. It is safe to retry; no historical records were lost." };
    }
  }

  // A failed photo removal is still a truthful PARTIAL — we never report complete
  // erasure while an object may remain in storage.
  if (orphanPhotoPath) {
    return { ok: false, partial: true, deleted: true, account_kind: profileId ? "login" : "schedule_only",
      mode: purge?.mode, auth_deleted: authDeleted, photo_removed: false,
      storage_cleanup_required: true, storage_path: orphanPhotoPath,
      shifts_retained: purge?.shift_entry_count ?? 0,
      message: "The member was deleted, but their stored profile photo could not be removed. The reference was kept so it can be retried; no historical records were lost." };
  }

  return { ok: true, deleted: true, account_kind: profileId ? "login" : "schedule_only",
    mode: purge?.mode, auth_deleted: authDeleted, photo_removed: photoRemoved,
    // The object is gone but its cleanup record couldn't be marked resolved; the
    // banner still shows it and a retry clears it. Surfaced, not hidden.
    ...(cleanupRecordPending ? { cleanup_record_pending: true } : {}),
    shifts_retained: purge?.shift_entry_count ?? 0 };
}

// Administrator self-service cleanup for profile-photo objects orphaned when a
// permanent delete removed the DB row but the Storage removal failed. Lists the
// recorded orphans, removes each object, and marks the removed ones resolved.
// Admin-only + step-up; nothing here can touch a live member's data.
async function cleanupPhotoOrphans(context: AtlasContext) {
  if (context.profile.role !== "admin") throw new ApiError(403, "Only an administrator can finish removing deleted members’ files.");
  requireStepUp(context);
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const projectUrl = Deno.env.get("SUPABASE_URL");
  if (!key || projectUrl !== productionAuthUrl()) throw new ApiError(503, "Cleanup is unavailable right now.");
  const admin = createClient(projectUrl!, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const orphans = await branchRpc("atlas_team_member_list_photo_orphans");
  const paths: string[] = Array.isArray(orphans) ? orphans.map((o: { storage_path?: unknown }) => String(o?.storage_path || "")).filter(Boolean) : [];
  let removed = 0;
  let remaining = 0;
  for (const path of paths) {
    const { error } = await admin.storage.from("atlas-profile-photos").remove([path]);
    if (error) { remaining += 1; continue; } // object still there — stays listed
    // Mark resolved ONLY now that Storage confirmed deletion. If the bookkeeping
    // fails, it is NOT resolved — count it as remaining (truthful), never lose it.
    try {
      const resolved = await branchRpc("atlas_team_member_resolve_photo_orphan", {
        p_storage_path: path, p_actor_id: context.user.id, p_actor_label: profileLabel(context.profile),
      });
      if (resolved?.ok === true) removed += 1; else remaining += 1;
    } catch (_error) {
      remaining += 1;
    }
  }
  return { ok: remaining === 0, attempted: paths.length, removed, remaining };
}

// S99 self-service onboarding completion. Any authenticated invitee finishing
// their OWN setup: the role comes only from the invite metadata (the caller can
// never choose it), and activation happens only after the account has a verified
// authenticator (aal2 + a verified factor) and a saved name, phone and photo —
// all re-verified here, never trusted from the client. This is the invite-flow
// gate only; it is independent of the database-wide MFA enforcement flag.
// S114: it may ACTIVATE only an invitation that has never been active (the
// security audit and the Auth markers say so; _shared/staff-access.mjs), never
// a removed, deactivated or demoted member, and it never changes the role or
// access of an account that is already active.
async function completeOnboarding(context: AtlasContext) {
  const project = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key || project !== productionAuthUrl()) throw new ApiError(503, "Account setup is unavailable.");
  if (context.aal !== "aal2") {
    const error = new ApiError(403, "Set up your authenticator app before finishing your account.");
    (error as { code?: string }).code = "mfa_required";
    throw error;
  }
  const admin = createClient(project!, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await admin.auth.admin.getUserById(context.user.id);
  if (userError || !userData?.user) throw new ApiError(400, "Your account could not be verified. Try again.");
  const user = userData.user;

  // Eligibility first, from Auth's current app_metadata (read with the service
  // key, not from the caller's token) and the profile's audited history.
  const decision = onboardingDecision({
    profile: context.profile,
    appMetadata: user.app_metadata,
    accessState: context.profile.active === true ? null : await profileAccessState(context.user.id),
  });
  if (!decision.ok) throw accessRefusal(decision);

  const factors = Array.isArray((user as { factors?: Array<{ status?: string }> }).factors) ? (user as { factors: Array<{ status?: string }> }).factors : [];
  if (!factors.some((factor) => factor?.status === "verified")) {
    const error = new ApiError(403, "Set up your authenticator app before finishing your account.");
    (error as { code?: string }).code = "mfa_required";
    throw error;
  }
  const rawName = typeof user.user_metadata?.full_name === "string"
    ? user.user_metadata.full_name
    : typeof user.user_metadata?.display_name === "string" ? user.user_metadata.display_name : "";
  const displayName = String(rawName).replace(/\s+/g, " ").trim();
  if (!displayName || displayName.length < 2 || displayName.includes("@")) throw new ApiError(400, "Add your name before finishing your account.");
  const readiness = await branchRpc("atlas_team_profile_onboarding_ready", { p_profile_id: context.user.id });
  if (!readiness?.has_phone) throw new ApiError(400, "Add a phone number before finishing your account.");
  if (!readiness?.has_photo) throw new ApiError(400, "Add a profile photo before finishing your account.");

  const role = decision.role;
  if (decision.mode === "activate") {
    // Conditional on the profile still being inactive: two concurrent requests
    // cannot both activate, and a profile a manager changed meanwhile is untouched.
    const { data: updated, error: profileError } = await admin.from("profiles")
      .update({ display_name: displayName, role, active: true })
      .eq("id", context.user.id)
      .eq("active", false)
      .select("id,email,display_name,role,active")
      .maybeSingle();
    if (profileError) throw new ApiError(503, "Your account could not be finished. Ask your manager to review it.");
    if (!updated) throw new ApiError(409, "This account is already set up. Sign in to Alcedo instead.");
    await branchRpc("atlas_shifts_sync_profiles", {
      p_profiles: [{ id: context.user.id, email: user.email, display_name: displayName, role, active: true }],
      p_actor_id: context.user.id, p_actor_label: displayName, p_actor_role: role,
    }).catch((error) => console.warn("Shift sync after onboarding failed", error instanceof Error ? error.message : error));
  } else {
    // Already active (created by a manager): record the name only; the role and
    // access stay exactly what a manager set.
    const { data: updated, error: profileError } = await admin.from("profiles")
      .update({ display_name: displayName })
      .eq("id", context.user.id)
      .eq("active", true)
      .select("id")
      .maybeSingle();
    if (profileError || !updated) throw new ApiError(503, "Your account could not be finished. Ask your manager to review it.");
  }
  // Setup is done: it can never run again for this account.
  await updateAccessMarkers(context.user.id, completionMetadata());
  await logExternalEvent(context, "active_status_changed", context.user.id, decision.mode === "activate"
    ? { previous_active: false, active: true, role, reason: "onboarding_completed" }
    : { previous_active: true, active: true, role, reason: "onboarding_completed_active_account" }).catch(() => undefined);
  return { completed: true, role };
}

// S99 lost-phone recovery. A manager/admin removes a member's authenticator so
// they can enrol a new one at next sign-in. A manager may reset
// bartender|viewer|manager but not an admin (only an admin may reset an admin),
// and the last active admin can never be stripped of their factor.
async function resetMemberMfa(context: AtlasContext, body: Record<string, unknown>) {
  requireManager(context);
  requireStepUp(context);
  const id = requireUuid(body.profile_id, "Team member");
  if (id === context.user.id) throw new ApiError(400, "Reset your own authenticator from Settings, not here.");
  const project = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key || project !== productionAuthUrl()) throw new ApiError(503, "Two-factor reset is unavailable.");
  const target = await profileById(context, id);
  if (!target) throw new ApiError(404, "The selected Atlas profile no longer exists.");
  if (context.profile.role === "manager" && target.role === "admin") {
    throw new ApiError(403, "Only an administrator can reset an administrator’s two-factor.");
  }
  if (target.role === "admin" && target.active) {
    const all = await profiles(context);
    const otherActiveAdmins = all.filter((profile) => profile.id !== id && profile.active && profile.role === "admin");
    if (otherActiveAdmins.length === 0) throw new ApiError(409, "Atlas must keep at least one administrator with two-factor set up.");
  }
  const admin = createClient(project!, key, { auth: { persistSession: false, autoRefreshToken: false } });
  let factors: Array<{ id?: string }> = [];
  try {
    const { data } = await admin.auth.admin.mfa.listFactors({ userId: id });
    factors = Array.isArray(data?.factors) ? data.factors : [];
  } catch (error) {
    console.warn("Could not list factors for reset", error instanceof Error ? error.message : error);
    throw new ApiError(503, "The member’s two-factor could not be read. Try again.");
  }
  let removed = 0;
  for (const factor of factors) {
    if (!factor?.id) continue;
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: id });
    if (!error) removed += 1;
  }
  await logExternalEvent(context, "active_status_changed", id, { reason: "mfa_reset", factors_removed: removed });
  return { reset: true, factors_removed: removed };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";
    // S99: onboarding self-service actions accept an inactive (mid-onboarding)
    // caller; every other action still requires an active staff profile.
    const allowInactive = request.method === "POST" && (action === "save-details" || action === "complete-onboarding");
    const context = await requireActiveProfile(request, { allowInactive });

    if (request.method === "GET") {
      if (action !== "snapshot") throw new ApiError(404, "Unknown Team Profiles action.");
      return jsonResponse(await snapshot(context));
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);
    const actor = profileLabel(context.profile);
    let result: unknown;

    switch (action) {
      case "renew-member-setup":
        result = await renewMemberSetup(context, body);
        break;
      case "create-login-member":
        result = await createLoginMember(context, body);
        break;
      case "save-details": {
        const profileId = requireUuid(body.profile_id, "Team profile");
        if (!isManager(context) && profileId !== context.user.id) {
          throw new ApiError(403, "Staff may edit only their own contact details.");
        }
        // S114: an inactive caller only while a genuine pending invitation.
        await requirePendingInvitationIfInactive(context);
        result = await branchRpc("atlas_team_profile_upsert_details", {
          p_profile_id: profileId,
          p_preferred_name: optionalText(body.preferred_name, 120),
          p_job_title: optionalText(body.job_title, 160),
          p_department: optionalEnum(body.department, "Department", DEPARTMENTS),
          p_employment_type: optionalEnum(body.employment_type, "Employment type", EMPLOYMENT_TYPES),
          p_start_date: optionalDate(body.start_date, "Start date"),
          p_phone: optionalText(body.phone, 40),
          p_phone_visibility: requiredEnum(body.phone_visibility ?? "managers_only", "Phone visibility", PHONE_VISIBILITY),
          p_preferred_language: optionalText(body.preferred_language, 80),
          p_manager_notes: optionalText(body.manager_notes, 5000),
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "save-emergency-contact": {
        const profileId = requireUuid(body.profile_id, "Team profile");
        if (!isManager(context) && profileId !== context.user.id) {
          throw new ApiError(403, "Staff may edit only their own emergency contacts.");
        }
        result = await branchRpc("atlas_team_profile_save_emergency_contact", {
          p_contact_id: optionalUuid(body.contact_id, "Emergency contact"),
          p_profile_id: profileId,
          p_contact_name: requiredText(body.contact_name, "Emergency contact name", 160),
          p_relationship: optionalText(body.relationship, 120),
          p_phone: requiredText(body.phone, "Emergency contact phone", 40),
          p_note: optionalText(body.note, 2000),
          p_priority: integerInRange(body.priority ?? 1, "Priority", 1, 5),
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "remove-emergency-contact": {
        const profileId = requireUuid(body.profile_id, "Team profile");
        if (!isManager(context) && profileId !== context.user.id) {
          throw new ApiError(403, "Staff may edit only their own emergency contacts.");
        }
        result = await branchRpc("atlas_team_profile_remove_emergency_contact", {
          p_contact_id: requireUuid(body.contact_id, "Emergency contact"),
          p_profile_id: profileId,
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "update-access":
        result = await updateProfileAccess(context, body);
        break;

      case "update-onboarding":
        result = await updateOnboarding(context, body);
        break;

      case "invite-account":
        result = await inviteAccount(context, body);
        break;

      case "complete-onboarding":
        // Self-scoped and possibly inactive-until-now: return without the
        // manager snapshot (which the invitee has no rights to read).
        return jsonResponse({ result: await completeOnboarding(context) });

      case "reset-member-mfa":
        result = await resetMemberMfa(context, body);
        break;

      case "delete-preview":
        result = await deletePreview(context, body);
        break;

      case "remove-from-team":
        result = await removeFromTeam(context, body);
        break;

      case "delete-member":
        result = await deleteMember(context, body);
        break;

      case "cleanup-photo-orphans":
        result = await cleanupPhotoOrphans(context);
        break;

      default:
        throw new ApiError(404, "Unknown Team Profiles action.");
    }

    const refreshed = await snapshot(context);
    return jsonResponse({ result, ...refreshed });
  } catch (error) {
    if (error instanceof ApiError || error instanceof AuthError) {
      const code = (error as { code?: unknown }).code;
      return jsonResponse({ error: error.message, ...(typeof code === "string" ? { code } : {}) }, error.status);
    }
    console.error("Team Profiles API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Team Profiles service is temporarily unavailable." }, 500);
  }
});
