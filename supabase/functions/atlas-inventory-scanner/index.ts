import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// S89: scanning identifies products; it never changes stock. The former
// `count` action (which could call adjust_inventory when live apply was on)
// is removed; counts are saved only through the stock-count workflow and
// reach stock only through manager verification. Codes use the shared
// product-identity normalisation (GTIN check digit, GTIN-14).
import { normalizeCode as normalizeProductCode } from "../_shared/product-identity.mjs";
import { AuthError, actorLabel, authConfig, resolveActor } from "../_shared/auth.mjs";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

const MANAGER_ROLES = new Set(["admin", "manager"]);
const MAX_BODY_BYTES = 64 * 1024;
const INVENTORY_SELECT = "id,name,category,quantity,unit,barcode,sku,image_url,bin_location,updated_at,active";

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

type InventoryItem = {
  id: string;
  name: string;
  category?: string | null;
  quantity: number;
  unit?: string | null;
  barcode?: string | null;
  sku?: string | null;
  image_url?: string | null;
  bin_location?: string | null;
  updated_at?: string | null;
  active?: boolean | null;
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
      "x-atlas-scanner-version": "0.1.0",
    },
  });
}

function contextLabel(context: AtlasContext): string {
  return actorLabel(context.profile);
}

function staffPayload(context: AtlasContext) {
  return {
    id: context.user.id,
    label: contextLabel(context),
    role: context.profile.role,
    can_count: false,
    can_link: MANAGER_ROLES.has(context.profile.role),
  };
}

// The production Auth/REST project and its publishable key come only from the
// function environment (_shared/auth.mjs authConfig); unconfigured fails closed.
function productionAuthUrl(): string {
  return authConfig(Deno.env).projectUrl;
}

function productionPublishableKey(): string {
  return authConfig(Deno.env).publishableKey;
}

async function requireActiveProfile(request: Request): Promise<AtlasContext> {
  const actor = await resolveActor(request, Deno.env, fetch);
  return { token: actor.token, user: { id: actor.userId }, profile: actor.profile as AtlasProfile };
}

function requireManager(context: AtlasContext): void {
  if (!MANAGER_ROLES.has(context.profile.role)) {
    throw new ApiError(403, "Linking a new barcode is limited to managers and administrators.");
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireUuid(value: unknown, label: string): string {
  if (!isUuid(value)) throw new ApiError(400, `${label} is invalid.`);
  return value;
}

function normalizeCode(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "Barcode or SKU is required.");
  const trimmed = value.trim();
  if (!trimmed) throw new ApiError(400, "Barcode or SKU is required.");
  const code = normalizeProductCode(trimmed);
  // A numeric code that fails the GTIN check can still be an internal barcode.
  const normalized = code.valid ? code.normalized : normalizeProductCode(trimmed, { kind: "other_barcode" }).normalized;
  if (!normalized) {
    throw new ApiError(400, "Barcode or SKU must contain between 3 and 128 characters.");
  }
  return normalized;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, "A text field is invalid.");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new ApiError(400, `Text is limited to ${maxLength} characters.`);
  return normalized;
}

function normalizeSymbology(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "unknown";
  const normalized = raw.replace(/[\s-]+/g, "_").slice(0, 64);
  return normalized || "unknown";
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "Request body is too large.");
  }
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

async function branchRpc(name: string, payload: Record<string, unknown> = {}): Promise<any> {
  const branchUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!branchUrl || !serviceRoleKey) throw new ApiError(500, "Scanner branch credentials are unavailable.");

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
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String(parsed.message)
      : typeof parsed === "string" && parsed
      ? parsed
      : "The inventory scanner database request failed.";
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

async function productionJson(context: AtlasContext, url: URL, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: productionPublishableKey(),
      authorization: `Bearer ${context.token}`,
      accept: "application/json",
      "cache-control": "no-store",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed
      ? String(parsed.message)
      : typeof parsed === "string" && parsed
      ? parsed
      : "The live inventory request failed.";
    throw new ApiError(response.status === 401 ? 401 : response.status === 403 ? 403 : 400, message);
  }
  return parsed;
}

async function inventoryCatalog(context: AtlasContext): Promise<InventoryItem[]> {
  const url = new URL(`${productionAuthUrl()}/rest/v1/inventory_items`);
  url.searchParams.set("select", INVENTORY_SELECT);
  url.searchParams.set("active", "eq.true");
  url.searchParams.set("order", "category.asc,name.asc");
  url.searchParams.set("limit", "1000");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) ? rows : [];
}

async function inventoryItem(context: AtlasContext, id: string): Promise<InventoryItem | null> {
  const url = new URL(`${productionAuthUrl()}/rest/v1/inventory_items`);
  url.searchParams.set("select", INVENTORY_SELECT);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("active", "eq.true");
  url.searchParams.set("limit", "1");
  const rows = await productionJson(context, url);
  return Array.isArray(rows) && rows[0] ? rows[0] as InventoryItem : null;
}

function itemCodeMatches(item: InventoryItem, normalizedCode: string): boolean {
  for (const candidate of [item.barcode, item.sku]) {
    if (!candidate) continue;
    try {
      if (normalizeCode(candidate) === normalizedCode) return true;
    } catch {
      // Ignore malformed legacy item identifiers.
    }
  }
  return false;
}

async function lookupCode(context: AtlasContext, rawCode: string) {
  const normalizedCode = normalizeCode(rawCode);
  const branchLookup = await branchRpc("atlas_inventory_scanner_lookup", { p_code: rawCode });
  const alias = branchLookup?.alias ?? null;

  if (branchLookup?.matched && alias?.item_id) {
    const item = await inventoryItem(context, String(alias.item_id));
    if (item) {
      return {
        normalized_code: normalizedCode,
        matched: true,
        match_source: "verified_alias",
        alias,
        item,
      };
    }
    return {
      normalized_code: normalizedCode,
      matched: false,
      stale_alias: true,
      alias,
      item: null,
    };
  }

  const items = await inventoryCatalog(context);
  const directMatches = items.filter((item) => itemCodeMatches(item, normalizedCode));
  if (directMatches.length === 1) {
    return {
      normalized_code: normalizedCode,
      matched: true,
      match_source: "inventory_field",
      alias: null,
      item: directMatches[0],
    };
  }

  return {
    normalized_code: normalizedCode,
    matched: false,
    match_source: directMatches.length > 1 ? "ambiguous_inventory_field" : "none",
    alias: null,
    item: null,
  };
}

async function scannerSnapshot(context: AtlasContext) {
  const [scanner, items] = await Promise.all([
    branchRpc("atlas_inventory_scanner_snapshot"),
    inventoryCatalog(context),
  ]);
  return { scanner, items };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const context = await requireActiveProfile(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "snapshot";

    if (request.method === "GET") {
      if (action === "snapshot") {
        const payload = await scannerSnapshot(context);
        return jsonResponse({
          ...payload,
          staff: staffPayload(context),
          policy: {
            camera_images_uploaded: false,
            direct_browser_table_access: false,
            code_link_requires_manager: true,
            scanner_changes_stock: false,
            counts_use_stock_count_workflow: true,
          },
        });
      }

      if (action === "lookup") {
        const code = url.searchParams.get("code") ?? "";
        const lookup = await lookupCode(context, code);
        return jsonResponse({ lookup, staff: staffPayload(context) });
      }

      throw new ApiError(404, "Unknown inventory scanner action.");
    }

    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);

    if (action === "link") {
      requireManager(context);
      const rawCode = optionalText(body.code, 256);
      if (!rawCode) throw new ApiError(400, "Barcode or SKU is required.");
      normalizeCode(rawCode);
      const itemId = requireUuid(body.item_id, "Inventory item");
      const item = await inventoryItem(context, itemId);
      if (!item) throw new ApiError(404, "The selected inventory item is no longer active.");

      const clientRequestId = requireUuid(body.client_request_id, "Client request ID");
      await branchRpc("atlas_inventory_scanner_link_code", {
        p_raw_code: rawCode,
        p_symbology: normalizeSymbology(body.symbology),
        p_item_id: item.id,
        p_item_name: item.name,
        p_item_category: item.category ?? null,
        p_item_unit: item.unit ?? null,
        p_actor_id: context.user.id,
        p_actor_label: contextLabel(context),
        p_client_request_id: clientRequestId,
      });

      const lookup = await lookupCode(context, rawCode);
      return jsonResponse({ lookup, staff: staffPayload(context), linked: true });
    }

    if (action === "count") {
      // Removed in S89: recognition and scanning stop at identification.
      throw new ApiError(410, "Scanner counts moved to Stock count. Scan inside a count and save the line there.");
    }

    throw new ApiError(404, "Unknown inventory scanner action.");
  } catch (error) {
    if (error instanceof ApiError || error instanceof AuthError) return jsonResponse({ error: error.message }, error.status);
    console.error("Inventory scanner API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The inventory scanner service is temporarily unavailable." }, 500);
  }
});
