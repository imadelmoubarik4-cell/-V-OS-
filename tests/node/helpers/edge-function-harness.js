// Runs a Supabase Edge Function (Deno TypeScript) inside Node for behavioural
// tests. Node strips the erasable TypeScript syntax; a minimal `Deno` global
// supplies env and captures the `Deno.serve` handler; `fetch` is injected per
// call. Relative imports are rewritten to absolute file URLs so shared modules
// resolve from the temporary copy. Nothing is written inside the repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let sequence = 0;

export async function loadEdgeFunction(relativePath, env = {}) {
  const sourcePath = path.join(ROOT, relativePath);
  let source = fs.readFileSync(sourcePath, 'utf8');
  source = source.replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";\n/m, '');
  source = source.replace(/from "(\.{1,2}\/[^"]+)"/g, (_, specifier) =>
    `from "${pathToFileURL(path.resolve(path.dirname(sourcePath), specifier)).href}"`);

  const state = { handler: null, env: { ...env }, fetch: null };
  const previousDeno = globalThis.Deno;
  globalThis.Deno = {
    env: { get: (name) => state.env[name] },
    serve: (handler) => { state.handler = handler; },
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-edge-'));
  const file = path.join(directory, `function-${process.pid}-${sequence += 1}.mts`);
  fs.writeFileSync(file, source);
  try {
    await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    if (previousDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = previousDeno;
  }
  if (typeof state.handler !== 'function') throw new Error(`${relativePath} did not register a handler`);

  // Calls the handler with `fetchImpl` as the global fetch for this request.
  return async function call(request, fetchImpl) {
    const previousFetch = globalThis.fetch;
    const previous = globalThis.Deno;
    globalThis.fetch = fetchImpl;
    globalThis.Deno = { env: { get: (name) => state.env[name] }, serve() {} };
    try {
      return await state.handler(request);
    } finally {
      globalThis.fetch = previousFetch;
      if (previous === undefined) delete globalThis.Deno;
      else globalThis.Deno = previous;
    }
  };
}

export function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
