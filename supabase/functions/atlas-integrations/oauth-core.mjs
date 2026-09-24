// Pure OAuth/crypto helpers for the atlas-integrations Edge Function.
// No Deno or Node specific APIs: WebCrypto (globalThis.crypto) only, so the
// same module runs in the Edge runtime and in the Node test runner.
//
// Nothing in this module reads environment variables or talks to the network.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const AES_KEY_BYTES = 32;
export const AES_NONCE_BYTES = 12;
export const STATE_BYTES = 32;
export const PKCE_VERIFIER_BYTES = 48; // 64 base64url characters (RFC 7636: 43-128)
export const STATE_TTL_SECONDS = 600;

function subtle() {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WebCrypto is unavailable.");
  return value;
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
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

export function base64Decode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) {
    throw new Error("Invalid base64 value.");
  }
  const binary = atob(value.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(value) {
  const hex = String(value ?? "").replace(/^\\x/, "");
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("Invalid hex value.");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
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

// ---------------------------------------------------------------- AES-256-GCM

export function parseKeyMaterial(base64Key) {
  let bytes;
  try {
    bytes = base64Decode(String(base64Key ?? ""));
  } catch {
    throw new Error("Integration encryption key must be base64.");
  }
  if (bytes.length !== AES_KEY_BYTES) throw new Error("Integration encryption key must decode to 32 bytes.");
  return bytes;
}

export async function importAesKey(base64Key) {
  return subtle().importKey("raw", parseKeyMaterial(base64Key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function credentialAad(providerKey, purpose) {
  return `atlas-integrations|${providerKey}|${purpose}`;
}

export async function encryptJson(key, value, aad) {
  const nonce = randomBytes(AES_NONCE_BYTES);
  const ciphertext = new Uint8Array(await subtle().encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad), tagLength: 128 },
    key,
    encoder.encode(JSON.stringify(value)),
  ));
  return { ciphertextHex: bytesToHex(ciphertext), nonceHex: bytesToHex(nonce) };
}

export async function decryptJson(key, ciphertextHex, nonceHex, aad) {
  const nonce = hexToBytes(nonceHex);
  if (nonce.length !== AES_NONCE_BYTES) throw new Error("Credential nonce is invalid.");
  const plaintext = await subtle().decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad), tagLength: 128 },
    key,
    hexToBytes(ciphertextHex),
  );
  return JSON.parse(decoder.decode(plaintext));
}

// ---------------------------------------------------------------- redirect + return allow-lists

export const CALLBACK_PATH_PREFIX = "/functions/v1/atlas-integrations/callback/";

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

// Provider error bodies can echo codes or tokens. Keep a short, printable,
// token-free summary for last_connection_error and events.
export function sanitizeProviderError(value) {
  const text = String(value ?? "")
    .replace(/[A-Za-z0-9._~+/-]{24,}={0,2}/g, "[redacted]")
    .replace(/(access_token|refresh_token|code|client_secret|key)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 240) || "Provider request failed.";
}
