// atlas-booking-email-worker (S113) — sends KANEL's guest booking emails from the
// sealed outbox (atlas_private.booking_email_outbox) through KANEL's own Google
// Workspace mailbox over SMTP (smtp.gmail.com, implicit TLS on 465).
//
// No browser surface. Woken by pg_cron -> pg_net (atlas_private.booking_email_tick)
// with the x-atlas-worker-secret header, compared in constant time over SHA-256
// digests with the secret held in Vault, read through the service-role RPC
// atlas_booking_email_worker_secret (cached for five minutes; missing or shorter
// than 32 bytes -> 503 and nothing runs). No CORS, body ≤ 4 KB and ignored,
// response = counts only: never an address, a subject or the password.
//
// The database decides what is due (owner switch, 24-hour limit, past bookings,
// deliverable address) and renders each email when it is claimed. Loop: claim ->
// send each over one SMTP session -> complete(sent | retry | failed). At most once:
// if the connection drops after the message was handed over, the email is marked
// failed, never sent again. A refused login stops the run and puts every claimed
// email back for a later retry.
//
// Secrets (function secrets only): BOOKING_EMAIL_SMTP_PASSWORD (the Google app
// password of the sending mailbox; unset -> the worker sends nothing), optional
// BOOKING_EMAIL_SMTP_USER (default: the email's from address),
// BOOKING_EMAIL_SMTP_HOST (smtp.gmail.com), BOOKING_EMAIL_SMTP_PORT (465),
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

export const SECRET_HEADER = "x-atlas-worker-secret";
const MIN_SECRET_BYTES = 32;
const MAX_BODY_BYTES = 4096;
const CLAIM_LIMIT = 10;
const SECRET_CACHE_MS = 5 * 60_000;

export const RPC = Object.freeze({
  claim: "atlas_booking_email_claim",
  complete: "atlas_booking_email_complete",
  secret: "atlas_booking_email_worker_secret",
});

// Same rule as atlas_private.booking_email_address_ok: no spaces, brackets or line breaks.
export const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESPONSE_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
});

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function envReader(env) {
  if (typeof env === "function") return (name) => env(name);
  return (name) => env?.[name];
}

// ---- secret check ------------------------------------------------------------

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text))));
}

// Constant-time comparison of two strings over their SHA-256 digests (fixed
// length, so neither content nor length leaks through timing).
export async function secretMatches(provided, expected) {
  const [a, b] = await Promise.all([sha256(provided ?? ""), sha256(expected ?? "")]);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export function secretConfigured(value) {
  return typeof value === "string" && new TextEncoder().encode(value).length >= MIN_SECRET_BYTES;
}

// ---- the message ---------------------------------------------------------------

function base64Bytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// RFC 2047 encoded words (UTF-8, base64), each ≤ 75 characters, folded.
export function encodeHeader(text) {
  const clean = String(text ?? "").replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words = [];
  let chunk = [];
  for (const char of clean) {
    const bytes = [...new TextEncoder().encode(char)];
    if (chunk.length + bytes.length > 45) {
      words.push(chunk);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length) words.push(chunk);
  return words.map((bytes) => `=?UTF-8?B?${base64Bytes(bytes)}?=`).join("\r\n ");
}

export function buildMessage({ id, from, to, subject, body }, date = new Date()) {
  const domain = from.slice(from.lastIndexOf("@") + 1);
  const text = String(body ?? "").replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  const encoded = base64Bytes(new TextEncoder().encode(text)).match(/.{1,76}/g) ?? [""];
  return [
    `From: KANEL <${from}>`,
    `To: <${to}>`,
    `Reply-To: ${from}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: <${id}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    ...encoded,
  ].join("\r\n");
}

// ---- the worker ------------------------------------------------------------------

function defaultRpc(readEnv, fetchImpl) {
  return async function rpc(name, payload) {
    const base = String(readEnv("SUPABASE_URL") ?? "").replace(/\/+$/, "");
    const key = String(readEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    if (!base || !key) throw new Error("rpc_not_configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json", "cache-control": "no-store" },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
        redirect: "manual",
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error("rpc_failed");
        error.status = response.status;
        throw error;
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createEmailWorkerHandler({ env, fetchImpl, rpc, smtp, now = () => Date.now() } = {}) {
  const readEnv = envReader(env);
  const fetcher = fetchImpl ?? ((input, init) => fetch(input, init));
  const callRpc = rpc ?? defaultRpc(readEnv, fetcher);
  let cached = { value: null, at: -Infinity };

  async function workerSecret() {
    if (cached.value && now() - cached.at < SECRET_CACHE_MS) return cached.value;
    const value = await callRpc(RPC.secret, {});
    cached = secretConfigured(value) ? { value, at: now() } : { value: null, at: -Infinity };
    return cached.value;
  }

  async function complete(id, outcome, error = null) {
    try {
      await callRpc(RPC.complete, { p_id: id, p_outcome: outcome, p_error: error });
    } catch {
      // The row stays 'sending'; the next claim marks it failed (never resent).
    }
  }

  async function run(password) {
    const counts = { claimed: 0, sent: 0, retry: 0, failed: 0 };
    const claimed = await callRpc(RPC.claim, { p_limit: CLAIM_LIMIT });
    const emails = Array.isArray(claimed?.emails) ? claimed.emails : [];
    counts.claimed = emails.length;
    if (!emails.length) return counts;

    const host = String(readEnv("BOOKING_EMAIL_SMTP_HOST") ?? "").trim() || "smtp.gmail.com";
    const port = Number(readEnv("BOOKING_EMAIL_SMTP_PORT") ?? 465) || 465;
    const userOverride = String(readEnv("BOOKING_EMAIL_SMTP_USER") ?? "").trim();
    let session = null;

    try {
      for (let index = 0; index < emails.length; index += 1) {
        const mail = emails[index];
        const id = String(mail?.id ?? "");
        if (!UUID.test(id)) continue;
        if (!ADDRESS.test(String(mail.to ?? "")) || !ADDRESS.test(String(mail.from ?? ""))) {
          await complete(id, "failed", "invalid address");
          counts.failed += 1;
          continue;
        }
        try {
          if (!session) session = await smtp.open({ host, port, user: userOverride || mail.from, password });
          await session.send({ from: mail.from, to: mail.to, data: buildMessage(mail, new Date(now())) });
          await complete(id, "sent");
          counts.sent += 1;
        } catch (error) {
          const code = Number(error?.code) || null;
          const phase = String(error?.phase ?? "send");
          const reason = String(error?.message ?? "smtp error").slice(0, 120);
          if (phase === "connect" || phase === "greeting" || phase === "ehlo" || phase === "auth") {
            // Nothing was sent: put this email and every one after it back for later.
            const rest = emails.slice(index).map((e) => String(e?.id ?? "")).filter((x) => UUID.test(x));
            const why = phase === "auth" ? "smtp login refused" : reason;
            for (const restId of rest) await complete(restId, "retry", why);
            counts.retry += rest.length;
            session = null;
            break;
          }
          if (phase === "data-end" && !code) {
            // Handed over without an answer: it may have been delivered. Never repeat.
            await complete(id, "failed", "no answer after the message was sent");
            counts.failed += 1;
          } else if (code && code >= 500) {
            await complete(id, "failed", reason);
            counts.failed += 1;
          } else {
            await complete(id, "retry", reason);
            counts.retry += 1;
          }
          if (!code) {
            // The connection is gone (timeout or drop before the message): retry the rest later.
            const rest = emails.slice(index + 1).map((e) => String(e?.id ?? "")).filter((x) => UUID.test(x));
            for (const restId of rest) await complete(restId, "retry", reason);
            counts.retry += rest.length;
            session = null;
            break;
          }
        }
      }
    } finally {
      if (session) await session.quit();
    }
    return counts;
  }

  return async function handle(request) {
    if (request.method !== "POST") return json(404, { error: "not_found" });
    let expected;
    try {
      expected = await workerSecret();
    } catch {
      return json(503, { error: "not_configured" });
    }
    if (!secretConfigured(expected)) return json(503, { error: "not_configured" });
    const provided = request.headers.get(SECRET_HEADER) ?? "";
    if (!provided || !(await secretMatches(provided, expected))) return json(401, { error: "unauthorized" });
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return json(413, { error: "too_large" });
    const body = await request.text().catch(() => "");
    if (body.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
    // Google shows app passwords in groups of four; the spaces are not part of it.
    const password = String(readEnv("BOOKING_EMAIL_SMTP_PASSWORD") ?? "").replace(/\s+/g, "");
    if (!password || !smtp || typeof smtp.open !== "function") return json(200, { ok: true, disabled: true });
    try {
      return json(200, { ok: true, ...(await run(password)) });
    } catch {
      return json(500, { error: "worker_error" });
    }
  };
}
