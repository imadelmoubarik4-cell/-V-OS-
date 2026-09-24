// Loads the OpenAI Agents SDK and zod for the Atlas AI runtime tests.
//
// * Under Deno (`npm run test:ai`) the same npm: specifiers as the Edge
//   Function resolve from the Deno cache.
// * Under Node the SDK is used when it can be resolved: installed as a
//   package, or from ATLAS_AI_SDK_DIR (a directory containing node_modules
//   with @openai/agents@0.18.0 and zod@4).
// * Otherwise the SDK-dependent tests are skipped with a reason and the rest
//   of the suite still runs (plain `npm test` needs no network or packages).

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

async function attempt(loader) {
  try {
    return await loader();
  } catch {
    return null;
  }
}

async function load() {
  const deno = await attempt(async () => ({
    sdk: await import('npm:@openai/agents@0.18.0'),
    z: (await import('npm:zod@4')).z,
    runtime: 'deno',
  }));
  if (deno?.sdk?.Agent) return deno;
  const bare = await attempt(async () => ({
    sdk: await import('@openai/agents'),
    z: (await import('zod')).z,
    runtime: 'node',
  }));
  if (bare?.sdk?.Agent) return bare;
  const dir = globalThis.process?.env?.ATLAS_AI_SDK_DIR;
  if (dir) {
    const fromDir = await attempt(async () => ({
      sdk: await import(pathToFileURL(join(dir, 'node_modules/@openai/agents/dist/index.mjs')).href),
      z: (await import(pathToFileURL(join(dir, 'node_modules/zod/index.js')).href)).z,
      runtime: 'node-dir',
    }));
    if (fromDir?.sdk?.Agent) return fromDir;
  }
  return null;
}

export const SDK = await load();
export const SKIP_SDK = SDK
  ? false
  : 'OpenAI Agents SDK not available: run `npm run test:ai` (Deno) or set ATLAS_AI_SDK_DIR';
