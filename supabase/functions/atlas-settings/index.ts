import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AuthError, actorLabel, authConfig, resolveActor } from "../_shared/auth.mjs";

const FUNCTION_VERSION = "0.1.3";
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

// s88-settings-helpers:start (pure; unit-tested by tests/node/venue-clock-api-s88.test.js)
const DEFAULT_VENUE_TIME_ZONE = "Atlantic/Reykjavik";
const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

function isValidTimeZone(value: unknown): boolean {
  if (typeof value !== "string" || value !== value.trim() || !TIME_ZONE_PATTERN.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function timeZoneProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (isValidTimeZone(value)) return null;
  const shown = typeof value === "string" && value.trim() ? value.trim().slice(0, 64) : "(empty)";
  return `Time zone ${shown} is not recognised. Use an IANA name such as ${DEFAULT_VENUE_TIME_ZONE}.`;
}

function venueClockStaff(role: string, id: string) {
  return {
    id,
    role,
    active: true,
    can_manage_hours: role === "admin" || role === "manager",
  };
}
// s88-settings-helpers:end

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

function profileLabel(profile: Partial<AtlasProfile> | null | undefined): string {
  return actorLabel(profile);
}

function isManager(context: AtlasContext): boolean {
  return MANAGER_ROLES.has(context.profile.role);
}

// The production Auth/REST project and its publishable key come only from the
// function environment (_shared/auth.mjs authConfig); unconfigured fails closed.
function productionAuthUrl(): string {
  return authConfig(Deno.env).projectUrl;
}

function productionPublishableKey(): string {
  return authConfig(Deno.env).publishableKey;
}

async function requireActiveProfile(request: Request): Promise<AtlasContext> {
  const actor = await resolveActor(request, Deno.env, fetch, {
    inactiveMessage: "This Atlas profile is inactive. Settings access has been removed.",
    profileColumns: ["updated_at"],
  });
  return { token: actor.token, user: { id: actor.userId }, profile: actor.profile as AtlasProfile };
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

// S88 hardening (F9): database text reaches the browser only when it is an
// Atlas-authored message (raised by our SQL) without schema detail; anything
// else (constraint, column, relation or permission text) becomes the fixed
// fallback. The SQLSTATE is logged instead.
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
    const message = safeDbMessage(parsed, "The private Settings request failed.");
    if (message === "The private Settings request failed.") {
      console.warn("Settings RPC failed", name, response.status, parsed && typeof parsed === "object" ? String(parsed.code ?? "-") : "-");
    }
    const conflict = /changed after this page was opened/i.test(message);
    throw new ApiError(response.status >= 500 && !conflict ? 500 : conflict ? 409 : 400, message);
  }
  return parsed;
}

async function productionProfiles(context: AtlasContext): Promise<AtlasProfile[]> {
  const url = new URL(`${productionAuthUrl()}/rest/v1/profiles`);
  url.searchParams.set("select", "id,email,display_name,role,active,updated_at");
  if (!isManager(context)) url.searchParams.set("id", `eq.${context.user.id}`);
  url.searchParams.set("order", "active.desc,display_name.asc.nullslast,email.asc");
  url.searchParams.set("limit", "500");
  const response = await fetch(url, {
    headers: {
      apikey: productionPublishableKey(),
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
  // Postgres time columns round-trip as HH:MM:SS; accept them and keep HH:MM.
  const raw = stringValue(value, label, 8, required);
  if (raw === null) return null;
  const normalized = /^\d{2}:\d{2}:\d{2}$/.test(raw) ? raw.slice(0, 5) : raw;
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
    // Match whole credential-style key names. A substring match rejected
    // ordinary booleans such as api_keys_visible and
    // password_policy_managed_by_auth, so the Security section could never
    // be saved. The database guard applies the same whole-key rule.
    if (/^(password|secret|token|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|service[_ -]?role([_ -]?key)?|credentials?|client[_ -]?secret|private[_ -]?key)$/i.test(key)) {
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
      if (action === "venue-clock") {
        // Every active role may read the venue clock: hours, offers, time
        // zone and dates are operational, not commercial.
        const clock = await branchRpc("atlas_settings_venue_clock", {
          p_actor_role: context.profile.role,
          p_actor_id: context.user.id,
        });
        return jsonResponse({ clock, staff: venueClockStaff(context.profile.role, context.user.id) });
      }
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
        if (sectionKey === "venue") {
          const problem = timeZoneProblem(value.timezone);
          if (problem) throw new ApiError(400, problem);
        }
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
        const preferenceZone = stringValue(body.timezone, "Timezone", 100, true);
        const preferenceZoneProblem = timeZoneProblem(preferenceZone);
        if (preferenceZoneProblem) throw new ApiError(400, preferenceZoneProblem);
        result = await branchRpc("atlas_settings_save_preferences", {
          p_user_id: context.user.id,
          p_theme: enumValue(body.theme, "Theme", new Set(["dark", "light", "system"])),
          p_density: enumValue(body.density, "Density", new Set(["comfortable", "compact"])),
          p_language: enumValue(body.language, "Language", new Set(["en", "is"])),
          p_start_view: stringValue(body.start_view, "Start view", 80, true),
          p_timezone: preferenceZone,
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
    if (error instanceof ApiError || error instanceof AuthError) return jsonResponse({ error: error.message }, error.status);
    console.error("Settings API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Settings service is temporarily unavailable." }, 500);
  }
});
