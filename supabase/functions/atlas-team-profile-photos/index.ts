import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AuthError, actorLabel, authConfig, resolveActor } from "../_shared/auth.mjs";

const PHOTO_BUCKET = "atlas-profile-photos";
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const SIGNED_URL_SECONDS = 6 * 60 * 60;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

const MANAGER_ROLES = new Set(["admin", "manager"]);
const PROFILE_ROLES = new Set(["admin", "manager", "bartender", "viewer"]);

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

type PhotoMetadata = {
  profile_id: string;
  bucket_id: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  width?: number | null;
  height?: number | null;
  version: string;
  updated_at?: string | null;
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-team-profile-photos-version": "0.1.0",
    },
  });
}

function profileLabel(profile: Partial<AtlasProfile> | null | undefined): string {
  return actorLabel(profile);
}

function isManager(context: AtlasContext): boolean {
  // S99: an inactive caller (an invitee uploading their own photo mid-onboarding,
  // resolved with allowInactive) is never a manager, so requireEditableTarget
  // keeps them to their own profile only.
  return context.profile.active === true && MANAGER_ROLES.has(context.profile.role);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireUuid(value: unknown, label: string): string {
  if (!isUuid(value)) throw new ApiError(400, `${label} is invalid.`);
  return value;
}

function integerOrNull(value: FormDataEntryValue | null, min: number, max: number): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  if (new TextEncoder().encode(text).byteLength > 32 * 1024) {
    throw new ApiError(413, "Request body is too large.");
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

// The production Auth/REST project and its publishable key come only from the
// function environment (_shared/auth.mjs authConfig); unconfigured fails closed.
function productionAuthUrl(): string {
  return authConfig(Deno.env).projectUrl;
}

function productionPublishableKey(): string {
  return authConfig(Deno.env).publishableKey;
}

async function requireActiveProfile(request: Request, options: { allowInactive?: boolean } = {}): Promise<AtlasContext> {
  // S99: photo upload accepts an inactive (mid-onboarding) caller so an invitee
  // can add their required profile photo before activation. isManager() returns
  // false for such a caller, so requireEditableTarget keeps them self-only.
  const actor = await resolveActor(request, Deno.env, fetch, {
    inactiveMessage: "This Atlas profile is inactive. Team access has been removed.",
    allowInactive: options.allowInactive === true,
  });
  return { token: actor.token, user: { id: actor.userId }, profile: actor.profile as AtlasProfile };
}

async function productionJson(context: AtlasContext, url: URL): Promise<any> {
  const response = await fetch(url, {
    headers: {
      apikey: productionPublishableKey(),
      authorization: `Bearer ${context.token}`,
      accept: "application/json",
      "cache-control": "no-store",
    },
  });
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    console.warn("Profile photos production read failed", response.status, payload && typeof payload === "object" ? String(payload.code ?? "-") : "-");
    throw new ApiError(response.status === 401 ? 401 : response.status === 403 ? 403 : 400, "Connected Atlas profile data could not be read.");
  }
  return payload;
}

async function allProfiles(context: AtlasContext): Promise<AtlasProfile[]> {
  const url = new URL(`${productionAuthUrl()}/rest/v1/profiles`);
  url.searchParams.set("select", "id,email,display_name,role,active");
  url.searchParams.set("order", "active.desc,display_name.asc.nullslast,email.asc");
  url.searchParams.set("limit", "500");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows as AtlasProfile[] : [];
}

async function visibleProfiles(context: AtlasContext): Promise<AtlasProfile[]> {
  const rows = await allProfiles(context);
  if (isManager(context)) return rows;
  return rows.filter((profile) => profile.active || profile.id === context.user.id);
}

async function requireEditableTarget(context: AtlasContext, profileId: string): Promise<AtlasProfile> {
  const rows = await allProfiles(context);
  const target = rows.find((profile) => profile.id === profileId);
  if (!target) throw new ApiError(404, "The selected Atlas profile no longer exists.");
  if (!isManager(context) && profileId !== context.user.id) {
    throw new ApiError(403, "Staff may change only their own profile photo.");
  }
  return target;
}

function branchCredentials() {
  const branchUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "The private profile-photo service is unavailable.");
  }
  return { branchUrl, serviceRoleKey };
}

async function branchRpc(name: string, payload: Record<string, unknown> = {}): Promise<any> {
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
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) {
    const message = safeDbMessage(parsed, "The private profile-photo request failed.");
    if (message === "The private profile-photo request failed.") console.warn("Profile photos RPC failed", name, response.status, parsed && typeof parsed === "object" ? String(parsed.code ?? "-") : "-");
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

// S96: database text reaches the browser only when it is an Atlas-authored
// message raised by our SQL, without schema detail (same rule as
// atlas-shifts / atlas-team-messages); anything else becomes the fixed
// fallback and only the SQLSTATE is logged.
const AUTHORED_SQLSTATES = new Set(["P0001", "42501", "22023", "P0002", "55000", "23514"]);
const SCHEMA_DETAIL = /(relation|column|constraint|function\s|schema|syntax|violates|duplicate key|permission denied|operator|does not exist|null value|sqlstate|pg_|atlas_private\.|public\.)/i;

function safeDbMessage(parsed: unknown, fallback: string): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  const body = parsed as { code?: unknown; message?: unknown };
  const code = String(body.code ?? "");
  const message = String(body.message ?? "").trim();
  if (!message || message.length > 300 || !AUTHORED_SQLSTATES.has(code) || SCHEMA_DETAIL.test(message)) return fallback;
  return message;
}

function encodedStoragePath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function uploadStorageObject(path: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  const { branchUrl, serviceRoleKey } = branchCredentials();
  const response = await fetch(`${branchUrl}/storage/v1/object/${PHOTO_BUCKET}/${encodedStoragePath(path)}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": mimeType,
      "cache-control": "3600",
      "x-upsert": "false",
    },
    body: bytes,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    console.warn("Profile photo upload failed", response.status);
    throw new ApiError(response.status >= 500 ? 500 : 400, "The profile photo could not be stored.");
  }
}

async function deleteStorageObjects(paths: string[]): Promise<void> {
  const prefixes = [...new Set(paths.filter(Boolean))];
  if (!prefixes.length) return;
  const { branchUrl, serviceRoleKey } = branchCredentials();
  const response = await fetch(`${branchUrl}/storage/v1/object/${PHOTO_BUCKET}`, {
    method: "DELETE",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prefixes }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || "Stored profile photo could not be removed.");
  }
}

async function signedStorageUrl(path: string): Promise<string> {
  const { branchUrl, serviceRoleKey } = branchCredentials();
  const response = await fetch(`${branchUrl}/storage/v1/object/sign/${PHOTO_BUCKET}/${encodedStoragePath(path)}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ expiresIn: SIGNED_URL_SECONDS }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || "Signed photo URL could not be created.");
  const value = payload.signedURL || payload.signedUrl || payload.signed_url;
  if (!value || typeof value !== "string") throw new Error("Signed photo URL was missing from the storage response.");
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/storage/v1/")) return `${branchUrl}${value}`;
  if (value.startsWith("/object/")) return `${branchUrl}/storage/v1${value}`;
  return `${branchUrl}/storage/v1/${value.replace(/^\/+/, "")}`;
}

function detectedImageType(bytes: Uint8Array): { mime: string; extension: string } | null {
  if (bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mime: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { mime: "image/webp", extension: "webp" };
  }
  return null;
}

async function photoSnapshot(context: AtlasContext) {
  const profiles = await visibleProfiles(context);
  const rows = await branchRpc("atlas_team_profile_photos_snapshot", {
    p_profile_ids: profiles.map((profile) => profile.id),
  }) as PhotoMetadata[];

  const photos = await Promise.all((Array.isArray(rows) ? rows : []).map(async (photo) => {
    try {
      return {
        ...photo,
        signed_url: await signedStorageUrl(photo.storage_path),
        signed_url_expires_in: SIGNED_URL_SECONDS,
        can_manage: isManager(context) || photo.profile_id === context.user.id,
      };
    } catch (error) {
      console.warn("Profile photo URL could not be signed", photo.profile_id, error instanceof Error ? error.message : error);
      return {
        ...photo,
        signed_url: null,
        signed_url_expires_in: 0,
        can_manage: isManager(context) || photo.profile_id === context.user.id,
      };
    }
  }));

  return {
    photos,
    staff: {
      id: context.user.id,
      label: profileLabel(context.profile),
      role: context.profile.role,
      can_manage_team: isManager(context),
    },
    policy: {
      bucket: PHOTO_BUCKET,
      bucket_public: false,
      max_upload_bytes: MAX_PHOTO_BYTES,
      accepted_types: ["image/webp", "image/jpeg", "image/png"],
      signed_url_seconds: SIGNED_URL_SECONDS,
      self_upload: true,
      manager_upload_for_staff: true,
      direct_browser_storage_access: false,
      original_filename_stored: false,
    },
  };
}

async function uploadPhoto(context: AtlasContext, request: Request) {
  // S96: refuse an oversized body before it is buffered and parsed.
  const declared = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(declared) || declared > MAX_PHOTO_BYTES + 64 * 1024) {
    throw new ApiError(413, "Profile photos must be no larger than 2 MB.");
  }
  const form = await request.formData();
  const profileId = requireUuid(form.get("profile_id"), "Team profile");
  await requireEditableTarget(context, profileId);
  const value = form.get("file");
  if (!(value instanceof File)) throw new ApiError(400, "Choose a profile photo to upload.");
  if (value.size < 1 || value.size > MAX_PHOTO_BYTES) {
    throw new ApiError(400, "Profile photos must be no larger than 2 MB.");
  }

  const bytes = new Uint8Array(await value.arrayBuffer());
  const imageType = detectedImageType(bytes);
  if (!imageType) throw new ApiError(400, "Use a JPEG, PNG, or WebP profile photo.");

  const width = integerOrNull(form.get("width"), 64, 2048);
  const height = integerOrNull(form.get("height"), 64, 2048);
  const version = crypto.randomUUID();
  const storagePath = `profiles/${profileId}/${version}.${imageType.extension}`;
  await uploadStorageObject(storagePath, bytes, imageType.mime);

  let saved: any;
  try {
    saved = await branchRpc("atlas_team_profile_photo_upsert", {
      p_profile_id: profileId,
      p_bucket_id: PHOTO_BUCKET,
      p_storage_path: storagePath,
      p_mime_type: imageType.mime,
      p_byte_size: bytes.byteLength,
      p_width: width,
      p_height: height,
      p_version: version,
      p_actor_id: context.user.id,
      p_actor_label: profileLabel(context.profile),
      p_actor_role: context.profile.role,
    });
  } catch (error) {
    await deleteStorageObjects([storagePath]).catch(() => undefined);
    throw error;
  }

  const previousPath = saved?.previous_storage_path;
  if (typeof previousPath === "string" && previousPath && previousPath !== storagePath) {
    await deleteStorageObjects([previousPath]).catch((error) => {
      console.warn("Previous profile photo cleanup failed", error instanceof Error ? error.message : error);
    });
  }

  return { result: saved, ...(await photoSnapshot(context)) };
}

async function removePhoto(context: AtlasContext, request: Request) {
  const body = await readJson(request);
  const profileId = requireUuid(body.profile_id, "Team profile");
  await requireEditableTarget(context, profileId);
  const result = await branchRpc("atlas_team_profile_photo_remove", {
    p_profile_id: profileId,
    p_actor_id: context.user.id,
    p_actor_label: profileLabel(context.profile),
    p_actor_role: context.profile.role,
  });
  const path = result?.photo?.storage_path;
  if (typeof path === "string" && path) {
    await deleteStorageObjects([path]).catch((error) => {
      console.warn("Removed profile photo cleanup failed", error instanceof Error ? error.message : error);
    });
  }
  return { result, ...(await photoSnapshot(context)) };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";
    // S99: only the self-scoped upload accepts an inactive onboarding caller.
    const allowInactive = request.method === "POST" && action === "upload";
    const context = await requireActiveProfile(request, { allowInactive });

    if (request.method === "GET") {
      if (action !== "snapshot") throw new ApiError(404, "Unknown profile-photo action.");
      return jsonResponse(await photoSnapshot(context));
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    if (action === "upload") return jsonResponse(await uploadPhoto(context, request));
    if (action === "remove") return jsonResponse(await removePhoto(context, request));
    throw new ApiError(404, "Unknown profile-photo action.");
  } catch (error) {
    if (error instanceof ApiError || error instanceof AuthError) return jsonResponse({ error: error.message }, error.status);
    console.error("Team Profile photos API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The profile-photo service is temporarily unavailable." }, 500);
  }
});
