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

const PROFILE_ROLES = new Set(["admin", "manager", "bartender", "viewer"]);
const MANAGER_ROLES = new Set(["admin", "manager"]);
const RESPONSE_VALUES = new Set(["confirmed", "change_requested", "declined"]);
const TIME_OFF_TYPES = new Set(["unavailable", "vacation", "sick", "other"]);
const TIME_OFF_DECISIONS = new Set(["approved", "rejected", "cancelled"]);
const RESPONSE_DECISIONS = new Set(["resolved", "rejected"]);
const MAX_BODY_BYTES = 96 * 1024;

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
      "x-atlas-shifts-version": "0.1.0",
    },
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  return match[1];
}

function labelForProfile(profile: Partial<AtlasProfile> | null | undefined): string {
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
    label: labelForProfile(context.profile),
    role: context.profile.role,
    active: true,
    can_manage_schedule: isManager(context),
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
  profileUrl.searchParams.set("select", "id,email,display_name,role,active");
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, { headers });
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas staff profile could not be verified.");
  const profiles = await profileResponse.json() as AtlasProfile[];
  const profile = profiles[0];
  if (!profile?.active) {
    throw new ApiError(403, "This Atlas profile is inactive. Shift access has been removed.");
  }
  if (!PROFILE_ROLES.has(profile.role)) {
    throw new ApiError(403, "This Atlas profile cannot access Shifts.");
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

function requireBoolean(value: unknown, label: string): boolean {
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

function requireDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${label} must use YYYY-MM-DD.`);
  }
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, `${label} is invalid.`);
  return value;
}

function requireMonday(value: unknown, label = "Week start"): string {
  const dateValue = requireDate(value, label);
  const date = new Date(`${dateValue}T12:00:00Z`);
  if (date.getUTCDay() !== 1) throw new ApiError(400, `${label} must be a Monday.`);
  return dateValue;
}

function requireLocalDateTime(value: unknown, label: string): string {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
    throw new ApiError(400, `${label} must use YYYY-MM-DDTHH:MM.`);
  }
  return value.length === 16 ? `${value}:00` : value;
}

function optionalTime(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
    throw new ApiError(400, `${label} must use HH:MM.`);
  }
  return value.length === 5 ? `${value}:00` : value;
}

function requiredEnum(value: unknown, label: string, allowed: Set<string>): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!allowed.has(normalized)) throw new ApiError(400, `${label} is invalid.`);
  return normalized;
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

function branchCredentials() {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const privilegedKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !privilegedKey) {
    throw new ApiError(500, "The private Shifts service is unavailable.");
  }
  return { branchUrl, privilegedKey };
}

async function branchRpc(name: string, payload: Record<string, unknown> = {}): Promise<any> {
  const { branchUrl, privilegedKey } = branchCredentials();
  const response = await fetch(`${branchUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: privilegedKey,
      authorization: `Bearer ${privilegedKey}`,
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
      : "The private Shifts request failed.";
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

async function productionJson(context: AtlasContext, url: URL): Promise<any> {
  const response = await fetch(url, {
    headers: {
      apikey: AUTH_PUBLISHABLE_KEY,
      authorization: `Bearer ${context.token}`,
      accept: "application/json",
      "cache-control": "no-store",
    },
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String(parsed.message)
      : "Connected Atlas staff data could not be read.";
    throw new ApiError(response.status === 401 ? 401 : response.status === 403 ? 403 : 400, message);
  }
  return parsed;
}

async function productionProfiles(context: AtlasContext): Promise<AtlasProfile[]> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  url.searchParams.set("select", "id,email,display_name,role,active");
  url.searchParams.set("order", "active.desc,display_name.asc.nullslast,email.asc");
  url.searchParams.set("limit", "500");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows as AtlasProfile[] : [];
}

async function syncProfiles(context: AtlasContext): Promise<void> {
  const rows = await productionProfiles(context);
  await branchRpc("atlas_shifts_sync_profiles", {
    p_profiles: rows,
    p_actor_id: context.user.id,
    p_actor_label: labelForProfile(context.profile),
    p_actor_role: context.profile.role,
  });
}

async function snapshot(context: AtlasContext, weekStart: string) {
  await syncProfiles(context);
  const workspace = await branchRpc("atlas_shifts_snapshot", {
    p_week_start: weekStart,
    p_actor_id: context.user.id,
    p_actor_role: context.profile.role,
  });
  return {
    workspace,
    staff: staffPayload(context),
    policy: {
      planning_environment: "isolated_branch",
      production_shift_sync_enabled: false,
      publish_to_team_enabled: true,
      schedule_only_people_supported: true,
      browser_notifications_enabled: false,
      direct_browser_table_access: false,
    },
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireActiveProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";

    if (request.method === "GET") {
      if (action !== "snapshot") throw new ApiError(404, "Unknown Shifts action.");
      const weekStart = requireMonday(url.searchParams.get("week_start"), "Week start");
      return jsonResponse(await snapshot(context, weekStart));
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);
    const actorLabel = labelForProfile(context.profile);
    let result: unknown;
    let refreshWeek = body.week_start ? requireMonday(body.week_start, "Week start") : null;

    switch (action) {
      case "create-person":
        requireManager(context);
        result = await branchRpc("atlas_shifts_create_person", {
          p_display_name: requiredText(body.display_name, "Name", 160),
          p_email: optionalText(body.email, 320),
          p_default_role: optionalText(body.default_role, 120),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "update-person":
        requireManager(context);
        result = await branchRpc("atlas_shifts_update_person", {
          p_person_id: requireUuid(body.person_id, "Team member"),
          p_display_name: requiredText(body.display_name, "Name", 160),
          p_email: optionalText(body.email, 320),
          p_default_role: optionalText(body.default_role, 120),
          p_active: requireBoolean(body.active, "Active status"),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "save-shift":
        requireManager(context);
        refreshWeek = requireMonday(body.week_start, "Week start");
        result = await branchRpc("atlas_shifts_save_shift", {
          p_shift_id: optionalUuid(body.shift_id, "Shift"),
          p_week_start: refreshWeek,
          p_person_id: requireUuid(body.person_id, "Team member"),
          p_role_name: optionalText(body.role_name, 120),
          p_starts_local: requireLocalDateTime(body.starts_local, "Shift start"),
          p_ends_local: requireLocalDateTime(body.ends_local, "Shift end"),
          p_break_minutes: integerInRange(body.break_minutes ?? 0, "Break minutes", 0, 720),
          p_note: optionalText(body.note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "cancel-shift":
        requireManager(context);
        result = await branchRpc("atlas_shifts_cancel_shift", {
          p_shift_id: requireUuid(body.shift_id, "Shift"),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "copy-week":
        requireManager(context);
        refreshWeek = requireMonday(body.target_week, "Target week");
        result = await branchRpc("atlas_shifts_copy_week", {
          p_source_week: requireMonday(body.source_week, "Source week"),
          p_target_week: refreshWeek,
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "publish-week":
        requireManager(context);
        refreshWeek = requireMonday(body.week_start, "Week start");
        result = await branchRpc("atlas_shifts_publish_week", {
          p_week_start: refreshWeek,
          p_note: optionalText(body.note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "save-availability":
        result = await branchRpc("atlas_shifts_save_availability", {
          p_person_id: requireUuid(body.person_id, "Team member"),
          p_weekday: integerInRange(body.weekday, "Weekday", 0, 6),
          p_available_from: optionalTime(body.available_from, "Available from"),
          p_available_to: optionalTime(body.available_to, "Available to"),
          p_unavailable: requireBoolean(body.unavailable, "Unavailable"),
          p_note: optionalText(body.note, 2000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "request-time-off":
        result = await branchRpc("atlas_shifts_request_time_off", {
          p_person_id: requireUuid(body.person_id, "Team member"),
          p_starts_on: requireDate(body.starts_on, "Start date"),
          p_ends_on: requireDate(body.ends_on, "End date"),
          p_request_type: requiredEnum(body.request_type, "Time-off type", TIME_OFF_TYPES),
          p_note: optionalText(body.note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "decide-time-off":
        requireManager(context);
        result = await branchRpc("atlas_shifts_decide_time_off", {
          p_request_id: requireUuid(body.request_id, "Time-off request"),
          p_status: requiredEnum(body.status, "Decision", TIME_OFF_DECISIONS),
          p_manager_note: optionalText(body.manager_note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "respond":
        result = await branchRpc("atlas_shifts_respond", {
          p_shift_id: requireUuid(body.shift_id, "Shift"),
          p_response: requiredEnum(body.response, "Response", RESPONSE_VALUES),
          p_note: optionalText(body.note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "decide-response":
        requireManager(context);
        result = await branchRpc("atlas_shifts_decide_response", {
          p_shift_id: requireUuid(body.shift_id, "Shift"),
          p_person_id: requireUuid(body.person_id, "Team member"),
          p_manager_status: requiredEnum(body.manager_status, "Manager decision", RESPONSE_DECISIONS),
          p_manager_note: requiredText(body.manager_note, "Manager note", 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      default:
        throw new ApiError(404, "Unknown Shifts action.");
    }

    if (!refreshWeek) {
      const rawWeek = body.current_week || url.searchParams.get("week_start");
      refreshWeek = requireMonday(rawWeek, "Current week");
    }

    return jsonResponse({ result, ...(await snapshot(context, refreshWeek)) });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Shifts API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Shifts service is temporarily unavailable." }, 500);
  }
});
