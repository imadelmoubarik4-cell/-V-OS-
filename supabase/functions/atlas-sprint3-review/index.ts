import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// This branch function deliberately uses custom authentication because Atlas users
// sign in against the production VÁ project while review rows live on the isolated
// Sprint 3 branch. The incoming production access token is verified against the
// production Auth API, then the caller's active manager/admin profile is confirmed.
const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store",
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ManagerContext = {
  user: { id: string; email?: string | null };
  profile: { id: string; email?: string | null; role: string; active: boolean };
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.");
  return match[1];
}

async function requireManager(request: Request): Promise<ManagerContext> {
  const token = bearerToken(request);
  const authHeaders = {
    apikey: AUTH_PUBLISHABLE_KEY,
    authorization: `Bearer ${token}`,
    "cache-control": "no-store",
  };

  const userResponse = await fetch(`${AUTH_PROJECT_URL}/auth/v1/user`, {
    headers: authHeaders,
  });
  if (!userResponse.ok) throw new ApiError(401, "Your Atlas session has expired.");
  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.");

  const profileResponse = await fetch(
    `${AUTH_PROJECT_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,role,active`,
    { headers: { ...authHeaders, accept: "application/json" } },
  );
  if (!profileResponse.ok) throw new ApiError(403, "Your Atlas role could not be verified.");
  const profiles = await profileResponse.json() as Array<{
    id: string;
    email?: string | null;
    role: string;
    active: boolean;
  }>;
  const profile = profiles[0];
  if (!profile?.active) throw new ApiError(403, "This Atlas profile is inactive.");
  if (profile.role !== "admin" && profile.role !== "manager") {
    throw new ApiError(403, "Sprint 3 review access is limited to managers and administrators.");
  }

  return {
    user: { id: user.id, email: user.email },
    profile,
  };
}

async function branchRpc(name: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const branchUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "Sprint 3 branch credentials are unavailable.");
  }

  const response = await fetch(`${branchUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
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
      : "Sprint 3 database request failed.";
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

function uuid(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new ApiError(400, `${field} must be a valid UUID.`);
  }
  return text;
}

function optionalText(value: unknown, max = 2000): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

async function handleGet(url: URL): Promise<unknown> {
  const action = url.searchParams.get("action") ?? "summary";
  if (action === "summary") {
    return branchRpc("atlas_sprint3_review_summary");
  }
  if (action === "rows") {
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const rawOffset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50, 1), 100);
    const offset = Math.max(Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0, 0);
    return branchRpc("atlas_sprint3_review_rows", {
      p_scope: optionalText(url.searchParams.get("scope"), 40),
      p_status: optionalText(url.searchParams.get("status"), 20) ?? "pending",
      p_query: optionalText(url.searchParams.get("q"), 160),
      p_limit: limit,
      p_offset: offset,
    });
  }
  if (action === "detail") {
    return branchRpc("atlas_sprint3_review_detail", {
      p_row_kind: optionalText(url.searchParams.get("row_kind"), 20),
      p_row_id: uuid(url.searchParams.get("row_id"), "row_id"),
    });
  }
  throw new ApiError(404, "Unknown Sprint 3 review action.");
}

async function handleDecision(request: Request, context: ManagerContext): Promise<unknown> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Decision payload must be valid JSON.");
  }

  const rowKind = optionalText(body.row_kind, 20);
  const decision = optionalText(body.decision, 20);
  if (rowKind !== "inventory" && rowKind !== "entity") {
    throw new ApiError(400, "row_kind must be inventory or entity.");
  }
  if (!decision || !["approve", "reject", "reset"].includes(decision)) {
    throw new ApiError(400, "decision must be approve, reject, or reset.");
  }

  const rowId = uuid(body.row_id, "row_id");
  const reviewerLabel = context.profile.email ?? context.user.email ?? context.user.id;
  let result: unknown;

  if (rowKind === "inventory") {
    result = await branchRpc("atlas_sprint3_review_decide_inventory", {
      p_row_id: rowId,
      p_decision: decision,
      p_action: optionalText(body.action, 20),
      p_matched_item_id: optionalText(body.matched_id, 160),
      p_notes: optionalText(body.notes, 2000),
      p_decided_by: context.user.id,
      p_decided_by_label: reviewerLabel,
    });
  } else {
    result = await branchRpc("atlas_sprint3_review_decide_entity", {
      p_row_id: rowId,
      p_decision: decision,
      p_action: optionalText(body.action, 20),
      p_matched_entity_type: optionalText(body.matched_entity_type, 80),
      p_matched_entity_id: optionalText(body.matched_id, 160),
      p_notes: optionalText(body.notes, 2000),
      p_decided_by: context.user.id,
      p_decided_by_label: reviewerLabel,
    });
  }

  const detail = await branchRpc("atlas_sprint3_review_detail", {
    p_row_kind: rowKind,
    p_row_id: rowId,
  });
  return { result, detail };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireManager(request);
    const url = new URL(request.url);
    if (request.method === "GET") return jsonResponse(await handleGet(url));
    if (request.method === "POST" && (url.searchParams.get("action") ?? "decision") === "decision") {
      return jsonResponse(await handleDecision(request, context));
    }
    throw new ApiError(405, "Method not allowed.");
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Sprint 3 review API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "Sprint 3 review is temporarily unavailable." }, 500);
  }
});
