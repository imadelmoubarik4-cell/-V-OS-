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
const MAX_BODY_BYTES = 64 * 1024;
const TIMEZONE = "Atlantic/Reykjavik";

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

type DateRange = {
  start: string;
  end: string;
  label: string;
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
      "x-atlas-reports-version": "0.1.0",
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
    can_view_manager_reports: isManager(context),
    can_view_employee_detail: isManager(context),
    can_export_reports: true,
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
  if (!profile?.active) throw new ApiError(403, "This Atlas profile is inactive. Reports access has been removed.");
  if (!PROFILE_ROLES.has(profile.role)) throw new ApiError(403, "This Atlas profile cannot access Reports.");

  return { token, user: { id: user.id, email: user.email }, profile };
}

function branchCredentials() {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const privilegedKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !privilegedKey) throw new ApiError(500, "The private Reports service is unavailable.");
  return { branchUrl, privilegedKey };
}

async function branchRpc(name: string, payload: Record<string, unknown>): Promise<any> {
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
      : "The private Reports request failed.";
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
      : "Connected Atlas report context could not be read.";
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

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfWeek(date: Date): Date {
  const next = utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = next.getUTCDay() || 7;
  return addDays(next, 1 - day);
}

function startOfQuarter(date: Date): Date {
  const month = Math.floor(date.getUTCMonth() / 3) * 3;
  return utcDate(date.getUTCFullYear(), month, 1);
}

function labelRange(start: string, end: string): string {
  const formatter = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: TIMEZONE });
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);
  return `${formatter.format(a)} – ${formatter.format(b)}`;
}

function dateRangeFromRequest(url: URL): { period: DateRange; preset: string } {
  const preset = url.searchParams.get("preset") || "last_30_days";
  const now = new Date();
  const today = utcDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let start = today;
  let end = today;

  switch (preset) {
    case "today":
      break;
    case "yesterday":
      start = addDays(today, -1);
      end = addDays(today, -1);
      break;
    case "last_7_days":
      start = addDays(today, -6);
      break;
    case "this_week":
      start = startOfWeek(today);
      break;
    case "last_week": {
      const thisWeek = startOfWeek(today);
      start = addDays(thisWeek, -7);
      end = addDays(thisWeek, -1);
      break;
    }
    case "this_month":
      start = utcDate(today.getUTCFullYear(), today.getUTCMonth(), 1);
      break;
    case "last_month":
      start = utcDate(today.getUTCFullYear(), today.getUTCMonth() - 1, 1);
      end = addDays(utcDate(today.getUTCFullYear(), today.getUTCMonth(), 1), -1);
      break;
    case "this_quarter":
      start = startOfQuarter(today);
      break;
    case "year_to_date":
      start = utcDate(today.getUTCFullYear(), 0, 1);
      break;
    case "custom": {
      const startParam = url.searchParams.get("start_date");
      const endParam = url.searchParams.get("end_date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startParam || "") || !/^\d{4}-\d{2}-\d{2}$/.test(endParam || "")) {
        throw new ApiError(400, "Custom report dates must use YYYY-MM-DD.");
      }
      const customStart = new Date(`${startParam}T00:00:00Z`);
      const customEnd = new Date(`${endParam}T00:00:00Z`);
      if (Number.isNaN(customStart.getTime()) || Number.isNaN(customEnd.getTime()) || customEnd < customStart) {
        throw new ApiError(400, "Custom report date range is invalid.");
      }
      start = customStart;
      end = customEnd;
      break;
    }
    case "last_30_days":
    default:
      start = addDays(today, -29);
      break;
  }

  const startText = isoDate(start);
  const endText = isoDate(end);
  return { preset, period: { start: startText, end: endText, label: labelRange(startText, endText) } };
}

function comparisonRange(period: DateRange, comparisonKey: string): DateRange | null {
  if (comparisonKey === "none") return null;
  const start = new Date(`${period.start}T00:00:00Z`);
  const end = new Date(`${period.end}T00:00:00Z`);
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  let comparisonStart: Date;
  let comparisonEnd: Date;

  switch (comparisonKey) {
    case "previous_week":
      comparisonStart = addDays(start, -7);
      comparisonEnd = addDays(end, -7);
      break;
    case "previous_month":
      comparisonStart = utcDate(start.getUTCFullYear(), start.getUTCMonth() - 1, start.getUTCDate());
      comparisonEnd = addDays(comparisonStart, days - 1);
      break;
    case "previous_year":
      comparisonStart = utcDate(start.getUTCFullYear() - 1, start.getUTCMonth(), start.getUTCDate());
      comparisonEnd = addDays(comparisonStart, days - 1);
      break;
    case "previous_period":
    default:
      comparisonEnd = addDays(start, -1);
      comparisonStart = addDays(comparisonEnd, 1 - days);
      break;
  }

  const startText = isoDate(comparisonStart);
  const endText = isoDate(comparisonEnd);
  return { start: startText, end: endText, label: labelRange(startText, endText) };
}

function filterPayload(url: URL): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const key of ["section", "status", "category", "supplier", "employee", "search"]) {
    const value = url.searchParams.get(key)?.trim();
    if (value) filters[key] = value;
  }
  return filters;
}

async function snapshot(context: AtlasContext, url: URL) {
  const { period, preset } = dateRangeFromRequest(url);
  const comparisonKey = url.searchParams.get("comparison") || "previous_period";
  const comparison = comparisonRange(period, comparisonKey);
  const [profiles, tasks, progress] = await Promise.all([
    productionProfiles(context),
    onboardingTasks(context),
    onboardingProgress(context),
  ]);

  const workspace = await branchRpc("atlas_reports_snapshot", {
    p_profiles: profiles,
    p_tasks: tasks,
    p_progress: progress,
    p_actor_id: context.user.id,
    p_actor_role: context.profile.role,
    p_period_start: period.start,
    p_period_end: period.end,
    p_comparison_start: comparison?.start ?? null,
    p_comparison_end: comparison?.end ?? null,
    p_comparison_key: comparisonKey,
    p_filters: filterPayload(url),
  });

  return {
    workspace,
    staff: staffPayload(context),
    controls: {
      selected_preset: preset,
      selected_comparison: comparisonKey,
      period_options: ["today", "yesterday", "last_7_days", "last_30_days", "this_week", "last_week", "this_month", "last_month", "this_quarter", "year_to_date", "custom"],
      comparison_options: ["previous_period", "previous_week", "previous_month", "previous_year", "none"],
    },
  };
}

function safeNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatIsk(value: unknown): string {
  const number = safeNumber(value);
  if (number === null) return "unavailable";
  return `${Math.round(number).toLocaleString("en-US")} ISK`;
}

function deterministicReportAnswer(question: string, workspace: any): { answer: string; evidence: any[]; limitations: string[] } {
  const lower = question.toLowerCase();
  const period = workspace?.period?.label || "the selected period";
  const reports = workspace?.reports || {};
  const inventory = reports.inventory?.summary || {};
  const operations = reports.operations?.summary || {};
  const recipes = reports.recipes?.summary || {};
  const purchasing = reports.purchasing?.summary || {};
  const attention = Array.isArray(workspace?.attention) ? workspace.attention : [];
  const sources = Array.isArray(workspace?.data_sources) ? workspace.data_sources : [];

  if (/missing|trust|complete|quality|source/.test(lower)) {
    const missing = sources.filter((source: any) => ["not_connected", "no_records", "partial"].includes(source.status));
    return {
      answer: `For ${period}, ${missing.length} report sources are not fully complete. Sales remains not connected, and partial/no-record sources are clearly labelled instead of showing invented values.`,
      evidence: missing.slice(0, 6).map((source: any) => ({ label: source.name, value: source.status, note: source.note })),
      limitations: ["Ask Atlas only uses values returned by the current Reports snapshot.", "It does not query raw source tables from the browser."],
    };
  }

  if (/inventory|stock|par|item/.test(lower)) {
    return {
      answer: `For ${period}, Atlas reports ${inventory.active_items ?? 0} active inventory items, ${inventory.below_par ?? 0} below par, ${inventory.out_of_stock ?? 0} out of stock, and an estimated inventory value of ${formatIsk(inventory.estimated_value)}.`,
      evidence: [
        { label: "Active inventory items", value: inventory.active_items ?? 0 },
        { label: "Below par", value: inventory.below_par ?? 0 },
        { label: "Out of stock", value: inventory.out_of_stock ?? 0 },
        { label: "Missing cost", value: inventory.missing_cost ?? 0 },
      ],
      limitations: ["Inventory valuation excludes items with missing cost information.", "Sales usage is not connected, so demand-based stock coverage is not calculated."],
    };
  }

  if (/recipe|menu|serve|available/.test(lower)) {
    return {
      answer: `For ${period}, Atlas reports ${recipes.ready ?? 0} ready recipes, ${recipes.needs_attention ?? 0} needing attention, ${recipes.unavailable ?? 0} unavailable, and ${recipes.incomplete_setup ?? 0} incomplete setup records.`,
      evidence: [
        { label: "Ready", value: recipes.ready ?? 0 },
        { label: "Needs attention", value: recipes.needs_attention ?? 0 },
        { label: "Unavailable", value: recipes.unavailable ?? 0 },
        { label: "Incomplete setup", value: recipes.incomplete_setup ?? 0 },
      ],
      limitations: ["Recipe reports do not edit recipes or ingredients.", "Menu-engineering classifications require sales mapping and complete recipe costing."],
    };
  }

  if (/purchase|supplier|spend|order/.test(lower)) {
    return {
      answer: `For ${period}, the connected purchasing evidence shows ${formatIsk(purchasing.spend)} in costed inventory movements across ${purchasing.movement_count ?? 0} movement records. Purchase-order reports remain unavailable until a PO source is connected.`,
      evidence: [
        { label: "Purchasing spend", value: purchasing.spend ?? 0, unit: "ISK" },
        { label: "Movement count", value: purchasing.movement_count ?? 0 },
        { label: "Open purchase orders", value: "not connected" },
      ],
      limitations: ["This is not a purchase-order ledger.", "Supplier ranking is not produced without enough evidence and a defined method."],
    };
  }

  if (/operation|checklist|temperature|clean/.test(lower)) {
    return {
      answer: `For ${period}, ${operations.completed_routines ?? 0} of ${operations.routine_count ?? 0} scheduled routines are complete. Temperature logs recorded: ${operations.temperature_logs ?? 0}; out of range: ${operations.temperature_out_of_range ?? 0}.`,
      evidence: [
        { label: "Routine completion", value: operations.completion_percent ?? "no data", unit: "%" },
        { label: "Overdue routines", value: operations.overdue_routines ?? 0 },
        { label: "Temperature logs", value: operations.temperature_logs ?? 0 },
      ],
      limitations: ["Reports cannot mark checklist steps complete; users must return to Operations to change records."],
    };
  }

  const first = attention[0];
  return {
    answer: first
      ? `For ${period}, the first attention item is: ${first.title}. ${first.detail}`
      : `For ${period}, Atlas did not find a high-priority attention item in the current Reports snapshot.`,
    evidence: attention.slice(0, 5).map((item: any) => ({ label: item.title, value: item.section, note: item.detail })),
    limitations: ["This answer is a report summary, not an autonomous business decision.", "Causes are not invented when evidence is insufficient."],
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireActiveProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";

    if (request.method === "GET") {
      if (action !== "snapshot") throw new ApiError(404, "Unknown Reports action.");
      return jsonResponse(await snapshot(context, url));
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);

    if (action === "ask") {
      const payload = await snapshot(context, url);
      const question = String(body.question || "").trim();
      if (!question) throw new ApiError(400, "Ask Atlas needs a report question.");
      const answer = deterministicReportAnswer(question.slice(0, 500), payload.workspace);
      return jsonResponse({ ...answer, workspace: payload.workspace, staff: payload.staff });
    }

    throw new ApiError(404, "Unknown Reports action.");
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Reports API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Reports service is temporarily unavailable." }, 500);
  }
});
