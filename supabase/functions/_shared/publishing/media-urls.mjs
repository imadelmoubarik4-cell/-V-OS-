// S94C: short-lived Storage access for the publishing worker.
//
// - sign(path, purpose): mints a signed GET URL for one object of the private
//   bucket `atlas-marketing-media`, right before the provider call that needs
//   it (POST /storage/v1/object/sign/<bucket>/<path>, service role). The URL
//   is a bearer secret: it is returned to the adapter only, never logged,
//   never stored, never put in an RPC payload. Callers may record
//   `url_expires_at` (returned alongside) through a record_step detail.
// - readRange(path, start, end): ranged read of the object for TikTok
//   FILE_UPLOAD chunking (GET /storage/v1/object/authenticated/<bucket>/<path>
//   with `Range`; ranged reads need rehearsal on the live project, report 03
//   §2.5 / §3.3, UNVERIFIED).
//
// Lifetimes per contract §5.4: Instagram video 60 min, Instagram image 15 min,
// Facebook 30 min, Google Business Profile 15 min.

export const MEDIA_BUCKET = "atlas-marketing-media";

export const URL_TTL_SECONDS = Object.freeze({
  instagram_image: 15 * 60,
  instagram_video: 60 * 60,
  facebook: 30 * 60,
  gbp_photo: 15 * 60,
});

// venues/<venue>/<yyyy>/<mm>/<asset uuid>/original.<ext> or .../v/<variant uuid>.<ext>
const PATH_PATTERN = /^venues\/[a-z0-9][a-z0-9-]{0,62}\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:original|v\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:jpg|jpeg|png|webp|heic|heif|mp4|mov)$/;

export class MediaError extends Error {
  constructor(code, message, { transient = false } = {}) {
    super(message);
    this.name = "MediaError";
    this.code = code;
    this.transient = transient;
  }
}

export function isValidStoragePath(path) {
  return typeof path === "string" && path.length <= 300 && PATH_PATTERN.test(path) && !path.includes("..");
}

function encodePath(path) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

// createMediaUrls({ http, supabaseUrl, serviceKey, now }) where http is the
// allowlisted client from http.mjs (our Storage host is always allowed).
export function createMediaUrls({ http, supabaseUrl, serviceKey, now }) {
  const base = String(supabaseUrl ?? "").replace(/\/+$/, "");
  const headers = () => ({ apikey: serviceKey, authorization: `Bearer ${serviceKey}` });

  function checkPath(path) {
    if (!base || !serviceKey) throw new MediaError("storage_not_configured", "Media storage is not configured for the publisher.");
    if (!isValidStoragePath(path)) throw new MediaError("media_path_invalid", "A media file in this post has an unexpected storage path.");
  }

  async function sign(path, ttlSeconds) {
    checkPath(path);
    const expiresIn = Math.max(60, Math.min(3600, Math.floor(Number(ttlSeconds) || 900)));
    let res;
    try {
      res = await http.request(`${base}/storage/v1/object/sign/${MEDIA_BUCKET}/${encodePath(path)}`, {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ expiresIn }),
        timeoutMs: 10_000,
      });
    } catch {
      throw new MediaError("storage_unavailable", "Media storage could not be reached.", { transient: true });
    }
    if (res.status === 404 || res.status === 400) throw new MediaError("media_missing", "A media file in this post is no longer in storage.");
    if (!res.ok) throw new MediaError("storage_unavailable", "Media storage could not sign a link.", { transient: true });
    const value = res.json?.signedURL || res.json?.signedUrl || res.json?.signed_url;
    if (!value || typeof value !== "string") throw new MediaError("storage_unavailable", "Media storage returned no link.", { transient: true });
    let url;
    if (/^https:\/\//i.test(value)) url = value;
    else if (value.startsWith("/storage/v1/")) url = `${base}${value}`;
    else if (value.startsWith("/object/")) url = `${base}/storage/v1${value}`;
    else url = `${base}/storage/v1/${value.replace(/^\/+/, "")}`;
    const expiresAt = new Date(now() + expiresIn * 1000).toISOString();
    return { url, expires_at: expiresAt };
  }

  // Returns the chunk as a Uint8Array (one chunk in memory at a time).
  async function readRange(path, start, end) {
    checkPath(path);
    let res;
    try {
      res = await http.request(`${base}/storage/v1/object/authenticated/${MEDIA_BUCKET}/${encodePath(path)}`, {
        method: "GET",
        headers: { ...headers(), range: `bytes=${start}-${end}` },
        timeoutMs: 60_000,
        binary: true,
      });
    } catch {
      throw new MediaError("storage_unavailable", "Media storage could not be read.", { transient: true });
    }
    if (res.status === 404) throw new MediaError("media_missing", "A media file in this post is no longer in storage.");
    if (res.status !== 206 && res.status !== 200) throw new MediaError("storage_unavailable", "Media storage could not be read.", { transient: true });
    const bytes = res.bytes;
    const expected = end - start + 1;
    if (!(bytes instanceof Uint8Array)) throw new MediaError("storage_unavailable", "Media storage returned no bytes.", { transient: true });
    // A server that ignores Range returns the whole object with 200.
    if (res.status === 200 && bytes.length > expected) return bytes.subarray(start, end + 1);
    if (bytes.length !== expected) throw new MediaError("storage_short_read", "Media storage returned fewer bytes than asked.", { transient: true });
    return bytes;
  }

  return { sign, readRange };
}
