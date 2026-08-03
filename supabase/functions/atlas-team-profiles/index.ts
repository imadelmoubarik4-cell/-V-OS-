import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";

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

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  return match[1];
}

function profileLabel(profile: Partial<AtlasProfile> | null | undefined): string {
  return profile?.display_name?.trim()
    || profile?.email?.trim()
    || "Atlas team member";
}

function isManager(context: AtlasContext): boolean {
  return MANAGER_ROLES.has(context.profile.role);
}

function staffPayload(context: AtlasContext) {
  return {
    id: context.user.id,
    label: profileLabel(context.profile),
    role: context.profile.role,
    active: true,
    can_manage_team: isManager(context),
    can_edit_self: true,
  };
}

async function requireActiveProfile(request: Request): Promise<AtlasContext> {
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
  profileUrl.searchParams.set("select", "id,email,display_name,role,active,created_at,updated_at");
  profileUrl.searchParams.set("limit", "1");

  const profileResponse = await fetch(profileUrl, { headers });
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas staff profile could not be verified.");

  const profiles = await profileResponse.json() as AtlasProfile[];
  const profile = profiles[0];
  if (!profile?.active) {
    throw new ApiError(403, "This Atlas profile is inactive. Team access has been removed.");
  }
  if (!PROFILE_ROLES.has(profile.role)) {
    throw new ApiError(403, "This Atlas profile cannot access Team Profiles.");
  }

  return {
    token,
    user: { id: user.id, email: user.email },
    profile,
  };
}

function requireManager(context: AtlasContext): void {
  if (!isManager(context)) {
    throw new ApiError(403, "This action is limited to managers and administrators.");
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
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String(parsed.message)
      : typeof parsed === "string" && parsed
      ? parsed
      : "The private Team Profiles request failed.";
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
      apikey: AUTH_PUBLISHABLE_KEY,
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
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String(parsed.message)
      : typeof parsed === "string" && parsed
      ? parsed
      : "Connected Atlas staff data could not be updated.";
    throw new ApiError(response.status === 401 ? 401 : response.status === 403 ? 403 : 400, message);
  }
  return parsed;
}

async function profiles(context: AtlasContext): Promise<AtlasProfile[]> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  url.searchParams.set("select", "id,email,display_name,role,active,created_at,updated_at");
  url.searchParams.set("order", "active.desc,display_name.asc.nullslast,email.asc");
  url.searchParams.set("limit", "500");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows as AtlasProfile[] : [];
}

async function onboardingTasks(context: AtlasContext): Promise<any[]> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/onboarding_tasks`);
  url.searchParams.set("select", "id,title,description,category,sort_order,required,active");
  url.searchParams.set("active", "eq.true");
  url.searchParams.set("order", "sort_order.asc,title.asc");
  url.searchParams.set("limit", "200");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows : [];
}

async function onboardingProgress(context: AtlasContext): Promise<any[]> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/onboarding_progress`);
  url.searchParams.set("select", "id,task_id,user_id,completed_at,completed_by,note");
  if (!isManager(context)) url.searchParams.set("user_id", `eq.${context.user.id}`);
  url.searchParams.set("limit", "5000");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows : [];
}

async function profileById(context: AtlasContext, profileId: string): Promise<AtlasProfile | null> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
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

  return {
    workspace,
    staff: staffPayload(context),
    policy: {
      inactive_profile_access: "denied_on_every_request",
      emergency_contacts: "self_or_manager",
      role_and_active_controls: "manager_or_admin_except_self",
      self_role_change: false,
      self_deactivation: false,
      account_invitations_enabled: false,
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

  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  url.searchParams.set("id", `eq.${profileId}`);
  url.searchParams.set("select", "id,email,display_name,role,active,created_at,updated_at");
  const rows = await productionJson(context, url, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ role: desiredRole, active: desiredActive }),
  });
  const updated = Array.isArray(rows) ? rows[0] : null;
  if (!updated) throw new ApiError(409, "The profile access update was not applied.");

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
    const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/onboarding_progress`);
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
    const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/onboarding_progress`);
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

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireActiveProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";

    if (request.method === "GET") {
      if (action !== "snapshot") throw new ApiError(404, "Unknown Team Profiles action.");
      return jsonResponse(await snapshot(context));
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);
    const actor = profileLabel(context.profile);
    let result: unknown;

    switch (action) {
      case "save-details": {
        const profileId = requireUuid(body.profile_id, "Team profile");
        if (!isManager(context) && profileId !== context.user.id) {
          throw new ApiError(403, "Staff may edit only their own contact details.");
        }
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

      default:
        throw new ApiError(404, "Unknown Team Profiles action.");
    }

    const refreshed = await snapshot(context);
    return jsonResponse({ result, ...refreshed });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Team Profiles API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Team Profiles service is temporarily unavailable." }, 500);
  }
});
