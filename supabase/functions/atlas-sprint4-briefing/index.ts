import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AuthError, MANAGER_ROLES, actorLabel, requireRole, resolveActor } from "../_shared/auth.mjs";

// DEAD (S89): no browser module calls this function (config.js no longer has
// SPRINT4_BRIEFING_API; Home's briefing is Atlas AI). The source stays only
// because the historical S33/S35/S39 release packages pin and rebuild it; do
// not add callers, and delete it with those package records.
//
// Atlas users authenticate against the production VÁ Auth project while the
// Sprint 4 briefing reads only the isolated development branch. The platform
// JWT check is disabled in config.toml because a production-project JWT cannot
// be validated by the branch gateway. This function verifies that JWT directly
// against production Auth, confirms the server-controlled manager/admin profile,
// and only then calls the branch's service-role-only briefing RPC. The caller
// check is the shared gateway module (_shared/auth.mjs), configured from env.

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store, max-age=0",
  "pragma": "no-cache",
  "vary": "authorization",
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ManagerContext = {
  user: { id: string };
  profile: { id: string; display_name?: string | null; role: string; active: boolean };
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-atlas-briefing-version": "0.1.0",
    },
  });
}

async function requireManager(request: Request): Promise<ManagerContext> {
  const actor = await resolveActor(request, Deno.env, fetch);
  requireRole(actor, MANAGER_ROLES, "The Daily Atlas Briefing is limited to managers and administrators.");
  return { user: { id: actor.userId }, profile: actor.profile };
}

async function branchRpc(name: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const branchUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!branchUrl || !serviceRoleKey) {
    throw new ApiError(500, "Sprint 4 branch credentials are unavailable.");
  }

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
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const message = typeof parsed === "object" && parsed && "message" in parsed
      ? String((parsed as { message: unknown }).message)
      : "The Daily Atlas Briefing database request failed.";
    throw new ApiError(response.status >= 500 ? 500 : 400, message);
  }
  return parsed;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    if (request.method !== "GET") throw new ApiError(405, "Method not allowed.");
    const context = await requireManager(request);
    const briefing = await branchRpc("atlas_sprint4_daily_briefing");

    return jsonResponse({
      briefing,
      manager: {
        id: context.user.id,
        label: actorLabel(context.profile),
        role: context.profile.role,
      },
      policy: {
        deterministic: true,
        ai_generation_used: false,
        automatic_mutation: false,
      },
    });
  } catch (error) {
    if (error instanceof ApiError || error instanceof AuthError) return jsonResponse({ error: error.message }, error.status);
    console.error("Daily Atlas Briefing API error", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "The Daily Atlas Briefing is temporarily unavailable." }, 500);
  }
});
