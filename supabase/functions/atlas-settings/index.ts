import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";
const FUNCTION_VERSION = "0.1.0";
const MAX_BODY_BYTES = 256 * 1024;

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
const SECTION_KEYS = new Set([
  "venue", "operations", "inventory", "temperature", "cleaning",
  "marketing", "brain", "security", "appearance", "modules",
]);
const ROLE_KEYS = new Set(["admin", "manager", "bartender", "viewer"]);
const NOTIFICATION_CHANNELS = new Set(["in_app", "browser", "email"]);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

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
      "x-atlas-settings-version": FUNCTION_VERSION,
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
  profileUrl.searchParams.set("select", "id,email,display_name,role,active,updated_at");
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, { headers });
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas staff profile could not be verified.");

  const profiles = await profileResponse.json() as AtlasProfile[];
  const profile = profiles[0];
  if (!profile?.active) {
    throw new ApiError(403, "This Atlas profile is inactive. Settings access has been removed.");
  }
  if (!PROFILE_ROLES.has(profile.role)) {
    throw new ApiError(403, "This Atlas profile cannot access Settings.");
  }

  return { token, user: { id: user.id, email: user.email }, profile };
}

function requireManager(context: AtlasContext): void {
  if (!isManager(context)) {
    throw new ApiError(403, "This action is limited to managers and administrators.");
  }
}

function branchCredentials() {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "The private Settings service is unavailable.");
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
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String(parsed.message)
      : typeof parsed === "string" && parsed
      ? parsed
      : "The private Settings request failed.";
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

async function productionProfiles(context: AtlasContext): Promise<AtlasProfile[]> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  url.searchParams.set("select", "id,email,display_name,role,active,updated_at");
  if (!isManager(context)) url.searchParams.set("id", `eq.${context.user.id}`);
  url.searchParams.set("order", "active.desc,display_name.asc.nullslast,email.asc");
  url.searchParams.set("limit", "500");
  const response = await fetch(url, {
    headers: {
      apikey: AUTH_PUBLISHABLE_KEY,
      authorization: `Bearer ${context.token}`,
      accept: "application/json",
      "cache-control": "no-store",
    },
  });
  if (!response.ok) throw new ApiError(403, "Atlas profile context could not be read.");
  const rows = await response.json();
  return Array.isArray(rows) ? rows as AtlasProfile[] : [];
}

async function snapshot(context: AtlasContext) {
  const profiles = await productionProfiles(context);
  const workspace = await branchRpc("atlas_settings_snapshot", {
    p_profiles: profiles,
    p_actor_id: context.user.id,
    p_actor_role: context.profile.role,
  });
  return {
    workspace,
    staff: {
      id: context.user.id,
      label: profileLabel(context.profile),
      role: context.profile.role,
      active: true,
      can_manage_organization: isManager(context),
      can_manage_security: context.profile.role === "admin",
    },
    policy: {
      environment: "isolated_branch",
      production_source_mutation: false,
      production_sync_enabled: false,
      destructive_actions_enabled: false,
      automatic_social_publishing_enabled: false,
      automatic_reorder_execution_enabled: false,
      automatic_brain_execution_enabled: false,
      secrets_returned: false,
    },
  };
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

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  return objectValue(value, label);
}

function stringValue(value: unknown, label: string, maxLength: number, required = true): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw new ApiError(400, `${label} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new ApiError(400, `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized && required) throw new ApiError(400, `${label} is required.`);
  if (normalized.length > maxLength) throw new ApiError(400, `${label} is limited to ${maxLength} characters.`);
  return normalized || null;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ApiError(400, `${label} must be true or false.`);
  return value;
}

function integerValue(value: unknown, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, `${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function nullableInteger(value: unknown, label: string, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  return integerValue(value, label, min, max);
}

function uuidValue(value: unknown, label: string, required = true): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw new ApiError(400, `${label} is required.`);
    return null;
  }
  if (typeof value !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, `${label} is invalid.`);
  }
  return value;
}

function enumValue(value: unknown, label: string, allowed: Set<string>): string {
  const normalized = stringValue(value, label, 120, true)!.toLowerCase();
  if (!allowed.has(normalized)) throw new ApiError(400, `${label} is invalid.`);
  return normalized;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ApiError(400, `${label} must be a list.`);
  return value;
}

function stringArray(value: unknown, label: string, allowed?: Set<string>): string[] {
  const values = [...new Set(arrayValue(value, label).map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (!values.length) throw new ApiError(400, `${label} must contain at least one value.`);
  if (allowed && values.some((item) => !allowed.has(item))) {
    throw new ApiError(400, `${label} contains an invalid value.`);
  }
  return values;
}

function integerArray(value: unknown, label: string, min: number, max: number): number[] {
  if (value === null || value === undefined) return [];
  const values = [...new Set(arrayValue(value, label).map((item) => integerValue(item, label, min, max)))];
  return values.sort((a, b) => a - b);
}

function timeValue(value: unknown, label: string, required = true): string | null {
  const normalized = stringValue(value, label, 5, required);
  if (normalized === null) return null;
  if (!TIME_PATTERN.test(normalized)) throw new ApiError(400, `${label} must use HH:MM.`);
  return `${normalized}:00`;
}

function assertNoSensitiveKeys(value: unknown, path = "settings"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(password|secret|token|api[_ -]?key|service[_ -]?role|credential)/i.test(key)) {
      throw new ApiError(400, `Sensitive field ${path}.${key} cannot be stored in Settings.`);
    }
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}

function validateHours(value: unknown): Record<string, unknown>[] {
  const rows = arrayValue(value, "Business hours");
  if (rows.length !== 7) throw new ApiError(400, "Business hours must contain all seven days.");
  const weekdays = new Set<number>();
  return rows.map((entry) => {
    const row = objectValue(entry, "Business-hours row");
    const weekday = integerValue(row.weekday, "Weekday", 0, 6);
    if (weekdays.has(weekday)) throw new ApiError(400, "Each weekday may appear only once.");
    weekdays.add(weekday);
    const isOpen = booleanValue(row.is_open, "Open state");
    return {
      weekday,
      day_label: stringValue(row.day_label, "Day label", 20, true),
      is_open: isOpen,
      open_time: isOpen ? timeValue(row.open_time, "Opening time", true) : null,
      close_time: isOpen ? timeValue(row.close_time, "Closing time", true) : null,
      close_next_day: Boolean(row.close_next_day),
      kitchen_close_time: timeValue(row.kitchen_close_time, "Kitchen close time", false),
      kitchen_close_next_day: Boolean(row.kitchen_close_next_day),
      last_order_time: timeValue(row.last_order_time, "Last order time", false),
      last_order_next_day: Boolean(row.last_order_next_day),
    };
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireActiveProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";

    if (request.method === "GET") {
      if (action !== "snapshot") throw new ApiError(404, "Unknown Settings action.");
      return jsonResponse(await snapshot(context));
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);
    const actorLabel = profileLabel(context.profile);
    let result: unknown;

    switch (action) {
      case "save-section": {
        requireManager(context);
        const sectionKey = enumValue(body.section_key, "Settings section", SECTION_KEYS);
        const value = objectValue(body.value, "Settings value");
        assertNoSensitiveKeys(value);
        result = await branchRpc("atlas_settings_save_section", {
          p_section_key: sectionKey,
          p_value: value,
          p_expected_version: integerValue(body.expected_version, "Expected version", 1, 1000000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "save-hours": {
        requireManager(context);
        result = await branchRpc("atlas_settings_save_hours", {
          p_hours: validateHours(body.hours),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "save-offer": {
        requireManager(context);
        const pricing = optionalObject(body.pricing, "Offer pricing");
        assertNoSensitiveKeys(pricing);
        result = await branchRpc("atlas_settings_save_offer", {
          p_offer_id: uuidValue(body.offer_id, "Offer", false),
          p_offer_key: stringValue(body.offer_key, "Offer key", 100, true),
          p_name: stringValue(body.name, "Offer name", 160, true),
          p_description: stringValue(body.description, "Offer description", 3000, false),
          p_active: booleanValue(body.active, "Offer active state"),
          p_days: integerArray(body.days, "Offer days", 0, 6),
          p_start_time: timeValue(body.start_time, "Offer start time", true),
          p_end_time: timeValue(body.end_time, "Offer end time", true),
          p_end_next_day: Boolean(body.end_next_day),
          p_pricing: pricing,
          p_booking_url: stringValue(body.booking_url, "Booking URL", 3000, false),
          p_expected_version: body.offer_id
            ? integerValue(body.expected_version, "Expected version", 1, 1000000)
            : null,
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "save-role": {
        requireManager(context);
        const roleKey = enumValue(body.role_key, "Atlas role", ROLE_KEYS);
        const permissions = objectValue(body.permissions, "Role permissions");
        assertNoSensitiveKeys(permissions);
        for (const [permission, allowed] of Object.entries(permissions)) {
          if (!/^[a-z][a-z0-9.-]{2,79}$/.test(permission) || typeof allowed !== "boolean") {
            throw new ApiError(400, "Role permission entries must be boolean capability keys.");
          }
        }
        result = await branchRpc("atlas_settings_save_role", {
          p_role_key: roleKey,
          p_permissions: permissions,
          p_expected_version: integerValue(body.expected_version, "Expected version", 1, 1000000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "save-notification": {
        requireManager(context);
        const channels = objectValue(body.channels, "Notification channels");
        for (const [channel, enabled] of Object.entries(channels)) {
          if (!NOTIFICATION_CHANNELS.has(channel) || typeof enabled !== "boolean") {
            throw new ApiError(400, "Notification channels are invalid.");
          }
        }
        result = await branchRpc("atlas_settings_save_notification_policy", {
          p_event_key: stringValue(body.event_key, "Notification event", 100, true),
          p_enabled: booleanValue(body.enabled, "Notification enabled state"),
          p_channels: channels,
          p_target_roles: stringArray(body.target_roles, "Target roles", ROLE_KEYS),
          p_reminder_minutes: integerArray(body.reminder_minutes, "Reminder minutes", 0, 43200),
          p_escalation_minutes: nullableInteger(body.escalation_minutes, "Escalation minutes", 0, 43200),
          p_manager_approval_required: booleanValue(body.manager_approval_required, "Manager approval state"),
          p_expected_version: integerValue(body.expected_version, "Expected version", 1, 1000000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "save-preferences": {
        const preferences = optionalObject(body.preferences, "Preferences");
        assertNoSensitiveKeys(preferences);
        result = await branchRpc("atlas_settings_save_preferences", {
          p_user_id: context.user.id,
          p_theme: enumValue(body.theme, "Theme", new Set(["dark", "light", "system"])),
          p_density: enumValue(body.density, "Density", new Set(["comfortable", "compact"])),
          p_language: enumValue(body.language, "Language", new Set(["en", "is"])),
          p_start_view: stringValue(body.start_view, "Start view", 80, true),
          p_timezone: stringValue(body.timezone, "Timezone", 100, true),
          p_reduce_motion: booleanValue(body.reduce_motion, "Reduce motion"),
          p_browser_notifications: booleanValue(body.browser_notifications, "Browser notifications"),
          p_email_notifications: booleanValue(body.email_notifications, "Email notifications"),
          p_preferences: preferences,
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      default:
        throw new ApiError(404, "Unknown Settings action.");
    }

    return jsonResponse({ result, ...(await snapshot(context)) });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Settings API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Settings service is temporarily unavailable." }, 500);
  }
});
