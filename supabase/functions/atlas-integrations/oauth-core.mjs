// Pure OAuth/crypto helpers for the atlas-integrations Edge Function.
// No Deno or Node specific APIs: WebCrypto (globalThis.crypto) only, so the
// same module runs in the Edge runtime and in the Node test runner.
//
// Nothing in this module reads environment variables or talks to the network.

// S94B: the AES-256-GCM helpers, hex/base64 helpers and provider-error
// sanitising live in ../_shared/integrations/crypto.mjs (shared with the
// publishing credential module) and are re-exported here unchanged.
import {
  AES_KEY_BYTES,
  AES_NONCE_BYTES,
  base64Decode,
  bytesToHex,
  credentialAad,
  decryptJson,
  encryptJson,
  hexToBytes,
  importAesKey,
  parseKeyMaterial,
  randomBytes,
  resourceCredentialAad,
  sanitizeProviderError,
} from "../_shared/integrations/crypto.mjs";

export {
  AES_KEY_BYTES,
  AES_NONCE_BYTES,
  base64Decode,
  bytesToHex,
  credentialAad,
  decryptJson,
  encryptJson,
  hexToBytes,
  importAesKey,
  parseKeyMaterial,
  randomBytes,
  resourceCredentialAad,
  sanitizeProviderError,
};

const encoder = new TextEncoder();

export const STATE_BYTES = 32;
export const PKCE_VERIFIER_BYTES = 48; // 64 base64url characters (RFC 7636: 43-128)
export const STATE_TTL_SECONDS = 600;

function subtle() {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WebCrypto is unavailable.");
  return value;
}

export function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("Invalid base64url value.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256Bytes(text) {
  return new Uint8Array(await subtle().digest("SHA-256", encoder.encode(String(text))));
}

// ---------------------------------------------------------------- PKCE (RFC 7636)

export function createPkceVerifier() {
  return base64UrlEncode(randomBytes(PKCE_VERIFIER_BYTES));
}

export function isValidPkceVerifier(verifier) {
  return typeof verifier === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
}

export async function pkceChallengeS256(verifier) {
  if (!isValidPkceVerifier(verifier)) throw new Error("PKCE verifier must be 43-128 unreserved characters.");
  return base64UrlEncode(await sha256Bytes(verifier));
}

export async function createPkcePair() {
  const verifier = createPkceVerifier();
  return { verifier, challenge: await pkceChallengeS256(verifier), method: "S256" };
}

// ---------------------------------------------------------------- OAuth state

// The raw state travels only through the provider redirect. The database keeps
// sha256(state) so a database read cannot be replayed as a callback.
export function createOAuthState() {
  return base64UrlEncode(randomBytes(STATE_BYTES));
}

export function isWellFormedState(state) {
  return typeof state === "string" && /^[A-Za-z0-9_-]{43}$/.test(state);
}

export async function hashState(state) {
  if (!isWellFormedState(state)) throw new Error("OAuth state is malformed.");
  return bytesToHex(await sha256Bytes(state));
}

// Reference model of the single-use rule enforced by
// atlas_private.integration_consume_state(): a state is accepted once, for the
// provider it was issued for, before it expires.
export function createStateLedger(now = () => Date.now()) {
  const rows = new Map();
  return {
    issue(stateHash, providerKey, ttlSeconds = STATE_TTL_SECONDS) {
      rows.set(stateHash, { providerKey, expiresAt: now() + ttlSeconds * 1000, consumedAt: null });
    },
    consume(stateHash, providerKey) {
      const row = rows.get(stateHash);
      if (!row || row.consumedAt !== null || row.expiresAt <= now() || row.providerKey !== providerKey) {
        return null;
      }
      row.consumedAt = now();
      return { providerKey: row.providerKey };
    },
    storedKeys() {
      return [...rows.keys()];
    },
  };
}

// AES-256-GCM: see ../_shared/integrations/crypto.mjs (re-exported above).

// ---------------------------------------------------------------- redirect + return allow-lists

export const CALLBACK_PATH_PREFIX = "/functions/v1/atlas-integrations/callback/";
export const AUTHORIZE_PATH_PREFIX = "/functions/v1/atlas-integrations/authorize/";

// The redirect URI registered with each provider. Exact string, no query, no
// fragment, https only, host must be allow-listed. Google and Meta compare it
// byte-for-byte with the registered value.
export function buildRedirectUri(publicBaseUrl, providerKey, allowedHosts) {
  let base;
  try {
    base = new URL(String(publicBaseUrl ?? ""));
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return null;
  if (base.pathname !== "/" && base.pathname !== "") return null;
  if (!isAllowedHost(base.hostname, allowedHosts)) return null;
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(String(providerKey ?? ""))) return null;
  return `https://${base.host}${CALLBACK_PATH_PREFIX}${providerKey}`;
}

// The Atlas authorize hop on the same host as the callback. `start` returns
// this URL; the browser opens it (top-level navigation on the functions
// domain), which binds the state to that browser with a first-party cookie
// and then redirects to the provider. S88 hardening F10.
export function buildAuthorizeHopUrl(redirectUri, providerKey, state, codeChallenge) {
  if (!redirectUri || !redirectUri.includes(CALLBACK_PATH_PREFIX)) return null;
  const url = new URL(redirectUri.replace(CALLBACK_PATH_PREFIX, AUTHORIZE_PATH_PREFIX));
  if (!url.pathname.endsWith(`/${providerKey}`)) return null;
  url.searchParams.set("state", state);
  if (codeChallenge) url.searchParams.set("cc", codeChallenge);
  return url.toString();
}

export function isWellFormedChallenge(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

// Browser binding: a random nonce in an httpOnly, Secure, SameSite=Lax,
// __Host- cookie on the functions domain; the database keeps only sha256.
// SameSite=Lax is sent on the provider's top-level redirect back to the
// callback and never on cross-site subresource requests.
export const BINDING_COOKIE_PREFIX = "__Host-atlas-oauth-";

export function bindingCookieName(providerKey) {
  return `${BINDING_COOKIE_PREFIX}${String(providerKey ?? "").replace(/[^a-z0-9-]/g, "")}`;
}

export function bindingSetCookie(providerKey, nonce, maxAgeSeconds = STATE_TTL_SECONDS) {
  return `${bindingCookieName(providerKey)}=${nonce}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

export function bindingClearCookie(providerKey) {
  return `${bindingCookieName(providerKey)}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function isAllowedHost(hostname, allowedHosts) {
  const host = String(hostname ?? "").toLowerCase();
  if (!host) return false;
  return (allowedHosts ?? []).some((entry) => {
    const rule = String(entry ?? "").trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length && !host.slice(0, -suffix.length).includes(".");
    }
    return host === rule;
  });
}

export function isAllowedRedirectUri(candidate, publicBaseUrl, providerKey, allowedHosts) {
  const expected = buildRedirectUri(publicBaseUrl, providerKey, allowedHosts);
  return expected !== null && candidate === expected;
}

// Where the browser lands after the callback: an allow-listed https app origin
// plus an Atlas hash route. Never a caller-supplied absolute URL.
export function parseAllowedOrigins(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        const url = new URL(entry);
        if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username) return null;
        return url.origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function normalizeReturnPath(value) {
  const path = String(value ?? "").trim() || "#settings";
  return /^#[a-z][a-z0-9-]{0,40}(?:\/[a-z0-9-]{1,40}){0,3}$/.test(path) ? path : null;
}

export function buildReturnUrl(appOrigin, returnPath, providerKey, result, reason = null) {
  const path = normalizeReturnPath(returnPath) ?? "#settings";
  const params = { integration: providerKey, result };
  if (reason) params.reason = reason;
  const query = new URLSearchParams(params).toString();
  return `${appOrigin}/?${query}${path}`;
}

// ---------------------------------------------------------------- output hygiene

export const SECRET_KEY_PATTERN =
  /^(access[_-]?token|refresh[_-]?token|id[_-]?token|token|tokens|token[_-]?set|code|code[_-]?verifier|verifier|client[_-]?secret|app[_-]?secret|api[_-]?key|secret|password|ciphertext|nonce|verifier[_-]?ciphertext|verifier[_-]?nonce|state|state[_-]?hash|kek|key[_-]?material|authorization)$/i;

export function findSecretKeys(value, path = "$") {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => hits.push(...findSecretKeys(entry, `${path}[${index}]`)));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) hits.push(`${path}.${key}`);
      hits.push(...findSecretKeys(child, `${path}.${key}`));
    }
  }
  return hits;
}
