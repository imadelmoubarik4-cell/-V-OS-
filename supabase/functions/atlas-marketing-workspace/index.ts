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
const PLATFORM_KEYS = new Set(["instagram", "facebook", "tiktok", "google-business-profile"]);
const CONTENT_TYPES = new Set([
  "post",
  "story",
  "reel",
  "campaign_task",
  "event_promotion",
  "content_idea",
  "google_post",
]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const CAMPAIGN_TYPES = new Set(["promotion", "event", "seasonal", "always_on", "brand", "other"]);
const APPROVAL_DECISIONS = new Set(["approved", "changes_requested", "rejected"]);
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
      "x-atlas-marketing-version": "0.1.0",
    },
  });
}

function bearerToken(request: Request): string {
  const raw = request.headers.get("authorization") ?? "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  return match[1];
}

function profileLabel(profile: Partial<AtlasProfile> | null | undefined): string {
  return profile?.display_name?.trim()
    || profile?.email?.trim()
    || "Atlas team member";
}

function staffPayload(context: AtlasContext) {
  return {
    id: context.user.id,
    label: profileLabel(context.profile),
    role: context.profile.role,
    active: true,
    can_create: WRITE_ROLES.has(context.profile.role),
    can_approve: MANAGER_ROLES.has(context.profile.role),
    can_mark_published: MANAGER_ROLES.has(context.profile.role),
    can_manage_connections: MANAGER_ROLES.has(context.profile.role),
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
    throw new ApiError(403, "This Atlas profile is inactive. Marketing workspace access has been removed.");
  }
  if (!["admin", "manager", "bartender", "viewer"].includes(profile.role)) {
    throw new ApiError(403, "This Atlas profile cannot access the Marketing workspace.");
  }

  return {
    token,
    user: { id: user.id, email: user.email },
    profile,
  };
}

function requireWriter(context: AtlasContext): void {
  if (!WRITE_ROLES.has(context.profile.role)) {
    throw new ApiError(403, "This profile can view marketing plans but cannot create or edit them.");
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

function requireEnum(value: unknown, label: string, allowed: Set<string>): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!allowed.has(normalized)) throw new ApiError(400, `${label} is invalid.`);
  return normalized;
}

function dateOnly(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new ApiError(400, `${label} is invalid.`);
  return value;
}

function dateTime(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, `${label} is invalid.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ApiError(400, `${label} is invalid.`);
  return parsed.toISOString();
}

function stringArray(value: unknown, label: string, allowed: Set<string>, maxItems = 8): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(400, `${label} must be a list.`);
  const normalized = [...new Set(value.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))];
  if (normalized.length > maxItems || normalized.some((entry) => !allowed.has(entry))) {
    throw new ApiError(400, `${label} contains an unsupported value.`);
  }
  return normalized;
}

function jsonArray(value: unknown, label: string, maxItems = 20): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new ApiError(400, `${label} must be a valid list.`);
  return value;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be a valid object.`);
  }
  return value as Record<string, unknown>;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");

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
    throw new ApiError(500, "The private Marketing workspace service is unavailable.");
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
      : "The private Marketing workspace request failed.";
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
      : "Connected Atlas data could not be loaded.";
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

function monthRange(rawStart: unknown, rawEnd: unknown) {
  const today = venueDate();
  const [year, month] = today.split("-").map(Number);
  const defaultStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const defaultEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const start = dateOnly(rawStart, "Start date") ?? defaultStart;
  const end = dateOnly(rawEnd, "End date") ?? defaultEnd;
  const difference = Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86400000);
  if (difference < 0 || difference > 92) throw new ApiError(400, "Calendar range must be between 1 and 93 days.");
  return { start, end };
}

function resolveOwner(body: Record<string, unknown>, members: AtlasProfile[]) {
  const ownerId = optionalUuid(body.owner_id, "Owner");
  if (!ownerId) return { id: null, label: null };
  const member = members.find((profile) => profile.id === ownerId);
  if (!member) throw new ApiError(404, "The selected owner is no longer an active Atlas profile.");
  return { id: member.id, label: profileLabel(member) };
}

function memberPayload(members: AtlasProfile[]) {
  return members.map((member) => ({
    id: member.id,
    label: profileLabel(member),
    role: member.role,
  }));
}

async function workspaceSnapshot(context: AtlasContext, start: string, end: string) {
  const [workspace, recommendations, members] = await Promise.all([
    branchRpc("atlas_marketing_workspace_snapshot", {
      p_user_id: context.user.id,
      p_user_role: context.profile.role,
      p_start_date: start,
      p_end_date: end,
    }),
    branchRpc("atlas_marketing_recommendations", { p_local_date: venueDate() }),
    activeProfiles(context),
  ]);

  return {
    workspace: {
      ...(workspace || {}),
      recommendations: Array.isArray(recommendations) ? recommendations : [],
    },
    members,
  };
}

function contentPayload(body: Record<string, unknown>, members: AtlasProfile[]) {
  const eventStartsAt = dateTime(body.event_starts_at, "Event start");
  const eventEndsAt = dateTime(body.event_ends_at, "Event end");
  if (eventStartsAt && eventEndsAt && new Date(eventEndsAt) < new Date(eventStartsAt)) {
    throw new ApiError(400, "Event end cannot precede event start.");
  }
  const owner = resolveOwner(body, members);
  return {
    campaign_id: optionalUuid(body.campaign_id, "Campaign"),
    title: requiredText(body.title, "Title", 180),
    content_type: requireEnum(body.content_type, "Content type", CONTENT_TYPES),
    priority: requireEnum(body.priority ?? "normal", "Priority", PRIORITIES),
    platforms: stringArray(body.platforms, "Platforms", PLATFORM_KEYS, 4),
    scheduled_for: dateTime(body.scheduled_for, "Scheduled time"),
    reminder_at: dateTime(body.reminder_at, "Reminder time"),
    event_starts_at: eventStartsAt,
    event_ends_at: eventEndsAt,
    suggested_format: optionalText(body.suggested_format, 2000),
    caption_draft: optionalText(body.caption_draft, 10000),
    creative_brief: optionalText(body.creative_brief, 10000),
    frames: jsonArray(body.frames, "Frames", 20),
    media_requirements: jsonObject(body.media_requirements, "Media requirements"),
    owner_id: owner.id,
    owner_label: owner.label,
    metadata: jsonObject(body.metadata, "Metadata"),
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireActiveProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";

    if (request.method === "GET") {
      if (action !== "snapshot") throw new ApiError(404, "Unknown Marketing workspace action.");
      const range = monthRange(url.searchParams.get("start"), url.searchParams.get("end"));
      const payload = await workspaceSnapshot(context, range.start, range.end);
      return jsonResponse({
        ...payload,
        staff: staffPayload(context),
        members: memberPayload(payload.members),
        policy: {
          actual_publishing_enabled: false,
          analytics_ingestion_enabled: false,
          oauth_tokens_in_browser: false,
          recommendations_shadow_only: true,
          manager_approval_required: true,
          connection_cards_are_read_only: true,
        },
      });
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);
    const range = monthRange(body.start_date, body.end_date);
    const actor = profileLabel(context.profile);
    const members = await activeProfiles(context);
    let result: unknown;

    switch (action) {
      case "create-campaign": {
        requireManager(context);
        const startDate = dateOnly(body.campaign_start_date, "Campaign start date");
        const endDate = dateOnly(body.campaign_end_date, "Campaign end date");
        if (startDate && endDate && endDate < startDate) throw new ApiError(400, "Campaign end date cannot precede its start date.");
        result = await branchRpc("atlas_marketing_create_campaign", {
          p_name: requiredText(body.name, "Campaign name", 180),
          p_description: optionalText(body.description, 5000),
          p_campaign_type: requireEnum(body.campaign_type ?? "always_on", "Campaign type", CAMPAIGN_TYPES),
          p_objective: optionalText(body.objective, 3000),
          p_target_audience: optionalText(body.target_audience, 3000),
          p_platforms: stringArray(body.platforms, "Platforms", PLATFORM_KEYS, 4),
          p_start_date: startDate,
          p_end_date: endDate,
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "create-content": {
        requireWriter(context);
        const content = contentPayload(body, members);
        result = await branchRpc("atlas_marketing_create_content", {
          p_client_request_id: requireUuid(body.client_request_id, "Client request ID"),
          p_campaign_id: content.campaign_id,
          p_title: content.title,
          p_content_type: content.content_type,
          p_priority: content.priority,
          p_platforms: content.platforms,
          p_scheduled_for: content.scheduled_for,
          p_reminder_at: content.reminder_at,
          p_event_starts_at: content.event_starts_at,
          p_event_ends_at: content.event_ends_at,
          p_suggested_format: content.suggested_format,
          p_caption_draft: content.caption_draft,
          p_creative_brief: content.creative_brief,
          p_frames: content.frames,
          p_media_requirements: content.media_requirements,
          p_owner_id: content.owner_id,
          p_owner_label: content.owner_label,
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
          p_metadata: content.metadata,
        });
        break;
      }

      case "update-content": {
        requireWriter(context);
        const content = contentPayload(body, members);
        result = await branchRpc("atlas_marketing_update_content", {
          p_content_id: requireUuid(body.content_id, "Content item"),
          p_campaign_id: content.campaign_id,
          p_title: content.title,
          p_priority: content.priority,
          p_platforms: content.platforms,
          p_scheduled_for: content.scheduled_for,
          p_reminder_at: content.reminder_at,
          p_event_starts_at: content.event_starts_at,
          p_event_ends_at: content.event_ends_at,
          p_suggested_format: content.suggested_format,
          p_caption_draft: content.caption_draft,
          p_creative_brief: content.creative_brief,
          p_frames: content.frames,
          p_media_requirements: content.media_requirements,
          p_owner_id: content.owner_id,
          p_owner_label: content.owner_label,
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
          p_note: optionalText(body.note, 2000),
        });
        break;
      }

      case "submit-approval": {
        requireWriter(context);
        result = await branchRpc("atlas_marketing_submit_approval", {
          p_content_id: requireUuid(body.content_id, "Content item"),
          p_note: optionalText(body.note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "decide-approval": {
        requireManager(context);
        result = await branchRpc("atlas_marketing_decide_approval", {
          p_content_id: requireUuid(body.content_id, "Content item"),
          p_decision: requireEnum(body.decision, "Approval decision", APPROVAL_DECISIONS),
          p_note: optionalText(body.note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "mark-published": {
        requireManager(context);
        result = await branchRpc("atlas_marketing_mark_published", {
          p_content_id: requireUuid(body.content_id, "Content item"),
          p_published_at: dateTime(body.published_at, "Published time"),
          p_external_publication_ids: jsonObject(body.external_publication_ids, "Publication references"),
          p_note: optionalText(body.note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "mark-completed": {
        requireWriter(context);
        result = await branchRpc("atlas_marketing_mark_completed", {
          p_content_id: requireUuid(body.content_id, "Content item"),
          p_note: optionalText(body.note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "convert-recommendation": {
        requireWriter(context);
        result = await branchRpc("atlas_marketing_convert_recommendation_occurrence", {
          p_recommendation_id: requireUuid(body.recommendation_id, "Recommendation"),
          p_occurrence_date: dateOnly(body.occurrence_date, "Occurrence date") ?? venueDate(),
          p_client_request_id: requireUuid(body.client_request_id, "Client request ID"),
          p_scheduled_for: dateTime(body.scheduled_for, "Scheduled time"),
          p_reminder_at: dateTime(body.reminder_at, "Reminder time"),
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "dismiss-recommendation": {
        requireManager(context);
        result = await branchRpc("atlas_marketing_dismiss_recommendation_occurrence", {
          p_recommendation_id: requireUuid(body.recommendation_id, "Recommendation"),
          p_occurrence_date: dateOnly(body.occurrence_date, "Occurrence date") ?? venueDate(),
          p_reason: requiredText(body.reason, "Dismiss reason", 2000),
          p_actor_id: context.user.id,
          p_actor_label: actor,
          p_actor_role: context.profile.role,
        });
        break;
      }

      default:
        throw new ApiError(404, "Unknown Marketing workspace action.");
    }

    const refreshed = await workspaceSnapshot(context, range.start, range.end);
    return jsonResponse({
      result,
      workspace: refreshed.workspace,
      staff: staffPayload(context),
      members: memberPayload(refreshed.members),
      policy: {
        actual_publishing_enabled: false,
        analytics_ingestion_enabled: false,
        automatic_social_action: false,
        history_preserved: true,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Marketing workspace API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Marketing workspace is temporarily unavailable." }, 500);
  }
});
