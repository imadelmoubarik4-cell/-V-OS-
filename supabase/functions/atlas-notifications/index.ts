import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import webpush from "npm:web-push@3.6.7";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-atlas-dispatch-token",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store",
};
const MAX_BODY_BYTES = 32 * 1024;

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json", "x-content-type-options": "nosniff" },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ApiError(503, `${name} is not configured.`);
  return value;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new ApiError(413, "Request is too large.");
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, "Request body must be valid JSON."); }
}

async function activeUser(request: Request): Promise<{ id: string }> {
  const authorization = request.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) throw new ApiError(401, "A valid Atlas session is required.");
  const project = requiredEnv("ATLAS_AUTH_PROJECT_URL");
  const key = requiredEnv("ATLAS_AUTH_PUBLISHABLE_KEY");
  const headers = { authorization, apikey: key, accept: "application/json" };
  const userResponse = await fetch(`${project}/auth/v1/user`, { headers });
  if (!userResponse.ok) throw new ApiError(401, "Your Atlas session has expired.");
  const user = await userResponse.json() as { id?: string };
  if (!user.id) throw new ApiError(401, "Your Atlas account could not be verified.");
  const profile = await fetch(`${project}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=id&limit=1`, { headers });
  if (!profile.ok || !(await profile.json() as unknown[]).length) throw new ApiError(403, "An active Atlas staff profile is required.");
  return { id: user.id };
}

async function rpc(name: string, payload: Record<string, unknown>): Promise<any> {
  const project = requiredEnv("SUPABASE_URL");
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${project}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(500, "The private notification store is unavailable.");
  return result;
}

async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function subscriptionPayload(value: unknown) {
  const candidate = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof candidate?.endpoint === "string" ? candidate.endpoint.trim() : "";
  const p256dh = typeof candidate?.keys?.p256dh === "string" ? candidate.keys.p256dh.trim() : "";
  const auth = typeof candidate?.keys?.auth === "string" ? candidate.keys.auth.trim() : "";
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ApiError(400, "Push subscription endpoint is invalid."); }
  if (url.protocol !== "https:" || !p256dh || !auth) throw new ApiError(400, "Push subscription is incomplete.");
  return { endpoint, p256dh, auth };
}

async function dispatch(request: Request): Promise<Response> {
  const enabled = Deno.env.get("ATLAS_PUSH_DELIVERY_ENABLED") === "true";
  if (!enabled) return json({ delivery: "disabled", processed: 0 });
  const expected = requiredEnv("ATLAS_PUSH_DISPATCH_TOKEN");
  if (request.headers.get("x-atlas-dispatch-token") !== expected) throw new ApiError(401, "Dispatch authorization failed.");
  webpush.setVapidDetails(requiredEnv("ATLAS_VAPID_SUBJECT"), requiredEnv("ATLAS_VAPID_PUBLIC_KEY"), requiredEnv("ATLAS_VAPID_PRIVATE_KEY"));
  const batch = await rpc("atlas_push_notification_claim", { p_limit: 50 });
  let sent = 0;
  let failed = 0;
  for (const entry of Array.isArray(batch) ? batch : []) {
    const notice = entry.notification || {};
    const subscriptions = Array.isArray(entry.subscriptions) ? entry.subscriptions : [];
    if (!subscriptions.length) {
      await rpc("atlas_push_notification_complete", { p_notification_id: notice.id, p_status: "suppressed", p_error: "No enabled subscription" });
      continue;
    }
    const results = await Promise.allSettled(subscriptions.map((subscription: any) => webpush.sendNotification({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    }, JSON.stringify({ title: notice.title, body: notice.body, route: notice.route, object_id: notice.object_id }))));
    const success = results.some((result) => result.status === "fulfilled");
    await rpc("atlas_push_notification_complete", {
      p_notification_id: notice.id,
      p_status: success ? "sent" : "failed",
      p_error: success ? null : "All subscription deliveries failed",
    });
    if (success) sent += 1; else failed += 1;
  }
  return json({ delivery: "enabled", processed: sent + failed, sent, failed });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const action = new URL(request.url).searchParams.get("action") || "configuration";
    if (action === "dispatch") return dispatch(request);
    const user = await activeUser(request);
    if (request.method === "GET" && action === "configuration") {
      return json({
        public_key: Deno.env.get("ATLAS_VAPID_PUBLIC_KEY")?.trim() || null,
        delivery_enabled: Deno.env.get("ATLAS_PUSH_DELIVERY_ENABLED") === "true",
        ...(await rpc("atlas_push_subscription_status", { p_user_id: user.id })),
      });
    }
    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const payload = await body(request);
    if (action === "subscribe") {
      const subscription = subscriptionPayload(payload.subscription);
      const id = await rpc("atlas_push_subscription_upsert", {
        p_user_id: user.id,
        p_endpoint: subscription.endpoint,
        p_endpoint_hash: await endpointHash(subscription.endpoint),
        p_p256dh: subscription.p256dh,
        p_auth_secret: subscription.auth,
        p_user_agent: request.headers.get("user-agent"),
      });
      return json({ status: "enabled", subscription_id: id });
    }
    if (action === "unsubscribe") {
      const endpoint = typeof payload.endpoint === "string" ? payload.endpoint.trim() : "";
      if (!endpoint) throw new ApiError(400, "Push endpoint is required.");
      await rpc("atlas_push_subscription_disable", { p_user_id: user.id, p_endpoint_hash: await endpointHash(endpoint) });
      return json({ status: "pending" });
    }
    throw new ApiError(404, "Unknown notification action.");
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error("Atlas notifications failed", error instanceof Error ? error.message : "unknown");
    return json({ error: "Notification service is temporarily unavailable." }, 500);
  }
});
