import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createMarketingHandler } from "./handler.mjs";

// atlas-marketing-workspace: plan, approve and publish Marketing posts.
//
// verify_jwt=false (supabase/config.toml): the production Auth project issues
// the JWT, so the handler validates it and the active profile through the
// shared caller check (_shared/auth.mjs resolveActor). Roles: writers
// (admin, manager, bartender) keep the planning actions they had; every S94
// publishing action is for managers and administrators only, checked here and
// again in SQL. The logic lives in handler.mjs so Node tests can drive it with
// injected env, fetch and clock.
//
// Function secrets (never in apps/web): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ATLAS_AUTH_PROJECT_URL / ATLAS_AUTH_PUBLISHABLE_KEY, and
// ATLAS_MARKETING_PUBLISHER_SECRET (used only to wake atlas-marketing-publisher
// after Publish now; the cron tick is the fallback).

const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;

const handle = createMarketingHandler({
  env: (name: string) => Deno.env.get(name),
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  now: () => Date.now(),
  waitUntil: typeof edgeRuntime?.waitUntil === "function" ? (promise: Promise<unknown>) => edgeRuntime.waitUntil!(promise) : undefined,
});

Deno.serve(handle);
