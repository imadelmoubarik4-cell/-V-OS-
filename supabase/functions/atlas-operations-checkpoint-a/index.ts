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

const WRITE_ROLES = new Set(["admin", "manager", "bartender"]);
const MANAGER_ROLES = new Set(["admin", "manager"]);
const MAX_BODY_BYTES = 64 * 1024;

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type AtlasContext = {
  user: { id: string; email?: string | null };
  profile: {
    id: string;
    email?: string | null;
    display_name?: string | null;
    role: string;
    active: boolean;
  };
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-operations-version": "0.1.0",
    },
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  return match[1];
}

function actorLabel(context: AtlasContext): string {
  return context.profile.display_name?.trim()
    || context.profile.email?.trim()
    || context.user.email?.trim()
    || "Atlas staff";
}

async function requireActiveProfile(request: Request): Promise<AtlasContext> {
  const token = bearerToken(request);
  const authHeaders = {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "cache-control": "no-store",
  };

  const userResponse = await fetch(`${AUTH_PROJECT_URL}/auth/v1/user`, {
    headers: authHeaders,
  });
  if (!userResponse.ok) throw new ApiError(401, "Your Atlas session has expired.");

  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.");

  const profileResponse = await fetch(
    `${AUTH_PROJECT_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,display_name,role,active`,
    { headers: authHeaders },
  );
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas role could not be verified.");

  const profiles = await profileResponse.json() as AtlasContext["profile"][];
  const profile = profiles[0];
  if (!profile?.active) throw new ApiError(403, "This Atlas profile is inactive.");
  if (!["admin", "manager", "bartender", "viewer"].includes(profile.role)) {
    throw new ApiError(403, "This Atlas profile cannot access operational routines.");
  }

  return {
    user: { id: user.id, email: user.email },
    profile,
  };
}

function requireWriter(context: AtlasContext): void {
  if (!WRITE_ROLES.has(context.profile.role)) {
    throw new ApiError(403, "This action is limited to active operational staff.");
  }
}

function requireManager(context: AtlasContext): void {
  if (!MANAGER_ROLES.has(context.profile.role)) {
    throw new ApiError(403, "This action is limited to managers and administrators.");
  }
}

function staffPayload(context: AtlasContext) {
  return {
    id: context.user.id,
    label: actorLabel(context),
    role: context.profile.role,
    can_write: WRITE_ROLES.has(context.profile.role),
    can_manage: MANAGER_ROLES.has(context.profile.role),
  };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireUuid(value: unknown, label: string): string {
  if (!isUuid(value)) throw new ApiError(400, `${label} is invalid.`);
  return value;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, "A text field is invalid.");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new ApiError(400, `Text is limited to ${maxLength} characters.`);
  return normalized;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ApiError(400, `${label} must be true or false.`);
  return value;
}

function requireNumber(value: unknown, label: string, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) {
    throw new ApiError(400, `${label} must be between ${min} and ${max}.`);
  }
  return numberValue;
}

function optionalNumber(value: unknown, label: string, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  return requireNumber(value, label, min, max);
}

function requireDate(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ApiError(400, "Date must use YYYY-MM-DD.");
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, "Date is invalid.");
  return raw;
}

function optionalTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
    throw new ApiError(400, "Time must use HH:MM.");
  }
  return value.length === 5 ? `${value}:00` : value;
}

function requireDays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new ApiError(400, "At least one day is required.");
  const days = [...new Set(value.map(Number))];
  if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new ApiError(400, "Days must be integers from 0 to 6.");
  }
  return days;
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

async function branchRpc(name: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const branchUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "Checkpoint A branch credentials are unavailable.");
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
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const message = typeof parsed === "object" && parsed && "message" in parsed
      ? String((parsed as { message: unknown }).message)
      : typeof parsed === "string" && parsed
      ? parsed
      : "The Checkpoint A database request failed.";
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

function venueDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Atlantic/Reykjavik",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireActiveProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";

    if (request.method === "GET") {
      if (action === "snapshot") {
        const requestedDate = url.searchParams.get("date");
        const localDate = requestedDate ? requireDate(requestedDate) : venueDate();
        const operations = await branchRpc("atlas_operations_today", { p_local_date: localDate });
        return jsonResponse({
          operations,
          staff: staffPayload(context),
          policy: {
            private_branch: true,
            manager_review_for_settings: true,
            direct_table_access: false,
            operational_history_preserved: true,
          },
        });
      }

      if (action === "settings") {
        requireManager(context);
        const settings = await branchRpc("atlas_operations_settings");
        return jsonResponse({
          settings,
          staff: staffPayload(context),
          policy: {
            manager_only: true,
            credentials_in_response: false,
            operational_history_preserved: true,
          },
        });
      }

      throw new ApiError(404, "Unknown Checkpoint A action.");
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);
    const actor = actorLabel(context);
    let result: unknown;

    switch (action) {
      case "set-item": {
        requireWriter(context);
        const evidence = body.evidence && typeof body.evidence === "object" && !Array.isArray(body.evidence)
          ? body.evidence
          : {};
        result = await branchRpc("atlas_operations_set_item", {
          p_instance_id: requireUuid(body.instance_id, "Routine instance"),
          p_template_item_id: requireUuid(body.template_item_id, "Checklist item"),
          p_completed: requireBoolean(body.completed, "Completed"),
          p_note: optionalText(body.note, 2000),
          p_evidence: evidence,
          p_actor_id: context.user.id,
          p_actor_label: actor,
        });
        break;
      }
      case "complete-routine": {
        requireWriter(context);
        result = await branchRpc("atlas_operations_complete_routine", {
          p_instance_id: requireUuid(body.instance_id, "Routine instance"),
          p_notes: optionalText(body.notes, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actor,
        });
        break;
      }
      case "skip-routine": {
        requireManager(context);
        const reason = optionalText(body.reason, 2000);
        if (!reason) throw new ApiError(400, "A skip reason is required.");
        result = await branchRpc("atlas_operations_skip_routine", {
          p_instance_id: requireUuid(body.instance_id, "Routine instance"),
          p_reason: reason,
          p_actor_id: context.user.id,
          p_actor_label: actor,
        });
        break;
      }
      case "log-temperature": {
        requireWriter(context);
        result = await branchRpc("atlas_operations_log_temperature", {
          p_point_id: requireUuid(body.point_id, "Temperature point"),
          p_temperature_c: requireNumber(body.temperature_c, "Temperature", -60, 120),
          p_note: optionalText(body.note, 2000),
          p_corrective_action: optionalText(body.corrective_action, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actor,
        });
        break;
      }
      case "update-template": {
        requireManager(context);
        const assignedRole = optionalText(body.assigned_role, 40);
        if (assignedRole && !["admin", "manager", "bartender", "viewer", "any_active_staff"].includes(assignedRole)) {
          throw new ApiError(400, "Assigned role is invalid.");
        }
        result = await branchRpc("atlas_operations_update_template", {
          p_template_id: requireUuid(body.template_id, "Routine template"),
          p_name: optionalText(body.name, 140),
          p_description: optionalText(body.description, 3000),
          p_days_of_week: requireDays(body.days_of_week),
          p_available_from: optionalTime(body.available_from),
          p_due_time: optionalTime(body.due_time),
          p_assigned_role: assignedRole,
          p_active: requireBoolean(body.active, "Active"),
          p_requires_manager_signoff: requireBoolean(body.requires_manager_signoff, "Manager sign-off"),
          p_actor_id: context.user.id,
          p_actor_label: actor,
        });
        break;
      }
      case "update-temperature-point": {
        requireManager(context);
        const min = optionalNumber(body.min_temp_c, "Minimum temperature", -60, 120);
        const max = optionalNumber(body.max_temp_c, "Maximum temperature", -60, 120);
        if (min !== null && max !== null && min > max) {
          throw new ApiError(400, "Minimum temperature cannot exceed maximum temperature.");
        }
        result = await branchRpc("atlas_operations_update_temperature_point", {
          p_point_id: requireUuid(body.point_id, "Temperature point"),
          p_name: optionalText(body.name, 140),
          p_location: optionalText(body.location, 240),
          p_min_temp_c: min,
          p_max_temp_c: max,
          p_active: requireBoolean(body.active, "Active"),
          p_actor_id: context.user.id,
          p_actor_label: actor,
        });
        break;
      }
      default:
        throw new ApiError(404, "Unknown Checkpoint A action.");
    }

    return jsonResponse({
      operations: result,
      staff: staffPayload(context),
      policy: {
        direct_table_access: false,
        quantity_mutation: false,
        operational_history_preserved: true,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Checkpoint A operations API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Checkpoint A operations service is temporarily unavailable." }, 500);
  }
});
