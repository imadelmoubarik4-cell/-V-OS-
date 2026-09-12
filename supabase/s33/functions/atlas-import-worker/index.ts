import { createHandler } from './worker.mjs';
// Review-only S33 source. This is not included in the live function configuration.
Deno.serve(createHandler({
  SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  ATLAS_AUTH_PROJECT_URL: Deno.env.get('ATLAS_AUTH_PROJECT_URL'),
  ATLAS_AUTH_PUBLISHABLE_KEY: Deno.env.get('ATLAS_AUTH_PUBLISHABLE_KEY'),
  ATLAS_IMPORT_ENABLED: Deno.env.get('ATLAS_IMPORT_ENABLED'),
}));
