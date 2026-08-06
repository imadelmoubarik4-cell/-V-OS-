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
const ARTICLE_TYPES = new Set(["policy", "sop", "checklist", "training", "reference", "live_resource"]);
const TARGET_ROLES = new Set(["all", "admin", "manager", "bartender", "viewer"]);
const SOURCE_TYPES = new Set(["google_drive", "atlas_module", "sprint3_import", "manual", "external"]);
const SOURCE_STATES = new Set(["manual_reference", "not_connected", "current", "stale", "error"]);
const MAX_BODY_BYTES = 512 * 1024;

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
      "x-atlas-knowledge-version": "0.1.0",
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
    can_manage_knowledge: isManager(context),
  };
}

function policyPayload() {
  return {
    publishing_model: "manager_draft_then_immutable_version",
    only_published_versions_visible_to_staff: true,
    google_drive_automatic_sync_enabled: false,
    source_urls_manager_only: true,
    browser_notifications_enabled: false,
    direct_browser_table_access: false,
    sensitive_credentials_imported: false,
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
    throw new ApiError(403, "This Atlas profile is inactive. Knowledge access has been removed.");
  }
  if (!PROFILE_ROLES.has(profile.role)) {
    throw new ApiError(403, "This Atlas profile cannot access Knowledge.");
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

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ApiError(400, `${label} must be true or false.`);
  return value;
}

function requiredEnum(value: unknown, label: string, allowed: Set<string>): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!allowed.has(normalized)) throw new ApiError(400, `${label} is invalid.`);
  return normalized;
}

function optionalEnum(value: unknown, label: string, allowed: Set<string>): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredEnum(value, label, allowed);
}

function stringArray(value: unknown, label: string, allowed?: Set<string>): string[] {
  if (!Array.isArray(value)) throw new ApiError(400, `${label} must be a list.`);
  const values = [...new Set(value.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (!values.length) throw new ApiError(400, `${label} must contain at least one value.`);
  if (allowed && values.some((item) => !allowed.has(item))) {
    throw new ApiError(400, `${label} contains an invalid value.`);
  }
  return values;
}

function uuidArray(value: unknown, label: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(400, `${label} must be a list.`);
  return [...new Set(value.map((item) => requireUuid(item, label)))];
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 110);
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
    throw new ApiError(500, "The private Knowledge service is unavailable.");
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
      : "The private Knowledge request failed.";
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
      : "Connected Atlas training data could not be read.";
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

async function snapshot(context: AtlasContext) {
  const [profiles, tasks, progress] = await Promise.all([
    productionProfiles(context),
    onboardingTasks(context),
    onboardingProgress(context),
  ]);
  const workspace = await branchRpc("atlas_knowledge_snapshot", {
    p_profiles: profiles,
    p_tasks: tasks,
    p_progress: progress,
    p_actor_id: context.user.id,
    p_actor_role: context.profile.role,
  });
  return {
    workspace,
    staff: staffPayload(context),
    onboarding_tasks: tasks,
    policy: policyPayload(),
  };
}

async function detail(context: AtlasContext, articleId: string, preferDraft = false) {
  const article = await branchRpc("atlas_knowledge_article_detail", {
    p_article_id: articleId,
    p_actor_id: context.user.id,
    p_actor_role: context.profile.role,
    p_prefer_draft: Boolean(preferDraft && isManager(context)),
  });
  return { article, staff: staffPayload(context), policy: policyPayload() };
}

async function validateTaskIds(context: AtlasContext, values: string[]): Promise<string[]> {
  if (!values.length) return [];
  const tasks = await onboardingTasks(context);
  const activeIds = new Set(tasks.map((task) => task.id));
  if (values.some((id) => !activeIds.has(id))) {
    throw new ApiError(400, "One or more onboarding tasks are no longer active.");
  }
  return values;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireActiveProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";

    if (request.method === "GET") {
      if (action === "snapshot") return jsonResponse(await snapshot(context));
      if (action === "detail") {
        const articleId = requireUuid(url.searchParams.get("article_id"), "Knowledge article");
        const preferDraft = url.searchParams.get("prefer_draft") === "true";
        return jsonResponse(await detail(context, articleId, preferDraft));
      }
      throw new ApiError(404, "Unknown Knowledge action.");
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);
    const actorLabel = profileLabel(context.profile);
    let result: unknown;
    let articleId: string | null = optionalUuid(body.article_id, "Knowledge article");

    switch (action) {
      case "save-draft": {
        requireManager(context);
        const title = requiredText(body.title, "Article title", 220);
        const targetRoles = stringArray(body.target_roles ?? ["all"], "Target roles", TARGET_ROLES);
        const taskIds = await validateTaskIds(context, uuidArray(body.task_ids, "Onboarding task"));
        const articleKey = articleId
          ? optionalText(body.article_key, 120)
          : optionalText(body.article_key, 120) || `${slugify(title)}-${crypto.randomUUID().slice(0, 8)}`;
        if (!articleKey || !/^[a-z0-9][a-z0-9-]{1,119}$/.test(articleKey)) {
          throw new ApiError(400, "Article key must contain lowercase letters, numbers and hyphens.");
        }

        result = await branchRpc("atlas_knowledge_save_draft", {
          p_article_id: articleId,
          p_article_key: articleKey,
          p_category_id: requireUuid(body.category_id, "Knowledge category"),
          p_article_type: requiredEnum(body.article_type, "Article type", ARTICLE_TYPES),
          p_title: title,
          p_summary: optionalText(body.summary, 3000),
          p_content: requiredText(body.content, "Article content", 250000),
          p_required: requiredBoolean(body.required ?? false, "Required reading"),
          p_target_roles: targetRoles,
          p_live_route: optionalText(body.live_route, 160),
          p_change_note: optionalText(body.change_note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        articleId = String((result as any)?.article?.id || articleId || "");
        if (!isUuid(articleId)) throw new ApiError(500, "The saved Knowledge article could not be identified.");
        await branchRpc("atlas_knowledge_set_task_links", {
          p_article_id: articleId,
          p_task_ids: taskIds,
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;
      }

      case "publish":
        requireManager(context);
        articleId = requireUuid(body.article_id, "Knowledge article");
        result = await branchRpc("atlas_knowledge_publish", {
          p_article_id: articleId,
          p_change_note: optionalText(body.change_note, 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "retire":
        requireManager(context);
        articleId = requireUuid(body.article_id, "Knowledge article");
        result = await branchRpc("atlas_knowledge_retire", {
          p_article_id: articleId,
          p_reason: requiredText(body.reason, "Retirement reason", 3000),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "mark-read":
        articleId = requireUuid(body.article_id, "Knowledge article");
        result = await branchRpc("atlas_knowledge_mark_read", {
          p_article_id: articleId,
          p_version_id: requireUuid(body.version_id, "Knowledge version"),
          p_user_id: context.user.id,
          p_user_label: actorLabel,
          p_user_role: context.profile.role,
        });
        break;

      case "acknowledge":
        articleId = requireUuid(body.article_id, "Knowledge article");
        result = await branchRpc("atlas_knowledge_acknowledge", {
          p_article_id: articleId,
          p_version_id: requireUuid(body.version_id, "Knowledge version"),
          p_user_id: context.user.id,
          p_user_label: actorLabel,
          p_user_role: context.profile.role,
        });
        break;

      case "save-source":
        requireManager(context);
        articleId = requireUuid(body.article_id, "Knowledge article");
        result = await branchRpc("atlas_knowledge_save_source", {
          p_source_id: optionalUuid(body.source_id, "Knowledge source"),
          p_article_id: articleId,
          p_source_type: requiredEnum(body.source_type, "Source type", SOURCE_TYPES),
          p_source_label: requiredText(body.source_label, "Source label", 220),
          p_source_reference: optionalText(body.source_reference, 1000),
          p_source_url: optionalText(body.source_url, 3000),
          p_source_version: optionalText(body.source_version, 300),
          p_connection_status: requiredEnum(body.connection_status ?? "manual_reference", "Source status", SOURCE_STATES),
          p_visible_to_staff: requiredBoolean(body.visible_to_staff ?? false, "Staff source visibility"),
          p_metadata: objectValue(body.metadata, "Source metadata"),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "remove-source":
        requireManager(context);
        result = await branchRpc("atlas_knowledge_remove_source", {
          p_source_id: requireUuid(body.source_id, "Knowledge source"),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      case "set-task-links":
        requireManager(context);
        articleId = requireUuid(body.article_id, "Knowledge article");
        result = await branchRpc("atlas_knowledge_set_task_links", {
          p_article_id: articleId,
          p_task_ids: await validateTaskIds(context, uuidArray(body.task_ids, "Onboarding task")),
          p_actor_id: context.user.id,
          p_actor_label: actorLabel,
          p_actor_role: context.profile.role,
        });
        break;

      default:
        throw new ApiError(404, "Unknown Knowledge action.");
    }

    const refreshed = await snapshot(context);
    const refreshedDetail = articleId && isUuid(articleId)
      ? await detail(context, articleId, isManager(context))
      : null;
    return jsonResponse({
      result,
      ...refreshed,
      detail: refreshedDetail?.article || null,
    });
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Knowledge API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Knowledge service is temporarily unavailable." }, 500);
  }
});
