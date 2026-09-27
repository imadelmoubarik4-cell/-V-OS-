// S94C: shared Meta Graph helpers for the Instagram and Facebook adapters.
//
// Graph version: ATLAS_META_GRAPH_VERSION (same variable as atlas-integrations),
// default v25.0 (the S88 default; v26.0 was released 2026-07-29 and the default
// should move after its Pages/IG/Video changelog is read, report 04 §3).
// The Page/IG token is sent as `Authorization: Bearer` (never in the URL, so
// no token can reach a URL that might be logged by the runtime).

import { providerRequest } from "./classify.mjs";

export const DEFAULT_META_GRAPH_VERSION = "v25.0";

export function graphVersion(env) {
  const value = typeof env === "function" ? env("ATLAS_META_GRAPH_VERSION") : env?.ATLAS_META_GRAPH_VERSION;
  return /^v\d{1,2}\.\d$/.test(String(value ?? "")) ? String(value) : DEFAULT_META_GRAPH_VERSION;
}

export function graphUrl(ctx, path, query) {
  const url = new URL(`https://graph.facebook.com/${graphVersion(ctx.env)}/${String(path).replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.href;
}

function authHeaders(ctx) {
  return { authorization: `Bearer ${ctx.credential.access_token}`, accept: "application/json" };
}

// GET /{path}?query (idempotent read).
export function graphGet(ctx, provider, path, query, options = {}) {
  return providerRequest(ctx, provider, graphUrl(ctx, path, query), { method: "GET", headers: authHeaders(ctx) }, options);
}

// POST /{path} with a form body. Objects/arrays are JSON-encoded (attached_media).
export function graphPost(ctx, provider, path, params, options = {}) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return providerRequest(
    ctx,
    provider,
    graphUrl(ctx, path),
    { method: "POST", headers: { ...authHeaders(ctx), "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), timeoutMs: options.timeoutMs },
    options,
  );
}

export function isoOrNull(value) {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function httpsOrNull(value) {
  const text = String(value ?? "");
  if (/^https:\/\//i.test(text)) return text.slice(0, 500);
  if (text.startsWith("/")) return `https://www.facebook.com${text}`.slice(0, 500);
  return null;
}
