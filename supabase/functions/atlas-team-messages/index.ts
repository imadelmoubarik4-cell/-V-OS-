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
const LINK_TYPES = new Set(["none", "inventory_item", "routine", "shift", "brain_recommendation"]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 100;

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

type LinkPayload = {
  type: "none" | "inventory_item" | "routine" | "shift" | "brain_recommendation";
  key: string | null;
  label: string | null;
  route: string | null;
  metadata: Record<string, unknown>;
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
      "x-atlas-team-messages-version": "0.1.0",
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

function staffPayload(context: AtlasContext) {
  return {
    id: context.user.id,
    label: labelForProfile(context.profile),
    role: context.profile.role,
    can_post: WRITE_ROLES.has(context.profile.role),
    can_announce: MANAGER_ROLES.has(context.profile.role),
    active: true,
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
    throw new ApiError(403, "This Atlas profile is inactive. Team-message access has been removed.");
  }
  if (!["admin", "manager", "bartender", "viewer"].includes(profile.role)) {
    throw new ApiError(403, "This Atlas profile cannot access team messages.");
  }

  return {
    token,
    user: { id: user.id, email: user.email },
    profile,
  };
}

function requireWriter(context: AtlasContext): void {
  if (!WRITE_ROLES.has(context.profile.role)) {
    throw new ApiError(403, "This profile can read messages but cannot post or modify them.");
  }
}

function requireManager(context: AtlasContext): void {
  if (!MANAGER_ROLES.has(context.profile.role)) {
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

function safeLimit(value: unknown, fallback = 60): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_MESSAGES, parsed));
}

function requireLinkType(value: unknown): LinkPayload["type"] {
  const normalized = typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "none";
  if (!LINK_TYPES.has(normalized)) throw new ApiError(400, "Message link type is invalid.");
  return normalized as LinkPayload["type"];
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
    throw new ApiError(500, "The private team-message service is unavailable.");
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
      : "The private team-message request failed.";
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
      : "The connected Atlas data request failed.";
    throw new ApiError(response.status === 401 ? 401 : response.status === 403 ? 403 : 400, message);
  }
  return parsed;
}

async function activeProfiles(context: AtlasContext): Promise<AtlasProfile[]> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  url.searchParams.set("select", "id,email,display_name,role,active");
  url.searchParams.set("active", "eq.true");
  url.searchParams.set("order", "display_name.asc.nullslast,email.asc");
  url.searchParams.set("limit", "500");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows as AtlasProfile[] : [];
}

function venueDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Atlantic/Reykjavik",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatShiftLabel(shift: any, profiles: AtlasProfile[]): string {
  const profile = profiles.find((item) => item.id === shift.user_id);
  const staff = labelForProfile(profile);
  const start = shift.starts_at ? new Date(shift.starts_at) : null;
  const end = shift.ends_at ? new Date(shift.ends_at) : null;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Atlantic/Reykjavik",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const time = start && !Number.isNaN(start.getTime())
    ? `${formatter.format(start)}${end && !Number.isNaN(end.getTime()) ? `–${formatter.format(end)}` : ""}`
    : "Scheduled shift";
  return `${staff} · ${time}`;
}

async function messageSnapshot(context: AtlasContext, channelKey: string, limit: number) {
  const members = await activeProfiles(context);
  const snapshot = await branchRpc("atlas_team_messages_snapshot", {
    p_user_id: context.user.id,
    p_user_role: context.profile.role,
    p_active_user_ids: members.map((member) => member.id),
    p_channel_key: channelKey,
    p_limit: limit,
  });
  return { snapshot, members };
}

async function inventoryItems(context: AtlasContext): Promise<any[]> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/inventory_items`);
  url.searchParams.set("select", "id,name,category,quantity,unit,bin_location,active");
  url.searchParams.set("active", "eq.true");
  url.searchParams.set("order", "category.asc,name.asc");
  url.searchParams.set("limit", "1000");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows : [];
}

async function shifts(context: AtlasContext): Promise<any[]> {
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/shifts`);
  url.searchParams.set("select", "id,user_id,role_name,starts_at,ends_at,status,note");
  url.searchParams.set("starts_at", `gte.${from}`);
  url.searchParams.set("starts_at", `gte.${from}`);
  url.searchParams.append("starts_at", `lte.${to}`);
  url.searchParams.set("order", "starts_at.asc");
  url.searchParams.set("limit", "200");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows : [];
}

async function targetOptions(context: AtlasContext, type: LinkPayload["type"], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (...values: unknown[]) => !normalizedQuery
    || values.filter(Boolean).some((value) => String(value).toLowerCase().includes(normalizedQuery));

  if (type === "inventory_item") {
    const items = await inventoryItems(context);
    return items
      .filter((item) => matchesQuery(item.name, item.category, item.bin_location))
      .slice(0, 30)
      .map((item) => ({
        type,
        key: item.id,
        label: item.name,
        description: [item.category, item.bin_location, `${item.quantity ?? 0} ${item.unit ?? ""}`.trim()]
          .filter(Boolean).join(" · "),
        route: "inventory",
      }));
  }

  if (type === "routine") {
    const operations = await branchRpc("atlas_operations_today", { p_local_date: venueDate() });
    const routines = Array.isArray(operations?.routines) ? operations.routines : [];
    return routines
      .filter((routine: any) => matchesQuery(routine.name, routine.description, routine.routine_type))
      .slice(0, 30)
      .map((routine: any) => ({
        type,
        key: routine.id,
        label: routine.name,
        description: `${routine.status ?? "scheduled"} · ${routine.progress?.completed ?? 0}/${routine.progress?.required ?? 0} complete`,
        route: "operations",
      }));
  }

  if (type === "shift") {
    const [rows, profiles] = await Promise.all([shifts(context), activeProfiles(context)]);
    return rows
      .map((shift) => ({ shift, label: formatShiftLabel(shift, profiles) }))
      .filter(({ shift, label }) => matchesQuery(label, shift.role_name, shift.status, shift.note))
      .slice(0, 30)
      .map(({ shift, label }) => ({
        type,
        key: shift.id,
        label,
        description: [shift.role_name, shift.status, shift.note].filter(Boolean).join(" · "),
        route: "shifts",
      }));
  }

  if (type === "brain_recommendation") {
    const phase3 = await branchRpc("atlas_phase3_snapshot");
    const recommendations = Array.isArray(phase3?.recommendations) ? phase3.recommendations : [];
    return recommendations
      .filter((recommendation: any) => matchesQuery(
        recommendation.title,
        recommendation.summary,
        recommendation.recommendation_type,
        recommendation.subject_type,
      ))
      .slice(0, 30)
      .map((recommendation: any) => ({
        type,
        key: recommendation.id,
        label: recommendation.title,
        description: `${recommendation.recommendation_type ?? "recommendation"} · ${recommendation.status ?? "active"}`,
        route: "brain",
      }));
  }

  return [];
}

async function validateLink(
  context: AtlasContext,
  type: LinkPayload["type"],
  keyValue: unknown,
): Promise<LinkPayload> {
  if (type === "none") {
    return { type, key: null, label: null, route: null, metadata: {} };
  }

  const key = requireUuid(keyValue, "Linked record");

  if (type === "inventory_item") {
    const items = await inventoryItems(context);
    const item = items.find((candidate) => candidate.id === key);
    if (!item) throw new ApiError(404, "The linked inventory item is no longer active.");
    return {
      type,
      key,
      label: item.name,
      route: "inventory",
      metadata: {
        category: item.category ?? null,
        unit: item.unit ?? null,
        bin_location: item.bin_location ?? null,
      },
    };
  }

  if (type === "routine") {
    const operations = await branchRpc("atlas_operations_today", { p_local_date: venueDate() });
    const routines = Array.isArray(operations?.routines) ? operations.routines : [];
    const routine = routines.find((candidate: any) => candidate.id === key);
    if (!routine) throw new ApiError(404, "The linked routine is not scheduled for today.");
    return {
      type,
      key,
      label: routine.name,
      route: "operations",
      metadata: {
        template_key: routine.template_key,
        routine_type: routine.routine_type,
        status: routine.status,
        scheduled_date: routine.scheduled_date,
        due_time: routine.due_time,
      },
    };
  }

  if (type === "shift") {
    const [rows, profiles] = await Promise.all([shifts(context), activeProfiles(context)]);
    const shift = rows.find((candidate) => candidate.id === key);
    if (!shift) throw new ApiError(404, "The linked shift is no longer available.");
    return {
      type,
      key,
      label: formatShiftLabel(shift, profiles),
      route: "shifts",
      metadata: {
        user_id: shift.user_id,
        role_name: shift.role_name,
        starts_at: shift.starts_at,
        ends_at: shift.ends_at,
        status: shift.status,
      },
    };
  }

  const phase3 = await branchRpc("atlas_phase3_snapshot");
  const recommendations = Array.isArray(phase3?.recommendations) ? phase3.recommendations : [];
  const recommendation = recommendations.find((candidate: any) => candidate.id === key);
  if (!recommendation) throw new ApiError(404, "The linked Atlas recommendation is no longer active.");
  return {
    type: "brain_recommendation",
    key,
    label: recommendation.title,
    route: "brain",
    metadata: {
      recommendation_type: recommendation.recommendation_type,
      status: recommendation.status,
      confidence_state: recommendation.confidence_state,
      confidence_score: recommendation.confidence_score,
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
      if (action === "snapshot") {
        const channelKey = optionalText(url.searchParams.get("channel"), 64) || "general";
        const limit = safeLimit(url.searchParams.get("limit"));
        const { snapshot, members } = await messageSnapshot(context, channelKey, limit);
        return jsonResponse({
          snapshot,
          staff: staffPayload(context),
          members: members.map((member) => ({
            id: member.id,
            label: labelForProfile(member),
            role: member.role,
          })),
          policy: {
            delivery_mode: "secure_polling",
            browser_notifications_enabled: false,
            direct_table_access: false,
            inactive_profile_access: "denied_on_every_request",
          },
        });
      }

      if (action === "targets") {
        const type = requireLinkType(url.searchParams.get("type"));
        if (type === "none") return jsonResponse({ targets: [], type });
        const query = optionalText(url.searchParams.get("q"), 120) || "";
        const targets = await targetOptions(context, type, query);
        return jsonResponse({ targets, type, staff: staffPayload(context) });
      }

      throw new ApiError(404, "Unknown team-message action.");
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);
    const channelKey = optionalText(body.channel_key, 64) || "general";
    const actor = labelForProfile(context.profile);
    let result: unknown;

    if (action === "mark-read") {
      result = await branchRpc("atlas_team_messages_mark_read", {
        p_channel_key: channelKey,
        p_user_id: context.user.id,
        p_user_label: actor,
        p_user_role: context.profile.role,
      });
      const { snapshot, members } = await messageSnapshot(context, channelKey, safeLimit(body.limit));
      return jsonResponse({ result, snapshot, members, staff: staffPayload(context) });
    }

    if (action === "send") {
      requireWriter(context);
      if (channelKey === "announcements") requireManager(context);
      const messageBody = requiredText(body.body, "Message", 4000);
      const linkType = requireLinkType(body.link_type);
      const link = await validateLink(context, linkType, body.link_key);
      result = await branchRpc("atlas_team_messages_send", {
        p_channel_key: channelKey,
        p_body: messageBody,
        p_sender_id: context.user.id,
        p_sender_label: actor,
        p_sender_role: context.profile.role,
        p_client_request_id: requireUuid(body.client_request_id, "Client request ID"),
        p_link_type: link.type,
        p_link_key: link.key,
        p_link_label: link.label,
        p_link_route: link.route,
        p_link_metadata: link.metadata,
      });
    } else if (action === "edit") {
      requireWriter(context);
      result = await branchRpc("atlas_team_messages_edit", {
        p_message_id: requireUuid(body.message_id, "Message"),
        p_body: requiredText(body.body, "Message", 4000),
        p_actor_id: context.user.id,
        p_actor_label: actor,
        p_actor_role: context.profile.role,
      });
    } else if (action === "delete") {
      requireWriter(context);
      result = await branchRpc("atlas_team_messages_delete", {
        p_message_id: requireUuid(body.message_id, "Message"),
        p_reason: optionalText(body.reason, 1000),
        p_actor_id: context.user.id,
        p_actor_label: actor,
        p_actor_role: context.profile.role,
      });
    } else {
      throw new ApiError(404, "Unknown team-message action.");
    }

    const { snapshot, members } = await messageSnapshot(context, channelKey, safeLimit(body.limit));
    return jsonResponse({ result, snapshot, members, staff: staffPayload(context) });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Team messages API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The team-message service is temporarily unavailable." }, 500);
  }
});
