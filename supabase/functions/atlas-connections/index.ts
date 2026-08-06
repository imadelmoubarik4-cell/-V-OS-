import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AUTH_PROJECT_URL = Deno.env.get("ATLAS_AUTH_PROJECT_URL")
  ?? "https://dnefgcmjcgxlynycxkts.supabase.co";
const AUTH_PUBLISHABLE_KEY = Deno.env.get("ATLAS_AUTH_PUBLISHABLE_KEY")
  ?? "sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp";
const FUNCTION_VERSION = "0.1.0";
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_GITHUB_REPOSITORY = "imadelmoubarik4-cell/-V-OS-";
const DEFAULT_GITHUB_BRANCH = "agent/phase2-connection-center-p2-0";
const CHECK_TIMEOUT_MS = 8000;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-atlas-request-id",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

const PROFILE_ROLES = new Set(["admin", "manager", "bartender", "viewer"]);
const MANAGER_ROLES = new Set(["admin", "manager"]);
const CONNECTION_STATES = new Set([
  "not_configured", "authorization_required", "verifying", "healthy",
  "degraded", "expired", "blocked", "intentionally_disabled",
]);
const GRANT_STATES = new Set([
  "not_requested", "verification_required", "read_only", "granted",
  "denied", "blocked", "not_supported",
]);
const CAPABILITY_KINDS = new Set(["read", "write", "publish", "admin"]);
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

const SAFE_ERROR_CODES = {
  authentication_expired: "AUTHENTICATION_EXPIRED",
  permission_denied: "PERMISSION_DENIED",
  provider_rate_limited: "PROVIDER_RATE_LIMITED",
  provider_unavailable: "PROVIDER_UNAVAILABLE",
  connection_timeout: "CONNECTION_TIMEOUT",
  invalid_provider_response: "INVALID_PROVIDER_RESPONSE",
  configuration_missing: "CONFIGURATION_MISSING",
  environment_mismatch: "ENVIRONMENT_MISMATCH",
  unsupported_check: "UNSUPPORTED_CHECK",
  connection_blocked: "CONNECTION_BLOCKED",
};

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

type ConnectionRecord = {
  connection_key: string;
  label: string;
  state: string;
  configured_state: string;
  check_strategy: string;
  requirements?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type CheckResult = {
  outcome: "passed" | "failed" | "skipped";
  state: string;
  latencyMs: number | null;
  errorCode: string | null;
  summary: string;
  evidence: Record<string, unknown>;
};

class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = "REQUEST_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requestId(request: Request): string {
  const supplied = request.headers.get("x-atlas-request-id")?.trim();
  if (supplied && /^[0-9a-f-]{36}$/i.test(supplied)) return supplied;
  return crypto.randomUUID();
}

function jsonResponse(result: unknown, status = 200, id = crypto.randomUUID()): Response {
  return new Response(JSON.stringify({
    connection: {
      provider: "atlas-connections",
      state: status < 500 ? "healthy" : "degraded",
      checked_at: new Date().toISOString(),
      version: FUNCTION_VERSION,
    },
    result,
    request_id: id,
  }), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-connections-version": FUNCTION_VERSION,
      "x-atlas-request-id": id,
    },
  });
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ApiError(401, "A valid Atlas session is required.", "AUTHENTICATION_REQUIRED");
  return match[1];
}

function profileLabel(profile: Partial<AtlasProfile> | null | undefined): string {
  return profile?.display_name?.trim()
    || profile?.email?.trim()
    || "Atlas team member";
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
  if (!userResponse.ok) {
    throw new ApiError(401, "Your Atlas session has expired.", SAFE_ERROR_CODES.authentication_expired);
  }
  const user = await userResponse.json() as { id?: string; email?: string | null };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.", SAFE_ERROR_CODES.authentication_expired);

  const profileUrl = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${user.id}`);
  profileUrl.searchParams.set("select", "id,email,display_name,role,active");
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, { headers });
  if (!profileResponse.ok) {
    throw new ApiError(403, "Your Atlas staff profile could not be verified.", SAFE_ERROR_CODES.permission_denied);
  }

  const profiles = await profileResponse.json() as AtlasProfile[];
  const profile = profiles[0];
  if (!profile?.active || !PROFILE_ROLES.has(profile.role)) {
    throw new ApiError(403, "This Atlas profile cannot access Connection Center.", SAFE_ERROR_CODES.permission_denied);
  }

  return { token, user: { id: user.id, email: user.email }, profile };
}

function requireManager(context: AtlasContext): void {
  if (!MANAGER_ROLES.has(context.profile.role)) {
    throw new ApiError(403, "Connection checks and capability review are limited to managers.", SAFE_ERROR_CODES.permission_denied);
  }
}

function branchCredentials() {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "The private Connection Center service is unavailable.", "PRIVATE_SERVICE_UNAVAILABLE");
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
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!response.ok) {
    console.error("Connection Center RPC failed", name, response.status);
    throw new ApiError(500, "The private Connection Center request failed.", "PRIVATE_RPC_FAILED");
  }
  return parsed;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.", "REQUEST_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "Request body is too large.", "REQUEST_TOO_LARGE");
  }
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.", "INVALID_JSON");
  }
}

function stringValue(value: unknown, label: string, maxLength: number, required = true): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw new ApiError(400, `${label} is required.`, "VALIDATION_FAILED");
    return null;
  }
  if (typeof value !== "string") throw new ApiError(400, `${label} must be text.`, "VALIDATION_FAILED");
  const normalized = value.trim();
  if (!normalized && required) throw new ApiError(400, `${label} is required.`, "VALIDATION_FAILED");
  if (normalized.length > maxLength) throw new ApiError(400, `${label} is too long.`, "VALIDATION_FAILED");
  return normalized || null;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ApiError(400, `${label} must be true or false.`, "VALIDATION_FAILED");
  return value;
}

function uuidValue(value: unknown, label: string, required = true): string | null {
  const normalized = stringValue(value, label, 36, required);
  if (normalized === null) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new ApiError(400, `${label} is invalid.`, "VALIDATION_FAILED");
  }
  return normalized;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `${label} must be an object.`, "VALIDATION_FAILED");
  }
  return value as Record<string, unknown>;
}

function enumValue(value: unknown, label: string, allowed: Set<string>): string {
  const normalized = stringValue(value, label, 120, true)!.toLowerCase();
  if (!allowed.has(normalized)) throw new ApiError(400, `${label} is invalid.`, "VALIDATION_FAILED");
  return normalized;
}

function enumErrorCode(value: unknown): string {
  const normalized = stringValue(value, "Error code", 80, true)!.toUpperCase();
  if (!/^[A-Z0-9_]{3,80}$/.test(normalized)) {
    throw new ApiError(400, "Error code is invalid.", "VALIDATION_FAILED");
  }
  return normalized;
}

function safeEvidence(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(password|secret|token|api[_ -]?key|service[_ -]?role|credential)/i.test(key)) continue;
    if (child === null || ["string", "number", "boolean"].includes(typeof child)) {
      result[key] = typeof child === "string" ? child.slice(0, 500) : child;
    }
  }
  return result;
}

async function snapshot(context: AtlasContext, historyLimit = 80) {
  return await branchRpc("atlas_connections_snapshot", {
    p_actor_id: context.user.id,
    p_actor_role: context.profile.role,
    p_history_limit: historyLimit,
  });
}

function findConnection(workspace: any, connectionKey: string): ConnectionRecord {
  const rows = Array.isArray(workspace?.connections) ? workspace.connections : [];
  const connection = rows.find((row: ConnectionRecord) => row.connection_key === connectionKey);
  if (!connection) throw new ApiError(404, "Connection is not registered.", SAFE_ERROR_CODES.configuration_missing);
  return connection;
}

async function beginCheck(
  context: AtlasContext,
  connectionKey: string,
  id: string,
  checkKind: string,
  triggerSource = "manager",
) {
  return await branchRpc("atlas_connections_begin_check", {
    p_connection_key: connectionKey,
    p_request_id: id,
    p_check_kind: checkKind,
    p_trigger_source: triggerSource,
    p_actor_id: context.user.id,
    p_actor_label: profileLabel(context.profile),
    p_actor_role: context.profile.role,
  });
}

async function finishCheck(
  context: AtlasContext,
  checkId: string,
  result: CheckResult,
) {
  return await branchRpc("atlas_connections_finish_check", {
    p_check_id: checkId,
    p_result_state: result.state,
    p_outcome: result.outcome,
    p_latency_ms: result.latencyMs,
    p_error_code: result.errorCode,
    p_summary: result.summary,
    p_evidence: safeEvidence(result.evidence),
    p_actor_id: context.user.id,
    p_actor_label: profileLabel(context.profile),
    p_actor_role: context.profile.role,
  });
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = CHECK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    return { response, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(504, "The provider did not respond before the timeout.", SAFE_ERROR_CODES.connection_timeout);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function failedResult(error: unknown): CheckResult {
  if (error instanceof ApiError) {
    const state = error.code === SAFE_ERROR_CODES.authentication_expired ? "expired"
      : error.code === SAFE_ERROR_CODES.permission_denied ? "blocked"
      : "degraded";
    return {
      outcome: "failed",
      state,
      latencyMs: null,
      errorCode: error.code,
      summary: error.message,
      evidence: {},
    };
  }
  console.error("Connection check failed", error instanceof Error ? error.message : "unknown");
  return {
    outcome: "failed",
    state: "degraded",
    latencyMs: null,
    errorCode: SAFE_ERROR_CODES.provider_unavailable,
    summary: "The provider could not be verified.",
    evidence: {},
  };
}

function responseFailure(response: Response, providerLabel: string): ApiError {
  if (response.status === 401) {
    return new ApiError(401, `${providerLabel} authorization has expired.`, SAFE_ERROR_CODES.authentication_expired);
  }
  if (response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      return new ApiError(429, `${providerLabel} rate limit was reached.`, SAFE_ERROR_CODES.provider_rate_limited);
    }
    return new ApiError(403, `${providerLabel} denied the required permission.`, SAFE_ERROR_CODES.permission_denied);
  }
  if (response.status === 404) {
    return new ApiError(404, `${providerLabel} configuration could not be found.`, SAFE_ERROR_CODES.configuration_missing);
  }
  if (response.status === 429) {
    return new ApiError(429, `${providerLabel} rate limit was reached.`, SAFE_ERROR_CODES.provider_rate_limited);
  }
  if (response.status >= 500) {
    return new ApiError(503, `${providerLabel} is temporarily unavailable.`, SAFE_ERROR_CODES.provider_unavailable);
  }
  return new ApiError(502, `${providerLabel} returned an unexpected response.`, SAFE_ERROR_CODES.invalid_provider_response);
}

async function checkProductionAuth(context: AtlasContext): Promise<CheckResult> {
  const { response, latencyMs } = await fetchWithTimeout(`${AUTH_PROJECT_URL}/auth/v1/user`, {
    headers: {
      apikey: AUTH_PUBLISHABLE_KEY,
      authorization: `Bearer ${context.token}`,
      accept: "application/json",
    },
  });
  if (!response.ok) throw responseFailure(response, "Production Auth");
  const user = await response.json() as { id?: string };
  if (user.id !== context.user.id) {
    throw new ApiError(502, "Production Auth returned an invalid user context.", SAFE_ERROR_CODES.invalid_provider_response);
  }
  return {
    outcome: "passed",
    state: "healthy",
    latencyMs,
    errorCode: null,
    summary: "Production Auth verified the active Atlas session.",
    evidence: { response_status: response.status, user_context_verified: true },
  };
}

async function checkProductionData(context: AtlasContext): Promise<CheckResult> {
  const url = new URL(`${AUTH_PROJECT_URL}/rest/v1/profiles`);
  url.searchParams.set("id", `eq.${context.user.id}`);
  url.searchParams.set("select", "id,role,active");
  url.searchParams.set("limit", "1");
  const { response, latencyMs } = await fetchWithTimeout(url.toString(), {
    headers: {
      apikey: AUTH_PUBLISHABLE_KEY,
      authorization: `Bearer ${context.token}`,
      accept: "application/json",
    },
  });
  if (!response.ok) throw responseFailure(response, "Production Data API");
  const rows = await response.json() as Array<{ id?: string; active?: boolean }>;
  if (!Array.isArray(rows) || rows[0]?.id !== context.user.id || rows[0]?.active !== true) {
    throw new ApiError(403, "Production Data API did not return the active profile.", SAFE_ERROR_CODES.permission_denied);
  }
  return {
    outcome: "passed",
    state: "healthy",
    latencyMs,
    errorCode: null,
    summary: "Production Data API verified the active profile through RLS.",
    evidence: { response_status: response.status, profile_rows: rows.length, rls_path: true },
  };
}

async function checkBranchDatabase(): Promise<CheckResult> {
  const startedAt = performance.now();
  const ping = await branchRpc("atlas_connections_ping", {});
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (ping?.version !== "atlas-connections/0.1.0") {
    throw new ApiError(502, "Atlas private database returned an unexpected contract.", SAFE_ERROR_CODES.invalid_provider_response);
  }
  return {
    outcome: "passed",
    state: "healthy",
    latencyMs,
    errorCode: null,
    summary: "Atlas private database RPC contract verified.",
    evidence: { registry_rows: Number(ping.registry_rows || 0), contract_version: String(ping.version) },
  };
}

async function checkEdgeRuntime(): Promise<CheckResult> {
  return {
    outcome: "passed",
    state: "healthy",
    latencyMs: 0,
    errorCode: null,
    summary: "The authenticated Connection Center gateway is executing normally.",
    evidence: { function_version: FUNCTION_VERSION, custom_profile_authorization: true },
  };
}

async function checkBranchStorage(): Promise<CheckResult> {
  const { branchUrl, serviceRoleKey } = branchCredentials();
  const { response, latencyMs } = await fetchWithTimeout(`${branchUrl}/storage/v1/bucket/atlas-profile-photos`, {
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
    },
  });
  if (!response.ok) throw responseFailure(response, "Atlas private Storage");
  const bucket = await response.json() as { id?: string; public?: boolean };
  if (bucket.id !== "atlas-profile-photos" || bucket.public !== false) {
    throw new ApiError(502, "Atlas profile-photo bucket is not verified private.", SAFE_ERROR_CODES.invalid_provider_response);
  }
  return {
    outcome: "passed",
    state: "healthy",
    latencyMs,
    errorCode: null,
    summary: "Private profile-photo Storage bucket verified.",
    evidence: { bucket_present: true, bucket_private: true, response_status: response.status },
  };
}

async function checkGitHub(connection: ConnectionRecord): Promise<CheckResult> {
  const requirements = connection.requirements || {};
  const repository = typeof requirements.repository === "string"
    ? requirements.repository
    : DEFAULT_GITHUB_REPOSITORY;
  const branch = typeof requirements.branch === "string"
    ? requirements.branch
    : DEFAULT_GITHUB_BRANCH;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new ApiError(400, "GitHub repository configuration is invalid.", SAFE_ERROR_CODES.configuration_missing);
  }
  const url = `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}`;
  const { response, latencyMs } = await fetchWithTimeout(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "va-atlas-connection-center",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw responseFailure(response, "GitHub");
  const commit = await response.json() as { sha?: string };
  if (!commit.sha || !/^[0-9a-f]{40}$/i.test(commit.sha)) {
    throw new ApiError(502, "GitHub returned an invalid commit response.", SAFE_ERROR_CODES.invalid_provider_response);
  }
  return {
    outcome: "passed",
    state: "healthy",
    latencyMs,
    errorCode: null,
    summary: "GitHub branch metadata verified through the public read API.",
    evidence: { repository, branch, commit_sha: commit.sha.slice(0, 12), response_status: response.status },
  };
}

function validatedNetlifyOrigin(value: unknown): string {
  const configured = typeof value === "string" && value.trim()
    ? value.trim()
    : (Deno.env.get("ATLAS_NETLIFY_SITE_URL") ?? "https://os-vabar.netlify.app");
  let url: URL;
  try { url = new URL(configured); }
  catch { throw new ApiError(400, "Netlify site URL is invalid.", SAFE_ERROR_CODES.configuration_missing); }
  const allowed = url.protocol === "https:"
    && (url.hostname === "os-vabar.netlify.app"
      || /^deploy-preview-\d+--os-vabar\.netlify\.app$/.test(url.hostname));
  if (!allowed) throw new ApiError(400, "Netlify environment does not match the approved Atlas site.", SAFE_ERROR_CODES.environment_mismatch);
  return url.origin;
}

async function checkNetlify(clientOrigin: unknown): Promise<CheckResult> {
  const origin = validatedNetlifyOrigin(clientOrigin);
  const { response, latencyMs } = await fetchWithTimeout(origin, {
    method: "GET",
    headers: { accept: "text/html" },
    redirect: "follow",
  });
  if (!response.ok) throw responseFailure(response, "Netlify");
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new ApiError(502, "Netlify returned an unexpected content type.", SAFE_ERROR_CODES.invalid_provider_response);
  }
  return {
    outcome: "passed",
    state: "healthy",
    latencyMs,
    errorCode: null,
    summary: "Approved Atlas Netlify site responded successfully.",
    evidence: { hostname: new URL(origin).hostname, response_status: response.status, html_response: true },
  };
}

function skippedResult(connection: ConnectionRecord): CheckResult {
  const disabled = connection.check_strategy === "disabled" || connection.state === "intentionally_disabled";
  return {
    outcome: "skipped",
    state: disabled ? "intentionally_disabled" : connection.state,
    latencyMs: null,
    errorCode: disabled ? null : SAFE_ERROR_CODES.unsupported_check,
    summary: disabled
      ? "Connection is intentionally disabled by policy."
      : "This connection requires manual authorization or evidence.",
    evidence: { automated_check_supported: false },
  };
}

async function executeStrategy(
  context: AtlasContext,
  connection: ConnectionRecord,
  options: { clientOrigin?: unknown } = {},
): Promise<CheckResult> {
  switch (connection.check_strategy) {
    case "production_auth": return await checkProductionAuth(context);
    case "production_data": return await checkProductionData(context);
    case "branch_rpc": return await checkBranchDatabase();
    case "edge_runtime": return await checkEdgeRuntime();
    case "branch_storage": return await checkBranchStorage();
    case "github_public": return await checkGitHub(connection);
    case "netlify_public": return await checkNetlify(options.clientOrigin);
    case "manual":
    case "aggregate":
    case "disabled":
      return skippedResult(connection);
    default:
      throw new ApiError(400, "Connection check strategy is unsupported.", SAFE_ERROR_CODES.unsupported_check);
  }
}

async function runConnectionCheck(
  context: AtlasContext,
  connectionKey: string,
  id: string,
  options: { clientOrigin?: unknown; triggerSource?: string; includeWorkspace?: boolean } = {},
) {
  requireManager(context);
  const workspace = await snapshot(context, 0);
  const connection = findConnection(workspace, connectionKey);
  const checkKind = connection.check_strategy === "edge_runtime" ? "synthetic"
    : connection.check_strategy === "manual" ? "manual"
    : "automated";
  const started = await beginCheck(
    context,
    connectionKey,
    id,
    checkKind,
    options.triggerSource || "manager",
  );
  const checkId = uuidValue(started?.id, "Connection check")!;

  let result: CheckResult;
  try { result = await executeStrategy(context, connection, options); }
  catch (error) { result = failedResult(error); }

  const finished = await finishCheck(context, checkId, result);
  return {
    check: finished,
    outcome: result,
    ...(options.includeWorkspace === false ? {} : { workspace: await snapshot(context, 100) }),
  };
}

async function runManualCheck(
  context: AtlasContext,
  body: Record<string, unknown>,
  id: string,
) {
  requireManager(context);
  const connectionKey = stringValue(body.connection_key, "Connection", 120, true)!;
  const workspace = await snapshot(context, 0);
  const connection = findConnection(workspace, connectionKey);
  if (connection.check_strategy !== "manual") {
    throw new ApiError(400, "This connection does not use manual verification.", "VALIDATION_FAILED");
  }

  const evidence = objectValue(body.evidence ?? {}, "Manual evidence");
  const invitationDelivered = evidence.invitation_delivered === true;
  const passwordResetDelivered = evidence.password_reset_delivered === true;
  const requestedState = enumValue(body.state ?? "verifying", "Connection state", CONNECTION_STATES);
  let result: CheckResult;

  if (requestedState === "healthy" && connectionKey !== "custom-smtp") {
    throw new ApiError(
      400,
      "This connection does not yet have an approved manual healthy-verification protocol.",
      "UNSUPPORTED_MANUAL_VERIFICATION",
    );
  }

  if (connectionKey === "custom-smtp" && requestedState === "healthy") {
    if (!invitationDelivered || !passwordResetDelivered) {
      throw new ApiError(
        400,
        "SMTP health requires both invitation and password-reset delivery evidence.",
        "EVIDENCE_INCOMPLETE",
      );
    }
    result = {
      outcome: "passed",
      state: "healthy",
      latencyMs: null,
      errorCode: null,
      summary: stringValue(body.summary, "Summary", 500, false)
        || "Custom SMTP invitation and password-reset delivery verified.",
      evidence: { invitation_delivered: true, password_reset_delivered: true },
    };
  } else if (["degraded", "expired", "blocked"].includes(requestedState)) {
    result = {
      outcome: "failed",
      state: requestedState,
      latencyMs: null,
      errorCode: enumErrorCode(body.error_code || SAFE_ERROR_CODES.provider_unavailable),
      summary: stringValue(body.summary, "Summary", 500, true)!,
      evidence: safeEvidence(evidence),
    };
  } else {
    result = {
      outcome: "skipped",
      state: requestedState,
      latencyMs: null,
      errorCode: null,
      summary: stringValue(body.summary, "Summary", 500, false)
        || "Manual evidence recorded; health is not yet verified.",
      evidence: safeEvidence(evidence),
    };
  }

  const started = await beginCheck(context, connectionKey, id, "manual", "manager");
  const checkId = uuidValue(started?.id, "Connection check")!;
  const finished = await finishCheck(context, checkId, result);
  return { check: finished, outcome: result, workspace: await snapshot(context, 100) };
}

async function setCapability(context: AtlasContext, body: Record<string, unknown>) {
  requireManager(context);
  const result = await branchRpc("atlas_connections_set_capability", {
    p_connection_key: stringValue(body.connection_key, "Connection", 120, true),
    p_capability_key: stringValue(body.capability_key, "Capability", 120, true),
    p_capability_kind: enumValue(body.capability_kind, "Capability kind", CAPABILITY_KINDS),
    p_grant_state: enumValue(body.grant_state, "Grant state", GRANT_STATES),
    p_risk_level: enumValue(body.risk_level, "Risk level", RISK_LEVELS),
    p_manager_approval_required: booleanValue(body.manager_approval_required, "Manager approval state"),
    p_metadata: safeEvidence(objectValue(body.metadata ?? {}, "Capability metadata")),
    p_actor_id: context.user.id,
    p_actor_label: profileLabel(context.profile),
    p_actor_role: context.profile.role,
  });
  return { capability: result, workspace: await snapshot(context, 100) };
}

Deno.serve(async (request: Request) => {
  const id = requestId(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireActiveProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";

    if (request.method === "GET") {
      if (action !== "snapshot") throw new ApiError(404, "Unknown Connection Center action.", "NOT_FOUND");
      return jsonResponse({ workspace: await snapshot(context, 100) }, 200, id);
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.", "METHOD_NOT_ALLOWED");
    const body = await readJson(request);

    if (action === "check") {
      const connectionKey = stringValue(body.connection_key, "Connection", 120, true)!;
      const operationId = uuidValue(body.request_id ?? id, "Request id")!;
      const result = await runConnectionCheck(context, connectionKey, operationId, {
        clientOrigin: body.client_origin,
      });
      return jsonResponse(result, 200, id);
    }

    if (action === "check-all") {
      requireManager(context);
      const workspace = await snapshot(context, 0);
      const connections = (Array.isArray(workspace?.connections) ? workspace.connections : [])
        .filter((entry: ConnectionRecord) => !["manual", "aggregate", "disabled"].includes(entry.check_strategy));
      const results = [];
      for (const connection of connections.slice(0, 12)) {
        results.push(await runConnectionCheck(context, connection.connection_key, crypto.randomUUID(), {
          clientOrigin: body.client_origin,
          includeWorkspace: false,
        }));
      }
      return jsonResponse({ checks: results.map((entry) => entry.outcome), workspace: await snapshot(context, 100) }, 200, id);
    }

    if (action === "manual-check") {
      const operationId = uuidValue(body.request_id ?? id, "Request id")!;
      return jsonResponse(await runManualCheck(context, body, operationId), 200, id);
    }

    if (action === "set-capability") {
      return jsonResponse(await setCapability(context, body), 200, id);
    }

    throw new ApiError(404, "Unknown Connection Center action.", "NOT_FOUND");
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse({ error: error.message, error_code: error.code }, error.status, id);
    }
    console.error("Connection Center error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({
      error: "The Connection Center service is temporarily unavailable.",
      error_code: "SERVICE_UNAVAILABLE",
    }, 500, id);
  }
});
