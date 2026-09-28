// S96 (edgea): pure checks for atlas-notifications (unit-tested in Node by
// tests/node/s96-notifications-push-policy.test.js).
//
// pushEndpointAllowed: a browser push subscription endpoint is stored by any
// active staff member and later POSTed to by the dispatcher (web-push). Only
// the browser vendors' push services are accepted, so a stored endpoint can
// never point the dispatcher at an internal or arbitrary host (SSRF).
//
// dispatchTokenMatches: the dispatch token is compared in constant time over
// SHA-256 digests and must be at least 32 bytes when configured.

const PUSH_HOSTS = Object.freeze([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "web.push.apple.com",
]);
const PUSH_HOST_SUFFIXES = Object.freeze([".notify.windows.com", ".push.apple.com"]);

export function pushEndpointAllowed(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text ?? ""))));
}

export async function dispatchTokenMatches(provided, expected) {
  if (typeof expected !== "string" || new TextEncoder().encode(expected).length < 32) return false;
  if (typeof provided !== "string" || !provided) return false;
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}
