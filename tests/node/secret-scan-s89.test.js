// S89: secret scan over everything Atlas ships to browsers (apps/web: HTML,
// JS, CSS, JSON, web manifest, SVG, text and the gzipped bundle) and over the
// docs tree. The one public value allowed is the production publishable key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// Public by design: the browser signs in with it (apps/web/config.js).
const ALLOWED_PUBLISHABLE = new Set(['sb_publishable_MQx7jRJzN3z9UV72THr90A_hxXk2Lkp']);
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.md', '.toml', '.map', '.xml', '.csv', '.sql', '.yml', '.yaml']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function readable(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.gz') return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  if (TEXT.has(ext)) return fs.readFileSync(file, 'utf8');
  return null;
}

function jwtRole(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))?.role ?? null;
  } catch {
    return null;
  }
}

// Returns [{ kind, sample }] for every secret-shaped value in `text`.
export function findSecrets(text) {
  const hits = [];
  const add = (kind, value) => hits.push({ kind, sample: `${value.slice(0, 12)}…` });
  for (const match of text.matchAll(/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g)) add('openai-api-key', match[0]);
  for (const match of text.matchAll(/\bek_[A-Za-z0-9]{20,}/g)) add('openai-ephemeral-key', match[0]);
  for (const match of text.matchAll(/\bsb_secret_[A-Za-z0-9_-]{8,}/g)) add('supabase-secret-key', match[0]);
  for (const match of text.matchAll(/\bsb_publishable_[A-Za-z0-9_-]{8,}/g)) {
    // Documentation placeholders (sb_publishable_REPLACE_WITH_…) are not keys.
    if (!ALLOWED_PUBLISHABLE.has(match[0]) && !/REPLACE|EXAMPLE|PLACEHOLDER|SYNTHETIC/i.test(match[0])) add('unreviewed-publishable-key', match[0]);
  }
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g)) {
    if (jwtRole(match[0]) === 'service_role') add('supabase-service-role-jwt', match[0]);
  }
  for (const match of text.matchAll(/-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/g)) add('private-key-pem', match[0]);
  for (const match of text.matchAll(/VAPID_PRIVATE_KEY["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{40,}/gi)) add('vapid-private-key', match[0]);
  for (const match of text.matchAll(/(?:privateKey|private_key)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{43}["']/g)) add('vapid-private-key', match[0]);
  for (const match of text.matchAll(/KEK[A-Z0-9_]*["']?\s*[:=]\s*["']?[A-Za-z0-9+/]{43}=/g)) add('integration-kek', match[0]);
  for (const match of text.matchAll(/SUPABASE_SERVICE_ROLE_KEY["']?\s*[:=]\s*["'][^"'\s]{16,}["']/g)) add('service-role-assignment', match[0]);
  return hits;
}

function scan(dir) {
  const files = walk(dir);
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    const text = readable(file);
    if (text === null) continue;
    scanned += 1;
    for (const hit of findSecrets(text)) findings.push(`${rel(file)}: ${hit.kind} ${hit.sample}`);
  }
  return { findings, scanned, files };
}

test('the scanner recognises every secret shape it guards (negative controls)', () => {
  const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const serviceJwt = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss: 'supabase', role: 'service_role' })}.${'s'.repeat(43)}`;
  const anonJwt = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss: 'supabase', role: 'anon' })}.${'a'.repeat(43)}`;
  const samples = {
    'openai-api-key': `const key = "${'sk'}-proj-${'A'.repeat(40)}";`,
    'openai-ephemeral-key': `secret: "${'ek'}_${'b'.repeat(32)}"`,
    'supabase-secret-key': `${'sb'}_secret_${'c'.repeat(24)}`,
    'unreviewed-publishable-key': `${'sb'}_publishable_${'d'.repeat(24)}`,
    'supabase-service-role-jwt': serviceJwt,
    'private-key-pem': `-----BEGIN ${'PRIVATE'} KEY-----`,
    'vapid-private-key': `ATLAS_VAPID_PRIVATE_KEY=${'e'.repeat(43)}`,
    'integration-kek': `ATLAS_INTEGRATION_KEK_V1="${'f'.repeat(43)}="`,
  };
  for (const [kind, text] of Object.entries(samples)) {
    assert.ok(findSecrets(text).some((hit) => hit.kind === kind), `${kind} is detected`);
  }
  assert.deepEqual(findSecrets(anonJwt), [], 'a public anon JWT is not a secret');
  assert.deepEqual(findSecrets([...ALLOWED_PUBLISHABLE][0]), [], 'the reviewed publishable key is allowed');
});

test('nothing under apps/web ships a secret (HTML, JS, JSON, manifest, gzip bundle)', () => {
  const { findings, scanned, files } = scan(path.join(ROOT, 'apps/web'));
  assert.ok(scanned >= 40, `expected the whole web app, scanned ${scanned}`);
  for (const required of ['apps/web/index.html', 'apps/web/config.js', 'apps/web/site.webmanifest', 'apps/web/assets/js/team-profiles.bundle.js.gz']) {
    assert.ok(files.some((file) => rel(file) === required), `${required} is scanned`);
  }
  assert.deepEqual(findings, []);
});

test('nothing under docs contains a secret', () => {
  const { findings, scanned } = scan(path.join(ROOT, 'docs'));
  assert.ok(scanned > 0);
  assert.deepEqual(findings, []);
});
