// Shared integration crypto and hygiene (S88 scheme, extracted in S94B so the
// publishing credential module and atlas-integrations use one implementation).
// WebCrypto only (globalThis.crypto): the same module runs in the Edge
// runtime and in the Node test runner. No environment reads, no network, no
// logging.
//
// Scheme (unchanged from S88): AES-256-GCM, a fresh random 96-bit nonce per
// encryption, 128-bit tag, key = base64 of 32 bytes (ATLAS_INTEGRATION_KEK_V<n>),
// ciphertext and nonce carried as lowercase hex. AAD binds each ciphertext to
// its purpose:
//   atlas-integrations|<provider>|<credential_kind>        provider token set
//   atlas-integrations|<provider>|pkce:<state_hash>         PKCE verifier
//   atlas-integrations|<provider>|resource|<resource_id>    Page access token (S94B)

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const AES_KEY_BYTES = 32;
export const AES_NONCE_BYTES = 12;

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

// S94B: a stored Page access token is bound to its provider and resource id.
export function resourceCredentialAad(providerKey, resourceId) {
  return `atlas-integrations|${providerKey}|resource|${resourceId}`;
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

// Key lookup by version from injected env, cached per caller (one cache per
// handler / credential opener). Throws a plain Error whose message names no
// secret; callers map it to their own owner-facing error.
export function createKeyring(env) {
  const cache = new Map();
  return {
    currentVersion() {
      const version = Number(env("ATLAS_INTEGRATION_KEK_CURRENT_VERSION") || "1");
      return Number.isInteger(version) && version > 0 && version < 1000 ? version : 1;
    },
    async key(version) {
      if (cache.has(version)) return cache.get(version);
      const material = env(`ATLAS_INTEGRATION_KEK_V${version}`);
      if (!material) throw Object.assign(new Error("Integration encryption key is not set."), { code: "key_missing" });
      let key;
      try {
        key = await importAesKey(material);
      } catch {
        throw Object.assign(new Error("Integration encryption key is invalid."), { code: "key_invalid" });
      }
      cache.set(version, key);
      return key;
    },
  };
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
